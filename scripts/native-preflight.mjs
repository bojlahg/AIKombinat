#!/usr/bin/env node
/**
 * Standalone native-module preflight for the launcher scripts.
 *
 * Runs before `npm run build`, so it cannot import anything from `dist/` — the
 * classification here intentionally mirrors `src/server/services/native-preflight.ts`
 * in a form that works straight from source with no build step.
 *
 * Exits 0 when every critical addon loads, 1 with a readable diagnosis when one
 * does not. It never rebuilds or deletes anything.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const MODULES = ['better-sqlite3', 'node-pty'];

function classify(message) {
  if (/NODE_MODULE_VERSION/i.test(message)) return 'abi_mismatch';
  if (/was compiled against a different Node\.js version/i.test(message)) return 'abi_mismatch';
  if (/ERR_DLOPEN_FAILED/i.test(message)) return 'abi_mismatch';
  if (/is not a valid Win32 application/i.test(message)) return 'abi_mismatch';
  if (/invalid ELF header/i.test(message)) return 'abi_mismatch';
  if (/(wrong architecture|incompatible architecture|mach-o)/i.test(message)) return 'abi_mismatch';
  if (/Could not locate the bindings file/i.test(message)) return 'not_built';
  if (/Cannot find (module|package)/i.test(message)) return 'missing';
  return 'load_error';
}

const CAUSE = {
  abi_mismatch: 'node_modules appears to have been built for a different runtime (Node vs Electron, or a different Node major).',
  not_built: 'The compiled binary for this module is missing - the install skipped or failed its build step.',
  missing: 'The package is not installed in node_modules.',
  load_error: 'The module is installed but could not be loaded.',
};

const RECOVERY = {
  abi_mismatch: ['npm rebuild better-sqlite3 node-pty', '(for the desktop build instead: npm run electron:rebuild)'],
  not_built: ['npm rebuild better-sqlite3 node-pty'],
  missing: ['npm install'],
  load_error: ['npm rebuild better-sqlite3 node-pty'],
};

const failures = [];
for (const name of MODULES) {
  try {
    require(name);
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    const stack = err && err.stack ? String(err.stack) : '';
    failures.push({ name, message, kind: classify(`${message}\n${stack}`) });
  }
}

const runtimeLine = `runtime=node node=${process.version} abi=${process.versions.modules} platform=${process.platform} ${process.arch}`;

if (failures.length === 0) {
  console.log(`[startup/native] native modules OK (${MODULES.join(', ')}) ${runtimeLine}`);
  process.exit(0);
}

for (const failure of failures) {
  console.error('');
  console.error(`ERROR [startup/native] ${failure.name} could not be loaded.`);
  console.error('');
  console.error('Current runtime:');
  console.error(`  Node ${process.version}`);
  console.error(`  ABI ${process.versions.modules} (${process.platform} ${process.arch})`);
  console.error('');
  console.error('Likely cause:');
  console.error(`  ${CAUSE[failure.kind]}`);
  console.error('');
  console.error('Recovery:');
  for (const line of RECOVERY[failure.kind]) console.error(`  ${line}`);
  console.error('');
  console.error('Original error:');
  console.error(`  ${failure.message.split('\n')[0]}`);
}
console.error('');
console.error('Startup aborted: critical native modules are not usable with this runtime.');
process.exit(1);
