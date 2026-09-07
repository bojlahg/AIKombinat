import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';
import type { DelegationRunStatus } from './store.js';

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
const { executorPool } = await import('../services/executor-pool.js');

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
  afterEach(() => { executorPool.setAvailabilityCallback(null); vi.clearAllMocks(); testDb.close(); workspace.cleanup(); });

  function runningRun(pid = 900, status: DelegationRunStatus = 'running') {
    const parent = store.createParentExecution({ ownerId: 'todo', workDir: workspace.path, executionSnapshot: {}, provider: 'claude', policyMode: 'telemetry', capability: `cap-${pid}` });
    const id = store.createDelegationRun({ parent, executionProfileId: 'profile', sourcePathRelative: 'source.ts', sourceSha256: 'hash', sourceBytes: 10, sourceChars: 10, sourceLines: 1, queryHash: 'query', queryLength: 5 });
    store.updateDelegationRun(id, { status, processPid: pid, processIdentity: JSON.stringify({ pid, startTime: 'owned' }), executionSnapshot: { agent: 'codex' }, finished: status === 'completed' || status === 'failed' || status === 'cancelled' });
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

  it('retains ownership when a safe cleanup attempt throws', async () => {
    const id = runningRun();
    vi.mocked(claudeManager.stopClaude).mockRejectedValue(new Error('probe failed'));
    expect(await recoverDelegationRuns()).toEqual({ reconciled: 0, recoveryRequired: 1 });
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'recovery_required', process_pid: 900 });
  });

  it('passively converges after an unverifiable worker later dies and wakes capacity once', async () => {
    const id = runningRun();
    const wake = vi.fn();
    executorPool.setAvailabilityCallback(wake);
    vi.mocked(processTree.verifyProcessIdentity).mockResolvedValue('unverifiable');
    await recoverDelegationRuns();
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'recovery_required', process_pid: 900 });
    vi.mocked(processTree.isProcessAlive).mockReturnValue(false);
    expect(await recoverDelegationRuns({ passive: true })).toEqual({ reconciled: 1, recoveryRequired: 0 });
    expect(await recoverDelegationRuns({ passive: true })).toEqual({ reconciled: 0, recoveryRequired: 0 });
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'failed', process_pid: null });
  });

  it('does not let an old asynchronous reconciliation clear superseding ownership', async () => {
    const id = runningRun();
    store.updateDelegationRun(id, { status: 'recovery_required' });
    let resolveVerdict!: (value: 'mismatch') => void;
    vi.mocked(processTree.verifyProcessIdentity).mockImplementation(() => new Promise((resolve) => { resolveVerdict = resolve; }));
    const reconciliation = recoverDelegationRuns({ passive: true });
    await Promise.resolve();
    const newerIdentity = JSON.stringify({ pid: 900, startTime: 'new-owner' });
    store.updateDelegationRun(id, { status: 'recovery_required', processPid: 900, processIdentity: newerIdentity });
    resolveVerdict('mismatch');
    expect(await reconciliation).toEqual({ reconciled: 0, recoveryRequired: 0 });
    expect(store.getDelegationRun(id)).toMatchObject({
      status: 'recovery_required', process_pid: 900, process_identity: newerIdentity,
    });
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
  });

  it('counts and passively reconciles terminal rows with persisted PID ownership', async () => {
    const id = runningRun(901, 'failed');
    const wake = vi.fn();
    executorPool.setAvailabilityCallback(wake);
    vi.mocked(processTree.isProcessAlive).mockReturnValue(false);

    expect(store.getDelegationRunsWithPersistedProcess().map((row) => row.id)).toContain(id);
    expect(store.getActiveDelegationUsage('codex')).toBe(1);
    expect(await recoverDelegationRuns({ passive: true })).toEqual({ reconciled: 1, recoveryRequired: 0 });
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'failed', process_pid: null, process_identity: null });
    expect(store.getActiveDelegationUsage('codex')).toBe(0);
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping recovery passes so one PID is never signalled twice', async () => {
    const id = runningRun(902, 'failed');
    const wake = vi.fn();
    executorPool.setAvailabilityCallback(wake);
    let resolveStop!: (value: { status: 'terminated'; pid: number; graceful: boolean }) => void;
    vi.mocked(claudeManager.stopClaude).mockImplementation(() => new Promise((resolve) => { resolveStop = resolve; }));

    const first = recoverDelegationRuns({ passive: true });
    await Promise.resolve();
    const second = recoverDelegationRuns({ passive: true });
    expect(second).toBe(first);
    expect(claudeManager.stopClaude).toHaveBeenCalledTimes(1);
    resolveStop({ status: 'terminated', pid: 902, graceful: false });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { reconciled: 1, recoveryRequired: 0 }, { reconciled: 1, recoveryRequired: 0 },
    ]);
    await Promise.resolve();
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'failed', process_pid: null });
    expect(claudeManager.stopClaude).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('never signals a mismatched terminal PID', async () => {
    const id = runningRun(903, 'completed');
    vi.mocked(processTree.verifyProcessIdentity).mockResolvedValue('mismatch');
    await recoverDelegationRuns({ passive: true });
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'completed', process_pid: null });
  });

  it('retains anomalous terminal ownership when identity is unverifiable', async () => {
    const id = runningRun(904, 'cancelled');
    vi.mocked(processTree.verifyProcessIdentity).mockResolvedValue('unverifiable');
    expect(await recoverDelegationRuns({ passive: true })).toEqual({ reconciled: 0, recoveryRequired: 1 });
    expect(store.getDelegationRun(id)).toMatchObject({ status: 'recovery_required', process_pid: 904 });
    expect(store.getActiveDelegationUsage('codex')).toBe(1);
    expect(claudeManager.stopClaude).not.toHaveBeenCalled();
  });
});
