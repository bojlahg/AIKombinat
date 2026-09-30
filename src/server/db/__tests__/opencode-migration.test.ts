import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../schema.js';

let db: Database.Database;

afterEach(() => db?.close());

function createLegacyCatalog(constraint = '', statusConstraint = '') {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE cli_models (
      id TEXT PRIMARY KEY,
      cli_tool TEXT NOT NULL ${constraint},
      model_value TEXT NOT NULL,
      model_label TEXT NOT NULL,
      source TEXT DEFAULT 'seed',
      status TEXT NOT NULL DEFAULT 'available' ${statusConstraint},
      superseded_by_model_id TEXT REFERENCES cli_models(id),
      UNIQUE(cli_tool, model_value)
    );
    CREATE INDEX legacy_model_labels ON cli_models(model_label);
    CREATE TABLE legacy_model_refs (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL REFERENCES cli_models(id)
    );
    INSERT INTO cli_models (id, cli_tool, model_value, model_label)
      VALUES ('old', 'claude', 'legacy-model', 'Legacy model');
    INSERT INTO cli_models (id, cli_tool, model_value, model_label, superseded_by_model_id)
      VALUES ('new', 'codex', 'next-model', 'Next model', 'old');
    INSERT INTO legacy_model_refs VALUES ('ref', 'new');
  `);
}

function verifyCatalog() {
  expect(db.prepare('SELECT id, cli_tool, model_value, model_label, superseded_by_model_id FROM cli_models ORDER BY id').all()).toEqual([
    { id: 'new', cli_tool: 'codex', model_value: 'next-model', model_label: 'Next model', superseded_by_model_id: 'old' },
    { id: 'old', cli_tool: 'claude', model_value: 'legacy-model', model_label: 'Legacy model', superseded_by_model_id: null },
  ]);
  expect(db.prepare('SELECT * FROM legacy_model_refs').all()).toEqual([{ id: 'ref', model_id: 'new' }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_model_labels'").get()).toBeDefined();
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(() => db.exec("INSERT INTO cli_models (id, cli_tool, model_value, model_label) VALUES ('open', 'opencode', 'provider/model', 'OpenCode model')")).not.toThrow();
  expect(() => db.exec("INSERT INTO cli_models (id, cli_tool, model_value, model_label) VALUES ('duplicate', 'opencode', 'provider/model', 'Duplicate')")).toThrow(/UNIQUE/);
}

describe('OpenCode catalog migration', () => {
  it.each(['', "CHECK (status IN ('available', 'missing'))"])(
    'starts with an unrestricted legacy CLI column and preserves data (status constraint: %s)',
    (statusConstraint) => {
      createLegacyCatalog('', statusConstraint);
      initDatabase(db);
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cli_models'").get();
      initDatabase(db);
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cli_models'").get()).toEqual(schema);
      verifyCatalog();
      if (statusConstraint) {
        expect(() => db.exec("UPDATE cli_models SET status = 'invalid'")).toThrow(/CHECK/);
      }
    },
  );

  it('expands the previous CLI constraint while preserving references and indexes', () => {
    createLegacyCatalog("CHECK (cli_tool IN ('claude', 'codex', 'antigravity'))");
    initDatabase(db);
    initDatabase(db);
    verifyCatalog();
    expect(() => db.exec("UPDATE cli_models SET cli_tool = 'unsupported'")).toThrow(/CHECK/);
  });

  it('still refuses an unsupported CLI constraint without dropping the catalog', () => {
    createLegacyCatalog("CHECK (cli_tool != 'unsupported')");
    expect(() => initDatabase(db)).toThrow('Cannot safely migrate cli_models CLI constraint');
    expect(db.prepare('SELECT COUNT(*) AS count FROM cli_models').get()).toEqual({ count: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
