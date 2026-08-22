import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { refreshModelCatalog, maybeTriggerSync, parseAntigravityModels, parseCodexModelList } = await import('../model-sync.js');

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
    expect(queries.getModelByValue('codex', 'gpt-good')).toMatchObject({ availability_status: 'available', deprecated: 0 });
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
    expect(queries.getModelByValue('claude', 'claude-old')?.availability_status).toBe('unknown');
    expect(queries.getModelByValue('claude', 'claude-old')?.deprecated).toBe(0);
    expect(queries.getModelByValue('claude', 'claude-old')?.last_seen_at).toBeTruthy();
  });

  it('authoritative discovery stores capabilities and marks absent models unavailable', async () => {
    testDb.prepare(`INSERT INTO cli_models (id, cli_tool, model_value, model_label, source, availability_status) VALUES ('old', 'codex', 'gpt-old', 'GPT Old', 'codex-app-server', 'available')`).run();
    await refreshModelCatalog('codex', { discover: async () => ({
      models: [{ value: 'gpt-new', label: 'GPT New', supportedEfforts: ['low', 'medium', 'xhigh'] }],
      source: 'codex-app-server', authoritative: true, primarySucceeded: true,
    }) });
    expect(JSON.parse(queries.getModelByValue('codex', 'gpt-new')!.supported_efforts!)).toEqual(['low', 'medium', 'xhigh']);
    expect(queries.getModelByValue('codex', 'gpt-new')).toMatchObject({ availability_status: 'available', source: 'codex-app-server' });
    expect(queries.getModelByValue('codex', 'gpt-old')).toMatchObject({ availability_status: 'unavailable', deprecated: 1 });
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

  it('parses Antigravity and Codex capability output', () => {
    expect(parseAntigravityModels('gemini-3-pro\n  gemini-3-flash')).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'gemini-3-pro', supportedEfforts: ['low', 'medium', 'high'] }),
    ]));
    expect(parseCodexModelList({ data: [{ id: 'gpt-5', displayName: 'GPT-5', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }] })).toEqual([
      { value: 'gpt-5', label: 'GPT-5', supportedEfforts: ['medium', 'high'] },
    ]);
  });
});
