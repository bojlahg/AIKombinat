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
import * as queries from '../db/queries.js';

const MAX_CONTEXT_SWITCHES = 3;

const STALE_CHECK_INTERVAL_MS = 30_000; // 30 seconds

export class Orchestrator {
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

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
   * Find tasks marked 'running' whose process is no longer alive, and mark them as failed.
   */
  private recoverStaleTasks(): void {
    const runningTodos = queries.getTodosByStatus('running');
    let recoveredCount = 0;
    for (const todo of runningTodos) {
      if (!todo.process_pid || todo.process_pid === 0) continue;
      if (!this.isProcessAlive(todo.process_pid)) {
        try {
          queries.updateTodoStatus(todo.id, 'failed');
          queries.createTaskLog(todo.id, 'error', 'Process exited unexpectedly (detected by liveness check).');
          queries.updateTodo(todo.id, { process_pid: 0, execution_snapshot: null });
        } catch { /* ignore */ }
        broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'failed' });
        this.broadcastProjectStatus(todo.project_id);
        recoveredCount++;
      }
    }
    if (recoveredCount > 0) {
      this.wakeWaitingExecutors().catch(() => { /* ignore */ });
    }
  }

  private isProcessAlive(pid: number): boolean {
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
    const pending = todos.filter((t) => t.status === 'pending' || t.status === 'waiting_executor');
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

  private isStoppingProjects: Set<string> = new Set();
  private wakeRunning = false;
  private wakeRequested = false;

  /**
   * Stop all running and waiting todos for a project.
   * Keeps worktrees so users can inspect results.
   */
  async stopProject(projectId: string): Promise<void> {
    this.isStoppingProjects.add(projectId);
    try {
      const todos = queries.getTodosByProjectId(projectId);
      const running = todos.filter((t) => t.status === 'running');
      const waiting = todos.filter((t) => t.status === 'waiting_executor');

      for (const todo of running) {
        if (todo.process_pid) {
          await claudeManager.stopClaude(todo.process_pid).catch(() => { /* ignore */ });
        }
        queries.updateTodoStatus(todo.id, 'stopped');
        queries.updateTodo(todo.id, { process_pid: 0, execution_mode: null });
        queries.createTaskLog(todo.id, 'output', 'Task stopped by user (Stop All).');
        broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'stopped' });
      }

      for (const todo of waiting) {
        queries.updateTodoStatus(todo.id, 'stopped');
        queries.updateTodo(todo.id, { process_pid: 0, execution_mode: null });
        queries.createTaskLog(todo.id, 'output', 'Task stopped by user (Stop All).');
        broadcaster.broadcast({ type: 'todo:status-changed', todoId: todo.id, status: 'stopped' });
      }

      this.broadcastProjectStatus(projectId);
    } finally {
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

    if (todo.process_pid) {
      await claudeManager.stopClaude(todo.process_pid);
    }

    queries.updateTodoStatus(todoId, 'stopped');
    queries.updateTodo(todoId, { process_pid: 0, execution_mode: null });
    queries.createTaskLog(todoId, 'output', 'Task stopped by user.');

    broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'stopped' });
    this.broadcastProjectStatus(todo.project_id);
    if (!this.isStoppingProjects.has(todo.project_id)) {
      this.wakeWaitingExecutors().catch(() => { /* ignore */ });
    }
  }

  /**
   * Internal: start a single todo with all the setup.
   * When continueOptions is provided, reuses the existing worktree and runs a
   * follow-up prompt (no new worktree, no squash merge, CLI session continued).
   */
  private async startSingleTodo(
    todoId: string,
    projectPath: string,
    projectId: string,
    mode: ClaudeMode = 'headless',
    autoChain: boolean = false,
    continueOptions?: { followUpPrompt: string; roundNumber: number },
  ): Promise<void> {
    const todo = queries.getTodoById(todoId);
    if (!todo) return;

    const project = queries.getProjectById(projectId);
    if (!project) return;

    const isContinue = !!continueOptions;
    const roundNumber = continueOptions?.roundNumber ?? (todo.round_count ?? 1);

    const taskContent = (isContinue
      ? continueOptions!.followUpPrompt
      : (todo.description || todo.title || '')
    ).trim();
    // Skip strict action-keyword validation for continue (user is in a live worktree
    // and follow-ups are often short/conversational); just ensure it's non-empty.
    if (isContinue) {
      if (!taskContent) {
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

    if (todo.execution_profile_id) {
      try {
        const selection = await executorPool.selectExecutor({
          executionProfileId: todo.execution_profile_id,
          interactive: mode === 'interactive',
          excludeTodoId: todoId,
          reserveOwnerId: todoId,
        });

        if (selection.status === 'waiting_executor') {
          queries.updateTodoStatus(todoId, 'waiting_executor');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
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

        if (selection.status === 'no_candidates') {
          queries.updateTodoStatus(todoId, 'failed');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
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
        const message = err instanceof Error ? err.message : String(err);
        queries.updateTodoStatus(todoId, 'failed');
        queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
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
            const adapter = getAdapter(resolvedCliTool);
            const failMsg = `${adapter.displayName} execution failed: provider quota exhausted (${quota.reason || 'provider quota is currently exhausted'}).`;
            queries.updateTodoStatus(todoId, 'failed');
            queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
            queries.createTaskLog(todoId, 'error', failMsg, roundNumber);
            broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
            broadcaster.broadcast({ type: 'todo:log', todoId, message: failMsg, logType: 'error' });
            this.broadcastProjectStatus(projectId);
            return;
          }
        }

        const reserved = executorPool.reserveSlot(todoId, resolvedCliTool, { excludeTodoId: todoId });
        if (!reserved) {
          queries.updateTodoStatus(todoId, 'waiting_executor');
          queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
          const adapter = getAdapter(resolvedCliTool);
          const usage = executorPool.getActiveToolUsage(resolvedCliTool, { excludeTodoId: todoId });
          const limit = executorPool.getLimit(resolvedCliTool);
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
        executorPool.releaseReservation(todoId);
        const message = err instanceof Error ? err.message : String(err);
        queries.updateTodoStatus(todoId, 'failed');
        queries.updateTodo(todoId, { execution_mode: null, process_pid: 0 });
        queries.createTaskLog(todoId, 'error', `Configuration error: ${message}`, roundNumber);
        broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
        this.broadcastProjectStatus(projectId);
        return;
      }
    }

    const adapter = getAdapter(resolvedCliTool);
    let pid: number;
    let exitPromise: Promise<number>;
    let debugSession: DebugSession | null = null;
    let executionStartRowid = 0;

    // Mark as running synchronously and release reservation immediately (no await in between)
    queries.updateTodoStatus(todoId, 'running');
    queries.updateTodo(todoId, {
      execution_mode: mode,
      ...(executionConfig
        ? { execution_snapshot: JSON.stringify(executionSnapshot(executionConfig)) }
        : { execution_snapshot: JSON.stringify({ configuration: 'manual', agent: resolvedCliTool }) }),
    });
    executorPool.releaseReservation(todoId);
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

        // Reuse existing worktree if available (context switch restart OR continue scenario)
        // Validates that the worktree is a real git checkout, not just an empty directory
        if (todo.worktree_path && todo.branch_name && isGitRepo && (await worktreeManager.isValidWorktree(todo.worktree_path))) {
          worktreePath = todo.worktree_path;
          branchName = todo.branch_name;
          queries.createTaskLog(todoId, 'output', `Reusing existing worktree at ${worktreePath} (branch: ${branchName})`, roundNumber);
        } else {
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
            worktreePath = wt.worktreePath;
            branchName = wt.branchName;
          } else {
            // SVN or non-git repo fallback: SVN worktrees not supported, run in project dir
            worktreePath = projectPath;
            branchName = null;
          }
        }
        workDir = worktreePath;
        prompt = isContinue ? continueOptions!.followUpPrompt : (todo.description || todo.title);
      } else {
        workDir = projectPath;
        prompt = isContinue ? continueOptions!.followUpPrompt : (todo.description || todo.title);
      }

      executionStartRowid = queries.getMaxTaskLogRowid(todoId);

      // Handle attached reference images: copy them into the task's worktree/dir
      if (todo.images) {
        try {
          const imagePaths = getTodoImagePaths(todoId);
          const imagesDir = path.join(workDir, '.task-images');
          if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
          }
          const copiedFiles: string[] = [];
          for (const { filename, filePath } of imagePaths) {
            const dest = path.join(imagesDir, filename);
            fs.copyFileSync(filePath, dest);
            copiedFiles.push(`.task-images/${filename}`);
          }
          prompt += `\n\nReference images are attached at the following paths (relative to working directory):\n${copiedFiles.map(f => `- ${f}`).join('\n')}`;
          queries.createTaskLog(todoId, 'output', `Copied ${copiedFiles.length} image(s) to worktree.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          queries.createTaskLog(todoId, 'error', `Failed to copy images: ${msg}`);
        }
      }

      const sandboxMode = (project.sandbox_mode as SandboxMode) || 'strict';

      // Sandbox: generate Claude CLI permission settings (worktree or project root)
      if (sandboxMode === 'strict' && resolvedCliTool === 'claude') {
        try {
          const claudeDir = path.join(workDir, '.claude');
          const settingsPath = path.join(claudeDir, 'settings.json');
          if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
          }
          // Merge permissions into existing settings.json (may already exist from git checkout with hooks etc.)
          const existingSettings = fs.existsSync(settingsPath)
            ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
            : {};
          // Claude's permission matcher normalizes paths to forward slashes; mixed separators
          // (e.g. backslash dir + slash glob on Windows) silently fail to match.
          const normalizedWorkDir = workDir.replace(/\\/g, '/');
          existingSettings.permissions = {
            allow: [
              `Read(${normalizedWorkDir}/**)`,`Edit(${normalizedWorkDir}/**)`,`Write(${normalizedWorkDir}/**)`,
              'Bash(*)','Glob(*)','Grep(*)',
              'TodoRead','TodoWrite','WebFetch(*)',
            ],
            deny: [],
          };
          fs.writeFileSync(settingsPath, JSON.stringify(existingSettings, null, 2));
          queries.createTaskLog(todoId, 'output', `[sandbox] Configured .claude/settings.json with directory-scoped permissions`);
        } catch (err) {
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
      const result = await claudeManager.startClaude(workDir, prompt, launchModel, claudeOptions, mode, resolvedCliTool, maxTurns, projectPath, sandboxMode, isContinue, undefined, undefined, launchEffort);
      pid = result.pid;
      exitPromise = result.exitPromise;

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
        logStreamer.streamJsonToDb(todoId, stdout, stderr, mode === 'verbose');
      } else {
        logStreamer.streamToDb(todoId, stdout, stderr);
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
      const message = err instanceof Error ? err.message : String(err);
      queries.updateTodoStatus(todoId, 'failed');
      queries.updateTodo(todoId, { process_pid: 0, execution_mode: null });
      queries.createTaskLog(todoId, 'error', `Failed to start ${adapter.displayName}: ${message}`, roundNumber);
      broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
      this.broadcastProjectStatus(projectId);
      this.wakeWaitingExecutors().catch(() => {});
      return;
    }

    // Handle process exit asynchronously
    exitPromise.then((exitCode) => {
      // Finalize debug log file
      if (debugSession) {
        try { debugSession.finalize(exitCode); } catch { /* ignore */ }
      }
      let delegated: queries.Todo | null = null;
      const currentTodo = queries.getTodoById(todoId);
      // Only update if still in running state (not manually stopped)
      if (currentTodo && currentTodo.status === 'running') {
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
            this.restartWithNextCli(todoId, projectId, resolvedCliTool, fallback, autoChain).catch(() => {
              try {
                queries.updateTodoStatus(todoId, 'failed');
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
            queries.createTaskLog(todoId, 'warning', quotaMsg, roundNumber);

            if (currentTodo.execution_profile_id) {
              // Profile execution: re-evaluate with next eligible candidate
              queries.updateTodo(todoId, {
                process_pid: 0,
                execution_snapshot: null,
              });
              queries.updateTodoStatus(todoId, 'pending');
              queries.createTaskLog(
                todoId,
                'output',
                `[quota] Switching to next candidate in profile after ${adapter.displayName} quota exhaustion...`,
                roundNumber,
              );
              this.startSingleTodo(todoId, projectPath, projectId, mode, autoChain, continueOptions).catch(() => {
                try {
                  queries.updateTodoStatus(todoId, 'failed');
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
              try {
                queries.updateTodoStatus(todoId, 'failed');
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
          try {
            queries.updateTodoStatus(todoId, 'failed');
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

          const doneMsg = `${adapter.displayName} completed successfully.${isContinue ? ` (round ${roundNumber})` : ''}`;
          try {
            queries.updateTodoStatus(todoId, 'completed');
            queries.createTaskLog(todoId, 'output', doneMsg, roundNumber);
            const tokenUsage = logStreamer.getTokenUsage(todoId);
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
          this.broadcastProjectStatus(projectId);

          try {
            delegated = maybeCreateReviewTodo(projectId, todoId);
          } catch { /* never block completion */ }
          if (delegated) {
            queries.createTaskLog(todoId, 'output', `Auto-delegation: created review task "${delegated.title}" (${delegated.cli_tool}).`, roundNumber);
            broadcaster.broadcast({ type: 'todo:created', todo: delegated });
            this.broadcastProjectStatus(projectId);
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
    }).catch(() => {
      // Fallback: ensure status is updated if exitPromise handler fails
      try {
        queries.updateTodoStatus(todoId, 'failed');
        queries.updateTodo(todoId, { process_pid: 0 });
      } catch { /* ignore */ }
      broadcaster.broadcast({ type: 'todo:status-changed', todoId, status: 'failed' });
      this.broadcastProjectStatus(projectId);
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
      (t) => (t.status === 'pending' || t.status === 'waiting_executor') && t.depends_on === parentTodoId
    );

    const slotsAvailable = Math.max(0, maxConcurrent - running.length);
    const toStart = dependentChildren.slice(0, slotsAvailable);

    const project = queries.getProjectById(projectId);
    if (!project) return;

    for (const child of toStart) {
      await this.startSingleTodo(child.id, project.path, projectId, 'headless', true);
    }
  }

  /**
   * Global wake mechanism: resume waiting_executor tasks across any project when executor capacity is freed.
   * Uses coalescing / loop semantics so that wake requests arriving during an active pass are never dropped.
   */
  async wakeWaitingExecutors(): Promise<void> {
    this.wakeRequested = true;
    if (this.wakeRunning) return;
    this.wakeRunning = true;
    try {
      while (this.wakeRequested) {
        this.wakeRequested = false;
        await this.processWaitingExecutors();
      }
    } finally {
      this.wakeRunning = false;
    }
  }

  private async processWaitingExecutors(): Promise<void> {
    const waitingTodos = queries.getTodosByStatus('waiting_executor');
    if (waitingTodos.length === 0) return;

    // Deterministic cross-project ordering: created_at ASC, id ASC
    const sortedWaiting = [...waitingTodos].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    );

    for (const todo of sortedWaiting) {
      if (this.isStoppingProjects.has(todo.project_id)) continue;
      const freshTodo = queries.getTodoById(todo.id);
      if (!freshTodo || freshTodo.status !== 'waiting_executor') continue;

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

  async resumeWaitingTasks(projectId: string): Promise<void> {
    return this.wakeWaitingExecutors();
  }
}

export const orchestrator = new Orchestrator();

// Quota-driven CLI fallback: when log-streamer detects repeated quota errors,
// kill the running CLI process so the existing exit-code fallback path triggers
// `getNextFallbackCli` and switches to the next CLI in the chain.
logStreamer.setQuotaKillCallback((todoId) => {
  try {
    const todo = queries.getTodoById(todoId);
    if (todo?.process_pid && todo.process_pid > 0) {
      claudeManager.stopClaude(todo.process_pid).catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
});
