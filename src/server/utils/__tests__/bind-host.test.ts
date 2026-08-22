import { describe, expect, it } from 'vitest';
import { resolveBindHost } from '../bind-host.js';

describe('resolveBindHost', () => {
  it('binds to localhost by default', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
  });

  it('uses an explicit external bind host', () => {
    expect(resolveBindHost({ BIND_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('keeps auth-disabled servers on localhost', () => {
    expect(resolveBindHost({ DISABLE_AUTH: 'true', BIND_HOST: '0.0.0.0' })).toBe('127.0.0.1');
  });
});
