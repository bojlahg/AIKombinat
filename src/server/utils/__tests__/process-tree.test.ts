import { describe, it, expect } from 'vitest';
import {
  isProcessAlive,
  terminateProcessTree,
  assertTestProcessKillAllowed,
  UNEXPECTED_PROCESS_KILL_MESSAGE,
} from '../process-tree.js';

describe('isProcessAlive', () => {
  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('treats missing / non-positive PIDs as not alive', () => {
    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(undefined)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('terminateProcessTree test guard', () => {
  it('refuses to signal a real process tree from a test', async () => {
    // Fail-closed: a test that exercises a termination path must stub this
    // helper explicitly rather than actually killing something.
    await expect(terminateProcessTree(process.pid)).rejects.toThrow(UNEXPECTED_PROCESS_KILL_MESSAGE);
  });

  it('short-circuits on a non-positive PID without reaching the guard', async () => {
    await expect(terminateProcessTree(0)).resolves.toBe(false);
    await expect(terminateProcessTree(-5)).resolves.toBe(false);
  });

  it('exposes the guard directly', () => {
    expect(() => assertTestProcessKillAllowed()).toThrow(UNEXPECTED_PROCESS_KILL_MESSAGE);
  });
});
