import { execFile } from 'child_process';
import { maybeTriggerSync } from './model-sync.js';
import type { CliTool } from './cli-adapters.js';
import { getRawShellInfo, parseCliHelpFlags } from './cli-adapters.js';
import { getDatabase } from '../db/connection.js';
import { assertExternalAiCliAllowed } from '../utils/cli-guard.js';

export interface CliToolStatus {
  tool: string;
  installed: boolean;
  version: string | null;
  /** Cached flags from provider help; omitted for non-AI tools and test mocks. */
  capabilities?: string[];
}

interface CacheEntry {
  status: CliToolStatus;
  timestamp: number;
}

const CACHE_TTL = 60_000; // 60 seconds
const CHECK_TIMEOUT = 5_000; // 5 seconds
const cache = new Map<string, CacheEntry>();

const TOOLS = [
  { tool: 'claude', command: 'claude' },
  { tool: 'antigravity', command: 'agy', helpArgs: ['--help'] },
  // Resume owns --last while sandbox/approval flags belong to exec. Probe both
  // once per cache lifetime so continued headless sessions are validated too.
  { tool: 'codex', command: 'codex', helpArgs: ['exec', '--help'], secondaryHelpArgs: ['exec', 'resume', '--help'] },
] as const;

// VCS tools listed alongside AI CLIs but skip model-sync — they're not
// model-bearing CLIs, just installation probes for UI guidance.
const VCS_TOOLS = [
  { tool: 'svn', command: 'svn' },
] as const;

function execProbe(command: string, args: string[]): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const opts: { timeout: number; shell?: boolean } = { timeout: CHECK_TIMEOUT };
    if (process.platform === 'win32') opts.shell = true;
    execFile(command, args, opts, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function checkTool(
  tool: string,
  command: string,
  isVcs = false,
  helpArgs?: readonly string[],
  secondaryHelpArgs?: readonly string[],
): Promise<CliToolStatus> {
  if (!isVcs) {
    try {
      assertExternalAiCliAllowed(command);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  const probeArgs = [
    ['--version'],
    ...(helpArgs ? [helpArgs] : []),
    ...(secondaryHelpArgs ? [secondaryHelpArgs] : []),
  ];
  const [versionProbe, ...helpProbes] = await Promise.all(
    probeArgs.map((args) => execProbe(command, [...args])),
  );
  if (versionProbe.error) return { tool, installed: false, version: null };

  const version = versionProbe.stdout.trim().split('\n')[0].trim() || null;
  if (!isVcs) {
    await maybeTriggerSync(tool as CliTool, version);
  }
  const helpText = helpProbes
    .filter((probe) => !probe.error || probe.stdout || probe.stderr)
    .map((probe) => `${probe.stdout}\n${probe.stderr}`)
    .join('\n');
  return {
    tool,
    installed: true,
    version,
    ...(helpArgs ? { capabilities: parseCliHelpFlags(helpText) } : {}),
  };
}

/**
 * VCS tools are only probed when at least one project explicitly opted in.
 * This keeps "no SVN here" installs free of stray svn process spawns and
 * the svn entry out of the API response.
 */
function svnRequested(): boolean {
  try {
    const row = getDatabase()
      .prepare('SELECT 1 FROM projects WHERE svn_enabled = 1 LIMIT 1')
      .get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Cached single-tool probe for pre-flight checks before spawning a CLI.
 * On Windows spawn uses shell:true, so a missing binary never fires ENOENT —
 * cmd.exe just exits 1 with a localized "not recognized" message. Probing
 * first turns that into an actionable error. Returns null for tools without
 * an installation probe (e.g. raw-shell).
 */
export async function getToolStatus(tool: string): Promise<CliToolStatus | null> {
  if (tool === 'raw-shell') {
    return { tool: 'raw-shell', installed: true, version: getRawShellInfo().name };
  }
  const entry = TOOLS.find((t) => t.tool === tool);
  if (!entry) return null;
  const cached = cache.get(tool);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.status;
  const status = await checkTool(
    entry.tool,
    entry.command,
    false,
    'helpArgs' in entry ? entry.helpArgs : undefined,
    'secondaryHelpArgs' in entry ? entry.secondaryHelpArgs : undefined,
  );
  cache.set(tool, { status, timestamp: Date.now() });
  return status;
}

export async function checkAllTools(): Promise<CliToolStatus[]> {
  const now = Date.now();
  const aiNeeds: typeof TOOLS[number][] = [];
  const vcsNeeds: typeof VCS_TOOLS[number][] = [];
  const results: CliToolStatus[] = [];
  const includeSvn = svnRequested();

  for (const t of TOOLS) {
    const cached = cache.get(t.tool);
    if (cached && now - cached.timestamp < CACHE_TTL) results.push(cached.status);
    else aiNeeds.push(t);
  }
  if (includeSvn) {
    for (const t of VCS_TOOLS) {
      const cached = cache.get(t.tool);
      if (cached && now - cached.timestamp < CACHE_TTL) results.push(cached.status);
      else vcsNeeds.push(t);
    }
  }

  const checked = await Promise.all([
    ...aiNeeds.map((t) => checkTool(
      t.tool,
      t.command,
      false,
      'helpArgs' in t ? t.helpArgs : undefined,
      'secondaryHelpArgs' in t ? t.secondaryHelpArgs : undefined,
    )),
    ...vcsNeeds.map((t) => checkTool(t.tool, t.command, true)),
  ]);
  for (const status of checked) {
    cache.set(status.tool, { status, timestamp: now });
    results.push(status);
  }

  // Return in consistent order: AI tools first, then VCS tools (when included)
  const order = [
    ...TOOLS.map((t) => t.tool),
    ...(includeSvn ? VCS_TOOLS.map((t) => t.tool) : []),
  ];
  const ordered = order.map((tool) => results.find((r) => r.tool === tool)!);
  // raw-shell is always available; report the resolved shell name so the UI
  // can label it "Raw Shell (PowerShell)" etc. No process is spawned.
  ordered.push({ tool: 'raw-shell', installed: true, version: getRawShellInfo().name });
  return ordered;
}

export function clearCache(): void {
  cache.clear();
}
