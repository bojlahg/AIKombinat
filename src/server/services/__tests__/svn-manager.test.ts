import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { createTestWorkspace, type TestWorkspace } from '../../test-utils/workspace.js';
import { UNEXPECTED_FS_WRITE_MESSAGE } from '../../utils/test-fs-guard.js';
import { runSvn } from '../../lib/svn.js';

let ws: TestWorkspace;
let wcPath: string;

vi.mock('../../lib/svn.js', () => ({
  runSvn: vi.fn(async (args: string[]) => {
    if (args[0] === 'status') {
      return {
        stdout: `<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path="${wcPath}">
<entry path="${wcPath}/src/plain.ts">
<wc-status item="modified" props="none" revision="10">
</wc-status>
</entry>
<entry path="${wcPath}/new.txt">
<wc-status item="unversioned" props="none">
</wc-status>
</entry>
</target>
<changelist name="ui&amp;fix">
<entry path="${wcPath}/src/App.tsx">
<wc-status item="modified" props="none" revision="10">
</wc-status>
</entry>
</changelist>
</status>`,
        stderr: '',
      };
    }
    if (args[0] === 'info') {
      return {
        stdout: `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry revision="10" path=".">
<url>https://example.com/svn/repo/trunk</url>
<relative-url>^/trunk</relative-url>
<repository><root>https://example.com/svn/repo</root></repository>
</entry>
</info>`,
        stderr: '',
      };
    }
    if (args[0] === 'update') {
      return {
        stdout: [
          `Updating '${wcPath}':`,
          `U    ${wcPath}/src/plain.ts`,
          `C    ${wcPath}/src/충돌.c`,
          ` C   ${wcPath}/props-conflict.txt`,
          `   C ${wcPath}/tree-dir`,
          `G    ${wcPath}/merged.txt`,
          'Updated to revision 42.',
          'Summary of conflicts:',
          '  Text conflicts: 1',
        ].join('\n'),
        stderr: '',
      };
    }
    if (args[0] === 'commit') {
      return {
        stdout: 'Committed revision 43.\n',
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  }),
  isSvnRepository: vi.fn(async () => true),
}));

import { svnManager } from '../svn-manager.js';

describe('SvnManager Suite', () => {
  beforeAll(() => {
    ws = createTestWorkspace('svn-test');
    wcPath = ws.path.replace(/\\/g, '/');
  });

  afterAll(() => {
    ws?.cleanup();
  });

  describe('svnManager.getStatus changelist parsing', () => {
    it('attaches the changelist name to member files and leaves others without one', async () => {
      const status = await svnManager.getStatus(wcPath);
      const byPath = new Map(status.files.map((f) => [f.path, f]));

      // Member of <changelist name="ui&amp;fix"> — name captured and unescaped.
      expect(byPath.get('src/App.tsx')?.changelist).toBe('ui&fix');
      // Plain <target> entries carry no changelist.
      expect(byPath.get('src/plain.ts')?.working_dir).toBe('M');
      expect(byPath.get('src/plain.ts')?.changelist).toBeUndefined();
      expect(byPath.get('new.txt')?.working_dir).toBe('?');
      expect(byPath.get('new.txt')?.changelist).toBeUndefined();
    });
  });

  describe('svnManager.update conflict parsing', () => {
    it('collects text/prop/tree conflicts and skips clean/summary lines', async () => {
      const result = await svnManager.update(wcPath);
      expect(result.revision).toBe('42');
      expect(result.conflicts).toEqual(['src/충돌.c', 'props-conflict.txt', 'tree-dir']);
    });
  });

  describe('svnManager.setProperty relative target regression', () => {
    it('allows relative target path inside working copy and passes it to runSvn', async () => {
      const runSvnSpy = vi.mocked(runSvn);
      runSvnSpy.mockClear();

      await expect(
        svnManager.setProperty(wcPath, 'svn:needs-lock', '*', 'src/file.ts'),
      ).resolves.not.toThrow();

      expect(runSvnSpy).toHaveBeenCalledWith(
        ['propset', 'svn:needs-lock', '*', 'src/file.ts'],
        wcPath,
      );
    });
  });

  describe('svnManager mutation targets sandbox boundary', () => {
    it('rejects unsafe absolute target paths before calling runSvn', async () => {
      const runSvnSpy = vi.mocked(runSvn);
      runSvnSpy.mockClear();

      const unsafeTarget = process.platform === 'win32'
        ? 'C:/aikombinat-forbidden-svn-target/file.txt'
        : '/aikombinat-forbidden-svn-target/file.txt';

      expect(fs.existsSync(unsafeTarget)).toBe(false);

      await expect(svnManager.revert(wcPath, [unsafeTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.remove(wcPath, [unsafeTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.add(wcPath, [unsafeTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.commit(wcPath, 'test', [unsafeTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.setProperty(wcPath, 'svn:test', 'x', unsafeTarget)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.resolve(wcPath, [unsafeTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.changelist(wcPath, 'cl', [unsafeTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      expect(runSvnSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(unsafeTarget)).toBe(false);
    });

    it('rejects target paths escaping working copy via parent traversal (..) before calling runSvn', async () => {
      const runSvnSpy = vi.mocked(runSvn);
      runSvnSpy.mockClear();

      const escapingTarget = '../outside/file.txt';

      await expect(svnManager.revert(wcPath, [escapingTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.remove(wcPath, [escapingTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.add(wcPath, [escapingTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.commit(wcPath, 'test', [escapingTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.setProperty(wcPath, 'svn:test', 'x', escapingTarget)).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.resolve(wcPath, [escapingTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);
      await expect(svnManager.changelist(wcPath, 'cl', [escapingTarget])).rejects.toThrow(UNEXPECTED_FS_WRITE_MESSAGE);

      expect(runSvnSpy).not.toHaveBeenCalled();
    });
  });
});


