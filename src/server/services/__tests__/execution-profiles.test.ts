import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { resolveExecutionConfig, executionSnapshot } = await import('../execution-config.js');
const { normalizeExecutionSelection } = await import('../execution-selection.js');

describe('execution profiles', () => {
  beforeEach(() => { testDb = new Database(':memory:'); initDatabase(testDb); });
  afterEach(() => testDb.close());

  it('creates a stable-slug profile with Claude and Codex candidates', () => {
    const claude = queries.addModel('claude', 'opus', 'Opus', ['high']);
    const codex = queries.addModel('codex', 'sol', 'Sol', ['medium']);
    const profile = queries.createExecutionProfile({ slug: 'complex', name: 'Complex', description: 'Broad changes', executors: [
      { cli_model_id: claude.id, effort_value: 'high', priority: 1 },
      { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
    ] });
    queries.updateExecutionProfile(profile.id, { name: 'Complex task' });
    expect(queries.getExecutionProfileById(profile.id)).toMatchObject({ slug: 'complex', name: 'Complex task', executors: [{ cli_tool: 'claude' }, { cli_tool: 'codex' }] });
  });

  it('selects the first eligible candidate and records a snapshot', () => {
    const missing = queries.addModel('claude', 'missing-opus', 'Missing Opus', ['high']);
    const codex = queries.addModel('codex', 'sol', 'Sol', ['medium']);
    testDb.prepare("UPDATE cli_models SET status = 'missing' WHERE id = ?").run(missing.id);
    const profile = queries.createExecutionProfile({ slug: 'complex', name: 'Complex', description: '', executors: [
      { cli_model_id: missing.id, effort_value: 'high', priority: 1 },
      { cli_model_id: codex.id, effort_value: 'medium', priority: 2 },
    ] });
    const resolved = resolveExecutionConfig({ executionProfileId: profile.id });
    expect(resolved).toMatchObject({ cliTool: 'codex', model: 'sol', effort: { nativeEffort: 'medium' } });
    expect(executionSnapshot(resolved)).toMatchObject({ configuration: 'profile', profileSlug: 'complex', agent: 'codex', model: 'sol', effort: 'medium' });
  });

  it('resolves an enabled profile slug for agent-generated tasks', () => {
    const model = queries.addModel('codex', 'terra', 'Terra');
    const profile = queries.createExecutionProfile({ slug: 'simple', name: 'Simple', description: '', executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
    const project = queries.createProject('Project', 'C:/project');
    const selection = normalizeExecutionSelection({ executionProfile: 'simple' });
    const todo = queries.createTodo(project.id, 'Task', undefined, 0, undefined, undefined, undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, selection.executionProfileId);
    expect(selection.executionProfileId).toBe(profile.id);
    expect(todo.execution_profile_id).toBe(profile.id);
  });

  it('rejects deletion of a model used by a profile', () => {
    const model = queries.addModel('codex', 'sol', 'Sol');
    queries.createExecutionProfile({ slug: 'review', name: 'Review', description: '', executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
    expect(queries.getModelUsage(model.id)).toHaveLength(1);
  });

  it('fails clearly when no candidate is eligible', () => {
    const model = queries.addModel('codex', 'sol', 'Sol', ['low']);
    const profile = queries.createExecutionProfile({ slug: 'bad', name: 'Bad', description: '', executors: [{ cli_model_id: model.id, effort_value: 'max', priority: 0 }] });
    expect(() => resolveExecutionConfig({ executionProfileId: profile.id })).toThrow('has no eligible executors');
  });
});
