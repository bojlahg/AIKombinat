import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { type Router } from 'express';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { resolveExecutionConfig, executionSnapshot } = await import('../execution-config.js');
const { normalizeExecutionSelection } = await import('../execution-selection.js');
const executionProfilesModule = await import('../../routes/execution-profiles.js');
const { executorInput } = executionProfilesModule;
const modelsRoute = (await import('../../routes/models.js')).default;
const { DiscussionOrchestrator } = await import('../discussion-orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const cliStatusModule = await import('../cli-status.js');

async function apiRequest(router: Router, path: string, init: RequestInit = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not start');
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      headers: { 'Content-Type': 'application/json' }, ...init,
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('execution profiles', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
    cliStatusModule.clearCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cliStatusModule.clearCache();
    testDb.close();
  });

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

  it('generates collision-safe slugs from the profile name and keeps them stable', async () => {
    const create = () => apiRequest(executionProfilesModule.default, '/execution-profiles', {
      method: 'POST', body: JSON.stringify({ name: 'Complex Work', description: 'Planning guidance', executors: [] }),
    });
    const first = await create();
    const second = await create();
    expect(first.body).toMatchObject({ name: 'Complex Work', slug: 'complex-work' });
    expect(second.body).toMatchObject({ name: 'Complex Work', slug: 'complex-work-2' });
    const id = first.body.id as string;
    const renamed = await apiRequest(executionProfilesModule.default, `/execution-profiles/${id}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed Work' }),
    });
    expect(renamed.body).toMatchObject({ name: 'Renamed Work', slug: 'complex-work' });
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
    expect(queries.getModelUsage(model.id)).toMatchObject({ execution_profiles: 1 });
  });

  it('persists model order through the models API without changing discovery ownership', async () => {
    const first = queries.addModel('codex', 'first', 'First');
    const second = queries.addModel('codex', 'second', 'Second');
    testDb.prepare("UPDATE cli_models SET source = 'cli' WHERE id IN (?, ?)").run(first.id, second.id);

    expect((await apiRequest(modelsRoute, `/models/${first.id}`, {
      method: 'PATCH', body: JSON.stringify({ sortOrder: 1 }),
    })).status).toBe(200);
    expect((await apiRequest(modelsRoute, `/models/${second.id}`, {
      method: 'PATCH', body: JSON.stringify({ sortOrder: 0 }),
    })).status).toBe(200);

    const response = await apiRequest(modelsRoute, '/models');
    const models = response.body.codex as Array<{ value: string }>;
    expect(models.map((model) => model.value)).toEqual(['second', 'first']);
    expect(queries.getModelById(first.id)).toMatchObject({ sort_order: 1, source: 'cli' });
  });

  it('fails clearly when no candidate is eligible', () => {
    const model = queries.addModel('codex', 'sol', 'Sol', ['low']);
    const profile = queries.createExecutionProfile({ slug: 'bad', name: 'Bad', description: '', executors: [{ cli_model_id: model.id, effort_value: 'max', priority: 0 }] });
    expect(() => resolveExecutionConfig({ executionProfileId: profile.id })).toThrow('has no eligible executors');
  });

  it.each(['Todo', 'Session', 'Discussion Agent'])('%s resolves its profile before a raw-shell project default', (_context) => {
    const model = queries.addModel('codex', 'sol', 'Sol', ['high']);
    const profile = queries.createExecutionProfile({ slug: `raw-${_context.toLowerCase().replace(/\s/g, '-')}`, name: _context, description: '', executors: [
      { cli_model_id: model.id, effort_value: 'high', priority: 0 },
    ] });
    expect(resolveExecutionConfig({ cliTool: 'raw-shell', executionProfileId: profile.id, interactive: _context === 'Session' })).toMatchObject({ cliTool: 'codex', source: 'profile' });
  });

  it('preserves a saved unsupported effort on edit while keeping the candidate ineligible', () => {
    const model = queries.addModel('codex', 'sol', 'Sol', ['low', 'medium', 'high', 'xhigh']);
    const profile = queries.createExecutionProfile({ slug: 'legacy-effort', name: 'Legacy effort', description: 'before', executors: [
      { cli_model_id: model.id, effort_value: 'xhigh', priority: 0 },
    ] });
    queries.updateModel(model.id, { supported_efforts: ['low', 'medium', 'high'] });
    const executors = executorInput(profile.executors.map((executor) => ({
      id: executor.id, cliModelId: executor.cli_model_id, effortValue: executor.effort_value, priority: executor.priority, isEnabled: true,
    })));
    queries.updateExecutionProfile(profile.id, { description: 'after', executors });
    expect(queries.getExecutionProfileById(profile.id)).toMatchObject({ description: 'after', executors: [{ effort_value: 'xhigh' }] });
    expect(() => resolveExecutionConfig({ executionProfileId: profile.id })).toThrow('has no eligible executors');
  });

  it('PATCH preserves a previously saved effort after capabilities stop supporting it', async () => {
    const model = queries.addModel('codex', 'api-sol', 'API Sol', ['low', 'medium', 'high', 'xhigh']);
    const profile = queries.createExecutionProfile({ slug: 'api-legacy-effort', name: 'API legacy effort', description: 'before', executors: [
      { cli_model_id: model.id, effort_value: 'xhigh', priority: 0 },
    ] });
    queries.updateModel(model.id, { supported_efforts: ['low', 'medium', 'high'] });
    const response = await apiRequest(executionProfilesModule.default, `/execution-profiles/${profile.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: 'after', executors: [{ id: profile.executors[0].id, cliModelId: model.id, effortValue: 'xhigh', priority: 0, isEnabled: true }] }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ description: 'after', executors: [{ effortValue: 'xhigh' }] });
    expect(() => resolveExecutionConfig({ executionProfileId: profile.id })).toThrow('has no eligible executors');
  });

  it.each(['Todo', 'Session', 'Discussion Agent'])('%s refuses to start with a disabled profile', (_context) => {
    const model = queries.addModel('codex', 'terra', 'Terra');
    const profile = queries.createExecutionProfile({ slug: `disabled-${_context.toLowerCase().replace(/\s/g, '-')}`, name: `${_context} disabled`, description: '', executors: [
      { cli_model_id: model.id, effort_value: null, priority: 0 },
    ] });
    queries.updateExecutionProfile(profile.id, { is_enabled: 0 });
    expect(() => resolveExecutionConfig({ cliTool: 'raw-shell', executionProfileId: profile.id, interactive: _context === 'Session' }))
      .toThrow(`Execution profile "${_context} disabled" is disabled.`);
  });

  it('uses the profile-resolved Codex tool for Discussion output handling', async () => {
    const model = queries.addModel('codex', 'discussion-sol', 'Discussion Sol');
    const profile = queries.createExecutionProfile({ slug: 'discussion-codex', name: 'Discussion Codex', description: '', executors: [
      { cli_model_id: model.id, effort_value: null, priority: 0 },
    ] });
    const project = queries.createProject('Discussion project', 'C:/discussion-project');
    const agent = queries.createDiscussionAgent(project.id, 'Reviewer', 'reviewer', 'Review carefully', 'claude', undefined, undefined, false, profile.id);
    const discussion = queries.createDiscussion(project.id, 'Review', 'Review the change', [agent.id, 'second-agent']);
    queries.updateDiscussion(discussion.id, { worktree_path: project.path });
    const message = queries.createDiscussionMessage(discussion.id, agent.id, 1, 0, agent.role, agent.name);
    const orchestrator = new DiscussionOrchestrator();
    const outputSpy = vi.spyOn(orchestrator as never, 'streamToDiscussionDb').mockReturnValue([]);
    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));
    vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({
      pid: 123, stdout: new PassThrough(), stderr: new PassThrough(), stdin: null,
      exitPromise: new Promise<number>(() => undefined), command: 'codex', args: [],
    });
    await (orchestrator as unknown as { runAgentTurn(discussionId: string, messageId: string): Promise<void> }).runAgentTurn(discussion.id, message.id);
    expect(outputSpy).toHaveBeenCalledWith(discussion.id, message.id, agent.name, expect.anything(), expect.anything(), 'codex');
  });

  it('reports every direct model usage before deletion', () => {
    const model = queries.addModel('codex', 'shared', 'Shared');
    const project = queries.createProject('Usage project', 'C:/usage-project');
    testDb.prepare('INSERT INTO todos (id, project_id, title, cli_model_id) VALUES (?, ?, ?, ?)').run('todo-use', project.id, 'Todo', model.id);
    testDb.prepare('INSERT INTO schedules (id, project_id, title, cron_expression, cli_model_id) VALUES (?, ?, ?, ?, ?)').run('schedule-use', project.id, 'Schedule', '* * * * *', model.id);
    testDb.prepare('INSERT INTO sessions (id, project_id, title, cli_model_id) VALUES (?, ?, ?, ?)').run('session-use', project.id, 'Session', model.id);
    testDb.prepare('INSERT INTO discussion_agents (id, project_id, name, role, system_prompt, cli_model_id) VALUES (?, ?, ?, ?, ?, ?)').run('agent-use', project.id, 'Agent', 'role', 'prompt', model.id);
    expect(queries.getModelUsage(model.id)).toMatchObject({
      execution_profiles: 0, todos: 1, schedules: 1, sessions: 1, discussion_agents: 1,
    });
  });

  it('DELETE model returns 409 with structured counts for direct usages', async () => {
    const model = queries.addModel('codex', 'delete-shared', 'Delete shared');
    const project = queries.createProject('Delete usage project', 'C:/delete-usage-project');
    testDb.prepare('INSERT INTO todos (id, project_id, title, cli_model_id) VALUES (?, ?, ?, ?)').run('delete-todo-use', project.id, 'Todo', model.id);
    testDb.prepare('INSERT INTO sessions (id, project_id, title, cli_model_id) VALUES (?, ?, ?, ?)').run('delete-session-use', project.id, 'Session', model.id);
    const response = await apiRequest(modelsRoute, `/models/${model.id}`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ usageCount: 2, usage: { todos: 1, sessions: 1, schedules: 0, discussion_agents: 0, execution_profiles: 0 } });
    expect(queries.getModelById(model.id)).toBeTruthy();
  });
});
