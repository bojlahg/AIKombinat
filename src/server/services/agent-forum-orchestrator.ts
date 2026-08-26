import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeManager } from './claude-manager.js';
import { getAdapter, type CliTool, type SandboxMode } from './cli-adapters.js';
import { isAgentCliTool } from './provider-types.js';
import { executionSnapshot, launchSelection, resolveExecutionConfig } from './execution-config.js';
import { broadcaster } from '../websocket/broadcaster.js';
import * as queries from '../db/queries.js';
import { executorPool } from './executor-pool.js';
import { orchestrator } from './orchestrator.js';
import { providerQuotaService } from './provider-quota.js';
import { classifyProviderFailure } from './failure-classifier.js';
import type { ResolvedExecutionConfig } from './execution-config.js';
import { assertTestRuntimePathAllowed } from '../utils/test-fs-guard.js';
import { readLines, drainReaders } from '../utils/line-stream.js';
import * as processTree from '../utils/process-tree.js';
import { extractStructuredReplies, type AgentForumReply } from './agent-forum-extractor.js';
import { logger } from '../logging/logger.js';
import { runWithLogContext, tag } from '../logging/context.js';
import { tailOf, clampLine } from '../logging/truncate.js';

export interface AvailableTargetInfo {
  id: string;
  authorName: string;
  authorRole: string;
  authorType: 'user' | 'agent';
  snippet: string;
}

/** Minimum participants required for a discussion to be meaningful. */
export const MIN_FORUM_PARTICIPANTS = 2;

/** Root for the per-turn scratch directories AgentForum runs its CLIs in. */
export const FORUM_TEMP_ROOT = path.join(os.tmpdir(), 'aikombinat-forum');

/**
 * AgentForum is a discussion experiment, never an implementation workflow, so
 * every turn is capped hard and always runs in strict sandbox mode regardless
 * of the linked project's permissive settings.
 */
const FORUM_MAX_TURNS = 5;
const FORUM_SANDBOX_MODE: SandboxMode = 'strict';

/**
 * Upper bound on how long Stop waits for an in-flight turn startup to drain.
 * Reaching it is a failure, not a successful stop — see `stopForum`.
 */
export const DEFAULT_STOP_DRAIN_TIMEOUT_MS = 15_000;

/** Recorded on turns that were still unfinished when the server went down. */
export const FORUM_TURN_RESTART_INTERRUPT_MESSAGE =
  'Turn interrupted by application/server restart before it completed.';

/**
 * Base for every "Stop did not finish" outcome. Callers must not treat the
 * forum as idle or deletable when one of these is raised.
 */
export class ForumStopIncompleteError extends Error {
  constructor(public readonly forumId: string, message: string) {
    super(message);
    this.name = 'ForumStopIncompleteError';
  }
}

/**
 * Raised when Stop could not confirm that the cycle is quiescent. The forum is
 * left in a retryable state: cancellation stays armed, the cycle stays
 * registered, and the caller must not treat the forum as idle or deletable.
 */
export class ForumStopTimeoutError extends ForumStopIncompleteError {
  constructor(forumId: string, message: string) {
    super(forumId, message);
    this.name = 'ForumStopTimeoutError';
  }
}

/**
 * Raised when a forum parked in `error` still has an orphan process that could
 * not be confirmed terminated. Its PID and history are deliberately preserved
 * so cleanup can be retried.
 */
export class ForumRecoveryPendingError extends ForumStopIncompleteError {
  constructor(forumId: string, message: string, public readonly unresolvedOrphanProcesses: number) {
    super(forumId, message);
    this.name = 'ForumRecoveryPendingError';
  }
}

/**
 * Live state for one forum cycle. Each `runCycle` call gets a fresh object and
 * a monotonically increasing generation; identity comparison against
 * `this.cycles.get(forumId)` is what makes a superseded cycle's late completion
 * a no-op instead of a state mutation on the current cycle.
 */
interface ForumCycle {
  generation: number;
  cancelled: boolean;
  /** Console tag for this cycle, e.g. `[forum:Design review]`. */
  scope: string;
  /** PIDs spawned by this cycle that have not been observed exiting yet. */
  activePids: Set<number>;
  /** Executor-pool reservation owners still held by this cycle's turns. */
  reservationOwners: Set<string>;
}

export interface AgentForumOrchestratorOptions {
  /** Injectable for tests; production uses DEFAULT_STOP_DRAIN_TIMEOUT_MS. */
  stopDrainTimeoutMs?: number;
}

export class AgentForumOrchestrator {
  private cycles: Map<string, ForumCycle> = new Map();
  /** Turn start timestamps, so an outcome helper can report a duration. */
  private turnStartedAt: Map<string, number> = new Map();
  private cycleRuns: Map<string, Promise<void>> = new Map();
  private generationCounters: Map<string, number> = new Map();
  private readonly stopDrainTimeoutMs: number;

  constructor(options: AgentForumOrchestratorOptions = {}) {
    this.stopDrainTimeoutMs = options.stopDrainTimeoutMs ?? DEFAULT_STOP_DRAIN_TIMEOUT_MS;
  }

