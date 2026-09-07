import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));

const store = await import('./store.js');

describe('delegation retention', () => {
  let workspace: TestWorkspace;
  beforeEach(() => {
    workspace = createTestWorkspace('delegation-retention');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    testDb.prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Project', ?)").run(workspace.path);
    testDb.prepare("INSERT INTO todos (id, project_id, title) VALUES ('todo', 'project', 'Todo')").run();
    testDb.prepare("INSERT INTO execution_profiles (id, slug, name) VALUES ('profile', 'worker', 'Worker')").run();
  });
  afterEach(() => { testDb.close(); workspace.cleanup(); });

  function parent(id: string) {
    return store.createParentExecution({
      id, ownerId: 'todo', workDir: workspace.path, executionSnapshot: {}, provider: 'claude',
      policyMode: 'telemetry', capability: `cap-${id}`,
    });
  }

  function run(parentExecution: ReturnType<typeof parent>, id: string) {
    return store.createDelegationRun({
      id, parent: parentExecution, executionProfileId: 'profile', sourcePathRelative: 'source.ts',
      sourceSha256: 'hash', sourceBytes: 10, sourceChars: 10, sourceLines: 1,
      queryHash: 'query', queryLength: 5,
    });
  }

  it('removes an old completed parent only after its old children are removed', () => {
    const old = parent('old-parent');
    const runId = run(old, 'old-run');
    store.updateDelegationRun(runId, { status: 'completed', finished: true });
    store.recordObservation({
      parentExecution: old, toolName: 'Read', operationType: 'read_file', decision: 'allow',
      decisionReason: 'telemetry_only', hookLatencyMs: 1,
    });
    store.updateParentExecution(old.id, { status: 'completed', finished: true });
    testDb.prepare("UPDATE delegation_parent_executions SET finished_at = '2020-01-01', created_at = '2020-01-01' WHERE id = ?").run(old.id);
    testDb.prepare("UPDATE delegation_runs SET started_at = '2020-01-01', finished_at = '2020-01-01' WHERE id = ?").run(runId);
    testDb.prepare("UPDATE delegation_tool_observations SET created_at = '2020-01-01', observed_at = '2020-01-01' WHERE parent_execution_id = ?").run(old.id);
    expect(store.cleanupDelegationTelemetry(30)).toBeGreaterThanOrEqual(3);
    expect(store.getParentExecution(old.id)).toBeUndefined();
  });

  it('retains an old parent with recovery-required PID ownership', () => {
    const retained = parent('retained-parent');
    const runId = run(retained, 'retained-run');
    store.updateDelegationRun(runId, {
      status: 'recovery_required', processPid: 4040,
      processIdentity: JSON.stringify({ pid: 4040, startTime: 'owned' }),
    });
    store.updateParentExecution(retained.id, { status: 'failed', finished: true });
    testDb.prepare("UPDATE delegation_parent_executions SET finished_at = '2020-01-01' WHERE id = ?").run(retained.id);
    testDb.prepare("UPDATE delegation_runs SET started_at = '2020-01-01' WHERE id = ?").run(runId);
    store.cleanupDelegationTelemetry(30);
    expect(store.getParentExecution(retained.id)).toBeDefined();
    expect(store.getDelegationRun(runId)).toMatchObject({ status: 'recovery_required', process_pid: 4040 });
  });

  it('retains an anomalous terminal row that still owns a PID', () => {
    const retained = parent('terminal-pid-parent');
    const runId = run(retained, 'terminal-pid-run');
    store.updateDelegationRun(runId, {
      status: 'failed', finished: true, processPid: 987,
      processIdentity: JSON.stringify({ pid: 987, startTime: 'owned' }),
    });
    store.updateParentExecution(retained.id, { status: 'failed', finished: true });
    testDb.prepare("UPDATE delegation_parent_executions SET finished_at = '2020-01-01' WHERE id = ?").run(retained.id);
    testDb.prepare("UPDATE delegation_runs SET started_at = '2020-01-01', finished_at = '2020-01-01' WHERE id = ?").run(runId);

    store.cleanupDelegationTelemetry(30);

    expect(store.getParentExecution(retained.id)).toBeDefined();
    expect(store.getDelegationRun(runId)).toMatchObject({ status: 'failed', process_pid: 987 });
  });

  it('retains a recent completed parent', () => {
    const recent = parent('recent-parent');
    store.updateParentExecution(recent.id, { status: 'completed', finished: true });
    store.cleanupDelegationTelemetry(30);
    expect(store.getParentExecution(recent.id)).toBeDefined();
  });
});
