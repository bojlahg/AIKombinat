import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeManager } from '../claude-manager.js';
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
      await expect(manager.stopClaude(99999)).resolves.toBeUndefined();
    });
  });

  describe('killAll', () => {
    it('should resolve when no processes exist', async () => {
      const manager = new ClaudeManager();
      await expect(manager.killAll()).resolves.toBeUndefined();
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

