import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));

const { setSetting } = await import('../db/app-settings.js');
const { createParentExecution, consumeFallback } = await import('./store.js');
const { BulkReadService, validateWorkerResult } = await import('./bulk-read.js');
const { executorPool } = await import('../services/executor-pool.js');
const { claudeManager } = await import('../services/claude-manager.js');

const config = {
  cliTool: 'codex' as const, source: 'profile' as const, profileId: 'profile', profileSlug: 'worker', profileName: 'Worker', executorCandidateId: 'candidate',
  cliModelId: 'model', requestedModel: 'gpt-test', model: 'gpt-test', effectiveModel: 'gpt-test-frozen', modelAvailability: 'available' as const,
  effort: { nativeEffort: 'low', supportedEfforts: ['low'], resolution: 'exact' as const }, warnings: [], resolvedAt: '2026-01-01T00:00:00.000Z',
};

describe('bulk_read', () => {
  let workspace: TestWorkspace;
  let root: string;
  let parent: ReturnType<typeof createParentExecution>;

  beforeEach(() => {
    workspace = createTestWorkspace('bulk-read');
    root = workspace.createSubdir('repo');
    testDb = new Database(':memory:'); initDatabase(testDb);
    testDb.prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Project', ?)").run(root);
    testDb.prepare("INSERT INTO todos (id, project_id, title) VALUES ('todo', 'project', 'Todo')").run();
    testDb.prepare("INSERT INTO execution_profiles (id, slug, name) VALUES ('profile', 'worker', 'Worker')").run();
    setSetting('delegation.enabled', '1'); setSetting('delegation.mode', 'telemetry'); setSetting('delegation.worker_execution_profile_id', 'profile');
    parent = createParentExecution({ ownerId: 'todo', workDir: root, executionSnapshot: { agent: 'claude' }, provider: 'claude', policyMode: 'telemetry', capability: 'capability' });
    vi.spyOn(executorPool, 'selectExecutor').mockResolvedValue({ status: 'selected', selectedConfig: config, evaluations: [], evaluatedAt: config.resolvedAt });
  });
  afterEach(() => { vi.restoreAllMocks(); executorPool.resetReservations(); testDb.close(); workspace.cleanup(); });

  it('validates and merges structured ranges while rejecting invalid output', () => {
    expect(validateWorkerResult({ summary: 'ok', ranges: [
      { start_line: 2, end_line: 4, reason: 'a' }, { start_line: 4, end_line: 5, reason: 'b' },
    ] }, 10, 8, 10).ranges).toEqual([{ start_line: 2, end_line: 5, reason: 'a; b' }]);
    expect(() => validateWorkerResult({ summary: 'ok', ranges: [{ start_line: 0, end_line: 2, reason: 'bad' }] }, 10, 8, 10)).toThrow(/out-of-bounds/);
    expect(() => validateWorkerResult({ summary: 'ok', ranges: Array.from({ length: 9 }, () => ({ start_line: 1, end_line: 1, reason: 'x' })) }, 10, 8, 10)).toThrow(/too many ranges/);
    expect(() => validateWorkerResult({}, 10, 8, 10)).toThrow();
  });

  it('returns server-extracted evidence and the frozen execution snapshot', async () => {
    fs.writeFileSync(path.join(root, 'source.ts'), 'one\ntwo\nthree\nfour\nfive\n');
    const service = new BulkReadService(async ({ onStarted }) => {
      onStarted(123, { pid: 123, startTime: 'frozen' });
      return { output: JSON.stringify({ summary: 'found', ranges: [{ start_line: 2, end_line: 4, reason: 'match', symbols: ['two'] }] }), exitCode: 0 };
    });
    const result = await service.run(parent, { path: 'source.ts', query: 'Where is two?' });
    expect(result.status).toBe('ok');
    expect(result.ranges?.[0].anchor_snippet).toContain('2: two');
    expect(result.worker_execution).toMatchObject({ effectiveModel: 'gpt-test-frozen' });
    expect(JSON.stringify(result)).not.toContain('SOURCE_DATA');
  });

  it('returns stale when the file changes during the worker call', async () => {
    const file = path.join(root, 'source.ts'); fs.writeFileSync(file, 'one\ntwo\n');
    const service = new BulkReadService(async ({ onStarted }) => {
      onStarted(124, null); fs.writeFileSync(file, 'changed content\n');
      return { output: JSON.stringify({ summary: 'found', ranges: [{ start_line: 1, end_line: 1, reason: 'match' }] }), exitCode: 0 };
    });
    expect((await service.run(parent, { path: file, query: 'find' })).status).toBe('stale');
  });

  it('grants one exact fallback for invalid output and no_match', async () => {
    const file = path.join(root, 'source.ts'); fs.writeFileSync(file, 'one\ntwo\n');
    const invalid = new BulkReadService(async ({ onStarted }) => { onStarted(125, null); return { output: 'not json', exitCode: 0 }; });
    const failed = await invalid.run(parent, { path: file, query: 'find' });
    expect(failed).toMatchObject({ status: 'failed', error_code: 'invalid_structured_output', fallback_granted: true });
    const identity = (await import('./file-access.js')).readDelegationFile(root, file, 1024, 20);
    expect(consumeFallback(parent.id, identity.canonicalPath, identity.sha256)).toBe(true);
    expect(consumeFallback(parent.id, identity.canonicalPath, identity.sha256)).toBe(false);

    const noMatch = new BulkReadService(async ({ onStarted }) => { onStarted(126, null); return { output: JSON.stringify({ summary: 'none', ranges: [] }), exitCode: 0 }; });
    expect(await noMatch.run(parent, { path: file, query: 'missing' })).toMatchObject({ status: 'no_match', fallback_granted: true });
  });

  it('grants direct fallback when no candidate is immediately available', async () => {
    const file = path.join(root, 'source.ts'); fs.writeFileSync(file, 'one\ntwo\n');
    vi.mocked(executorPool.selectExecutor).mockResolvedValueOnce({ status: 'waiting_executor', evaluations: [], evaluatedAt: config.resolvedAt, rejectionSummary: 'busy' });
    const service = new BulkReadService(async () => { throw new Error('must not launch'); });
    expect(await service.run(parent, { path: file, query: 'find' })).toMatchObject({ status: 'failed', error_code: 'delegation_unavailable', fallback_granted: true });
  });

  it('cancels a running worker with its parent and ignores the late result', async () => {
    const file = path.join(root, 'source.ts'); fs.writeFileSync(file, 'one\ntwo\n');
    let resolveWorker!: (value: { output: string; exitCode: number }) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const service = new BulkReadService(({ onStarted }) => new Promise((resolve) => {
      resolveWorker = resolve;
      onStarted(777, { pid: 777, startTime: 'owned' });
      started();
    }));
    vi.spyOn(claudeManager, 'stopClaude').mockResolvedValue({ status: 'terminated', pid: 777, graceful: true });
    const runPromise = service.run(parent, { path: file, query: 'find' });
    await startedPromise;
    await service.cancelForOwner('todo');
    resolveWorker({ output: JSON.stringify({ summary: 'late', ranges: [{ start_line: 1, end_line: 1, reason: 'late' }] }), exitCode: 0 });
    expect(await runPromise).toMatchObject({ status: 'failed', error_code: 'cancelled', fallback_granted: false });
    expect(testDb.prepare('SELECT status FROM delegation_runs ORDER BY started_at DESC LIMIT 1').get()).toEqual({ status: 'cancelled' });
  });
});
