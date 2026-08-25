import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDatabase } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

const orchestratorMocks = vi.hoisted(() => ({
  stopForum: vi.fn(async () => {}),
  postUserMessage: vi.fn(),
  isCycleRegistered: vi.fn(() => false),
}));

vi.mock('../../services/agent-forum-orchestrator.js', () => {
  class ForumStopTimeoutError extends Error {
    constructor(public readonly forumId: string, message: string) {
      super(message);
      this.name = 'ForumStopTimeoutError';
    }
  }
  return {
    agentForumOrchestrator: orchestratorMocks,
    ForumStopTimeoutError,
  };
});

const queries = await import('../../db/queries.js');
const router = (await import('../agent-forums.js')).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  orchestratorMocks.isCycleRegistered.mockReturnValue(false);
  orchestratorMocks.stopForum.mockImplementation(async () => {});
  testDb = new Database(':memory:');
  initDatabase(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedForum(status: 'idle' | 'running' = 'idle') {
  const forum = queries.createAgentForum('Route Forum', undefined, 1024);
  const a = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
  const b = queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });
  const c = queries.createAgentForumMember(forum.id, 'AgentC', 'participant', '', { cliTool: 'claude', sortOrder: 2 });
  if (status === 'running') {
    queries.updateAgentForum(forum.id, { status: 'running', current_cycle: 1, current_member_id: a.id });
  }
  return { forum: queries.getAgentForumById(forum.id)!, a, b, c };
}

describe('AgentForum routes - mutation lock while running', () => {
  it('rejects rules / max_reply_length / project_id changes with 409', async () => {
    const { forum } = seedForum('running');

    for (const body of [
      { rules: 'new rules' },
      { max_reply_length: 512 },
      { project_id: null },
    ]) {
      const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(409);
    }

    const unchanged = queries.getAgentForumById(forum.id)!;
    expect(unchanged.rules).toBe(forum.rules);
    expect(unchanged.max_reply_length).toBe(1024);
  });

  it('rejects the mutation when only the orchestrator knows a cycle is in flight', async () => {
    const { forum } = seedForum('idle');
    orchestratorMocks.isCycleRegistered.mockReturnValue(true);

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: 'sneaky update' }),
    });

    expect(response.status).toBe(409);
  });

  it('still allows renaming a running forum', async () => {
    const { forum } = seedForum('running');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed while running' }),
    });

    expect(response.status).toBe(200);
    expect(queries.getAgentForumById(forum.id)!.title).toBe('Renamed while running');
  });

  it('rejects adding a participant with 409', async () => {
    const { forum } = seedForum('running');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'AgentD', role: 'participant', cli_tool: 'claude' }),
    });

    expect(response.status).toBe(409);
    expect(queries.getAgentForumMembers(forum.id)).toHaveLength(3);
  });

  it('rejects changing a participant (model / profile / prompt) with 409', async () => {
    const { forum, b } = seedForum('running');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members/${b.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_prompt: 'changed mid-cycle', cli_tool: 'codex' }),
    });

    expect(response.status).toBe(409);
    const unchanged = queries.getAgentForumMemberById(b.id)!;
    expect(unchanged.system_prompt).toBe('');
    expect(unchanged.cli_tool).toBe('claude');
  });

  it('rejects removing the current member with 409 so the running turn is never cascaded away', async () => {
    const { forum, a } = seedForum('running');
    const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members/${a.id}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(409);
    expect(queries.getAgentForumMemberById(a.id)).toBeDefined();
    expect(queries.getAgentForumTurnById(turn.id)).toBeDefined();
  });

  it('deletes a running forum only through the stop/drain lifecycle', async () => {
    const { forum } = seedForum('running');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(orchestratorMocks.stopForum).toHaveBeenCalledWith(forum.id);
    expect(queries.getAgentForumById(forum.id)).toBeUndefined();
  });
});

describe('AgentForum routes - participant removal preserves history', () => {
  it('soft-disables a participant that already has history', async () => {
    const { forum, a } = seedForum('idle');
    const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
    queries.updateAgentForumTurn(turn.id, { status: 'completed', execution_snapshot: '{"agent":"claude"}' });
    const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Q');
    queries.createAgentForumMessage(forum.id, 'agent', a.id, 'AgentA', 'participant', 'A answer', userMsg.id, turn.id);

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members/${a.id}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.removal).toBe('soft_disabled');
    expect(body.is_active).toBe(0);

    // Nothing was destroyed.
    expect(queries.getAgentForumMemberById(a.id)).toBeDefined();
    const keptTurn = queries.getAgentForumTurnById(turn.id)!;
    expect(keptTurn.execution_snapshot).toBe('{"agent":"claude"}');
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(2);

    // But they no longer take part in future cycles.
    expect(queries.getActiveAgentForumMembers(forum.id).map((m) => m.name)).toEqual(['AgentB', 'AgentC']);
  });

  it('hard-deletes a participant that has no history yet', async () => {
    const { forum, c } = seedForum('idle');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members/${c.id}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
    expect(queries.getAgentForumMemberById(c.id)).toBeUndefined();
    expect(queries.getAgentForumMembers(forum.id)).toHaveLength(2);
  });
});

describe('AgentForum routes - forum deletion with history', () => {
  it('still deletes a forum that has turn history despite the RESTRICT member FK', async () => {
    const { forum, a } = seedForum('idle');
    const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
    queries.updateAgentForumTurn(turn.id, { status: 'completed' });

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(queries.getAgentForumById(forum.id)).toBeUndefined();
    expect(queries.getAgentForumTurnById(turn.id)).toBeUndefined();
  });
});

