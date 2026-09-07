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

const { delegationHookBridgePath, getDelegationHookStatus, installDelegationHook, removeDelegationHook } = await import('./hook-installer.js');

describe('delegation hook installer', () => {
  let workspace: TestWorkspace;
  beforeEach(() => { workspace = createTestWorkspace('delegation-hooks'); testDb = new Database(':memory:'); initDatabase(testDb); });
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
});
