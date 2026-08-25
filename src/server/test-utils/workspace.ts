import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TestWorkspace {
  /** Root directory of the temporary workspace. */
  readonly path: string;
  /** Resolves relative subpaths inside this workspace. */
  resolvePath: (...subpaths: string[]) => string;
  /** Creates and returns a subdirectory inside this workspace. */
  createSubdir: (...subpaths: string[]) => string;
  /** Safely removes this temporary workspace and its contents. */
  cleanup: () => void;
}

const activeWorkspaces = new Set<TestWorkspace>();

/**
 * Validates that the target path is strictly inside the system temporary directory
 * and is not the root temp directory itself.
 */
function isSafeTempPath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const normalizedTarget = path.resolve(targetPath).toLowerCase();
  const normalizedTmpDir = path.resolve(os.tmpdir()).toLowerCase();

  // Target must be strictly inside os.tmpdir() and not os.tmpdir() itself
  if (normalizedTarget === normalizedTmpDir) return false;
  if (!normalizedTarget.startsWith(normalizedTmpDir + path.sep) && !normalizedTarget.startsWith(normalizedTmpDir + '/')) {
    return false;
  }
  return true;
}

/**
 * Creates an isolated temporary directory for test execution.
 * Any filesystem side-effects (e.g. .claude/settings.json, worktrees, images)
 * are contained within this directory and cleaned up after test completion.
 */
export function createTestWorkspace(prefix = 'test'): TestWorkspace {
  const sanitizedPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '-');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `aikombinat-${sanitizedPrefix}-`));
  const resolvedPath = path.resolve(tempDir);

  const workspace: TestWorkspace = {
    path: resolvedPath,
    resolvePath(...subpaths: string[]) {
      return path.join(resolvedPath, ...subpaths);
    },
    createSubdir(...subpaths: string[]) {
      const targetDir = path.join(resolvedPath, ...subpaths);
      if (!isSafeTempPath(targetDir)) {
        throw new Error(`Unsafe subdirectory path requested: ${targetDir}`);
      }
      fs.mkdirSync(targetDir, { recursive: true });
      return targetDir;
    },
    cleanup() {
      activeWorkspaces.delete(workspace);
      if (!isSafeTempPath(resolvedPath)) {
        throw new Error(`Refusing to delete unsafe directory: ${resolvedPath}`);
      }
      try {
        if (fs.existsSync(resolvedPath)) {
          fs.rmSync(resolvedPath, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup on Windows (handles brief file locks)
      }
    },
  };

  activeWorkspaces.add(workspace);
  return workspace;
}

/**
 * Clean up all tracked test workspaces. Called automatically in test teardown hooks.
 */
export function cleanupAllTestWorkspaces(): void {
  const workspaces = Array.from(activeWorkspaces);
  for (const ws of workspaces) {
    ws.cleanup();
  }
}
