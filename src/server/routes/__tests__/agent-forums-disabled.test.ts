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
  continueWithoutUserMessage: vi.fn(),
  isCycleRegistered: vi.fn(() => false),
}));

vi.mock('../../services/agent-forum-orchestrator.js', () => {
  class ForumStopIncompleteError extends Error {
    constructor(public readonly forumId: string, message: string) {
      super(message);
      this.name = 'ForumStopIncompleteError';
    }
  }
  class ForumStopTimeoutError extends ForumStopIncompleteError {
    constructor(forumId: string, message: string) {
      super(forumId, message);
      this.name = 'ForumStopTimeoutError';
    }
  }
  class ForumRecoveryPendingError extends ForumStopIncompleteError {
    constructor(forumId: string, message: string, public readonly unresolvedOrphanProcesses: number) {
      super(forumId, message);
      this.name = 'ForumRecoveryPendingError';
    }
  }
  class ForumNotIdleError extends Error {
    constructor(
      public readonly forumId: string,
      message: string,
      public readonly code: 'forum_running' | 'forum_recovery_required',
    ) {
      super(message);
      this.name = 'ForumNotIdleError';
    }
  }
  return {
    agentForumOrchestrator: orchestratorMocks,
    ForumStopIncompleteError,
    ForumStopTimeoutError,
    ForumRecoveryPendingError,
    ForumNotIdleError,
  };
});

const queries = await import('../../db/queries.js');
const { AGENT_FORUM_ENV_VAR } = await import('../../services/features.js');
const forumsRouter = (await import('../agent-forums.js')).default;
const featuresRouter = (await import('../features.js')).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', forumsRouter);
  app.use('/api', featuresRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  // Disabled-mode suite: the flag stays off unless a single test opts in and
  // restores it. Never rely on ambient env from another test file.
  delete process.env[AGENT_FORUM_ENV_VAR];
  orchestratorMocks.isCycleRegistered.mockReturnValue(false);
  orchestratorMocks.stopForum.mockImplementation(async () => {});
  testDb = new Database(':memory:');
  initDatabase(testDb);
});

afterEach(() => {
  delete process.env[AGENT_FORUM_ENV_VAR];
  testDb.close();
});

function seedForum(status: 'idle' | 'running' | 'error' = 'idle') {
  const forum = queries.createAgentForum('Route Forum', undefined, 1024);
  const a = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
  const b = queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });
  const c = queries.createAgentForumMember(forum.id, 'AgentC', 'participant', '', { cliTool: 'claude', sortOrder: 2 });
  if (status !== 'idle') {
    queries.updateAgentForum(forum.id, { status, current_cycle: 1, current_member_id: status === 'running' ? a.id : null });
  }
  return { forum: queries.getAgentForumById(forum.id)!, a, b, c };
}

function seedForumWithHistory() {
  const { forum, a, b, c } = seedForum('idle');
  const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Q');
  const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
  queries.updateAgentForumTurn(turn.id, { status: 'completed', execution_snapshot: '{"agent":"claude"}' });
  const agentMsg = queries.createAgentForumMessage(forum.id, 'agent', a.id, 'AgentA', 'participant', 'A answer', userMsg.id, turn.id);
  return { forum, a, b, c, userMsg, agentMsg, turn };
}

async function postJson(url: string, body: unknown, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AgentForum disabled mode - feature exposure', () => {
  it('reports agentForum=false from GET /api/features by default', async () => {
    const response = await fetch(`${baseUrl}/api/features`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agentForum: false });
  });

  it('reports agentForum=true from GET /api/features when the developer flag is set', async () => {
    process.env[AGENT_FORUM_ENV_VAR] = '1';
    const response = await fetch(`${baseUrl}/api/features`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agentForum: true });
  });
});

