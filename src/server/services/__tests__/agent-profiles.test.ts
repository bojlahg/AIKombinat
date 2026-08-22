import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));
const queries = await import('../../db/queries.js');
const { resolveExecutionConfig } = await import('../execution-config.js');

describe('named agent profiles', () => {
  beforeEach(() => { testDb = new Database(':memory:'); initDatabase(testDb); });
  afterEach(() => testDb.close());

  it('allows the same name across agents but rejects it within one agent', () => {
    queries.createAgentProfile('claude', 'Deep', null, 'high');
    queries.createAgentProfile('codex', 'Deep', null, 'xhigh');
    expect(() => queries.createAgentProfile('claude', 'Deep', null, 'low')).toThrow();
  });

  it('updates, disables, and deletes an unused profile', () => {
    const profile = queries.createAgentProfile('antigravity', 'Fast', null, 'low');
    expect(queries.updateAgentProfile(profile.id, { effort_value: 'medium', is_enabled: 0 })).toMatchObject({ effort_value: 'medium', is_enabled: 0 });
    expect(queries.deleteAgentProfile(profile.id)).toBe(true);
  });

  it('reports usage so referenced profiles cannot be silently deleted', () => {
    const profile = queries.createAgentProfile('codex', 'Review', null, 'high');
    const project = queries.createProject('test', 'C:/test');
    const todo = queries.createTodo(project.id, 'pending', undefined, 0, 'codex');
    queries.updateTodo(todo.id, { agent_profile_id: profile.id });
    expect(queries.getAgentProfileUsage(profile.id).todos).toBe(1);
  });

  it('resolves current profile values, manual defaults, mismatch warnings, and legacy effort', () => {
    const profile = queries.createAgentProfile('codex', 'Deep', null, 'xhigh');
    expect(resolveExecutionConfig({ cliTool: 'claude', agentProfileId: profile.id })).toMatchObject({ cliTool: 'codex', source: 'profile', profileName: 'Deep', model: undefined, effort: { nativeEffort: 'xhigh' } });
    expect(resolveExecutionConfig({ cliTool: 'claude', agentProfileId: profile.id }).warnings).toHaveLength(1);
    queries.updateAgentProfile(profile.id, { effort_value: 'max' });
    expect(resolveExecutionConfig({ cliTool: 'codex', agentProfileId: profile.id }).effort.nativeEffort).toBe('max');
    expect(resolveExecutionConfig({ cliTool: 'claude', cliEffort: null })).toMatchObject({ source: 'manual', model: undefined, effort: { nativeEffort: undefined } });
    expect(resolveExecutionConfig({ cliTool: 'claude', effortLevel: 3 })).toMatchObject({ source: 'legacy', effort: { requestedLevel: 3 } });
  });

  it('rejects missing and disabled profiles and bypasses AI fields for raw shell', () => {
    expect(() => resolveExecutionConfig({ cliTool: 'codex', agentProfileId: 'missing' })).toThrow(/no longer exists/);
    const profile = queries.createAgentProfile('codex', 'Off', null, null, false);
    expect(() => resolveExecutionConfig({ cliTool: 'codex', agentProfileId: profile.id })).toThrow(/disabled/);
    expect(resolveExecutionConfig({ cliTool: 'raw-shell', model: 'ignored', cliEffort: 'max' })).toMatchObject({ cliTool: 'raw-shell', model: undefined, source: 'manual' });
  });
});
