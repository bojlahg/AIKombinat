import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
  isTestEnvironment,
  isTestRuntimePathAllowed,
  assertTestRuntimePathAllowed,
  UNEXPECTED_FS_WRITE_MESSAGE,
  registerApprovedTestRoot,
  unregisterApprovedTestRoot,
} from '../test-fs-guard.js';
import { createTestWorkspace } from '../../test-utils/workspace.js';

describe('test-fs-guard', () => {
  it('isTestEnvironment returns true in test runner', () => {
    expect(isTestEnvironment()).toBe(true);
  });

  describe('isTestRuntimePathAllowed and assertTestRuntimePathAllowed', () => {
    it('accepts paths strictly inside os.tmpdir()', () => {
      const allowedPath = path.join(os.tmpdir(), 'aikombinat-test-guard', '.claude', 'settings.json');
      expect(isTestRuntimePathAllowed(allowedPath)).toBe(true);
      expect(() => assertTestRuntimePathAllowed(allowedPath)).not.toThrow();
    });

    it('accepts paths created via TestWorkspace', () => {
      const workspace = createTestWorkspace('fs-guard-unit');
      const target = workspace.resolvePath('sub', 'file.txt');
      expect(isTestRuntimePathAllowed(target)).toBe(true);
      expect(() => assertTestRuntimePathAllowed(target)).not.toThrow();
      workspace.cleanup();
    });

    it('rejects drive-root synthetic paths', () => {
      const unsafePaths = [
        'C:/aikombinat-forbidden-test-proj',
        'C:\\aikombinat-forbidden-test-proj',
        'D:/aikombinat-forbidden-test-proj',
        'D:\\aikombinat-forbidden-test-proj',
        'C:/some-proj/.claude/settings.json',
        'C:\\Users\\user\\some-proj',
      ];

      for (const p of unsafePaths) {
        expect(isTestRuntimePathAllowed(p)).toBe(false);
        expect(() => assertTestRuntimePathAllowed(p)).toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      }
    });

    it('rejects paths escaping tmpdir via parent traversal (..)', () => {
      const escaping = path.join(os.tmpdir(), '..', 'escaped-dir', 'file.txt');
      expect(isTestRuntimePathAllowed(escaping)).toBe(false);
      expect(() => assertTestRuntimePathAllowed(escaping)).toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
    });

    it('rejects sibling directories of tmpdir', () => {
      const sibling = `${os.tmpdir()}_sibling`;
      expect(isTestRuntimePathAllowed(sibling)).toBe(false);
      expect(() => assertTestRuntimePathAllowed(sibling)).toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
    });

    it('handles Windows case-insensitivity correctly for allowed paths', () => {
      const originalTmp = os.tmpdir();
      // Test inverted casing of drive letter if present
      const match = originalTmp.match(/^([A-Za-z]):(.*)$/);
      if (match) {
        const invertedDrive = match[1] === match[1].toUpperCase() ? match[1].toLowerCase() : match[1].toUpperCase();
        const altCasedTmp = `${invertedDrive}:${match[2]}`;
        const target = path.join(altCasedTmp, 'aikombinat-test-case', 'file.txt');
        expect(isTestRuntimePathAllowed(target)).toBe(true);
        expect(() => assertTestRuntimePathAllowed(target)).not.toThrow();
      }
    });

    it('supports custom registered test roots', () => {
      const customRoot = path.resolve('data', 'custom-test-root');
      expect(isTestRuntimePathAllowed(path.join(customRoot, 'test.txt'))).toBe(false);

      registerApprovedTestRoot(customRoot);
      expect(isTestRuntimePathAllowed(path.join(customRoot, 'test.txt'))).toBe(true);
      expect(() => assertTestRuntimePathAllowed(path.join(customRoot, 'test.txt'))).not.toThrow();

      unregisterApprovedTestRoot(customRoot);
      expect(isTestRuntimePathAllowed(path.join(customRoot, 'test.txt'))).toBe(false);
    });
  });
});
