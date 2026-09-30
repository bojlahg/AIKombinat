import { createHash } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import { getComputeNode } from './resource-fabric.js';
import { getAdapter, parseCliHelpFlags, type CliBuildOptions } from './cli-adapters.js';
import { runProbe, shellQuote, sshArgs, type CommandRunner } from './resource-probes.js';
import { assertExternalAiCliAllowed } from '../utils/cli-guard.js';

export interface RemoteOpenCodeCapabilities {
  observed_at: string;
  context: string;
  installed: boolean;
  compatible: boolean;
  version: string | null;
  flags: string[];
  models: string[];
  models_verified: boolean;
}

export async function discoverRemoteOpenCode(nodeId: string, runner: CommandRunner = runProbe): Promise<RemoteOpenCodeCapabilities> {
  if (runner === runProbe) assertExternalAiCliAllowed('opencode');
  const node = getComputeNode(nodeId);
  if (node.transport !== 'ssh' || !node.connection || !node.identity || node.identity_changed) throw new Error('remote_opencode_node_unverified');
  const context = createHash('sha256').update(JSON.stringify([node.identity, node.connection])).digest('hex');
  const db = getDatabase();
  const row = db.prepare('SELECT observation_json FROM resource_observations WHERE node_id = ?').get(nodeId) as { observation_json: string } | undefined;
  const cached = row ? JSON.parse(row.observation_json).remote_opencode as RemoteOpenCodeCapabilities | undefined : undefined;
  const age = cached ? Date.now() - Date.parse(cached.observed_at) : Infinity;
  if (cached?.context === context && age >= 0 && age < 60_000) return cached;
  const probe = (args: string[]) => runner('ssh', sshArgs(node.connection!, ['opencode', ...args].map(shellQuote).join(' ')), 8000);
  const version = await probe(['--version']);
  const installed = version.code === 0 && !version.timed_out;
  const [run, modelsHelp, models] = installed ? await Promise.all([probe(['run', '--help']), probe(['models', '--help']), probe(['models'])]) : [];
  const flags = run?.code === 0 && !run.timed_out ? parseCliHelpFlags(run.stdout + '\n' + run.stderr) : [];
  const versionText = installed ? version.stdout.trim().split(/\r?\n/)[0].slice(0, 128) : null;
  const result: RemoteOpenCodeCapabilities = {
    observed_at: new Date().toISOString(), context, installed, version: versionText,
    compatible: !!versionText && /^1\./.test(versionText) && run?.code === 0 && !run.timed_out
      && modelsHelp?.code === 0 && !modelsHelp.timed_out && ['--format', '--model', '--agent'].every(flag => flags.includes(flag)),
    flags, models_verified: models?.code === 0 && !models.timed_out,
    models: models?.code === 0 && !models.timed_out ? [...new Set(models.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w./:+-]*(?:#[\w.-]+)?$/.test(line)))].slice(0, 2048) : [],
  };
  const fresh = getComputeNode(nodeId);
  if (fresh.identity !== node.identity || fresh.identity_changed || JSON.stringify(fresh.connection) !== JSON.stringify(node.connection)) throw new Error('remote_opencode_node_changed');
  db.prepare("UPDATE resource_observations SET observation_json = json_set(observation_json, '$.remote_opencode', json(?)) WHERE node_id = ?").run(JSON.stringify(result), nodeId);
  return result;
}

export function remoteOpenCodeArgs(options: CliBuildOptions, capabilities: RemoteOpenCodeCapabilities): string[] {
  if (!capabilities.installed || !capabilities.compatible) throw new Error('remote_opencode_unsupported');
  const model = options.effectiveModel ?? options.model;
  if (!capabilities.models_verified) throw new Error('remote_opencode_models_unverified');
  if (!model || !capabilities.models.includes(model)) throw new Error('model_unavailable_on_node');
  return getAdapter('opencode').buildArgs({ ...options, opencodeStandalone: capabilities.flags.includes('--standalone') });
}
