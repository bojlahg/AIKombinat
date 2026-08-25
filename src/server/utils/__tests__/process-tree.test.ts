import { describe, it, expect } from 'vitest';
import {
  isProcessAlive,
  terminateProcessTree,
  assertTestProcessKillAllowed,
  parseProcessIdentity,
  readProcessIdentity,
  verifyProcessIdentity,
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

describe('parseProcessIdentity', () => {
  it('round-trips a well-formed fingerprint', () => {
    const identity = { pid: 4242, startedAt: '1699999999', command: 'claude' };
    expect(parseProcessIdentity(JSON.stringify(identity))).toEqual(identity);
  });

  it('defaults a missing command to null', () => {
    expect(parseProcessIdentity(JSON.stringify({ pid: 1, startedAt: 'x' })))
      .toEqual({ pid: 1, startedAt: 'x', command: null });
  });

  it('rejects anything it cannot trust', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not json',
      '[]',
      JSON.stringify({ pid: 1 }),
      JSON.stringify({ startedAt: 'x' }),
      JSON.stringify({ pid: '1', startedAt: 'x' }),
      JSON.stringify({ pid: 1, startedAt: '' }),
    ]) {
      expect(parseProcessIdentity(bad as string | null)).toBeNull();
    }
  });
});

describe('readProcessIdentity', () => {
  it('inspects nothing in a test environment', async () => {
    // Fail-closed: tests must never spawn probe processes, and a null identity
    // is treated as unverifiable by every caller.
    await expect(readProcessIdentity(process.pid)).resolves.toBeNull();
  });

  it('rejects non-positive PIDs', async () => {
    await expect(readProcessIdentity(0)).resolves.toBeNull();
    await expect(readProcessIdentity(-1)).resolves.toBeNull();
  });
});

describe('verifyProcessIdentity', () => {
  const expected = { pid: 4242, startedAt: '1699999999', command: 'claude' };

  it('is unverifiable without a recorded fingerprint', async () => {
    await expect(verifyProcessIdentity(4242, null)).resolves.toBe('unverifiable');
    await expect(verifyProcessIdentity(4242, undefined)).resolves.toBe('unverifiable');
    await expect(verifyProcessIdentity(4242, { pid: 4242, startedAt: '' })).resolves.toBe('unverifiable');
  });

  it('is unverifiable for a non-positive PID', async () => {
    await expect(verifyProcessIdentity(0, expected)).resolves.toBe('unverifiable');
  });

  it('is a mismatch when the recorded fingerprint belongs to a different PID', async () => {
    await expect(verifyProcessIdentity(9999, expected)).resolves.toBe('mismatch');
  });

  it('is unverifiable when the current identity cannot be read', async () => {
    // readProcessIdentity returns null under test, so a same-PID check can never
    // come back as a match — which is the safe direction.
    await expect(verifyProcessIdentity(4242, expected)).resolves.toBe('unverifiable');
  });
});
