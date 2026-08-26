import { claudeManager } from './claude-manager.js';
import { worktreeManager } from './worktree-manager.js';
import { getAdapter, supportsInteractiveMode, type CliTool, type SandboxMode } from './cli-adapters.js';
import { isAgentCliTool } from './provider-types.js';
import { executionSnapshot, launchSelection, resolveExecutionConfig } from './execution-config.js';
import { broadcaster, encodeSessionFrame } from '../websocket/broadcaster.js';
import { applyMemoryInjection } from './memory-inject-hook.js';
import { parseMemoryNodeIds, parseRawFilePaths, type MemoryInjectMode } from './memory-injector.js';
import { broadcastProjectStatus } from './project-status.js';
import { logger } from '../logging/logger.js';
import { tag } from '../logging/context.js';
import { clampLine } from '../logging/truncate.js';
import { snapshotWorkingTree } from '../lib/git-diff.js';
import { executorPool } from './executor-pool.js';
import { orchestrator } from './orchestrator.js';
import { providerQuotaService } from './provider-quota.js';
import { classifyProviderFailure } from './failure-classifier.js';
import type { ResolvedExecutionConfig } from './execution-config.js';
import { parseStoredResourceRequirements, RESOURCE_CATALOG } from './resource-catalog.js';
import { resourceManager } from './resource-manager.js';
import * as queries from '../db/queries.js';

const RAW_FLUSH_BYTES = 4 * 1024;
const RAW_FLUSH_MS = 100;
const RAW_DB_CAP_BYTES = 2 * 1024 * 1024;
// Enforce the DB cap only after this many bytes have been appended since the
// last trim — trimming on every flush scanned the whole per-session chunk
// table every ≤100ms and blocked the event loop under heavy TUI output.
const RAW_TRIM_EVERY_BYTES = 256 * 1024;
const STALE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

export type SessionRunToken = string;

export class SessionManager {
  // Monotonically increasing run generation per session to isolate transient state across runs
  private sessionRunGenerations: Map<string, number> = new Map();
  // sessionId -> currently active execution run token
  private activeRunTokens: Map<string, SessionRunToken> = new Map();

  // Guard set to prevent race conditions during stopSession kill window
  private stoppingSessionIds: Set<string> = new Set();
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private processAliveChecker: ((pid: number) => boolean) | null = null;

  constructor(
    private readonly isProcessAliveFn: (pid: number) => boolean = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  ) {}

  private isProcessAlive(pid: number): boolean {
    if (this.processAliveChecker) return this.processAliveChecker(pid);
    return this.isProcessAliveFn(pid);
  }

  setProcessAliveCheckerForTesting(checker: ((pid: number) => boolean) | null): void {
    this.processAliveChecker = checker;
  }

  /**
   * Start periodic process liveness check for sessions.
   * Detects sessions stuck in 'running' state whose process has already exited.
   */
  startStaleProcessChecker(): void {
    if (this.staleCheckTimer) return;
    this.staleCheckTimer = setInterval(() => this.recoverStaleSessions(), STALE_CHECK_INTERVAL_MS);
    this.staleCheckTimer.unref?.();
  }

