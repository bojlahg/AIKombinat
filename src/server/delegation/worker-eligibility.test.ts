import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));
vi.mock('../services/cli-status.js', () => ({
  getToolStatus: vi.fn(async (tool: string) => ({ tool, installed: true, version: 'test' })),
}));

const queries = await import('../db/queries.js');
const { ExecutorPool } = await import('../services/executor-pool.js');
const { updateDelegationSettings } = await import('./settings.js');
const { getDelegationWorkerIsolationCapability } = await import('./worker-isolation.js');

describe('delegation worker eligibility', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
    testDb.pragma('ignore_check_constraints = ON');
    testDb.prepare(`INSERT INTO cli_models
      (id, cli_tool, model_value, model_label, status, source) VALUES ('raw-model', 'raw-shell', 'shell', 'Raw Shell', 'available', 'manual')`).run();
  });
  afterEach(() => { vi.restoreAllMocks(); testDb.close(); });

  function profileWith(executors: Array<{ modelId: string; priority: number }>) {
    const id = `profile-${Math.random()}`;
    testDb.prepare('INSERT INTO execution_profiles (id, slug, name) VALUES (?, ?, ?)').run(id, id, id);
    for (const [index, executor] of executors.entries()) {
      testDb.prepare(`INSERT INTO execution_profile_executors
        (id, profile_id, cli_model_id, priority) VALUES (?, ?, ?, ?)`).run(
          `${id}-${index}`, id, executor.modelId, executor.priority,
        );
    }
    return id;
  }

  it('rejects raw-shell-only selection without spawning a worker', async () => {
    const pool = new ExecutorPool();
    const profileId = profileWith([{ modelId: 'raw-model', priority: 1 }]);
    const result = await pool.selectExecutor({
      executionProfileId: profileId,
      allowedCliTools: ['claude', 'codex', 'antigravity'],
      requireDelegationWorkerIsolation: true,
    });
    expect(result.status).toBe('no_candidates');
    expect(result.evaluations).toEqual([
      expect.objectContaining({ cliTool: 'raw-shell', status: 'invalid', reason: expect.stringContaining('not allowed') }),
    ]);
  });

  it('skips unsupported AI providers and selects the next proven-isolated candidate', async () => {
    const codex = queries.addModel('codex', 'gpt-test', 'Codex Test');
    const antigravity = queries.addModel('antigravity', 'agy-test', 'Antigravity Test');
    const claude = queries.addModel('claude', 'claude-test', 'Claude Test');
    const pool = new ExecutorPool();
    const profileId = profileWith([
      { modelId: codex.id, priority: 1 },
      { modelId: antigravity.id, priority: 2 },
      { modelId: claude.id, priority: 3 },
    ]);
    const result = await pool.selectExecutor({
      executionProfileId: profileId,
      allowedCliTools: ['claude', 'codex', 'antigravity'],
      requireDelegationWorkerIsolation: true,
    });
    expect(result.status).toBe('selected');
    expect(result.selectedConfig?.cliTool).toBe('claude');
    expect(result.evaluations.slice(0, 2)).toEqual([
      expect.objectContaining({ cliTool: 'codex', status: 'unsupported', reason: expect.stringContaining('unsupported for Delegation Worker isolation') }),
      expect.objectContaining({ cliTool: 'antigravity', status: 'unsupported', reason: expect.stringContaining('unsupported for Delegation Worker isolation') }),
    ]);
  });

  it('publishes a truthful provider isolation capability matrix', () => {
    expect(getDelegationWorkerIsolationCapability('claude')).toMatchObject({ proven: true, strategy: 'tools_disabled' });
    expect(getDelegationWorkerIsolationCapability('codex')).toMatchObject({ proven: false, strategy: 'unsupported' });
    expect(getDelegationWorkerIsolationCapability('antigravity')).toMatchObject({ proven: false, strategy: 'unsupported' });
    expect(getDelegationWorkerIsolationCapability('raw-shell')).toBeNull();
  });

  it('revalidates a profile changed after settings were saved', async () => {
    const codex = queries.addModel('codex', 'gpt-test', 'GPT Test');
    const profileId = profileWith([{ modelId: codex.id, priority: 1 }]);
    updateDelegationSettings({ workerExecutionProfileId: profileId });
    testDb.prepare("UPDATE execution_profile_executors SET cli_model_id = 'raw-model' WHERE profile_id = ?").run(profileId);
    const result = await new ExecutorPool().selectExecutor({
      executionProfileId: profileId,
      allowedCliTools: ['claude', 'codex', 'antigravity'],
    });
    expect(result.status).toBe('no_candidates');
    expect(result.evaluations[0]).toMatchObject({ cliTool: 'raw-shell', status: 'invalid' });
  });

  it('reports a valid but busy provider as unavailable for immediate delegation', async () => {
    const codex = queries.addModel('codex', 'gpt-busy', 'GPT Busy');
    const profileId = profileWith([{ modelId: codex.id, priority: 1 }]);
    const pool = new ExecutorPool();
    pool.setLimit('codex', 0);
    const result = await pool.selectExecutor({
      executionProfileId: profileId,
      allowedCliTools: ['claude', 'codex', 'antigravity'],
    });
    expect(result.status).toBe('waiting_executor');
    expect(result.evaluations[0]).toMatchObject({ cliTool: 'codex', status: 'busy' });
  });
});
