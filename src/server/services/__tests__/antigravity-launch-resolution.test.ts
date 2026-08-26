import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PassThrough } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import { initDatabase, normalizeAntigravityCatalogAndExecutors } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

/**
 * Double-resolution regression suite.
 *
 * Production bug: resolveExecutionConfig() correctly turned the canonical
 * Antigravity model `gemini-3.7-flash` + effort `high` into the provider slug
 * `gemini-3.7-flash-high`, but every execution caller then handed that slug
 * back to the CLI adapter as if it were a *logical* model. The adapter resolved
 * it a second time against the Model Catalog, where variant grouping had
 * deliberately marked the legacy `gemini-3.7-flash-high` row
 * `status = 'missing'` / superseded — so the turn died before `cli.spawned`
 * with "Selected antigravity model ... is unavailable."
 *
 * These tests mock only actual process spawning (the private `startWithSpawn` /
 * `startWithPty` transports). Argument construction and model resolution run
 * for real — mocking those away is what let the original bug ship green.
 */

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

// The real CLI guard fails closed in tests. These tests must reach the spawn
// boundary of a genuine AI CLI, and the transport itself is mocked below.
vi.mock('../../utils/cli-guard.js', () => ({
  assertExternalAiCliAllowed: vi.fn(),
  isTestEnvironment: () => true,
  isRecognizedAiCli: () => true,
  UNEXPECTED_CLI_LAUNCH_MESSAGE: 'mocked',
}));

vi.mock('../cli-status.js', () => ({
  getToolStatus: async (tool: string) => ({ tool, installed: true, version: '1.0.0' }),
  checkAllTools: vi.fn().mockResolvedValue([]),
  clearCache: vi.fn(),
}));

