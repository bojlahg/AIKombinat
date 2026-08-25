import fs from 'fs';
import os from 'os';
import path from 'path';

export const UNEXPECTED_FS_WRITE_MESSAGE = 'Unexpected filesystem write outside test workspace:';

/**
 * Returns true if running in a test runner environment (Vitest / NODE_ENV=test).
 */
export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

function normalizePathForComparison(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathContainedInRoot(root: string, target: string): boolean {
  const normRoot = normalizePathForComparison(root);
  const normTarget = normalizePathForComparison(target);
  const rel = path.relative(normRoot, normTarget);
  if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) {
    return true;
  }
  return false;
}

const customApprovedRoots = new Set<string>();

/**
 * Allow tests to register an additional approved root if necessary.
 */
export function registerApprovedTestRoot(rootPath: string): void {
  customApprovedRoots.add(path.resolve(rootPath));
}

export function unregisterApprovedTestRoot(rootPath: string): void {
  customApprovedRoots.delete(path.resolve(rootPath));
}

/**
 * Validates whether a target path is allowed for runtime write operations during test mode.
 */
export function isTestRuntimePathAllowed(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;

  // Check against os.tmpdir()
  const sysTmp = os.tmpdir();
  if (isPathContainedInRoot(sysTmp, targetPath)) {
    return true;
  }

  // Check against realpath of os.tmpdir() (e.g. /var vs /private/var on macOS)
  try {
    const realTmp = fs.realpathSync(sysTmp);
    if (realTmp !== sysTmp && isPathContainedInRoot(realTmp, targetPath)) {
      return true;
    }
  } catch {
    // Ignore realpath failure on tmpdir
  }

  // Check any custom registered roots
  for (const root of customApprovedRoots) {
    if (isPathContainedInRoot(root, targetPath)) {
      return true;
    }
    try {
      const realRoot = fs.realpathSync(root);
      if (realRoot !== root && isPathContainedInRoot(realRoot, targetPath)) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

/**
 * Throws a fail-closed error if attempting to perform a runtime filesystem write outside
 * an approved test workspace in a test environment.
 * Outside test environments, this is a no-op with zero side effects.
 */
export function assertTestRuntimePathAllowed(targetPath: string): void {
  if (!isTestEnvironment()) {
    return;
  }

  if (!isTestRuntimePathAllowed(targetPath)) {
    throw new Error(`${UNEXPECTED_FS_WRITE_MESSAGE} ${targetPath}`);
  }
}
