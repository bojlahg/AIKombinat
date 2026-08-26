import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

const queries = await import('../../db/queries.js');
const { extractStructuredReplies, AgentForumValidationError } = await import('../agent-forum-extractor.js');
const { AgentForumOrchestrator } = await import('../agent-forum-orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const { getAdapter } = await import('../cli-adapters.js');

describe('AgentForum Extractor & Validation', () => {
  const availableTargetIds = new Set(['msg-user-1', 'msg-agent-a1', 'msg-agent-b1']);
  const maxReplyLength = 100;

  it('parses valid structured JSON with multiple replies', () => {
    const rawOutput = JSON.stringify({
      replies: [
        { replyTo: 'msg-user-1', content: 'I agree with the user proposal.' },
        { replyTo: 'msg-agent-a1', content: 'However, Agent A overlooked an edge case.' },
      ],
    });

    const result = extractStructuredReplies(rawOutput, {
      availableTargetIds,
      maxReplyLength,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ replyTo: 'msg-user-1', content: 'I agree with the user proposal.' });
    expect(result[1]).toEqual({ replyTo: 'msg-agent-a1', content: 'However, Agent A overlooked an edge case.' });
  });

  it('handles PASS (empty replies array)', () => {
    const rawOutput = JSON.stringify({ replies: [] });
    const result = extractStructuredReplies(rawOutput, {
      availableTargetIds,
      maxReplyLength,
    });
    expect(result).toEqual([]);
  });

  it('extracts JSON from markdown code blocks', () => {
    const rawOutput = `Here is my structured response:
\`\`\`json
{
  "replies": [
    { "replyTo": "msg-user-1", "content": "Clean markdown extracted." }
  ]
}
\`\`\`
Hope this helps!`;

    const result = extractStructuredReplies(rawOutput, {
      availableTargetIds,
      maxReplyLength,
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Clean markdown extracted.');
  });

  it('rejects empty output', () => {
    expect(() =>
      extractStructuredReplies('', { availableTargetIds, maxReplyLength })
    ).toThrow(AgentForumValidationError);
  });

  it('rejects unparseable non-JSON output', () => {
    expect(() =>
      extractStructuredReplies('This is plain text without JSON', { availableTargetIds, maxReplyLength })
    ).toThrow(AgentForumValidationError);
  });

  it('rejects replies exceeding maxReplyLength', () => {
    const rawOutput = JSON.stringify({
      replies: [
        { replyTo: 'msg-user-1', content: 'A'.repeat(150) },
      ],
    });

    expect(() =>
      extractStructuredReplies(rawOutput, { availableTargetIds, maxReplyLength })
    ).toThrow(/exceeded maximum length/);
  });

  it('rejects duplicate replyTo within the same turn', () => {
    const rawOutput = JSON.stringify({
      replies: [
        { replyTo: 'msg-user-1', content: 'First reply to user' },
        { replyTo: 'msg-user-1', content: 'Second reply to user in same turn' },
      ],
    });

    expect(() =>
      extractStructuredReplies(rawOutput, { availableTargetIds, maxReplyLength })
    ).toThrow(/Duplicate replyTo target/);
  });

  it('rejects target IDs not in availableTargetIds (invalid/self/already replied)', () => {
    const rawOutput = JSON.stringify({
      replies: [
        { replyTo: 'msg-non-existent', content: 'Replying to invalid message' },
      ],
    });

    expect(() =>
      extractStructuredReplies(rawOutput, { availableTargetIds, maxReplyLength })
    ).toThrow(/Invalid reply target/);
  });
});

describe('AgentForum Orchestrator & State Machine', () => {
  let workspace: TestWorkspace;
  let orchestrator: InstanceType<typeof AgentForumOrchestrator>;

  beforeEach(() => {
    workspace = createTestWorkspace('forum-test');
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);
    orchestrator = new AgentForumOrchestrator();
  });

  afterEach(() => {
    testDb.close();
    workspace.cleanup();
    vi.restoreAllMocks();
  });

  it('persists forum, members, and user messages', async () => {
    const forum = queries.createAgentForum('Architecture Forum', 'Be concise and constructive.', 512);
    expect(forum.id).toBeDefined();
    expect(forum.title).toBe('Architecture Forum');
    expect(forum.max_reply_length).toBe(512);
    expect(forum.status).toBe('idle');

    const m1 = queries.createAgentForumMember(forum.id, 'Claude', 'architect', 'Focus on design');
    const m2 = queries.createAgentForumMember(forum.id, 'Codex', 'developer', 'Focus on code');

    const members = queries.getAgentForumMembers(forum.id);
    expect(members).toHaveLength(2);
    expect(members[0].name).toBe('Claude');
    expect(members[1].name).toBe('Codex');

    const userMsg = queries.createAgentForumMessage(
      forum.id,
      'user',
      null,
      'User',
      'User',
      'Should we migrate to SQLite WAL mode?',
    );

    expect(userMsg.id).toBeDefined();
    expect(userMsg.author_type).toBe('user');
    expect(userMsg.parent_message_id).toBeNull();

    const messages = queries.getAgentForumMessages(forum.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Should we migrate to SQLite WAL mode?');
  });

  it('runs sequential cycle: Agent A replies, Agent B sees Agent A replies and replies', async () => {
    const forum = queries.createAgentForum('Test Forum', undefined, 1024);
    const m1 = queries.createAgentForumMember(forum.id, 'AgentA', 'architect');
    const m2 = queries.createAgentForumMember(forum.id, 'AgentB', 'developer');
    const m3 = queries.createAgentForumMember(forum.id, 'AgentC', 'reviewer');

    // Create initial user message
    const userMsg = queries.createAgentForumMessage(
      forum.id,
      'user',
      null,
      'User',
      'User',
      'Initial question about cache design.',
    );

    // Mock startClaude to simulate sequential outputs
    let callCount = 0;
    const capturedPrompts: string[] = [];

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async (_dir, prompt) => {
      callCount++;
      capturedPrompts.push(prompt);

      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const currentCall = callCount;

      const exitPromise = new Promise<number>((resolve) => {
        setTimeout(() => {
          if (currentCall === 1) {
            // Agent A replies to User
            stdout.emit('data', JSON.stringify({
              replies: [{ replyTo: userMsg.id, content: 'Agent A: We should use Redis for cache.' }],
            }));
            resolve(0);
          } else if (currentCall === 2) {
            // Agent B sees Agent A's reply and replies to Agent A
            const messages = queries.getAgentForumMessages(forum.id);
            const agentAMsg = messages.find((m) => m.author_name === 'AgentA')!;
            stdout.emit('data', JSON.stringify({
              replies: [
                { replyTo: agentAMsg.id, content: 'Agent B: In-memory LRU is simpler than Redis.' },
              ],
            }));
            resolve(0);
          } else if (currentCall === 3) {
            // Agent C decides to PASS
            stdout.emit('data', JSON.stringify({ replies: [] }));
            resolve(0);
          }
        }, 10);
      });

      const pid = 1000 + callCount;
      return { pid, stdout, stderr, exitPromise };
    });

    await orchestrator.runCycle(forum.id);

    const turns = queries.getAgentForumTurns(forum.id);
    const finalMessages = queries.getAgentForumMessages(forum.id);
    expect(finalMessages).toHaveLength(3); // User, Agent A reply, Agent B reply (Agent C passed)

    const agentAMsg = finalMessages.find((m) => m.author_name === 'AgentA')!;
    expect(agentAMsg).toBeDefined();
    expect(agentAMsg.parent_message_id).toBe(userMsg.id);

    const agentBMsg = finalMessages.find((m) => m.author_name === 'AgentB')!;
    expect(agentBMsg).toBeDefined();
    expect(agentBMsg.parent_message_id).toBe(agentAMsg.id);

    // Verify Agent B prompt contained Agent A's reply
    expect(capturedPrompts[1]).toContain('Agent A: We should use Redis for cache.');
    // Verify Agent C prompt contained both Agent A and Agent B replies
    expect(capturedPrompts[2]).toContain('Agent A: We should use Redis for cache.');
    expect(capturedPrompts[2]).toContain('Agent B: In-memory LRU is simpler than Redis.');

    // Verify turns recorded correctly
    expect(turns).toHaveLength(3);
    expect(turns[0].status).toBe('completed');
    expect(turns[1].status).toBe('completed');
    expect(turns[2].status).toBe('passed');

    // Verify forum returned to idle
    const updatedForum = queries.getAgentForumById(forum.id)!;
    expect(updatedForum.status).toBe('idle');
    expect(updatedForum.current_cycle).toBe(1);
  });

  it('creates a reply from a captured Antigravity NDJSON result after provider-edge decoding', async () => {
    const forum = queries.createAgentForum('Antigravity Transport Forum', undefined, 1024);
    queries.createAgentForumMember(forum.id, 'AgentA', 'architect', '', { cliTool: 'antigravity' });
    queries.createAgentForumMember(forum.id, 'AgentB', 'developer', '', { cliTool: 'antigravity' });
    queries.createAgentForumMember(forum.id, 'AgentC', 'reviewer', '', { cliTool: 'antigravity' });
    const userMsg = queries.createAgentForumMessage(
      forum.id, 'user', null, 'User', 'User', 'Поздоровайся.',
    );

    let turn = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      turn++;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const response = turn === 1
        ? JSON.stringify({ replies: [{ replyTo: userMsg.id, content: 'Привет' }] })
        : JSON.stringify({ replies: [] });
      const captured = [
        JSON.stringify({ event: 'init', session: 'captured-session' }),
        JSON.stringify({ event: 'step_update', step: { text: 'working' } }),
        JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } }),
      ].join('\n') + '\n';
      const decoder = getAdapter('antigravity').createOutputDecoder!();
      decoder.push(captured.slice(0, 23));
      decoder.push(captured.slice(23, -5));
      decoder.push(captured.slice(-5));
      const decoded = decoder.finish(0);

      const exitPromise = new Promise<number>((resolve) => {
        setTimeout(() => {
          stdout.emit('data', decoded.output);
          resolve(decoded.exitCode);
        }, 5);
      });
      return { pid: 1500 + turn, stdout, stderr, exitPromise };
    });

    await orchestrator.runCycle(forum.id);

    const reply = queries.getAgentForumMessages(forum.id).find((message) => message.author_name === 'AgentA');
    expect(reply).toMatchObject({
      parent_message_id: userMsg.id,
      content: 'Привет',
    });
  });

  it('prevents agent from replying to its own message and from replying twice to the same message', async () => {
    const forum = queries.createAgentForum('Reply Constraint Test');
    const m1 = queries.createAgentForumMember(forum.id, 'AgentA', 'architect');
    const m2 = queries.createAgentForumMember(forum.id, 'AgentB', 'developer');

    const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Hello');
    const a1Msg = queries.createAgentForumMessage(forum.id, 'agent', m1.id, 'AgentA', 'architect', 'Reply from A', userMsg.id);

    // Check replied target IDs for Agent A:
    const repliedA = queries.getAgentRepliedTargetMessageIds(forum.id, m1.id);
    expect(repliedA.has(userMsg.id)).toBe(true);

    // If Agent A attempts to reply to userMsg again, it should fail validation
    const availableTargetsForA = new Set<string>();
    // Available targets for A excludes userMsg (already replied) and a1Msg (own message)
    // Hence availableTargetsForA is empty

    expect(() => {
      extractStructuredReplies(
        JSON.stringify({ replies: [{ replyTo: userMsg.id, content: 'Duplicate reply' }] }),
        { availableTargetIds: availableTargetsForA, maxReplyLength: 1024 }
      );
    }).toThrow(/Invalid reply target/);

    expect(() => {
      extractStructuredReplies(
        JSON.stringify({ replies: [{ replyTo: a1Msg.id, content: 'Self reply' }] }),
        { availableTargetIds: availableTargetsForA, maxReplyLength: 1024 }
      );
    }).toThrow(/Invalid reply target/);

    // Agent B can reply to both userMsg and a1Msg
    const availableTargetsForB = new Set([userMsg.id, a1Msg.id]);
    const bReplies = extractStructuredReplies(
      JSON.stringify({
        replies: [
          { replyTo: userMsg.id, content: 'B replying to user' },
          { replyTo: a1Msg.id, content: 'B replying to A' },
        ],
      }),
      { availableTargetIds: availableTargetsForB, maxReplyLength: 1024 }
    );
    expect(bReplies).toHaveLength(2);
  });

  it('preserves prior messages when a turn fails', async () => {
    const forum = queries.createAgentForum('Failure Resilience Test');
    const m1 = queries.createAgentForumMember(forum.id, 'AgentA', 'architect');
    const m2 = queries.createAgentForumMember(forum.id, 'AgentB', 'developer');

    const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Root question');

    let turn = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      turn++;
      const currentTurn = turn;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      const exitPromise = new Promise<number>((resolve) => {
        setTimeout(() => {
          if (currentTurn === 1) {
            // Agent A succeeds
            stdout.emit('data', JSON.stringify({
              replies: [{ replyTo: userMsg.id, content: 'Valid reply from A' }],
            }));
            resolve(0);
          } else {
            // Agent B crashes / exits non-zero
            stderr.emit('data', 'Process crash: Out of memory');
            resolve(1);
          }
        }, 10);
      });

      return { pid: 2000 + currentTurn, stdout, stderr, exitPromise };
    });

    await orchestrator.runCycle(forum.id);

    // Messages should retain userMsg and Agent A's reply
    const messages = queries.getAgentForumMessages(forum.id);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Valid reply from A');

    // Turns should record Agent A as completed, Agent B as failed
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns[0].status).toBe('completed');
    expect(turns[1].status).toBe('failed');
    expect(turns[1].error_message).toContain('exit code 1');
  });

  it('rotates starting agent across cycles (round-robin)', async () => {
    const forum = queries.createAgentForum('Rotation Test');
    queries.createAgentForumMember(forum.id, 'AgentA', 'roleA', '', { sortOrder: 0 });
    queries.createAgentForumMember(forum.id, 'AgentB', 'roleB', '', { sortOrder: 1 });
    queries.createAgentForumMember(forum.id, 'AgentC', 'roleC', '', { sortOrder: 2 });

    const orderLog: string[][] = [];

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async (_dir, prompt) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();

      // Determine speaking agent from prompt
      let agentName = '';
      if (prompt.includes('You are AgentA')) agentName = 'AgentA';
      else if (prompt.includes('You are AgentB')) agentName = 'AgentB';
      else if (prompt.includes('You are AgentC')) agentName = 'AgentC';

      if (orderLog.length === 0 || orderLog[orderLog.length - 1].length === 3) {
        orderLog.push([agentName]);
      } else {
        orderLog[orderLog.length - 1].push(agentName);
      }

      const exitPromise = new Promise<number>((resolve) => {
        setTimeout(() => {
          stdout.emit('data', JSON.stringify({ replies: [] }));
          resolve(0);
        }, 10);
      });

      return { pid: 3000 + Math.floor(Math.random() * 1000), stdout, stderr, exitPromise };
    });

    // Cycle 1
    await orchestrator.runCycle(forum.id);
    // Cycle 2
    await orchestrator.runCycle(forum.id);
    // Cycle 3
    await orchestrator.runCycle(forum.id);

    expect(orderLog[0]).toEqual(['AgentA', 'AgentB', 'AgentC']);
    expect(orderLog[1]).toEqual(['AgentB', 'AgentC', 'AgentA']);
    expect(orderLog[2]).toEqual(['AgentC', 'AgentA', 'AgentB']);
  });
});
