import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { logger } from '../../logging/logger.js';
import type { LogRecord, LogSink } from '../../logging/types.js';

/**
 * Diagnostic-contract coverage for the Todo / Review execution paths.
 *
 * These assert what an operator can see in the terminal, not how many times the
 * logger was called: every terminal transition must surface a WARN or ERROR
 * record, and the prompt must never appear in any of them.
 *
 * `claude-manager` is mocked throughout — no test here launches a real
 * Claude/Codex/Antigravity CLI, spawns a process, or signals one, and every
 * filesystem side effect stays inside the temporary TestWorkspace.
 */

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

vi.mock('../../websocket/broadcaster.js', () => ({
  broadcaster: { broadcast: vi.fn() },
}));

let nextExitResolvers: Array<(code: number) => void> = [];
let capturedPrompts: string[] = [];

vi.mock('../claude-manager.js', () => ({
  claudeManager: {
    startClaude: vi.fn((workDir: string, prompt: string, _model, _options, _mode, cliTool: string) => {
      capturedPrompts.push(prompt);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let exitResolve: (code: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        exitResolve = (code: number) => { stdout.end(); stderr.end(); resolve(code); };
      });
      nextExitResolvers.push(exitResolve!);
      return Promise.resolve({
        pid: 4000 + nextExitResolvers.length,
        exitPromise,
        stdout,
        stderr,
        stdin: null,
        command: cliTool,
        args: [],
      });
    }),
    stopClaude: vi.fn().mockResolvedValue(true),
    killAll: vi.fn().mockResolvedValue(undefined),
  },
}));

let currentWorkspace: TestWorkspace | null = null;

