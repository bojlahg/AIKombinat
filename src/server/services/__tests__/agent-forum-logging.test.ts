import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { logger } from '../../logging/logger.js';
import type { LogRecord, LogSink } from '../../logging/types.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

const queries = await import('../../db/queries.js');
const { AgentForumOrchestrator } = await import('../agent-forum-orchestrator.js');
const { claudeManager } = await import('../claude-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');

interface CapturingSink extends LogSink {
  records: LogRecord[];
}

function capturingSink(): CapturingSink {
  const records: LogRecord[] = [];
  return { records, write: (record) => { records.push(record); } };
}

/**
 * Simulates one CLI run per turn. `claudeManager.startClaude` is always mocked:
 * no test in this file may reach a real Claude/Codex/Antigravity binary, spawn a
 * process, or signal one.
 */
function mockTurns(turns: Array<{ stdout?: string; stderr?: string; exitCode: number }>) {
  let callIndex = 0;
  return vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
    const turn = turns[Math.min(callIndex, turns.length - 1)];
    callIndex++;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exitPromise = new Promise<number>((resolve) => {
      setTimeout(() => {
        if (turn.stdout) stdout.emit('data', turn.stdout);
        if (turn.stderr) stderr.emit('data', turn.stderr);
        resolve(turn.exitCode);
      }, 5);
    });
    return {
      pid: 90000 + callIndex,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      stdin: null,
      exitPromise,
      command: 'claude',
      args: [],
    };
  });
}

function eventsOf(sink: CapturingSink): string[] {
  return sink.records.map(r => r.event);
}

function findRecord(sink: CapturingSink, event: string): LogRecord | undefined {
  return sink.records.find(r => r.event === event);
}

