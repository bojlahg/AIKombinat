import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  isNewerVersion,
  mapMigratedFilename,
  migrateLegacyCliDir,
  migrateLegacyUserData,
  parseSemver,
  reconcileDirectory,
  reconcileTargetDatabase,
} = require('../../../../electron/migration.cjs') as {
  isNewerVersion: (latest: string, current: string) => boolean;
  mapMigratedFilename: (filename: string) => string;
  migrateLegacyCliDir: (targetDir: string, legacyDir: string, options?: any) => void;
  migrateLegacyUserData: (targetDir: string, options?: any) => void;
  parseSemver: (v: string) => { major: number; minor: number; patch: number; prerelease: string } | null;
  reconcileDirectory: (sourceDir: string, targetDir: string, options?: any) => void;
  reconcileTargetDatabase: (targetDir: string, options?: any) => void;
};

describe('migration safeguards and reconciliation', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-migration-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('maps legacy database filenames correctly', () => {
    expect(mapMigratedFilename('clitrigger.db')).toBe('aikombinat.db');
    expect(mapMigratedFilename('clitrigger.db-wal')).toBe('aikombinat.db-wal');
    expect(mapMigratedFilename('clitrigger.db-shm')).toBe('aikombinat.db-shm');
    expect(mapMigratedFilename('config.json')).toBe('config.json');
    expect(mapMigratedFilename('other.txt')).toBe('other.txt');
  });

  it('recursively migrates nested directories (e.g. Local Storage, IndexedDB)', () => {
    const legacyDir = path.join(tempRoot, 'legacy-data');
    const targetDir = path.join(tempRoot, 'new-data');

    fs.mkdirSync(path.join(legacyDir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.mkdirSync(path.join(legacyDir, 'IndexedDB', 'store.indexeddb.leveldb'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'Local Storage', 'leveldb', '000001.log'), 'storage-data');
    fs.writeFileSync(path.join(legacyDir, 'IndexedDB', 'store.indexeddb.leveldb', '000002.ldb'), 'idb-data');
    fs.writeFileSync(path.join(legacyDir, 'Preferences'), '{"theme":"dark"}');

    reconcileDirectory(legacyDir, targetDir);

    expect(fs.existsSync(path.join(targetDir, 'Local Storage', 'leveldb', '000001.log'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'Local Storage', 'leveldb', '000001.log'), 'utf-8')).toBe('storage-data');
    expect(fs.existsSync(path.join(targetDir, 'IndexedDB', 'store.indexeddb.leveldb', '000002.ldb'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'IndexedDB', 'store.indexeddb.leveldb', '000002.ldb'), 'utf-8')).toBe('idb-data');
    expect(fs.readFileSync(path.join(targetDir, 'Preferences'), 'utf-8')).toBe('{"theme":"dark"}');
  });

  it('never overwrites existing destination files (destination always wins)', () => {
    const legacyDir = path.join(tempRoot, 'legacy-data');
    const targetDir = path.join(tempRoot, 'new-data');

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(path.join(legacyDir, 'config.json'), '{"port":3000,"legacy":true}');
    fs.writeFileSync(path.join(targetDir, 'config.json'), '{"port":4000,"new":true}');

    reconcileDirectory(legacyDir, targetDir);

    expect(fs.readFileSync(path.join(targetDir, 'config.json'), 'utf-8')).toBe('{"port":4000,"new":true}');
  });

  it('completes cleanly on retry after a partial migration', () => {
    const legacyDir = path.join(tempRoot, 'legacy-data');
    const targetDir = path.join(tempRoot, 'new-data');

    fs.mkdirSync(path.join(legacyDir, 'sub1'), { recursive: true });
    fs.mkdirSync(path.join(legacyDir, 'sub2'), { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'file1.txt'), 'content-1');
    fs.writeFileSync(path.join(legacyDir, 'sub1', 'file2.txt'), 'content-2');
    fs.writeFileSync(path.join(legacyDir, 'sub2', 'file3.txt'), 'content-3');

    // Simulate partial migration: only file1.txt and sub1/file2.txt were copied before crash
    fs.mkdirSync(path.join(targetDir, 'sub1'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'file1.txt'), 'content-1-existing');
    fs.writeFileSync(path.join(targetDir, 'sub1', 'file2.txt'), 'content-2');

    // Run retry
    reconcileDirectory(legacyDir, targetDir);

    // Existing files in target preserved, missing file copied
    expect(fs.readFileSync(path.join(targetDir, 'file1.txt'), 'utf-8')).toBe('content-1-existing');
    expect(fs.readFileSync(path.join(targetDir, 'sub1', 'file2.txt'), 'utf-8')).toBe('content-2');
    expect(fs.existsSync(path.join(targetDir, 'sub2', 'file3.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'sub2', 'file3.txt'), 'utf-8')).toBe('content-3');
  });

  it('migrates database files clitrigger.db, -wal, -shm to aikombinat.db, -wal, -shm', () => {
    const legacyDir = path.join(tempRoot, 'legacy-data');
    const targetDir = path.join(tempRoot, 'new-data');

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'clitrigger.db'), 'sqlite-data');
    fs.writeFileSync(path.join(legacyDir, 'clitrigger.db-wal'), 'wal-data');
    fs.writeFileSync(path.join(legacyDir, 'clitrigger.db-shm'), 'shm-data');

    reconcileDirectory(legacyDir, targetDir);

    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'aikombinat.db'), 'utf-8')).toBe('sqlite-data');
    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db-wal'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'aikombinat.db-wal'), 'utf-8')).toBe('wal-data');
    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db-shm'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'aikombinat.db-shm'), 'utf-8')).toBe('shm-data');
  });

  it('reconciles target database if clitrigger.db was already in target without rename', () => {
    const targetDir = path.join(tempRoot, 'target-with-legacy-db');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'clitrigger.db'), 'legacy-in-target');
    fs.writeFileSync(path.join(targetDir, 'clitrigger.db-wal'), 'wal-in-target');

    reconcileTargetDatabase(targetDir);

    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'aikombinat.db'), 'utf-8')).toBe('legacy-in-target');
    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db-wal'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'aikombinat.db-wal'), 'utf-8')).toBe('wal-in-target');
  });

  it('preserves legacy source files without destructive deletion', () => {
    const legacyDir = path.join(tempRoot, 'legacy-source');
    const targetDir = path.join(tempRoot, 'aikombinat-target');

    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'clitrigger.db'), 'db-data');
    fs.writeFileSync(path.join(legacyDir, 'config.json'), '{"test":1}');

    migrateLegacyCliDir(targetDir, legacyDir);

    // Target populated
    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db'))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, 'config.json'))).toBe(true);

    // Source intact
    expect(fs.existsSync(path.join(legacyDir, 'clitrigger.db'))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, 'config.json'))).toBe(true);
  });

  it('migrateLegacyUserData handles multiple legacy candidates (CLITrigger / clitrigger)', () => {
    const parentDir = path.join(tempRoot, 'appdata');
    const cliTriggerDir = path.join(parentDir, 'CLITrigger');
    const clitriggerLowerDir = path.join(parentDir, 'clitrigger');
    const targetDir = path.join(parentDir, 'AIKombinat');

    fs.mkdirSync(cliTriggerDir, { recursive: true });
    fs.mkdirSync(clitriggerLowerDir, { recursive: true });

    fs.writeFileSync(path.join(cliTriggerDir, 'clitrigger.db'), 'upper-db');
    fs.writeFileSync(path.join(clitriggerLowerDir, 'extra-file.txt'), 'extra');

    migrateLegacyUserData(targetDir, {
      legacyCandidates: [cliTriggerDir, clitriggerLowerDir],
    });

    expect(fs.existsSync(path.join(targetDir, 'aikombinat.db'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'aikombinat.db'), 'utf-8')).toBe('upper-db');
    expect(fs.existsSync(path.join(targetDir, 'extra-file.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, 'extra-file.txt'), 'utf-8')).toBe('extra');
  });

  it('handles non-fatal errors gracefully without throwing', () => {
    const logged: string[] = [];
    const customLogger = (msg: string) => logged.push(msg);

    // Passing non-existent dirs should not throw
    expect(() => {
      migrateLegacyCliDir(path.join(tempRoot, 'non-existent-target'), path.join(tempRoot, 'non-existent-src'), {
        logger: customLogger,
      });
    }).not.toThrow();
  });
});

describe('semver parsing and comparison', () => {
  it('parses semver components correctly', () => {
    expect(parseSemver('0.2.50')).toEqual({ major: 0, minor: 2, patch: 50, prerelease: '' });
    expect(parseSemver('v1.3.0-beta.2')).toEqual({ major: 1, minor: 3, patch: 0, prerelease: 'beta.2' });
    expect(parseSemver('invalid')).toBeNull();
  });

  it('correctly compares version numbers', () => {
    expect(isNewerVersion('0.2.50', '0.2.49')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.2.49')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.2.49')).toBe(true);
    expect(isNewerVersion('v0.2.50', '0.2.49')).toBe(true);
    expect(isNewerVersion('0.2.49', '0.2.49')).toBe(false);
    expect(isNewerVersion('0.2.48', '0.2.49')).toBe(false);
    expect(isNewerVersion('0.1.99', '0.2.0')).toBe(false);
  });
});
