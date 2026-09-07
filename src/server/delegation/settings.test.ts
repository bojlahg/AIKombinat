import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));

const { delegationDefaults, getDelegationSettings, updateDelegationSettings } = await import('./settings.js');

describe('delegation settings', () => {
  beforeEach(() => { testDb = new Database(':memory:'); initDatabase(testDb); });
  afterEach(() => testDb.close());

  it('defaults disabled with telemetry as the first rollout mode', () => {
    expect(getDelegationSettings()).toEqual(delegationDefaults);
  });

  it('validates bounds and requires an existing enabled worker profile', () => {
    expect(() => updateDelegationSettings({ fullFileThresholdLines: 0 })).toThrow(/between/);
    expect(() => updateDelegationSettings({ workerExecutionProfileId: 'missing' })).toThrow(/does not exist/);
    testDb.prepare("INSERT INTO execution_profiles (id, slug, name) VALUES ('profile', 'worker', 'Worker')").run();
    expect(updateDelegationSettings({ enabled: true, mode: 'suggest', workerExecutionProfileId: 'profile', workerTimeoutSeconds: 45 })).toMatchObject({
      enabled: true, mode: 'suggest', workerExecutionProfileId: 'profile', workerTimeoutSeconds: 45,
    });
  });
});
