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
const { orchestrator, configureClaudeSandboxPermissions } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { executorPool } = await import('../executor-pool.js');
const { resourceManager } = await import('../resource-manager.js');
const { worktreeManager } = await import('../worktree-manager.js');
const { debugLogger } = await import('../debug-logger.js');
const { exportProjectWikiSync } = await import('../wiki-exporter.js');
const { atomicWriteText } = await import('../../plugins/harness/io.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');
const cliStatus = await import('../cli-status.js');
const { getAdapter } = await import('../cli-adapters.js');
const { createGit } = await import('../../lib/git.js');
const { discoverAntigravity, discoverModelCatalog, execCommand } = await import('../model-sync.js');
const { UNEXPECTED_FS_WRITE_MESSAGE } = await import('../../utils/test-fs-guard.js');








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

      // Execution-local policy must not create or modify project settings.
      const settingsPath = path.join(projectDir, '.claude', 'settings.json');
      expect(fs.existsSync(settingsPath)).toBe(false);
      expect(settingsPath.startsWith(workspace.path)).toBe(true);

      const relative = path.relative(workspace.path, settingsPath);
      expect(relative.startsWith('..')).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);

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

  describe('Runtime Filesystem Sandbox Boundary Suite', () => {
    it('16. forgotten synthetic project path fails closed before any mkdir or write', async () => {
      const forbiddenProjectDir = process.platform === 'win32'
        ? 'C:/aikombinat-forbidden-test-proj'
        : '/aikombinat-forbidden-test-proj';

      // Prove destination does not exist prior to test
      expect(fs.existsSync(forbiddenProjectDir)).toBe(false);

      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const writeFileSpy = vi.spyOn(fs, 'writeFileSync');
      const startClaudeSpy = vi.spyOn(claudeManager, 'startClaude');

      // 1. Direct call to sandbox configuration helper must throw fail-closed error
      expect(() => configureClaudeSandboxPermissions(forbiddenProjectDir)).toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // 2. Orchestrator flow driving execution with forbidden project path
      const project = queries.createProject('Forbidden Project', forbiddenProjectDir, 'main', 0);
      const todo = queries.createTodo(project.id, 'Forbidden Todo', undefined, 0, 'claude');

      await orchestrator.startTodo(todo.id);

      // Assert: fs.mkdirSync was NEVER called for forbidden destination
      const mkdirCalls = mkdirSpy.mock.calls.map(call => String(call[0]));
      expect(mkdirCalls.some(p => p.includes('aikombinat-forbidden-test-proj'))).toBe(false);

      // Assert: fs.writeFileSync was NEVER called for forbidden destination
      const writeCalls = writeFileSpy.mock.calls.map(call => String(call[0]));
      expect(writeCalls.some(p => p.includes('aikombinat-forbidden-test-proj'))).toBe(false);

      // Assert: forbidden path was never created
      expect(fs.existsSync(forbiddenProjectDir)).toBe(false);

      // Assert: no real CLI was launched
      expect(startClaudeSpy).not.toHaveBeenCalled();
    });

    it('17. valid TestWorkspace path leaves user .claude/settings.json byte-identical', () => {
      const ws = createTestWorkspace('valid-sandbox');
      fs.mkdirSync(path.join(ws.path, '.claude'), { recursive: true });
      const settingsPath = path.join(ws.path, '.claude', 'settings.json');
      const original = '{"permissions":{"deny":["Read(.env)"],"ask":["Bash(*)"]},"hooks":{"custom":true}}\n';
      fs.writeFileSync(settingsPath, original);

      expect(() => configureClaudeSandboxPermissions(ws.path)).not.toThrow();
      expect(fs.existsSync(settingsPath)).toBe(true);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);

      ws.cleanup();
      expect(fs.existsSync(ws.path)).toBe(false);
    });

    it('18. representative runtime writers reject unsafe root paths in test mode and accept TestWorkspace paths', async () => {
      const unsafePath = process.platform === 'win32'
        ? 'C:/aikombinat-forbidden-runtime-proj'
        : '/aikombinat-forbidden-runtime-proj';
      const safeDir = workspace.createSubdir('safe-runtime-writers');

      // 1. WorktreeManager.createWorktree
      await expect(worktreeManager.createWorktree(unsafePath, 'feature/test')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // 2. WorktreeManager.cleanupWorktree
      await expect(worktreeManager.cleanupWorktree(unsafePath, path.join(unsafePath, 'sub-wt'), 'feature/test')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // 3. WorktreeManager.resolveConflictWithContent
      await expect(worktreeManager.resolveConflictWithContent(unsafePath, 'file.txt', 'data')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // 4. DebugLogger.startSession
      expect(() => debugLogger.startSession({
        todoId: 'todo-unsafe',
        projectPath: unsafePath,
        cliTool: 'claude',
        command: 'claude',
        args: [],
        workDir: unsafePath,
      })).toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // 5. Wiki Exporter (exportProjectWikiSync)
      const unsafeProject = queries.createProject('Unsafe Wiki Proj', unsafePath, 'main', 0);
      expect(() => exportProjectWikiSync(unsafeProject.id)).toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // 6. Harness atomicWriteText
      await expect(atomicWriteText(path.join(unsafePath, 'file.txt'), 'hello')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // Now verify safe TestWorkspace paths succeed for each
      const safeProject = queries.createProject('Safe Wiki Proj', safeDir, 'main', 0);
      const wikiResult = exportProjectWikiSync(safeProject.id);
      expect(wikiResult).not.toBeNull();
      expect(fs.existsSync(path.join(safeDir, '.aikombinat', 'wiki', 'README.md'))).toBe(true);

      const harnessFile = path.join(safeDir, 'harness.txt');
      await expect(atomicWriteText(harnessFile, 'content')).resolves.not.toThrow();
      expect(fs.readFileSync(harnessFile, 'utf8')).toBe('content');

      const debugSession = debugLogger.startSession({
        todoId: 'todo-safe',
        projectPath: safeDir,
        cliTool: 'claude',
        command: 'claude',
        args: [],
        workDir: safeDir,
      });
      expect(fs.existsSync(debugSession.filePath)).toBe(true);
      debugSession.finalize(0);
    });

    it('19. static source audit: scans server test files to ensure no hardcoded Windows drive root project fixtures', () => {
      const serverDir = path.resolve(__dirname, '..', '..');
      const testFiles: string[] = [];

      function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
            testFiles.push(full);
          }
        }
      }
      walk(serverDir);

      const violations: Array<{ file: string; match: string }> = [];
      const forbiddenProjectPattern = /createProject\(\s*['"][^'"]*['"]\s*,\s*['"][A-Za-z]:[\\/]/;

      for (const file of testFiles) {
        const content = fs.readFileSync(file, 'utf8');
        if (forbiddenProjectPattern.test(content)) {
          const match = content.match(forbiddenProjectPattern);
          violations.push({ file: path.relative(serverDir, file), match: match ? match[0] : '' });
        }
      }

      expect(violations).toEqual([]);
    });

    it('20. WorktreeManager mutating methods fail closed on unsafe paths BEFORE executing any git commands', async () => {
      const unsafePath = process.platform === 'win32'
        ? 'C:/aikombinat-forbidden-worktree-proj'
        : '/aikombinat-forbidden-worktree-proj';

      expect(fs.existsSync(unsafePath)).toBe(false);

      // Verify fail-closed behavior on all mutating WorktreeManager methods
      await expect(worktreeManager.removeWorktree(unsafePath, path.join(unsafePath, 'wt'))).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.squashMergeBranch(unsafePath, 'feature/test')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitDiscardAll(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitCheckout(unsafePath, 'main')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitCommit(unsafePath, 'test commit')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitMerge(unsafePath, 'feature/test')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitRebase(unsafePath, 'main')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitStashPush(unsafePath, 'test stash')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitStage(unsafePath, ['file.txt'])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitUnstage(unsafePath, ['file.txt'])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitPull(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitPush(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitFetch(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitCreateBranch(unsafePath, 'feature/test')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitDeleteBranch(unsafePath, 'feature/test')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitCreateTag(unsafePath, 'v1.0')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitDeleteTag(unsafePath, 'v1.0')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitRenameBranch(unsafePath, 'old', 'new')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitRevert(unsafePath, 'HEAD')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitCherryPick(unsafePath, 'HEAD')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitReset(unsafePath, 'HEAD', 'hard')).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitConflictContinue(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitConflictAbort(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitStashPop(unsafePath)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(worktreeManager.gitDiscard(unsafePath, ['file.txt'])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      // Verify no directory was created on disk
      expect(fs.existsSync(unsafePath)).toBe(false);
    });

    it('21. WorktreeManager mutating operations succeed inside a real TestWorkspace git repository', async () => {
      const gitWs = createTestWorkspace('wm-real-git');
      try {
        const git = createGit(gitWs.path);
        await git.init();
        await git.addConfig('user.name', 'Test Runner');
        await git.addConfig('user.email', 'test@example.com');

        const testFile = gitWs.resolvePath('sample.txt');
        fs.writeFileSync(testFile, 'initial content\n', 'utf8');

        // Stage and commit using WorktreeManager
        await expect(worktreeManager.gitStage(gitWs.path, ['sample.txt'])).resolves.not.toThrow();
        await expect(worktreeManager.gitCommit(gitWs.path, 'initial commit')).resolves.toBeDefined();

        // Create and checkout branch
        await expect(worktreeManager.gitCreateBranch(gitWs.path, 'feature/sample')).resolves.not.toThrow();
        await expect(worktreeManager.gitCheckout(gitWs.path, 'feature/sample')).resolves.not.toThrow();

        // Modify file and test stash operations
        fs.appendFileSync(testFile, 'modified line\n', 'utf8');
        await expect(worktreeManager.gitStashPush(gitWs.path, 'stash test')).resolves.not.toThrow();
        await expect(worktreeManager.gitStashPop(gitWs.path, 0)).resolves.not.toThrow();

        // Commit the modified content so HEAD advances
        await expect(worktreeManager.gitStage(gitWs.path, ['sample.txt'])).resolves.not.toThrow();
        await expect(worktreeManager.gitCommit(gitWs.path, 'second commit')).resolves.toBeDefined();

        // Test discard all (dirty uncommitted line is cleanly discarded)
        fs.appendFileSync(testFile, 'dirty line\n', 'utf8');
        await expect(worktreeManager.gitDiscardAll(gitWs.path)).resolves.not.toThrow();
        expect(fs.readFileSync(testFile, 'utf8').replace(/\r\n/g, '\n')).toBe('initial content\nmodified line\n');
      } finally {
        gitWs.cleanup();
      }
      expect(fs.existsSync(gitWs.path)).toBe(false);
    });


  });
});


