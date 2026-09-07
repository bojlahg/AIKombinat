import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));

const { setSetting } = await import('../db/app-settings.js');
const { createParentExecution } = await import('./store.js');
const { decideHookOperation, formatHookResponse, normalizeHookOperation } = await import('./policy.js');

describe('delegation hook policy', () => {
  let workspace: TestWorkspace;
  let root: string;
  beforeEach(() => {
    workspace = createTestWorkspace('delegation-policy'); root = workspace.createSubdir('repo');
    testDb = new Database(':memory:'); initDatabase(testDb);
    testDb.prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Project', ?)").run(root);
    testDb.prepare("INSERT INTO todos (id, project_id, title) VALUES ('todo', 'project', 'Todo')").run();
    setSetting('delegation.enabled', '1');
  });
  afterEach(() => { testDb.close(); workspace.cleanup(); vi.restoreAllMocks(); });

  it('normalizes provider payloads without retaining raw shell commands', async () => {
    const parent = createParentExecution({ ownerId: 'todo', workDir: root, executionSnapshot: {}, provider: 'codex', policyMode: 'telemetry', capability: 'cap' });
    const normalized = normalizeHookOperation('codex', { tool_name: 'exec_command', tool_input: { command: 'Get-Content secret.ts' } });
    expect(normalized.operation).toMatchObject({ type: 'shell', commandKind: 'get-content', rawLength: 21 });
    await decideHookOperation('codex', parent, { tool_name: 'exec_command', tool_input: { command: 'Get-Content secret.ts' } });
    const row = testDb.prepare('SELECT command_hash, command_raw_length, command_kind FROM delegation_tool_observations').get() as Record<string, unknown>;
    expect(row).toMatchObject({ command_raw_length: 21, command_kind: 'get-content' });
    expect(JSON.stringify(row)).not.toContain('secret.ts');
  });

  it('allows targeted reads, observes full reads, and makes recursion a no-op', async () => {
    fs.writeFileSync(path.join(root, 'large.ts'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
    const parent = createParentExecution({ ownerId: 'todo', workDir: root, executionSnapshot: {}, provider: 'claude', policyMode: 'telemetry', capability: 'cap' });
    expect(await decideHookOperation('claude', parent, { tool_name: 'Read', tool_input: { file_path: 'large.ts', limit: 20 } })).toMatchObject({ decision: 'allow', reason: 'targeted_read' });
    expect(await decideHookOperation('claude', parent, { tool_name: 'Read', tool_input: { file_path: 'large.ts' } })).toMatchObject({ decision: 'allow', reason: 'telemetry_only' });
    expect(await decideHookOperation('claude', parent, { tool_name: 'Read', tool_input: { file_path: 'large.ts' } }, 1)).toMatchObject({ decision: 'allow', reason: 'delegation_depth' });
  });

  it('returns provider-native suggestion and denial output shapes', async () => {
    fs.writeFileSync(path.join(root, 'large.ts'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
    const parent = createParentExecution({ ownerId: 'todo', workDir: root, executionSnapshot: {}, provider: 'claude', policyMode: 'suggest', capability: 'cap' });
    const decision = await decideHookOperation('claude', parent, { tool_name: 'Read', tool_input: { file_path: 'large.ts' } });
    expect(decision.decision).toBe('suggest_bulk_read');
    expect(formatHookResponse('claude', decision)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('bulk_read') } });
    expect(formatHookResponse('claude', { decision: 'deny_use_bulk_read', reason: 'bulk_read_required', message: 'use bulk_read' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'use bulk_read' } });
  });
});
