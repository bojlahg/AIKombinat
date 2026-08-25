import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { initDatabase } from '../../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDatabase: () => testDb,
}));

const queries = await import('../../db/queries.js');
const {
  AgentForumOrchestrator,
  FORUM_TEMP_ROOT,
  ForumStopTimeoutError,
  ForumRecoveryPendingError,
} = await import('../agent-forum-orchestrator.js');
const processTree = await import('../../utils/process-tree.js');
const { executorPool } = await import('../executor-pool.js');
const { claudeManager } = await import('../claude-manager.js');
const { providerQuotaService } = await import('../provider-quota.js');
const cliStatusModule = await import('../cli-status.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Mock CLI process handle. `resolveExit` is what a test uses to make the fake
 * process terminate. Nothing in this file ever spawns a real provider CLI.
 */
function createMockProcess(pid: number) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = (code: number) => {
      stdout.end();
      stderr.end();
      resolve(code);
    };
  });
  return {
    pid,
    stdout,
    stderr,
    stdin: null,
    exitPromise,
    resolveExit,
    command: 'claude',
    args: [] as string[],
  };
}

function replyPayload(replyTo: string, content: string): string {
  return JSON.stringify({ replies: [{ replyTo, content }] });
}

const PASS_PAYLOAD = JSON.stringify({ replies: [] });

