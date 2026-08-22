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

  it('rejects known unsupported native effort without clamping', () => {
    testDb.prepare(`INSERT INTO cli_models (id, cli_tool, model_value, model_label, supported_efforts) VALUES ('cap', 'codex', 'gpt-cap', 'GPT Cap', ?)`)
      .run(JSON.stringify(['low', 'medium', 'high']));
    expect(() => resolveExecutionConfig({ cliTool: 'codex', model: 'gpt-cap', cliEffort: 'max' }))
      .toThrow('Effort "max" is not supported by model "gpt-cap"');
    const profile = queries.createAgentProfile('codex', 'Unsupported', 'gpt-cap', 'max');
    expect(() => resolveExecutionConfig({ cliTool: 'codex', agentProfileId: profile.id }))
      .toThrow('Effort "max" is not supported by model "gpt-cap"');
    expect(resolveExecutionConfig({ cliTool: 'codex', model: 'gpt-cap', cliEffort: 'high' })).toMatchObject({ effort: { nativeEffort: 'high', resolution: 'exact' } });
  });

  it('allows configured native effort when capabilities are unknown', () => {
    expect(resolveExecutionConfig({ cliTool: 'codex', model: 'custom-unknown', cliEffort: 'max' })).toMatchObject({ effort: { nativeEffort: 'max', resolution: 'capability-unknown' } });
    expect(resolveExecutionConfig({ cliTool: 'codex', cliEffort: 'provider-default' })).toMatchObject({ effort: { nativeEffort: undefined, resolution: 'provider-default' } });
  });

  it('does not rewrite effort when a profile model changes and pending records resolve current values', () => {
    const profile = queries.createAgentProfile('codex', 'Mutable', 'old-model', 'xhigh');
    const project = queries.createProject('pending-project', 'C:/pending-project');
    const todo = queries.createTodo(project.id, 'pending');
    queries.updateTodo(todo.id, { cli_tool: 'codex', agent_profile_id: profile.id });
    queries.updateAgentProfile(profile.id, { model_value: 'new-model' });
    expect(queries.getAgentProfileById(profile.id)).toMatchObject({ model_value: 'new-model', effort_value: 'xhigh' });
    const pending = queries.getTodoById(todo.id)!;
    expect(resolveExecutionConfig({ cliTool: pending.cli_tool as 'codex', agentProfileId: pending.agent_profile_id })).toMatchObject({ model: 'new-model', effort: { nativeEffort: 'xhigh' } });
  });

  it('rejects missing and disabled profiles and bypasses AI fields for raw shell', () => {
    expect(() => resolveExecutionConfig({ cliTool: 'codex', agentProfileId: 'missing' })).toThrow(/no longer exists/);
    const profile = queries.createAgentProfile('codex', 'Off', null, null, false);
    expect(() => resolveExecutionConfig({ cliTool: 'codex', agentProfileId: profile.id })).toThrow(/disabled/);
    expect(resolveExecutionConfig({ cliTool: 'raw-shell', model: 'ignored', cliEffort: 'max' })).toMatchObject({ cliTool: 'raw-shell', model: undefined, source: 'manual' });
  });
});
