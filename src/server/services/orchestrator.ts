import fs from 'fs';
import path from 'path';
import { worktreeManager } from './worktree-manager.js';
import { claudeManager, type ClaudeMode } from './claude-manager.js';
import { getAdapter, type CliTool, type SandboxMode } from './cli-adapters.js';
import { isAgentCliTool } from './provider-types.js';
import { executionSnapshot, resolveExecutionConfig } from './execution-config.js';
import { logStreamer } from './log-streamer.js';
import { getTodoImagePaths } from '../routes/images.js';
import { applyMemoryInjection } from './memory-inject-hook.js';
import { parseMemoryNodeIds, parseRawFilePaths, type MemoryInjectMode } from './memory-injector.js';
import { broadcaster } from '../websocket/broadcaster.js';
import { validatePromptContent } from './prompt-guard.js';
import { debugLogger, type DebugSession } from './debug-logger.js';
import { captureReviewMetadata } from './review-capture.js';
import { broadcastProjectStatus as broadcastProjectStatusShared } from './project-status.js';
import { maybeCreateReviewTodo } from './auto-delegate.js';
import { executorPool } from './executor-pool.js';
import { providerQuotaService } from './provider-quota.js';
import { classifyProviderFailure } from './failure-classifier.js';
import type { ResolvedExecutionConfig } from './execution-config.js';
import { v4 as uuidv4 } from 'uuid';
import { parseStoredResourceRequirements } from './resource-catalog.js';
import { resourceManager } from './resource-manager.js';
import { reviewPipeline } from './review-pipeline.js';
import { logger } from '../logging/logger.js';
import { runWithLogContext, tag } from '../logging/context.js';
import { clampLine, tailOf } from '../logging/truncate.js';
import * as queries from '../db/queries.js';
import { assertTestRuntimePathAllowed } from '../utils/test-fs-guard.js';


/**
 * Generates directory-scoped permission settings for Claude CLI in strict sandbox mode.
 */
export function configureClaudeSandboxPermissions(workDir: string): void {
  const claudeDir = path.join(workDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  assertTestRuntimePathAllowed(claudeDir);
  assertTestRuntimePathAllowed(settingsPath);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  const existingSettings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    : {};
  const normalizedWorkDir = workDir.replace(/\\/g, '/');
  existingSettings.permissions = {
    allow: [
      `Read(${normalizedWorkDir}/**)`, `Edit(${normalizedWorkDir}/**)`, `Write(${normalizedWorkDir}/**)`,
      'Bash(*)', 'Glob(*)', 'Grep(*)',
      'TodoRead', 'TodoWrite', 'WebFetch(*)',
    ],
    deny: [],
  };
  fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));
}

const MAX_CONTEXT_SWITCHES = 3;

const STALE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

export class Orchestrator {

  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private activeResourceRuns = new Map<string, string>();
  private isStoppingProjects = new Set<string>();
  private stoppingTodoIds = new Set<string>();
  private activeStartTokens = new Map<string, string>();
  private startGenerations = new Map<string, number>();
  private activeStartPromises = new Map<string, Promise<void>>();

  /**
   * Start periodic process liveness check.
   * Detects tasks stuck in 'running' state whose process has already exited.
   */
  startStaleProcessChecker(): void {
    if (this.staleCheckTimer) return;
    this.staleCheckTimer = setInterval(() => this.recoverStaleTasks(), STALE_CHECK_INTERVAL_MS);
  }

