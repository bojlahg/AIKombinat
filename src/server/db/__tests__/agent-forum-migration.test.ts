import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../schema.js';

/**
 * These tests build a database in the shape the first AgentForum release
 * produced (member_id ON DELETE CASCADE, no uniqueness indexes) and then run the
 * current `initDatabase` over it, the way an upgrade would.
 */
let db: Database.Database;

afterEach(() => {
  db?.close();
});

function createLegacyForumSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE agent_forums (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      rules TEXT NOT NULL,
      max_reply_length INTEGER NOT NULL DEFAULT 1024,
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
      current_cycle INTEGER NOT NULL DEFAULT 0,
      current_member_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agent_forum_members (
      id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      cli_tool TEXT,
      cli_model TEXT,
      cli_model_id TEXT,
      execution_profile_id TEXT,
      cli_effort TEXT,
      avatar_color TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agent_forum_messages (
      id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
      author_id TEXT,
      author_name TEXT NOT NULL,
      author_role TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      parent_message_id TEXT REFERENCES agent_forum_messages(id) ON DELETE SET NULL,
      turn_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE agent_forum_turns (
      id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL REFERENCES agent_forums(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES agent_forum_members(id) ON DELETE CASCADE,
      cycle_number INTEGER NOT NULL,
      turn_order INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'passed')),
      execution_snapshot TEXT,
      raw_output TEXT,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  database.exec(`
    INSERT INTO agent_forums (id, title, rules) VALUES ('f1', 'Legacy Forum', 'be nice');
    INSERT INTO agent_forum_members (id, forum_id, name, role) VALUES
      ('m1', 'f1', 'AgentA', 'architect'),
      ('m2', 'f1', 'AgentB', 'developer');
    INSERT INTO agent_forum_messages (id, forum_id, author_type, author_id, author_name, content, parent_message_id, created_at) VALUES
      ('msg-user', 'f1', 'user', NULL, 'User', 'Root', NULL, '2026-08-01T00:00:00Z');
  `);
}

describe('AgentForum schema migration on an existing database', () => {
  it('preserves turn history and switches member_id to ON DELETE RESTRICT', () => {
    db = new Database(':memory:');
    createLegacyForumSchema(db);
    db.exec(`
      INSERT INTO agent_forum_turns (id, forum_id, member_id, cycle_number, turn_order, status, execution_snapshot, created_at) VALUES
        ('t1', 'f1', 'm1', 1, 0, 'completed', '{"agent":"claude"}', '2026-08-01T00:01:00Z'),
        ('t2', 'f1', 'm2', 1, 1, 'passed', '{"agent":"codex"}', '2026-08-01T00:02:00Z');
    `);

    initDatabase(db);

    const turns = db.prepare('SELECT * FROM agent_forum_turns ORDER BY turn_order').all() as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(2);
    expect(turns[0].execution_snapshot).toBe('{"agent":"claude"}');
    expect(turns[1].status).toBe('passed');

    const fks = db.pragma('foreign_key_list(agent_forum_turns)') as Array<{ table: string; on_delete: string }>;
    const memberFk = fks.find((fk) => fk.table === 'agent_forum_members')!;
    expect(memberFk.on_delete).toBe('RESTRICT');

    // Deleting a participant that still has turns is refused by the DB itself.
    expect(() => db.prepare('DELETE FROM agent_forum_members WHERE id = ?').run('m1')).toThrow(/FOREIGN KEY/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_forum_turns').get()).toEqual({ n: 2 });
  });

  it('adds is_active to existing member rows with a safe default', () => {
    db = new Database(':memory:');
    createLegacyForumSchema(db);

    initDatabase(db);

    const members = db.prepare('SELECT id, is_active FROM agent_forum_members ORDER BY id').all();
    expect(members).toEqual([
      { id: 'm1', is_active: 1 },
      { id: 'm2', is_active: 1 },
    ]);
  });

  it('reconciles legacy duplicate agent replies without deleting messages, then enforces uniqueness', () => {
    db = new Database(':memory:');
    createLegacyForumSchema(db);
    db.exec(`
      INSERT INTO agent_forum_messages (id, forum_id, author_type, author_id, author_name, content, parent_message_id, created_at) VALUES
        ('dup-1', 'f1', 'agent', 'm1', 'AgentA', 'first reply', 'msg-user', '2026-08-01T00:03:00Z'),
        ('dup-2', 'f1', 'agent', 'm1', 'AgentA', 'second reply to same target', 'msg-user', '2026-08-01T00:04:00Z');
    `);

    initDatabase(db);

    // No message content was destroyed; the later duplicate was detached.
    const rows = db.prepare('SELECT id, parent_message_id FROM agent_forum_messages WHERE id IN (?, ?) ORDER BY id').all('dup-1', 'dup-2');
    expect(rows).toEqual([
      { id: 'dup-1', parent_message_id: 'msg-user' },
      { id: 'dup-2', parent_message_id: null },
    ]);

    // The invariant now holds at the DB level.
    expect(() =>
      db.prepare(
        `INSERT INTO agent_forum_messages (id, forum_id, author_type, author_id, author_name, content, parent_message_id)
         VALUES ('dup-3', 'f1', 'agent', 'm1', 'AgentA', 'third', 'msg-user')`
      ).run()
    ).toThrow(/UNIQUE/i);
  });

  it('reconciles legacy duplicate turn identities without deleting turns, then enforces uniqueness', () => {
    db = new Database(':memory:');
    createLegacyForumSchema(db);
    db.exec(`
      INSERT INTO agent_forum_turns (id, forum_id, member_id, cycle_number, turn_order, status, created_at) VALUES
        ('t1', 'f1', 'm1', 1, 0, 'completed', '2026-08-01T00:01:00Z'),
        ('t2', 'f1', 'm2', 1, 0, 'failed', '2026-08-01T00:02:00Z');
    `);

    initDatabase(db);

    const turns = db.prepare('SELECT id, turn_order FROM agent_forum_turns ORDER BY id').all();
    expect(turns).toHaveLength(2);
    expect(turns).toEqual([
      { id: 't1', turn_order: 0 },
      { id: 't2', turn_order: 1 },
    ]);

    expect(() =>
      db.prepare(
        `INSERT INTO agent_forum_turns (id, forum_id, member_id, cycle_number, turn_order, status)
         VALUES ('t3', 'f1', 'm1', 1, 0, 'pending')`
      ).run()
    ).toThrow(/UNIQUE/i);
  });

  it('does not rebuild agent_forum_turns on a database created by the current schema', () => {
    db = new Database(':memory:');
    initDatabase(db);

    const rootPageBefore = db.prepare(
      `SELECT rootpage FROM sqlite_master WHERE type='table' AND name='agent_forum_turns'`
    ).get() as { rootpage: number };

    initDatabase(db);

    const rootPageAfter = db.prepare(
      `SELECT rootpage FROM sqlite_master WHERE type='table' AND name='agent_forum_turns'`
    ).get() as { rootpage: number };

    // A rebuild would drop and recreate the table, moving its root page.
    expect(rootPageAfter.rootpage).toBe(rootPageBefore.rootpage);
  });

  it('is idempotent across repeated startups', () => {
    db = new Database(':memory:');
    createLegacyForumSchema(db);
    db.exec(`
      INSERT INTO agent_forum_turns (id, forum_id, member_id, cycle_number, turn_order, status, created_at) VALUES
        ('t1', 'f1', 'm1', 1, 0, 'completed', '2026-08-01T00:01:00Z');
    `);

    initDatabase(db);
    initDatabase(db);
    initDatabase(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_forum_turns').get()).toEqual({ n: 1 });
    const fks = db.pragma('foreign_key_list(agent_forum_turns)') as Array<{ table: string; on_delete: string }>;
    expect(fks.find((fk) => fk.table === 'agent_forum_members')!.on_delete).toBe('RESTRICT');
  });
});
