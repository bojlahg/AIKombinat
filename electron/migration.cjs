const fs = require('node:fs');
const path = require('node:path');

function mapMigratedFilename(filename) {
  if (filename === 'clitrigger.db') return 'aikombinat.db';
  if (filename === 'clitrigger.db-wal') return 'aikombinat.db-wal';
  if (filename === 'clitrigger.db-shm') return 'aikombinat.db-shm';
  return filename;
}

function defaultLogger(message, error) {
  if (error) {
    console.error(`[migration] ${message}:`, error);
  } else {
    console.error(`[migration] ${message}`);
  }
}

/**
 * Recursively reconciles sourceDir into targetDir.
 * - Missing directories and files in targetDir are copied from sourceDir.
 * - Existing files/directories in targetDir are NEVER overwritten (target data wins).
 * - Source files/directories are NEVER deleted (preserves legacy data as backup).
 * - File names can be mapped using filenameMapper (e.g. clitrigger.db -> aikombinat.db).
 */
function reconcileDirectory(sourceDir, targetDir, options = {}) {
  const logger = options.logger || defaultLogger;
  const filenameMapper = options.filenameMapper || mapMigratedFilename;

  try {
    if (!fs.existsSync(sourceDir)) return;
    if (path.resolve(sourceDir) === path.resolve(targetDir)) return;

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(sourceDir, entry.name);
      const destName = filenameMapper ? filenameMapper(entry.name) : entry.name;
      const destPath = path.join(targetDir, destName);

      try {
        if (entry.isDirectory()) {
          if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
          }
          if (fs.statSync(destPath).isDirectory()) {
            reconcileDirectory(srcPath, destPath, options);
          } else {
            logger(`Destination ${destPath} is not a directory, skipping source directory ${srcPath}`);
          }
        } else if (entry.isFile()) {
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      } catch (entryErr) {
        logger(`Failed to reconcile entry ${srcPath} -> ${destPath}`, entryErr);
      }
    }
  } catch (err) {
    logger(`Failed to reconcile directory ${sourceDir} -> ${targetDir}`, err);
  }
}

/**
 * Reconciles legacy db files within targetDir if aikombinat.db is not yet present.
 */
function reconcileTargetDatabase(targetDir, options = {}) {
  const logger = options.logger || defaultLogger;
  try {
    const targetDb = path.join(targetDir, 'aikombinat.db');
    const legacyDbInTarget = path.join(targetDir, 'clitrigger.db');

    if (!fs.existsSync(targetDb) && fs.existsSync(legacyDbInTarget)) {
      fs.copyFileSync(legacyDbInTarget, targetDb);
      if (fs.existsSync(`${legacyDbInTarget}-wal`)) {
        fs.copyFileSync(`${legacyDbInTarget}-wal`, `${targetDb}-wal`);
      }
      if (fs.existsSync(`${legacyDbInTarget}-shm`)) {
        fs.copyFileSync(`${legacyDbInTarget}-shm`, `${targetDb}-shm`);
      }
    }
  } catch (err) {
    logger(`Failed to reconcile target database in ${targetDir}`, err);
  }
}

/**
 * Migrates Electron userData from legacy directories (e.g. CLITrigger / clitrigger).
 */
function migrateLegacyUserData(targetDir, options = {}) {
  const logger = options.logger || defaultLogger;
  try {
    const parentDir = path.dirname(targetDir);
    const legacyCandidates = options.legacyCandidates || [
      path.join(parentDir, 'CLITrigger'),
      path.join(parentDir, 'clitrigger'),
    ];

    for (const legacyDir of legacyCandidates) {
      if (fs.existsSync(legacyDir) && path.resolve(legacyDir) !== path.resolve(targetDir)) {
        reconcileDirectory(legacyDir, targetDir, options);
      }
    }

    reconcileTargetDatabase(targetDir, options);
  } catch (err) {
    logger(`Failed to migrate legacy userData into ${targetDir}`, err);
  }
}

/**
 * Migrates CLI config and database from legacy directory (e.g. ~/.clitrigger).
 */
function migrateLegacyCliDir(targetDir, legacyDir, options = {}) {
  const logger = options.logger || defaultLogger;
  try {
    if (legacyDir && fs.existsSync(legacyDir) && path.resolve(legacyDir) !== path.resolve(targetDir)) {
      reconcileDirectory(legacyDir, targetDir, options);
    }
    reconcileTargetDatabase(targetDir, options);
  } catch (err) {
    logger(`Failed to migrate legacy CLI directory into ${targetDir}`, err);
  }
}

/**
 * Parses a semver string (e.g. "0.2.50", "v1.0.0-beta.1") into major, minor, patch, prerelease components.
 */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const clean = v.trim().replace(/^v/i, '');
  const [core, ...prerelease] = clean.split('-');
  const parts = core.split('.').map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return null;
  while (parts.length < 3) parts.push(0);
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    prerelease: prerelease.join('-'),
  };
}

/**
 * Returns true if latestStr represents a newer semver than currentStr.
 */
function isNewerVersion(latestStr, currentStr) {
  const latest = parseSemver(latestStr);
  const current = parseSemver(currentStr);
  if (!latest || !current) return false;
  if (latest.major !== current.major) return latest.major > current.major;
  if (latest.minor !== current.minor) return latest.minor > current.minor;
  if (latest.patch !== current.patch) return latest.patch > current.patch;
  if (!latest.prerelease && current.prerelease) return true;
  return false;
}

module.exports = {
  defaultLogger,
  isNewerVersion,
  mapMigratedFilename,
  migrateLegacyCliDir,
  migrateLegacyUserData,
  parseSemver,
  reconcileDirectory,
  reconcileTargetDatabase,
};
