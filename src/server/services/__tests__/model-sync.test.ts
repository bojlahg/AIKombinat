import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { DOCUMENTED_CLAUDE_MODELS, discoverAntigravity, refreshModelCatalog, maybeTriggerSync, parseAntigravityModels, parseAntigravityModelEnvelope, parseCodexModelList } = await import('../model-sync.js');

const command = (stdout: string, stderr = '', exitCode: number | null = 0) => ({ stdout, stderr, exitCode });

describe('model catalog refresh', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
  });
  afterEach(() => testDb.close());

  it('forces discovery even when CLI version is unchanged', async () => {
    queries.setCliDetectedVersion('codex', '1.2.3');
    const discover = vi.fn().mockResolvedValue({
      models: [{ value: 'gpt-current', label: 'GPT Current', supportedEfforts: ['low', 'high'] }],
      source: 'codex-app-server', authoritative: true, primarySucceeded: true,
    });
    await refreshModelCatalog('codex', { version: '1.2.3', discover });
    await refreshModelCatalog('codex', { version: '1.2.3', discover });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('failed refresh retains the last good catalog', async () => {
    await refreshModelCatalog('codex', { discover: async () => ({
      models: [{ value: 'gpt-good', label: 'GPT Good', supportedEfforts: ['medium', 'high'] }],
      source: 'codex-app-server', authoritative: true, primarySucceeded: true,
    }) });
    await refreshModelCatalog('codex', { discover: async () => ({
      models: [], source: 'registry', authoritative: false, primarySucceeded: false,
    }) });
    expect(queries.getModelByValue('codex', 'gpt-good')).toMatchObject({ status: 'available', source: 'cli' });
  });

  it.each([
    ['Antigravity empty parsed output', 'antigravity', 'antigravity-models'],
    ['Codex empty model/list result', 'codex', 'codex-app-server'],
  ] as const)('%s is not an authoritative success and cannot mass-mark Missing', async (_name, tool, source) => {
    await refreshModelCatalog(tool, { discover: async () => ({
      models: [{ value: 'existing-model', label: 'Existing model' }], source, authoritative: true, primarySucceeded: true,
    }) });
    const result = await refreshModelCatalog(tool, { discover: async () => ({
      models: [], source, authoritative: true, primarySucceeded: true,
    }) });
    expect(result).toMatchObject({ authoritative: false, primarySucceeded: false, markedMissing: 0 });
    expect(queries.getModelByValue(tool, 'existing-model')).toMatchObject({ status: 'available' });
  });

  it('treats an unexpected Codex model/list schema as an empty parse', () => {
    expect(parseCodexModelList({ response: { unknown: [{ identifier: 'gpt-surprise' }] } })).toEqual([]);
  });

  it('weak discovery absence does not mark cached models unavailable', async () => {
    await refreshModelCatalog('claude', { discover: async () => ({
      models: [{ value: 'claude-old', label: 'Claude Old' }],
      source: 'claude-help', authoritative: false, primarySucceeded: true,
    }) });
    await refreshModelCatalog('claude', { discover: async () => ({
      models: [{ value: 'sonnet', label: 'Claude Sonnet' }],
      source: 'claude-help', authoritative: false, primarySucceeded: true,
    }) });
    expect(queries.getModelByValue('claude', 'claude-old')?.status).toBe('available');
    expect(queries.getModelByValue('claude', 'claude-old')?.last_seen_at).toBeTruthy();
  });

  it('authoritative discovery stores capabilities and marks absent models unavailable', async () => {
    testDb.prepare(`INSERT INTO cli_models (id, cli_tool, model_value, model_label, source, status) VALUES ('old', 'codex', 'gpt-old', 'GPT Old', 'cli', 'available')`).run();
    await refreshModelCatalog('codex', { discover: async () => ({
      models: [{ value: 'gpt-new', label: 'GPT New', supportedEfforts: ['low', 'medium', 'xhigh'] }],
      source: 'codex-app-server', authoritative: true, primarySucceeded: true,
    }) });
    expect(JSON.parse(queries.getModelByValue('codex', 'gpt-new')!.supported_efforts!)).toEqual(['low', 'medium', 'xhigh']);
    expect(queries.getModelByValue('codex', 'gpt-new')).toMatchObject({ status: 'available', source: 'cli' });
    expect(queries.getModelByValue('codex', 'gpt-old')).toMatchObject({ status: 'missing' });
  });

  it('never marks manual-only models missing and restores rediscovered CLI models', async () => {
    const manual = queries.addModel('codex', 'private', 'Private', ['high']);
    testDb.prepare(`INSERT INTO cli_models (id, cli_tool, model_value, model_label, source, status) VALUES ('old', 'codex', 'old', 'Old', 'cli', 'missing')`).run();
    const result = await refreshModelCatalog('codex', { discover: async () => ({
      models: [{ value: 'old', label: 'Old restored' }], source: 'codex-app-server', authoritative: true, primarySucceeded: true,
    }) });
    expect(queries.getModelById(manual.id)?.status).toBe('available');
    expect(queries.getModelByValue('codex', 'old')?.status).toBe('available');
    expect(result).toMatchObject({ restored: 1, markedMissing: 0 });
  });

  it('keeps installation version and model refresh timestamps independent', async () => {
    queries.setCliDetectedVersion('claude', '2.0.0');
    await refreshModelCatalog('claude', { discover: async () => ({ models: [{ value: 'sonnet', label: 'Sonnet' }], source: 'claude-alias', authoritative: false, primarySucceeded: true }) });
    const before = queries.getCliVersion('claude')!;
    await maybeTriggerSync('claude', '2.0.0');
    const after = queries.getCliVersion('claude')!;
    expect(after.last_version).toBe('2.0.0');
    expect(after.last_synced_at).toBe(before.last_synced_at);
  });

  it('parses the official Antigravity table with spaces, tabs, and ANSI sequences', () => {
    const output = '\u001b[32mgemini-3.7-flash-high\u001b[0m     Gemini 3.7 Flash (High)\n'
      + 'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n'
      + 'gemini-3.1-pro-high       Gemini 3.1 Pro (High)\n'
      + 'claude-sonnet-4-6        Claude Sonnet 4.6 (Thinking)';
    expect(parseAntigravityModels(output)).toEqual([
      { value: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)', supportedEfforts: null },
      { value: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)', supportedEfforts: null },
      { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', supportedEfforts: null },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', supportedEfforts: null },
    ]);
  });

  it('parses the Antigravity /model JSON envelope response as a text model list', () => {
    expect(parseAntigravityModelEnvelope(JSON.stringify({ status: 'SUCCESS', response: 'gemini-pro-high  Gemini Pro (High)' }))).toEqual([
      { value: 'gemini-pro-high', label: 'Gemini Pro (High)', supportedEfforts: null },
    ]);
    expect(parseAntigravityModelEnvelope('{malformed')).toBeNull();
    expect(parseAntigravityModelEnvelope(JSON.stringify({ status: 'SUCCESS', response: '' }))).toBeNull();
    expect(parseAntigravityModelEnvelope(JSON.stringify({ status: 'ERROR', response: 'gemini-pro  Gemini Pro' }))).toBeNull();
  });

  it('parses Codex capability output', () => {
    expect(parseCodexModelList({ data: [{ id: 'gpt-5', displayName: 'GPT-5', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }] })).toEqual([
      { value: 'gpt-5', label: 'GPT-5', supportedEfforts: ['medium', 'high'] },
    ]);
  });

  it('preserves manual edits to a discovered model during later refreshes', async () => {
    await refreshModelCatalog('claude', { discover: async () => ({
      models: [{ value: 'claude-opus-5', label: 'Claude Opus 5', supportedEfforts: ['high'] }],
      source: 'claude-documented', authoritative: false, primarySucceeded: true,
    }) });
    const discovered = queries.getModelByValue('claude', 'claude-opus-5')!;
    queries.updateModel(discovered.id, { model_label: 'My Opus', supported_efforts: ['xhigh'] });
    await refreshModelCatalog('claude', { discover: async () => ({
      models: [{ value: 'claude-opus-5', label: 'Changed upstream', supportedEfforts: ['low'] }],
      source: 'claude-documented', authoritative: false, primarySucceeded: true,
    }) });
    expect(queries.getModelById(discovered.id)).toMatchObject({ model_label: 'My Opus', supported_efforts: '["xhigh"]', source: 'manual' });
  });

  it('bootstraps concrete documented Claude models with known native efforts', () => {
    expect(DOCUMENTED_CLAUDE_MODELS.map((model) => model.value)).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5-20250929',
    ]);
    expect(Object.fromEntries(DOCUMENTED_CLAUDE_MODELS.map((model) => [model.value, model.supportedEfforts]))).toMatchObject({
      'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
      'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
      'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
      'claude-opus-4-5-20251101': ['low', 'medium', 'high'],
      'claude-haiku-4-5-20251001': null,
      'claude-sonnet-4-5-20250929': null,
    });
  });

  it('keeps unknown Antigravity capabilities NULL and preserves manual metadata', async () => {
    const manual = queries.addModel('antigravity', 'gemini-private', 'Private label', ['high']);
    await refreshModelCatalog('antigravity', { discover: async () => ({
      models: [{ value: 'gemini-private', label: 'Discovered label', supportedEfforts: null }, { value: 'gemini-public', label: 'Public', supportedEfforts: null }],
      source: 'antigravity-models', authoritative: false, primarySucceeded: true,
    }) });
    expect(queries.getModelById(manual.id)).toMatchObject({ model_label: 'Private label', supported_efforts: '["high"]' });
    expect(queries.getModelByValue('antigravity', 'gemini-public')?.supported_efforts).toBeNull();
  });

  it('preserves user model order across missing, restore, discovery, and manual append', async () => {
    const discover = async (values: string[]) => refreshModelCatalog('codex', { discover: async () => ({
      models: values.map((value) => ({ value, label: value.toUpperCase() })), source: 'codex-app-server', authoritative: true, primarySucceeded: true,
    }) });
    await discover(['a', 'b']);
    queries.updateModel(queries.getModelByValue('codex', 'a')!.id, { sort_order: 1 });
    queries.updateModel(queries.getModelByValue('codex', 'b')!.id, { sort_order: 0 });

    await discover(['b', 'c']);
    expect(queries.getModelsByTool('codex').map((model) => [model.model_value, model.sort_order, model.status])).toEqual([
      ['b', 0, 'available'], ['a', 1, 'missing'], ['c', 2, 'available'],
    ]);

    await discover(['a', 'b', 'c']);
    const manual = queries.addModel('codex', 'manual', 'Manual');
    expect(queries.getModelByValue('codex', 'a')).toMatchObject({ sort_order: 1, status: 'available' });
    expect(manual.sort_order).toBe(3);
  });

  it('uses agy models as the primary Antigravity discovery command with diagnostics', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const stdout = 'gemini-pro-high  Gemini Pro (High)';
    const run = vi.fn().mockResolvedValueOnce(command(stdout, 'token=secret diagnostic'));
    const result = await discoverAntigravity(run);
    expect(run.mock.calls.map((call) => call[1])).toEqual([['models']]);
    expect(result).toMatchObject({ source: 'antigravity-models', authoritative: true, primarySucceeded: true });
    expect(result.models).toEqual([{ value: 'gemini-pro-high', label: 'Gemini Pro (High)', supportedEfforts: null }]);
    expect(result.diagnostics?.[0]).toMatchObject({ command: 'agy models', exitCode: 0, stdoutLength: stdout.length, stderr: 'token=[redacted] diagnostic', parsedModelCount: 1, source: 'antigravity-models' });
  });

  it('falls back to the /model JSON envelope and rejects malformed empty results', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fallback = vi.fn()
      .mockResolvedValueOnce(command('', 'unsupported', 1))
      .mockResolvedValueOnce(command(JSON.stringify({ status: 'SUCCESS', response: 'gemini-command  Gemini Command' })));
    expect(await discoverAntigravity(fallback)).toMatchObject({ source: 'antigravity-model-command', authoritative: true, models: [{ value: 'gemini-command', label: 'Gemini Command', supportedEfforts: null }] });

    const malformed = vi.fn().mockResolvedValueOnce(command('')).mockResolvedValueOnce(command('{bad'));
    expect(await discoverAntigravity(malformed)).toMatchObject({ models: [], authoritative: false, primarySucceeded: false });
  });
});
