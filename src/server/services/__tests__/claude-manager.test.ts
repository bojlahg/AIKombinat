import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('tree-kill', () => ({ default: vi.fn() }));
import { ClaudeManager, Utf8StreamDecoder } from '../claude-manager.js';
import * as cliStatus from '../cli-status.js';

describe('ClaudeManager', () => {
  describe('isRunning', () => {
    it('should return false for unknown PID', () => {
      const manager = new ClaudeManager();
      expect(manager.isRunning(99999)).toBe(false);
    });
  });

  describe('stopClaude', () => {
    it('should resolve immediately for unknown PID', async () => {
      const manager = new ClaudeManager();
      await expect(manager.stopClaude(99999)).resolves.toEqual({ status: 'already_exited', pid: 99999 });
    });
  });

  describe('killAll', () => {
    it('should resolve when no processes exist', async () => {
      const manager = new ClaudeManager();
      await expect(manager.killAll()).resolves.toEqual([]);
    });
  });

  describe('provider stream transport', () => {
    it.each(['Привет', '你好世界', 'hello 😀', 'ASCII + Кириллица + 日本語 + 🚀'])('preserves UTF-8 at every byte boundary: %s', (sample) => {
      const bytes = Buffer.from(sample, 'utf8');
      for (let split = 0; split <= bytes.length; split++) {
        const decoder = new Utf8StreamDecoder();
        const actual = decoder.write(bytes.subarray(0, split))
          + decoder.write(bytes.subarray(split))
          + decoder.end();
        expect(actual).toBe(sample);
      }
    });

    it('retains ownership when termination cannot be confirmed and allows retry', async () => {
      vi.useFakeTimers();
      try {
        const manager = new ClaudeManager();
        const pid = 424242;
        (manager as any).processes.set(pid, { pid, kill: vi.fn() });
        const firstStop = manager.stopClaude(pid);
        await vi.advanceTimersByTimeAsync(7_000);
        await expect(firstStop).resolves.toEqual({
          status: 'unresolved', pid, reason: 'termination_not_confirmed',
        });
        expect(manager.isRunning(pid)).toBe(true);

        const exited = manager.whenExited(pid);
        const retry = manager.stopClaude(pid);
        (manager as any).markExited(pid);
        await vi.advanceTimersByTimeAsync(200);
        await expect(retry).resolves.toMatchObject({ status: 'terminated', pid });
        await expect(exited).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('turns an early stdin pipe close into the execution exit result', async () => {
      const manager = new ClaudeManager();
      const adapter = {
        command: process.execPath,
        displayName: 'Synthetic CLI',
        needsStdin: () => true,
        formatStdinPrompt: (prompt: string) => prompt,
      };
      const result = await (manager as any).startWithSpawn(
        adapter,
        ['-e', 'process.stdin.destroy(); process.exit(0)'],
        process.cwd(),
        'x'.repeat(2 * 1024 * 1024),
        'headless',
        'implementation',
      );
      await expect(result.exitPromise).resolves.toBe(1);
      expect(manager.isRunning(result.pid)).toBe(false);
    });
  });

  describe('startClaude fail-closed boundary', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects without mock in test mode before calling getToolStatus or spawning process', async () => {
      const getStatusSpy = vi.spyOn(cliStatus, 'getToolStatus');
      const manager = new ClaudeManager();
      await expect(
        manager.startClaude(process.cwd(), 'hi', undefined, undefined, 'headless', 'antigravity')
      ).rejects.toThrow('Unexpected real CLI launch from test. Install an explicit mock for this test.');
      expect(getStatusSpy).not.toHaveBeenCalled();
    });
  });
});

