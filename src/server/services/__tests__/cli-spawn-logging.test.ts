import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { logger } from '../../logging/logger.js';
import type { LogRecord, LogSink } from '../../logging/types.js';

/**
 * The Windows "CLI is not on PATH" preflight used to throw before the shared
 * spawn diagnostics ran, so the single most common startup failure produced no
 * unified record at all.
 *
 * These tests drive the real `claudeManager.startClaude` with the `raw-shell`
 * provider, whose command is a plain shell rather than an AI CLI: the test
 * filesystem/CLI guards stay fully armed, no Claude/Codex/Antigravity binary is
 * reachable, and no process is spawned because the preflight rejects first.
 */

const getToolStatus = vi.fn();

vi.mock('../../utils/cli-guard.js', () => ({
  assertExternalAiCliAllowed: vi.fn(),
}));

vi.mock('../cli-status.js', () => ({
  getToolStatus: (...args: unknown[]) => getToolStatus(...args),
  checkAllTools: vi.fn().mockResolvedValue([]),
  clearCache: vi.fn(),
}));

const { claudeManager } = await import('../claude-manager.js');

interface CapturingSink extends LogSink {
  records: LogRecord[];
}

function capturingSink(): CapturingSink {
  const records: LogRecord[] = [];
  return { records, write: (record) => { records.push(record); } };
}

describe('CLI spawn diagnostics', () => {
  let workspace: TestWorkspace;
  let sink: CapturingSink;
  const realPlatform = process.platform;

  beforeEach(() => {
    workspace = createTestWorkspace('cli-spawn-logging');
    sink = capturingSink();
    logger.configure({ level: 'debug', sinks: [sink] });
    // The preflight is Windows-only; pin it so the contract is checked on every host.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    logger.configure({ level: 'info', dir: null });
    getToolStatus.mockReset();
    vi.restoreAllMocks();
    workspace.cleanup();
  });

  it('logs cli.spawn.failed when the CLI is missing from PATH', async () => {
    getToolStatus.mockResolvedValue({ tool: 'raw-shell', installed: false, version: null });

    await expect(
      claudeManager.startClaude(workspace.path, '', undefined, undefined, 'interactive', 'raw-shell'),
    ).rejects.toThrow(/was not found on PATH/);

    const failures = sink.records.filter(r => r.event === 'cli.spawn.failed');
    // Exactly one record: the preflight now fails inside the shared boundary
    // rather than being logged separately or not at all.
    expect(failures).toHaveLength(1);
    expect(failures[0].level).toBe('error');
    expect(failures[0].fields).toMatchObject({ provider: 'raw-shell', mode: 'interactive' });
    expect(String(failures[0].fields.message)).toContain('was not found on PATH');

    // No process was started, so there must be no "started" record either.
    expect(sink.records.some(r => r.event === 'cli.spawned')).toBe(false);
  });

  it('carries the ambient execution context onto the failure record', async () => {
    getToolStatus.mockResolvedValue({ tool: 'raw-shell', installed: false, version: null });
    const { runWithLogContext, tag } = await import('../../logging/context.js');

    await runWithLogContext(
      { scope: tag('todo', 'Fix login'), fields: { todoId: 'todo-1', projectId: 'proj-1' } },
      () => claudeManager
        .startClaude(workspace.path, '', undefined, undefined, 'interactive', 'raw-shell')
        .catch(() => undefined),
    );

    const failure = sink.records.find(r => r.event === 'cli.spawn.failed')!;
    expect(failure.scope).toBe('[todo:Fix login]');
    expect(failure.fields).toMatchObject({ todoId: 'todo-1', projectId: 'proj-1' });
  });

  it('never records the prompt, even in the DEBUG spawn request line', async () => {
    getToolStatus.mockResolvedValue({ tool: 'raw-shell', installed: false, version: null });
    const secret = 'CONFIDENTIAL-PROMPT-4471';

    await claudeManager
      .startClaude(workspace.path, secret, undefined, undefined, 'interactive', 'raw-shell')
      .catch(() => undefined);

    const rendered = sink.records
      .map(r => `${r.event} ${r.scope} ${r.msg} ${r.detail ?? ''} ${JSON.stringify(r.fields)}`)
      .join('\n');
    expect(rendered).toContain('cli.spawn.failed');
    // Covers the DEBUG `cli.spawn.requested` line too: it logs redacted argv,
    // never the prompt piped to the process.
    expect(rendered).not.toContain(secret);
  });

  it('fails before spawn and emits a unified compatibility error for unsupported required flags', async () => {
    getToolStatus.mockResolvedValue({
      tool: 'antigravity',
      installed: true,
      version: 'agy 0.9.0',
      capabilities: ['--headless', '--sandbox'],
    });

    await expect(
      claudeManager.startClaude(
        workspace.path,
        'Discuss safely',
        undefined,
        undefined,
        'headless',
        'antigravity',
        undefined,
        workspace.path,
        'strict',
        false,
        undefined,
        undefined,
        undefined,
        'discussion',
      ),
    ).rejects.toThrow(/required flag --input-format is not supported/);

    const failures = sink.records.filter((record) => record.event === 'cli.compatibility.failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].level).toBe('error');
    expect(failures[0].fields).toMatchObject({
      provider: 'antigravity',
      unsupportedFlag: '--input-format',
      detectedVersion: 'agy 0.9.0',
    });
    expect(sink.records.some((record) => record.event === 'cli.spawned')).toBe(false);
    expect(sink.records.some((record) => record.event === 'cli.spawn.failed')).toBe(false);
  });
});
