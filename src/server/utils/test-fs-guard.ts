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

function getCanonicalTempRoots(): string[] {
  const sysTmp = os.tmpdir();
  const roots = [sysTmp];
  try {
    const realTmp = fs.realpathSync(sysTmp);
    if (normalizePathForComparison(realTmp) !== normalizePathForComparison(sysTmp)) {
      roots.push(realTmp);
    }
  } catch {
    // Ignore realpath failure on tmpdir
  }
  return roots;
}

/**
 * Validates whether a target path is allowed for runtime write operations during test mode.
 * Enforces both lexical containment and filesystem canonicalization (preventing symlink /
 * junction escapes outside the temporary test workspace root).
 */
export function isTestRuntimePathAllowed(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;

  const tempRoots = getCanonicalTempRoots();

  // 1. Lexical containment check against known temp roots
  const lexicallyContained = tempRoots.some(root => isPathContainedInRoot(root, targetPath));
  if (!lexicallyContained) {
    return false;
  }

  // 2. Realpath / Symlink / Junction escape check
  // Resolve nearest existing ancestor to verify real filesystem location
  let current = path.resolve(targetPath);
  const uncreatedSegments: string[] = [];

  while (true) {
    if (fs.existsSync(current)) {
      try {
        const realAncestor = fs.realpathSync(current);
        const ancestorContained = tempRoots.some(root => isPathContainedInRoot(root, realAncestor));
        if (!ancestorContained) {
          return false;
        }

        if (uncreatedSegments.length > 0) {
          const reconstructed = path.resolve(realAncestor, ...uncreatedSegments);
          const reconstructedContained = tempRoots.some(root => isPathContainedInRoot(root, reconstructed));
          if (!reconstructedContained) {
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding existing ancestor
      return false;
    }
    uncreatedSegments.unshift(path.basename(current));
    current = parent;
  }
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

