import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TestWorkspace {
  /** Root directory of the temporary workspace. */
  readonly path: string;
  /** Resolves relative subpaths inside this workspace. Throws if path escapes workspace. */
  resolvePath: (...subpaths: string[]) => string;
  /** Creates and returns a subdirectory inside this workspace. Throws if path escapes workspace. */
  createSubdir: (...subpaths: string[]) => string;
  /** Safely removes this temporary workspace and its contents. */
  cleanup: () => void;
}

const activeWorkspaces = new Set<TestWorkspace>();

function normalizePathForComparison(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Validates that the candidate path is strictly inside the specified workspace root
 * and does not escape via `..`, absolute paths, or sibling directories.
 */
function assertContained(workspaceRoot: string, ...subpaths: string[]): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  const target = path.resolve(resolvedRoot, ...subpaths);

  const normRoot = normalizePathForComparison(resolvedRoot);
  const normTarget = normalizePathForComparison(target);

  const rel = path.relative(normRoot, normTarget);
  if (rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error(`Path "${target}" escapes test workspace "${resolvedRoot}".`);
  }
  return target;
}

/**
 * Validates that the target path is strictly inside the system temporary directory
 * and is not the root temp directory itself.
 */
function isSafeTempPath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const normalizedTarget = normalizePathForComparison(targetPath);
  const normalizedTmpDir = normalizePathForComparison(os.tmpdir());

  // Target must be strictly inside os.tmpdir() and not os.tmpdir() itself
  if (normalizedTarget === normalizedTmpDir) return false;
  const rel = path.relative(normalizedTmpDir, normalizedTarget);
  if (rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../') || path.isAbsolute(rel)) {
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
      return assertContained(resolvedPath, ...subpaths);
    },
    createSubdir(...subpaths: string[]) {
      const targetDir = assertContained(resolvedPath, ...subpaths);
      if (normalizePathForComparison(targetDir) !== normalizePathForComparison(resolvedPath)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      return targetDir;
    },
    cleanup() {
      if (!isSafeTempPath(resolvedPath)) {
        throw new Error(`Refusing to delete unsafe directory: ${resolvedPath}`);
      }
      if (!fs.existsSync(resolvedPath)) {
        activeWorkspaces.delete(workspace);
        return;
      }

      const maxRetries = 5;
      const delayMs = 40;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          fs.rmSync(resolvedPath, { recursive: true, force: true });
          if (!fs.existsSync(resolvedPath)) {
            activeWorkspaces.delete(workspace);
            return;
          }
        } catch (err) {
          lastError = err;
          // Synchronous sleep for brief Windows file locks (e.g. SQLite / process release)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        }
      }

      if (fs.existsSync(resolvedPath)) {
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Failed to clean up test workspace at "${resolvedPath}": ${msg}`);
      }
      activeWorkspaces.delete(workspace);
    },
  };

  activeWorkspaces.add(workspace);
  return workspace;
}

/**
 * Returns the count of currently active (un-cleaned) test workspaces.
 */
export function getActiveWorkspacesCount(): number {
  return activeWorkspaces.size;
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

