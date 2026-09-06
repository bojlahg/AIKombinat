import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../../db/schema.js';
import type { ProcessIdentity } from '../../utils/process-tree.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => testDb }));
vi.mock('../../websocket/broadcaster.js', () => ({ broadcaster: { broadcast: vi.fn() } }));
vi.mock('../../utils/process-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/process-tree.js')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});

const queries = await import('../../db/queries.js');
const processTree = await import('../../utils/process-tree.js');
const { resourceManager } = await import('../resource-manager.js');
const { recoverPersistedProcesses } = await import('../startup-process-recovery.js');
const { assertNoUnresolvedProcess } = await import('../process-ownership.js');

const PID = 424242;
const identity: ProcessIdentity = { pid: PID, startedAt: '2026-09-06T00:00:00Z', command: 'provider.exe' };
const persistedIdentity = JSON.stringify(identity);

describe('startup process recovery', () => {
  let project: queries.Project;
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace('startup-process-recovery');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    project = queries.createProject('Recovery', workspace.createSubdir('recovery'));
  });

  afterEach(() => {
    resourceManager.shutdown();
    testDb.close();
    workspace.cleanup();
  });

  function runningOwners(pid = PID, processIdentity: string | null = persistedIdentity) {
    const todo = queries.createTodo(project.id, 'Todo');
    const session = queries.createSession(project.id, 'Session');
    const discussion = queries.createDiscussion(project.id, 'Discussion', 'Recover', []);
    queries.updateTodoStatus(todo.id, 'running');
    queries.updateSessionStatus(session.id, 'running');
    queries.updateDiscussionStatus(discussion.id, 'running');
    queries.updateTodo(todo.id, { process_pid: pid, process_identity: processIdentity });
    queries.updateSession(session.id, { process_pid: pid, process_identity: processIdentity });
    queries.updateDiscussion(discussion.id, { process_pid: pid, process_identity: processIdentity });
    return { todo, session, discussion };
  }

  it('reconciles dead Todo, Session, and Discussion PIDs and clears identities', async () => {
    const owners = runningOwners();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: owners.todo.id, runToken: 'todo-dead', resources: ['gpu.0'] });
    await recoverPersistedProcesses({ isAlive: () => false, verify: vi.fn() });

    expect(queries.getTodoById(owners.todo.id)).toMatchObject({ status: 'failed', process_pid: 0, process_identity: null });
    expect(queries.getSessionById(owners.session.id)).toMatchObject({ status: 'failed', process_pid: 0, process_identity: null });
    expect(queries.getDiscussionById(owners.discussion.id)).toMatchObject({ status: 'paused', process_pid: 0, process_identity: null });
    expect(resourceManager.getStatus().find((entry) => entry.key === 'gpu.0')?.used).toBe(0);
  });

  it('preserves live matching processes, including a Discussion surviving restart', async () => {
    const owners = runningOwners();
    const verify = vi.fn().mockResolvedValue('match');
    await recoverPersistedProcesses({ isAlive: () => true, verify });

    expect(queries.getTodoById(owners.todo.id)).toMatchObject({ status: 'running', process_pid: PID, process_identity: persistedIdentity });
    expect(queries.getSessionById(owners.session.id)).toMatchObject({ status: 'running', process_pid: PID, process_identity: persistedIdentity });
    expect(queries.getDiscussionById(owners.discussion.id)).toMatchObject({ status: 'running', process_pid: PID, process_identity: persistedIdentity });
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('clears mismatched reused PIDs without signalling them and releases ownership', async () => {
    const owners = runningOwners();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: owners.todo.id, runToken: 'todo-mismatch', resources: ['gpu.0'] });
    resourceManager.acquireAtomic({ ownerType: 'session', ownerId: owners.session.id, runToken: 'session-mismatch', resources: ['cpu.heavy'] });
    await recoverPersistedProcesses({ isAlive: () => true, verify: vi.fn().mockResolvedValue('mismatch') });

    expect(queries.getTodoById(owners.todo.id)).toMatchObject({ status: 'failed', process_pid: 0, process_identity: null });
    expect(queries.getSessionById(owners.session.id)).toMatchObject({ status: 'failed', process_pid: 0, process_identity: null });
    expect(queries.getDiscussionById(owners.discussion.id)).toMatchObject({ status: 'paused', process_pid: 0, process_identity: null });
    expect(resourceManager.getStatus().find((entry) => entry.key === 'gpu.0')?.used).toBe(0);
    expect(resourceManager.getStatus().find((entry) => entry.key === 'cpu.heavy')?.used).toBe(0);
    expect(processTree.terminateProcessTree).not.toHaveBeenCalled();
    expect(() => assertNoUnresolvedProcess('Todo', queries.getTodoById(owners.todo.id)!)).not.toThrow();
    expect(() => assertNoUnresolvedProcess('Session', queries.getSessionById(owners.session.id)!)).not.toThrow();
    expect(() => assertNoUnresolvedProcess('Discussion', queries.getDiscussionById(owners.discussion.id)!)).not.toThrow();
  });

  it('retains unverifiable live PIDs and ownership for explicit recovery', async () => {
    const owners = runningOwners();
    resourceManager.acquireAtomic({ ownerType: 'todo', ownerId: owners.todo.id, runToken: 'todo-unverifiable', resources: ['gpu.0'] });
    resourceManager.acquireAtomic({ ownerType: 'session', ownerId: owners.session.id, runToken: 'session-unverifiable', resources: ['cpu.heavy'] });
    await recoverPersistedProcesses({ isAlive: () => true, verify: vi.fn().mockResolvedValue('unverifiable') });

    expect(queries.getTodoById(owners.todo.id)).toMatchObject({ status: 'failed', process_pid: PID, process_identity: persistedIdentity });
    expect(queries.getSessionById(owners.session.id)).toMatchObject({ status: 'failed', process_pid: PID, process_identity: persistedIdentity });
    expect(queries.getDiscussionById(owners.discussion.id)).toMatchObject({ status: 'failed', process_pid: PID, process_identity: persistedIdentity });
    expect(resourceManager.getStatus().find((entry) => entry.key === 'gpu.0')?.used).toBe(1);
    expect(resourceManager.getStatus().find((entry) => entry.key === 'cpu.heavy')?.used).toBe(1);
  });

  it('treats a missing identity as unverifiable and retains the live PID', async () => {
    const owners = runningOwners(PID, null);
    const verify = vi.fn().mockResolvedValue('unverifiable');
    await recoverPersistedProcesses({ isAlive: () => true, verify });
    expect(verify).toHaveBeenCalledWith(PID, null);
    expect(queries.getDiscussionById(owners.discussion.id)).toMatchObject({ status: 'failed', process_pid: PID, process_identity: null });
  });
});