  stopStaleProcessChecker(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  /**
   * Check whether a todo is currently in a stopping lifecycle.
   */
  isStopping(todoId: string): boolean {
    return this.stoppingTodoIds.has(todoId);
  }

  /**
   * Check whether a project is currently in a stopping lifecycle.
   */
  isStoppingProject(projectId: string): boolean {
    return this.isStoppingProjects.has(projectId);
  }

  /**
   * Find tasks marked 'running' whose process is no longer alive, and mark them as failed.
   */
  public recoverStaleTasks(): void {
    const runningTodos = queries.getTodosByStatus('running');
    let recoveredCount = 0;
    for (const todo of runningTodos) {
      if (this.stoppingTodoIds.has(todo.id)) continue;
      if (this.isStoppingProjects.has(todo.project_id)) continue;
      if (!todo.process_pid || todo.process_pid === 0) continue;
      if (!this.isProcessAlive(todo.process_pid)) {
        try {
          if (todo.review_enabled) {
            const activeRound = queries.getActiveExecutionRound(todo.id);
            if (activeRound) {
              queries.updateExecutionRound(activeRound.id, {
                status: 'failed',
                error_message: 'Process exited unexpectedly (detected by liveness check).',
                finished_at: new Date().toISOString(),
              });
              const updated = queries.getExecutionRoundById(activeRound.id);
              if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId: todo.id, round: updated });
            }
          }
          logger.error('todo.process.vanished', {
            scope: tag('todo', todo.title),
            msg: 'process exited unexpectedly (detected by liveness check)',
            todoId: todo.id,
            projectId: todo.project_id,
            pid: todo.process_pid,
          });
          queries.updateTodoStatus(todo.id, 'failed');
          queries.createTaskLog(todo.id, 'error', 'Process exited unexpectedly (detected by liveness check).');
          queries.updateTodo(todo.id, { process_pid: 0, execution_snapshot: null });
          const runToken = this.activeResourceRuns.get(todo.id);
          if (runToken) {
            resourceManager.releaseRun(runToken);
            this.activeResourceRuns.delete(todo.id);
          } else {
            resourceManager.releaseOwner('todo', todo.id);
          }
        } catch { /* ignore */ }
        broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'failed' });
        this.broadcastProjectStatus(todo.project_id);
        recoveredCount++;
      }
    }
    if (recoveredCount > 0) {
      this.wakeWaitingExecutors().catch(() => { /* ignore */ });
      this.wakeWaitingResources().catch(() => { /* ignore */ });
    }
  }

  public isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the max concurrent setting for a project.
   */
  private getMaxConcurrent(projectId: string): number {
    const project = queries.getProjectById(projectId);
    if (!project) return 3;
    if (project.is_git_repo && !project.use_worktree) return 1;
    // SVN projects share a single working copy in phase 1 — serialize.
    if (project.vcs_type === 'svn') return 1;
    return project.max_concurrent ?? 3;
  }

  /**
   * Resolve effective worktree mode for a todo:
   * - todo.use_worktree === 1 → force worktree (if git repo)
   * - todo.use_worktree === 0 → force main branch
   * - otherwise → inherit from project.use_worktree
   */
  private resolveUseWorktree(project: queries.Project, todo: queries.Todo): boolean {
    if (!project.is_git_repo) return false;
    if (todo.use_worktree === 0) return false;
    if (todo.use_worktree === 1) return true;
    return !!project.use_worktree;
  }

  /**
   * Check if a todo can start right now given currently-running todos.
   * A main-branch todo (effective useWorktree=false) requires exclusive
   * execution — no other todos may be running. Conversely, if any running
   * todo is on main branch, nothing new can start until it completes.
   */
  private canStartNow(
    project: queries.Project,
    todo: queries.Todo,
    runningTodos: queries.Todo[],
  ): { ok: boolean; reason?: string } {
    const othersRunning = runningTodos.filter((t) => t.id !== todo.id);
    if (othersRunning.length === 0) return { ok: true };
    const thisUsesWorktree = this.resolveUseWorktree(project, todo);
    if (!thisUsesWorktree) {
      return { ok: false, reason: 'This todo runs on main branch and requires exclusive execution; other todos are currently running.' };
    }
    const anyRunningOnMain = othersRunning.some((t) => !this.resolveUseWorktree(project, t));
    if (anyRunningOnMain) {
      return { ok: false, reason: 'Another todo is running exclusively on main branch; waiting for it to complete.' };
    }
    return { ok: true };
  }

  /**
   * Broadcast the current project status summary via WebSocket.
   * Counts todos + sessions + discussions so the sidebar dot pulses
   * for any background activity, not only running todos.
   */
  private broadcastProjectStatus(projectId: string): void {
    broadcastProjectStatusShared(projectId);
  }

  /**
   * Start all pending todos for a project.
   * Respects maxConcurrent limit. When a Claude process exits,
   * the next queued todo is started automatically.
   */
  async startProject(projectId: string): Promise<void> {
    const project = queries.getProjectById(projectId);
    if (!project) {
      throw new Error('Project not found');
    }

    const todos = queries.getTodosByProjectId(projectId);
    const pending = todos.filter((t) => t.status === 'pending' || t.status === 'waiting_executor' || t.status === 'waiting_quota' || t.status === 'waiting_resource');
    const running = todos.filter((t) => t.status === 'running');
    const maxConcurrent = this.getMaxConcurrent(projectId);

    // Prevent starting if there are already running todos
    if (running.length >= maxConcurrent) {
      throw new Error(`Project already has ${running.length} running tasks (max ${maxConcurrent})`);
    }

    // Filter out tasks whose dependency hasn't completed yet
    const startable = pending.filter((t) => this.isDependencySatisfied(t, todos));

    const slotsAvailable = Math.max(0, maxConcurrent - running.length);
    const todosToStart = startable.slice(0, slotsAvailable);

    for (const todo of todosToStart) {
      await this.startSingleTodo(todo.id, project.path, projectId, 'headless', true);
    }
  }

  private admissionWakeRunning = false;
  private admissionWakeRequested = false;
  private resourceWakeRunning = false;
  private resourceWakeRequested = false;

  /**
   * Stop all running and waiting todos for a project.
   * Keeps worktrees so users can inspect results.
   */
  async stopProject(projectId: string): Promise<void> {
    this.isStoppingProjects.add(projectId);
    const todos = queries.getTodosByProjectId(projectId);
    const running = todos.filter((t) => t.status === 'running');
    const waiting = todos.filter((t) => t.status === 'waiting_executor' || t.status === 'waiting_quota' || t.status === 'waiting_resource');
    todos.forEach((t) => {
      this.activeStartTokens.delete(t.id);
      this.startGenerations.set(t.id, (this.startGenerations.get(t.id) ?? 0) + 1);
      executorPool.releaseReservation(t.id);
    });
    running.forEach((t) => this.stoppingTodoIds.add(t.id));
    waiting.forEach((t) => this.stoppingTodoIds.add(t.id));

    try {
      for (const todo of running) {
        if (todo.process_pid) {
          await claudeManager.stopClaude(todo.process_pid).catch(() => { /* ignore */ });
        }
        if (todo.review_enabled) {
          const activeRound = queries.getActiveExecutionRound(todo.id);
          if (activeRound) {
            queries.updateExecutionRound(activeRound.id, {
              status: 'stopped',
              finished_at: new Date().toISOString(),
            });
            const updatedRound = queries.getExecutionRoundById(activeRound.id);
            if (updatedRound) broadcaster.broadcast({ type: 'todo:round-updated', todoId: todo.id, round: updatedRound });
          }
        }
        const runToken = this.activeResourceRuns.get(todo.id);
        if (runToken) resourceManager.releaseRun(runToken);
        else resourceManager.releaseOwner('todo', todo.id);
        this.activeResourceRuns.delete(todo.id);
        queries.updateTodoStatus(todo.id, 'stopped');
        queries.updateTodo(todo.id, { process_pid: 0, execution_mode: null });
        queries.createTaskLog(todo.id, 'output', 'Task stopped by user (Stop All).');
        broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'stopped' });
      }

      for (const todo of waiting) {
        if (todo.review_enabled) {
          const activeRound = queries.getActiveExecutionRound(todo.id);
          if (activeRound) {
            queries.updateExecutionRound(activeRound.id, {
              status: 'stopped',
              finished_at: new Date().toISOString(),
            });
            const updatedRound = queries.getExecutionRoundById(activeRound.id);
            if (updatedRound) broadcaster.broadcast({ type: 'todo:round-updated', todoId: todo.id, round: updatedRound });
          }
        }
        queries.updateTodoStatus(todo.id, 'stopped');
        queries.updateTodo(todo.id, { process_pid: 0, execution_mode: null });
        queries.createTaskLog(todo.id, 'output', 'Task stopped by user (Stop All).');
        broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'stopped' });
      }

      this.broadcastProjectStatus(projectId);
    } finally {
      running.forEach((t) => this.stoppingTodoIds.delete(t.id));
      waiting.forEach((t) => this.stoppingTodoIds.delete(t.id));
      this.isStoppingProjects.delete(projectId);
    }
  }

  /**
   * Start a single todo by ID. If the todo has unsatisfied dependencies,
   * automatically starts the topmost ancestor first and auto-chains down.
   */
  async startTodo(todoId: string, mode: ClaudeMode = 'headless'): Promise<void> {
    const todo = queries.getTodoById(todoId);
    if (!todo) {
      throw new Error('Todo not found');
    }

    // Prevent starting an already running todo
    if (todo.status === 'running') {
      throw new Error('Todo is already running');
    }

    if (this.isStoppingProjects.has(todo.project_id) || this.stoppingTodoIds.has(todoId)) {
      throw new Error('Cannot start task while stopping.');
    }

    if (todo.review_enabled) {
      const activeRound = queries.getActiveExecutionRound(todoId);
      if (!activeRound) {
        const latestRound = queries.getLatestExecutionRound(todoId);
        if (latestRound && (latestRound.status === 'failed' || latestRound.status === 'stopped' || latestRound.status === 'completed')) {
          throw new Error('Reviewed pipeline has a terminal execution round. Use Retry Phase instead of Start.');
        }
      }
    }

    const project = queries.getProjectById(todo.project_id);
    if (!project) {
      throw new Error('Project not found');
    }

    // Check dependency chain
    const chain = this.getUnsatisfiedAncestorChain(todoId);

    if (chain.length === 0) {
      // No unsatisfied dependencies — start directly with autoChain
      await this.startSingleTodo(todoId, project.path, project.id, mode, true);
      return;
    }

    const root = chain[0];

    if (root.status === 'running') {
      // Root ancestor is already running — auto-chain will cascade on completion
      queries.createTaskLog(todoId, 'output', `Waiting for parent task "${root.title}" to complete before starting.`);
      return;
    }

    // Root ancestor needs starting (pending/failed/stopped)
    queries.createTaskLog(todoId, 'output', `Starting parent task "${root.title}" first (dependency chain). Will auto-start when ready.`);
    await this.startSingleTodo(root.id, project.path, project.id, mode, true);
  }

  /**
   * Continue a completed todo in the same worktree with a follow-up prompt.
   * Runs a new "round" — no new worktree, no squash merge. For Claude CLI,
   * uses --continue to resume the prior session.
   */
  async continueTodo(todoId: string, followUpPrompt: string, mode: ClaudeMode = 'headless'): Promise<void> {
    const todo = queries.getTodoById(todoId);
    if (!todo) {
      throw new Error('Todo not found');
    }
    if (todo.review_enabled) {
      throw new Error('Continue is not supported for reviewed pipeline tasks in Review/Rework V1. Create a new Todo or use an explicit review/rework action.');
    }
    if (todo.status !== 'completed') {
      throw new Error('Only completed todos can be continued');
    }
    if (todo.process_pid && todo.process_pid > 0) {
      throw new Error('Todo has an active process');
    }

    const project = queries.getProjectById(todo.project_id);
    if (!project) {
      throw new Error('Project not found');
    }

    const useWorktree = this.resolveUseWorktree(project, todo);
    if (useWorktree) {
      if (!todo.worktree_path || !todo.branch_name) {
        throw new Error('No worktree available to continue. Use Retry to start fresh.');
      }
      if (!(await worktreeManager.isValidWorktree(todo.worktree_path))) {
        throw new Error('Worktree no longer exists. Use Retry to start fresh.');
      }
    }

    const trimmed = followUpPrompt.trim();
    if (!trimmed) {
      throw new Error('Follow-up prompt is required');
    }

    const nextRound = (todo.round_count ?? 1) + 1;
    queries.updateTodo(todoId, { round_count: nextRound });

    await this.startSingleTodo(todoId, project.path, project.id, mode, false, {
      followUpPrompt: trimmed,
      roundNumber: nextRound,
    });
  }

  /**
   * Stop a single todo by ID.
   */
  async stopTodo(todoId: string): Promise<void> {
    const todo = queries.getTodoById(todoId);
    if (!todo) {
      throw new Error('Todo not found');
    }

    this.stoppingTodoIds.add(todoId);
    this.activeStartTokens.delete(todoId);
    this.startGenerations.set(todoId, (this.startGenerations.get(todoId) ?? 0) + 1);
    executorPool.releaseReservation(todoId);
    try {
      if (todo.process_pid) {
        await claudeManager.stopClaude(todo.process_pid);
      }

      if (todo.review_enabled) {
        const activeRound = queries.getActiveExecutionRound(todoId);
        if (activeRound) {
          queries.updateExecutionRound(activeRound.id, {
            status: 'stopped',
            finished_at: new Date().toISOString(),
          });
          const updatedRound = queries.getExecutionRoundById(activeRound.id);
          if (updatedRound) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updatedRound });
        }
      }

      const runToken = this.activeResourceRuns.get(todoId);
      if (runToken) resourceManager.releaseRun(runToken);
      else resourceManager.releaseOwner('todo', todoId);
      this.activeResourceRuns.delete(todoId);

      queries.updateTodoStatus(todoId, 'stopped');
      queries.updateTodo(todoId, { process_pid: 0, execution_mode: null });
      queries.createTaskLog(todoId, 'output', 'Task stopped by user.');

      broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'stopped' });
      this.broadcastProjectStatus(todo.project_id);
      if (!this.isStoppingProjects.has(todo.project_id)) {
        this.wakeWaitingExecutors().catch(() => { /* ignore */ });
      }
    } finally {
      this.stoppingTodoIds.delete(todoId);
    }
  }

  /**
   * Internal: start a single todo with all the setup.
   * When continueOptions is provided, reuses the existing worktree and runs a
   * follow-up prompt (no new worktree, no squash merge, CLI session continued).
   */
  private isStartupValid(todoId: string, startToken: string, projectId: string): boolean {
    if (this.isStoppingProjects.has(projectId)) return false;
    if (this.stoppingTodoIds.has(todoId)) return false;
    if (this.activeStartTokens.get(todoId) !== startToken) return false;
    const currentTodo = queries.getTodoById(todoId);
    if (!currentTodo) return false;
    if (currentTodo.status === 'stopped') return false;
    return true;
  }

  private failCurrentRoundAndTodo(
    todoId: string,
    projectId: string,
    currentRound: queries.TodoExecutionRound | undefined,
    errorMessage: string,
    roundNumber: number,
    adapterDisplayName?: string,
  ): void {
    executorPool.releaseReservation(todoId);
    const runToken = this.activeResourceRuns.get(todoId);
    if (runToken) {
      resourceManager.releaseRun(runToken);
      this.activeResourceRuns.delete(todoId);
    } else {
      resourceManager.releaseOwner('todo', todoId);
    }

    const currentTodo = queries.getTodoById(todoId);
    if (!currentTodo || currentTodo.status === 'stopped' || this.isStoppingProjects.has(projectId) || this.stoppingTodoIds.has(todoId)) {
      return;
    }

    queries.updateTodoStatus(todoId, 'failed');
    queries.updateTodo(todoId, { process_pid: 0, execution_mode: null });
    if (currentRound) {
      const freshRound = queries.getExecutionRoundById(currentRound.id);
      if (freshRound && freshRound.status !== 'stopped') {
        queries.updateExecutionRound(currentRound.id, {
          status: 'failed',
          error_message: errorMessage,
          finished_at: new Date().toISOString(),
        });
        const updated = queries.getExecutionRoundById(currentRound.id);
        if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
      }
    }
    const logMsg = adapterDisplayName ? `Failed to start ${adapterDisplayName}: ${errorMessage}` : errorMessage;
    logger.error('todo.execution.start-failed', {
      msg: adapterDisplayName ? `failed to start ${adapterDisplayName}` : 'execution failed to start',
      todoId,
      projectId,
      round: roundNumber,
      message: clampLine(errorMessage),
    });
    queries.createTaskLog(todoId, 'error', logMsg, roundNumber);
    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
    this.broadcastProjectStatus(projectId);
    this.wakeWaitingExecutors().catch(() => {});
  }

  private async startSingleTodo(
    todoId: string,
    projectPath: string,
    projectId: string,
    mode: ClaudeMode = 'headless',
    autoChain: boolean = false,
    continueOptions?: { followUpPrompt: string; roundNumber: number },
  ): Promise<void> {
    while (true) {
      if (this.isStoppingProjects.has(projectId) || this.stoppingTodoIds.has(todoId)) {
        return;
      }

      const inFlight = this.activeStartPromises.get(todoId);
      const activeToken = this.activeStartTokens.get(todoId);

      if (inFlight) {
        if (activeToken) {
          // In-flight startup is valid and actively owned. Join it.
          return inFlight;
        }
        // In-flight startup is cancelled/stale and only draining cleanup.
        // Wait for it to drain before claiming a fresh startup token.
        try {
          await inFlight;
        } catch { /* ignore */ }
        continue;
      }

      const startToken = uuidv4();
      this.activeStartTokens.set(todoId, startToken);
      const generation = (this.startGenerations.get(todoId) ?? 0) + 1;
      this.startGenerations.set(todoId, generation);

      let startPromise: Promise<void> | null = null;
      startPromise = (async () => {
        try {
          await this.executeStartSingleTodo(todoId, projectPath, projectId, mode, autoChain, continueOptions, startToken);
        } finally {
          if (this.activeStartTokens.get(todoId) === startToken) {
            this.activeStartTokens.delete(todoId);
          }
          if (this.activeStartPromises.get(todoId) === startPromise) {
            this.activeStartPromises.delete(todoId);
          }
        }
      })();

      this.activeStartPromises.set(todoId, startPromise);
      return startPromise;
    }
  }

  private async executeStartSingleTodo(
    todoId: string,
    projectPath: string,
    projectId: string,
    mode: ClaudeMode = 'headless',
    autoChain: boolean = false,
    continueOptions?: { followUpPrompt: string; roundNumber: number },
    startToken?: string,
  ): Promise<void> {
    const contextTodo = queries.getTodoById(todoId);
    // Everything logged underneath — CLI spawn, quota, resources — carries this
    // task's tag, so the terminal reads as one story per task.
    return runWithLogContext(
      { scope: tag('todo', contextTodo?.title ?? todoId), fields: { todoId, projectId } },
      () => this.executeStartSingleTodoInner(todoId, projectPath, projectId, mode, autoChain, continueOptions, startToken),
    );
  }

  private async executeStartSingleTodoInner(
    todoId: string,
    projectPath: string,
    projectId: string,
    mode: ClaudeMode,
    autoChain: boolean,
    continueOptions: { followUpPrompt: string; roundNumber: number } | undefined,
    startToken: string | undefined,
  ): Promise<void> {
    const todo = queries.getTodoById(todoId);
    if (!todo) return;

    const project = queries.getProjectById(projectId);
    if (!project) return;

    if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
      return;
    }

    const isContinue = !!continueOptions;
    const roundNumber = continueOptions?.roundNumber ?? (todo.round_count ?? 1);

    let currentRound: queries.TodoExecutionRound | undefined = undefined;
    if (todo.review_enabled) {
      reviewPipeline.ensureInitialRound(todoId);
      if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
        return;
      }
      currentRound = queries.getActiveExecutionRound(todoId);
      if (!currentRound) {
        const latestRound = queries.getLatestExecutionRound(todoId);
        if (latestRound && (latestRound.status === 'failed' || latestRound.status === 'stopped' || latestRound.status === 'completed')) {
          throw new Error('Reviewed pipeline has a terminal execution round. Use Retry Phase instead of Start.');
        }
      }
    }

    const taskContent = (isContinue
      ? continueOptions!.followUpPrompt
      : (todo.description || todo.title || '')
    ).trim();
    // Skip strict action-keyword validation for continue (user is in a live worktree
    // and follow-ups are often short/conversational); just ensure it's non-empty.
    if (isContinue) {
      if (!taskContent) {
        logger.warn('todo.continue.empty-prompt', {
          msg: 'continue refused: the follow-up prompt is empty',
          todoId,
          projectId,
          round: roundNumber,
        });
        queries.updateTodoStatus(todoId, 'failed');
        queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
        queries.createTaskLog(todoId, 'error', 'Follow-up prompt is empty.', roundNumber);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
        this.broadcastProjectStatus(projectId);
        return;
      }
    }

    // Concurrency gate: a main-branch todo (effective useWorktree=false) requires
    // exclusive execution. Defer silently; on any later completion a scheduler tick
    // will retry pending todos.
    const runningNow = queries.getTodosByProjectId(projectId).filter((t) => t.status === 'running');
    const gate = this.canStartNow(project, todo, runningNow);
    if (!gate.ok) {
      queries.createTaskLog(todoId, 'output', `Deferred: ${gate.reason}`, roundNumber);
      return;
    }

    // Resolve execution configuration / executor candidate BEFORE creating worktree
    let executionConfig: ResolvedExecutionConfig | null = null;
    let resolvedCliTool: CliTool;

    let effectiveProfileId = todo.execution_profile_id;
    if (todo.review_enabled && currentRound) {
      if (currentRound.phase === 'implementation') {
        effectiveProfileId = todo.execution_profile_id;
      } else if (currentRound.phase === 'review') {
        effectiveProfileId = todo.review_profile_id ?? project.default_review_profile_id;
        if (!effectiveProfileId) {
          logger.error('todo.review.profile-missing', {
            msg: 'review phase cannot start: no review profile is configured',
            todoId,
            projectId,
            phase: 'review',
            round: currentRound.round_index,
            detail: 'Set a review profile on the task, or a default review profile on the project.',
          });
          queries.updateTodoStatus(todoId, 'failed');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0, pipeline_phase: 'review' });
          queries.createTaskLog(
            todoId,
            'error',
            'Configuration error: Review profile is not configured (todo.review_profile_id is null and project has no default_review_profile_id).',
            currentRound.round_index
          );
          queries.updateExecutionRound(currentRound.id, {
            status: 'failed',
            error_message: 'Review profile is not configured.',
            finished_at: new Date().toISOString(),
          });
          const updated = queries.getExecutionRoundById(currentRound.id);
          if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
          broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
          this.broadcastProjectStatus(projectId);
          return;
        }
      } else if (currentRound.phase === 'rework') {
        effectiveProfileId = todo.rework_profile_id ?? todo.execution_profile_id;
      }
    }

    if (effectiveProfileId) {
      try {
        const selection = await executorPool.selectExecutor({
          executionProfileId: effectiveProfileId,
          interactive: mode === 'interactive',
          excludeTodoId: todoId,
          reserveOwnerId: todoId,
        });

        if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
          executorPool.releaseReservation(todoId);
          return;
        }

        if (selection.status === 'waiting_executor') {
          queries.updateTodoStatus(todoId, 'waiting_executor');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
          if (currentRound) {
            queries.updateExecutionRound(currentRound.id, { status: 'waiting_executor' });
            const updated = queries.getExecutionRoundById(currentRound.id);
            if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
          }
          logger.warn('todo.admission.waiting-executor', {
            msg: 'waiting_executor: provider concurrency limit reached',
            profile: selection.profileName,
            reason: clampLine(selection.rejectionSummary),
          });
          const message = `[executor-pool] Waiting for executor capacity (profile "${selection.profileName}"):\n\n${selection.rejectionSummary}`;
          const recentLogs = queries.getTaskLogsByTodoId(todoId);
          const lastOutput = [...recentLogs].reverse().find((l) => l.log_type === 'output');
          if (!lastOutput || lastOutput.message !== message) {
            queries.createTaskLog(todoId, 'output', message, roundNumber);
          }
          broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'waiting_executor' });
          this.broadcastProjectStatus(projectId);
          return;
        }

        if (selection.status === 'waiting_quota') {
          executorPool.releaseReservation(todoId);
          queries.updateTodoStatus(todoId, 'waiting_quota');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
          if (currentRound) {
            queries.updateExecutionRound(currentRound.id, { status: 'waiting_quota' });
            const updated = queries.getExecutionRoundById(currentRound.id);
            if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
          }
          logger.warn('todo.admission.waiting-quota', {
            msg: 'waiting_quota: provider quota exhausted',
            profile: selection.profileName,
            reason: clampLine(selection.rejectionSummary),
          });
          const message = `[executor-pool] Waiting for provider quota (profile "${selection.profileName}"):\n\n${selection.rejectionSummary}`;
          const recentLogs = queries.getTaskLogsByTodoId(todoId);
          const lastOutput = [...recentLogs].reverse().find((l) => l.log_type === 'output');
          if (!lastOutput || lastOutput.message !== message) {
            queries.createTaskLog(todoId, 'output', message, roundNumber);
          }
          broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'waiting_quota' });
          this.broadcastProjectStatus(projectId);
          return;
        }

        if (selection.status === 'no_candidates') {
          queries.updateTodoStatus(todoId, 'failed');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
          if (currentRound) {
            queries.updateExecutionRound(currentRound.id, {
              status: 'failed',
              error_message: `Execution profile "${selection.profileName}" has no eligible executors`,
              finished_at: new Date().toISOString(),
            });
            const updated = queries.getExecutionRoundById(currentRound.id);
            if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
          }
          logger.error('todo.admission.no-candidates', {
            msg: `no eligible executors for execution profile "${selection.profileName}"`,
            profile: selection.profileName,
            detail: selection.rejectionSummary,
          });
          queries.createTaskLog(
            todoId,
            'error',
            `Execution profile "${selection.profileName}" has no eligible executors:\n\n${selection.rejectionSummary}`,
            roundNumber,
          );
          broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
          this.broadcastProjectStatus(projectId);
          return;
        }

        executionConfig = selection.selectedConfig!;
        resolvedCliTool = executionConfig.cliTool;
        queries.createTaskLog(
          todoId,
          'output',
          `[executor-pool] Selected executor ${getAdapter(resolvedCliTool).displayName} (model: ${executionConfig.model ?? 'default'}${executionConfig.effort.nativeEffort ? `, effort: ${executionConfig.effort.nativeEffort}` : ''}) from profile "${selection.profileName}"`,
          roundNumber,
        );
      } catch (err) {
        if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
          executorPool.releaseReservation(todoId);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error('todo.selection.failed', {
          msg: 'execution profile selection failed',
          todoId,
          projectId,
          profileId: effectiveProfileId,
          ...(currentRound ? { phase: currentRound.phase, round: currentRound.round_index } : { round: roundNumber }),
          err,
        });
        queries.updateTodoStatus(todoId, 'failed');
        queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
        if (currentRound) {
          queries.updateExecutionRound(currentRound.id, {
            status: 'failed',
            error_message: `Execution selection error: ${message}`,
            finished_at: new Date().toISOString(),
          });
          const updated = queries.getExecutionRoundById(currentRound.id);
          if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
        }
        queries.createTaskLog(todoId, 'error', `Execution selection error: ${message}`, roundNumber);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
        this.broadcastProjectStatus(projectId);
        return;
      }
    } else {
      const cliTool = (todo.cli_tool as CliTool) || (project.cli_tool as CliTool) || 'claude';
      const claudeModel = todo.cli_model ?? undefined;
      try {
        executionConfig = isAgentCliTool(cliTool) || todo.cli_model_id || todo.cli_effort
          ? resolveExecutionConfig({
              cliTool,
              model: claudeModel,
              cliModelId: todo.cli_model_id,
              cliEffort: todo.cli_effort,
              interactive: mode === 'interactive',
            })
          : null;
        resolvedCliTool = executionConfig?.cliTool ?? cliTool;

        // Quota preflight for manual execution (agents only, not raw-shell)
        if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
          const quota = providerQuotaService.getQuotaState(resolvedCliTool);
          if (quota.state === 'exhausted') {
            executorPool.releaseReservation(todoId);
            const adapter = getAdapter(resolvedCliTool);
            const quotaMsg = `${adapter.displayName} waiting for provider quota (${quota.reason || 'provider quota is currently exhausted'}).`;
            logger.warn('todo.admission.waiting-quota', {
              msg: 'waiting_quota: provider quota exhausted',
              provider: resolvedCliTool,
              ...(quota.reason ? { reason: clampLine(quota.reason) } : {}),
            });
            queries.updateTodoStatus(todoId, 'waiting_quota');
            queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
            if (currentRound) {
              queries.updateExecutionRound(currentRound.id, {
                status: 'waiting_quota',
              });
              const updated = queries.getExecutionRoundById(currentRound.id);
              if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
            }
            queries.createTaskLog(todoId, 'output', quotaMsg, roundNumber);
            broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'waiting_quota' });
            this.broadcastProjectStatus(projectId);
            return;
          }
        }

        const reserved = executorPool.reserveSlot(todoId, resolvedCliTool, { excludeTodoId: todoId });
        if (!reserved) {
          queries.updateTodoStatus(todoId, 'waiting_executor');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
          if (currentRound) {
            queries.updateExecutionRound(currentRound.id, { status: 'waiting_executor' });
            const updated = queries.getExecutionRoundById(currentRound.id);
            if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
          }
          const adapter = getAdapter(resolvedCliTool);
          const usage = executorPool.getActiveToolUsage(resolvedCliTool, { excludeTodoId: todoId });
          const limit = executorPool.getLimit(resolvedCliTool);
          logger.warn('todo.admission.waiting-executor', {
            msg: `waiting_executor: provider concurrency limit reached (${usage}/${limit} active)`,
            provider: resolvedCliTool,
            active: usage,
            limit,
          });
          const message = `[executor-pool] Waiting for executor capacity (manual ${adapter.displayName}): provider concurrency limit reached (${usage}/${limit} active)`;
          const recentLogs = queries.getTaskLogsByTodoId(todoId);
          const lastOutput = [...recentLogs].reverse().find((l) => l.log_type === 'output');
          if (!lastOutput || lastOutput.message !== message) {
            queries.createTaskLog(todoId, 'output', message, roundNumber);
          }
          broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'waiting_executor' });
          this.broadcastProjectStatus(projectId);
          return;
        }
      } catch (err) {
        if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
          executorPool.releaseReservation(todoId);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.failCurrentRoundAndTodo(todoId, projectId, currentRound, `Configuration error: ${message}`, roundNumber);
        return;
      }
    }

    let adapter: ReturnType<typeof getAdapter>;
    let resourceRunToken: string | null = null;
    let pid: number;
    let exitPromise: Promise<number>;
    let debugSession: DebugSession | null = null;
    let executionStartRowid = 0;
    let streamDrainPromise: Promise<void> | null = null;

    if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
      executorPool.releaseReservation(todoId);
      return;
    }

    try {
      adapter = getAdapter(resolvedCliTool);
      const requirements = parseStoredResourceRequirements(todo.resource_requirements);
      resourceRunToken = currentRound ? currentRound.run_token : uuidv4();
      const acquisition = resourceManager.acquireAtomic({
        ownerType: 'todo', ownerId: todoId, runToken: resourceRunToken, resources: requirements,
      });
      if (acquisition.status === 'busy') {
        executorPool.releaseReservation(todoId);
        resourceRunToken = null;
        queries.updateTodoStatus(todoId, 'waiting_resource');
        queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
        if (currentRound) {
          queries.updateExecutionRound(currentRound.id, { status: 'waiting_resource' });
          const updated = queries.getExecutionRoundById(currentRound.id);
          if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
        }
        const details = acquisition.busy.map((busy) => {
          const holders = busy.holders.map((holder) => `${holder.ownerType === 'todo' ? 'Todo' : 'Session'} ${holder.ownerId}`).join(', ');
          return `- ${busy.key}: busy, held by ${holders}`;
        }).join('\n');
        logger.warn('todo.admission.waiting-resource', {
          msg: `waiting_resource: ${acquisition.busy.map(b => b.key).join(', ')}`,
          resources: acquisition.busy.map(b => b.key).join(','),
          detail: details,
        });
        const message = `[resource-manager] Waiting for resources:\n${details}`;
        const recentLogs = queries.getTaskLogsByTodoId(todoId);
        const lastOutput = [...recentLogs].reverse().find((log) => log.log_type === 'output');
        if (!lastOutput || lastOutput.message !== message) queries.createTaskLog(todoId, 'output', message, roundNumber);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'waiting_resource' });
        this.broadcastProjectStatus(projectId);
        return;
      }
      if (requirements.length > 0) {
        this.activeResourceRuns.set(todoId, resourceRunToken);
        queries.createTaskLog(todoId, 'output', `[resource-manager] Acquired resources: ${requirements.join(', ')}`, roundNumber);
      }

      // Persist running provider usage, then release the temporary provider reservation.
      queries.updateTodoStatus(todoId, 'running');
      const initialSnapshot = executionConfig
        ? JSON.stringify(executionSnapshot(executionConfig))
        : JSON.stringify({ configuration: 'manual', agent: resolvedCliTool });
      queries.updateTodo(todoId, {
        execution_mode: mode,
        execution_snapshot: initialSnapshot,
      });
      if (currentRound) {
        queries.updateExecutionRound(currentRound.id, {
          status: 'running',
          started_at: new Date().toISOString(),
          execution_snapshot: initialSnapshot,
        });
        const updated = queries.getExecutionRoundById(currentRound.id);
        if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
      }
      executorPool.releaseReservation(todoId);
    } catch (err) {
      if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
        executorPool.releaseReservation(todoId);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.failCurrentRoundAndTodo(todoId, projectId, currentRound, `Resource configuration error: ${message}`, roundNumber);
      return;
    }
    logStreamer.setRound(todoId, roundNumber);

    try {
      const isGitRepo = !!project.is_git_repo;
      const useWorktree = this.resolveUseWorktree(project, todo);
      let worktreePath: string | null = null;
      let branchName: string | null = null;
      let workDir: string;
      let prompt: string;

      if (useWorktree) {
        let inheritedFromBranch: string | null = null;
        let isReused = false;

        // Reuse existing worktree if available (context switch restart OR continue scenario)
        // Validates that the worktree is a real git checkout, not just an empty directory
        if (todo.worktree_path && todo.branch_name && isGitRepo) {
          const isValid = await worktreeManager.isValidWorktree(todo.worktree_path);
          if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
            if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
            else resourceManager.releaseOwner('todo', todoId);
            this.activeResourceRuns.delete(todoId);
            return;
          }
          if (isValid) {
            worktreePath = todo.worktree_path;
            branchName = todo.branch_name;
            queries.createTaskLog(todoId, 'output', `Reusing existing worktree at ${worktreePath} (branch: ${branchName})`, roundNumber);
            isReused = true;
          }
        }

        if (!isReused) {
          // If this task depends on a parent that completed on a branch, branch from that parent's branch
          if (todo.depends_on) {
            const parentTodo = queries.getTodoById(todo.depends_on);
            if (parentTodo && parentTodo.branch_name) {
              inheritedFromBranch = parentTodo.branch_name;
            }
          }

          if (isGitRepo) {
            const requestedBranch = worktreeManager.sanitizeBranchName(todo.title);
            const wt = await worktreeManager.createWorktree(projectPath, requestedBranch, !!project.npm_auto_install);
            if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
              if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
              else resourceManager.releaseOwner('todo', todoId);
              this.activeResourceRuns.delete(todoId);
              return;
            }
            worktreePath = wt.worktreePath;
            branchName = wt.branchName;
          } else {
            // SVN or non-git repo fallback: SVN worktrees not supported, run in project dir
            worktreePath = projectPath;
            branchName = null;
          }
        }
        workDir = worktreePath ?? projectPath;
        if (isContinue) {
          prompt = continueOptions!.followUpPrompt;
        } else if (todo.review_enabled && currentRound?.input_payload) {
          prompt = currentRound.input_payload;
        } else {
          prompt = todo.description || todo.title || '';
        }
      } else {
        workDir = projectPath;
        if (isContinue) {
          prompt = continueOptions!.followUpPrompt;
        } else if (todo.review_enabled && currentRound?.input_payload) {
          prompt = currentRound.input_payload;
        } else {
          prompt = todo.description || todo.title || '';
        }
      }

      assertTestRuntimePathAllowed(workDir);

      // Handle attached reference images: copy them into the task's worktree/dir
      if (todo.images) {
        try {
          const imagePaths = getTodoImagePaths(todoId);
          const imagesDir = path.join(workDir, '.task-images');
          assertTestRuntimePathAllowed(imagesDir);
          if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
          }
          const copiedFiles: string[] = [];
          for (const { filename, filePath } of imagePaths) {
            const dest = path.join(imagesDir, filename);
            assertTestRuntimePathAllowed(dest);
            fs.copyFileSync(filePath, dest);
            copiedFiles.push(`.task-images/${filename}`);
          }
          prompt += `\n\nReference images are attached at the following paths (relative to working directory):\n${copiedFiles.map(f => `- ${f}`).join('\n')}`;
          queries.createTaskLog(todoId, 'output', `Copied ${copiedFiles.length} image(s) to worktree.`);
        } catch (err) {
          // The run continues without the images, so the agent silently works
          // from an incomplete brief unless this is visible outside the DB.
          logger.warn('todo.images.copy-failed', {
            msg: 'attached reference images could not be copied into the work directory',
            todoId,
            projectId,
            message: clampLine(err instanceof Error ? err.message : String(err)),
          });
          const msg = err instanceof Error ? err.message : String(err);
          queries.createTaskLog(todoId, 'error', `Failed to copy images: ${msg}`);
        }
      }

      const sandboxMode = (project.sandbox_mode as SandboxMode) || 'strict';

      // Sandbox: generate Claude CLI permission settings (worktree or project root)
      if (sandboxMode === 'strict' && resolvedCliTool === 'claude') {
        try {
          configureClaudeSandboxPermissions(workDir);
          queries.createTaskLog(todoId, 'output', `[sandbox] Configured .claude/settings.json with directory-scoped permissions`);
        } catch (err) {
          // Strict mode without its settings file means the CLI runs less
          // constrained than the project asked for — never a silent condition.
          logger.warn('todo.sandbox.config-failed', {
            msg: 'strict sandbox permission settings could not be written',
            todoId,
            projectId,
            provider: resolvedCliTool,
            message: clampLine(err instanceof Error ? err.message : String(err)),
          });
          const msg = err instanceof Error ? err.message : String(err);
          queries.createTaskLog(todoId, 'error', `[sandbox] Failed to create permission settings: ${msg}`);
        }
      }

      // Sandbox: add prompt-level path restriction for strict mode
      if (sandboxMode === 'strict') {

        prompt += `\n\nIMPORTANT: Your working directory is ${workDir}. Do NOT access, read, write, or modify any files outside this directory, except for git operations that naturally access .git metadata.`;
      }

      // Inject long-term memory if configured for this todo
      const memMode = ((todo.memory_inject_mode as MemoryInjectMode | null) || 'none') as MemoryInjectMode;
      const rawFilePaths = parseRawFilePaths(todo.memory_raw_file_paths);
      if (memMode !== 'none' || rawFilePaths.length > 0) {
        const memBlock = await applyMemoryInjection({
          projectId: project.id,
          mode: memMode,
          nodeIds: parseMemoryNodeIds(todo.memory_node_ids),
          rawFilePaths,
          vaultFilePaths: rawFilePaths,
          projectRoot: project.path,
          query: `${todo.title}\n${todo.description ?? ''}`.trim(),
          log: (type, message) => queries.createTaskLog(todoId, type, message, roundNumber),
        });
        if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
          if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
          else resourceManager.releaseOwner('todo', todoId);
          this.activeResourceRuns.delete(todoId);
          return;
        }
        if (memBlock) {
          prompt = `${memBlock}\n\n${prompt}`;
        }
      }

      const claudeOptions = project.claude_options ? project.claude_options : undefined;
      const DEFAULT_MAX_TURNS = 30;
      const maxTurns = todo.max_turns ?? project.default_max_turns ?? DEFAULT_MAX_TURNS;

      // Prompt injection detection (warn only)
      const promptGuardContent = isContinue ? continueOptions!.followUpPrompt : (todo.description || todo.title);
      const validation = validatePromptContent(promptGuardContent);
      if (!validation.valid) {
        for (const w of validation.warnings) {
          queries.createTaskLog(todoId, 'warning', `[prompt-guard] ${w}`, roundNumber);
        }
      }

      // Round separator marker (continue only)
      if (isContinue) {
        queries.createTaskLog(todoId, 'output', `── Round ${roundNumber} ──`, roundNumber);
      }

      // Audit log: record the prompt sent to CLI (truncated for storage)
      const auditPrompt = prompt.length > 2000 ? prompt.slice(0, 2000) + '... [truncated]' : prompt;
      queries.createTaskLog(todoId, 'prompt', auditPrompt, roundNumber);
      if (executionConfig) {
        queries.updateTodo(todoId, { execution_snapshot: JSON.stringify(executionSnapshot(executionConfig)) });
        queries.createTaskLog(todoId, 'info', `[execution] ${JSON.stringify(executionSnapshot(executionConfig))}`, roundNumber);
      }

      const launchModel = executionConfig?.effectiveModel ?? executionConfig?.model;
      const launchEffort = (resolvedCliTool === 'antigravity' && executionConfig?.effectiveModel && executionConfig.effectiveModel !== executionConfig.model)
        ? undefined
        : executionConfig?.effort.nativeEffort;

      logger.info('todo.execution.started', {
        msg: `${isContinue ? 'rework' : (currentRound?.phase ?? 'implementation')} started`,
        phase: currentRound?.phase ?? (isContinue ? 'rework' : 'implementation'),
        round: roundNumber,
        provider: resolvedCliTool,
        ...(launchModel ? { model: launchModel } : {}),
        ...(launchEffort ? { effort: launchEffort } : {}),
        ...(executionConfig?.profileName ? { profile: executionConfig.profileName } : {}),
        mode,
      });

      // Establish the current-run classification boundary immediately before starting provider process
      executionStartRowid = queries.getMaxTaskLogRowid(todoId);

      const result = await claudeManager.startClaude(workDir, prompt, launchModel, claudeOptions, mode, resolvedCliTool, maxTurns, projectPath, sandboxMode, isContinue, undefined, undefined, launchEffort);
      pid = result.pid;
      exitPromise = result.exitPromise;

      if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
        if (pid && pid > 0) {
          try {
            await claudeManager.stopClaude(pid).catch(() => {});
          } catch { /* ignore */ }
        }
        if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
        else resourceManager.releaseOwner('todo', todoId);
        this.activeResourceRuns.delete(todoId);
        return;
      }

      // Debug logging: capture full stdin/stdout/stderr to file
      let stdout = result.stdout;
      let stderr = result.stderr;
      if (project.debug_logging) {
        debugSession = debugLogger.startSession({
          todoId, projectPath, cliTool: resolvedCliTool,
          command: result.command, args: result.args,
          workDir, model: launchModel, sandboxMode,
        });
        debugSession.writeStdin(prompt);
        stdout = debugSession.teeStdout(result.stdout);
        stderr = debugSession.teeStderr(result.stderr);
      }

      // Start streaming logs to DB (Claude uses structured JSON, others use plain text)
      // Interactive mode outputs TUI text (not JSON), so always use plain text streaming
      if (resolvedCliTool === 'claude' && mode !== 'interactive') {
        streamDrainPromise = logStreamer.streamJsonToDb(todoId, stdout, stderr, mode === 'verbose');
      } else {
        streamDrainPromise = logStreamer.streamToDb(todoId, stdout, stderr);
      }

      // Update todo with process info (status already set to 'running' above)
      queries.updateTodo(todoId, { process_pid: pid });

      const logMsg = useWorktree
        ? `Started ${adapter.displayName} (PID: ${pid}) on branch ${branchName} [${mode}]${isContinue ? ` (round ${roundNumber})` : ''}`
        : `Started ${adapter.displayName} (PID: ${pid}) in project directory [${mode}]${isContinue ? ` (round ${roundNumber})` : ''}`;
      queries.createTaskLog(todoId, 'output', logMsg, roundNumber);

      // Broadcast status change with mode and worktree info
      broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'running', mode, worktree_path: worktreePath, branch_name: branchName });
      this.broadcastProjectStatus(projectId);
    } catch (err) {
      if (startToken && !this.isStartupValid(todoId, startToken, projectId)) {
        if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
        else resourceManager.releaseOwner('todo', todoId);
        this.activeResourceRuns.delete(todoId);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.failCurrentRoundAndTodo(todoId, projectId, currentRound, message, roundNumber, adapter?.displayName);
      return;
    }

    // Handle process exit asynchronously
    exitPromise.then(async (exitCode) => {
      // Finalize debug log file
      if (debugSession) {
        try { debugSession.finalize(exitCode); } catch { /* ignore */ }
      }

      // Ensure log streamer has fully drained streams and flushed all trailing lines before log inspection
      if (streamDrainPromise) {
        try {
          await streamDrainPromise;
        } catch { /* ignore */ }
      }

      // Check if todo is intentionally stopping (or project is stopping)
      const currentTodo = queries.getTodoById(todoId);
      const isStopping = this.stoppingTodoIds.has(todoId) || (currentTodo && this.isStoppingProjects.has(currentTodo.project_id));
      if (isStopping) {
        return;
      }

      if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
      if (this.activeResourceRuns.get(todoId) === resourceRunToken) this.activeResourceRuns.delete(todoId);

      let delegated: queries.Todo | null = null;
      // Only update if still in running state (not manually stopped or superseded)
      if (currentTodo && currentTodo.status === 'running') {
        if (todo.review_enabled && currentRound) {
          const freshRound = queries.getExecutionRoundById(currentRound.id);
          if (!freshRound || freshRound.run_token !== currentRound.run_token || freshRound.status !== 'running') {
            // Late callback from an older or superseded execution round — discard
            return;
          }
        }

        if (exitCode !== 0) {
          // Check for context exhaustion before normal failure handling
          const isContextExhausted = logStreamer.isContextExhausted(todoId);
          const tokenUsage = logStreamer.getTokenUsage(todoId);

          // Heuristic: also flag if input_tokens > 85% of context_window (Claude only)
          const heuristicExhausted = resolvedCliTool === 'claude'
            && tokenUsage?.context_window
            && tokenUsage?.input_tokens
            && (tokenUsage.input_tokens / tokenUsage.context_window) > 0.85;

          const fallback = queries.getNextFallbackCli(projectId, resolvedCliTool);
          const shouldAutoSwitch = (isContextExhausted || heuristicExhausted) && fallback;

          if (shouldAutoSwitch) {
            // Save token usage before clearing logs
            queries.updateTodo(todoId, {
              process_pid: 0,
              ...(tokenUsage ? { token_usage: JSON.stringify(tokenUsage) } : {}),
            });
            this.restartWithNextCli(todoId, projectId, resolvedCliTool, fallback, autoChain).catch((err) => {
              logger.error('todo.context-switch.failed', {
                msg: `context switch to ${fallback.cliTool} failed`,
                todoId,
                projectId,
                from: resolvedCliTool,
                to: fallback.cliTool,
                round: roundNumber,
                err,
              });
              try {
                if (todo.review_enabled && currentRound) {
                  reviewPipeline.handleRoundFailure(todoId, currentRound.id, 'Context switch restart failed.');
                } else {
                  queries.updateTodoStatus(todoId, 'failed');
                }
                queries.createTaskLog(todoId, 'error', 'Context switch restart failed.', roundNumber);
              } catch { /* ignore */ }
              broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
              this.broadcastProjectStatus(projectId);
            });
            return;
          }

          // Check for runtime quota / rate-limit rejection (scoped to current execution)
          const combinedOutput = queries.getRecentTaskLogText(todoId, executionStartRowid, 64 * 1024);
          const classification = classifyProviderFailure(resolvedCliTool, exitCode, combinedOutput);

          if (classification.category === 'quota_exhausted' || classification.category === 'rate_limited') {
            if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
              providerQuotaService.markExhausted(resolvedCliTool, {
                source: 'runtime_rejection',
                reason: classification.reason,
                resetAt: classification.resetAt,
              });
            }

            const quotaMsg = `[quota] ${adapter.displayName} quota exhausted (${classification.reason || 'runtime quota rejection'}).`;
            logger.warn('todo.execution.quota-rejected', {
              msg: 'provider rejected the run: quota exhausted',
              provider: resolvedCliTool,
              exitCode,
              reason: clampLine(classification.reason || 'runtime quota rejection'),
              round: roundNumber,
            });
            queries.createTaskLog(todoId, 'warning', quotaMsg, roundNumber);

            if (effectiveProfileId) {
              // Profile execution: re-evaluate with next eligible candidate in effective profile
              queries.updateTodo(todoId, {
                process_pid: 0,
                execution_snapshot: null,
              });
              queries.updateTodoStatus(todoId, 'pending');
              if (currentRound) {
                queries.updateExecutionRound(currentRound.id, {
                  status: 'pending',
                  execution_snapshot: null,
                });
                const updated = queries.getExecutionRoundById(currentRound.id);
                if (updated) broadcaster.broadcast({ type: 'todo:round-updated', todoId, round: updated });
              }
              queries.createTaskLog(
                todoId,
                'output',
                `[quota] Switching to next candidate in profile after ${adapter.displayName} quota exhaustion...`,
                roundNumber,
              );
              this.startSingleTodo(todoId, projectPath, projectId, mode, autoChain, continueOptions).catch((err) => {
                logger.error('todo.quota-switch.failed', {
                  msg: 'switching to the next profile candidate after quota exhaustion failed',
                  todoId,
                  projectId,
                  provider: resolvedCliTool,
                  round: roundNumber,
                  err,
                });
                try {
                  if (todo.review_enabled && currentRound) {
                    reviewPipeline.handleRoundFailure(todoId, currentRound.id, 'Profile candidate switch failed.');
                  } else {
                    queries.updateTodoStatus(todoId, 'failed');
                  }
                  queries.createTaskLog(todoId, 'error', 'Profile candidate switch failed.', roundNumber);
                } catch { /* ignore */ }
                broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
                this.broadcastProjectStatus(projectId);
              });
              this.wakeWaitingExecutors().catch(() => {});
              return;
            } else {
              // Manual execution: do not silently switch executor; fail clearly with quota diagnostic
              const failMsg = `${adapter.displayName} execution failed: provider quota exhausted (${classification.reason || 'runtime quota rejection'}).`;
              logger.error('todo.execution.failed', {
                msg: 'execution failed: provider quota exhausted',
                provider: resolvedCliTool,
                category: classification.category,
                exitCode,
                round: roundNumber,
                reason: clampLine(classification.reason || 'runtime quota rejection'),
              });
              try {
                if (todo.review_enabled && currentRound) {
                  reviewPipeline.handleRoundFailure(todoId, currentRound.id, failMsg);
                } else {
                  queries.updateTodoStatus(todoId, 'failed');
                }
                queries.createTaskLog(todoId, 'error', failMsg, roundNumber);
                queries.updateTodo(todoId, {
                  process_pid: 0,
                  ...(tokenUsage ? {
                    token_usage: JSON.stringify(tokenUsage),
                    total_cost_usd: tokenUsage.total_cost ?? null,
                    total_tokens: ((tokenUsage.input_tokens ?? 0) + (tokenUsage.output_tokens ?? 0)) || null,
                  } : {}),
                });
              } catch {
                try { queries.updateTodoStatus(todoId, 'failed'); } catch { /* ignore */ }
              }

              captureReviewMetadata(todoId).catch(() => { /* ignore */ });
              broadcaster.broadcast({ type: 'todo:log', todoId, message: failMsg, logType: 'error' });
              broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
              this.broadcastProjectStatus(projectId);
              this.wakeWaitingExecutors().catch(() => {});
              return;
            }
          }

          // Normal failure path
          const failMsg = `${adapter.displayName} exited with code ${exitCode}.`;
          logger.error('todo.execution.failed', {
            msg: `process failed with exit code ${exitCode}`,
            provider: resolvedCliTool,
            ...(classification.category ? { category: classification.category } : {}),
            exitCode,
            round: roundNumber,
            phase: currentRound?.phase ?? (isContinue ? 'rework' : 'implementation'),
            // Bounded tail of this run's captured output — never the whole log.
            detail: tailOf(combinedOutput),
          });
          try {
            if (todo.review_enabled && currentRound) {
              reviewPipeline.handleRoundFailure(todoId, currentRound.id, failMsg);
            } else {
              queries.updateTodoStatus(todoId, 'failed');
            }
            queries.createTaskLog(todoId, 'error', failMsg, roundNumber);
            queries.updateTodo(todoId, {
              process_pid: 0,
              ...(tokenUsage ? {
                token_usage: JSON.stringify(tokenUsage),
                total_cost_usd: tokenUsage.total_cost ?? null,
                total_tokens: ((tokenUsage.input_tokens ?? 0) + (tokenUsage.output_tokens ?? 0)) || null,
              } : {}),
            });
          } catch {
            try { queries.updateTodoStatus(todoId, 'failed'); } catch { /* ignore */ }
          }

          captureReviewMetadata(todoId).catch(() => { /* ignore */ });
          broadcaster.broadcast({ type: 'todo:log', todoId, message: failMsg, logType: 'error' });
          broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
          this.broadcastProjectStatus(projectId);
        } else {
          // Success path
          if (resolvedCliTool === 'claude' || resolvedCliTool === 'codex' || resolvedCliTool === 'antigravity') {
            providerQuotaService.markAvailable(resolvedCliTool, { source: 'execution_success' });
          }

          logger.info('todo.execution.completed', {
            msg: `${currentRound?.phase ?? (isContinue ? 'rework' : 'implementation')} completed successfully`,
            provider: resolvedCliTool,
            phase: currentRound?.phase ?? (isContinue ? 'rework' : 'implementation'),
            round: roundNumber,
            exitCode,
          });
          const doneMsg = `${adapter.displayName} completed successfully.${isContinue ? ` (round ${roundNumber})` : ''}`;
          queries.createTaskLog(todoId, 'output', doneMsg, roundNumber);
          const tokenUsage = logStreamer.getTokenUsage(todoId);

          if (todo.review_enabled && currentRound) {
            const combinedOutput = queries.getRecentTaskLogText(todoId, executionStartRowid, 64 * 1024);
            const advanceResult = await reviewPipeline.advanceRoundOnSuccess(
              todoId,
              currentRound.id,
              combinedOutput,
              {
                isCancelled: () =>
                  this.stoppingTodoIds.has(todoId) ||
                  this.isStoppingProjects.has(projectId),
              }
            );

            queries.updateTodo(todoId, {
              process_pid: 0,
              ...(tokenUsage ? {
                token_usage: JSON.stringify(tokenUsage),
                total_cost_usd: tokenUsage.total_cost ?? null,
                total_tokens: ((tokenUsage.input_tokens ?? 0) + (tokenUsage.output_tokens ?? 0)) || null,
              } : {}),
            });

            if (advanceResult.action === 'superseded') {
              return;
            } else if (advanceResult.action === 'start_review' || advanceResult.action === 'start_rework') {
              // Auto-chain next round in pipeline!
              await this.startSingleTodo(todoId, projectPath, projectId, mode, autoChain);
              return;
            } else if (advanceResult.action === 'completed') {
              captureReviewMetadata(todoId).catch(() => { /* ignore */ });
              broadcaster.broadcast({ type: 'todo:log', todoId, message: doneMsg, logType: 'output' });
              broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'completed' });
              try { this.broadcastProjectStatus(projectId); } catch { /* ignore */ }

              try {
                delegated = maybeCreateReviewTodo(projectId, todoId);
              } catch { /* never block completion */ }
              if (delegated) {
                queries.createTaskLog(todoId, 'output', `Auto-delegation: created review task "${delegated.title}" (${delegated.cli_tool}).`, roundNumber);
                broadcaster.broadcast({ type: 'todo:created', todo: delegated });
                try { this.broadcastProjectStatus(projectId); } catch { /* ignore */ }
              }
            }
          } else {
            // Normal non-pipeline todo completion
            try {
              queries.updateTodoStatus(todoId, 'completed');
              queries.updateTodo(todoId, {
                process_pid: 0,
                ...(tokenUsage ? {
                  token_usage: JSON.stringify(tokenUsage),
                  total_cost_usd: tokenUsage.total_cost ?? null,
                  total_tokens: ((tokenUsage.input_tokens ?? 0) + (tokenUsage.output_tokens ?? 0)) || null,
                } : {}),
              });
            } catch {
              try { queries.updateTodoStatus(todoId, 'completed'); } catch { /* ignore */ }
            }

            captureReviewMetadata(todoId).catch(() => { /* ignore */ });
            broadcaster.broadcast({ type: 'todo:log', todoId, message: doneMsg, logType: 'output' });
            broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'completed' });
            try { this.broadcastProjectStatus(projectId); } catch { /* ignore */ }

            try {
              delegated = maybeCreateReviewTodo(projectId, todoId);
            } catch { /* never block completion */ }
            if (delegated) {
              queries.createTaskLog(todoId, 'output', `Auto-delegation: created review task "${delegated.title}" (${delegated.cli_tool}).`, roundNumber);
              broadcaster.broadcast({ type: 'todo:created', todo: delegated });
              try { this.broadcastProjectStatus(projectId); } catch { /* ignore */ }
            }
          }
        }
      }

      // Start dependent children that were waiting for this task to complete
      // (or a review todo this completion just auto-delegated), and trigger global wake
      if (autoChain || delegated) {
        this.startDependentChildren(projectId, todoId).catch(() => {
          // Ignore errors when starting dependent children
        });
      }
      this.wakeWaitingExecutors().catch(() => {
        // Ignore errors
      });
    }).catch((err) => {
      // The completion handler itself threw: the task is being force-failed
      // below and the original exception would otherwise vanish entirely.
      logger.error('todo.execution.handler-failed', {
        msg: 'execution completion handler failed - forcing the task to failed',
        todoId,
        projectId,
        round: roundNumber,
        err,
      });
      try {
        if (resourceRunToken) resourceManager.releaseRun(resourceRunToken);
      } catch { /* ignore */ }
      if (this.activeResourceRuns.get(todoId) === resourceRunToken) this.activeResourceRuns.delete(todoId);
      // Fallback: ensure status is updated if exitPromise handler fails
      try {
        queries.updateTodoStatus(todoId, 'failed');
        queries.updateTodo(todoId, { process_pid: 0 });
      } catch { /* ignore */ }
      try {
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
      } catch { /* ignore */ }
      try {
        this.broadcastProjectStatus(projectId);
      } catch { /* ignore */ }
      this.wakeWaitingExecutors().catch(() => { /* ignore */ });
    });
  }

  /**
   * Restart a task with the next CLI tool in the fallback chain after context exhaustion.
   * Preserves the worktree and clears logs before restarting.
   */
  private async restartWithNextCli(
    todoId: string,
    projectId: string,
    fromCli: string,
    fallback: { cliTool: string; cliModel: null },
    autoChain: boolean,
  ): Promise<void> {
    const project = queries.getProjectById(projectId);
    if (!project) return;

    const currentTodo = queries.getTodoById(todoId);
    if (!currentTodo) return;

    const toCli = fallback.cliTool;
    const switchCount = (currentTodo.context_switch_count ?? 0) + 1;

    if (switchCount > MAX_CONTEXT_SWITCHES) {
      logger.error('todo.context-switch.limit-reached', {
        scope: tag('todo', currentTodo.title),
        msg: `maximum context switches (${MAX_CONTEXT_SWITCHES}) exceeded - stopping the task`,
        todoId,
        projectId,
        switchCount,
        to: toCli,
      });
      queries.updateTodoStatus(todoId, 'failed');
      queries.createTaskLog(todoId, 'error',
        `Maximum context switches (${MAX_CONTEXT_SWITCHES}) exceeded. Stopping task.`);
      queries.updateTodo(todoId, { process_pid: 0 });
      broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
      this.broadcastProjectStatus(projectId);
      return;
    }

    queries.createTaskLog(todoId, 'output',
      `Context exhaustion detected. Switching from ${fromCli} to ${toCli} (attempt ${switchCount})...`);

    // Clear previous logs
    queries.deleteTaskLogsByTodoId(todoId);

    // Update todo with new CLI tool and reset model to default
    queries.updateTodo(todoId, {
      cli_tool: toCli,
      cli_model: null as unknown as string,
      context_switch_count: switchCount,
      process_pid: 0,
    });
    queries.updateTodoStatus(todoId, 'pending');

    // Broadcast the context switch event
    broadcaster.broadcast({
      type: 'todo:context-switch',
      todoId,
      fromCli,
      toCli,
      switchCount,
    });

    // Restart the task
    await this.startSingleTodo(todoId, project.path, projectId, 'headless', autoChain);
  }

  /**
   * Check if a task's dependency is satisfied (no depends_on, or depends_on task is completed).
   */
  private isDependencySatisfied(todo: queries.Todo, allTodos: queries.Todo[]): boolean {
    if (!todo.depends_on) return true;
    const parent = allTodos.find((t) => t.id === todo.depends_on);
    return !!parent && parent.status === 'completed';
  }

  /**
   * Walk the depends_on chain upward and return unsatisfied ancestors (root-first order).
   * Stops at a completed or running ancestor. Detects circular dependencies.
   */
  private getUnsatisfiedAncestorChain(todoId: string): queries.Todo[] {
    const chain: queries.Todo[] = [];
    const visited = new Set<string>();
    let currentId: string | null = queries.getTodoById(todoId)?.depends_on ?? null;

    while (currentId) {
      if (visited.has(currentId)) {
        throw new Error('Circular dependency detected');
      }
      visited.add(currentId);

      const ancestor = queries.getTodoById(currentId);
      if (!ancestor) break;
      if (ancestor.status === 'completed') break;

      chain.unshift(ancestor);
      if (ancestor.status === 'running') break;
      currentId = ancestor.depends_on;
    }

    return chain;
  }

  /**
   * Start pending children that directly depend on a completed parent task.
   * Only starts tasks whose depends_on matches the given parentTodoId,
   * preventing unrelated pending tasks from being auto-started.
   *
   * Also retries any sibling todo that was previously deferred by the
   * main-branch exclusivity gate, since the parent completing may have
   * freed the exclusive slot.
   */
  private async startDependentChildren(projectId: string, parentTodoId: string): Promise<void> {
    const todos = queries.getTodosByProjectId(projectId);
    const running = todos.filter((t) => t.status === 'running');
    const maxConcurrent = this.getMaxConcurrent(projectId);

    // Only start children that depend on the just-completed parent
    const dependentChildren = todos.filter(
      (t) => (t.status === 'pending' || t.status === 'waiting_executor' || t.status === 'waiting_quota' || t.status === 'waiting_resource') && t.depends_on === parentTodoId
    );

    const slotsAvailable = Math.max(0, maxConcurrent - running.length);
    const toStart = dependentChildren.slice(0, slotsAvailable);

    const project = queries.getProjectById(projectId);
    if (!project) return;

    for (const child of toStart) {
      await this.startSingleTodo(child.id, project.path, projectId, 'headless', true);
    }
  }

  async wakeWaitingResources(): Promise<void> {
    this.resourceWakeRequested = true;
    if (this.resourceWakeRunning) return;
    this.resourceWakeRunning = true;
    try {
      while (this.resourceWakeRequested) {
        this.resourceWakeRequested = false;
        await this.processWaitingResources();
      }
    } finally {
      this.resourceWakeRunning = false;
    }
  }

  /**
   * Global wake mechanism: resume waiting_executor and waiting_quota tasks across any project when executor capacity is freed.
   * Uses coalescing / loop semantics so that wake requests arriving during an active pass are never dropped.
   */
  private async wakeAdmissionWaiters(): Promise<void> {
    this.admissionWakeRequested = true;
    if (this.admissionWakeRunning) return;
    this.admissionWakeRunning = true;
    try {
      while (this.admissionWakeRequested) {
        this.admissionWakeRequested = false;
        await this.processAdmissionWaitTasks();
      }
    } finally {
      this.admissionWakeRunning = false;
    }
  }

  /**
   * Global wake mechanism: resume waiting_executor and waiting_quota tasks across any project when executor capacity is freed.
   * Serializes through the shared admission wake loop so concurrent quota/capacity events do not race.
   */
  async wakeWaitingExecutors(): Promise<void> {
    return this.wakeAdmissionWaiters();
  }

  /**
   * Global wake mechanism: resume waiting_executor and waiting_quota tasks across any project when provider quota becomes available.
   * Serializes through the shared admission wake loop so concurrent quota/capacity events do not race.
   */
  async wakeWaitingQuota(): Promise<void> {
    return this.wakeAdmissionWaiters();
  }

  private async processAdmissionWaitTasks(): Promise<void> {
    const waitingExecutors = queries.getTodosByStatus('waiting_executor');
    const waitingQuotas = queries.getTodosByStatus('waiting_quota');
    const waitingTodos = [...waitingExecutors, ...waitingQuotas];
    if (waitingTodos.length === 0) return;

    // Deterministic cross-project ordering: created_at ASC, id ASC
    const sortedWaiting = [...waitingTodos].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    );

    for (const todo of sortedWaiting) {
      if (this.isStoppingProjects.has(todo.project_id) || this.stoppingTodoIds.has(todo.id)) continue;
      const freshTodo = queries.getTodoById(todo.id);
      if (!freshTodo || (freshTodo.status !== 'waiting_executor' && freshTodo.status !== 'waiting_quota')) continue;

      const project = queries.getProjectById(todo.project_id);
      if (!project) continue;

      const projectTodos = queries.getTodosByProjectId(todo.project_id);
      const runningInProject = projectTodos.filter((t) => t.status === 'running');
      const maxConcurrent = this.getMaxConcurrent(todo.project_id);
      if (runningInProject.length >= maxConcurrent) continue;

      const gate = this.canStartNow(project, freshTodo, runningInProject);
      if (!gate.ok) continue;

      if (!this.isDependencySatisfied(freshTodo, projectTodos)) continue;

      await this.startSingleTodo(freshTodo.id, project.path, project.id, 'headless', true);
    }
  }

  private async processWaitingResources(): Promise<void> {
    const waitingTodos = queries.getTodosByStatus('waiting_resource');
    const sortedWaiting = [...waitingTodos].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    );
    for (const todo of sortedWaiting) {
      if (this.isStoppingProjects.has(todo.project_id) || this.stoppingTodoIds.has(todo.id)) continue;
      const freshTodo = queries.getTodoById(todo.id);
      if (!freshTodo || freshTodo.status !== 'waiting_resource') continue;
      const project = queries.getProjectById(todo.project_id);
      if (!project) continue;
      const projectTodos = queries.getTodosByProjectId(todo.project_id);
      const running = projectTodos.filter((candidate) => candidate.status === 'running');
      if (running.length >= this.getMaxConcurrent(todo.project_id)) continue;
      if (!this.canStartNow(project, freshTodo, running).ok) continue;
      if (!this.isDependencySatisfied(freshTodo, projectTodos)) continue;
      await this.startSingleTodo(freshTodo.id, project.path, project.id, 'headless', true);
    }
  }

  async resumeWaitingTasks(projectId: string): Promise<void> {
    await Promise.all([this.wakeAdmissionWaiters(), this.wakeWaitingResources()]);
  }
}

export const orchestrator = new Orchestrator();