describe('AgentForum disabled mode - mutations blocked before orchestration', () => {
  it('rejects forum creation with 403 and persists nothing', async () => {
    const response = await postJson(`${baseUrl}/api/agent-forums`, {
      title: 'Blocked Forum',
      members: [{ name: 'AgentA', role: 'participant', cli_tool: 'claude' }],
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'AgentForum is temporarily disabled',
      code: 'feature_disabled',
      feature: 'agentForum',
    });
    expect(queries.listAgentForums()).toHaveLength(0);
    expect(orchestratorMocks.postUserMessage).not.toHaveBeenCalled();
    expect(orchestratorMocks.continueWithoutUserMessage).not.toHaveBeenCalled();
  });

  it('rejects user messages with 403 and writes no message or cycle', async () => {
    const { forum } = seedForum('idle');

    const response = await postJson(`${baseUrl}/api/agent-forums/${forum.id}/messages`, {
      content: 'Hello?',
    });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('feature_disabled');
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(0);
    expect(queries.getAgentForumTurns(forum.id)).toHaveLength(0);
    expect(orchestratorMocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('rejects continue/skip with 403 without starting a cycle', async () => {
    const { forum } = seedForum('idle');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/continue`, { method: 'POST' });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('feature_disabled');
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(0);
    expect(orchestratorMocks.continueWithoutUserMessage).not.toHaveBeenCalled();
    expect(orchestratorMocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('rejects forum settings changes with 403 and leaves the row untouched', async () => {
    const { forum } = seedForum('idle');

    const response = await postJson(`${baseUrl}/api/agent-forums/${forum.id}`, { rules: 'sneaky' }, 'PUT');

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('feature_disabled');
    expect(queries.getAgentForumById(forum.id)!.rules).toBe(forum.rules);
  });

  it('rejects participant add/update/remove with 403 and leaves members untouched', async () => {
    const { forum, b } = seedForum('idle');

    const added = await postJson(`${baseUrl}/api/agent-forums/${forum.id}/members`, {
      name: 'AgentD', role: 'participant', cli_tool: 'claude',
    });
    expect(added.status).toBe(403);
    expect((await added.json()).code).toBe('feature_disabled');

    const changed = await postJson(
      `${baseUrl}/api/agent-forums/${forum.id}/members/${b.id}`,
      { system_prompt: 'sneaky' },
      'PUT',
    );
    expect(changed.status).toBe(403);

    const removed = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members/${b.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(403);

    expect(queries.getAgentForumMembers(forum.id)).toHaveLength(3);
    expect(queries.getAgentForumMemberById(b.id)!.system_prompt).toBe('');
  });

  it('never uses 500 for a feature-disabled refusal', async () => {
    const { forum } = seedForum('idle');
    const statuses = [
      (await postJson(`${baseUrl}/api/agent-forums`, { title: 'x' })).status,
      (await postJson(`${baseUrl}/api/agent-forums/${forum.id}/messages`, { content: 'x' })).status,
      (await fetch(`${baseUrl}/api/agent-forums/${forum.id}/continue`, { method: 'POST' })).status,
    ];
    for (const status of statuses) {
      expect(status).not.toBe(500);
      expect(status).toBe(403);
    }
  });
});

describe('AgentForum disabled mode - data preservation', () => {
  it('keeps existing forums, members, messages, and turns intact', async () => {
    const { forum, a, b, c, userMsg, agentMsg, turn } = seedForumWithHistory();

    // Fire every blocked mutation; all must refuse without touching data.
    await postJson(`${baseUrl}/api/agent-forums`, { title: 'Blocked' });
    await postJson(`${baseUrl}/api/agent-forums/${forum.id}/messages`, { content: 'Blocked' });
    await fetch(`${baseUrl}/api/agent-forums/${forum.id}/continue`, { method: 'POST' });
    await postJson(`${baseUrl}/api/agent-forums/${forum.id}`, { title: 'Blocked' }, 'PUT');
    await postJson(`${baseUrl}/api/agent-forums/${forum.id}/members`, { name: 'X', role: 'participant' });
    await fetch(`${baseUrl}/api/agent-forums/${forum.id}/members/${b.id}`, { method: 'DELETE' });
    const blockedDelete = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });
    expect(blockedDelete.status).toBe(403);

    expect(queries.getAgentForumById(forum.id)).toBeDefined();
    expect(queries.getAgentForumMembers(forum.id).map((m) => m.id).sort())
      .toEqual([a.id, b.id, c.id].sort());
    expect(queries.getAgentForumMessages(forum.id).map((m) => m.id).sort())
      .toEqual([userMsg.id, agentMsg.id].sort());
    const keptTurn = queries.getAgentForumTurnById(turn.id)!;
    expect(keptTurn.execution_snapshot).toBe('{"agent":"claude"}');
    expect(keptTurn.status).toBe('completed');
  });

  it('keeps reads working: history stays inspectable while disabled', async () => {
    const { forum } = seedForumWithHistory();

    const list = await fetch(`${baseUrl}/api/agent-forums`);
    expect(list.status).toBe(200);
    expect((await list.json() as unknown[])).toHaveLength(1);

    const detail = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`);
    expect(detail.status).toBe(200);
    const body = await detail.json() as { messages: unknown[]; turns: unknown[] };
    expect(body.messages).toHaveLength(2);
    expect(body.turns).toHaveLength(1);
  });
});

describe('AgentForum disabled mode - cleanup stays possible', () => {
  it('leaves Stop available and finishes without starting a new turn', async () => {
    const { forum } = seedForum('running');
    orchestratorMocks.stopForum.mockImplementation(async () => {
      queries.updateAgentForum(forum.id, { status: 'idle', current_member_id: null });
    });

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}/stop`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(orchestratorMocks.stopForum).toHaveBeenCalledWith(forum.id);
    // Cleanup reconciles; it must not trigger fresh provider work.
    expect(orchestratorMocks.postUserMessage).not.toHaveBeenCalled();
    expect(orchestratorMocks.continueWithoutUserMessage).not.toHaveBeenCalled();
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(queries.getAgentForumTurns(forum.id)).toHaveLength(0);
  });

  it('refuses DELETE with 403 and preserves forum/members/messages/turns while disabled', async () => {
    const { forum, a, b, c, userMsg, agentMsg, turn } = seedForumWithHistory();

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'AgentForum is temporarily disabled',
      code: 'feature_disabled',
      feature: 'agentForum',
    });
    // No orchestration, no deletion, no new cycle.
    expect(orchestratorMocks.stopForum).not.toHaveBeenCalled();
    expect(orchestratorMocks.postUserMessage).not.toHaveBeenCalled();
    expect(orchestratorMocks.continueWithoutUserMessage).not.toHaveBeenCalled();
    expect(queries.getAgentForumById(forum.id)).toBeDefined();
    expect(queries.getAgentForumMembers(forum.id).map((m) => m.id).sort())
      .toEqual([a.id, b.id, c.id].sort());
    expect(queries.getAgentForumMessages(forum.id).map((m) => m.id).sort())
      .toEqual([userMsg.id, agentMsg.id].sort());
    expect(queries.getAgentForumTurnById(turn.id)).toBeDefined();
    expect(queries.getAgentForumTurns(forum.id)).toHaveLength(1);
  });

  it('refuses DELETE on a running forum with 403 while disabled (use Stop for cleanup)', async () => {
    const { forum } = seedForum('running');

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('feature_disabled');
    expect(orchestratorMocks.stopForum).not.toHaveBeenCalled();
    expect(queries.getAgentForumById(forum.id)).toBeDefined();
    expect(queries.getAgentForumById(forum.id)!.status).toBe('running');
  });
});

describe('AgentForum disabled mode - reversibility', () => {
  it('accepts creation again once the developer flag is set (re-enable path)', async () => {
    process.env[AGENT_FORUM_ENV_VAR] = '1';

    const response = await postJson(`${baseUrl}/api/agent-forums`, {
      title: 'Re-enabled Forum',
      members: [
        { name: 'AgentA', role: 'participant', cli_tool: 'claude' },
        { name: 'AgentB', role: 'participant', cli_tool: 'claude' },
      ],
    });

    expect(response.status).toBe(201);
    expect(queries.listAgentForums()).toHaveLength(1);
  });

  it('accepts DELETE again once the developer flag is set (existing behavior preserved)', async () => {
    const { forum } = seedForum('idle');
    process.env[AGENT_FORUM_ENV_VAR] = '1';

    const response = await fetch(`${baseUrl}/api/agent-forums/${forum.id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(queries.getAgentForumById(forum.id)).toBeUndefined();
  });
});