  stopStaleProcessChecker(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  /**
   * Find persisted/recovered sessions marked 'running' whose process is no longer alive,
   * and mark them as failed.
   */
  recoverStaleSessions(): number {
    const runningSessions = queries.getSessionsByStatus('running');
    let recoveredCount = 0;
    for (const session of runningSessions) {
      if (this.activeRunTokens.has(session.id)) continue;
      if (this.stoppingSessionIds.has(session.id)) continue;

      const pid = session.process_pid;
      if (pid && pid > 0 && this.isProcessAlive(pid)) {
        continue;
      }

      const msg = 'Process exited unexpectedly (detected by liveness check).';
      logger.error('session.process.vanished', {
        scope: tag('session', session.title),
        msg: 'process exited unexpectedly (detected by liveness check)',
        sessionId: session.id,
        projectId: session.project_id,
        pid,
      });
      try {
        queries.updateSessionStatus(session.id, 'failed');
        queries.createSessionLog(session.id, 'error', msg);
        queries.updateSession(session.id, { process_pid: 0 });
        resourceManager.releaseOwner('session', session.id);
      } catch {
        try {
          queries.updateSessionStatus(session.id, 'failed');
          queries.updateSession(session.id, { process_pid: 0 });
          resourceManager.releaseOwner('session', session.id);
        } catch { /* ignore */ }
      }
      broadcaster.broadcast({ type: 'session:log', sessionId: session.id, message: msg, logType: 'error' });
      broadcaster.broadcast({ type: 'session:status-changed', sessionId: session.id, status: 'failed' });
      broadcastProjectStatus(session.project_id);
      recoveredCount++;
    }

    if (recoveredCount > 0) {
      orchestrator.wakeWaitingExecutors().catch(() => {});
    }

    return recoveredCount;
  }

  resetForTesting(): void {
    this.stopStaleProcessChecker();
    this.processAliveChecker = null;
    this.sessionRunGenerations.clear();
    this.activeRunTokens.clear();
    this.runFlushers.clear();
    this.runRawUnsubscribes.clear();
    this.runInitialPrompts.clear();
    this.runStartupBuffers.clear();
    this.livePids.clear();
    this.pendingBaseSnapshots.clear();
    this.stoppingSessionIds.clear();
  }

  // runToken -> pending-flush callback so we can drain the byte buffer when
  // the PTY exits or the user stops the session.
  private runFlushers: Map<SessionRunToken, () => void> = new Map();

  // runToken -> raw PTY unsubscribe callback
  private runRawUnsubscribes: Map<SessionRunToken, () => void> = new Map();

  // Initial prompts (description + optional injected wiki) keyed by runToken that have NOT been
  // submitted to the PTY yet. We hold them so the user gets to review the
  // payload — including any auto-retrieved wiki nodes — and explicitly hit
  // Send (or Skip) instead of having the prompt fire the moment the CLI
  // emits its ready indicator.
  private runInitialPrompts: Map<SessionRunToken, string> = new Map();

  // Per-run type-ahead queue. While the session has status='running'
  // but the PTY hasn't spawned yet (process_pid still 0), every
  // terminal-input WS message is appended here instead of being dropped
  // or written to a non-existent PTY. A buffer presence is the gate —
  // `writeTerminalInput` always checks the map first; the drain block at
  // the end of `startSession` deletes the entry atomically with the
  // process_pid DB update so subsequent input goes straight to the PTY
  // without any reordering window.
  private runStartupBuffers: Map<SessionRunToken, string[]> = new Map();

  // sessionId → live PTY pid. Keystroke routing hot path: writeTerminalInput
  // fires on every WS terminal-input message, and looking the pid up in the
  // DB per keystroke stalls input echo whenever SQLite is busy with raw-chunk
  // flushes. Populated by the drain block in startSession, cleared on
  // stop/exit; the DB lookup remains as the fallback for cache misses.
  private livePids: Map<string, number> = new Map();

  // sessionId → in-flight diff-base snapshot (started just before PTY spawn,
  // resolves after base_commit lands in the DB). The Diff route awaits this
  // instead of falling back to a HEAD-only diff that hides untracked files.
  private pendingBaseSnapshots: Map<string, Promise<void>> = new Map();

  /** Resolves once the session's diff-base snapshot (if in flight) is in the DB. */
  async waitForBaseSnapshot(sessionId: string): Promise<void> {
    const pending = this.pendingBaseSnapshots.get(sessionId);
    if (pending) await pending;
  }

  /**
   * Hook the raw PTY byte stream of `pid` into:
   *   1. live binary WS frames to currently subscribed clients
   *   2. batched (≥4KB or 100ms) appends to `session_raw_chunks` for replay
   *
   * Memory-bounded by the upstream ring buffer in claudeManager and by
   * `trimSessionRawChunks` (~2MB rolling) on the DB side.
   */
  private subscribeRawForSession(sessionId: string, pid: number, runToken: SessionRunToken): void {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let bytesSinceTrim = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (pending.length === 0) return;
      if (this.activeRunTokens.get(sessionId) !== runToken) {
        pending = [];
        pendingBytes = 0;
        return;
      }
      const buf = Buffer.concat(pending);
      pending = [];
      pendingBytes = 0;
      try {
        queries.appendSessionRawChunk(sessionId, buf);
        bytesSinceTrim += buf.length;
        if (bytesSinceTrim >= RAW_TRIM_EVERY_BYTES) {
          bytesSinceTrim = 0;
          queries.trimSessionRawChunks(sessionId, RAW_DB_CAP_BYTES);
        }
      } catch { /* DB may be locked or session deleted; drop chunk */ }
    };

    const unsub = claudeManager.subscribeRaw(pid, (chunk) => {
      // Guard: if run was superseded or stopped, drop chunk immediately
      if (this.activeRunTokens.get(sessionId) !== runToken) {
        if (timer) { clearTimeout(timer); timer = null; }
        pending = [];
        pendingBytes = 0;
        return;
      }

      const buf = Buffer.from(chunk, 'utf8');
      pending.push(buf);
      pendingBytes += buf.length;

      // Live broadcast — only currently-subscribed clients receive the bytes.
      try {
        broadcaster.sendBinaryToSubscribers(sessionId, encodeSessionFrame(sessionId, buf));
      } catch { /* ignore */ }

      if (pendingBytes >= RAW_FLUSH_BYTES) {
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, RAW_FLUSH_MS);
      }
    }, true);

