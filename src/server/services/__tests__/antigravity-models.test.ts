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
const todosRoute = (await import('../../routes/todos.js')).default;
const schedulesRoute = (await import('../../routes/schedules.js')).default;
const { normalizeExecutionSelection, validateAntigravityExecutionEffort, ExecutionSelectionError } = await import('../execution-selection.js');

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

  it('5. creates a frozen executionSnapshot with canonical model, effort, and effective provider slug', () => {
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
      model: 'gemini-3.7-flash',
      effectiveModel: 'gemini-3.7-flash-high',
      effort: 'high',
    });
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

  it('7. throws an informative error when a grouped Antigravity model is executed without explicit effort or with unsupported effort', () => {
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

    expect(() => resolveExecutionModel('gemini-3.7-flash', 'antigravity', true, 'xhigh'))
      .toThrow(/Effort "xhigh" is not supported for Antigravity model "gemini-3.7-flash"/);

    expect(() => getAdapter('antigravity').buildArgs({
      mode: 'headless',
      prompt: '',
      model: 'gemini-3.7-flash',
      effort: 'xhigh',
    })).toThrow(/Effort "xhigh" is not supported for Antigravity model "gemini-3.7-flash"/);
  });

  it('8. migrates legacy sibling variant rows and reconciles profile executors idempotently, marking legacy rows superseded', () => {
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

    // Superseded models have superseded_by_model_id set and are excluded from getAllModels
    expect(queries.getModelById(idMed)?.status).toBe('missing');
    expect(queries.getModelById(idMed)?.superseded_by_model_id).toBe(canonical!.id);
    expect(queries.getModelById(idHigh)?.status).toBe('missing');
    expect(queries.getModelById(idHigh)?.superseded_by_model_id).toBe(canonical!.id);
    expect(queries.getModelById(idLow)?.status).toBe('missing');
    expect(queries.getModelById(idLow)?.superseded_by_model_id).toBe(canonical!.id);

    const allModels = queries.getAllModels();
    expect(allModels.antigravity?.map((m) => m.model_value)).toEqual(['gemini-3.7-flash']);

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

  it('9. migrates active references in todos, schedules, sessions, and discussion_agents with NULL cli_model_id', () => {
    const idHigh = uuidv4();
    const idMed = uuidv4();
    testDb.prepare(`
      INSERT INTO cli_models (id, cli_tool, model_value, model_label, status, source)
      VALUES
        (?, 'antigravity', 'gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)', 'available', 'cli'),
        (?, 'antigravity', 'gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)', 'available', 'cli')
    `).run(idHigh, idMed);

    const project = queries.createProject('Test Project', 'C:/test-project');
    const schedule = queries.createSchedule(project.id, 'Sched', '', '* * * * *', 'antigravity', 'gemini-3.6-flash-high', 1, 'recurring', undefined, null, null, null, null, null, null, null, null);
    const agent = queries.createDiscussionAgent(project.id, 'Agent', 'role', 'prompt', 'antigravity', 'gemini-3.6-flash-medium', undefined, false, undefined, undefined, null);
    const todo = queries.createTodo(project.id, 'Task', undefined, 0, 'antigravity', 'gemini-3.6-flash-high', undefined, undefined, undefined, null, undefined, undefined, undefined, undefined, undefined, undefined, null);
    const session = queries.createSession(project.id, 'Session', undefined, 'antigravity', 'gemini-3.6-flash-medium', undefined, null, null, null, null, undefined, undefined, null);

    normalizeAntigravityCatalogAndExecutors(testDb);

    const canonical = queries.getModelByValue('antigravity', 'gemini-3.6-flash')!;
    expect(queries.getScheduleById(schedule.id)?.cli_model_id).toBe(canonical.id);
    expect(queries.getScheduleById(schedule.id)?.cli_model).toBe('gemini-3.6-flash');
    expect(queries.getScheduleById(schedule.id)?.cli_effort).toBe('high');

    expect(queries.getDiscussionAgentsByProjectId(project.id)[0].cli_model_id).toBe(canonical.id);
    expect(queries.getDiscussionAgentsByProjectId(project.id)[0].cli_model).toBe('gemini-3.6-flash');
    expect(queries.getDiscussionAgentsByProjectId(project.id)[0].cli_effort).toBe('medium');

    expect(queries.getTodoById(todo.id)?.cli_model_id).toBe(canonical.id);
    expect(queries.getTodoById(todo.id)?.cli_model).toBe('gemini-3.6-flash');
    expect(queries.getTodoById(todo.id)?.cli_effort).toBe('high');

    expect(queries.getSessionById(session.id)?.cli_model_id).toBe(canonical.id);
    expect(queries.getSessionById(session.id)?.cli_model).toBe('gemini-3.6-flash');
    expect(queries.getSessionById(session.id)?.cli_effort).toBe('medium');
  });

  it('10. roundtrips canonical models and execution profiles through HTTP API endpoints and rejects invalid efforts', async () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    // Reject creating profile with grouped Antigravity model and Provider Default (effortValue = null)
    const badProfileRes = await apiRequest(executionProfilesRoute, '/execution-profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Bad Profile',
        description: 'Testing',
        executors: [{ cliModelId: model.id, effortValue: null, priority: 0, isEnabled: true }],
      }),
    });
    expect(badProfileRes.status).toBe(400);

    // Reject creating profile with unsupported effort
    const invalidEffortProfileRes = await apiRequest(executionProfilesRoute, '/execution-profiles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Invalid Effort Profile',
        description: 'Testing',
        executors: [{ cliModelId: model.id, effortValue: 'xhigh', priority: 0, isEnabled: true }],
      }),
    });
    expect(invalidEffortProfileRes.status).toBe(400);

    // Reject updating model with unmapped supported effort
    const badModelPatchRes = await apiRequest(modelsRoute, `/models/${model.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
      }),
    });
    expect(badModelPatchRes.status).toBe(400);

    // Create execution profile via API with valid effort
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

  it('11. passes --effort for manual/ungrouped Antigravity models and updates variants on label-only edit', async () => {
    // Manual/ungrouped Antigravity model passes --effort if specified
    const custom = queries.addModel('antigravity', 'custom-model', 'Custom Model', ['low', 'medium']);
    const adapter = getAdapter('antigravity');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: '',
      model: 'custom-model',
      effort: 'medium',
      sandboxMode: 'strict',
    });
    expect(args).toEqual(['--headless', '--model', 'custom-model', '--effort', 'medium']);

    // Label-only edit preserves custom label but refresh still updates provider variants
    const rawStdout1 = 'gemini-3.5-flash-high  Gemini 3.5 Flash (High)\ngemini-3.5-flash-low   Gemini 3.5 Flash (Low)';
    await refreshModelCatalog('antigravity', {
      discover: async () => ({
        models: parseAntigravityModels(rawStdout1),
        source: 'antigravity-models',
        authoritative: true,
        primarySucceeded: true,
      }),
    });

    const stored = queries.getModelByValue('antigravity', 'gemini-3.5-flash')!;
    queries.updateModel(stored.id, { model_label: 'My Custom Gemini 3.5 Flash' });
    expect(queries.getModelById(stored.id)?.source).toBe('manual');

    // Subsequent discovery with an additional variant updates provider_variants without overwriting custom label
    const rawStdout2 = 'gemini-3.5-flash-high  Gemini 3.5 Flash (High)\ngemini-3.5-flash-medium Gemini 3.5 Flash (Medium)\ngemini-3.5-flash-low   Gemini 3.5 Flash (Low)';
    await refreshModelCatalog('antigravity', {
      discover: async () => ({
        models: parseAntigravityModels(rawStdout2),
        source: 'antigravity-models',
        authoritative: true,
        primarySucceeded: true,
      }),
    });

    const refreshed = queries.getModelById(stored.id)!;
    expect(refreshed.model_label).toBe('My Custom Gemini 3.5 Flash');
    expect(refreshed.supported_efforts).toBe(JSON.stringify(['low', 'medium', 'high']));
    expect(refreshed.provider_variants).toBe(JSON.stringify({
      low: 'gemini-3.5-flash-low',
      medium: 'gemini-3.5-flash-medium',
      high: 'gemini-3.5-flash-high',
    }));
  });

  it('12. safely migrates an OLD database schema with CHECK (status IN (available, missing)) without column superseded_by_model_id', () => {
    // Construct a raw DB that has the exact old schema constraint
    const oldDb = new Database(':memory:');
    oldDb.exec(`
      CREATE TABLE cli_models (
        id TEXT PRIMARY KEY,
        cli_tool TEXT NOT NULL CHECK (cli_tool IN ('claude', 'codex', 'antigravity')),
        model_value TEXT NOT NULL,
        model_label TEXT NOT NULL,
        supported_efforts TEXT,
        provider_variants TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'missing')),
        source TEXT NOT NULL DEFAULT 'cli' CHECK (source IN ('cli', 'manual')),
        last_seen_at DATETIME,
        last_checked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(cli_tool, model_value)
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        cli_tool TEXT,
        cli_model TEXT,
        cli_model_id TEXT,
        cli_effort TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const idHigh = uuidv4();
    const idMed = uuidv4();
    const idLow = uuidv4();
    oldDb.prepare(`
      INSERT INTO cli_models (id, cli_tool, model_value, model_label, status, source)
      VALUES
        (?, 'antigravity', 'gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)', 'available', 'cli'),
        (?, 'antigravity', 'gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)', 'available', 'cli'),
        (?, 'antigravity', 'gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)', 'available', 'cli')
    `).run(idHigh, idMed, idLow);

    const projId = uuidv4();
    oldDb.prepare(`INSERT INTO projects (id, name, path) VALUES (?, 'Old Proj', 'C:/old')`).run(projId);
    const todoId = uuidv4();
    oldDb.prepare(`INSERT INTO todos (id, project_id, title, cli_tool, cli_model, cli_model_id) VALUES (?, ?, 'Task', 'antigravity', 'gemini-3.7-flash-high', ?)`).run(todoId, projId, idHigh);

    // Run current system migration on this old DB
    expect(() => {
      initDatabase(oldDb);
      normalizeAntigravityCatalogAndExecutors(oldDb);
    }).not.toThrow();

    // Verify canonical model was added with status='available'
    const canonical = oldDb.prepare(`SELECT * FROM cli_models WHERE cli_tool = 'antigravity' AND model_value = 'gemini-3.7-flash'`).get() as Record<string, unknown>;
    expect(canonical).toBeDefined();
    expect(canonical.status).toBe('available');
    expect(canonical.model_label).toBe('Gemini 3.7 Flash');

    // Verify legacy rows still exist, have status='missing', and point superseded_by_model_id to canonical ID
    const highRow = oldDb.prepare(`SELECT * FROM cli_models WHERE id = ?`).get(idHigh) as Record<string, unknown>;
    expect(highRow.status).toBe('missing');
    expect(highRow.superseded_by_model_id).toBe(canonical.id);

    // Verify todo FK was updated to canonical model and effort set to high
    const updatedTodo = oldDb.prepare(`SELECT * FROM todos WHERE id = ?`).get(todoId) as Record<string, unknown>;
    expect(updatedTodo.cli_model_id).toBe(canonical.id);
    expect(updatedTodo.cli_model).toBe('gemini-3.7-flash');
    expect(updatedTodo.cli_effort).toBe('high');

    oldDb.close();
  });

  it('13. centralizes model/effort validation in normalizeExecutionSelection and HTTP routes', async () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'medium', 'high'],
      { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    );

    // Invariant checks in normalizeExecutionSelection
    expect(() => normalizeExecutionSelection({ cliTool: 'antigravity', cliModelId: model.id, cliEffort: null }))
      .toThrow(ExecutionSelectionError);
    expect(() => normalizeExecutionSelection({ cliTool: 'antigravity', cliModel: 'gemini-3.7-flash', cliEffort: 'provider-default' }))
      .toThrow(ExecutionSelectionError);
    expect(() => normalizeExecutionSelection({ cliTool: 'antigravity', cliModelId: model.id, cliEffort: 'xhigh' }))
      .toThrow(ExecutionSelectionError);

    // Consistency check: supportedEfforts = ['low'], providerVariants = { low: '...', medium: '...', high: '...' }
    const modelRestricted = queries.addModel(
      'antigravity',
      'gemini-restricted',
      'Gemini Restricted',
      ['low'],
      { low: 'gemini-restricted-low', medium: 'gemini-restricted-medium' },
    );
    expect(() => normalizeExecutionSelection({ cliTool: 'antigravity', cliModelId: modelRestricted.id, cliEffort: 'medium' }))
      .toThrow(/Effort "medium" is not supported for Antigravity model/);

    const project = queries.createProject('Test Validation Project', 'C:/test-val');

    // HTTP POST /api/projects/:id/todos rejects missing or invalid effort on grouped Antigravity models with 400
    const badTodoCreate = await apiRequest(todosRoute, `/projects/${project.id}/todos`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Todo',
        cli_tool: 'antigravity',
        cli_model_id: model.id,
        cli_effort: null,
      }),
    });
    expect(badTodoCreate.status).toBe(400);

    const badTodoCreateEffort = await apiRequest(todosRoute, `/projects/${project.id}/todos`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Todo 2',
        cli_tool: 'antigravity',
        cli_model: 'gemini-3.7-flash',
        cli_effort: 'xhigh',
      }),
    });
    expect(badTodoCreateEffort.status).toBe(400);

    // Create valid todo
    const goodTodoCreate = await apiRequest(todosRoute, `/projects/${project.id}/todos`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Good Todo',
        cli_tool: 'antigravity',
        cli_model_id: model.id,
        cli_effort: 'high',
      }),
    });
    expect(goodTodoCreate.status).toBe(201);
    const todoId = (goodTodoCreate.body as { id: string }).id;

    // HTTP PUT /api/todos/:id rejects invalid effort with 400
    const badTodoUpdate = await apiRequest(todosRoute, `/todos/${todoId}`, {
      method: 'PUT',
      body: JSON.stringify({
        cli_tool: 'antigravity',
        cli_model_id: model.id,
        cli_effort: null,
      }),
    });
    expect(badTodoUpdate.status).toBe(400);

    // HTTP POST /api/projects/:id/schedules rejects invalid effort with 400
    const badScheduleCreate = await apiRequest(schedulesRoute, `/projects/${project.id}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Bad Schedule',
        cron_expression: '* * * * *',
        cli_tool: 'antigravity',
        cli_model_id: model.id,
        cli_effort: null,
      }),
    });
    expect(badScheduleCreate.status).toBe(400);

    const goodScheduleCreate = await apiRequest(schedulesRoute, `/projects/${project.id}/schedules`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Good Schedule',
        cron_expression: '* * * * *',
        cli_tool: 'antigravity',
        cli_model_id: model.id,
        cli_effort: 'medium',
      }),
    });
    expect(goodScheduleCreate.status).toBe(201);
    const schedId = (goodScheduleCreate.body as { id: string }).id;

    // HTTP PUT /api/schedules/:id rejects invalid effort with 400
    const badScheduleUpdate = await apiRequest(schedulesRoute, `/schedules/${schedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        cli_effort: 'xhigh',
      }),
    });
    expect(badScheduleUpdate.status).toBe(400);
  });

  it('14. guarantees execution snapshot and actual spawn use the exact same frozen effective model resolution even if catalog mutates', () => {
    const model = queries.addModel(
      'antigravity',
      'gemini-3.7-flash',
      'Gemini 3.7 Flash',
      ['low', 'high'],
      { low: 'gemini-3.7-flash-low', high: 'gemini-3.7-flash-high' },
    );

    // Resolve execution config
    const config = resolveExecutionConfig({
      cliTool: 'antigravity',
      cliModelId: model.id,
      cliEffort: 'high',
    });

    const snapshot = executionSnapshot(config);
    expect(snapshot.model).toBe('gemini-3.7-flash');
    expect(snapshot.effectiveModel).toBe('gemini-3.7-flash-high');
    expect(snapshot.effort).toBe('high');

    // Simulate catalog mutating in DB after resolveExecutionConfig but before spawn
    queries.updateModel(model.id, {
      provider_variants: { low: 'gemini-3.7-flash-low', high: 'gemini-3.7-flash-mutated-afterwards' },
    });

    // Spawn uses the frozen resolution (effectiveModel) from executionConfig
    const launchModel = config.effectiveModel ?? config.model;
    const launchEffort = (config.effectiveModel && config.effectiveModel !== config.model)
      ? undefined
      : config.effort.nativeEffort;

    const adapter = getAdapter('antigravity');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Task prompt',
      model: launchModel,
      effort: launchEffort,
      sandboxMode: 'strict',
    });

    // Actual CLI args match snapshot.effectiveModel and do not produce conflicting --effort
    expect(args).toEqual(['--headless', '--model', 'gemini-3.7-flash-high']);
    expect(args).not.toContain('gemini-3.7-flash-mutated-afterwards');
    expect(args).not.toContain('--effort');
  });
});
