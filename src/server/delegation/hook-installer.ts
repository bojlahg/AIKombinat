import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import TOML from '@iarna/toml';
import { getToolStatus } from '../services/cli-status.js';
import { logger } from '../logging/logger.js';
import { getDatabase } from '../db/connection.js';

export type DelegationHookProvider = 'claude' | 'codex';
export type DelegationHookState = 'not_installed' | 'installed_unverified' | 'needs_trust' | 'verified' | 'incompatible' | 'manual_action_required' | 'error';

interface HookCommand { type: 'command'; command: string; args?: string[]; timeout?: number }
interface HookGroup { matcher: string; hooks: HookCommand[] }
interface HookFile { hooks?: Record<string, HookGroup[]>; [key: string]: unknown }

const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/aikombinat-hook.js');

function configPaths(provider: DelegationHookProvider, homeOverride?: string) {
  const home = homeOverride ?? os.homedir();
  if (provider === 'claude') {
    const root = process.env.CLAUDE_CONFIG_DIR && !homeOverride ? process.env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
    return { hookFile: path.join(root, 'settings.json'), configFile: path.join(root, 'settings.json') };
  }
  const root = process.env.CODEX_HOME && !homeOverride ? process.env.CODEX_HOME : path.join(home, '.codex');
  return { hookFile: path.join(root, 'hooks.json'), configFile: path.join(root, 'config.toml') };
}

function isManaged(command: HookCommand | undefined, provider: DelegationHookProvider): boolean {
  if (!command || command.type !== 'command') return false;
  if (provider === 'codex') return command.command.includes(bridgePath) && command.command.includes('codex');
  if (command.command.toLowerCase() !== 'node' || !command.args) return false;
  return command.args.some((arg) => path.resolve(arg) === path.resolve(bridgePath)) && command.args.includes(provider);
}

function managedGroup(provider: DelegationHookProvider): HookGroup {
  if (provider === 'codex') {
    const quotedBridge = `"${bridgePath.replace(/"/g, '\\"')}"`;
    return { matcher: '.*', hooks: [{ type: 'command', command: `node ${quotedBridge} codex`, timeout: 5 }] };
  }
  return {
    matcher: 'Read|Bash|PowerShell',
    hooks: [{ type: 'command', command: 'node', args: [bridgePath, provider], timeout: 5 }],
  };
}

function readHookFile(file: string): HookFile {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Hook configuration must be a JSON object.');
  return parsed as HookFile;
}

function hasManaged(config: HookFile, provider: DelegationHookProvider): boolean {
  return (config.hooks?.PreToolUse ?? []).some((group) => Array.isArray(group.hooks) && group.hooks.some((hook) => isManaged(hook, provider)));
}

function atomicWriteWithBackup(file: string, value: HookFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.aikombinat-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function codexInlineHooksConflict(configFile: string): boolean {
  if (!fs.existsSync(configFile)) return false;
  const raw = fs.readFileSync(configFile, 'utf8');
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  return parsed.hooks !== undefined;
}

export async function getDelegationHookStatus(provider: DelegationHookProvider, homeOverride?: string) {
  const { hookFile, configFile } = configPaths(provider, homeOverride);
  let installed = false;
  let state: DelegationHookState = 'not_installed';
  let error: string | null = null;
  try {
    if (provider === 'codex' && codexInlineHooksConflict(configFile)) {
      state = 'manual_action_required';
    } else {
      installed = hasManaged(readHookFile(hookFile), provider);
      const observed = (getDatabase().prepare('SELECT 1 FROM delegation_tool_observations WHERE parent_provider = ? LIMIT 1').get(provider) !== undefined);
      if (installed) state = observed ? 'verified' : provider === 'codex' ? 'needs_trust' : 'installed_unverified';
    }
  } catch (err) {
    state = 'error';
    error = err instanceof Error ? err.message : String(err);
  }
  const tool = await getToolStatus(provider).catch(() => null);
  return { provider, state, installed, verified: state === 'verified', needsTrust: state === 'needs_trust', version: tool?.version ?? null, configPath: hookFile, error };
}

export async function installDelegationHook(provider: DelegationHookProvider, homeOverride?: string) {
  const { hookFile, configFile } = configPaths(provider, homeOverride);
  if (provider === 'codex' && codexInlineHooksConflict(configFile)) {
    return getDelegationHookStatus(provider, homeOverride);
  }
  const config = readHookFile(hookFile);
  if (!hasManaged(config, provider)) {
    const existing = config.hooks?.PreToolUse ?? [];
    config.hooks = { ...(config.hooks ?? {}), PreToolUse: [...existing, managedGroup(provider)] };
    atomicWriteWithBackup(hookFile, config);
    logger.info('delegation.hook.install', { msg: `${provider} delegation hook installed`, provider });
  }
  return getDelegationHookStatus(provider, homeOverride);
}

export async function removeDelegationHook(provider: DelegationHookProvider, homeOverride?: string) {
  const { hookFile } = configPaths(provider, homeOverride);
  const config = readHookFile(hookFile);
  if (!config.hooks?.PreToolUse || !hasManaged(config, provider)) return getDelegationHookStatus(provider, homeOverride);
  const next = config.hooks.PreToolUse
    .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isManaged(hook, provider)) }))
    .filter((group) => group.hooks.length > 0);
  config.hooks = { ...config.hooks, PreToolUse: next };
  if (next.length === 0) delete config.hooks.PreToolUse;
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  atomicWriteWithBackup(hookFile, config);
  logger.info('delegation.hook.remove', { msg: `${provider} delegation hook removed`, provider });
  return getDelegationHookStatus(provider, homeOverride);
}

export const delegationHookBridgePath = bridgePath;
