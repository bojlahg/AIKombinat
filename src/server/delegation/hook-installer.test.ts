import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));
vi.mock('../services/cli-status.js', () => ({ getToolStatus: vi.fn(async (provider: string) => ({ tool: provider, installed: true, version: 'test-1.0' })) }));

const {
  delegationHookBridgePath, getDelegationHookStatus, installDelegationHook,
  removeDelegationHook, resolveManagedHookDefinition,
} = await import('./hook-installer.js');
const { createParentExecution, recordObservation } = await import('./store.js');

describe('delegation hook installer', () => {
  let workspace: TestWorkspace;
  beforeEach(() => {
    workspace = createTestWorkspace('delegation-hooks'); testDb = new Database(':memory:'); initDatabase(testDb);
    testDb.prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Project', ?)").run(workspace.path);
    testDb.prepare("INSERT INTO todos (id, project_id, title) VALUES ('todo', 'project', 'Todo')").run();
  });
  afterEach(() => { testDb.close(); workspace.cleanup(); vi.restoreAllMocks(); });

  it('preserves unrelated Claude settings and hooks, installs once, and removes only its own entry', async () => {
    const dir = workspace.createSubdir('.claude');
    const file = path.join(dir, 'settings.json');
    const existing = { permissions: { deny: ['Read(.env)'], ask: ['Bash(*)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'existing', args: [] }] }] } };
    fs.writeFileSync(file, JSON.stringify(existing));
    await installDelegationHook('claude', workspace.path);
    await installDelegationHook('claude', workspace.path);
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(installed.permissions).toEqual(existing.permissions);
    expect(installed.hooks.PreToolUse).toHaveLength(2);
    expect(fs.existsSync(`${file}.aikombinat-backup`)).toBe(true);
    await removeDelegationHook('claude', workspace.path);
    const removed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(removed.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
  });

  it('refuses malformed JSON without overwriting it', async () => {
    const dir = workspace.createSubdir('.claude');
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{broken');
    await expect(installDelegationHook('claude', workspace.path)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('reports manual action when Codex inline hooks already exist and otherwise reports needs_trust', async () => {
    const dir = workspace.createSubdir('.codex');
    fs.writeFileSync(path.join(dir, 'config.toml'), '[hooks]\nenabled = true\n');
    expect((await installDelegationHook('codex', workspace.path)).state).toBe('manual_action_required');
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "gpt-test"\n');
    expect((await installDelegationHook('codex', workspace.path)).state).toBe('needs_trust');
    expect((await getDelegationHookStatus('codex', workspace.path)).verified).toBe(false);
  });

  it('is inert for an ordinary CLI run without AIKombinat execution context', () => {
    const result = spawnSync(process.execPath, [delegationHookBridgePath, 'claude'], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'large.ts' } }),
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('installs a runnable launcher under an app-data path containing spaces', async () => {
    const home = workspace.createSubdir('home with spaces');
    const status = await installDelegationHook('claude', home);
    const definition = resolveManagedHookDefinition('claude', home);
    expect(status).toMatchObject({ state: 'installed_unverified', installed: true, launcherRunnable: true });
    expect(fs.existsSync(definition.launcherPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(config.hooks.PreToolUse[0].hooks[0]).toMatchObject({
      command: definition.launcherPath,
      args: ['claude', definition.definitionHash],
    });
    const inert = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', definition.launcherPath, 'claude', definition.definitionHash], {
        input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
      })
      : spawnSync(definition.launcherPath, ['claude', definition.definitionHash], {
        input: '{}', encoding: 'utf8', env: { PATH: process.env.PATH ?? '' },
      });
    expect(inert.status).toBe(0);
    expect(inert.stdout).toBe('');
  });

  it('uses an exact runtime and Electron Node mode in the packaged launcher seam', async () => {
    const options = { runtimePath: process.execPath, packagedElectron: true, platform: process.platform };
    await installDelegationHook('claude', workspace.path, options);
    const definition = resolveManagedHookDefinition('claude', workspace.path, options);
    const launcher = fs.readFileSync(definition.launcherPath, 'utf8');
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(launcher).toContain(process.execPath);
    expect(launcher).toContain(definition.bridgeCopyPath);
  });

  it('defines a POSIX packaged launcher strategy for macOS and Linux', async () => {
    const options = { runtimePath: process.execPath, packagedElectron: true, platform: 'linux' as const };
    await installDelegationHook('claude', workspace.path, options);
    const definition = resolveManagedHookDefinition('claude', workspace.path, options);
    const launcher = fs.readFileSync(definition.launcherPath, 'utf8');
    expect(launcher).toMatch(/^#!\/bin\/sh\n/);
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1 exec');
  });

  it('distinguishes a configured hook from a missing runtime', async () => {
    const missingRuntime = path.join(workspace.path, 'missing runtime', 'node');
    const status = await installDelegationHook('claude', workspace.path, { runtimePath: missingRuntime });
    expect(status).toMatchObject({ state: 'incompatible', installed: true, launcherRunnable: false });
    expect(status.error).toContain('runtime is missing');
  });

  it('rejects a corrupted app-data bridge copy even after a matching hook observation', async () => {
    const installed = await installDelegationHook('claude', workspace.path);
    const definition = resolveManagedHookDefinition('claude', workspace.path);
    const parent = createParentExecution({
      ownerId: 'todo', workDir: workspace.path, executionSnapshot: {}, provider: 'claude',
      policyMode: 'telemetry', capability: 'bridge-integrity-capability',
    });
    recordObservation({
      parentExecution: parent, toolName: 'Read', operationType: 'read_file', decision: 'allow',
      decisionReason: 'telemetry_only', hookLatencyMs: 1, managedDefinitionHash: installed.definitionHash,
    });
    expect((await getDelegationHookStatus('claude', workspace.path)).state).toBe('verified');

    fs.writeFileSync(definition.bridgeCopyPath, 'corrupted bridge');

    const status = await getDelegationHookStatus('claude', workspace.path);
    expect(status).toMatchObject({ state: 'incompatible', installed: true, launcherRunnable: false, verified: false });
    expect(status.error).toContain('integrity mismatch');
  });

  it('verifies only a matching observation from the current installation', async () => {
    const installed = await installDelegationHook('claude', workspace.path);
    const parent = createParentExecution({
      ownerId: 'todo', workDir: workspace.path, executionSnapshot: {}, provider: 'claude',
      policyMode: 'telemetry', capability: 'hook-capability',
    });
    const observe = (managedDefinitionHash: string) => recordObservation({
      parentExecution: parent, toolName: 'Read', operationType: 'read_file', decision: 'allow',
      decisionReason: 'telemetry_only', hookLatencyMs: 1, managedDefinitionHash,
    });
    observe('0'.repeat(64));
    expect((await getDelegationHookStatus('claude', workspace.path)).state).toBe('installed_unverified');
    observe(installed.definitionHash!);
    expect((await getDelegationHookStatus('claude', workspace.path)).state).toBe('verified');

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await installDelegationHook('claude', workspace.path)).state).toBe('installed_unverified');
  });

  it('keeps Codex needs_trust distinct until the current definition is observed', async () => {
    const installed = await installDelegationHook('codex', workspace.path);
    expect(installed.state).toBe('needs_trust');
    const parent = createParentExecution({
      ownerId: 'todo', workDir: workspace.path, executionSnapshot: {}, provider: 'codex',
      policyMode: 'telemetry', capability: 'codex-hook-capability',
    });
    recordObservation({
      parentExecution: parent, toolName: 'exec_command', operationType: 'shell', decision: 'allow',
      decisionReason: 'telemetry_only', hookLatencyMs: 1, managedDefinitionHash: installed.definitionHash,
    });
    expect((await getDelegationHookStatus('codex', workspace.path)).state).toBe('verified');
  });
});