  /**
   * User posts a message and starts a sequential cycle.
   */
  async postUserMessage(
    forumId: string,
    content: string,
    parentMessageId?: string | null,
  ): Promise<queries.AgentForumMessage> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) throw new Error('Agent forum not found');

    if (forum.status === 'running' || this.cycles.has(forumId)) {
      throw new Error('Forum is currently running an agent cycle. Please wait for it to complete.');
    }

    // `error` means an unconfirmed Stop or an unresolved orphan process. It is
    // not a quiet idle state: continuing the conversation from here could race
    // whatever is still alive, so require the cleanup to succeed first.
    if (forum.status !== 'idle') {
      throw new Error(
        'Forum requires recovery before continuing. Run Stop to finish cleaning up the previous cycle.'
      );
    }

    // Refuse before writing anything: a user message that can never start a
    // cycle would sit in the thread with no agent able to answer it.
    const activeMembers = queries.getActiveAgentForumMembers(forumId);
    if (activeMembers.length < MIN_FORUM_PARTICIPANTS) {
      throw new Error(
        `Forum needs at least ${MIN_FORUM_PARTICIPANTS} active participants to start a cycle (currently ${activeMembers.length}).`
      );
    }

    if (parentMessageId) {
      const parentMsg = queries.getAgentForumMessageById(parentMessageId);
      if (!parentMsg || parentMsg.forum_id !== forumId) {
        throw new Error('Parent message not found in this forum');
      }
    }

    const userMsg = queries.createAgentForumMessage(
      forumId,
      'user',
      null,
      'User',
      'User',
      content.trim(),
      parentMessageId,
    );

    broadcaster.broadcast({
      type: 'forum:message-created',
      forumId,
      message: userMsg,
    });

    // Start cycle in background
    this.runCycle(forumId).catch((err) => {
      logger.error('forum.cycle.error', {
        scope: tag('forum', forum.title),
        msg: 'cycle failed',
        forumId,
        err,
      });
    });

    return userMsg;
  }

  /**
   * Stop an active forum cycle.
   *
   * Cancellation is generation-scoped and drains: after flagging the cycle we
   * kill everything already spawned, wait for any turn sitting between executor
   * admission and spawn to finish its startup, then kill whatever won that race.
   * A turn that observes the cancellation refuses to accept CLI output, so no
   * replies are created after Stop returns.
   *
   * Returning normally is a guarantee, not a best effort: the startup drained,
   * every known and late-spawned process was terminated, reservations were
   * released, no in-flight cycle remains, and the forum is safe to leave idle or
   * delete.
   *
   * If the drain deadline expires that guarantee does not hold — a PID may still
   * appear afterwards — so this throws `ForumStopTimeoutError` instead of
   * reporting success. The forum is parked in `error`, the cycle stays
   * registered (blocking delete and mutation) and cancellation stays armed so a
   * late startup still kills its process and creates no replies. Calling Stop
   * again after the run finally settles completes the transition to idle.
   */
  async stopForum(forumId: string): Promise<void> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) throw new Error('Agent forum not found');

    const forumScope = tag('forum', forum.title);
    logger.info('forum.stop.requested', {
      scope: forumScope,
      msg: 'stop requested',
      forumId,
    });

    const cycle = this.cycles.get(forumId);
    if (cycle) {
      cycle.cancelled = true;

      // 1. Terminate processes that are already running.
      await this.terminateCyclePids(cycle);

      // 2. Drain in-flight startup. A turn may currently be awaiting executor
      //    selection or the spawn itself; it must reach its own cleanup before
      //    Stop can claim the forum is quiescent.
      const run = this.cycleRuns.get(forumId);
      const drained = run ? await this.drain(run) : true;

      // 3. Terminate anything that was spawned during the drain window.
      await this.terminateCyclePids(cycle);

      if (!drained) {
        // Fail closed. Release the reservations this cycle still owns so a hung
        // startup cannot leak provider capacity permanently; the turn's own
        // cleanup releases idempotently, and any process it still manages to
        // spawn is killed immediately by the cancellation check.
        this.releaseCycleReservations(cycle);

        queries.updateAgentForum(forumId, { status: 'error', current_member_id: null });
        broadcaster.broadcast({
          type: 'forum:status-changed',
          forumId,
          status: 'error',
          currentCycle: queries.getAgentForumById(forumId)?.current_cycle ?? forum.current_cycle,
          currentMemberId: null,
        });
        orchestrator.wakeWaitingExecutors().catch(() => {});

        logger.error('forum.stop.timeout', {
          scope: forumScope,
          msg: `stop could not confirm the cycle is quiescent within ${this.stopDrainTimeoutMs}ms`,
          forumId,
          timeoutMs: this.stopDrainTimeoutMs,
          detail: 'The forum stays in recovery: cancellation is still armed and Stop must be retried.',
        });

        throw new ForumStopTimeoutError(
          forumId,
          `Stop could not confirm the forum cycle is quiescent within ${this.stopDrainTimeoutMs}ms. `
          + 'The cycle is still cancelling — retry Stop once it finishes draining.',
        );
      }
    } else if (forum.status === 'error' || forum.status === 'running') {
      // No cycle in memory, but the forum is not quiescent on disk: either it is
      // still marked `running` from a previous process (a crash, or a restart
      // between spawn and reconciliation), or it is parked in `error` by a Stop
      // that timed out or an unresolved orphan. Both cases mean a real process
      // may still be alive, so Stop must run the cleanup rather than blindly
      // flipping the row to idle. Only a confirmed clean result may do that.
      const recovery = await recoverAgentForum(forumId);
      if (recovery.unresolvedOrphanProcesses > 0) {
        // `recoverAgentForum` already parked the forum in `error`.
        broadcaster.broadcast({
          type: 'forum:status-changed',
          forumId,
          status: 'error',
          currentCycle: queries.getAgentForumById(forumId)?.current_cycle ?? forum.current_cycle,
          currentMemberId: null,
        });
        logger.error('forum.stop.recovery-pending', {
          scope: forumScope,
          msg: `stop could not confirm cleanup: ${recovery.unresolvedOrphanProcesses} orphan process(es) still alive`,
          forumId,
          unresolvedOrphanProcesses: recovery.unresolvedOrphanProcesses,
        });
        throw new ForumRecoveryPendingError(
          forumId,
          `Stop could not confirm cleanup: ${recovery.unresolvedOrphanProcesses} process(es) from the `
          + 'previous run are still alive. The forum stays in recovery — retry Stop once they exit.',
          recovery.unresolvedOrphanProcesses,
        );
      }
      // recoverAgentForum already moved the forum to idle.
      broadcaster.broadcast({
        type: 'forum:status-changed',
        forumId,
        status: 'idle',
        currentCycle: queries.getAgentForumById(forumId)?.current_cycle ?? forum.current_cycle,
        currentMemberId: null,
      });
      orchestrator.wakeWaitingExecutors().catch(() => {});
      return;
    }

    queries.updateAgentForum(forumId, {
      status: 'idle',
      current_member_id: null,
    });

    const finalForum = queries.getAgentForumById(forumId);

    broadcaster.broadcast({
      type: 'forum:status-changed',
      forumId,
      status: 'idle',
      currentCycle: finalForum?.current_cycle ?? forum.current_cycle,
      currentMemberId: null,
    });

    orchestrator.wakeWaitingExecutors().catch(() => {});
  }

  /** True while a cycle object for this forum is registered (running or draining). */
  isCycleRegistered(forumId: string): boolean {
    return this.cycles.has(forumId);
  }

  /**
   * Runs a complete sequential cycle of all active members in round-robin order.
   */
  async runCycle(forumId: string): Promise<void> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) return;

    const forumScope = tag('forum', forum.title);

    if (this.cycles.has(forumId)) {
      logger.warn('forum.cycle.already-running', {
        scope: forumScope,
        msg: 'cycle skipped: another cycle is already in flight',
        forumId,
      });
      return;
    }

    const members = queries.getActiveAgentForumMembers(forumId);
    if (members.length < MIN_FORUM_PARTICIPANTS) {
      logger.warn('forum.cycle.not-enough-members', {
        scope: forumScope,
        msg: `cycle skipped: fewer than ${MIN_FORUM_PARTICIPANTS} active participants`,
        forumId,
        activeMembers: members.length,
      });
      return;
    }

    const generation = (this.generationCounters.get(forumId) ?? 0) + 1;
    this.generationCounters.set(forumId, generation);
    const cycle: ForumCycle = {
      generation,
      cancelled: false,
      scope: forumScope,
      activePids: new Set(),
      reservationOwners: new Set(),
    };

    const nextCycleNumber = forum.current_cycle + 1;

    queries.updateAgentForum(forumId, {
      status: 'running',
      current_cycle: nextCycleNumber,
      current_member_id: null,
    });

    broadcaster.broadcast({
      type: 'forum:status-changed',
      forumId,
      status: 'running',
      currentCycle: nextCycleNumber,
      currentMemberId: null,
    });

    // Determine round-robin member rotation for this cycle
    const memberCount = members.length;
    const offset = (nextCycleNumber - 1) % memberCount;
    const orderedMembers: queries.AgentForumMember[] = [];
    for (let i = 0; i < memberCount; i++) {
      orderedMembers.push(members[(offset + i) % memberCount]);
    }

    // Register the cycle and its run promise BEFORE any turn work starts, so a
    // Stop landing on the very first tick still finds something to cancel and
    // drain. The gate keeps `executeCycle` from running ahead of registration.
    let openGate: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });

    const run = (async () => {
      await gate;
      // Every record emitted underneath — including the shared CLI spawn and
      // quota lines — inherits this forum's tag and correlation ids.
      await runWithLogContext(
        { scope: forumScope, fields: { forumId } },
        () => this.executeCycle(forumId, cycle, orderedMembers, nextCycleNumber),
      );
    })();

    this.cycles.set(forumId, cycle);
    this.cycleRuns.set(forumId, run);
    openGate!();

    try {
      await run;
    } finally {
      if (this.cycleRuns.get(forumId) === run) this.cycleRuns.delete(forumId);
      if (this.cycles.get(forumId) === cycle) this.cycles.delete(forumId);
    }
  }

  private async executeCycle(
    forumId: string,
    cycle: ForumCycle,
    orderedMembers: queries.AgentForumMember[],
    cycleNumber: number,
  ): Promise<void> {
    const cycleStartedAt = Date.now();
    logger.info('forum.cycle.started', {
      msg: `cycle #${cycleNumber} started`,
      cycleNumber,
      participants: orderedMembers.length,
    });
    try {
      for (let turnOrder = 0; turnOrder < orderedMembers.length; turnOrder++) {
        if (!this.isCycleActive(forumId, cycle)) break;
        await this.runMemberTurn(forumId, cycle, orderedMembers[turnOrder], cycleNumber, turnOrder);
      }
    } finally {
      this.logCycleSummary(forumId, cycle, cycleNumber, Date.now() - cycleStartedAt);
      // A cancelled cycle does not own the terminal transition — `stopForum`
      // performs it once the drain completes. A superseded cycle owns nothing.
      if (this.isCycleActive(forumId, cycle)) {
        const finalForum = queries.getAgentForumById(forumId);
        if (finalForum && finalForum.status === 'running') {
          queries.updateAgentForum(forumId, {
            status: 'idle',
            current_member_id: null,
          });

          broadcaster.broadcast({
            type: 'forum:status-changed',
            forumId,
            status: 'idle',
            currentCycle: cycleNumber,
            currentMemberId: null,
          });

          orchestrator.wakeWaitingExecutors().catch(() => {});
        }
      }
    }
  }

  /**
   * Runs a single turn for a specific member in the forum.
   */
  private async runMemberTurn(
    forumId: string,
    cycle: ForumCycle,
    member: queries.AgentForumMember,
    cycleNumber: number,
    turnOrder: number,
  ): Promise<void> {
    return runWithLogContext(
      { scope: `[${member.name}]`, fields: { memberId: member.id, cycleNumber } },
      () => this.runMemberTurnInner(forumId, cycle, member, cycleNumber, turnOrder),
    );
  }

  private async runMemberTurnInner(
    forumId: string,
    cycle: ForumCycle,
    member: queries.AgentForumMember,
    cycleNumber: number,
    turnOrder: number,
  ): Promise<void> {
    const forum = queries.getAgentForumById(forumId);
    if (!forum) return;

    const project = forum.project_id ? (queries.getProjectById(forum.project_id) ?? null) : null;

    const turn = queries.createAgentForumTurn(forumId, member.id, cycleNumber, turnOrder);
    this.turnStartedAt.set(turn.id, Date.now());

    queries.updateAgentForum(forumId, { current_member_id: member.id });
    broadcaster.broadcast({
      type: 'forum:status-changed',
      forumId,
      status: 'running',
      currentCycle: cycleNumber,
      currentMemberId: member.id,
    });

    queries.updateAgentForumTurn(turn.id, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    broadcaster.broadcast({
      type: 'forum:turn-started',
      forumId,
      turnId: turn.id,
      memberId: member.id,
      memberName: member.name,
      cycleNumber,
      turnOrder,
    });

    // 1. Determine available reply targets for this member
    const allMessages = queries.getAgentForumMessages(forumId);
    const alreadyRepliedTargets = queries.getAgentRepliedTargetMessageIds(forumId, member.id);

    const availableTargets: AvailableTargetInfo[] = [];
    const availableTargetIds = new Set<string>();

    for (const msg of allMessages) {
      // Agent cannot reply to its own messages
      if (msg.author_id === member.id) continue;
      // Agent cannot reply to same message more than once in entire conversation
      if (alreadyRepliedTargets.has(msg.id)) continue;

      const snippet = msg.content.length > 80 ? `${msg.content.slice(0, 80)}...` : msg.content;
      availableTargets.push({
        id: msg.id,
        authorName: msg.author_name,
        authorRole: msg.author_role,
        authorType: msg.author_type,
        snippet,
      });
      availableTargetIds.add(msg.id);
    }

    // 2. Build prompt. Project context is read server-side and embedded here —
    //    the CLI never gets the project directory itself.
    const prompt = this.buildTurnPrompt(forum, member, project, allMessages, availableTargets);

    // 3. Resolve execution configuration & quota
    const cliTool = (member.cli_tool || project?.cli_tool || 'claude') as CliTool;
    const cliModel = member.cli_model ?? undefined;
    let executionConfig: ResolvedExecutionConfig | null = null;
    let resolvedCliTool = cliTool;

    // The reservation owner is the turn, not the forum: concurrent turns must
    // each hold their own provider slot for their whole process lifetime.
    const reservationOwner = turn.id;
    let reservationHeld = false;
    let workDir: string | null = null;
    let pid: number | null = null;

    try {
      // ── Admission ─────────────────────────────────────────────────────────
      if (member.execution_profile_id) {
        const selection = await executorPool.selectExecutor({
          executionProfileId: member.execution_profile_id,
          reserveOwnerId: reservationOwner,
        });
        if (selection.status === 'selected') {
          reservationHeld = true;
          cycle.reservationOwners.add(reservationOwner);
        }

        // Async boundary crossed — the cycle may have been stopped or superseded.
        if (!this.isCycleActive(forumId, cycle)) {
          this.markTurnStopped(turn.id);
          return;
        }

        if (selection.status === 'waiting_executor') {
          this.markTurnSkipped(forumId, turn.id, member,
            `Provider concurrency limit reached for execution profile "${selection.profileName}"`);
          return;
        }
        if (selection.status === 'waiting_quota') {
          this.markTurnSkipped(forumId, turn.id, member,
            `Provider quota exhausted for execution profile "${selection.profileName}"`);
          return;
        }
        if (selection.status === 'no_candidates') {
          this.markTurnFailed(forumId, turn.id, member,
            `No eligible executors for execution profile "${selection.profileName}"`);
          return;
        }

        executionConfig = selection.selectedConfig!;
        resolvedCliTool = executionConfig.cliTool;
      } else {
        if (isAgentCliTool(cliTool) || member.cli_model_id || member.cli_effort) {
          executionConfig = resolveExecutionConfig({
            cliTool,
            model: cliModel,
            cliModelId: member.cli_model_id,
            cliEffort: member.cli_effort,
          });
          resolvedCliTool = executionConfig.cliTool;
        }

        if (isAgentCliTool(resolvedCliTool)) {
          const quota = providerQuotaService.getQuotaState(resolvedCliTool);
          if (quota.state === 'exhausted') {
            const adapter = getAdapter(resolvedCliTool);
            this.markTurnSkipped(forumId, turn.id, member,
              `Provider quota exhausted for ${adapter.displayName} (${quota.reason || 'quota exhausted'})`);
            return;
          }
        }

        reservationHeld = executorPool.reserveSlot(reservationOwner, resolvedCliTool);
        if (reservationHeld) cycle.reservationOwners.add(reservationOwner);
        if (!reservationHeld) {
          const adapter = getAdapter(resolvedCliTool);
          this.markTurnSkipped(forumId, turn.id, member,
            `Provider concurrency limit reached for ${adapter.displayName}`);
          return;
        }
      }

      logger.info('forum.turn.started', {
        msg: 'turn started',
        turnId: turn.id,
        provider: resolvedCliTool,
        ...(executionConfig?.effectiveModel ? { model: executionConfig.effectiveModel } : {}),
        ...(executionConfig?.effort.nativeEffort ? { effort: executionConfig.effort.nativeEffort } : {}),
        ...(executionConfig?.profileName ? { profile: executionConfig.profileName } : {}),
      });

      const snapshotStr = executionConfig
        ? JSON.stringify(executionSnapshot(executionConfig))
        : JSON.stringify({ configuration: 'manual', agent: resolvedCliTool });

      queries.updateAgentForumTurn(turn.id, { execution_snapshot: snapshotStr });

      // The reservation deliberately stays held from here until the CLI process
      // has terminated (see `finally`), so a running forum turn is visible to
      // provider concurrency accounting for its whole lifetime.

      workDir = this.createTurnWorkDir(forumId, turn.id);

      // Re-check immediately before spawning: Stop may have landed while the
      // snapshot / scratch-dir work above was running.
      if (!this.isCycleActive(forumId, cycle)) {
        this.markTurnStopped(turn.id);
        return;
      }

      const launch = launchSelection(executionConfig);

      const result = await claudeManager.startClaude(
        workDir,
        prompt,
        launch,
        // No project CLI options: a discussion run must not inherit flags meant
        // for implementation tasks.
        undefined,
        'headless',
        resolvedCliTool,
        FORUM_MAX_TURNS,
        // projectPath is the scratch dir, never the real project root — this is
        // what keeps Codex's writable --add-dir off the project's .git directory.
        workDir,
        FORUM_SANDBOX_MODE,
        false,
        undefined,
        undefined,
        launch.effort,
        'discussion',
      );

      pid = result.pid;
      cycle.activePids.add(pid);
      // Persist process identity immediately: if the server dies right here,
      // startup recovery needs the PID to find and terminate the orphan.
      queries.updateAgentForumTurn(turn.id, { process_pid: pid });
      // The instance fingerprint is captured off the critical path — it costs an
      // OS probe and must not delay the turn. If the server dies before it
      // lands, the PID stays unverifiable and recovery fails closed rather than
      // risking a signal to a process that merely reused the id.
      this.captureTurnProcessIdentity(turn.id, pid);

      // Post-spawn race: Stop may have completed its PID sweep before this
      // process existed. Terminate it and refuse its output.
      if (!this.isCycleActive(forumId, cycle)) {
        await this.terminatePid(cycle, pid);
        pid = null;
        this.markTurnStopped(turn.id);
        return;
      }

      const adapter = getAdapter(resolvedCliTool);
      const isJsonMode = adapter.outputFormat === 'stream-json';

      const stdoutParts: string[] = [];
      const stderrParts: string[] = [];

      // Chunk-safe line assembly: a stream-json event can be split across
      // several data chunks, and one chunk can carry several events plus a
      // partial tail.
      const stdoutReader = readLines(result.stdout, (line) => {
        if (!isJsonMode) {
          stdoutParts.push(line);
          return;
        }
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'assistant') {
            const contentArr = evt.message?.content as Array<Record<string, unknown>> | undefined;
            if (contentArr) {
              for (const blk of contentArr) {
                if (blk.type === 'text' && typeof blk.text === 'string') {
                  stdoutParts.push(blk.text);
                }
              }
            }
          } else if (evt.type === 'content_block_delta' && evt.delta?.text) {
            stdoutParts.push(evt.delta.text);
          } else if (Array.isArray(evt.replies)) {
            stdoutParts.push(line);
          }
        } catch {
          stdoutParts.push(line);
        }
      });

      const stderrReader = readLines(result.stderr, (line) => {
        stderrParts.push(line);
      });

      const exitCode = await result.exitPromise;
      // Process exit and stream drain are independent events and exit can win
      // the race, so wait for the streams before reading the collected output.
      await drainReaders([stdoutReader, stderrReader]);
      // Not every stream emits 'end'; flushing guarantees a trailing partial
      // line is not lost either way.
      stdoutReader.flush();
      stderrReader.flush();

      cycle.activePids.delete(pid);
      queries.updateAgentForumTurn(turn.id, { process_pid: null, process_identity: null });
      pid = null;

      // A stale completion belonging to a cancelled or superseded cycle must
      // never mutate the current cycle's state.
      if (!this.isCycleActive(forumId, cycle)) {
        this.markTurnStopped(turn.id);
        return;
      }

      const fullOutput = stdoutParts.join('\n').trim();
      const errorOutput = stderrParts.join('\n').trim();

      if (exitCode === 0) {
        if (isAgentCliTool(resolvedCliTool)) {
          providerQuotaService.markAvailable(resolvedCliTool, { source: 'execution_success' });
        }

        // Parse and validate structured output
        let validatedReplies: AgentForumReply[];
        try {
          validatedReplies = extractStructuredReplies(fullOutput, {
            availableTargetIds,
            maxReplyLength: forum.max_reply_length,
            currentAgentName: member.name,
          });
        } catch (validationErr) {
          const errMsg = validationErr instanceof Error ? validationErr.message : String(validationErr);
          this.markTurnFailed(forumId, turn.id, member, errMsg, fullOutput, {
            category: 'invalid_structured_output',
            provider: resolvedCliTool,
          });
          return;
        }

        if (validatedReplies.length === 0) {
          // PASS — no message created
          logger.info('forum.turn.passed', {
            msg: `PASSED after ${this.turnDuration(turn.id)}`,
            turnId: turn.id,
            provider: resolvedCliTool,
            repliesCount: 0,
          });
          queries.updateAgentForumTurn(turn.id, {
            status: 'passed',
            raw_output: fullOutput,
            completed_at: new Date().toISOString(),
          });

          broadcaster.broadcast({
            type: 'forum:turn-completed',
            forumId,
            turnId: turn.id,
            memberId: member.id,
            memberName: member.name,
            status: 'passed',
            repliesCount: 0,
          });
        } else {
          logger.info('forum.turn.completed', {
            msg: `COMPLETED after ${this.turnDuration(turn.id)}`,
            turnId: turn.id,
            provider: resolvedCliTool,
            repliesCount: validatedReplies.length,
          });
          // Persist each reply as a message node
          for (const reply of validatedReplies) {
            const msg = queries.createAgentForumMessage(
              forumId,
              'agent',
              member.id,
              member.name,
              member.role,
              reply.content,
              reply.replyTo,
              turn.id,
            );

            broadcaster.broadcast({
              type: 'forum:message-created',
              forumId,
              message: msg,
            });
          }

          queries.updateAgentForumTurn(turn.id, {
            status: 'completed',
            raw_output: fullOutput,
            completed_at: new Date().toISOString(),
          });

          broadcaster.broadcast({
            type: 'forum:turn-completed',
            forumId,
            turnId: turn.id,
            memberId: member.id,
            memberName: member.name,
            status: 'completed',
            repliesCount: validatedReplies.length,
          });
        }
      } else {
        // Runtime failure classification must see stderr too: quota and auth
        // rejections are frequently written there and nowhere else.
        const combinedOutput = [fullOutput, errorOutput].filter(Boolean).join('\n');
        const classification = classifyProviderFailure(resolvedCliTool, exitCode, combinedOutput);
        if (classification.category === 'quota_exhausted' || classification.category === 'rate_limited') {
          if (isAgentCliTool(resolvedCliTool)) {
            providerQuotaService.markExhausted(resolvedCliTool, {
              source: 'runtime_rejection',
              reason: classification.reason,
              resetAt: classification.resetAt,
            });
          }
        }

        const errMsg = `Process failed with exit code ${exitCode}: ${classification.reason || combinedOutput.slice(-300)}`;
        this.markTurnFailed(forumId, turn.id, member, errMsg, combinedOutput, {
          category: classification.category,
          exitCode,
          provider: resolvedCliTool,
          stderrTail: errorOutput,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isCycleActive(forumId, cycle)) {
        this.markTurnFailed(forumId, turn.id, member, errMsg);
      } else {
        this.markTurnStopped(turn.id);
      }
    } finally {
      if (pid !== null) cycle.activePids.delete(pid);
      // Released only here: after process termination, after a startup failure,
      // and on every stop / cancellation path. Never between admission and spawn.
      if (reservationHeld) {
        executorPool.releaseReservation(reservationOwner);
        cycle.reservationOwners.delete(reservationOwner);
      }
      if (workDir) this.cleanupTurnWorkDir(workDir);
      this.turnStartedAt.delete(turn.id);
    }
  }

  /** `1.42s` / `3ms` — matches how the spec's console examples read. */
  private turnDuration(turnId: string): string {
    const startedAt = this.turnStartedAt.get(turnId);
    if (startedAt === undefined) return 'unknown time';
    const ms = Date.now() - startedAt;
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
  }

  private turnDurationMs(turnId: string): number | undefined {
    const startedAt = this.turnStartedAt.get(turnId);
    return startedAt === undefined ? undefined : Date.now() - startedAt;
  }

  // ── Cycle lifecycle helpers ────────────────────────────────────────────────

  /**
   * The one line that answers "why did nothing appear in the chat?".
   *
   * Counted from the persisted turns rather than from in-memory bookkeeping, so
   * it reports what actually happened even when a turn ended on a path that
   * never returned to the loop. A cycle with failures or skips is a WARN: the
   * user asked a question and did not get every answer.
   */
  private logCycleSummary(forumId: string, cycle: ForumCycle, cycleNumber: number, durationMs: number): void {
    let counts = { completed: 0, passed: 0, skipped: 0, failed: 0, stopped: 0, running: 0 };
    try {
      for (const turn of queries.getAgentForumTurns(forumId)) {
        if (turn.cycle_number !== cycleNumber) continue;
        if (turn.status in counts) {
          counts[turn.status as keyof typeof counts]++;
        }
      }
    } catch (err) {
      logger.debug('forum.cycle.summary-unavailable', { msg: 'could not read cycle turns', cycleNumber, err });
      return;
    }

    const cancelled = cycle.cancelled;
    const hasProblems = counts.failed > 0 || counts.skipped > 0;
    const fields = {
      msg: cancelled
        ? `cycle #${cycleNumber} stopped`
        : hasProblems
          ? `cycle #${cycleNumber} finished with problems`
          : `cycle #${cycleNumber} finished`,
      cycleNumber,
      completed: counts.completed,
      passed: counts.passed,
      skipped: counts.skipped,
      failed: counts.failed,
      ...(counts.stopped > 0 ? { stopped: counts.stopped } : {}),
      durationMs,
    };
    if (cancelled) {
      logger.warn('forum.cycle.stopped', fields);
    } else if (hasProblems) {
      logger.warn('forum.cycle.finished-with-problems', fields);
    } else {
      logger.info('forum.cycle.finished', fields);
    }
  }

  private isCycleActive(forumId: string, cycle: ForumCycle): boolean {
    if (cycle.cancelled) return false;
    return this.cycles.get(forumId) === cycle;
  }

  /**
   * Records the OS instance fingerprint of a freshly spawned turn process.
   *
   * Fire-and-forget on purpose: the probe is an OS call and the turn must not
   * wait for it. A turn whose process already exited, or whose identity cannot
   * be read, simply keeps a null fingerprint — recovery then refuses to signal
   * that PID, which is the safe direction.
   */
  private captureTurnProcessIdentity(turnId: string, pid: number): void {
    void processTree.readProcessIdentity(pid)
      .then((identity) => {
        if (!identity) return;
        const turn = queries.getAgentForumTurnById(turnId);
        // Only attach the fingerprint while the turn still owns this PID.
        if (!turn || turn.process_pid !== pid) return;
        queries.updateAgentForumTurn(turnId, { process_identity: JSON.stringify(identity) });
      })
      .catch(() => { /* unverifiable identity is handled fail-closed at recovery */ });
  }

  private async terminatePid(cycle: ForumCycle, pid: number): Promise<void> {
    try {
      await claudeManager.stopClaude(pid);
    } catch { /* process may already be gone */ }
    cycle.activePids.delete(pid);
  }

  private async terminateCyclePids(cycle: ForumCycle): Promise<void> {
    for (const pid of Array.from(cycle.activePids)) {
      await this.terminatePid(cycle, pid);
    }
  }

  /** Resolves true when the run settled, false when the drain deadline expired. */
  private async drain(run: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.stopDrainTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([
        run.then(() => true, () => true),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private releaseCycleReservations(cycle: ForumCycle): void {
    for (const owner of Array.from(cycle.reservationOwners)) {
      executorPool.releaseReservation(owner);
      cycle.reservationOwners.delete(owner);
    }
  }

  // ── Turn outcome helpers ───────────────────────────────────────────────────

  /**
   * Transient, non-crash outcomes (provider busy / quota exhausted). Recorded as
   * an observable `skipped` turn rather than an error, so the rest of the cycle
   * keeps a consistent state and a transient capacity limit is never surfaced
   * as an internal failure.
   */
  private markTurnSkipped(
    forumId: string,
    turnId: string,
    member: queries.AgentForumMember,
    reason: string,
  ): void {
    // A skip is why the chat stayed silent, so it is never quieter than WARN.
    logger.warn('forum.turn.skipped', {
      msg: `SKIPPED after ${this.turnDuration(turnId)}`,
      turnId,
      reason: clampLine(reason),
      durationMs: this.turnDurationMs(turnId),
    });

    queries.updateAgentForumTurn(turnId, {
      status: 'skipped',
      error_message: reason,
      completed_at: new Date().toISOString(),
      process_pid: null,
      process_identity: null,
    });

    broadcaster.broadcast({
      type: 'forum:turn-skipped',
      forumId,
      turnId,
      memberId: member.id,
      memberName: member.name,
      reason,
    });
  }

  private markTurnFailed(
    forumId: string,
    turnId: string,
    member: queries.AgentForumMember,
    error: string,
    rawOutput?: string,
    diagnostics: { category?: string; exitCode?: number; provider?: string; stderrTail?: string } = {},
  ): void {
    logger.error('forum.turn.failed', {
      msg: `FAILED after ${this.turnDuration(turnId)}`,
      turnId,
      ...(diagnostics.provider ? { provider: diagnostics.provider } : {}),
      ...(diagnostics.category ? { category: diagnostics.category } : {}),
      ...(diagnostics.exitCode !== undefined ? { exitCode: diagnostics.exitCode } : {}),
      message: clampLine(error),
      durationMs: this.turnDurationMs(turnId),
      // Bounded tail only — provider output is never logged in full.
      detail: diagnostics.stderrTail ? tailOf(diagnostics.stderrTail) : undefined,
    });

    queries.updateAgentForumTurn(turnId, {
      status: 'failed',
      ...(rawOutput !== undefined ? { raw_output: rawOutput } : {}),
      error_message: error,
      completed_at: new Date().toISOString(),
      process_pid: null,
      process_identity: null,
    });

    broadcaster.broadcast({
      type: 'forum:turn-failed',
      forumId,
      turnId,
      memberId: member.id,
      memberName: member.name,
      error,
    });
  }

  private markTurnStopped(turnId: string): void {
    const turn = queries.getAgentForumTurnById(turnId);
    if (!turn) return;
    if (turn.status === 'completed' || turn.status === 'passed' || turn.status === 'failed' || turn.status === 'skipped') return;
    logger.warn('forum.turn.stopped', {
      msg: `STOPPED after ${this.turnDuration(turnId)}`,
      turnId,
      durationMs: this.turnDurationMs(turnId),
    });
    queries.updateAgentForumTurn(turnId, {
      status: 'stopped',
      error_message: 'Turn stopped before completion',
      completed_at: new Date().toISOString(),
      process_pid: null,
      process_identity: null,
    });
  }

  // ── Scratch directory ──────────────────────────────────────────────────────

  /**
   * Every turn gets its own throwaway directory. AgentForum never runs a CLI
   * with the real project root as cwd (or as a writable add-dir): provider
   * agents may hold file and shell tools, and this experiment is discussion-only.
   */
  private createTurnWorkDir(forumId: string, turnId: string): string {
    const workDir = path.join(FORUM_TEMP_ROOT, forumId, turnId);
    assertTestRuntimePathAllowed(workDir);
    fs.mkdirSync(workDir, { recursive: true });
    return workDir;
  }

  private cleanupTurnWorkDir(workDir: string): void {
    try {
      const relative = path.relative(FORUM_TEMP_ROOT, workDir);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  }

  /**
   * Builds the comprehensive prompt for an agent's turn.
   */
  private buildTurnPrompt(
    forum: queries.AgentForum,
    member: queries.AgentForumMember,
    project: queries.Project | null,
    allMessages: queries.AgentForumMessage[],
    availableTargets: AvailableTargetInfo[],
  ): string {
    // 1. Shared Project Context (if project mode). Read here, on the server, and
    //    embedded as text — the CLI is never pointed at the project itself.
    //    Missing context files are normal, not an error.
    let projectContextBlock = '';
    if (project) {
      const filesToRead = ['AGENTS.md', 'PROJECT-MAP.md', 'README.md'];
      const sections: string[] = [];

      for (const fileName of filesToRead) {
        const filePath = path.join(project.path, fileName);
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const truncated = content.length > 8000 ? `${content.slice(0, 8000)}\n...(truncated)` : content;
            sections.push(`### ${fileName}\n${truncated}`);
          }
        } catch { /* unreadable context file is not an error */ }
      }

      projectContextBlock = `## Shared Project Context\nProject Name: ${project.name}\n`;
      projectContextBlock += sections.length > 0
        ? `\n${sections.join('\n\n')}\n`
        : '(No AGENTS.md / PROJECT-MAP.md / README.md available for this project.)\n';
      projectContextBlock += '\nThis context is provided as text only. You do not have the project checked out.\n';
    }

    // 2. Full Conversation History
    let historyBlock = '## Full Forum Conversation History\n';
    if (allMessages.length === 0) {
      historyBlock += '(No messages yet)\n';
    } else {
      const msgMap = new Map<string, queries.AgentForumMessage>(allMessages.map((m) => [m.id, m]));
      for (const msg of allMessages) {
        const replyInfo = msg.parent_message_id
          ? ` [in reply to message "${msg.parent_message_id}" by ${msgMap.get(msg.parent_message_id)?.author_name ?? 'Unknown'}]`
          : ' [root message]';
        historyBlock += `--- Message ID: ${msg.id} | Author: ${msg.author_name} (${msg.author_role || msg.author_type})${replyInfo} ---\n${msg.content}\n\n`;
      }
    }

    // 3. Available Reply Targets for this specific agent
    let targetsBlock = `## Available Reply Targets for YOU (${member.name})\n`;
    if (availableTargets.length === 0) {
      targetsBlock += 'No available targets to reply to. (You must return an empty replies list: {"replies": []})\n';
    } else {
      targetsBlock += 'You may reply ONLY to one or more of the following message IDs:\n';
      for (const target of availableTargets) {
        targetsBlock += `- ${target.id} — Author: ${target.authorName} (${target.authorRole || target.authorType}): "${target.snippet}"\n`;
      }
      targetsBlock += '\n(Note: You CANNOT reply to your own messages or to messages you already replied to previously.)\n';
    }

    const memberRole = member.role ? `a ${member.role}` : 'an AI participant';
    const systemPrompt = member.system_prompt ? `\n\nPersona Instructions:\n${member.system_prompt}` : '';

    return `You are ${member.name}, ${memberRole} participating in a structured multi-agent forum discussion.${systemPrompt}

## Execution Policy (MANDATORY)
This is a discussion only. It is NOT an implementation task.
- Do NOT create, edit, or delete any files.
- Do NOT run implementation actions, builds, installs, or other shell side effects.
- Do NOT commit or push anything to any repository.
- Do NOT try to inspect the filesystem; everything you need is already in this prompt.
- Return ONLY the structured forum JSON described below.

## Forum Rules
${forum.rules}

${projectContextBlock}
${historyBlock}
${targetsBlock}
## Reply Constraints & Instructions
- Maximum length per individual reply: ${forum.max_reply_length} characters.
- You can reply to 0, 1, or multiple available target messages in this turn.
- If you have no meaningful critique, alternative, objection, answer, or new insight to add, return an empty replies list: {"replies": []}.
- DO NOT repeat what has already been said without adding new value.

## Output Format Requirement
You MUST respond with a JSON object strictly matching this schema:
\`\`\`json
{
  "replies": [
    {
      "replyTo": "<valid_message_id_from_available_targets_list>",
      "content": "<your concise reply text, max ${forum.max_reply_length} chars>"
    }
  ]
}
\`\`\`
If you have nothing to add (PASS), output:
\`\`\`json
{
  "replies": []
}
\`\`\`
Respond ONLY with the JSON object. Do not include extra conversational filler outside the JSON.`;
  }
}

export const agentForumOrchestrator = new AgentForumOrchestrator();

/** Why an orphan process was left alive by recovery. */
export type UnresolvedOrphanReason =
  /** We were allowed to signal it, but it survived (or the kill failed). */
  | 'termination_failed'
  /** The PID is alive but belongs to a different process instance now. */
  | 'identity_mismatch'
  /** The PID is alive but we could not prove which process it is. */
  | 'identity_unverifiable';

export const FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGES: Record<UnresolvedOrphanReason, string> = {
  termination_failed:
    'Recovery could not confirm the CLI process from the previous run was terminated. '
    + 'The turn keeps its process id so cleanup can be retried.',
  identity_mismatch:
    'Recovery found a live process at the recorded process id, but it is a different process instance '
    + '(the id was reused). It was NOT signalled. The turn keeps its recorded process id for inspection.',
  identity_unverifiable:
    'Recovery could not verify that the live process at the recorded process id is the one this turn '
    + 'started, so it was NOT signalled. The turn keeps its recorded process id for inspection.',
};

/** Recorded on a turn whose orphan process could not be confirmed terminated. */
export const FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGE =
  FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGES.termination_failed;

/** Server-side detail about an orphan we failed to clean up. Never sent to clients. */
export interface UnresolvedOrphanProcess {
  forumId: string;
  turnId: string;
  pid: number;
  reason: UnresolvedOrphanReason;
}

/** Server-side detail about a forum whose recovery threw unexpectedly. */
export interface ForumRecoveryFailure {
  forumId: string;
  error: string;
}

export interface ForumRecoveryReport {
  forumsRecovered: number;
  turnsReconciled: number;
  orphanProcessesTerminated: number;
  unresolvedOrphanProcesses: number;
  /** Forums whose recovery threw and were therefore left closed. */
  forumsFailed: number;
  /** Log/debug detail; kept server-side. */
  unresolvedOrphans: UnresolvedOrphanProcess[];
  recoveryFailures: ForumRecoveryFailure[];
}

function emptyRecoveryReport(): ForumRecoveryReport {
  return {
    forumsRecovered: 0,
    turnsReconciled: 0,
    orphanProcessesTerminated: 0,
    unresolvedOrphanProcesses: 0,
    forumsFailed: 0,
    unresolvedOrphans: [],
    recoveryFailures: [],
  };
}

/**
 * Recovers one forum left behind by a crash, restart or an unconfirmed Stop.
 *
 * For each turn that never finished (or still holds a PID) we try to terminate
 * the orphan process tree. `claudeManager.stopClaude` cannot help here: after a
 * restart its in-memory map is empty, so it would silently no-op.
 *
 * A live PID is never signalled on the strength of the number alone. The OS
 * reuses process ids, so the recorded instance fingerprint must still match
 * before anything is killed; a mismatch or an unverifiable identity leaves that
 * process untouched. Leaving a real orphan running is recoverable — killing an
 * unrelated process that inherited the id is not.
 *
 * Termination itself counts as successful only when the helper reports success
 * or a follow-up liveness probe shows the process is gone. Anything else is an
 * unresolved orphan, handled fail-closed: the turn keeps its PID, fingerprint
 * and unfinished status, the forum stays in `error`, and recovery (or Stop) can
 * be retried later. History, snapshots and messages are never destroyed.
 */
export async function recoverAgentForum(forumId: string): Promise<ForumRecoveryReport> {
  const report = emptyRecoveryReport();
  const forum = queries.getAgentForumById(forumId);
  if (!forum) return report;

  const candidates = queries.getAgentForumTurnsNeedingRecovery(forumId);
  const resolvedTurnIds: string[] = [];

  const leaveUnresolved = (turnId: string, pid: number, reason: UnresolvedOrphanReason) => {
    report.unresolvedOrphans.push({ forumId, turnId, pid, reason });
    queries.updateAgentForumTurn(turnId, {
      error_message: FORUM_TURN_UNRESOLVED_ORPHAN_MESSAGES[reason],
    });
  };

  for (const turn of candidates) {
    if (!turn.process_pid) {
      resolvedTurnIds.push(turn.id);
      continue;
    }

    // A surviving PID is an orphan, never a healthy running execution:
    // nothing in this process owns its streams or its exit any more.
    if (!processTree.isProcessAlive(turn.process_pid)) {
      resolvedTurnIds.push(turn.id);
      continue;
    }

    // Something is alive at that id — prove it is OUR process before signalling.
    let verdict: processTree.ProcessIdentityVerdict;
    try {
      verdict = await processTree.verifyProcessIdentity(
        turn.process_pid,
        processTree.parseProcessIdentity(turn.process_identity),
      );
    } catch {
      verdict = 'unverifiable';
    }

    if (verdict !== 'match') {
      logger.warn('forum.recovery.identity-unconfirmed', {
        scope: tag('forum', forum.title),
        msg: `not signalling pid ${turn.process_pid}: process identity ${verdict}`,
        forumId,
        turnId: turn.id,
        pid: turn.process_pid,
        verdict,
      });
      leaveUnresolved(
        turn.id,
        turn.process_pid,
        verdict === 'mismatch' ? 'identity_mismatch' : 'identity_unverifiable',
      );
      continue;
    }

    let terminated = false;
    try {
      terminated = await processTree.terminateProcessTree(turn.process_pid);
    } catch (err) {
      logger.warn('forum.recovery.orphan-terminate-failed', {
        scope: tag('forum', forum.title),
        msg: `could not terminate orphan process ${turn.process_pid}`,
        forumId,
        turnId: turn.id,
        pid: turn.process_pid,
        err,
      });
    }

    // Trust the outcome only if the helper said so, or the process is verifiably
    // gone. A `false`/throwing terminate with a live PID must NOT be reconciled.
    if (!terminated && processTree.isProcessAlive(turn.process_pid)) {
      leaveUnresolved(turn.id, turn.process_pid, 'termination_failed');
      continue;
    }

    report.orphanProcessesTerminated++;
    resolvedTurnIds.push(turn.id);
  }

  report.turnsReconciled += queries.markAgentForumTurnsInterrupted(
    forumId,
    FORUM_TURN_RESTART_INTERRUPT_MESSAGE,
    resolvedTurnIds,
  );
  report.unresolvedOrphanProcesses = report.unresolvedOrphans.length;

  if (report.unresolvedOrphans.length > 0) {
    // Fail closed: a process we could not kill — or were not allowed to touch —
    // must not leave the forum looking clean.
    queries.updateAgentForum(forumId, { status: 'error', current_member_id: null });
    logger.error('forum.recovery.unresolved', {
      scope: tag('forum', forum.title),
      msg: `forum left in error: ${report.unresolvedOrphans.length} unresolved process(es)`,
      forumId,
      unresolved: report.unresolvedOrphans.length,
      detail: report.unresolvedOrphans.map((o) => `pid ${o.pid}: ${o.reason}`).join('\n'),
    });
    return report;
  }

  queries.updateAgentForum(forumId, { status: 'idle', current_member_id: null });
  report.forumsRecovered = 1;
  logger.info('forum.recovery.completed', {
    scope: tag('forum', forum.title),
    msg: 'recovered to idle',
    forumId,
    turnsReconciled: report.turnsReconciled,
    orphansTerminated: report.orphanProcessesTerminated,
  });
  return report;
}

/**
 * Startup recovery for AgentForum.
 *
 * Covers forums left `running` by a crash and forums parked in `error` by a
 * Stop that could not be confirmed, as long as they still have something
 * concrete to reconcile. Forums whose `error` has already been cleaned up are
 * not touched.
 *
 * Each forum is recovered in isolation: an unexpected failure on one leaves
 * that forum closed (`error`, with its turns and PIDs untouched) and recovery
 * moves on to the next. A forum with an orphan that refuses to die — or one we
 * are not allowed to signal — stays in `error` too, so one stuck process cannot
 * hold AIKombinat hostage while still failing closed at its own endpoints.
 */
export async function recoverInterruptedAgentForums(): Promise<ForumRecoveryReport> {
  const report = emptyRecoveryReport();
  const forums = queries.getAgentForumsNeedingRecovery();
  if (forums.length === 0) return report;

  logger.warn('forum.recovery.started', {
    scope: '[forum]',
    msg: `recovering ${forums.length} agent forum(s) needing recovery`,
    count: forums.length,
  });
  for (const forum of forums) {
    try {
      const forumReport = await recoverAgentForum(forum.id);
      report.forumsRecovered += forumReport.forumsRecovered;
      report.turnsReconciled += forumReport.turnsReconciled;
      report.orphanProcessesTerminated += forumReport.orphanProcessesTerminated;
      report.unresolvedOrphans.push(...forumReport.unresolvedOrphans);
    } catch (err) {
      // One broken forum must not stop the others from being reconciled, and it
      // must never be quietly marked idle — leave it closed for a later retry.
      const message = err instanceof Error ? err.message : String(err);
      report.recoveryFailures.push({ forumId: forum.id, error: message });
      try {
        queries.updateAgentForum(forum.id, { status: 'error', current_member_id: null });
      } catch { /* the DB itself is unhappy; the log below is all we can do */ }
      logger.error('forum.recovery.failed', {
        scope: tag('forum', forum.title),
        msg: 'recovery failed - forum stays closed',
        forumId: forum.id,
        message,
      });
    }
  }
  report.unresolvedOrphanProcesses = report.unresolvedOrphans.length;
  report.forumsFailed = report.recoveryFailures.length;

  return report;
}
