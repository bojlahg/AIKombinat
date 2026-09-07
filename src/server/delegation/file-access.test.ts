import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';
import { DelegationFileError, readDelegationFile, recheckDelegationFile, resolveDelegationFile } from './file-access.js';

describe('delegation file access', () => {
  let workspace: TestWorkspace;
  let root: string;

  beforeEach(() => {
    workspace = createTestWorkspace('delegation-files');
    root = workspace.createSubdir('repo');
  });
  afterEach(() => workspace.cleanup());

  it('accepts relative and absolute UTF-8 files inside the workDir', () => {
    const file = path.join(root, 'source.ts');
    fs.writeFileSync(file, 'const привет = "世界";\nexport { привет };\n');
    expect(readDelegationFile(root, 'source.ts', 1024, 20)).toMatchObject({ relativePath: 'source.ts', lines: 3 });
    expect(resolveDelegationFile(root, file).canonicalPath).toBe(fs.realpathSync.native(file));
  });

  it('rejects traversal, directories, sensitive paths, binary files and oversize input', () => {
    const outside = workspace.resolvePath('outside.txt');
    fs.writeFileSync(outside, 'outside');
    expect(() => resolveDelegationFile(root, '../outside.txt')).toThrowError(DelegationFileError);
    expect(() => resolveDelegationFile(root, '.')).toThrow(/regular file/);
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
    expect(() => readDelegationFile(root, '.env', 100, 10)).toThrow(/Sensitive/);
    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([1, 0, 2]));
    expect(() => readDelegationFile(root, 'binary.dat', 100, 10)).toThrow(/Binary/);
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(101));
    expect(() => readDelegationFile(root, 'large.txt', 100, 10)).toThrow(/exceeds/);
  });

  it('rejects an external symlink and permits an internal symlink', () => {
    const outside = workspace.resolvePath('outside.txt');
    const inside = path.join(root, 'inside.txt');
    fs.writeFileSync(outside, 'outside');
    fs.writeFileSync(inside, 'inside');
    try {
      fs.symlinkSync(outside, path.join(root, 'external-link.txt'));
      fs.symlinkSync(inside, path.join(root, 'internal-link.txt'));
    } catch {
      return;
    }
    expect(() => resolveDelegationFile(root, 'external-link.txt')).toThrow(/outside/);
    expect(resolveDelegationFile(root, 'internal-link.txt').relativePath).toBe('inside.txt');
  });

  it('detects stale identity after the source changes', () => {
    const file = path.join(root, 'source.txt');
    fs.writeFileSync(file, 'before\n');
    const identity = readDelegationFile(root, file, 100, 10);
    expect(recheckDelegationFile(identity)).toBe(true);
    fs.writeFileSync(file, 'after with a different size\n');
    expect(recheckDelegationFile(identity)).toBe(false);
  });
});