const queries = await import('../../db/queries.js');
const { resolveExecutionConfig, executionSnapshot, launchSelection } = await import('../execution-config.js');
const { claudeManager } = await import('../claude-manager.js');
const { AgentForumOrchestrator } = await import('../agent-forum-orchestrator.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { discussionOrchestrator } = await import('../discussion-orchestrator.js');
const { executorPool } = await import('../executor-pool.js');
const { getAdapter, resolveExecutionModel } = await import('../cli-adapters.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');

const CANONICAL = 'gemini-3.7-flash';
const HIGH_SLUG = 'gemini-3.7-flash-high';
const VARIANTS = {
  low: 'gemini-3.7-flash-low',
  medium: 'gemini-3.7-flash-medium',
  high: HIGH_SLUG,
};

/**
 * Reproduces the exact production catalog: three sibling variant rows collapsed
 * by the real migration into one canonical row plus legacy siblings that are
 * `missing` and superseded. Hand-writing that state would risk testing a
 * catalog shape production never actually has.
 */
function seedProductionCatalog() {
  const ids = { high: uuidv4(), medium: uuidv4(), low: uuidv4() };
  testDb.prepare(`
    INSERT INTO cli_models (id, cli_tool, model_value, model_label, supported_efforts, sort_order, status, source)
    VALUES
      (?, 'antigravity', 'gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)', NULL, 1, 'available', 'cli'),
      (?, 'antigravity', 'gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)', NULL, 2, 'available', 'cli'),
      (?, 'antigravity', 'gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)', NULL, 3, 'available', 'cli')
  `).run(ids.high, ids.medium, ids.low);

  normalizeAntigravityCatalogAndExecutors(testDb);

  const canonical = queries.getModelByValue('antigravity', CANONICAL)!;
  // Pin the DB state the rest of the suite depends on.
  expect(canonical.status).toBe('available');
  expect(JSON.parse(canonical.supported_efforts!)).toEqual(['low', 'medium', 'high']);
  expect(JSON.parse(canonical.provider_variants!)).toEqual(VARIANTS);
  const legacyHigh = queries.getModelById(ids.high)!;
  expect(legacyHigh.model_value).toBe(HIGH_SLUG);
  expect(legacyHigh.status).toBe('missing');
  expect(legacyHigh.superseded_by_model_id).toBe(canonical.id);

  return canonical;
}

/** Lets queued post-exit callbacks flush before the in-memory DB is torn down. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Replaces only the transport, recording the argv of every spawn. */
function captureSpawns() {
  const spawns: Array<{ args: string[] }> = [];
  const record = (exits: boolean) => (_adapter: unknown, args: string[]) => {
    spawns.push({ args });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    return Promise.resolve({
      pid: 4000 + spawns.length,
      stdout,
      stderr,
      stdin: new PassThrough(),
      exitPromise: exits
        ? new Promise<number>((resolve) => {
          setTimeout(() => { stdout.end(); stderr.end(); resolve(0); }, 1);
        })
        // Interactive sessions stay alive; resolving here would fire the
        // session's post-exit broadcast after the test DB is closed.
        : new Promise<number>(() => {}),
    });
  };
  vi.spyOn(claudeManager as never, 'startWithSpawn').mockImplementation(record(true) as never);
  vi.spyOn(claudeManager as never, 'startWithPty').mockImplementation(record(false) as never);
  return spawns;
}

const frozenSlugSpawns = (spawns: Array<{ args: string[] }>) =>
  spawns.filter((s) => s.args[s.args.indexOf('--model') + 1] === HIGH_SLUG);

describe('Antigravity effective-model resolution happens exactly once', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace('antigravity-launch');
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);
    executorPool.resetLimits();
    executorPool.resetReservations();
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    executorPool.resetLimits();
    executorPool.resetReservations();
    testDb.close();
    workspace.cleanup();
  });

  it('1. resolves the canonical model once and launches the frozen provider slug (exact production repro)', async () => {
    const canonical = seedProductionCatalog();

    const config = resolveExecutionConfig({
      cliTool: 'antigravity',
      cliModelId: canonical.id,
      cliEffort: 'high',
    });
    expect(config.model).toBe(CANONICAL);
    expect(config.effectiveModel).toBe(HIGH_SLUG);
    expect(config.effort.nativeEffort).toBe('high');

    const spawns = captureSpawns();
    const launch = launchSelection(config);

    // The real launch path: the frozen slug must not be re-resolved against the
    // catalog, where its legacy row is `missing` / superseded.
    const result = await claudeManager.startClaude(
      workspace.path, 'Discussion prompt', launch, undefined, 'headless', 'antigravity',
      undefined, workspace.path, 'strict', false, undefined, undefined, launch.effort, 'discussion',
    );

    expect(result.args).toEqual([
      '--sandbox',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', HIGH_SLUG,
    ]);
    expect(result.args).not.toContain('--print');
    expect(result.args).not.toContain('--headless');
    expect(result.args).not.toContain('--effort');
    expect(result.args).not.toContain('high');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].args).toEqual(result.args);
  });

  it('2. never sends the frozen slug back through logical model resolution', async () => {
    seedProductionCatalog();

    // This is the second resolution the bug performed. It is *correct* for it to
    // throw — grouping intentionally supersedes the legacy row. The fix is to
    // never take the frozen slug down this path, not to make this path lenient.
    expect(() => resolveExecutionModel(HIGH_SLUG, 'antigravity', true, 'high'))
      .toThrow(/Selected antigravity model "gemini-3.7-flash-high" is unavailable/);

    const spawns = captureSpawns();
    await claudeManager.startClaude(
      workspace.path, 'p', { model: CANONICAL, effectiveModel: HIGH_SLUG }, undefined,
      'headless', 'antigravity', undefined, workspace.path, 'strict', false,
      undefined, undefined, 'high',
    );
    expect(spawns[0].args).toContain(HIGH_SLUG);
    expect(spawns[0].args).not.toContain('--effort');
  });

  it('3. keeps --effort for singleton / custom Antigravity models where it is a real flag', async () => {
    queries.addModel('antigravity', 'custom-model', 'Custom Model', ['low', 'medium']);
    const config = resolveExecutionConfig({
      cliTool: 'antigravity',
      model: 'custom-model',
      cliEffort: 'medium',
    });
    expect(config.model).toBe('custom-model');
    expect(config.effectiveModel).toBe('custom-model');

    const spawns = captureSpawns();
    const launch = launchSelection(config);
    const result = await claudeManager.startClaude(
      workspace.path, 'p', launch, undefined, 'headless', 'antigravity',
      undefined, workspace.path, 'strict', false, undefined, undefined, launch.effort,
    );

    expect(result.args).toEqual([
      '--sandbox',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', 'custom-model',
      '--effort', 'medium',
    ]);
    expect(spawns).toHaveLength(1);
  });

  it('4. uses the frozen slug even after the catalog mutates between admission and spawn', async () => {
    const canonical = seedProductionCatalog();

    const config = resolveExecutionConfig({
      cliTool: 'antigravity',
      cliModelId: canonical.id,
      cliEffort: 'high',
    });
    expect(executionSnapshot(config).effectiveModel).toBe(HIGH_SLUG);

    // Catalog refresh lands after admission: the variant map now points `high`
    // at a different slug, and the canonical row itself leaves service.
    queries.updateModel(canonical.id, {
      provider_variants: { low: VARIANTS.low, high: 'gemini-3.7-flash-mutated-afterwards' },
    });
    testDb.prepare(`UPDATE cli_models SET status = 'missing' WHERE id = ?`).run(canonical.id);

    const spawns = captureSpawns();
    const launch = launchSelection(config);
    const result = await claudeManager.startClaude(
      workspace.path, 'p', launch, undefined, 'headless', 'antigravity',
      undefined, workspace.path, 'strict', false, undefined, undefined, launch.effort,
    );

    expect(result.args).toContain(HIGH_SLUG);
    expect(result.args).not.toContain('gemini-3.7-flash-mutated-afterwards');
    expect(result.args).not.toContain('--effort');
    expect(spawns[0].args).toEqual(result.args);
  });

  it('5. AgentForum reaches spawn with the frozen slug', async () => {
    const canonical = seedProductionCatalog();
    const forum = queries.createAgentForum('Antigravity Forum', undefined, 1024);
    for (const name of ['AgentA', 'AgentB']) {
      queries.createAgentForumMember(forum.id, name, 'architect', '', {
        cliTool: 'antigravity', cliModelId: canonical.id, cliEffort: 'high',
      });
    }
    const userMsg = queries.createAgentForumMessage(
      forum.id, 'user', null, 'User', 'User', 'Say hello.',
    );

    // The provider-edge decoder lives inside the transport being replaced, so
    // the fake transport hands back what the real decoder would have produced.
    const response = JSON.stringify({ replies: [{ replyTo: userMsg.id, content: 'Hi' }] });
    const decoder = getAdapter('antigravity').createOutputDecoder!();
    decoder.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } }) + '\n');
    const decoded = decoder.finish(0);

    const spawns: Array<{ args: string[] }> = [];
    vi.spyOn(claudeManager as never, 'startWithSpawn').mockImplementation(((
      _adapter: unknown, args: string[],
    ) => {
      spawns.push({ args });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const exitPromise = new Promise<number>((resolve) => {
        setTimeout(() => {
          stdout.write(decoded.output);
          stdout.end(); stderr.end(); resolve(decoded.exitCode);
        }, 1);
      });
      return Promise.resolve({ pid: 4100, stdout, stderr, stdin: new PassThrough(), exitPromise });
    }) as never);

    await new AgentForumOrchestrator().runCycle(forum.id);

    expect(spawns.length).toBeGreaterThan(0);
    expect(frozenSlugSpawns(spawns)).toHaveLength(spawns.length);
    for (const spawn of spawns) expect(spawn.args).not.toContain('--effort');
    expect(queries.getAgentForumMessages(forum.id).some((m) => m.content === 'Hi')).toBe(true);
  });

  it('6. Todo, Session and Discussion all reach spawn with the frozen slug', async () => {
    const canonical = seedProductionCatalog();
    const project = queries.createProject('Antigravity Project', workspace.resolvePath('agy-proj'));
    // The interactive session below holds its provider slot for the rest of the
    // test; without headroom the discussion would be queued instead of spawned.
    executorPool.setLimit('antigravity', 10);
    const spawns = captureSpawns();
    let seen = 0;
    const spawnedSince = (feature: string) => {
      const fresh = spawns.slice(seen);
      seen = spawns.length;
      expect(fresh.length, feature + ' never reached spawn').toBeGreaterThan(0);
      return fresh;
    };

    // --- Todo (orchestrator: implementation / review / rework share this path)
    const todo = queries.createTodo(
      project.id, 'Agy Task', undefined, 0, 'antigravity', undefined, undefined, undefined,
      undefined, 0, undefined, undefined, undefined, undefined, undefined, 'high', canonical.id,
    );
    await orchestrator.startTodo(todo.id);
    expect(JSON.parse(queries.getTodoById(todo.id)!.execution_snapshot!)).toMatchObject({
      model: CANONICAL, effectiveModel: HIGH_SLUG, effort: 'high',
    });
    const todoSpawns = spawnedSince('Todo');

    // --- Session (interactive / PTY transport)
    const session = queries.createSession(
      project.id, 'Agy Session', 'Desc', 'antigravity', undefined, false,
      undefined, undefined, undefined, undefined, undefined, 'high', canonical.id,
    );
    await sessionManager.startSession(session.id);
    const sessionSpawns = spawnedSince('Session');

    // --- Discussion
    const agents = ['Agy Agent A', 'Agy Agent B'].map((name) => queries.createDiscussionAgent(
      project.id, name, 'Role', 'Prompt', 'antigravity', undefined, undefined,
      false, undefined, 'high', canonical.id,
    ));
    const discussion = queries.createDiscussion(
      project.id, 'Agy Discussion', 'Desc', agents.map((a) => a.id), 1, false, undefined, 'none', null, null, 0,
    );
    await discussionOrchestrator.startDiscussion(discussion.id);
    const discussionSpawns = spawnedSince('Discussion');

    // Every feature reached a real spawn, and every one of them carried the
    // frozen provider slug rather than the logical canonical model.
    for (const spawn of [...todoSpawns, ...sessionSpawns, ...discussionSpawns]) {
      expect(spawn.args[spawn.args.indexOf('--model') + 1]).toBe(HIGH_SLUG);
      expect(spawn.args).not.toContain(CANONICAL);
      expect(spawn.args).not.toContain('--effort');
    }
    await settle();
  });
});