vi.mock('../worktree-manager.js', () => ({
  worktreeManager: {
    createWorktree: vi.fn().mockImplementation(async () => ({
      worktreePath: currentWorkspace?.createSubdir('worktree-1') ?? '',
      branchName: 'task-1',
    })),
    isValidWorktree: vi.fn().mockResolvedValue(true),
    sanitizeBranchName: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/git.js', () => ({
  createGit: () => ({
    diff: vi.fn().mockResolvedValue('diff --git a/index.ts b/index.ts\n+ ok'),
    status: vi.fn().mockResolvedValue({ modified: ['index.ts'], not_added: [], created: [], deleted: [] }),
    raw: vi.fn().mockResolvedValue('index.ts\n'),
  }),
  resolveLocalBaseBranch: vi.fn().mockResolvedValue('main'),
}));

vi.mock('../cli-status.js', () => ({
  getToolStatus: vi.fn().mockResolvedValue({ tool: 'claude', installed: true, version: '1.0.0' }),
  checkAllTools: vi.fn().mockResolvedValue([]),
  clearCache: vi.fn(),
}));

const queries = await import('../../db/queries.js');
const { orchestrator } = await import('../orchestrator.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');
const { logStreamer } = await import('../log-streamer.js');

interface CapturingSink extends LogSink {
  records: LogRecord[];
}

function capturingSink(): CapturingSink {
  const records: LogRecord[] = [];
  return { records, write: (record) => { records.push(record); } };
}

function findRecord(sink: CapturingSink, event: string): LogRecord | undefined {
  return sink.records.find(r => r.event === event);
}

/** Everything an operator would actually read, flattened for substring checks. */
function rendered(sink: CapturingSink): string {
  return sink.records
    .map(r => `${r.scope} ${r.msg} ${r.detail ?? ''} ${JSON.stringify(r.fields)}`)
    .join('\n');
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('Todo / Review diagnostics', () => {
  let workspace: TestWorkspace;
  let project: queries.Project;
  let claudeModel: queries.CliModel;
  let sink: CapturingSink;

  beforeEach(() => {
    workspace = createTestWorkspace('todo-logging');
    currentWorkspace = workspace;
    nextExitResolvers = [];
    capturedPrompts = [];

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);

    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetReservations();
    executorPool.resetLimits();
    providerQuotaService.resetForTesting();

    claudeModel = queries.addModel('claude', 'claude-3-7-sonnet', 'Claude 3.7 Sonnet', ['high']);
    project = queries.createProject('Logging Test Project', workspace.createSubdir('proj'));

    sink = capturingSink();
    logger.configure({ level: 'debug', sinks: [sink] });
  });

  afterEach(() => {
    logger.configure({ level: 'info', dir: null });
    vi.restoreAllMocks();
    resourceManager.shutdown();
    resourceManager.setAvailabilityCallback(null);
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    testDb.close();
    currentWorkspace = null;
    workspace.cleanup();
  });

  function createTodo(title: string, description: string, updates: Parameters<typeof queries.updateTodo>[1] = {}) {
    const todo = queries.createTodo(project.id, title, description, 1, 'claude');
    queries.updateTodo(todo.id, { use_worktree: 0, ...updates });
    return queries.getTodoById(todo.id)!;
  }

  it('logs an ERROR when execution profile selection throws', async () => {
    const profile = queries.createExecutionProfile({
      slug: 'broken-prof',
      name: 'Broken Profile',
      description: 'Gets disabled underneath the task',
      isEnabled: true,
      sortOrder: 0,
      executors: [{ cli_model_id: claudeModel.id, priority: 1 }],
    });
    const todo = createTodo('Broken profile task', 'Do the thing', {
      execution_profile_id: profile.id,
    });
    // Disabled after assignment: selectExecutor then throws instead of
    // returning a status — the path that used to reach the DB and nothing else.
    testDb.prepare('UPDATE execution_profiles SET is_enabled = 0 WHERE id = ?').run(profile.id);

    await orchestrator.startTodo(todo.id);
    await settle();

    const record = findRecord(sink, 'todo.selection.failed')!;
    expect(record).toBeDefined();
    expect(record.level).toBe('error');
    expect(record.scope).toBe('[todo:Broken profile task]');
    expect(record.fields).toMatchObject({
      todoId: todo.id,
      projectId: project.id,
      profileId: profile.id,
    });
    expect(String(record.fields.message)).toContain('disabled');
    expect(queries.getTodoById(todo.id)!.status).toBe('failed');
  });

  it('logs an ERROR when a review-enabled task has no review profile', async () => {
    const todo = createTodo('Reviewed task', 'Implement the feature', {
      review_enabled: 1,
      review_profile_id: null,
      max_review_rounds: 3,
    });

    await orchestrator.startTodo(todo.id);
    expect(nextExitResolvers).toHaveLength(1);

    // Implementation succeeds; the review phase then has nowhere to run.
    nextExitResolvers[0](0);
    await settle();

    const record = findRecord(sink, 'review.profile-missing')!;
    expect(record).toBeDefined();
    expect(record.level).toBe('error');
    expect(record.fields).toMatchObject({ todoId: todo.id, phase: 'review' });
    expect(record.msg).toContain('no review profile is configured');
    expect(queries.getTodoById(todo.id)!.status).toBe('failed');
  });

  it('logs an ERROR when the completion handler itself throws', async () => {
    const todo = createTodo('Handler blows up', 'Implement the feature');

    vi.spyOn(logStreamer, 'getTokenUsage').mockImplementation(() => {
      throw new Error('token usage store is corrupt');
    });

    await orchestrator.startTodo(todo.id);
    expect(nextExitResolvers).toHaveLength(1);
    nextExitResolvers[0](0);
    await settle();

    const record = findRecord(sink, 'todo.execution.handler-failed')!;
    expect(record).toBeDefined();
    expect(record.level).toBe('error');
    expect(record.fields).toMatchObject({ todoId: todo.id, projectId: project.id });
    // The original exception survives instead of being swallowed by the cleanup.
    expect(String(record.fields.message)).toContain('token usage store is corrupt');
    expect(queries.getTodoById(todo.id)!.status).toBe('failed');
  });

  it('logs an ERROR with the exit code when the provider process fails', async () => {
    const todo = createTodo('Failing task', 'Implement the feature');

    await orchestrator.startTodo(todo.id);
    nextExitResolvers[0](1);
    await settle();

    const record = findRecord(sink, 'todo.execution.failed')!;
    expect(record).toBeDefined();
    expect(record.level).toBe('error');
    expect(record.fields).toMatchObject({ exitCode: 1, provider: 'claude' });
    expect(record.scope).toBe('[todo:Failing task]');
  });

  it('logs a WARN when a task waits on provider quota', async () => {
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'usage limit reached',
    });
    const todo = createTodo('Quota blocked', 'Implement the feature');

    await orchestrator.startTodo(todo.id);
    await settle();

    const record = findRecord(sink, 'todo.admission.waiting-quota')!;
    expect(record).toBeDefined();
    expect(record.level).toBe('warn');
    expect(record.fields.provider).toBe('claude');
    expect(queries.getTodoById(todo.id)!.status).toBe('waiting_quota');
    expect(nextExitResolvers).toHaveLength(0);
  });

  it('logs a WARN when a task waits on executor capacity', async () => {
    // Both tasks must run in worktrees, otherwise the main-branch exclusivity
    // gate defers the second one before admission is ever evaluated.
    queries.updateProject(project.id, { is_git_repo: 1 });
    executorPool.setLimit('claude', 1);
    const blocker = createTodo('Blocker', 'Runs first', { use_worktree: 1 });
    await orchestrator.startTodo(blocker.id);
    expect(nextExitResolvers).toHaveLength(1);

    const waiting = createTodo('Waiting task', 'Runs second', { use_worktree: 1 });
    await orchestrator.startTodo(waiting.id);
    await settle();

    const record = sink.records.find(
      r => r.event === 'todo.admission.waiting-executor' && r.fields.todoId === waiting.id,
    )!;
    expect(record).toBeDefined();
    expect(record.level).toBe('warn');
    expect(queries.getTodoById(waiting.id)!.status).toBe('waiting_executor');

    nextExitResolvers[0](0);
    await settle();
  });

  it('does not write project settings while preparing strict sandbox policy', async () => {
    const todo = createTodo('Sandbox task', 'Implement the feature');
    queries.updateProject(project.id, { sandbox_mode: 'strict' });

    const fs = await import('fs');
    const writeSpy = vi.spyOn(fs.default, 'writeFileSync');

    await orchestrator.startTodo(todo.id);
    await settle();

    expect(writeSpy).not.toHaveBeenCalled();
    expect(findRecord(sink, 'todo.sandbox.config-failed')).toBeUndefined();
  });

  describe('prompt confidentiality', () => {
    const SECRET_DESCRIPTION = 'CONFIDENTIAL-BRIEF-9137 rewrite the billing subsystem';

    it('never puts the prompt into a unified logger record on a successful run', async () => {
      const todo = createTodo('Confidential task', SECRET_DESCRIPTION);

      await orchestrator.startTodo(todo.id);
      nextExitResolvers[0](0);
      await settle();

      // The prompt really did reach the CLI...
      expect(capturedPrompts.join('\n')).toContain('CONFIDENTIAL-BRIEF-9137');
      // ...and none of it reached the terminal/file stream.
      expect(rendered(sink)).not.toContain('CONFIDENTIAL-BRIEF-9137');
      expect(rendered(sink)).not.toContain('rewrite the billing subsystem');
      expect(findRecord(sink, 'todo.execution.completed')).toBeDefined();
    });

    it('never puts the prompt into a unified logger record on a failing run', async () => {
      const todo = createTodo('Confidential failing task', SECRET_DESCRIPTION);

      await orchestrator.startTodo(todo.id);
      nextExitResolvers[0](1);
      await settle();

      expect(findRecord(sink, 'todo.execution.failed')).toBeDefined();
      expect(rendered(sink)).not.toContain('CONFIDENTIAL-BRIEF-9137');
    });

    it('keeps the opt-in raw debug capture out of the unified stream', async () => {
      queries.updateProject(project.id, { debug_logging: 1 });
      const todo = createTodo('Debug logged task', SECRET_DESCRIPTION);

      await orchestrator.startTodo(todo.id);
      nextExitResolvers[0](0);
      await settle();

      // debug_logging writes the raw prompt to its own per-project directory...
      const { debugLogger } = await import('../debug-logger.js');
      const files = debugLogger.listLogs(project.path, todo.id);
      expect(files.length).toBeGreaterThan(0);
      const raw = debugLogger.readLog(project.path, files[0].name)!;
      expect(raw).toContain('CONFIDENTIAL-BRIEF-9137');

      // ...and still nothing leaks into the unified console/file stream.
      expect(rendered(sink)).not.toContain('CONFIDENTIAL-BRIEF-9137');
    });
  });
});
