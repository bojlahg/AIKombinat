import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough } from 'node:stream';
import { createTestWorkspace } from '../../test-utils/workspace.js';
import { initDatabase } from '../../db/schema.js';
import { OpenCodeOutputDecoder, createOpenCodeConfig, openCodePolicy } from '../opencode.js';
import { getAdapter, supportsInteractiveMode } from '../cli-adapters.js';
import { parseOpenCodeModels, discoverOpenCode, refreshModelCatalog } from '../model-sync.js';
import { classifyProviderFailure } from '../failure-classifier.js';
import { isAgentCliTool, isQuotaProviderTool } from '../provider-types.js';
import { isRecognizedAiCli } from '../../utils/cli-guard.js';
import { getDelegationWorkerIsolationCapability } from '../../delegation/worker-isolation.js';

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
const queries = await import('../../db/queries.js');
const status = await import('../cli-status.js');
const { ExecutorPool } = await import('../executor-pool.js');
const { executionSnapshot } = await import('../execution-config.js');
const { providerQuotaService } = await import('../provider-quota.js');
const { orchestrator } = await import('../orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const { reviewPipeline } = await import('../review-pipeline.js');

beforeEach(() => { db = new Database(':memory:'); initDatabase(db); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

const event = (type: string, part: unknown) => JSON.stringify({ type, part }) + '\n';

describe('OpenCode model discovery', () => {
  it('preserves exact namespaces, nested model IDs and variants, strips ANSI/noise and sorts duplicates', () => {
    expect(parseOpenCodeModels('\u001b[32mzen/model\u001b[0m\na/model#fast\nzen/model\nopenrouter/vendor/model\nWARNING hello\n/path\nbad/\n\n'))
      .toEqual(['a/model#fast', 'openrouter/vendor/model', 'zen/model'].map((value) => ({ value, label: value, supportedEfforts: [] })));
  });
  it.each(['', 'diagnostics only\n', '{"models":[]}'])('rejects suspicious empty/malformed output %s', async (stdout) => {
    const result = await discoverOpenCode(async () => ({ stdout, stderr: '', exitCode: 0, timeout: false }));
    expect(result).toMatchObject({ models: [], authoritative: false, primarySucceeded: false });
  });
  it.each([{ exitCode: 1, timeout: false }, { exitCode: null, timeout: true }])('rejects failed discovery even with valid-looking output', async (failure) => {
    expect(await discoverOpenCode(async () => ({ stdout: 'p/model\n', stderr: 'failed', ...failure })))
      .toMatchObject({ models: [], authoritative: false });
  });
  it('refreshes authoritatively, preserves manual rows and retains known-good rows after failure', async () => {
    queries.addModel('opencode', 'manual/model', 'Manual');
    const run = vi.fn(async () => ({ stdout: 'p/a\np/b\n', stderr: '', exitCode: 0, timeout: false }));
    await refreshModelCatalog('opencode', { discover: () => discoverOpenCode(run, true) });
    expect(run).toHaveBeenCalledWith('opencode', ['models', '--refresh']);
    await refreshModelCatalog('opencode', { discover: () => discoverOpenCode(async () => ({ stdout: '', stderr: '', exitCode: 0, timeout: false })) });
    expect(queries.getModelsByTool('opencode').every((m) => m.status === 'available')).toBe(true);
    await refreshModelCatalog('opencode', { discover: () => discoverOpenCode(async () => ({ stdout: 'p/a\n', stderr: '', exitCode: 0, timeout: false })) });
    expect(queries.getModelByValue('opencode', 'p/b')?.status).toBe('missing');
    expect(queries.getModelByValue('opencode', 'manual/model')?.status).toBe('available');
  });
});

describe('OpenCode migration', () => {
  it('preserves IDs, profile FKs, variants, status, manual models and indexes across repeat startup', () => {
    db.close();
    db = new Database(':memory:');
    db.exec(`CREATE TABLE cli_models (
      id TEXT PRIMARY KEY, cli_tool TEXT NOT NULL CHECK(cli_tool IN ('claude','codex','antigravity')),
      model_value TEXT NOT NULL, model_label TEXT NOT NULL, supported_efforts TEXT, provider_variants TEXT,
      sort_order INTEGER DEFAULT 0, status TEXT DEFAULT 'available', source TEXT DEFAULT 'cli',
      superseded_by_model_id TEXT REFERENCES cli_models(id), created_at DATETIME, updated_at DATETIME,
      UNIQUE(cli_tool, model_value));
      CREATE INDEX custom_model_label ON cli_models(model_label);
      CREATE TABLE execution_profiles(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, description TEXT DEFAULT '',
        is_enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at DATETIME, updated_at DATETIME);
      CREATE TABLE execution_profile_executors(id TEXT PRIMARY KEY, profile_id TEXT REFERENCES execution_profiles(id),
        cli_model_id TEXT REFERENCES cli_models(id), effort_value TEXT, priority INTEGER DEFAULT 0,
        is_enabled INTEGER DEFAULT 1, created_at DATETIME, updated_at DATETIME);
      INSERT INTO cli_models VALUES ('m', 'codex', 'model', 'Manual', '["high"]', '{"high":"model-high"}', 7, 'missing', 'manual', NULL, 'before', 'before');
      INSERT INTO execution_profiles(id,slug,name) VALUES ('p','preserved','Preserved');
      INSERT INTO execution_profile_executors(id,profile_id,cli_model_id,effort_value) VALUES ('e','p','m','high');`);
    db.pragma('foreign_keys = ON');
    initDatabase(db);
    initDatabase(db);
    expect(queries.getModelById('m')).toMatchObject({ id: 'm', sort_order: 7, status: 'missing', source: 'manual',
      supported_efforts: '["high"]', provider_variants: '{"high":"model-high"}', created_at: 'before' });
    expect(queries.getExecutionProfileById('p')?.executors[0].cli_model_id).toBe('m');
    expect(() => queries.addModel('opencode', 'p/model', 'New')).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='custom_model_label'").get()).toBeDefined();
    expect(() => db.prepare("UPDATE execution_profile_executors SET cli_model_id='missing'").run()).toThrow();
  });
});

describe('OpenCode adapter and managed config', () => {
  it('passes exact ID and managed agent, uses stdin, conditionally emits standalone and rejects unsupported modes', () => {
    const adapter = getAdapter('opencode');
    const opts = { mode: 'headless' as const, prompt: 'PRIVATE PROMPT', model: 'p/model', effectiveModel: 'p/exact' };
    expect(adapter.buildArgs(opts)).toEqual(['run', '--format', 'json', '--model', 'p/exact', '--agent', 'aikombinat-build']);
    expect(adapter.buildArgs({ ...opts, opencodeStandalone: true })).toContain('--standalone');
    expect(adapter.buildArgs({ ...opts, promptPolicy: 'review' })).toContain('aikombinat-review');
    expect(adapter.buildArgs(opts).join(' ')).not.toContain(opts.prompt);
    expect(adapter.needsStdin('headless')).toBe(true);
    expect(adapter.formatStdinPrompt(opts.prompt)).toBe('PRIVATE PROMPT\n');
    expect(() => adapter.buildArgs({ ...opts, continueSession: true })).toThrow();
    expect(() => adapter.buildArgs({ ...opts, extraOptions: '--auto' })).toThrow();
    expect(() => adapter.buildArgs({ ...opts, promptPolicy: 'read-only-worker' })).toThrow();
    expect(supportsInteractiveMode('opencode')).toBe(false);
    expect(getDelegationWorkerIsolationCapability('opencode')?.proven).toBe(false);
    expect(isAgentCliTool('opencode')).toBe(true);
    expect(isQuotaProviderTool('opencode')).toBe(false);
    expect(isRecognizedAiCli('opencode.cmd')).toBe(true);
  });
  it('creates an execution-local secret-free config and cleans it up', () => {
    const managed = createOpenCodeConfig('review');
    try {
      const content = JSON.parse(fs.readFileSync(path.join(managed.directory, 'opencode.json'), 'utf8'));
      expect(content.default_agent).toBe('aikombinat-review');
      expect(managed.env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(content));
      expect(Object.keys(managed.env)).toEqual(['OPENCODE_CONFIG_CONTENT']);
      expect(content).not.toHaveProperty('provider');
      expect(content).not.toHaveProperty('prompt');
      expect(JSON.stringify(content)).not.toContain('"ask"');
      expect(content.agent['aikombinat-build'].permission.edit['*']).toBe('allow');
      expect(content.agent['aikombinat-review'].permission.edit['*']).toBe('deny');
      for (const policy of [openCodePolicy(false), openCodePolicy(true)]) {
        expect(policy.external_directory).toBe('deny');
        expect(policy.task).toBe('deny');
        expect(policy.bash['git push *']).toBe('deny');
        expect(policy.read['**/.env']).toBe('deny');
        expect(policy.question).toBe('deny');
      }
    } finally { managed.cleanup(); }
    expect(fs.existsSync(managed.directory)).toBe(false);
  });
});

describe('OpenCode output decoder', () => {
  it('handles chunk boundaries, repeated text IDs, Unicode, reasoning and missing usage', () => {
    const decoder = new OpenCodeOutputDecoder();
    const wire = Buffer.from(event('text', { id: 'a', text: 'Привет 😀' }) + event('text', { id: 'a', text: 'Привет 😀' }) + event('reasoning', { text: 'hidden' }));
    const utf8 = new StringDecoder('utf8');
    for (const byte of wire) decoder.push(utf8.write(Buffer.from([byte])));
    decoder.push(utf8.end());
    expect(decoder.finish(0)).toMatchObject({ output: 'Привет 😀', exitCode: 0, inputTokens: undefined });
  });
  it('reads real usage only when present', () => {
    const decoder = new OpenCodeOutputDecoder();
    decoder.push(event('text', { id: 'a', text: 'answer' }) + event('step_finish', { tokens: { input: 42, output: 5 } }));
    expect(decoder.finish(0)).toMatchObject({ inputTokens: 42, outputTokens: 5 });
  });
  it.each(['', event('reasoning', { text: 'hidden' }), 'not json\n', '{"type":"text"'])('fails empty or malformed successful transport', (wire) => {
    const decoder = new OpenCodeOutputDecoder(); decoder.push(wire);
    expect(decoder.finish(0).exitCode).toBe(1);
  });
  it('fails error events even after text and bounds diagnostic', () => {
    const decoder = new OpenCodeOutputDecoder();
    decoder.push(event('text', { id: 'a', text: 'partial' }) + JSON.stringify({ type: 'error', error: { message: 'quota '.repeat(500) } }) + '\n');
    const result = decoder.finish(0);
    expect(result.exitCode).toBe(1);
    expect(result.diagnostic!.length).toBeLessThanOrEqual(1000);
  });
  it('does not promote quota/rate-limit errors to harness-wide quota state', () => {
    expect(classifyProviderFailure('opencode', 1, '429 quota exceeded')).toEqual({ category: 'other', reason: 'OpenCode runtime/provider error' });
    expect(classifyProviderFailure('opencode', 1, 'Model unavailable: p/nope').reason).toBe('OpenCode model unavailable');
    expect(classifyProviderFailure('opencode', 1, 'authentication failed').category).toBe('auth_error');
    expect(providerQuotaService.getAllQuotaStates().some((quota) => (quota.tool as string) === 'opencode')).toBe(false);
  });
});

describe('OpenCode ExecutorPool', () => {
  it('passes only assistant JSON to the reviewed pipeline, excluding lifecycle logs and stderr', async () => {
    const workspace = createTestWorkspace('opencode-review-output');
    try {
      const model = queries.addModel('opencode', 'provider/model', 'OpenCode', []);
      const profile = queries.createExecutionProfile({ name: 'Review', slug: 'review', description: '',
        executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
      const project = queries.createProject('Review', workspace.path, 'main', 0);
      const todo = queries.createTodo(project.id, 'Review only', undefined, 0, undefined, undefined,
        undefined, undefined, undefined, 0, 'none', null, null, undefined, profile.id,
        null, null, null, 1, profile.id);
      reviewPipeline.ensureInitialRound(todo.id);
      db.prepare("UPDATE todo_execution_rounds SET phase = 'review', input_payload = 'Review fixture' WHERE todo_id = ?").run(todo.id);
      queries.updateTodo(todo.id, { pipeline_phase: 'review' });
      vi.spyOn(status, 'getToolStatus').mockResolvedValue({ tool: 'opencode', installed: true, usable: true, version: '1.18.33' });
      const stdout = new PassThrough(); const stderr = new PassThrough();
      let exit!: (code: number) => void;
      vi.spyOn(claudeManager, 'startClaude').mockResolvedValue({ pid: 887766, stdout, stderr, stdin: null,
        command: 'opencode', args: [], exitPromise: new Promise((resolve) => { exit = resolve; }) });
      const advance = vi.spyOn(reviewPipeline, 'advanceRoundOnSuccess').mockImplementation(async () => {
        queries.updateTodoStatus(todo.id, 'completed'); return { action: 'completed' };
      });
      await orchestrator.startTodo(todo.id);
      const json = JSON.stringify({ verdict: 'approved', summary: 'Reviewed', issues: [] });
      stdout.end(json); stderr.end('diagnostic only'); exit(0);
      await vi.waitFor(() => expect(queries.getTodoById(todo.id)?.process_pid).toBe(0));
      expect(advance).toHaveBeenCalledWith(todo.id, expect.any(String), json, expect.anything());
    } finally { workspace.cleanup(); }
  });
  it('selects profiles, preserves snapshot and waits/releases at concurrency limit without consulting quota', async () => {
    const model = queries.addModel('opencode', 'provider/exact', 'OpenCode', []);
    const profile = queries.createExecutionProfile({ name: 'OpenCode', slug: 'opencode', description: '',
      executors: [{ cli_model_id: model.id, effort_value: null, priority: 0 }] });
    vi.spyOn(status, 'getToolStatus').mockResolvedValue({ tool: 'opencode', installed: true, usable: true, version: '1.18.33' });
    const quota = vi.spyOn(providerQuotaService, 'getQuotaState');
    const pool = new ExecutorPool();
    const selected = await pool.selectExecutor({ executionProfileId: profile.id });
    expect(selected.status).toBe('selected');
    expect(executionSnapshot(selected.selectedConfig!)).toMatchObject({ agent: 'opencode', model: 'provider/exact', effectiveModel: 'provider/exact', profileId: profile.id });
    expect(pool.getLimit('opencode')).toBe(2);
    expect(pool.reserveSlot('one', 'opencode')).toBe(true);
    expect(pool.reserveSlot('two', 'opencode')).toBe(true);
    expect((await pool.selectExecutor({ executionProfileId: profile.id })).status).toBe('waiting_executor');
    pool.releaseReservation('one');
    expect((await pool.selectExecutor({ executionProfileId: profile.id })).status).toBe('selected');
    expect(quota).not.toHaveBeenCalled();
  });
});
