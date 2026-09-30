import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createChildEnvironment, SERVER_ONLY_ENV_KEYS } from './child-environment.js';

afterEach(() => vi.unstubAllEnvs());

describe('canonical AI child environment', () => {
  it('copies runtime/provider env, removes undefined overrides and never re-adds server secrets', () => {
    const source = { PATH: 'runtime-path', HOME: 'home', USERPROFILE: 'profile', TEMP: 'temp', TMP: 'tmp',
      ANTHROPIC_API_KEY: 'provider-test-key', OPENAI_API_KEY: 'provider-test-key', SAFE_PROVIDER_TEST_VAR: 'present',
      SESSION_SECRET: 'TOP_SECRET_SESSION', AUTH_PASSWORD: 'TOP_SECRET_AUTH', TUNNEL_TOKEN: 'TOP_SECRET_TUNNEL', REMOVE: 'old' };
    const result = createChildEnvironment({ REMOVE: undefined, EXTRA: 'added', ELECTRON_RUN_AS_NODE: '1',
      SESSION_SECRET: 'oops', auth_password: 'oops', tunnel_token: 'oops' }, source);
    expect(result).toEqual({ PATH: source.PATH, HOME: source.HOME, USERPROFILE: source.USERPROFILE, TEMP: source.TEMP, TMP: source.TMP,
      ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY, OPENAI_API_KEY: source.OPENAI_API_KEY, SAFE_PROVIDER_TEST_VAR: 'present', EXTRA: 'added', ELECTRON_RUN_AS_NODE: '1' });
    expect(source.REMOVE).toBe('old');
  });

  async function inspect(useProc: boolean) {
    for (const key of SERVER_ONLY_ENV_KEYS) vi.stubEnv(key, `TOP_SECRET_${key}`);
    const environment = createChildEnvironment({ AIKOMBINAT_ORCHESTRATOR_ENDPOINT: 'http://127.0.0.1:1/',
      AIKOMBINAT_ORCHESTRATOR_CAPABILITY: 'synthetic-turn-capability', AIKOMBINAT_ORCHESTRATION_DEPTH: '0', SAFE_PROVIDER_TEST_VAR: 'present' });
    const source = useProc
      ? "Object.fromEntries(require('node:fs').readFileSync('/proc/self/environ','utf8').split('\\0').filter(Boolean).map(s=>[s.slice(0,s.indexOf('=')),true]))"
      : 'process.env';
    const keys = [...SERVER_ONLY_ENV_KEYS, 'AIKOMBINAT_ORCHESTRATOR_ENDPOINT', 'AIKOMBINAT_ORCHESTRATOR_CAPABILITY', 'AIKOMBINAT_ORCHESTRATION_DEPTH', 'SAFE_PROVIDER_TEST_VAR'];
    const script = `const env=${source}; process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,Object.hasOwn(env,k)]))))`;
    const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, ['-e', script], { env: environment }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output)).toEqual(Object.fromEntries(keys.map(key => [key, !SERVER_ONLY_ENV_KEYS.includes(key as typeof SERVER_ONLY_ENV_KEYS[number])])));
  }
  it('confirms server secret stripping at the synthetic spawned-process boundary', () => inspect(false));
  it.skipIf(process.platform !== 'linux')('confirms stripping in the spawned Linux /proc/self/environ', () => inspect(true));
});