describe('AgentForum diagnostics', () => {
  let workspace: TestWorkspace;
  let orchestrator: InstanceType<typeof AgentForumOrchestrator>;
  let sink: CapturingSink;

  beforeEach(() => {
    workspace = createTestWorkspace('forum-logging-test');
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    initDatabase(testDb);
    orchestrator = new AgentForumOrchestrator();
    sink = capturingSink();
    logger.configure({ level: 'debug', sinks: [sink] });
  });

  afterEach(() => {
    logger.configure({ level: 'info', dir: null });
    testDb.close();
    workspace.cleanup();
    vi.restoreAllMocks();
  });

  function seedForum(title = 'test') {
    const forum = queries.createAgentForum(title, undefined, 1024);
    queries.createAgentForumMember(forum.id, 'Claude', 'architect');
    queries.createAgentForumMember(forum.id, 'Codex', 'developer');
    const userMsg = queries.createAgentForumMessage(
      forum.id, 'user', null, 'User', 'User', 'What cache should we use?',
    );
    return { forum, userMsg };
  }

  it('logs cycle start, turn start and a clean cycle summary', async () => {
    const { forum, userMsg } = seedForum();
    mockTurns([
      { stdout: JSON.stringify({ replies: [{ replyTo: userMsg.id, content: 'Use an LRU.' }] }), exitCode: 0 },
      { stdout: JSON.stringify({ replies: [] }), exitCode: 0 },
    ]);

    await orchestrator.runCycle(forum.id);

    expect(eventsOf(sink)).toContain('forum.cycle.started');
    expect(eventsOf(sink)).toContain('forum.turn.started');
    expect(eventsOf(sink)).toContain('forum.turn.completed');
    expect(eventsOf(sink)).toContain('forum.turn.passed');

    const started = findRecord(sink, 'forum.cycle.started')!;
    expect(started.level).toBe('info');
    expect(started.scope).toBe('[forum:test]');
    expect(started.msg).toBe('cycle #1 started');

    const turnStarted = findRecord(sink, 'forum.turn.started')!;
    expect(turnStarted.scope).toBe('[forum:test][Claude]');
    expect(turnStarted.fields.provider).toBeDefined();

    const summary = findRecord(sink, 'forum.cycle.finished')!;
    expect(summary.level).toBe('info');
    expect(summary.msg).toBe('cycle #1 finished');
    expect(summary.fields).toMatchObject({ completed: 1, passed: 1, skipped: 0, failed: 0 });
  });

  it('logs a non-zero exit as a turn failure and downgrades the cycle summary', async () => {
    const { forum } = seedForum();
    mockTurns([{ stdout: '', stderr: 'Authentication required. Please login.', exitCode: 1 }]);

    await orchestrator.runCycle(forum.id);

    const failed = findRecord(sink, 'forum.turn.failed')!;
    expect(failed.level).toBe('error');
    expect(failed.scope).toBe('[forum:test][Claude]');
    expect(failed.msg).toMatch(/^FAILED after /);
    expect(failed.fields.exitCode).toBe(1);
    expect(String(failed.fields.message)).toContain('exit code 1');
    expect(failed.detail).toContain('Authentication required');

    const summary = findRecord(sink, 'forum.cycle.finished-with-problems')!;
    expect(summary.level).toBe('warn');
    expect(summary.fields).toMatchObject({ failed: 2, completed: 0, passed: 0 });
    expect(findRecord(sink, 'forum.cycle.finished')).toBeUndefined();
  });

  it('logs unusable structured output as a failure with its category', async () => {
    const { forum } = seedForum();
    mockTurns([{ stdout: 'I think we should use Redis, actually.', exitCode: 0 }]);

    await orchestrator.runCycle(forum.id);

    const failed = findRecord(sink, 'forum.turn.failed')!;
    expect(failed.fields.category).toBe('invalid_structured_output');
    expect(failed.level).toBe('error');
  });

  it('logs a quota-exhausted turn as a WARN skip, with the reason', async () => {
    const { forum } = seedForum();
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'usage limit reached',
    });
    mockTurns([{ stdout: JSON.stringify({ replies: [] }), exitCode: 0 }]);

    try {
      await orchestrator.runCycle(forum.id);
    } finally {
      providerQuotaService.markUnknown('claude', { source: 'test-cleanup' });
    }

    const quota = findRecord(sink, 'provider.quota.exhausted')!;
    expect(quota.level).toBe('warn');
    expect(quota.scope).toBe('[provider:claude]');
    expect(quota.fields).toMatchObject({ provider: 'claude', reason: 'usage limit reached' });

    const skipped = findRecord(sink, 'forum.turn.skipped')!;
    expect(skipped.level).toBe('warn');
    expect(skipped.msg).toMatch(/^SKIPPED after /);
    expect(String(skipped.fields.reason)).toContain('quota exhausted');

    const summary = findRecord(sink, 'forum.cycle.finished-with-problems')!;
    expect(summary.fields.skipped).toBeGreaterThan(0);
  });

  it('logs a refused cycle when the forum has too few participants', async () => {
    const forum = queries.createAgentForum('lonely', undefined, 1024);
    queries.createAgentForumMember(forum.id, 'Claude', 'architect');

    await orchestrator.runCycle(forum.id);

    const record = findRecord(sink, 'forum.cycle.not-enough-members')!;
    expect(record.level).toBe('warn');
    expect(record.fields.activeMembers).toBe(1);
  });

  it('logs stop as requested and the cycle summary as stopped', async () => {
    const { forum, userMsg } = seedForum();
    mockTurns([
      { stdout: JSON.stringify({ replies: [{ replyTo: userMsg.id, content: 'ok' }] }), exitCode: 0 },
      { stdout: JSON.stringify({ replies: [] }), exitCode: 0 },
    ]);
    vi.spyOn(claudeManager, 'stopClaude').mockResolvedValue(undefined);

    const cycle = orchestrator.runCycle(forum.id);
    await orchestrator.stopForum(forum.id);
    await cycle;

    expect(findRecord(sink, 'forum.stop.requested')?.level).toBe('info');
    expect(findRecord(sink, 'forum.cycle.stopped')?.level).toBe('warn');
  });

  it('sanitizes a hostile forum title and member name in the scope tag', async () => {
    const forum = queries.createAgentForum('bad\ntitle token=leakedsecret9999', undefined, 1024);
    queries.createAgentForumMember(forum.id, 'Agent\nERROR forged', 'architect');
    queries.createAgentForumMember(forum.id, 'Codex', 'developer');
    queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Question?');
    mockTurns([{ stdout: JSON.stringify({ replies: [] }), exitCode: 0 }]);

    await orchestrator.runCycle(forum.id);

    const turnStarted = findRecord(sink, 'forum.turn.started')!;
    expect(turnStarted).toBeDefined();
    expect(turnStarted.scope).not.toMatch(/[\r\n]/);
    expect(turnStarted.scope).not.toContain('leakedsecret9999');
    expect(turnStarted.scope).toBe('[forum:bad title token=***redacted***][Agent ERROR forged]');

    for (const record of sink.records) {
      expect(record.scope).not.toMatch(/[\r\n]/);
      expect(record.scope).not.toContain('leakedsecret9999');
    }
  });

  it('never writes the prompt or the full provider output to the log', async () => {
    const { forum, userMsg } = seedForum('secret project');
    const hugeOutput = 'X'.repeat(50_000);
    mockTurns([{ stdout: hugeOutput, stderr: hugeOutput, exitCode: 1 }]);

    await orchestrator.runCycle(forum.id);

    const rendered = sink.records
      .map(r => `${r.msg} ${r.detail ?? ''} ${JSON.stringify(r.fields)}`)
      .join('\n');
    // The turn prompt embeds the forum's messages; none of it may be logged.
    expect(rendered).not.toContain('What cache should we use?');
    expect(rendered).not.toContain(userMsg.content);
    // The stderr tail is bounded, not the whole 50 KB.
    expect(rendered.length).toBeLessThan(30_000);
    expect(findRecord(sink, 'forum.turn.failed')?.detail).toContain('truncated');
  });
});
