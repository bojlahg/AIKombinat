import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

process.env.DB_PATH = ':memory:';

import { SqliteSessionStore, validatePersistedAuthSession } from '../auth.js';
import { closeDatabase, getDatabase } from '../../db/connection.js';
import { setSetting } from '../../db/app-settings.js';
import type { SessionData } from 'express-session';

function sess(expiresInMs: number): SessionData {
  return {
    cookie: { expires: new Date(Date.now() + expiresInMs) },
    authenticated: true,
  } as unknown as SessionData;
}

describe('SqliteSessionStore', () => {
  let store: SqliteSessionStore;

  beforeAll(() => {
    store = new SqliteSessionStore();
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('persisted authentication validation', () => {
    beforeEach(() => {
      getDatabase().prepare('DELETE FROM auth_sessions').run();
      setSetting('auth.password_hash', 'fixture-hash');
      setSetting('auth.password_changed_at', '100');
      getDatabase().prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)')
        .run('persisted', JSON.stringify({ authenticated: true, createdAt: 100 }), Date.now() + 60_000);
    });
    it('accepts a valid persisted session at the password timestamp boundary', () => {
      expect(validatePersistedAuthSession('persisted')).toEqual({ valid: true, reason: 'ok' });
    });
    it.each([
      ['missing', 'DELETE FROM auth_sessions', []],
      ['expired', 'UPDATE auth_sessions SET expires_at = ?', [0]],
      ['invalid_payload', 'UPDATE auth_sessions SET data = ?', ['{']],
      ['invalid_payload', 'UPDATE auth_sessions SET data = ?', ['null']],
      ['invalid_payload', 'UPDATE auth_sessions SET data = ?', ['[]']],
      ['invalid_payload', 'UPDATE auth_sessions SET data = ?', ['{"authenticated":true,"createdAt":"100"}']],
      ['invalid_payload', 'UPDATE auth_sessions SET data = ?', ['{"authenticated":true,"createdAt":1e999}']],
      ['not_authenticated', 'UPDATE auth_sessions SET data = ?', ['{"authenticated":false,"createdAt":100}']],
      ['password_changed', 'UPDATE auth_sessions SET data = ?', ['{"authenticated":true,"createdAt":99}']],
    ] as const)('rejects %s rows (%s)', (reason, sql, args) => {
      getDatabase().prepare(sql).run(...args);
      expect(validatePersistedAuthSession('persisted')).toEqual({ valid: false, reason });
    });
    it('expires at the exact persisted expiry boundary', () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        getDatabase().prepare('UPDATE auth_sessions SET expires_at = ?').run(now);
        expect(validatePersistedAuthSession('persisted').reason).toBe('expired');
        store.get('persisted', (err, data) => { expect(err).toBeNull(); expect(data).toBeNull(); });
      } finally { clock.mockRestore(); }
    });
    it('fails closed when the password is removed', () => {
      setSetting('auth.password_hash', null);
      expect(validatePersistedAuthSession('persisted')).toEqual({ valid: false, reason: 'password_missing' });
    });
    it('fails closed on a SQLite read failure without throwing', () => {
      const read = vi.spyOn(getDatabase(), 'prepare').mockImplementation(() => { throw new Error('read failed'); });
      try { expect(validatePersistedAuthSession('persisted')).toEqual({ valid: false, reason: 'invalid_payload' }); }
      finally { read.mockRestore(); }
    });
  });

  it('persists and retrieves a session', async () => {
    await new Promise<void>((resolve, reject) =>
      store.set('sid1', sess(60_000), (err) => (err ? reject(err) : resolve()))
    );
    const got = await new Promise<SessionData | null>((resolve, reject) =>
      store.get('sid1', (err, s) => (err ? reject(err) : resolve(s ?? null)))
    );
    expect(got).not.toBeNull();
    expect((got as any).authenticated).toBe(true);
  });

  it('returns null for expired sessions', async () => {
    await new Promise<void>((resolve, reject) =>
      store.set('sid2', sess(-1000), (err) => (err ? reject(err) : resolve()))
    );
    const got = await new Promise<SessionData | null>((resolve, reject) =>
      store.get('sid2', (err, s) => (err ? reject(err) : resolve(s ?? null)))
    );
    expect(got).toBeNull();
  });

  it('destroys sessions', async () => {
    await new Promise<void>((resolve, reject) =>
      store.set('sid3', sess(60_000), (err) => (err ? reject(err) : resolve()))
    );
    await new Promise<void>((resolve, reject) =>
      store.destroy('sid3', (err) => (err ? reject(err) : resolve()))
    );
    const got = await new Promise<SessionData | null>((resolve, reject) =>
      store.get('sid3', (err, s) => (err ? reject(err) : resolve(s ?? null)))
    );
    expect(got).toBeNull();
  });
});
