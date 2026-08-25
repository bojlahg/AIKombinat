import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isTestEnvironment } from '../utils/test-fs-guard.js';

export const LOG_FILE_NAME = 'aikombinat.log';
/** Rotate once the active file would exceed this. */
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
/** Total files kept: `aikombinat.log` + `aikombinat.1.log` … `aikombinat.3.log`. */
export const MAX_RETAINED_LOG_FILES = 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from the compiled/source location until a `package.json` shows up.
 * Works from both `src/server/logging/` (tsx) and `dist/server/logging/`.
 */
export function findRepoRoot(startDir: string = __dirname): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Where the persistent log lives.
 *
 * Priority:
 *  1. `AIKOMBINAT_LOG_DIR` — explicit override (also what tests use).
 *  2. `<dirname(DB_PATH)>/logs` — the app-data directory the packaged CLI and
 *     the Electron build already agree on (`~/.aikombinat`, `userData/`).
 *  3. `<repo>/logs` — development. Gitignored; never inside a tracked source
 *     directory.
 *
 * Returns `null` when file logging must stay off: under the test runner the
 * filesystem guard rejects writes outside the temp workspace, so an unguarded
 * default would turn every test into a failure.
 */
export function resolveLogDir(): string | null {
  const override = process.env.AIKOMBINAT_LOG_DIR?.trim();
  if (override) return path.resolve(override);
  if (isTestEnvironment()) return null;

  const dbPath = process.env.DB_PATH?.trim();
  if (dbPath) return path.join(path.dirname(path.resolve(dbPath)), 'logs');

  return path.join(findRepoRoot(), 'logs');
}

export function resolveLogFilePath(): string | null {
  const dir = resolveLogDir();
  return dir ? path.join(dir, LOG_FILE_NAME) : null;
}

/** `aikombinat.log` → `aikombinat.1.log`. Index 0 is the active file. */
export function rotatedFileName(index: number, baseName = LOG_FILE_NAME): string {
  if (index <= 0) return baseName;
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  return `${stem}.${index}${ext}`;
}
