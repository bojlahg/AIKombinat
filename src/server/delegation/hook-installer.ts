import crypto from 'crypto';
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

export interface HookRuntimeOptions {
  runtimePath?: string;
  packagedElectron?: boolean;
  platform?: NodeJS.Platform;
}

interface ManagedDefinition {
  provider: DelegationHookProvider;
  definitionHash: string;
  group: HookGroup;
  launcherPath: string;
  bridgeCopyPath: string;
  runtimePath: string;
  packagedElectron: boolean;
  platform: NodeJS.Platform;
}

const HOOK_SCHEMA_VERSION = 2;
const HOOK_BRIDGE_VERSION = 1;
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

function appDataRoot(homeOverride?: string): string {
  if (homeOverride) return path.join(homeOverride, '.aikombinat');
  const dbPath = process.env.DB_PATH?.trim();
  return dbPath ? path.dirname(path.resolve(dbPath)) : path.join(os.homedir(), '.aikombinat');
}

function normalizeIdentityPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/');
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '""').replace(/%/g, '%%')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function resolveManagedHookDefinition(
  provider: DelegationHookProvider,
  homeOverride?: string,
  runtimeOptions: HookRuntimeOptions = {},
): ManagedDefinition {
  const platform = runtimeOptions.platform ?? process.platform;
  const runtimePath = path.resolve(runtimeOptions.runtimePath ?? process.execPath);
  const packagedElectron = runtimeOptions.packagedElectron ?? !!process.versions.electron;
  const launcherDir = path.join(appDataRoot(homeOverride), 'delegation-hooks');
  const launcherPath = path.join(launcherDir, platform === 'win32' ? 'aikombinat-hook.cmd' : 'aikombinat-hook');
  const bridgeCopyPath = path.join(launcherDir, 'aikombinat-hook.js');
  const bridgeSha256 = crypto.createHash('sha256').update(fs.readFileSync(bridgePath)).digest('hex');
  const normalized = JSON.stringify({
    schemaVersion: HOOK_SCHEMA_VERSION,
    bridgeVersion: HOOK_BRIDGE_VERSION,
    provider,
    matcher: provider === 'claude' ? 'Read|Bash|PowerShell' : '.*',
    runtimePath: normalizeIdentityPath(runtimePath),
    launcherPath: normalizeIdentityPath(launcherPath),
    bridgePath: normalizeIdentityPath(bridgeCopyPath),
    bridgeSha256,
    packagedElectron,
  });
  const definitionHash = crypto.createHash('sha256').update(normalized).digest('hex');
  const hook: HookCommand = provider === 'codex'
    ? { type: 'command', command: `${shellQuote(launcherPath, platform)} codex ${definitionHash}`, timeout: 5 }
    : { type: 'command', command: launcherPath, args: ['claude', definitionHash], timeout: 5 };
  return {
    provider, definitionHash, launcherPath, bridgeCopyPath, runtimePath, packagedElectron, platform,
    group: { matcher: provider === 'claude' ? 'Read|Bash|PowerShell' : '.*', hooks: [hook] },
  };
}

function isManaged(command: HookCommand | undefined, provider: DelegationHookProvider): boolean {
  if (!command || command.type !== 'command') return false;
  const text = `${command.command}\n${(command.args ?? []).join('\n')}`.replace(/\\/g, '/').toLowerCase();
  return text.includes('aikombinat-hook') && text.includes(provider);
}

function definitionHashFromHook(command: HookCommand, provider: DelegationHookProvider): string | null {
  if (!isManaged(command, provider)) return null;
  const values = [command.command, ...(command.args ?? [])];
  return values.flatMap((value) => value.match(/[a-f0-9]{64}/g) ?? []).at(-1) ?? null;
}

function findManaged(config: HookFile, provider: DelegationHookProvider): HookCommand | undefined {
  for (const group of config.hooks?.PreToolUse ?? []) {
    const hook = Array.isArray(group.hooks) ? group.hooks.find((item) => isManaged(item, provider)) : undefined;
    if (hook) return hook;
  }
  return undefined;
}

