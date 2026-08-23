import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { type Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, normalizeAntigravityCatalogAndExecutors } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { resolveExecutionConfig, executionSnapshot } = await import('../execution-config.js');
const { parseAntigravityModels, discoverAntigravity, refreshModelCatalog } = await import('../model-sync.js');
const { getAdapter, resolveExecutionModel } = await import('../cli-adapters.js');
const executionProfilesRoute = (await import('../../routes/execution-profiles.js')).default;
const modelsRoute = (await import('../../routes/models.js')).default;

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

describe('Antigravity model discovery, representation, resolution, and migration', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testDb.close();
  });

  it('1. groups sibling variants into canonical models and keeps singletons un-grouped', () => {
    const rawStdout = `gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)
gemini-3.5-flash-high     Gemini 3.5 Flash (High)
gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)
gemini-3.5-flash-low      Gemini 3.5 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)`;

    const models = parseAntigravityModels(rawStdout);
    expect(models).toHaveLength(7);

    const flash37 = models.find((m) => m.value === 'gemini-3.7-flash')!;
    expect(flash37).toBeDefined();
    expect(flash37.label).toBe('Gemini 3.7 Flash');
    expect(flash37.supportedEfforts).toEqual(['low', 'medium', 'high']);
    expect(flash37.providerVariants).toEqual({
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
    });

    const pro31 = models.find((m) => m.value === 'gemini-3.1-pro')!;
    expect(pro31).toBeDefined();
    expect(pro31.label).toBe('Gemini 3.1 Pro');
    expect(pro31.supportedEfforts).toEqual(['low', 'high']);
    expect(pro31.providerVariants).toEqual({
      low: 'gemini-3.1-pro-low',
      high: 'gemini-3.1-pro-high',
    });

    const gptOss = models.find((m) => m.value === 'gpt-oss-120b-medium')!;
    expect(gptOss).toBeDefined();
    expect(gptOss.label).toBe('GPT-OSS 120B (Medium)');
    expect(gptOss.supportedEfforts).toBeNull();
    expect(gptOss.providerVariants).toBeNull();

    const sonnet = models.find((m) => m.value === 'claude-sonnet-4-6')!;
    expect(sonnet).toBeDefined();
    expect(sonnet.supportedEfforts).toBeNull();
    expect(sonnet.providerVariants).toBeNull();
  });

  it('2. uses agy models without invalid json flags, and fallback never marks catalog missing', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const mockRun = vi.fn().mockResolvedValueOnce({
      stdout: 'gemini-3.7-flash-high  Gemini 3.7 Flash (High)\ngemini-3.7-flash-low   Gemini 3.7 Flash (Low)',
      stderr: '',
      exitCode: 0,
      timeout: false,
    });

    const result = await discoverAntigravity(mockRun);
    expect(mockRun).toHaveBeenCalledWith('agy', ['models']);
    expect(result?.models).toHaveLength(1);
    expect(result?.models[0].value).toBe('gemini-3.7-flash');

    queries.addModel('antigravity', 'existing-model', 'Existing Model');

    const fallbackResult = await refreshModelCatalog('antigravity', {
      discover: async () => ({
        models: [{ value: 'fallback-model', label: 'Fallback Model', supportedEfforts: null }],
        source: 'antigravity-model-command',
        authoritative: false,
        primarySucceeded: false,
      }),
    });

    expect(fallbackResult.markedMissing).toBe(0);
    expect(queries.getModelByValue('antigravity', 'existing-model')?.status).toBe('available');
    expect(queries.getModelByValue('antigravity', 'fallback-model')?.status).toBe('available');
  });

  it('3. persistently stores provider_variants JSON across DB refresh and model updates', async () => {
    const rawStdout = 'gemini-3.7-flash-high  Gemini 3.7 Flash (High)\ngemini-3.7-flash-low   Gemini 3.7 Flash (Low)';
    await refreshModelCatalog('antigravity', {
      discover: async () => ({
        models: parseAntigravityModels(rawStdout),
        source: 'antigravity-models',
        authoritative: true,
        primarySucceeded: true,
      }),
    });

    const stored = queries.getModelByValue('antigravity', 'gemini-3.7-flash');
    expect(stored).toBeDefined();
    expect(stored?.provider_variants).toBe(JSON.stringify({ low: 'gemini-3.7-flash-low', high: 'gemini-3.7-flash-high' }));

    queries.updateModel(stored!.id, { model_label: 'Custom Flash Label' });
    const updated = queries.getModelById(stored!.id);
    expect(updated?.model_label).toBe('Custom Flash Label');
    expect(updated?.provider_variants).toBe(JSON.stringify({ low: 'gemini-3.7-flash-low', high: 'gemini-3.7-flash-high' }));
  });

  it('4. resolves execution config correctly for canonical Antigravity models', () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    expect(() => resolveExecutionConfig({
      cliTool: 'antigravity',
      cliModelId: model.id,
      cliEffort: null,
    })).toThrow(/requires an explicit effort selection/);

    const validConfig = resolveExecutionConfig({
      cliTool: 'antigravity',
      cliModelId: model.id,
      cliEffort: 'medium',
    });

    expect(validConfig).toMatchObject({
      cliTool: 'antigravity',
      source: 'manual',
      cliModelId: model.id,
      requestedModel: 'gemini-3.7-flash',
      model: 'gemini-3.7-flash',
      modelAvailability: 'available',
      effort: {
        nativeEffort: 'medium',
        supportedEfforts: ['low', 'medium', 'high'],
        resolution: 'exact',
      },
    });
  });

  it('5. creates a frozen executionSnapshot with canonical model and effort', () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    const profile = queries.createExecutionProfile({
      slug: 'flash-profile',
      name: 'Flash Profile',
      description: '',
      executors: [{ cli_model_id: model.id, effort_value: 'high', priority: 0 }],
    });

    const config = resolveExecutionConfig({ executionProfileId: profile.id });
    const snapshot = executionSnapshot(config);

    expect(snapshot).toMatchObject({
      configuration: 'profile',
      profileSlug: 'flash-profile',
      agent: 'antigravity',
      cliModelId: model.id,
    });
    expect(snapshot.model).toBe('gemini-3.7-flash');
    expect(snapshot.effort).toBe('high');
  });

  it('6. translates canonical model + effort to provider slug without --effort flag in buildArgs', () => {
    queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    const adapter = getAdapter('antigravity');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Task prompt',
      model: 'gemini-3.7-flash',
      effort: 'medium',
      sandboxMode: 'strict',
    });

    expect(args).toEqual(['--headless', '--model', 'gemini-3.7-flash-medium']);
    expect(args).not.toContain('--effort');
    expect(args).not.toContain('medium');
  });

  it('7. throws an informative error when a grouped Antigravity model is executed without explicit effort', () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    expect(() => resolveExecutionConfig({
      cliTool: 'antigravity',
      cliModelId: model.id,
      cliEffort: null,
    })).toThrow(/requires an explicit effort selection/);
  });

  it('8. migrates legacy sibling variant rows and reconciles profile executors idempotently', () => {
    const idHigh = uuidv4();
    const idMed = uuidv4();
    const idLow = uuidv4();

    testDb.prepare(`
      INSERT INTO cli_models (id, cli_tool, model_value, model_label, supported_efforts, sort_order, status, source)
      VALUES
        (?, 'antigravity', 'gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)', NULL, 1, 'available', 'cli'),
        (?, 'antigravity', 'gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)', NULL, 2, 'available', 'cli'),
        (?, 'antigravity', 'gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)', NULL, 3, 'available', 'cli')
    `).run(idHigh, idMed, idLow);

    const profile = queries.createExecutionProfile({
      slug: 'legacy-profile',
      name: 'Legacy Profile',
      description: '',
      executors: [{ cli_model_id: idMed, effort_value: null, priority: 0 }],
    });

    normalizeAntigravityCatalogAndExecutors(testDb);

    const canonical = queries.getModelByValue('antigravity', 'gemini-3.7-flash');
    expect(canonical).toBeDefined();
    expect(canonical?.status).toBe('available');
    expect(canonical?.model_label).toBe('Gemini 3.7 Flash');
    expect(canonical?.supported_efforts).toBe(JSON.stringify(['low', 'medium', 'high']));
    expect(canonical?.provider_variants).toBe(JSON.stringify({
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
    }));

    expect(queries.getModelById(idMed)?.status).toBe('missing');
    expect(queries.getModelById(idHigh)?.status).toBe('missing');
    expect(queries.getModelById(idLow)?.status).toBe('missing');

    const updatedProfile = queries.getExecutionProfileById(profile.id)!;
    expect(updatedProfile.executors).toHaveLength(1);
    expect(updatedProfile.executors[0].cli_model_id).toBe(canonical!.id);
    expect(updatedProfile.executors[0].effort_value).toBe('medium');

    normalizeAntigravityCatalogAndExecutors(testDb);
    const updatedProfile2 = queries.getExecutionProfileById(profile.id)!;
    expect(updatedProfile2.executors).toHaveLength(1);
    expect(updatedProfile2.executors[0].cli_model_id).toBe(canonical!.id);
    expect(updatedProfile2.executors[0].effort_value).toBe('medium');
  });

  it('9. migrates active FK references in todos, schedules, sessions, and discussion_agents without corrupting historical snapshots', () => {
    const idHigh = uuidv4();
    const idMed = uuidv4();
    testDb.prepare(`
      INSERT INTO cli_models (id, cli_tool, model_value, model_label, status, source)
      VALUES
        (?, 'antigravity', 'gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)', 'available', 'cli'),
        (?, 'antigravity', 'gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)', 'available', 'cli')
    `).run(idHigh, idMed);

    const project = queries.createProject('Test Project', 'C:/test-project');
    const schedule = queries.createSchedule(project.id, 'Sched', '', '* * * * *', 'antigravity', 'gemini-3.6-flash-high', 1, 'recurring', undefined, null, null, null, null, null, null, null, idHigh);
    const agent = queries.createDiscussionAgent(project.id, 'Agent', 'role', 'prompt', 'antigravity', 'gemini-3.6-flash-medium', undefined, false, undefined, undefined, idMed);
    const todo = queries.createTodo(project.id, 'Task', undefined, 0, 'antigravity', 'gemini-3.6-flash-high', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, undefined, idHigh);
    const session = queries.createSession(project.id, 'Session', undefined, 'antigravity', 'gemini-3.6-flash-medium', undefined, null, null, null, null, undefined, undefined, idMed);

    normalizeAntigravityCatalogAndExecutors(testDb);

    const canonical = queries.getModelByValue('antigravity', 'gemini-3.6-flash')!;
    expect(queries.getScheduleById(schedule.id)?.cli_model_id).toBe(canonical.id);
    expect(queries.getScheduleById(schedule.id)?.cli_effort).toBe('high');

    expect(queries.getDiscussionAgentsByProjectId(project.id)[0].cli_model_id).toBe(canonical.id);
    expect(queries.getDiscussionAgentsByProjectId(project.id)[0].cli_effort).toBe('medium');

    expect(queries.getTodoById(todo.id)?.cli_model_id).toBe(canonical.id);
    expect(queries.getTodoById(todo.id)?.cli_effort).toBe('high');

    expect(queries.getSessionById(session.id)?.cli_model_id).toBe(canonical.id);
    expect(queries.getSessionById(session.id)?.cli_effort).toBe('medium');
  });

  it('10. roundtrips canonical models and execution profiles through HTTP API endpoints', async () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    const modelsRes = await apiRequest(modelsRoute, '/models');
    expect(modelsRes.status).toBe(200);
    const antigravityModels = modelsRes.body.antigravity as Array<{ id: string; value: string; providerVariants: Record<string, string> }>;
    const apiModel = antigravityModels.find((m) => m.value === 'gemini-3.7-flash')!;
    expect(apiModel.providerVariants).toEqual({
      low: 'gemini-3.7-flash-low',
      medium: 'gemini-3.7-flash-medium',
      high: 'gemini-3.7-flash-high',
    });

    const createRes = await apiRequest(executionProfilesRoute, '/execution-profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'API Flash Profile',
        description: 'Testing API',
        executors: [
          { cliModelId: model.id, effortValue: 'medium', priority: 0, isEnabled: true },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      name: 'API Flash Profile',
      executors: [
        {
          cliModelId: model.id,
          modelValue: 'gemini-3.7-flash',
          effortValue: 'medium',
          providerVariants: {
            low: 'gemini-3.7-flash-low',
            medium: 'gemini-3.7-flash-medium',
            high: 'gemini-3.7-flash-high',
          },
        },
      ],
    });
  });
});
