import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));

const { delegationDefaults, getDelegationSettings, updateDelegationSettings } = await import('./settings.js');
const queries = await import('../db/queries.js');

describe('delegation settings', () => {
  beforeEach(() => { testDb = new Database(':memory:'); initDatabase(testDb); });
  afterEach(() => testDb.close());

  it('defaults disabled with telemetry as the first rollout mode', () => {
    expect(getDelegationSettings()).toEqual(delegationDefaults);
  });

  it('validates bounds and requires an existing enabled worker profile', () => {
    expect(() => updateDelegationSettings({ fullFileThresholdLines: 0 })).toThrow(/between/);
    expect(() => updateDelegationSettings({ workerExecutionProfileId: 'missing' })).toThrow(/does not exist/);
    const model = queries.addModel('codex', 'gpt-test', 'GPT Test', ['low']);
    const profile = queries.createExecutionProfile({
      slug: 'worker', name: 'Worker', description: '',
      executors: [{ cli_model_id: model.id, effort_value: 'low', priority: 1 }],
    });
    expect(updateDelegationSettings({ enabled: true, mode: 'suggest', workerExecutionProfileId: profile.id, workerTimeoutSeconds: 45 })).toMatchObject({
      enabled: true, mode: 'suggest', workerExecutionProfileId: profile.id, workerTimeoutSeconds: 45,
    });
  });

  it('rejects a raw-shell-only worker profile at the settings boundary', () => {
    testDb.pragma('ignore_check_constraints = ON');
    testDb.prepare(`INSERT INTO cli_models
      (id, cli_tool, model_value, model_label, status, source) VALUES ('raw-model', 'raw-shell', 'shell', 'Raw Shell', 'available', 'manual')`).run();
    testDb.prepare("INSERT INTO execution_profiles (id, slug, name) VALUES ('raw-profile', 'raw-worker', 'Raw Worker')").run();
    testDb.prepare(`INSERT INTO execution_profile_executors
      (id, profile_id, cli_model_id, priority) VALUES ('raw-executor', 'raw-profile', 'raw-model', 1)`).run();
    expect(() => updateDelegationSettings({ workerExecutionProfileId: 'raw-profile' })).toThrow(/Claude, Codex, or Antigravity/);
  });
});