function readHookFile(file: string): HookFile {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Hook configuration must be a JSON object.');
  return parsed as HookFile;
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

function writeLauncher(definition: ManagedDefinition): void {
  fs.mkdirSync(path.dirname(definition.launcherPath), { recursive: true });
  fs.copyFileSync(bridgePath, definition.bridgeCopyPath);
  fs.chmodSync(definition.bridgeCopyPath, 0o600);
  const content = definition.platform === 'win32'
    ? `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${shellQuote(definition.runtimePath, 'win32')} ${shellQuote(definition.bridgeCopyPath, 'win32')} %*\r\n`
    : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(definition.runtimePath, definition.platform)} ${shellQuote(definition.bridgeCopyPath, definition.platform)} "$@"\n`;
  fs.writeFileSync(definition.launcherPath, content, { encoding: 'utf8', mode: 0o700 });
  if (definition.platform !== 'win32') fs.chmodSync(definition.launcherPath, 0o700);
}

function launcherDiagnostic(definition: ManagedDefinition): string | null {
  if (!fs.existsSync(definition.launcherPath)) return `Managed hook launcher is missing: ${definition.launcherPath}`;
  if (!fs.existsSync(definition.bridgeCopyPath)) return `Managed hook bridge is missing: ${definition.bridgeCopyPath}`;
  if (!fs.existsSync(definition.runtimePath)) return `Managed hook runtime is missing: ${definition.runtimePath}`;
  if (definition.platform !== 'win32') {
    try {
      if ((fs.statSync(definition.launcherPath).mode & 0o111) === 0) return `Managed hook launcher is not executable: ${definition.launcherPath}`;
    } catch (err) { return err instanceof Error ? err.message : String(err); }
  }
  return null;
}

function replaceManaged(config: HookFile, provider: DelegationHookProvider, group: HookGroup): HookFile {
  const existing = config.hooks?.PreToolUse ?? [];
  const preserved = existing
    .map((item) => ({ ...item, hooks: item.hooks.filter((hook) => !isManaged(hook, provider)) }))
    .filter((item) => item.hooks.length > 0);
  return { ...config, hooks: { ...(config.hooks ?? {}), PreToolUse: [...preserved, group] } };
}

export async function getDelegationHookStatus(
  provider: DelegationHookProvider,
  homeOverride?: string,
  runtimeOptions: HookRuntimeOptions = {},
) {
  const { hookFile, configFile } = configPaths(provider, homeOverride);
  let installed = false;
  let launcherRunnable = false;
  let state: DelegationHookState = 'not_installed';
  let error: string | null = null;
  let definitionHash: string | null = null;
  try {
    if (provider === 'codex' && codexInlineHooksConflict(configFile)) {
      state = 'manual_action_required';
    } else {
      const definition = resolveManagedHookDefinition(provider, homeOverride, runtimeOptions);
      definitionHash = definition.definitionHash;
      const managed = findManaged(readHookFile(hookFile), provider);
      installed = !!managed;
      if (managed) {
        const installedHash = definitionHashFromHook(managed, provider);
        const launcherError = launcherDiagnostic(definition);
        launcherRunnable = !launcherError;
        if (launcherError) {
          state = 'incompatible';
          error = launcherError;
        } else if (installedHash !== definition.definitionHash) {
          state = 'installed_unverified';
          error = 'Managed hook definition is outdated; reinstall it.';
        } else {
          const installation = getDatabase().prepare(`SELECT definition_hash, installed_at
            FROM delegation_hook_installations WHERE provider = ?`).get(provider) as { definition_hash: string; installed_at: string } | undefined;
          const observed = installation?.definition_hash === definition.definitionHash
            && getDatabase().prepare(`SELECT 1 FROM delegation_tool_observations
              WHERE parent_provider = ? AND managed_definition_hash = ? AND observed_at >= ? LIMIT 1`).get(
                provider, definition.definitionHash, installation.installed_at,
              ) !== undefined;
          state = observed ? 'verified' : provider === 'codex' ? 'needs_trust' : 'installed_unverified';
        }
      }
    }
  } catch (err) {
    state = 'error';
    error = err instanceof Error ? err.message : String(err);
  }
  const tool = await getToolStatus(provider).catch(() => null);
  return {
    provider, state, installed, launcherRunnable, definitionHash,
    verified: state === 'verified', needsTrust: state === 'needs_trust',
    version: tool?.version ?? null, configPath: hookFile, error,
  };
}

export async function installDelegationHook(
  provider: DelegationHookProvider,
  homeOverride?: string,
  runtimeOptions: HookRuntimeOptions = {},
) {
  const { hookFile, configFile } = configPaths(provider, homeOverride);
  if (provider === 'codex' && codexInlineHooksConflict(configFile)) {
    return getDelegationHookStatus(provider, homeOverride, runtimeOptions);
  }
  const definition = resolveManagedHookDefinition(provider, homeOverride, runtimeOptions);
  const config = readHookFile(hookFile);
  writeLauncher(definition);
  atomicWriteWithBackup(hookFile, replaceManaged(config, provider, definition.group));
  getDatabase().prepare(`INSERT INTO delegation_hook_installations (provider, definition_hash, installed_at)
    VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET definition_hash = excluded.definition_hash,
      installed_at = excluded.installed_at`).run(provider, definition.definitionHash, new Date().toISOString());
  logger.info('delegation.hook.install', {
    msg: `${provider} delegation hook installed`, provider, definitionHash: definition.definitionHash,
  });
  return getDelegationHookStatus(provider, homeOverride, runtimeOptions);
}

export async function removeDelegationHook(
  provider: DelegationHookProvider,
  homeOverride?: string,
  runtimeOptions: HookRuntimeOptions = {},
) {
  const { hookFile } = configPaths(provider, homeOverride);
  const config = readHookFile(hookFile);
  const existing = config.hooks?.PreToolUse ?? [];
  const hadManaged = existing.some((group) => group.hooks.some((hook) => isManaged(hook, provider)));
  if (hadManaged) {
    const next = existing
      .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isManaged(hook, provider)) }))
      .filter((group) => group.hooks.length > 0);
    config.hooks = { ...(config.hooks ?? {}), PreToolUse: next };
    if (next.length === 0) delete config.hooks.PreToolUse;
    if (Object.keys(config.hooks).length === 0) delete config.hooks;
    atomicWriteWithBackup(hookFile, config);
  }
  getDatabase().prepare('DELETE FROM delegation_hook_installations WHERE provider = ?').run(provider);
  logger.info('delegation.hook.remove', { msg: `${provider} delegation hook removed`, provider });
  return getDelegationHookStatus(provider, homeOverride, runtimeOptions);
}

export const delegationHookBridgePath = bridgePath;
