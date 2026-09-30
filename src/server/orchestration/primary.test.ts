import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedExecutionConfig } from '../services/execution-config.js';
import { logger } from '../logging/logger.js';
import { resetRedactionCache } from '../logging/redact.js';

const fixture = vi.hoisted(() => ({ fail: false, environment: {} as NodeJS.ProcessEnv }));
vi.mock('../utils/cli-guard.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/cli-guard.js')>();
  return { ...actual, assertExternalAiCliAllowed: vi.fn() };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn((_command, _args, options) => {
    fixture.environment = options.env;
    if (fixture.fail) throw new Error(`synthetic spawn failure ${options.env.AIKOMBINAT_ORCHESTRATOR_CAPABILITY} ${process.env.SESSION_SECRET}`);
    const keys = ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN', 'AIKOMBINAT_ORCHESTRATOR_ENDPOINT', 'AIKOMBINAT_ORCHESTRATOR_CAPABILITY', 'AIKOMBINAT_ORCHESTRATION_DEPTH', 'SAFE_PROVIDER_TEST_VAR'];
    return actual.spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,Object.hasOwn(process.env,k)])))))`], options);
  }) };
});
const { launchPrimary } = await import('./primary.js');
const input = { orchestratorId: 'synthetic', turnId: 'synthetic-turn', projectPath: process.cwd(),
  config: { cliTool: 'claude', effort: {} } as ResolvedExecutionConfig, context: '{}' };

afterEach(() => { fixture.fail = false; fixture.environment = {}; vi.unstubAllEnvs(); resetRedactionCache(); logger.configure({ level: 'info', dir: null }); });

describe('primary launch environment boundary', () => {
  it('launches a synthetic primary with sanitized env and turn capability', async () => {
    for (const key of ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN']) vi.stubEnv(key, `TOP_SECRET_${key}`);
    vi.stubEnv('SAFE_PROVIDER_TEST_VAR', 'present'); vi.stubEnv('CLAUDECODE', 'parent');
    const execution = await launchPrimary(input);
    try {
      const result = await execution.exit;
      expect(result.code).toBe(0);
      expect(JSON.parse(result.output)).toEqual({ SESSION_SECRET: false, AUTH_PASSWORD: false, TUNNEL_TOKEN: false,
        AIKOMBINAT_ORCHESTRATOR_ENDPOINT: true, AIKOMBINAT_ORCHESTRATOR_CAPABILITY: true, AIKOMBINAT_ORCHESTRATION_DEPTH: true, SAFE_PROVIDER_TEST_VAR: true });
      expect(Object.hasOwn(fixture.environment, 'CLAUDECODE')).toBe(false);
    } finally { await execution.revoke(); }
  });
  it('redacts spawn-failure diagnostics while the turn capability is live', async () => {
    const records: unknown[] = [];
    logger.configure({ level: 'debug', sinks: [{ write: record => { records.push(record); } }] });
    for (const key of ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN']) vi.stubEnv(key, `TOP_SECRET_${key}`);
    resetRedactionCache(); fixture.fail = true;
    // A synchronous spawn error must be safe even if a caller logs it after revoke.
    let failure: unknown;
    try { await launchPrimary(input); } catch (error) { failure = error; }
    logger.error('orchestrator.turn.failed', { err: failure });
    logger.debug('cli.spawn.requested', { command: 'claude' });
    const rendered = JSON.stringify(records);
    for (const key of ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN', 'AIKOMBINAT_ORCHESTRATOR_CAPABILITY']) {
      const value = fixture.environment[key] ?? process.env[key]!;
      expect(rendered.includes(value)).toBe(false);
    }
    expect(records.length).toBeGreaterThan(0);
  });
});
