import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));
vi.mock('../utils/process-tree.js', () => ({
  isProcessAlive: vi.fn(), verifyProcessIdentity: vi.fn(),
}));
vi.mock('../services/claude-manager.js', () => ({
  claudeManager: { stopClaude: vi.fn() },
}));

const processTree = await import('../utils/process-tree.js');
const { claudeManager } = await import('../services/claude-manager.js');
const store = await import('./store.js');
const { recoverDelegationRuns } = await import('./recovery.js');

describe('delegation recovery', () => {
  let workspace: TestWorkspace;
  beforeEach(() => {
    workspace = createTestWorkspace('delegation-recovery'); testDb = new Database(':memory:'); initDatabase(testDb);
    testDb.prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Project', ?)").run(workspace.path);
    testDb.prepare("INSERT INTO todos (id, project_id, title) VALUES ('todo', 'project', 'Todo')").run();
    testDb.prepare("INSERT INTO execution_profiles (id, slug, name) VALUES ('profile', 'worker', 'Worker')").run();
    vi.mocked(processTree.isProcessAlive).mockReturnValue(true);
    vi.mocked(processTree.verifyProcessIdentity).mockResolvedValue('match');
    vi.mocked(claudeManager.stopClaude).mockResolvedValue({ status: 'terminated', pid: 900, graceful: false });
  });
  afterEach(() => { vi.clearAllMocks(); testDb.close(); workspace.cleanup(); });

  function runningRun(pid = 900) {
    const parent = store.createParentExecution({ ownerId: 'todo', workDir: workspace.path, executionSnapshot: {}, provider: 'claude', policyMode: 'telemetry', capability: `cap-${pid}` });
    const id = store.createDelegationRun({ parent, executionProfileId: 'profile', sourcePathRelative: 'source.ts', sourceSha256: 'hash', sourceBytes: 10, sourceChars: 10, sourceLines: 1, queryHash: 'query', queryLength: 5 });
    store.updateDelegationRun(id, { status: 'running', processPid: pid, processIdentity: JSON.stringify({ pid, startTime: 'owned' }), executionSnapshot: { agent: 'codex' } });
    return id;
  }

  it('reconciles a dead worker without signalling it', async () => {
    const id = runningRun(); vi.mocked(processTree.isProcessAlive).mockReturnValue(false);
    expect(await recoverDelegationRuns()).toEqual({ reconciled: 1, recoveryRequired: 0 });
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'failed', process_pid: null });
  });

  it('never signals an identity mismatch and clears stale ownership', async () => {
    const id = runningRun(); vi.mocked(processTree.verifyProcessIdentity).mockResolvedValue('mismatch');
    await recoverDelegationRuns();
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'failed', process_pid: null });
  });

  it('retains provider ownership when identity is unverifiable', async () => {
    const id = runningRun(); vi.mocked(processTree.verifyProcessIdentity).mockResolvedValue('unverifiable');
    expect(await recoverDelegationRuns()).toEqual({ reconciled: 0, recoveryRequired: 1 });
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'recovery_required', process_pid: 900 });
    expect(store.getActiveDelegationUsage('codex')).toBe(1);
  });

  it('terminates an identity-matched orphan because its MCP caller is gone', async () => {
    const id = runningRun();
    await recoverDelegationRuns();
    expect(claudeManager.stopClaude).toHaveBeenCalledWith(900, { pid: 900, startTime: 'owned' });
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'failed', process_pid: null });
  });
});