/** Lets pending microtasks and stream 'data' events settle. */
async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('AgentForum lifecycle hardening', () => {
  let workspace: TestWorkspace;
  let orchestrator: InstanceType<typeof AgentForumOrchestrator>;

  beforeEach(() => {
    workspace = createTestWorkspace('forum-hardening');
    testDb = new Database(':memory:');
    initDatabase(testDb);
    orchestrator = new AgentForumOrchestrator();
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    cliStatusModule.clearCache();
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined);
    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: true,
      version: '1.0.0',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    executorPool.resetLimits();
    executorPool.resetReservations();
    providerQuotaService.resetForTesting();
    cliStatusModule.clearCache();
    testDb.close();
    workspace.cleanup();
  });

  function seedForum(title = 'Hardening Forum') {
    const forum = queries.createAgentForum(title, undefined, 1024);
    const a = queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
    const b = queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });
    const userMsg = queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Root question');
    return { forum, a, b, userMsg };
  }

  // ── 1. Provider concurrency: reservation lifetime ──────────────────────────

  it('keeps a running forum turn visible to provider concurrency accounting', async () => {
    executorPool.setLimit('claude', 1);
    const { forum, userMsg } = seedForum();

    const spawned = deferred();
    const processes: ReturnType<typeof createMockProcess>[] = [];

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      const proc = createMockProcess(9100 + processes.length);
      processes.push(proc);
      if (processes.length === 1) spawned.resolve();
      return proc as never;
    });

    const cyclePromise = orchestrator.runCycle(forum.id);
    await spawned.promise;

    // The in-flight turn occupies the single Claude slot...
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);
    expect(executorPool.hasAvailableSlot('claude')).toBe(false);
    // ...so an unrelated execution cannot take it.
    expect(executorPool.reserveSlot('other-execution', 'claude')).toBe(false);
    executorPool.releaseReservation('other-execution');

    processes[0].stdout.write(replyPayload(userMsg.id, 'A reply'));
    processes[0].resolveExit(0);
    await settle();

    if (processes[1]) {
      processes[1].stdout.write(PASS_PAYLOAD);
      processes[1].resolveExit(0);
    }
    await cyclePromise;

    // Every turn released its slot after its process exited.
    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
    expect(executorPool.getReservations()).toHaveLength(0);
    expect(processes).toHaveLength(2);
  });

  it('releases the provider slot when the spawn itself fails', async () => {
    executorPool.setLimit('claude', 1);
    const { forum } = seedForum();

    vi.spyOn(claudeManager, 'startClaude').mockRejectedValue(new Error('claude not found on PATH'));

    await orchestrator.runCycle(forum.id);

    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
    expect(executorPool.getReservations()).toHaveLength(0);
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns).toHaveLength(2);
    expect(turns[0].status).toBe('failed');
    expect(turns[0].error_message).toContain('claude not found');
  });

  it('keeps a second forum out of the provider slot held by a running forum turn', async () => {
    executorPool.setLimit('claude', 1);
    const first = seedForum('Forum One');
    const second = seedForum('Forum Two');

    const spawned = deferred();
    const processes: ReturnType<typeof createMockProcess>[] = [];
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      const proc = createMockProcess(9200 + processes.length);
      processes.push(proc);
      if (processes.length === 1) spawned.resolve();
      return proc as never;
    });

    const firstCycle = orchestrator.runCycle(first.forum.id);
    await spawned.promise;

    const secondOrchestrator = new AgentForumOrchestrator();
    await secondOrchestrator.runCycle(second.forum.id);

    // No turn of the second forum was allowed to spawn.
    const secondTurns = queries.getAgentForumTurns(second.forum.id);
    expect(secondTurns).toHaveLength(2);
    for (const turn of secondTurns) {
      expect(turn.status).toBe('skipped');
      expect(turn.error_message).toMatch(/concurrency limit/i);
    }
    expect(processes).toHaveLength(1);

    // Once the first process exits, the slot frees up again.
    processes[0].stdout.write(PASS_PAYLOAD);
    processes[0].resolveExit(0);
    await settle();
    if (processes[1]) {
      processes[1].stdout.write(PASS_PAYLOAD);
      processes[1].resolveExit(0);
    }
    await firstCycle;
    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
  });

  // ── 2. Stop-before-spawn race ──────────────────────────────────────────────

  it('Stop during executor selection prevents any CLI from launching', async () => {
    const { forum, a } = seedForum();
    const claudeModel = queries.addModel('claude', 'claude-opus-5', 'Claude Opus 5', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'forum-slow-profile',
      name: 'Forum Slow Profile',
      description: '',
      executors: [{ cli_model_id: claudeModel.id, effort_value: 'high', priority: 1 }],
    });
    queries.updateAgentForumMember(a.id, { execution_profile_id: profile.id, cli_tool: null });

    const selectionEntered = deferred();
    const selectionGate = deferred();
    const realSelect = executorPool.selectExecutor.bind(executorPool);
    vi.spyOn(executorPool, 'selectExecutor').mockImplementation(async (input) => {
      selectionEntered.resolve();
      await selectionGate.promise;
      return realSelect(input);
    });

    const startSpy = vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      throw new Error('startClaude must not be called after Stop');
    });

    const cyclePromise = orchestrator.runCycle(forum.id);
    await selectionEntered.promise;

    const stopPromise = orchestrator.stopForum(forum.id);
    await settle(1);
    selectionGate.resolve();
    await stopPromise;
    await cyclePromise;

    expect(startSpy).not.toHaveBeenCalled();
    // Only the seed user message survives — no replies were created.
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(executorPool.getReservations()).toHaveLength(0);
  });

  it('Stop immediately before spawn leaves no CLI running and creates no replies', async () => {
    const { forum, userMsg } = seedForum();

    const spawnRequested = deferred();
    const spawnGate = deferred();
    const stoppedPids: number[] = [];
    const processes: ReturnType<typeof createMockProcess>[] = [];

    vi.spyOn(claudeManager, 'stopClaude').mockImplementation(async (pid: number) => {
      stoppedPids.push(pid);
      processes.find((p) => p.pid === pid)?.resolveExit(143);
    });

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      spawnRequested.resolve();
      await spawnGate.promise;
      const proc = createMockProcess(9300 + processes.length);
      processes.push(proc);
      // Output that would create a reply if a stale turn were still accepted.
      proc.stdout.write(replyPayload(userMsg.id, 'reply that must never land'));
      return proc as never;
    });

    const cyclePromise = orchestrator.runCycle(forum.id);
    await spawnRequested.promise;

    const stopPromise = orchestrator.stopForum(forum.id);
    // Let Stop reach its drain step before the spawn is allowed to complete.
    await settle(1);
    spawnGate.resolve();
    await stopPromise;
    await cyclePromise;

    // The process that won the spawn race was terminated and its output refused.
    expect(processes).toHaveLength(1);
    expect(stoppedPids).toContain(processes[0].pid);
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(1);
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns.some((t) => t.status === 'completed')).toBe(false);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(executorPool.getReservations()).toHaveLength(0);
  });

  it('Stop racing with spawn completion never accepts the stale turn output', async () => {
    const { forum, userMsg } = seedForum();

    const spawnGate = deferred();
    const spawnRequested = deferred();
    const processes: ReturnType<typeof createMockProcess>[] = [];

    vi.spyOn(claudeManager, 'stopClaude').mockImplementation(async (pid: number) => {
      processes.find((p) => p.pid === pid)?.resolveExit(143);
    });

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      const proc = createMockProcess(9350 + processes.length);
      processes.push(proc);
      spawnRequested.resolve();
      await spawnGate.promise;
      // The process "finishes successfully" exactly while Stop is in flight.
      proc.stdout.write(replyPayload(userMsg.id, 'late reply'));
      proc.resolveExit(0);
      return proc as never;
    });

    const cyclePromise = orchestrator.runCycle(forum.id);
    await spawnRequested.promise;

    const stopPromise = orchestrator.stopForum(forum.id);
    await settle(1);
    spawnGate.resolve();
    await stopPromise;
    await cyclePromise;

    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(1);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
    expect(executorPool.getReservations()).toHaveLength(0);
  });

  it('Stop releases the provider slot only after the process terminates', async () => {
    executorPool.setLimit('claude', 1);
    const { forum } = seedForum();

    const spawned = deferred();
    const processes: ReturnType<typeof createMockProcess>[] = [];
    const slotsAtTermination: number[] = [];

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      const proc = createMockProcess(9400 + processes.length);
      processes.push(proc);
      if (processes.length === 1) spawned.resolve();
      return proc as never;
    });

    vi.spyOn(claudeManager, 'stopClaude').mockImplementation(async (pid: number) => {
      // The slot must still be accounted for at the moment termination starts.
      slotsAtTermination.push(executorPool.getActiveToolUsage('claude'));
      processes.find((p) => p.pid === pid)?.resolveExit(143);
    });

    const cyclePromise = orchestrator.runCycle(forum.id);
    await spawned.promise;
    expect(executorPool.getActiveToolUsage('claude')).toBe(1);

    await orchestrator.stopForum(forum.id);
    await cyclePromise;

    expect(slotsAtTermination[0]).toBe(1);
    expect(executorPool.getActiveToolUsage('claude')).toBe(0);
    expect(executorPool.getReservations()).toHaveLength(0);
  });

  // ── 3. Discussion-only execution ───────────────────────────────────────────

  it('runs a project-linked forum in a temporary directory, never in the project root', async () => {
    const projectDir = workspace.createSubdir('linked-project');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Project contract\nBe careful.');
    const project = queries.createProject('Linked Project', projectDir);
    const forum = queries.createAgentForum('Project Forum', undefined, 1024, project.id);
    queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
    queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });
    queries.createAgentForumMessage(forum.id, 'user', null, 'User', 'User', 'Root question');

    interface Launch {
      workDir: string;
      projectPath: string;
      sandboxMode: string;
      extraOptions: string | undefined;
      prompt: string;
      promptPolicy: string | undefined;
    }
    const launches: Launch[] = [];

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async (
      workDir, prompt, _model, extraOptions, _mode, _tool, _maxTurns, projectPath, sandboxMode,
      _cont, _cols, _rows, _effort, promptPolicy,
    ) => {
      launches.push({
        workDir,
        projectPath: projectPath as string,
        sandboxMode: sandboxMode as string,
        extraOptions,
        prompt,
        promptPolicy: promptPolicy as string | undefined,
      });
      const proc = createMockProcess(9500 + launches.length);
      proc.stdout.write(PASS_PAYLOAD);
      proc.resolveExit(0);
      return proc as never;
    });

    const projectFilesBefore = fs.readdirSync(projectDir).sort();

    await orchestrator.runCycle(forum.id);

    expect(launches).toHaveLength(2);
    for (const launch of launches) {
      expect(launch.workDir).not.toBe(projectDir);
      expect(launch.projectPath).not.toBe(projectDir);
      // cwd and the writable root are the same throwaway directory.
      expect(launch.workDir).toBe(launch.projectPath);
      // ...and that directory lives under the approved temporary root.
      const relative = path.relative(FORUM_TEMP_ROOT, launch.workDir);
      expect(relative.startsWith('..')).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
      // Strict mode is forced; project CLI options are not inherited.
      expect(launch.sandboxMode).toBe('strict');
      expect(launch.extraOptions).toBeUndefined();
      expect(launch.promptPolicy).toBe('discussion');
      // Project context arrives as prompt text, not as a checkout.
      expect(launch.prompt).toContain('# Project contract');
      expect(launch.prompt).toContain('This is a discussion only.');
      expect(launch.prompt).toContain('Do NOT commit or push');
    }

    // The project tree is untouched.
    expect(fs.readdirSync(projectDir).sort()).toEqual(projectFilesBefore);
  });

  it('forces strict sandbox mode even when the linked project is permissive', async () => {
    const projectDir = workspace.createSubdir('permissive-project');
    const project = queries.createProject('Permissive Project', projectDir);
    queries.updateProject(project.id, { sandbox_mode: 'permissive' });
    const forum = queries.createAgentForum('Permissive Forum', undefined, 1024, project.id);
    queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
    queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });

    const sandboxModes: string[] = [];
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async (
      _workDir, _prompt, _model, _opts, _mode, _tool, _maxTurns, _projectPath, sandboxMode,
    ) => {
      sandboxModes.push(sandboxMode as string);
      const proc = createMockProcess(9600 + sandboxModes.length);
      proc.stdout.write(PASS_PAYLOAD);
      proc.resolveExit(0);
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);
    expect(sandboxModes).toEqual(['strict', 'strict']);
  });

  it('treats missing project context files as normal, not an error', async () => {
    const projectDir = workspace.createSubdir('empty-project');
    const project = queries.createProject('Empty Project', projectDir);
    const forum = queries.createAgentForum('Empty Context Forum', undefined, 1024, project.id);
    queries.createAgentForumMember(forum.id, 'AgentA', 'participant', '', { cliTool: 'claude', sortOrder: 0 });
    queries.createAgentForumMember(forum.id, 'AgentB', 'participant', '', { cliTool: 'claude', sortOrder: 1 });

    const prompts: string[] = [];
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async (_workDir, prompt) => {
      prompts.push(prompt);
      const proc = createMockProcess(9700 + prompts.length);
      proc.stdout.write(PASS_PAYLOAD);
      proc.resolveExit(0);
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);

    expect(prompts[0]).toContain('Empty Project');
    expect(prompts[0]).toContain('No AGENTS.md');
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns.every((t) => t.status === 'passed')).toBe(true);
  });

  // ── 4. waiting_quota is handled explicitly ─────────────────────────────────

  it('handles a waiting_quota execution profile without crashing', async () => {
    const { forum, a, b } = seedForum();
    const claudeModel = queries.addModel('claude', 'claude-opus-5', 'Claude Opus 5', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'quota-only-profile',
      name: 'Quota Only Profile',
      description: '',
      executors: [{ cli_model_id: claudeModel.id, effort_value: 'high', priority: 1 }],
    });
    queries.updateAgentForumMember(a.id, { execution_profile_id: profile.id, cli_tool: null });
    queries.updateAgentForumMember(b.id, { execution_profile_id: profile.id, cli_tool: null });

    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'usage limit reached',
    });

    const startSpy = vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      throw new Error('no CLI should launch when the provider quota is exhausted');
    });

    const selection = await executorPool.selectExecutor({ executionProfileId: profile.id });
    expect(selection.status).toBe('waiting_quota');

    await orchestrator.runCycle(forum.id);

    expect(startSpy).not.toHaveBeenCalled();
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      // Transient capacity state, not an internal TypeError.
      expect(turn.status).toBe('skipped');
      expect(turn.error_message).toMatch(/quota exhausted/i);
      expect(turn.error_message).not.toMatch(/undefined|TypeError/i);
    }
    // Cycle state stays consistent afterwards.
    const finalForum = queries.getAgentForumById(forum.id)!;
    expect(finalForum.status).toBe('idle');
    expect(finalForum.current_member_id).toBeNull();
    expect(executorPool.getReservations()).toHaveLength(0);
  });

  it('records no_candidates as a failed turn without dereferencing a missing config', async () => {
    const { forum, a, b } = seedForum();
    const claudeModel = queries.addModel('claude', 'claude-opus-5', 'Claude Opus 5', ['high']);
    const profile = queries.createExecutionProfile({
      slug: 'uninstalled-profile',
      name: 'Uninstalled Profile',
      description: '',
      executors: [{ cli_model_id: claudeModel.id, effort_value: 'high', priority: 1 }],
    });
    queries.updateAgentForumMember(a.id, { execution_profile_id: profile.id, cli_tool: null });
    queries.updateAgentForumMember(b.id, { execution_profile_id: profile.id, cli_tool: null });

    cliStatusModule.clearCache();
    vi.spyOn(cliStatusModule, 'getToolStatus').mockImplementation(async (tool) => ({
      tool,
      installed: false,
      version: null,
    }));

    const startSpy = vi.spyOn(claudeManager, 'startClaude');

    await orchestrator.runCycle(forum.id);

    expect(startSpy).not.toHaveBeenCalled();
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns.every((t) => t.status === 'failed')).toBe(true);
    expect(turns[0].error_message).toMatch(/No eligible executors/i);
    expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
  });

  it('skips a turn when the direct (profile-less) provider quota is exhausted', async () => {
    const { forum } = seedForum();
    providerQuotaService.markExhausted('claude', {
      source: 'runtime_rejection',
      reason: 'daily limit',
    });

    const startSpy = vi.spyOn(claudeManager, 'startClaude');
    await orchestrator.runCycle(forum.id);

    expect(startSpy).not.toHaveBeenCalled();
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns.every((t) => t.status === 'skipped')).toBe(true);
    expect(executorPool.getReservations()).toHaveLength(0);
  });

  // ── 5. Chunk-safe stdout/stderr collection ─────────────────────────────────

  it('reassembles a stream-json event split across two chunks', async () => {
    const { forum, userMsg } = seedForum();
    const event = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: replyPayload(userMsg.id, 'Split across two chunks') }] },
    });
    const cut = Math.floor(event.length / 2);

    let call = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      call++;
      const proc = createMockProcess(9800 + call);
      if (call === 1) {
        proc.stdout.write(event.slice(0, cut));
        setImmediate(() => {
          proc.stdout.write(event.slice(cut) + '\n');
          proc.resolveExit(0);
        });
      } else {
        proc.stdout.write(PASS_PAYLOAD);
        proc.resolveExit(0);
      }
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);

    const messages = queries.getAgentForumMessages(forum.id);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Split across two chunks');
  });

  it('reassembles a stream-json event split across three chunks', async () => {
    const { forum, userMsg } = seedForum();
    const event = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: replyPayload(userMsg.id, 'Split across three chunks') }] },
    });
    const third = Math.floor(event.length / 3);

    let call = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      call++;
      const proc = createMockProcess(9850 + call);
      if (call === 1) {
        proc.stdout.write(event.slice(0, third));
        setImmediate(() => {
          proc.stdout.write(event.slice(third, third * 2));
          setImmediate(() => {
            proc.stdout.write(event.slice(third * 2) + '\n');
            proc.resolveExit(0);
          });
        });
      } else {
        proc.stdout.write(PASS_PAYLOAD);
        proc.resolveExit(0);
      }
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);

    const messages = queries.getAgentForumMessages(forum.id);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Split across three chunks');
  });

  it('handles several JSON lines followed by an unterminated partial tail', async () => {
    const { forum, userMsg } = seedForum();
    const noise = JSON.stringify({ type: 'system', subtype: 'init' });
    const tail = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: replyPayload(userMsg.id, 'Tail reply survives') }] },
    });
    const cut = tail.length - 12;

    let call = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      call++;
      const proc = createMockProcess(9900 + call);
      if (call === 1) {
        // Two complete lines plus the beginning of a third, then the rest with
        // NO trailing newline — the tail must still be flushed on exit.
        proc.stdout.write(noise + '\n' + noise + '\n' + tail.slice(0, cut));
        setImmediate(() => {
          proc.stdout.write(tail.slice(cut));
          proc.resolveExit(0);
        });
      } else {
        proc.stdout.write(PASS_PAYLOAD);
        proc.resolveExit(0);
      }
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);

    const messages = queries.getAgentForumMessages(forum.id);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('Tail reply survives');
  });

  it('classifies a quota rejection that appears only on stderr', async () => {
    const { forum } = seedForum();

    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      const proc = createMockProcess(9950);
      proc.stderr.write('Claude usage limit reached. Try again later.\n');
      proc.resolveExit(1);
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);

    expect(providerQuotaService.getQuotaState('claude').state).toBe('exhausted');
    const turns = queries.getAgentForumTurns(forum.id);
    expect(turns[0].status).toBe('failed');
    expect(turns[0].error_message).toMatch(/usage limit reached/i);
    expect(turns[0].raw_output).toContain('usage limit reached');
  });

  // ── 7. Historical turns survive participant removal ────────────────────────

  it('keeps turns and snapshots when a participant with history is soft-disabled', async () => {
    const { forum, a, userMsg } = seedForum();

    let call = 0;
    vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
      call++;
      const proc = createMockProcess(9990 + call);
      proc.stdout.write(call === 1 ? replyPayload(userMsg.id, 'A speaks') : PASS_PAYLOAD);
      proc.resolveExit(0);
      return proc as never;
    });

    await orchestrator.runCycle(forum.id);

    const turnsBefore = queries.getAgentForumTurns(forum.id);
    expect(turnsBefore).toHaveLength(2);
    expect(queries.agentForumMemberHasHistory(a.id)).toBe(true);

    queries.setAgentForumMemberActive(a.id, false);

    // History is fully preserved.
    const turnsAfter = queries.getAgentForumTurns(forum.id);
    expect(turnsAfter).toHaveLength(2);
    expect(turnsAfter.map((t) => t.id).sort()).toEqual(turnsBefore.map((t) => t.id).sort());
    expect(turnsAfter.find((t) => t.member_id === a.id)!.execution_snapshot).toBeTruthy();
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(2);

    // The disabled member no longer takes part in cycles.
    expect(queries.getActiveAgentForumMembers(forum.id).map((m) => m.name)).toEqual(['AgentB']);
    expect(queries.getAgentForumMembers(forum.id)).toHaveLength(2);
  });

  it('refuses to start a cycle once too few active participants remain', async () => {
    const { forum, a } = seedForum();
    queries.setAgentForumMemberActive(a.id, false);

    const startSpy = vi.spyOn(claudeManager, 'startClaude');
    await expect(orchestrator.postUserMessage(forum.id, 'Anybody there?')).rejects.toThrow(/at least 2 active participants/i);

    expect(startSpy).not.toHaveBeenCalled();
    // The un-answerable user message was never persisted.
    expect(queries.getAgentForumMessages(forum.id)).toHaveLength(1);
  });

  // ── 9. DB-level invariants ─────────────────────────────────────────────────

  it('rejects a second reply from the same agent to the same target at the DB level', () => {
    const { forum, a, userMsg } = seedForum();
    queries.createAgentForumMessage(forum.id, 'agent', a.id, 'AgentA', 'participant', 'first', userMsg.id);

    expect(() =>
      queries.createAgentForumMessage(forum.id, 'agent', a.id, 'AgentA', 'participant', 'second', userMsg.id)
    ).toThrow(/UNIQUE/i);

    // A different agent replying to the same target is still allowed.
    const { b } = { b: queries.getAgentForumMembers(forum.id)[1] };
    expect(() =>
      queries.createAgentForumMessage(forum.id, 'agent', b.id, 'AgentB', 'participant', 'other agent', userMsg.id)
    ).not.toThrow();

    // Root (unparented) messages from the same agent stay unconstrained.
    expect(() => {
      queries.createAgentForumMessage(forum.id, 'agent', a.id, 'AgentA', 'participant', 'root one');
      queries.createAgentForumMessage(forum.id, 'agent', a.id, 'AgentA', 'participant', 'root two');
    }).not.toThrow();
  });

  it('rejects a duplicate logical turn identity at the DB level', () => {
    const { forum, a } = seedForum();
    queries.createAgentForumTurn(forum.id, a.id, 1, 0);

    expect(() => queries.createAgentForumTurn(forum.id, a.id, 1, 0)).toThrow(/UNIQUE/i);
    expect(() => queries.createAgentForumTurn(forum.id, a.id, 1, 1)).not.toThrow();
    expect(() => queries.createAgentForumTurn(forum.id, a.id, 2, 0)).not.toThrow();
  });

  // ── Stop drain timeout must not be reported as a successful stop ───────────

  describe('Stop drain timeout', () => {
    /** Short drain deadline so the timeout path is exercised without waiting. */
    const DRAIN_TIMEOUT_MS = 60;

    it('fails closed when startup outlives the drain deadline, then completes on retry', async () => {
      executorPool.setLimit('claude', 1);
      const timeoutOrchestrator = new AgentForumOrchestrator({ stopDrainTimeoutMs: DRAIN_TIMEOUT_MS });
      const { forum, userMsg } = seedForum();

      const spawnRequested = deferred();
      const spawnGate = deferred();
      const processes: ReturnType<typeof createMockProcess>[] = [];
      const stoppedPids: number[] = [];

      vi.spyOn(claudeManager, 'stopClaude').mockImplementation(async (pid: number) => {
        stoppedPids.push(pid);
        processes.find((p) => p.pid === pid)?.resolveExit(143);
      });

      // Startup stays unresolved well past the drain deadline.
      vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
        spawnRequested.resolve();
        await spawnGate.promise;
        const proc = createMockProcess(9700 + processes.length);
        processes.push(proc);
        // Output that would become a reply if the stale turn were accepted.
        proc.stdout.write(replyPayload(userMsg.id, 'reply that must never land'));
        return proc as never;
      });

      const cyclePromise = timeoutOrchestrator.runCycle(forum.id);
      await spawnRequested.promise;

      // Stop must NOT report success while the startup is still in flight.
      await expect(timeoutOrchestrator.stopForum(forum.id)).rejects.toBeInstanceOf(ForumStopTimeoutError);

      // The forum is not safely idle, and the cycle is still registered so the
      // route layer refuses to delete or mutate it.
      const afterTimeout = queries.getAgentForumById(forum.id)!;
      expect(afterTimeout.status).not.toBe('idle');
      expect(afterTimeout.status).toBe('error');
      expect(timeoutOrchestrator.isCycleRegistered(forum.id)).toBe(true);

      // No provider capacity is leaked while the startup hangs.
      expect(executorPool.getReservations()).toHaveLength(0);
      expect(executorPool.getActiveToolUsage('claude')).toBe(0);

      // Now the startup finally resolves with a PID.
      spawnGate.resolve();
      await cyclePromise;

      // Cancellation stayed armed: the late process was terminated immediately
      // and its output was refused.
      expect(processes).toHaveLength(1);
      expect(stoppedPids).toContain(processes[0].pid);
      expect(queries.getAgentForumMessages(forum.id)).toHaveLength(1);
      expect(queries.getAgentForumTurns(forum.id).some((t) => t.status === 'completed')).toBe(false);

      // Reservation released, nothing left in flight.
      expect(executorPool.getReservations()).toHaveLength(0);
      expect(timeoutOrchestrator.isCycleRegistered(forum.id)).toBe(false);

      // Retrying Stop after the drain finishes succeeds and lands on idle.
      await expect(timeoutOrchestrator.stopForum(forum.id)).resolves.toBeUndefined();
      expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
      expect(queries.getAgentForumById(forum.id)!.current_member_id).toBeNull();
    });

    it('clears the persisted turn PID once the late process is terminated', async () => {
      const timeoutOrchestrator = new AgentForumOrchestrator({ stopDrainTimeoutMs: DRAIN_TIMEOUT_MS });
      const { forum } = seedForum();

      const spawnRequested = deferred();
      const spawnGate = deferred();
      const processes: ReturnType<typeof createMockProcess>[] = [];

      vi.spyOn(claudeManager, 'stopClaude').mockImplementation(async (pid: number) => {
        processes.find((p) => p.pid === pid)?.resolveExit(143);
      });
      vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
        spawnRequested.resolve();
        await spawnGate.promise;
        const proc = createMockProcess(9750 + processes.length);
        processes.push(proc);
        return proc as never;
      });

      const cyclePromise = timeoutOrchestrator.runCycle(forum.id);
      await spawnRequested.promise;
      await expect(timeoutOrchestrator.stopForum(forum.id)).rejects.toBeInstanceOf(ForumStopTimeoutError);

      spawnGate.resolve();
      await cyclePromise;

      // Nothing is left claiming to own a live process.
      for (const turn of queries.getAgentForumTurns(forum.id)) {
        expect(turn.process_pid).toBeNull();
      }
    });

    it('reports success normally when the startup drains inside the deadline', async () => {
      const timeoutOrchestrator = new AgentForumOrchestrator({ stopDrainTimeoutMs: DRAIN_TIMEOUT_MS });
      const { forum } = seedForum();

      const spawned = deferred();
      const processes: ReturnType<typeof createMockProcess>[] = [];

      vi.spyOn(claudeManager, 'stopClaude').mockImplementation(async (pid: number) => {
        processes.find((p) => p.pid === pid)?.resolveExit(143);
      });
      vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
        const proc = createMockProcess(9800 + processes.length);
        processes.push(proc);
        if (processes.length === 1) spawned.resolve();
        return proc as never;
      });

      const cyclePromise = timeoutOrchestrator.runCycle(forum.id);
      await spawned.promise;

      await expect(timeoutOrchestrator.stopForum(forum.id)).resolves.toBeUndefined();
      await cyclePromise;

      expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
      expect(timeoutOrchestrator.isCycleRegistered(forum.id)).toBe(false);
      expect(executorPool.getReservations()).toHaveLength(0);
    });

    it('persists the PID of a running turn so a crash can find the orphan', async () => {
      const { forum } = seedForum();

      const spawned = deferred();
      const processes: ReturnType<typeof createMockProcess>[] = [];
      vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
        const proc = createMockProcess(9900 + processes.length);
        processes.push(proc);
        if (processes.length === 1) spawned.resolve();
        return proc as never;
      });

      const cyclePromise = orchestrator.runCycle(forum.id);
      await spawned.promise;
      await settle(1);

      const runningTurn = queries.getAgentForumTurns(forum.id).find((t) => t.status === 'running')!;
      expect(runningTurn.process_pid).toBe(processes[0].pid);

      processes[0].stdout.write(PASS_PAYLOAD);
      processes[0].resolveExit(0);
      await settle();
      if (processes[1]) {
        processes[1].stdout.write(PASS_PAYLOAD);
        processes[1].resolveExit(0);
      }
      await cyclePromise;

      // Cleared once the process actually terminated.
      for (const turn of queries.getAgentForumTurns(forum.id)) {
        expect(turn.process_pid).toBeNull();
      }
    });
  });

  // ── Backend state gate for a forum parked in `error` ───────────────────────

  describe('Forum in error state', () => {
    const ORPHAN_PID = 515151;
    /** Fingerprint the turn recorded when it spawned; never a real process. */
    const ORPHAN_IDENTITY = JSON.stringify({ pid: ORPHAN_PID, startedAt: '1699999999', command: 'claude' });

    it('refuses a new user message until recovery succeeds', async () => {
      const { forum } = seedForum();
      queries.updateAgentForum(forum.id, { status: 'error', current_member_id: null });

      const startSpy = vi.spyOn(claudeManager, 'startClaude');

      await expect(orchestrator.postUserMessage(forum.id, 'Carry on?'))
        .rejects.toThrow(/requires recovery/i);

      expect(startSpy).not.toHaveBeenCalled();
      // The un-runnable message was never persisted.
      expect(queries.getAgentForumMessages(forum.id)).toHaveLength(1);
    });

    it('Stop on an error forum retries orphan cleanup and returns it to idle', async () => {
      const { forum, a } = seedForum();
      const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
      queries.updateAgentForumTurn(turn.id, {
        status: 'running',
        process_pid: ORPHAN_PID,
        process_identity: ORPHAN_IDENTITY,
      });
      queries.updateAgentForum(forum.id, { status: 'error', current_member_id: a.id });

      vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
      vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue('match');
      const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(true);

      await expect(orchestrator.stopForum(forum.id)).resolves.toBeUndefined();

      expect(terminateSpy).toHaveBeenCalledWith(ORPHAN_PID);
      const recovered = queries.getAgentForumById(forum.id)!;
      expect(recovered.status).toBe('idle');
      expect(recovered.current_member_id).toBeNull();
      const after = queries.getAgentForumTurnById(turn.id)!;
      expect(after.status).toBe('stopped');
      expect(after.process_pid).toBeNull();

      // The conversation continues normally once the forum is idle again.
      vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
        const proc = createMockProcess(9990);
        proc.stdout.write(PASS_PAYLOAD);
        proc.resolveExit(0);
        return proc as never;
      });
      await expect(orchestrator.postUserMessage(forum.id, 'Carry on?')).resolves.toBeDefined();
    });

    it('Stop on an error forum with a surviving orphan stays failed and retryable', async () => {
      const { forum, a } = seedForum();
      const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
      queries.updateAgentForumTurn(turn.id, {
        status: 'running',
        process_pid: ORPHAN_PID,
        process_identity: ORPHAN_IDENTITY,
      });
      queries.updateAgentForum(forum.id, { status: 'error', current_member_id: a.id });

      const aliveSpy = vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
      vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue('match');
      const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(false);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(orchestrator.stopForum(forum.id)).rejects.toBeInstanceOf(ForumRecoveryPendingError);

      expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
      const stillOrphaned = queries.getAgentForumTurnById(turn.id)!;
      expect(stillOrphaned.process_pid).toBe(ORPHAN_PID);
      expect(stillOrphaned.status).toBe('running');

      // Still refuses new messages while unresolved.
      await expect(orchestrator.postUserMessage(forum.id, 'Carry on?')).rejects.toThrow(/requires recovery/i);

      // Once the orphan exits, retrying Stop completes the cleanup.
      aliveSpy.mockReturnValue(false);
      terminateSpy.mockResolvedValue(true);
      await expect(orchestrator.stopForum(forum.id)).resolves.toBeUndefined();
      expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
      expect(queries.getAgentForumTurnById(turn.id)!.process_pid).toBeNull();
    });

    it('Stop on a persisted running forum with no in-memory cycle runs recovery, not a blind idle', async () => {
      const { forum, a } = seedForum();
      const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
      queries.updateAgentForumTurn(turn.id, {
        status: 'running',
        process_pid: ORPHAN_PID,
        process_identity: ORPHAN_IDENTITY,
      });
      // Marked running on disk, but this process owns no cycle for it — exactly
      // the state a crash or restart leaves behind.
      queries.updateAgentForum(forum.id, { status: 'running', current_cycle: 1, current_member_id: a.id });
      expect(orchestrator.isCycleRegistered(forum.id)).toBe(false);

      const aliveSpy = vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
      vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue('match');
      const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(false);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      // Termination fails and the process survives: Stop must NOT claim success.
      await expect(orchestrator.stopForum(forum.id)).rejects.toBeInstanceOf(ForumRecoveryPendingError);

      expect(terminateSpy).toHaveBeenCalledWith(ORPHAN_PID);
      expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
      const stillOrphaned = queries.getAgentForumTurnById(turn.id)!;
      expect(stillOrphaned.status).toBe('running');
      expect(stillOrphaned.process_pid).toBe(ORPHAN_PID);
      expect(stillOrphaned.process_identity).toBe(ORPHAN_IDENTITY);

      // Once the process is confirmed gone, retrying Stop completes cleanly.
      aliveSpy.mockReturnValue(false);
      await expect(orchestrator.stopForum(forum.id)).resolves.toBeUndefined();
      const recovered = queries.getAgentForumById(forum.id)!;
      expect(recovered.status).toBe('idle');
      expect(recovered.current_member_id).toBeNull();
      const done = queries.getAgentForumTurnById(turn.id)!;
      expect(done.status).toBe('stopped');
      expect(done.process_pid).toBeNull();
      expect(done.process_identity).toBeNull();
    });

    it('Stop on a persisted running forum succeeds when the orphan is terminated', async () => {
      const { forum, a } = seedForum();
      const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
      queries.updateAgentForumTurn(turn.id, {
        status: 'running',
        process_pid: ORPHAN_PID,
        process_identity: ORPHAN_IDENTITY,
      });
      queries.updateAgentForum(forum.id, { status: 'running', current_cycle: 1, current_member_id: a.id });

      vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
      vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue('match');
      const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue(true);

      await expect(orchestrator.stopForum(forum.id)).resolves.toBeUndefined();

      expect(terminateSpy).toHaveBeenCalledWith(ORPHAN_PID);
      expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
      const done = queries.getAgentForumTurnById(turn.id)!;
      expect(done.status).toBe('stopped');
      expect(done.process_pid).toBeNull();
    });

    it('Stop on a persisted running forum never signals a reused PID', async () => {
      const { forum, a } = seedForum();
      const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
      queries.updateAgentForumTurn(turn.id, {
        status: 'running',
        process_pid: ORPHAN_PID,
        process_identity: ORPHAN_IDENTITY,
      });
      queries.updateAgentForum(forum.id, { status: 'running', current_cycle: 1, current_member_id: a.id });

      vi.spyOn(processTree, 'isProcessAlive').mockImplementation((pid) => pid === ORPHAN_PID);
      vi.spyOn(processTree, 'verifyProcessIdentity').mockResolvedValue('mismatch');
      const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(orchestrator.stopForum(forum.id)).rejects.toBeInstanceOf(ForumRecoveryPendingError);

      expect(terminateSpy).not.toHaveBeenCalled();
      expect(queries.getAgentForumById(forum.id)!.status).toBe('error');
      expect(queries.getAgentForumTurnById(turn.id)!.process_pid).toBe(ORPHAN_PID);
    });

    it('Stop on a persisted running forum with nothing left simply goes idle', async () => {
      const { forum, a } = seedForum();
      const turn = queries.createAgentForumTurn(forum.id, a.id, 1, 0);
      queries.updateAgentForumTurn(turn.id, { status: 'passed', completed_at: '2026-08-25T10:00:00Z' });
      queries.updateAgentForum(forum.id, { status: 'running', current_cycle: 1, current_member_id: a.id });

      const terminateSpy = vi.spyOn(processTree, 'terminateProcessTree');

      await expect(orchestrator.stopForum(forum.id)).resolves.toBeUndefined();

      expect(terminateSpy).not.toHaveBeenCalled();
      expect(queries.getAgentForumById(forum.id)!.status).toBe('idle');
      expect(queries.getAgentForumTurnById(turn.id)!.status).toBe('passed');
    });

    it('reports a stop timeout as an incomplete stop', async () => {
      // ForumStopTimeoutError and ForumRecoveryPendingError share one base so
      // the route layer can handle both with a single check.
      const err = new ForumStopTimeoutError('f1', 'timed out');
      expect(err).toBeInstanceOf(ForumStopTimeoutError);
      expect(new ForumRecoveryPendingError('f1', 'pending', 1).unresolvedOrphanProcesses).toBe(1);
    });
  });
});
