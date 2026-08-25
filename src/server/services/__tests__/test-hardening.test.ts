import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { UNEXPECTED_CLI_LAUNCH_MESSAGE, createMockCliResult } from '../../test-utils/cli-guard.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { claudeManager } = await import('../claude-manager.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');

describe('Test Hardening & Boundary Guard Suite', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace('hardening');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => {});
    executorPool.resetReservations();
    executorPool.resetLimits();
    resourceManager.resetForTesting();
    sessionManager.resetForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    executorPool.resetReservations();
    executorPool.resetLimits();
    resourceManager.resetForTesting();
    sessionManager.resetForTesting();
    testDb.close();
    workspace.cleanup();
  });

  it('1. Sandbox setup writes only below temporary test workspace', async () => {
    const projectDir = workspace.createSubdir('sandbox-project');
    const project = queries.createProject('Sandbox Project', projectDir, 'main', 0);
    const todo = queries.createTodo(project.id, 'Sandbox Todo', undefined, 0, 'claude');

    const mockCli = createMockCliResult(8888, 'claude');
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(mockCli);

    await orchestrator.startTodo(todo.id);

    // Settings file must exist strictly inside the test workspace
    const settingsPath = path.join(projectDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(settingsPath.startsWith(workspace.path)).toBe(true);

    const relative = path.relative(workspace.path, settingsPath);
    expect(relative.startsWith('..')).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);

    // Verify settings content is valid JSON and contains directory-scoped permissions
    const content = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(content.permissions).toBeDefined();
    expect(Array.isArray(content.permissions.allow)).toBe(true);

    mockCli.resolveExit(0);
  });

  it('2. Workspace cleanup removes temporary workspace cleanly', () => {
    const isolatedWorkspace = createTestWorkspace('temp-cleanup-check');
    const createdFile = path.join(isolatedWorkspace.path, 'probe.txt');
    fs.writeFileSync(createdFile, 'test payload', 'utf8');

    expect(fs.existsSync(isolatedWorkspace.path)).toBe(true);
    expect(fs.existsSync(createdFile)).toBe(true);

    isolatedWorkspace.cleanup();

    expect(fs.existsSync(isolatedWorkspace.path)).toBe(false);
    expect(fs.existsSync(createdFile)).toBe(false);
  });

  it('3. Running without mock fails closed with exact guard message', async () => {
    // Calling unmocked startClaude directly must throw the fail-closed error
    await expect(
      claudeManager.startClaude(
        workspace.resolvePath('unmocked-workdir'),
        'Test prompt',
        undefined,
        undefined,
        'task',
        'claude',
      )
    ).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
  });

  it('4. Explicit mock executes normally without being blocked by guard', async () => {
    const mockCli = createMockCliResult(7777, 'claude');
    const startSpy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(mockCli);

    const result = await claudeManager.startClaude(
      workspace.resolvePath('mocked-workdir'),
      'Test prompt',
      undefined,
      undefined,
      'task',
      'claude',
    );

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(result.pid).toBe(7777);
    expect(result.command).toBe('claude');

    mockCli.resolveExit(0);
    await expect(result.exitPromise).resolves.toBe(0);
  });

  it('5. SessionManager and Orchestrator are fail-closed protected against unmocked CLI launches', async () => {
    const projectDir = workspace.createSubdir('guard-project');
    const project = queries.createProject('Guard Project', projectDir, 'main', 0);

    // Test SessionManager startSession without mock: throws and records failure
    const session = queries.createSession(project.id, 'Unmocked Session', undefined, 'claude');
    await expect(sessionManager.startSession(session.id)).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

    const failedSession = queries.getSessionById(session.id);
    expect(failedSession?.status).toBe('failed');

    const sessionLogs = queries.getSessionLogsBySessionId(session.id);
    expect(sessionLogs.some((l) => l.message.includes(UNEXPECTED_CLI_LAUNCH_MESSAGE))).toBe(true);

    // Test Orchestrator startTodo without mock: handles gracefully, fails todo and records failure log
    const todo = queries.createTodo(project.id, 'Unmocked Todo', undefined, 0, 'claude');
    await orchestrator.startTodo(todo.id);

    const failedTodo = queries.getTodoById(todo.id);
    expect(failedTodo?.status).toBe('failed');

    const todoLogs = queries.getTaskLogsByTodoId(todo.id);
    expect(todoLogs.some((l) => l.message.includes(UNEXPECTED_CLI_LAUNCH_MESSAGE))).toBe(true);
  });

  it('6. Test workspaces are strictly isolated inside os.tmpdir() and never created in root', () => {
    const freshWorkspace = createTestWorkspace('root-isolation-check');
    const tempDir = os.tmpdir();

    // Verify workspace path is strictly located under os.tmpdir()
    expect(freshWorkspace.path.startsWith(tempDir)).toBe(true);
    expect(freshWorkspace.path).not.toBe(tempDir);

    // Verify it is not at the filesystem root
    const parsed = path.parse(freshWorkspace.path);
    expect(freshWorkspace.path).not.toBe(parsed.root);
    expect(path.dirname(freshWorkspace.path)).not.toBe(parsed.root);

    // Verify resolvePath and createSubdir stay within workspace
    const subpath = freshWorkspace.resolvePath('sub', 'nested', 'dir');
    expect(subpath.startsWith(freshWorkspace.path)).toBe(true);

    const createdSubdir = freshWorkspace.createSubdir('test-subdir');
    expect(fs.existsSync(createdSubdir)).toBe(true);
    expect(createdSubdir.startsWith(freshWorkspace.path)).toBe(true);

    freshWorkspace.cleanup();
    expect(fs.existsSync(freshWorkspace.path)).toBe(false);
  });
});
