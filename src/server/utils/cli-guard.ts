import path from 'path';

export const UNEXPECTED_CLI_LAUNCH_MESSAGE =
  'Unexpected real CLI launch from test. Install an explicit mock for this test.';

const AI_CLI_BASENAMES = new Set([
  'claude',
  'codex',
  'agy',
  'antigravity',
]);

/**
 * Returns true if running in a test runner environment (Vitest / NODE_ENV=test).
 */
export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/**
 * Checks if a given command or binary name corresponds to a recognized AI CLI executable.
 * Handles platform variations (.cmd, .exe, .bat, .ps1, etc.) and path prefixes.
 */
export function isRecognizedAiCli(command: string): boolean {
  if (!command || typeof command !== 'string') return false;

  const clean = command.trim().replace(/^["']|["']$/g, '');
  const base = path.basename(clean).toLowerCase();
  const nameWithoutExt = base.replace(/\.(cmd|exe|bat|ps1|sh)$/i, '');

  return AI_CLI_BASENAMES.has(base) || AI_CLI_BASENAMES.has(nameWithoutExt);
}

/**
 * Throws a fail-closed error if attempting to execute a real AI provider CLI in a test environment.
 * Allows non-AI binaries (e.g. process.execPath, git, svn) to execute normally.
 */
export function assertExternalAiCliAllowed(command: string): void {
  if (isTestEnvironment() && isRecognizedAiCli(command)) {
    throw new Error(UNEXPECTED_CLI_LAUNCH_MESSAGE);
  }
}
