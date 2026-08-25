import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeManager } from './claude-manager.js';
import { getAdapter, type CliTool, type SandboxMode } from './cli-adapters.js';
import { isAgentCliTool } from './provider-types.js';
import { executionSnapshot, resolveExecutionConfig } from './execution-config.js';
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
 * Raised when Stop could not confirm that the cycle is quiescent. The forum is
 * left in a retryable state: cancellation stays armed, the cycle stays
 * registered, and the caller must not treat the forum as idle or deletable.
 */
export class ForumStopTimeoutError extends Error {
  constructor(public readonly forumId: string, message: string) {
    super(message);
    this.name = 'ForumStopTimeoutError';
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
      console.error(`[agent-forum] Cycle error in forum ${forumId}:`, err);
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

        throw new ForumStopTimeoutError(
          forumId,
          `Stop could not confirm the forum cycle is quiescent within ${this.stopDrainTimeoutMs}ms. `
          + 'The cycle is still cancelling — retry Stop once it finishes draining.',
        );
      }
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

    if (this.cycles.has(forumId)) {
      console.warn(`[agent-forum] Forum ${forumId} already has a cycle in flight. Skipping.`);
      return;
    }

    const members = queries.getActiveAgentForumMembers(forumId);
    if (members.length < MIN_FORUM_PARTICIPANTS) {
      console.warn(`[agent-forum] Forum ${forumId} has fewer than ${MIN_FORUM_PARTICIPANTS} active members. Skipping cycle.`);
      return;
    }

    const generation = (this.generationCounters.get(forumId) ?? 0) + 1;
    this.generationCounters.set(forumId, generation);
    const cycle: ForumCycle = { generation, cancelled: false, activePids: new Set(), reservationOwners: new Set() };

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
      await this.executeCycle(forumId, cycle, orderedMembers, nextCycleNumber);
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
    try {
      for (let turnOrder = 0; turnOrder < orderedMembers.length; turnOrder++) {
        if (!this.isCycleActive(forumId, cycle)) break;
        await this.runMemberTurn(forumId, cycle, orderedMembers[turnOrder], cycleNumber, turnOrder);
      }
    } finally {
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
    const forum = queries.getAgentForumById(forumId);
    if (!forum) return;

    const project = forum.project_id ? (queries.getProjectById(forum.project_id) ?? null) : null;

    const turn = queries.createAgentForumTurn(forumId, member.id, cycleNumber, turnOrder);

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

      const launchModel = executionConfig?.effectiveModel ?? executionConfig?.model;
      const launchEffort = (resolvedCliTool === 'antigravity' && executionConfig?.effectiveModel && executionConfig.effectiveModel !== executionConfig.model)
        ? undefined
        : executionConfig?.effort.nativeEffort;

      const result = await claudeManager.startClaude(
        workDir,
        prompt,
        launchModel,
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
        launchEffort,
        'discussion',
      );

      pid = result.pid;
      cycle.activePids.add(pid);
      // Persist process identity immediately: if the server dies right here,
      // startup recovery needs the PID to find and terminate the orphan.
      queries.updateAgentForumTurn(turn.id, { process_pid: pid });

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
      queries.updateAgentForumTurn(turn.id, { process_pid: null });
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
          this.markTurnFailed(forumId, turn.id, member, errMsg, fullOutput);
          return;
        }

        if (validatedReplies.length === 0) {
          // PASS — no message created
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
        this.markTurnFailed(forumId, turn.id, member, errMsg, combinedOutput);
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
    }
  }

  // ── Cycle lifecycle helpers ────────────────────────────────────────────────

  private isCycleActive(forumId: string, cycle: ForumCycle): boolean {
    if (cycle.cancelled) return false;
    return this.cycles.get(forumId) === cycle;
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
    queries.updateAgentForumTurn(turnId, {
      status: 'skipped',
      error_message: reason,
      completed_at: new Date().toISOString(),
      process_pid: null,
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
  ): void {
    queries.updateAgentForumTurn(turnId, {
      status: 'failed',
      ...(rawOutput !== undefined ? { raw_output: rawOutput } : {}),
      error_message: error,
      completed_at: new Date().toISOString(),
      process_pid: null,
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
    queries.updateAgentForumTurn(turnId, {
      status: 'stopped',
      error_message: 'Turn stopped before completion',
      completed_at: new Date().toISOString(),
      process_pid: null,
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

export interface ForumRecoveryReport {
  forumsRecovered: number;
  turnsReconciled: number;
  orphanProcessesTerminated: number;
}

/**
 * Startup recovery for AgentForum.
 *
 * A forum left in `running` by a crash or restart has no owning cycle any more:
 * the orchestrator's in-memory maps are empty and `claudeManager` no longer
 * knows any of the PIDs it spawned. Resetting only the forum row leaves its
 * turns stuck in `pending`/`running` forever, and any CLI the old process
 * started keeps running as an orphan.
 *
 * So for each stale forum: terminate the orphan process tree of every unfinished
 * turn that still has a live PID, reconcile those turns to `stopped`, and return
 * the forum to `idle`. Completed / passed / failed / skipped / stopped turns,
 * their snapshots and all messages are left untouched.
 */
export async function recoverInterruptedAgentForums(): Promise<ForumRecoveryReport> {
  const report: ForumRecoveryReport = {
    forumsRecovered: 0,
    turnsReconciled: 0,
    orphanProcessesTerminated: 0,
  };

  const staleForums = queries.getRunningAgentForums();
  for (const forum of staleForums) {
    const unfinished = queries.getUnfinishedAgentForumTurns(forum.id);

    for (const turn of unfinished) {
      if (!turn.process_pid) continue;
      // A surviving PID is an orphan, never a healthy running execution:
      // nothing in this process owns its streams or its exit any more.
      if (!processTree.isProcessAlive(turn.process_pid)) continue;
      try {
        const terminated = await processTree.terminateProcessTree(turn.process_pid);
        if (terminated) report.orphanProcessesTerminated++;
      } catch (err) {
        // Best-effort: a process we cannot signal must not block reconciliation.
        console.warn(
          `[agent-forum] Could not terminate orphan process ${turn.process_pid} `
          + `for turn ${turn.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    report.turnsReconciled += queries.markAgentForumTurnsInterrupted(
      forum.id,
      FORUM_TURN_RESTART_INTERRUPT_MESSAGE,
    );
    queries.updateAgentForum(forum.id, { status: 'idle', current_member_id: null });
    report.forumsRecovered++;

    console.log(`  Reset agent forum "${forum.title}" (${forum.id}) from running to idle`);
  }

  return report;
}
