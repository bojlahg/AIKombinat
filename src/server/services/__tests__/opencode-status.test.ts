import { beforeEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({ version: '1.18.33', run: '--format --model --agent', modelsError: false, calls: [] as string[][] }));
vi.mock('child_process', () => ({ execFile: (_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  probes.calls.push(args);
  const models = args[0] === 'models';
  callback(models && probes.modelsError ? new Error('Unsupported command') : null,
    args[0] === '--version' ? probes.version : models ? '--refresh' : probes.run, '');
} }));
vi.mock('../../utils/cli-guard.js', () => ({ assertExternalAiCliAllowed: vi.fn() }));
vi.mock('../model-sync.js', () => ({ maybeTriggerSync: vi.fn() }));
const { getToolStatus, clearCache } = await import('../cli-status.js');
const { maybeTriggerSync } = await import('../model-sync.js');

beforeEach(() => { clearCache(); vi.clearAllMocks(); probes.version = '1.18.33'; probes.run = '--format --model --agent'; probes.modelsError = false; probes.calls = []; });

describe('OpenCode CLI capabilities', () => {
  it('probes version, run and models and caches a usable V1 installation', async () => {
    expect(await getToolStatus('opencode')).toMatchObject({ installed: true, usable: true, version: '1.18.33',
      capabilities: expect.arrayContaining(['--format', '--model', '--agent', '--refresh']) });
    await getToolStatus('opencode');
    expect(probes.calls).toHaveLength(3);
    expect(probes.calls).toContainEqual(['run', '--help']);
    expect(probes.calls).toContainEqual(['models', '--help']);
  });
  it.each(['--format --agent', '--model --agent', '--model --format'])('rejects missing required run flags: %s', async (help) => {
    probes.run = help;
    expect(await getToolStatus('opencode')).toMatchObject({ installed: true, usable: false });
    expect(maybeTriggerSync).not.toHaveBeenCalled();
  });
  it('rejects unverified V2 permissions and unsupported models command', async () => {
    probes.version = 'opencode v2.0.20';
    expect(await getToolStatus('opencode')).toMatchObject({ installed: true, usable: false });
    clearCache(); probes.version = '1.18.33'; probes.modelsError = true;
    expect(await getToolStatus('opencode')).toMatchObject({ installed: true, usable: false });
  });
});
