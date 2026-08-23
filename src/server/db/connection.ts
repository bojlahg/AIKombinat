import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './schema.js';

import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    let dbPath = process.env.DB_PATH;
    if (!dbPath) {
      const aikombinatDbPath = path.join(PROJECT_ROOT, 'aikombinat.db');
      const legacyDbPath = path.join(PROJECT_ROOT, 'clitrigger.db');
      if (!fs.existsSync(aikombinatDbPath) && fs.existsSync(legacyDbPath)) {
        try {
          fs.copyFileSync(legacyDbPath, aikombinatDbPath);
          if (fs.existsSync(`${legacyDbPath}-wal`)) fs.copyFileSync(`${legacyDbPath}-wal`, `${aikombinatDbPath}-wal`);
          if (fs.existsSync(`${legacyDbPath}-shm`)) fs.copyFileSync(`${legacyDbPath}-shm`, `${aikombinatDbPath}-shm`);
        } catch {
          // Fallback to legacy path if copying fails
        }
      }
      dbPath = fs.existsSync(aikombinatDbPath) || !fs.existsSync(legacyDbPath) ? aikombinatDbPath : legacyDbPath;
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initDatabase(db);
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
