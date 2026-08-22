import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const effort = await import('../effort-profiles.js');

describe('agent effort profiles', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
  });
  afterEach(() => testDb.close());

  it('seeds the exact three recommended profiles', () => {
    expect(effort.getProfiles()).toMatchObject([
      { cliTool: 'claude', defaultLevel: 3, mapping: { 1: 'low', 2: 'medium', 3: 'high', 4: 'xhigh', 5: 'max' } },
      { cliTool: 'codex', defaultLevel: 2, mapping: { 1: 'low', 2: 'medium', 3: 'high', 4: 'xhigh', 5: 'max' } },
      { cliTool: 'antigravity', defaultLevel: 2, mapping: { 1: 'low', 2: 'medium', 3: 'high', 4: 'high', 5: 'high' } },
    ]);
  });

  it('updates and resets a profile', () => {
    const mapping = { 1: 'high', 2: 'low', 3: 'medium', 4: 'xhigh', 5: 'max' } as const;
    expect(effort.saveProfile('claude', 4, mapping).defaultLevel).toBe(4);
    expect(effort.getMappingWarnings(mapping)).toHaveLength(1);
    expect(effort.resetProfile('claude')).toMatchObject(effort.RECOMMENDED_PROFILES.claude);
  });

  it('rejects malformed levels and unknown native values', () => {
    expect(effort.isEffortLevel(0)).toBe(false);
    expect(effort.isEffortLevel(6)).toBe(false);
    expect(effort.validateMapping({ 1: 'low' })).toBe(false);
    expect(effort.areMappingValuesAllowed('claude', { 1: 'low', 2: 'medium', 3: 'turbo', 4: 'xhigh', 5: 'max' })).toBe(false);
  });

  it('resolves exact, clamped, below-minimum, unknown, and provider-default targets', () => {
    expect(effort.resolveExecutionEffort({ cliTool: 'codex', effortLevel: 3, supportedEfforts: ['low', 'medium', 'high'] })).toMatchObject({ nativeEffort: 'high', resolution: 'exact' });
    expect(effort.resolveExecutionEffort({ cliTool: 'codex', effortLevel: 5, supportedEfforts: ['low', 'medium', 'high', 'xhigh'] })).toMatchObject({ nativeEffort: 'xhigh', resolution: 'clamped' });
    expect(effort.resolveExecutionEffort({ cliTool: 'claude', effortLevel: 4, supportedEfforts: ['low', 'medium', 'high', 'max'] })).toMatchObject({ nativeEffort: 'high', resolution: 'clamped' });
    expect(effort.resolveExecutionEffort({ cliTool: 'codex', effortLevel: 1, supportedEfforts: ['medium', 'high'] })).toMatchObject({ nativeEffort: 'medium', resolution: 'clamped' });
    expect(effort.resolveExecutionEffort({ cliTool: 'claude', effortLevel: 5, supportedEfforts: null })).toMatchObject({ nativeEffort: 'max', resolution: 'capability-unknown' });

    const profile = effort.getProfile('claude');
    effort.saveProfile('claude', profile.defaultLevel, { ...profile.mapping, 2: 'provider-default' });
    expect(effort.resolveExecutionEffort({ cliTool: 'claude', effortLevel: 2 })).toMatchObject({ nativeEffort: undefined, resolution: 'provider-default' });
  });

  it('preserves legacy null and supports project/task precedence', () => {
    expect(effort.resolveInheritedLevel({ recordLevel: null, projectLevel: 4, cliTool: 'claude', legacyNull: true })).toBeNull();
    expect(effort.resolveInheritedLevel({ recordLevel: 2, projectLevel: 4, cliTool: 'claude' })).toBe(2);
    expect(effort.resolveInheritedLevel({ recordLevel: null, projectLevel: 4, cliTool: 'claude' })).toBe(4);
  });
});