describe('AgentForum routes - stop that could not be confirmed', () => {
  async function stopTimesOut(forumId: string) {
    const { ForumStopTimeoutError } = await import('../../services/agent-forum-orchestrator.js');
    orchestratorMocks.isCycleRegistered.mockReturnValue(true);
    orchestratorMocks.stopForum.mockImplementation(async () => {
      throw new ForumStopTimeoutError(forumId, 'Stop could not confirm the forum cycle is quiescent within 15000ms.');
    });
  }

  it('reports an incomplete Stop explicitly instead of pretending success', async () => {
    const { forum } = seedForum('running');
    await stopTimesOut(forum.id);

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/stop`, { method: 'POST' });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe('forum_stop_incomplete');
    expect(body.error).toMatch(/could not confirm/i);
    // The forum is not presented as safely idle.
    expect(queries.getAgentForumById(forum.id)!.status).not.toBe('idle');
  });

  it('refuses to DELETE a forum whose Stop did not complete, keeping all rows', async () => {
    const { forum, a } = seedForum('running');
    const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
    queries.updateAgentForumTurn(turn.id, { status: 'running', process_pid: 4242 });
    const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Q');
    await stopTimesOut(forum.id);

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('forum_stop_incomplete');
    expect(body.error).toMatch(/not deleted/i);

    // Nothing was removed — the rows that let us reconcile the cycle survive.
    expect(queries.getAgentForumById(forum.id)).toBeDefined();
    expect(queries.getAgentForumTurnById(turn.id)!.process_pid).toBe(4242);
    expect(queries.getAgentForumMessages(forum.id).map((m) => m.id)).toEqual([userMsg.id]);
    expect(queries.getAgentForumMembers(forum.id)).toHaveLength(3);
  });

  it('deletes normally once a retried Stop completes', async () => {
    const { forum } = seedForum('running');
    await stopTimesOut(forum.id);

    const blocked = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(queries.getAgentForumById(forum.id)).toBeDefined();

    // The cycle drained; Stop now succeeds.
    orchestratorMocks.stopForum.mockImplementation(async () => {
      queries.updateAgentForum(forum.id, { status: 'idle', current_member_id: null });
    });

    const retried = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });
    expect(retried.status).toBe(204);
    expect(queries.getAgentForumById(forum.id)).toBeUndefined();
  });

  it('still surfaces unexpected stop errors as 500', async () => {
    const { forum } = seedForum('running');
    orchestratorMocks.stopForum.mockRejectedValue(new Error('boom'));

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/stop`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('boom');
  });
});

describe('AgentForum routes - creation atomicity', () => {
  it('creates forum and all members together', async () => {
    const response = await fetch(`${baseUrl}/api/agent-forums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Atomic Forum',
        members: [
          { name: 'AgentA', role: 'participant', cli_tool: 'claude' },
          { name: 'AgentB', role: 'participant', cli_tool: 'codex' },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m: { name: string }) => m.name)).toEqual(['AgentA', 'AgentB']);
    expect(queries.listAgentForums()).toHaveLength(1);
  });

  it('rejects the whole create when any initial member is malformed', async () => {
    const malformedCases: Array<{ label: string; second: unknown; expected: RegExp }> = [
      { label: 'missing name', second: { role: 'participant', cli_tool: 'claude' }, expected: /members\[1\]\.name/ },
      { label: 'blank name', second: { name: '   ', role: 'participant' }, expected: /members\[1\]\.name/ },
      { label: 'missing role', second: { name: 'AgentB', cli_tool: 'claude' }, expected: /members\[1\]\.role/ },
      { label: 'blank role', second: { name: 'AgentB', role: '' }, expected: /members\[1\]\.role/ },
      { label: 'not an object', second: 'AgentB', expected: /members\[1\] must be an object/ },
      { label: 'null', second: null, expected: /members\[1\] must be an object/ },
    ];

    for (const { label, second, expected } of malformedCases) {
      const response = await fetch(`${baseUrl}/api/agent-forums`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Doomed ${label}`,
          members: [
            { name: 'AgentA', role: 'participant', cli_tool: 'claude' },
            second,
            { name: 'AgentC', role: 'participant', cli_tool: 'claude' },
          ],
        }),
      });

      expect(response.status, label).toBe(400);
      expect((await response.json()).error, label).toMatch(expected);
      // A malformed member is never silently dropped, and nothing is persisted.
      expect(queries.listAgentForums(), label).toHaveLength(0);
      expect(
        (testDb.prepare('SELECT COUNT(*) AS n FROM agent_forum_members').get() as { n: number }).n,
        label,
      ).toBe(0);
    }
  });

  it('rejects a non-array members field', async () => {
    const response = await fetch(`${baseUrl}/api/agent-forums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bad Members', members: { name: 'AgentA', role: 'participant' } }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/members must be an array/);
    expect(queries.listAgentForums()).toHaveLength(0);
  });

  it('leaves no partial forum behind when a member has an invalid execution config', async () => {
    const response = await fetch(`${baseUrl}/api/agent-forums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Doomed Forum',
        members: [
          { name: 'AgentA', role: 'participant', cli_tool: 'claude' },
          { name: 'AgentB', role: 'participant', execution_profile_id: 'profile-that-does-not-exist' },
        ],
      }),
    });

    expect(response.status).toBe(400);
    // Neither the forum nor its first member were persisted.
    expect(queries.listAgentForums()).toHaveLength(0);
  });
});

describe('AgentForum routes - cycle start requires a quorum', () => {
  it('surfaces the orchestrator refusal instead of creating an unanswerable message', async () => {
    const { forum } = seedForum('idle');
    orchestratorMocks.postUserMessage.mockRejectedValue(
      new Error('Forum needs at least 2 active participants to start a cycle (currently 1).')
    );

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Anybody there?' }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/at least 2 active participants/i);
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(0);
  });
});