    this.runFlushers.set(runToken, flush);
    this.runRawUnsubscribes.set(runToken, unsub);
  }

  private flushAndForgetRaw(runToken: SessionRunToken): void {
    const flusher = this.runFlushers.get(runToken);
    if (flusher) {
      try { flusher(); } catch { /* ignore */ }
      this.runFlushers.delete(runToken);
    }
    const unsub = this.runRawUnsubscribes.get(runToken);
    if (unsub) {
      try { unsub(); } catch { /* ignore */ }
      this.runRawUnsubscribes.delete(runToken);
    }
  }

  /**
   * Drain any in-flight raw bytes for `sessionId` to `session_raw_chunks`
   * without tearing down the subscription. Call this immediately before
   * reading DB chunks for replay so the persisted history is the single
   * source of truth — otherwise the in-memory PTY ring would still hold
   * the most recent ~100ms of bytes and replaying both would duplicate.
   */
  flushPendingRaw(sessionId: string): void {
    const runToken = this.activeRunTokens.get(sessionId);
    if (runToken === undefined) return;
    const flusher = this.runFlushers.get(runToken);
    if (!flusher) return;
    try { flusher(); } catch { /* ignore */ }
  }

  /**
   * Start a session (always interactive mode).
   *
   * `opts.cols` / `opts.rows` come from the client xterm.js after FitAddon
   * resolves. Spawning the PTY at the actual rendered size avoids the
   * 200x50-default-then-resize race where Claude Code's TUI banner ends up
   * misaligned in scrollback. If the caller doesn't supply dims (e.g.
   * plugin or curl direct hit), fall back to 100x30 — small enough that a
   * later wider client still renders the welcome banner cleanly.
   */
  async startSession(sessionId: string, opts?: { cols?: number; rows?: number; continueSession?: boolean }): Promise<void> {
    const session = queries.getSessionById(sessionId);
    if (!session) throw new Error('Session not found');

    const project = queries.getProjectById(session.project_id);
    if (!project) throw new Error('Project not found');

    const generation = (this.sessionRunGenerations.get(sessionId) ?? 0) + 1;
    this.sessionRunGenerations.set(sessionId, generation);
    const runToken: SessionRunToken = `${sessionId}:${generation}`;
    this.activeRunTokens.set(sessionId, runToken);

    let hasReservation = false;
    let hasResources = false;
    let isRunningPersisted = false;
    let executionConfig: ResolvedExecutionConfig | null = null;
    let resolvedCliTool = (session.cli_tool || project.cli_tool || 'claude') as CliTool;
    const cliModel = session.cli_model ?? undefined;
    let adapter: ReturnType<typeof getAdapter> | null = null;
    let worktreePath: string | null = null;
    let branchName: string | null = null;
    let workDir = project.path;
    let useWorktree = false;

    try {
      if (session.execution_profile_id) {
        const selection = await executorPool.selectExecutor({
          executionProfileId: session.execution_profile_id,
          interactive: true,
          excludeSessionId: sessionId,
          reserveOwnerId: sessionId,
        });
        if (selection.status === 'waiting_executor') {
          throw new Error(
            `Provider concurrency limit reached for profile "${selection.profileName}":\n\n${selection.rejectionSummary}`
          );
        }
        if (selection.status === 'no_candidates') {
          throw new Error(
            `Execution profile "${selection.profileName}" has no eligible interactive executors:\n\n${selection.rejectionSummary}`
          );
        }
        hasReservation = true;
        executionConfig = selection.selectedConfig!;
        resolvedCliTool = executionConfig.cliTool;
      } else {
        if (isAgentCliTool(resolvedCliTool) || session.cli_model_id || session.cli_effort) {
          executionConfig = resolveExecutionConfig({
            cliTool: resolvedCliTool,
            model: cliModel,
            cliModelId: session.cli_model_id,
            cliEffort: session.cli_effort,
            interactive: true,
          });
          resolvedCliTool = executionConfig.cliTool;
        }

        // Quota preflight for manual session (agents only, not raw-shell)
        if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
          const quota = providerQuotaService.getQuotaState(resolvedCliTool);
          if (quota.state === 'exhausted') {
            adapter = getAdapter(resolvedCliTool);
            throw new Error(
              `Provider quota exhausted for ${adapter.displayName} (${quota.reason || 'provider quota is currently exhausted'}). Please try again later.`
            );
          }
        }

        const reserved = executorPool.reserveSlot(sessionId, resolvedCliTool, { excludeSessionId: sessionId });
        if (!reserved) {
          adapter = getAdapter(resolvedCliTool);
          const usage = executorPool.getActiveToolUsage(resolvedCliTool, { excludeSessionId: sessionId });
          const limit = executorPool.getLimit(resolvedCliTool);
          throw new Error(
            `Provider concurrency limit reached for ${adapter.displayName} (${usage}/${limit} active). Please try again later.`
          );
        }
        hasReservation = true;
      }

      if (!supportsInteractiveMode(resolvedCliTool)) {
        throw new Error(`${resolvedCliTool} does not support interactive mode`);
      }
      const isRawShell = resolvedCliTool === 'raw-shell';

      const requirements = parseStoredResourceRequirements(session.resource_requirements);
      const acquisition = resourceManager.acquireAtomic({
        ownerType: 'session', ownerId: sessionId, runToken, resources: requirements,
      });
      if (acquisition.status === 'busy') {
        const busyLabels = acquisition.busy.map((busy) => {
          const definition = RESOURCE_CATALOG.find((resource) => resource.key === busy.key)!;
          return `${definition.label} (${definition.key})`;
        });
        throw new Error(`Required resources are busy: ${busyLabels.join(', ')}`);
      }
      hasResources = requirements.length > 0;
      if (hasResources) queries.createSessionLog(sessionId, 'output', `[resource-manager] Acquired resources: ${requirements.join(', ')}`);

      useWorktree = !!session.use_worktree && !!project.is_git_repo;
      const resume = !!opts?.continueSession;
      if (resume) {
        if (isRawShell) {
          throw new Error('Resume is not supported for raw shell sessions');
        }
        // --continue is currently only wired for Claude in interactive mode.
        // Antigravity/Codex have the adapter flag but their interactive resume is
        // not yet validated, so reject early with a clear message.
        if (resolvedCliTool !== 'claude') {
          throw new Error('Resume is only supported for Claude sessions');
        }
        // claude --continue picks the latest conversation in the cwd. If the
        // session runs at the project root, that latest can easily be a todo
        // executor's conversation — refuse and force a worktree session.
        if (!useWorktree || !session.worktree_path) {
          throw new Error('Resume requires a worktree session');
        }
      }

      adapter = getAdapter(resolvedCliTool);

      // Persist execution identity and mark status='running' synchronously, then immediately release reservation
      const snapshotStr = executionConfig
        ? JSON.stringify(executionSnapshot(executionConfig))
        : JSON.stringify({ configuration: 'manual', agent: resolvedCliTool });
      queries.updateSession(sessionId, { execution_snapshot: snapshotStr });
      if (executionConfig) {
        queries.createSessionLog(sessionId, 'info', `[execution] ${snapshotStr}`);
      }
      queries.updateSessionStatus(sessionId, 'running');
      executorPool.releaseReservation(sessionId);
      hasReservation = false;
      isRunningPersisted = true;

      // Establish initial prompt gate BEFORE opening startup buffering so type-ahead cannot bypass Send/Skip
      const memMode = ((session.memory_inject_mode as MemoryInjectMode | null) || 'none') as MemoryInjectMode;
      const rawFilePaths = parseRawFilePaths(session.memory_raw_file_paths);
      const willHaveInitialPrompt = !isRawShell && !resume && (!!session.description?.trim() || memMode !== 'none' || rawFilePaths.length > 0);

      if (willHaveInitialPrompt) {
        this.runInitialPrompts.set(runToken, session.description || '');
      } else {
        this.runInitialPrompts.delete(runToken);
      }

      this.runStartupBuffers.set(runToken, []);

      let prompt = session.description || '';

      // Inject long-term memory if configured for this session. Mirrors the
      // todo/discussion flow: prepend a <long_term_memory> block to the initial
      // PTY prompt so the CLI sees both the wiki context and the user's request
      // as one combined first turn. Skipped on resume — the prior conversation
      // already contains the same block, and we don't want to fire a fresh
      // initial prompt on top of restored history.
      // Raw-shell never consumes a prompt at all — it's a regular OS shell —
      // so memory injection is unconditionally skipped.
      if (!isRawShell && !resume && (memMode !== 'none' || rawFilePaths.length > 0)) {
        const memBlock = await applyMemoryInjection({
          projectId: project.id,
          mode: memMode,
          nodeIds: parseMemoryNodeIds(session.memory_node_ids),
          rawFilePaths,
          vaultFilePaths: rawFilePaths,
          projectRoot: project.path,
          query: `${session.title}\n${session.description ?? ''}`.trim(),
          log: (type, message) => queries.createSessionLog(sessionId, type, message),
        });
        if (memBlock) {
          prompt = prompt ? `${memBlock}\n\n${prompt}` : memBlock;
        }
      }

      // Update final prepared prompt in runInitialPrompts
      if (!isRawShell && !resume && prompt.trim()) {
        this.runInitialPrompts.set(runToken, prompt);
      } else {
        this.runInitialPrompts.delete(runToken);
      }

      // Worktree setup
      if (useWorktree) {
        // Reuse existing worktree if available
        if (session.worktree_path && session.branch_name && await worktreeManager.isValidWorktree(session.worktree_path)) {
          worktreePath = session.worktree_path;
          branchName = session.branch_name;
          workDir = worktreePath;
          queries.createSessionLog(sessionId, 'output', `Reusing existing worktree on branch ${branchName}`);
        } else {
          const requestedBranch = worktreeManager.sanitizeBranchName(`session-${session.title}`);
          const created = await worktreeManager.createWorktree(project.path, requestedBranch, !!project.npm_auto_install);
          worktreePath = created.worktreePath;
          branchName = created.branchName;
          workDir = worktreePath;
          queries.createSessionLog(sessionId, 'output', `Created worktree on branch ${branchName}`);
        }
      }

      // Snapshot the working tree once at first start (kept across resume) as the
      // baseline for the Diff view.
      if (!session.base_commit && project.is_git_repo) {
        const snapshot = snapshotWorkingTree(workDir)
          .then((base) => { if (base) queries.updateSession(sessionId, { base_commit: base }); })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            queries.createSessionLog(sessionId, 'error', `Diff base snapshot failed: ${message}`);
          })
          .finally(() => { this.pendingBaseSnapshots.delete(sessionId); });
        this.pendingBaseSnapshots.set(sessionId, snapshot);
      }

      const launch = launchSelection(executionConfig);
      const startRawSeq = queries.getMaxSessionRawSeq(sessionId) + 1;
      const startLogRowid = queries.getMaxSessionLogRowid(sessionId);

      // Check if session was stopped/superseded during async setup
      if (this.activeRunTokens.get(sessionId) !== runToken) {
        if (hasResources) resourceManager.releaseRun(runToken);
        hasResources = false;
        return;
      }

      const result = await claudeManager.startClaude(
        workDir, '', launch, undefined, 'interactive', resolvedCliTool,
        undefined, project.path, (project.sandbox_mode as SandboxMode) || 'strict', resume,
        opts?.cols ?? 100, opts?.rows ?? 30,
        launch.effort,
      );
      const pid = result.pid;
      const exitPromise = result.exitPromise;

      if (this.activeRunTokens.get(sessionId) !== runToken) {
        // Run superseded while spawning
        try { await claudeManager.stopClaude(pid); } catch { /* ignore */ }
        if (hasResources) resourceManager.releaseRun(runToken);
        hasResources = false;
        return;
      }

      this.subscribeRawForSession(sessionId, pid, runToken);

      // Atomic drain: persist process_pid, remove the buffer, replay queued
      // bytes — all in a single synchronous block. JS being single-threaded
      // guarantees no WS message can sneak between the DB update and the
      // map.delete, so a message arriving on the next event-loop tick will
      // see process_pid set and no buffer, and write straight to the PTY in
      // correct order after the replayed bytes.
      // base_commit intentionally absent: the pre-spawn snapshot's completion
      // handler owns that column — writing the (possibly stale-null) value here
      // could overwrite a snapshot that already landed.
      queries.updateSession(sessionId, { process_pid: pid, branch_name: branchName, worktree_path: worktreePath });
      this.livePids.set(sessionId, pid);
      const queued = this.runStartupBuffers.get(runToken);
      this.runStartupBuffers.delete(runToken);
      if (queued && queued.length > 0) {
        for (const input of queued) {
          try { claudeManager.writeStdinRaw(pid, input); } catch { /* ignore */ }
        }
      }

      const logMsg = useWorktree
        ? `Started ${adapter.displayName} (PID: ${pid}) on branch ${branchName} [interactive]`
        : `Started ${adapter.displayName} (PID: ${pid}) [interactive]`;
      queries.createSessionLog(sessionId, 'output', logMsg);
      if (resume) {
        queries.createSessionLog(
          sessionId,
          'output',
          `Resumed Claude session via --continue (cwd: ${workDir}) — picks latest conversation in this directory`,
        );
      }
      broadcaster.broadcast({ type: 'session:status-changed', sessionId, status: 'running', worktree_path: worktreePath, branch_name: branchName });
      broadcastProjectStatus(session.project_id);

      // Handle process exit
      exitPromise.then((exitCode) => {
        // Flush and clean up resources owned by this runToken only
        this.flushAndForgetRaw(runToken);
        this.runInitialPrompts.delete(runToken);
        this.runStartupBuffers.delete(runToken);
        if (this.livePids.get(sessionId) === pid) this.livePids.delete(sessionId);
        if (hasResources) resourceManager.releaseRun(runToken);
        hasResources = false;

        // Guard: if run was superseded by a newer run or stopped, do not mutate newer execution state
        if (this.activeRunTokens.get(sessionId) !== runToken) {
          return;
        }

        const current = queries.getSessionById(sessionId);
        // pid guard: a session stopped-then-restarted during the kill window has
        // a new process_pid — the old process's exit must not clobber it.
        if (current && current.status === 'running' && current.process_pid === pid) {
          this.activeRunTokens.delete(sessionId);

          if (exitCode === 0) {
            if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
              providerQuotaService.markAvailable(resolvedCliTool, { source: 'execution_success' });
            }
          } else {
            const logsText = queries.getRecentSessionLogText(sessionId, startLogRowid, 32 * 1024);
            const recentPtyText = queries.getRecentSessionRawText(sessionId, 64 * 1024, startRawSeq);
            const combinedOutput = [logsText, recentPtyText].filter(Boolean).join('\n');
            const classification = classifyProviderFailure(resolvedCliTool, exitCode, combinedOutput);
            if (classification.category === 'quota_exhausted' || classification.category === 'rate_limited') {
              if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
                providerQuotaService.markExhausted(resolvedCliTool, {
                  source: 'runtime_rejection',
                  reason: classification.reason,
                  resetAt: classification.resetAt,
                });
              }
            }
          }

          const status = exitCode === 0 ? 'completed' : 'failed';
          const msg = exitCode === 0
            ? `${adapter!.displayName} session completed.`
            : `${adapter!.displayName} exited with code ${exitCode}.`;
          logger[exitCode === 0 ? 'info' : 'error'](
            exitCode === 0 ? 'session.completed' : 'session.failed',
            {
              scope: tag('session', session.title),
              msg: exitCode === 0 ? 'session completed' : `session failed with exit code ${exitCode}`,
              sessionId,
              projectId: session.project_id,
              exitCode,
            },
          );
          try {
            queries.updateSessionStatus(sessionId, status);
            queries.createSessionLog(sessionId, exitCode === 0 ? 'output' : 'error', msg);
            queries.updateSession(sessionId, { process_pid: 0 });
          } catch {
            try { queries.updateSessionStatus(sessionId, status); } catch { /* ignore */ }
          }
          broadcaster.broadcast({ type: 'session:log', sessionId, message: msg, logType: exitCode === 0 ? 'output' : 'error' });
          broadcaster.broadcast({ type: 'session:status-changed', sessionId, status });
          broadcastProjectStatus(session.project_id);
          orchestrator.wakeWaitingExecutors().catch(() => {});
        }
      }).catch((err) => {
        // The completion handler itself threw: the session is force-failed below
        // and the original exception would otherwise be lost entirely.
        logger.error('session.handler-failed', {
          scope: tag('session', session.title),
          msg: 'session completion handler failed - forcing the session to failed',
          sessionId,
          projectId: session.project_id,
          err,
        });
        this.flushAndForgetRaw(runToken);
        this.runInitialPrompts.delete(runToken);
        this.runStartupBuffers.delete(runToken);
        if (this.livePids.get(sessionId) === pid) this.livePids.delete(sessionId);
        if (hasResources) resourceManager.releaseRun(runToken);
        hasResources = false;
        if (this.activeRunTokens.get(sessionId) === runToken) {
          this.activeRunTokens.delete(sessionId);
          try {
            queries.updateSessionStatus(sessionId, 'failed');
            queries.updateSession(sessionId, { process_pid: 0 });
          } catch { /* ignore */ }
          broadcaster.broadcast({ type: 'session:status-changed', sessionId, status: 'failed' });
          broadcastProjectStatus(session.project_id);
          orchestrator.wakeWaitingExecutors().catch(() => {});
        }
      });
    } catch (err) {
      if (hasReservation) {
        executorPool.releaseReservation(sessionId);
        hasReservation = false;
      }
      if (hasResources) {
        resourceManager.releaseRun(runToken);
        hasResources = false;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (this.activeRunTokens.get(sessionId) === runToken) {
        this.flushAndForgetRaw(runToken);
        this.activeRunTokens.delete(sessionId);
        this.runInitialPrompts.delete(runToken);
        this.runStartupBuffers.delete(runToken);
        if (isRunningPersisted) {
          queries.updateSessionStatus(sessionId, 'failed');
          queries.updateSession(sessionId, { process_pid: 0, execution_snapshot: null });
          logger.error('session.start-failed', {
            scope: tag('session', session.title),
            msg: `failed to start ${adapter?.displayName || 'session'}`,
            sessionId,
            projectId: session.project_id,
            message: clampLine(message),
          });
          queries.createSessionLog(sessionId, 'error', `Failed to start ${adapter?.displayName || 'session'}: ${message}`);
          if (useWorktree && worktreePath && !session.worktree_path) {
            try { await worktreeManager.removeWorktree(project.path, worktreePath); } catch { /* ignore */ }
          }
          broadcaster.broadcast({ type: 'session:status-changed', sessionId, status: 'failed' });
          broadcastProjectStatus(session.project_id);
          orchestrator.wakeWaitingExecutors().catch(() => {});
        }
      }
      throw err;
    } finally {
      if (hasReservation) {
        executorPool.releaseReservation(sessionId);
      }
    }
  }

  /**
   * Stop a running session.
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = queries.getSessionById(sessionId);
    if (!session) throw new Error('Session not found');
    const pid = session.process_pid;

    this.stoppingSessionIds.add(sessionId);
    try {
      const runToken = this.activeRunTokens.get(sessionId);
      if (runToken !== undefined) {
        this.flushAndForgetRaw(runToken);
        this.activeRunTokens.delete(sessionId);
        this.runInitialPrompts.delete(runToken);
        this.runStartupBuffers.delete(runToken);
      }

      this.livePids.delete(sessionId);
      if (pid) {
        await claudeManager.stopClaude(pid);
      }
      if (runToken !== undefined) resourceManager.releaseRun(runToken);
      else resourceManager.releaseOwner('session', sessionId);
      queries.updateSessionStatus(sessionId, 'stopped');
      queries.updateSession(sessionId, { process_pid: 0 });
      queries.createSessionLog(sessionId, 'output', 'Session stopped by user.');
      broadcaster.broadcast({ type: 'session:status-changed', sessionId, status: 'stopped' });
      broadcastProjectStatus(session.project_id);
      orchestrator.wakeWaitingExecutors().catch(() => {});
    } finally {
      this.stoppingSessionIds.delete(sessionId);
    }
  }

  /**
   * Route a `session:terminal-input` WS payload to the right destination.
   * If the session is mid-spawn (`startupInputBuffer` has an entry) the
   * bytes are queued for the drain block at the end of `startSession`,
   * preserving the user's type-ahead in order. Otherwise the bytes are
   * written straight to the PTY — but only if the session is actually
   * running with a live process_pid, so a stray write to a dead session
   * is silently dropped.
   *
   * Note: the WS handler still gates on `hasPendingPrompt` before calling
   * this, so type-ahead never leaks past the Send/Skip pre-flight.
   */
  writeTerminalInput(sessionId: string, input: string): void {
    if (this.hasPendingPrompt(sessionId)) return;
    const runToken = this.activeRunTokens.get(sessionId);
    if (runToken !== undefined) {
      const buf = this.runStartupBuffers.get(runToken);
      if (buf) {
        buf.push(input);
        return;
      }
    }
    // Hot path: avoid a synchronous DB read per keystroke.
    const pid = this.livePids.get(sessionId);
    if (pid) {
      try { claudeManager.writeStdinRaw(pid, input); } catch { /* ignore */ }
      return;
    }
    const session = queries.getSessionById(sessionId);
    if (!session || session.status !== 'running' || !session.process_pid) return;
    try { claudeManager.writeStdinRaw(session.process_pid, input); } catch { /* ignore */ }
  }

  /**
   * Submit the held initial prompt to the running PTY. The payload is
   * terminated with `\n` so claudeManager's ptyWritable converts it to the
   * adapter's submit sequence (\r for Claude/Codex, \r\n for Antigravity).
   * Returns false if there's no pending prompt or the PTY is gone.
   */
  submitInitialPrompt(sessionId: string): boolean {
    const runToken = this.activeRunTokens.get(sessionId);
    if (runToken === undefined) return false;
    const prompt = this.runInitialPrompts.get(runToken);
    if (!prompt) return false;

    const session = queries.getSessionById(sessionId);
    if (!session?.process_pid) return false;

    const payload = prompt.endsWith('\n') ? prompt : `${prompt}\n`;
    const ok = claudeManager.writeToStdin(session.process_pid, payload);
    if (ok) {
      this.runInitialPrompts.delete(runToken);
      queries.createSessionLog(
        sessionId,
        'output',
        `[memory] initial prompt submitted (${prompt.length} chars)`,
      );
    }
    return ok;
  }

  /** Discard the held initial prompt without sending anything to the PTY. */
  skipInitialPrompt(sessionId: string): void {
    const runToken = this.activeRunTokens.get(sessionId);
    if (runToken !== undefined && this.runInitialPrompts.has(runToken)) {
      this.runInitialPrompts.delete(runToken);
      queries.createSessionLog(sessionId, 'output', '[memory] initial prompt skipped by user');
    }
  }

  /** Full body of the held initial prompt, or null if none. */
  getPendingPrompt(sessionId: string): string | null {
    const runToken = this.activeRunTokens.get(sessionId);
    if (runToken === undefined) return null;
    return this.runInitialPrompts.get(runToken) ?? null;
  }

  hasPendingPrompt(sessionId: string): boolean {
    const runToken = this.activeRunTokens.get(sessionId);
    if (runToken === undefined) return false;
    return this.runInitialPrompts.has(runToken);
  }

  /**
   * Classify a filtered PTY output line into a log type.
   * Heuristic: ● prefix = assistant response, [Tool: ...] = tool call, else = output.
   */
  private classifyPtyLine(line: string): { logType: string; message: string } {
    // Claude TUI response lines start with ● (bullet)
    if (/^●\s/.test(line)) {
      return { logType: 'assistant', message: line.replace(/^●\s*/, '') };
    }
    // Tool call lines: [Tool: Read], ⏺ Read(file_path: ...), etc.
    if (/^\[Tool:\s*\w+\]/.test(line)) {
      const match = line.match(/^\[Tool:\s*(\w+)\]\s*(.*)/);
      if (match) {
        return { logType: 'tool_use', message: JSON.stringify({ tool: match[1], summary: match[2].trim() }) };
      }
    }
    // Tool call variant: ⏺ ToolName (shown in some TUI versions)
    if (/^⏺\s+\w+/.test(line)) {
      const match = line.match(/^⏺\s+(\w+)\s*(.*)/);
      if (match) {
        return { logType: 'tool_use', message: JSON.stringify({ tool: match[1], summary: match[2].trim() }) };
      }
    }
    return { logType: 'output', message: line };
  }

  /**
   * Stream PTY output to session logs with heuristic classification.
   * Accumulates consecutive assistant lines into a single log entry.
   */
  private streamToSessionLogs(sessionId: string, stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): void {
    stdout.setEncoding('utf8' as BufferEncoding);
    stderr.setEncoding('utf8' as BufferEncoding);

    // Accumulator for consecutive assistant lines (merged into one block)
    let assistantBuffer: string[] = [];
    let assistantFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushAssistant = () => {
      if (assistantBuffer.length === 0) return;
      const text = assistantBuffer.join('\n');
      assistantBuffer = [];
      try {
        queries.createSessionLog(sessionId, 'assistant', text);
        broadcaster.broadcast({ type: 'session:log', sessionId, message: text, logType: 'assistant' });
      } catch { /* session may have been deleted */ }
    };

    const processStdoutLine = (line: string) => {
      const { logType, message } = this.classifyPtyLine(line);

      if (logType === 'assistant') {
        // Accumulate assistant lines; flush after 300ms gap or on non-assistant line
        assistantBuffer.push(message);
        if (assistantFlushTimer) clearTimeout(assistantFlushTimer);
        assistantFlushTimer = setTimeout(flushAssistant, 300);
        return;
      }

      // Non-assistant line: flush any buffered assistant text first
      if (assistantBuffer.length > 0) {
        if (assistantFlushTimer) { clearTimeout(assistantFlushTimer); assistantFlushTimer = null; }
        flushAssistant();
      }

      try {
        queries.createSessionLog(sessionId, logType, message);
        broadcaster.broadcast({ type: 'session:log', sessionId, message, logType });
      } catch { /* session may have been deleted */ }
    };

    let stdoutBuffer = '';
    stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        processStdoutLine(line.trim());
      }
    });
    stdout.on('end', () => {
      if (stdoutBuffer.trim()) {
        processStdoutLine(stdoutBuffer.trim());
      }
      // Flush remaining assistant buffer
      if (assistantFlushTimer) { clearTimeout(assistantFlushTimer); assistantFlushTimer = null; }
      flushAssistant();
    });

    let stderrBuffer = '';
    stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          queries.createSessionLog(sessionId, 'error', line.trim());
          broadcaster.broadcast({ type: 'session:log', sessionId, message: line.trim(), logType: 'error' });
        } catch { /* ignore */ }
      }
    });
    stderr.on('end', () => {
      if (stderrBuffer.trim()) {
        try {
          queries.createSessionLog(sessionId, 'error', stderrBuffer.trim());
          broadcaster.broadcast({ type: 'session:log', sessionId, message: stderrBuffer.trim(), logType: 'error' });
        } catch { /* ignore */ }
      }
    });
  }
}

export const sessionManager = new SessionManager();
