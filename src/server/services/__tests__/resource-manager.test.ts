import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));

const queries = await import('../../db/queries.js');
const { ResourceManager, RESOURCE_HEARTBEAT_INTERVAL_MS, resourceManager } = await import('../resource-manager.js');
const { normalizeResourceKeys, parseStoredResourceRequirements, serializeResourceRequirements } = await import('../resource-catalog.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');
const { executorPool } = await import('../executor-pool.js');
const { orchestrator } = await import('../orchestrator.js');
const { sessionManager } = await import('../session-manager.js');
const { claudeManager } = await import('../claude-manager.js');

describe('Resource Manager V1', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initDatabase(testDb);
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
    executorPool.resetReservations();
    executorPool.resetLimits();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resourceManager.shutdown();
    executorPool.resetReservations();
    executorPool.resetLimits();
    testDb.close();
  });

  function owner(title = 'Owner') {
    const project = queries.createProject('Project', `C:/project-${Math.random()}`);
    return queries.createTodo(project.id, title);
  }

  it('acquires exclusively and allows the next run after release', () => {
    const first = owner('A');
    const second = owner('B');
    const manager = new ResourceManager();

    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: first.id, runToken: 'run-a', resources: ['unity.editor'] }).status).toBe('acquired');
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second.id, runToken: 'run-b', resources: ['unity.editor'] }).status).toBe('busy');
    expect(manager.releaseRun('run-a')).toBe(1);
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second.id, runToken: 'run-b', resources: ['unity.editor'] }).status).toBe('acquired');
  });

  it('does not retain a partial lease when one requested resource is busy', () => {
    const first = owner('A');
    const second = owner('B');
    const third = owner('C');
    const manager = new ResourceManager();
    manager.acquireAtomic({ ownerType: 'todo', ownerId: first.id, runToken: 'run-a', resources: ['gpu.0'] });

    const blocked = manager.acquireAtomic({
      ownerType: 'todo', ownerId: second.id, runToken: 'run-b', resources: ['unity.editor', 'gpu.0'],
    });
    expect(blocked.status).toBe('busy');
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM resource_leases WHERE run_token = ?').get('run-b')).toEqual({ count: 0 });
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: third.id, runToken: 'run-c', resources: ['unity.editor'] }).status).toBe('acquired');
  });

  it('scopes idempotent release to the old run token', () => {
    const todo = owner();
    const manager = new ResourceManager();
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'run-a', resources: ['gpu.0'] });
    manager.releaseRun('run-a');
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'run-b', resources: ['gpu.0'] });

    expect(manager.releaseRun('run-a')).toBe(0);
    expect(manager.getStatus().find((resource) => resource.key === 'gpu.0')?.leases[0].runToken).toBe('run-b');
  });

  it('normalizes duplicates in catalog order and rejects malformed requirements', () => {
    expect(normalizeResourceKeys(['gpu.0', 'unity.editor', 'gpu.0'])).toEqual(['unity.editor', 'gpu.0']);
    expect(serializeResourceRequirements(['gpu.0', 'gpu.0'])).toBe('["gpu.0"]');
    expect(() => normalizeResourceKeys(['gpu.0', 'definitely.not.real'])).toThrow('Unknown resource key');
    expect(() => normalizeResourceKeys('gpu.0')).toThrow('must be an array');
    expect(() => parseStoredResourceRequirements('{bad json')).toThrow('malformed JSON');
  });

  it('releases an expired dead owner and invokes the availability callback', () => {
    const todo = owner();
    const wake = vi.fn();
    const manager = new ResourceManager(() => false);
    manager.setAvailabilityCallback(wake);
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'dead-run', resources: ['cpu.heavy'] });
    testDb.prepare("UPDATE resource_leases SET expires_at = '2000-01-01T00:00:00.000Z'").run();

    expect(manager.recoverStaleLeases()).toEqual({ released: 1, recovered: 0 });
    expect(wake).toHaveBeenCalledOnce();
    expect(manager.getStatus().find((resource) => resource.key === 'cpu.heavy')?.used).toBe(0);
  });

  it('renews an expired live owner instead of allowing a second owner', () => {
    const first = owner('A');
    const second = owner('B');
    queries.updateTodoStatus(first.id, 'running');
    queries.updateTodo(first.id, { process_pid: 4321 });
    const manager = new ResourceManager((pid) => pid === 4321);
    manager.acquireAtomic({ ownerType: 'todo', ownerId: first.id, runToken: 'live-run', resources: ['local.llm'] });
    testDb.prepare("UPDATE resource_leases SET expires_at = '2000-01-01T00:00:00.000Z'").run();

    expect(manager.recoverStaleLeases()).toEqual({ released: 0, recovered: 1 });
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second.id, runToken: 'other-run', resources: ['local.llm'] }).status).toBe('busy');
  });

  it('heartbeats active runs without broadcasting heartbeat updates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
    const todo = owner();
    queries.updateTodoStatus(todo.id, 'running');
    queries.updateTodo(todo.id, { process_pid: 1234 });
    const manager = new ResourceManager(() => true);
    manager.acquireAtomic({ ownerType: 'todo', ownerId: todo.id, runToken: 'heartbeat-run', resources: ['android.emulator'] });
    const before = manager.getStatus().find((resource) => resource.key === 'android.emulator')!.leases[0].expiresAt;
    vi.mocked(broadcaster.broadcast).mockClear();
    manager.initialize();
    vi.advanceTimersByTime(RESOURCE_HEARTBEAT_INTERVAL_MS);
    const after = manager.getStatus().find((resource) => resource.key === 'android.emulator')!.leases[0].expiresAt;

    expect(after > before).toBe(true);
    expect(broadcaster.broadcast).not.toHaveBeenCalled();
    manager.shutdown();
  });

  it('moves a blocked Todo to waiting_resource without leaking its provider reservation', async () => {
    const project = queries.createProject('Project', 'C:/resource-todo');
    const holder = queries.createTodo(project.id, 'Holder');
    const waiting = queries.createTodo(
      project.id, 'Waiting', undefined, 0, 'raw-shell', undefined, undefined, undefined,
      undefined, 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["gpu.0"]',
    );
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['gpu.0'] });
    const spawn = vi.spyOn(claudeManager, 'startClaude');

    await orchestrator.startTodo(waiting.id);

    expect(queries.getTodoById(waiting.id)?.status).toBe('waiting_resource');
    expect(executorPool.getReservations()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a busy interactive Session without spawning a PTY or retaining a reservation', async () => {
    const project = queries.createProject('Project', 'C:/resource-session');
    const holder = queries.createTodo(project.id, 'Holder');
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: holder.id, runToken: 'holder-run', resources: ['unity.editor'] });
    const session = queries.createSession(
      project.id, 'Interactive', undefined, 'raw-shell', undefined, false,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      '["unity.editor"]',
    );
    const spawn = vi.spyOn(claudeManager, 'startClaude');

    await expect(sessionManager.startSession(session.id)).rejects.toThrow('Required resources are busy: Unity Editor (unity.editor)');
    expect(queries.getSessionById(session.id)?.status).toBe('pending');
    expect(executorPool.getReservations()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
