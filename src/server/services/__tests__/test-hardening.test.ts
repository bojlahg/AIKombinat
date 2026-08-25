import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import child_process from 'child_process';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, getActiveWorkspacesCount, type TestWorkspace } from '../../test-utils/workspace.js';
import { UNEXPECTED_CLI_LAUNCH_MESSAGE, createMockCliResult, installDefaultCliGuard } from '../../test-utils/cli-guard.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { claudeManager } = await import('../claude-manager.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');
const cliStatus = await import('../cli-status.js');
const { getAdapter } = await import('../cli-adapters.js');
const { discoverAntigravity, discoverModelCatalog, execCommand } = await import('../model-sync.js');

describe('Test Hardening & Boundary Guard Suite', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    cliStatus.clearCache();
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
    cliStatus.clearCache();
    executorPool.resetReservations();
    executorPool.resetLimits();
    resourceManager.resetForTesting();
    sessionManager.resetForTesting();
    testDb.close();
    workspace.cleanup();
  });

  describe('Sandbox File System Containment', () => {
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
  });

  describe('AI CLI Boundary Fail-Closed Protections', () => {
    it('2. unmocked startClaude in test mode fails closed before calling getToolStatus or spawning processes', async () => {
      const execFileSpy = vi.spyOn(child_process, 'execFile');
      const spawnSpy = vi.spyOn(child_process, 'spawn');
      const getToolStatusSpy = vi.spyOn(cliStatus, 'getToolStatus');

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

      expect(getToolStatusSpy).not.toHaveBeenCalled();
      expect(execFileSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('3. getToolStatus cannot invoke real execFile for claude, codex, or antigravity in test mode', async () => {
      const execFileSpy = vi.spyOn(child_process, 'execFile');

      await expect(cliStatus.getToolStatus('claude')).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      await expect(cliStatus.getToolStatus('codex')).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      await expect(cliStatus.getToolStatus('antigravity')).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

      // Raw shell requires no process execution and resolves shell metadata safely
      const rawShellStatus = await cliStatus.getToolStatus('raw-shell');
      expect(rawShellStatus?.installed).toBe(true);

      // Verify no real AI CLI execFile was ever dispatched
      expect(execFileSpy).not.toHaveBeenCalled();
    });

    it('4. checkAllTools cannot invoke real execFile in test mode without mocks', async () => {
      const execFileSpy = vi.spyOn(child_process, 'execFile');
      await expect(cliStatus.checkAllTools()).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      expect(execFileSpy).not.toHaveBeenCalled();
    });

    it('5. explicit CLI mocks execute normally across startClaude and cliStatus', async () => {
      const mockCli = createMockCliResult(7777, 'claude');
      const startSpy = vi.spyOn(claudeManager, 'startClaude').mockResolvedValue(mockCli);
      const statusSpy = vi.spyOn(cliStatus, 'getToolStatus').mockResolvedValue({
        tool: 'claude',
        installed: true,
        version: 'Claude Code 1.0.0',
      });

      const toolStatus = await cliStatus.getToolStatus('claude');
      expect(statusSpy).toHaveBeenCalledWith('claude');
      expect(toolStatus).toMatchObject({ tool: 'claude', installed: true, version: 'Claude Code 1.0.0' });

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

    it('6. installDefaultCliGuard helper installs fail-closed spies across startClaude and cliStatus', async () => {
      installDefaultCliGuard();

      await expect(
        claudeManager.startClaude(workspace.resolvePath('workdir'), 'prompt', undefined, undefined, 'task', 'claude')
      ).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

      await expect(cliStatus.getToolStatus('codex')).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      await expect(cliStatus.checkAllTools()).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
    });

    it('7. SessionManager and Orchestrator are fail-closed protected against unmocked CLI launches', async () => {
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

    it('8. discoverAntigravity with default runner cannot execute agy', async () => {
      const execFileSpy = vi.spyOn(child_process, 'execFile');
      const spawnSpy = vi.spyOn(child_process, 'spawn');

      await expect(discoverAntigravity()).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      expect(execFileSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('9. discoverModelCatalog for codex cannot spawn codex app-server', async () => {
      const spawnSpy = vi.spyOn(child_process, 'spawn');

      await expect(discoverModelCatalog('codex')).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('10. getAdapter probeModels cannot execute claude --help or agy --help', async () => {
      const execFileSpy = vi.spyOn(child_process, 'execFile');

      const claudeAdapter = getAdapter('claude');
      await expect(claudeAdapter.probeModels!()).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

      const agyAdapter = getAdapter('antigravity');
      await expect(agyAdapter.probeModels!()).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

      const codexAdapter = getAdapter('codex');
      await expect(codexAdapter.probeModels!()).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

      expect(execFileSpy).not.toHaveBeenCalled();
    });

    it('11. execCommand with process.execPath is NOT blocked by AI guard', async () => {
      const res = await execCommand(process.execPath, ['-e', 'console.log("allowed non-ai child process");']);
      expect(res.exitCode).toBe(0);
      expect(res.timeout).toBe(false);
      expect(res.stdout.trim()).toBe('allowed non-ai child process');
    });

    it('12. execCommand with AI CLI binary throws fail-closed error', async () => {
      const spawnSpy = vi.spyOn(child_process, 'spawn');
      const execFileSpy = vi.spyOn(child_process, 'execFile');

      await expect(execCommand('claude', ['--help'])).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      await expect(execCommand('claude.cmd', ['--version'])).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      await expect(execCommand('codex', ['exec'])).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);
      await expect(execCommand('agy', ['models'])).rejects.toThrow(UNEXPECTED_CLI_LAUNCH_MESSAGE);

      expect(spawnSpy).not.toHaveBeenCalled();
      expect(execFileSpy).not.toHaveBeenCalled();
    });
  });

  describe('TestWorkspace Path Containment & Lifecycle Invariants', () => {
    it('13. rejects path traversal outside workspace via resolvePath and createSubdir', () => {
      const testWs = createTestWorkspace('containment-check');

      // Traversal via ..
      expect(() => testWs.resolvePath('..', 'outside')).toThrow(/escapes test workspace/);
      expect(() => testWs.resolvePath('sub', '..', '..', 'escape')).toThrow(/escapes test workspace/);
      expect(() => testWs.createSubdir('..', 'outside-dir')).toThrow(/escapes test workspace/);
      expect(() => testWs.createSubdir('nested', '..', '..', 'escape-dir')).toThrow(/escapes test workspace/);

      // Absolute path traversal escaping workspace
      const siblingPath = path.resolve(os.tmpdir(), 'sibling-workspace');
      expect(() => testWs.resolvePath(siblingPath)).toThrow(/escapes test workspace/);
      expect(() => testWs.createSubdir(siblingPath)).toThrow(/escapes test workspace/);

      // Valid containment paths succeed
      const validPath = testWs.resolvePath('valid', 'subpath.txt');
      expect(validPath.startsWith(testWs.path)).toBe(true);

      const validDir = testWs.createSubdir('valid', 'sub', 'dir');
      expect(fs.existsSync(validDir)).toBe(true);
      expect(validDir.startsWith(testWs.path)).toBe(true);

      testWs.cleanup();
    });

    it('14. only untracks workspace from activeWorkspaces after successful deletion', () => {
      const initialActiveCount = getActiveWorkspacesCount();
      const testWs = createTestWorkspace('tracking-check');
      expect(getActiveWorkspacesCount()).toBe(initialActiveCount + 1);

      // Simulate a cleanup failure by stubbing fs.rmSync to throw
      const originalRmSync = fs.rmSync;
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
        throw new Error('EBUSY: resource locked');
      });

      expect(() => testWs.cleanup()).toThrow(/Failed to clean up test workspace/);
      // Because cleanup failed, workspace remains tracked in activeWorkspaces
      expect(getActiveWorkspacesCount()).toBe(initialActiveCount + 1);

      rmSpy.mockRestore();

      // Successful cleanup removes it from activeWorkspaces
      testWs.cleanup();
      expect(getActiveWorkspacesCount()).toBe(initialActiveCount);
      expect(fs.existsSync(testWs.path)).toBe(false);
    });

    it('15. verifies test workspaces are strictly located below os.tmpdir() and not at root', () => {
      const freshWorkspace = createTestWorkspace('root-isolation-check');
      const tempDir = os.tmpdir();

      // Verify workspace path is strictly located under os.tmpdir()
      expect(freshWorkspace.path.startsWith(tempDir)).toBe(true);
      expect(freshWorkspace.path).not.toBe(tempDir);

      // Verify it is not at the filesystem root
      const parsed = path.parse(freshWorkspace.path);
      expect(freshWorkspace.path).not.toBe(parsed.root);
      expect(path.dirname(freshWorkspace.path)).not.toBe(parsed.root);

      freshWorkspace.cleanup();
      expect(fs.existsSync(freshWorkspace.path)).toBe(false);
    });
  });
});
