import { vi } from 'vitest';
import { PassThrough } from 'stream';
import { claudeManager } from '../services/claude-manager.js';
import * as cliStatus from '../services/cli-status.js';

export const UNEXPECTED_CLI_LAUNCH_MESSAGE =
  'Unexpected real CLI launch from test. Install an explicit mock for this test.';

export interface MockCliProcessResult {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream | null;
  exitPromise: Promise<number>;
  resolveExit: (code: number) => void;
  command: string;
  args: string[];
}

/**
 * Creates a standard mock result for `claudeManager.startClaude`.
 */
export function createMockCliResult(
  pid = 1234,
  command = 'claude',
  args: string[] = []
): MockCliProcessResult {
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
    command,
    args,
  };
}

/**
 * Installs fail-closed guard on `claudeManager.startClaude` and `cliStatus` probing.
 * Prevents any accidental execution of real AI CLIs (Claude, Codex, Antigravity).
 */
export function installDefaultCliGuard(): void {
  vi.spyOn(claudeManager, 'startClaude').mockImplementation(async () => {
    throw new Error(UNEXPECTED_CLI_LAUNCH_MESSAGE);
  });
  vi.spyOn(cliStatus, 'getToolStatus').mockImplementation(async (tool: string) => {
    if (tool === 'raw-shell') {
      return { tool: 'raw-shell', installed: true, version: 'raw-shell' };
    }
    throw new Error(UNEXPECTED_CLI_LAUNCH_MESSAGE);
  });
  vi.spyOn(cliStatus, 'checkAllTools').mockImplementation(async () => {
    throw new Error(UNEXPECTED_CLI_LAUNCH_MESSAGE);
  });
}

