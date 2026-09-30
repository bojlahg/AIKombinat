import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('tree-kill', () => ({ default: vi.fn() }));
const processTreeMocks = vi.hoisted(() => ({
  verifyProcessIdentity: vi.fn(),
  terminateProcessTree: vi.fn(),
}));
vi.mock('../../utils/process-tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/process-tree.js')>();
  return { ...actual, ...processTreeMocks };
});
import { ClaudeManager, Utf8StreamDecoder } from '../claude-manager.js';
import * as cliStatus from '../cli-status.js';
import { getAdapter } from '../cli-adapters.js';
import { sshTransport } from '../execution-transport.js';
const syntheticNode = process.platform === 'win32' ? 'node' : process.execPath;
const syntheticArgs = (source: string) => {
  const code = `eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())`;
  return ['-e', process.platform === 'win32' ? `"${code}"` : code];
};

describe('ClaudeManager', () => {
  describe('isRunning', () => {
    it('keeps local exit lifecycle separate from a remote process with the same numeric PID', async () => {
      const manager = new ClaudeManager(), pid = 424243;
      vi.spyOn(sshTransport, 'hasPid').mockReturnValue(true);
      const remoteExit = vi.spyOn(sshTransport, 'whenExited').mockResolvedValue();
      (manager as any).processes.set(pid, { pid, kill: vi.fn() });
      const exited = manager.whenExited(pid);
      (manager as any).markExited(pid);
      await exited;
      expect(remoteExit).not.toHaveBeenCalled();
      expect(manager.isRunning(pid)).toBe(false);
      const remoteIdentity = { pid, startedAt: '100', remote: { nodeId: 'node', bindingId: 'binding', workspace: '/jobs', pid, startedAt: '100', bootId: 'boot' } };
      expect(manager.isRunning(pid, remoteIdentity)).toBe(true);
      await manager.whenExited(pid, remoteIdentity);
      expect(remoteExit).toHaveBeenCalledWith(pid, 'binding');
      vi.restoreAllMocks();
    });
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

    it('returns not_owned for a live identity mismatch without signalling the process', async () => {
      processTreeMocks.verifyProcessIdentity.mockResolvedValueOnce('mismatch');
      processTreeMocks.terminateProcessTree.mockClear();
      const manager = new ClaudeManager();
      await expect(manager.stopClaude(process.pid, {
        pid: process.pid, startedAt: '2000-01-01T00:00:00Z', command: 'old-provider.exe',
      })).resolves.toEqual({
        status: 'not_owned', pid: process.pid, reason: 'process_identity_mismatch',
      });
      expect(processTreeMocks.terminateProcessTree).not.toHaveBeenCalled();
    });

    it('keeps a live unverifiable untracked PID unresolved without signalling it', async () => {
      processTreeMocks.verifyProcessIdentity.mockResolvedValueOnce('unverifiable');
      processTreeMocks.terminateProcessTree.mockClear();
      const manager = new ClaudeManager();
      await expect(manager.stopClaude(process.pid, null)).resolves.toEqual({
        status: 'unresolved', pid: process.pid, reason: 'process_identity_unverifiable',
      });
      expect(processTreeMocks.terminateProcessTree).not.toHaveBeenCalled();
    });
  });

  describe('killAll', () => {
    it('should resolve when no processes exist', async () => {
      const manager = new ClaudeManager();
      await expect(manager.killAll()).resolves.toEqual([]);
    });
  });

  describe('provider stream transport', () => {
    it('delivers OpenCode stdin, decodes split UTF-8 and separates stderr from assistant JSON', async () => {
      const manager = new ClaudeManager();
      const adapter = { ...getAdapter('opencode'), command: syntheticNode };
      const source = `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => input+=s);
        process.stdin.on('end', () => { if(input !== 'PRIVATE Привет\\n') return process.exit(9);
          process.stderr.write('provider diagnostic\\n');
          const wire=Buffer.from(JSON.stringify({type:'text',part:{id:'a',text:'{"verdict":"approved","summary":"Привет 😀","issues":[]}'}})+'\\n');
          for(const byte of wire) process.stdout.write(Buffer.from([byte])); });`;
      const result = await (manager as any).startWithSpawn(adapter, syntheticArgs(source), process.cwd(), 'PRIVATE Привет', 'headless', 'review');
      let output = ''; let stderr = '';
      result.stdout.setEncoding('utf8'); result.stdout.on('data', (chunk: string) => { output += chunk; });
      result.stderr.setEncoding('utf8'); result.stderr.on('data', (chunk: string) => { stderr += chunk; });
      await expect(result.exitPromise).resolves.toBe(0);
      expect(JSON.parse(output)).toEqual({ verdict: 'approved', summary: 'Привет 😀', issues: [] });
      expect(stderr).toContain('provider diagnostic');
      expect(manager.isRunning(result.pid)).toBe(false);
    });

    it('rejects synthetic OpenCode exit zero without an assistant result through the process lifecycle', async () => {
      const manager = new ClaudeManager();
      const result = await (manager as any).startWithSpawn({ ...getAdapter('opencode'), command: syntheticNode },
        syntheticArgs("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"), process.cwd(), 'prompt', 'headless');
      let diagnostic = '';
      result.stderr.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
      result.stdout.resume();
      await expect(result.exitPromise).resolves.toBe(1);
      expect(diagnostic).toContain('empty-success anomaly');
      expect(manager.isRunning(result.pid)).toBe(false);
    });
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

