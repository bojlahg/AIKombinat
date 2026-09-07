import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../test-utils/workspace.js';

let testDb: Database.Database;
vi.mock('../db/connection.js', () => ({ getDatabase: () => testDb }));

const { setSetting } = await import('../db/app-settings.js');
const { prepareTodoDelegationLaunch, setDelegationServerPort } = await import('./runtime.js');

describe('delegation parent runtime', () => {
  let workspace: TestWorkspace;
  beforeEach(() => {
    workspace = createTestWorkspace('delegation-runtime'); testDb = new Database(':memory:'); initDatabase(testDb);
    testDb.prepare("INSERT INTO projects (id, name, path) VALUES ('project', 'Project', ?)").run(workspace.path);
    testDb.prepare("INSERT INTO todos (id, project_id, title) VALUES ('todo', 'project', 'Todo')").run();
    setDelegationServerPort(4321);
  });
  afterEach(() => { testDb.close(); workspace.cleanup(); });

  it('defaults disabled and injects no execution context', () => {
    expect(prepareTodoDelegationLaunch({ todoId: 'todo', workDir: workspace.path, provider: 'claude', executionSnapshot: {}, mode: 'headless' })).toBeNull();
  });

  it('creates an execution-scoped Claude MCP config without storing the capability in it', () => {
    setSetting('delegation.enabled', '1'); setSetting('delegation.mode', 'telemetry');
    const launch = prepareTodoDelegationLaunch({ todoId: 'todo', workDir: workspace.path, provider: 'claude', model: 'logical', effectiveModel: 'frozen', executionSnapshot: { agent: 'claude' }, mode: 'headless' })!;
    expect(launch.runtimeEnv).toMatchObject({ AIKOMBINAT_EXECUTION_KIND: 'todo', AIKOMBINAT_DELEGATION_DEPTH: '0', AIKOMBINAT_DELEGATION_ENDPOINT: 'http://127.0.0.1:4321' });
    const configPath = launch.delegationMcp.configPath!;
    const config = fs.readFileSync(configPath, 'utf8');
    expect(config).toContain('kombinat-delegation');
    expect(config).not.toContain(launch.runtimeEnv.AIKOMBINAT_DELEGATION_CAPABILITY);
    launch.markStarted(123, { pid: 123 });
    launch.finish('completed');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(testDb.prepare('SELECT status, effective_model FROM delegation_parent_executions').get()).toEqual({ status: 'completed', effective_model: 'frozen' });
  });

  it('uses provider-native Codex config overrides and never creates a tracked config file', () => {
    setSetting('delegation.enabled', '1'); setSetting('delegation.mode', 'telemetry');
    const launch = prepareTodoDelegationLaunch({ todoId: 'todo', workDir: workspace.path, provider: 'codex', executionSnapshot: { agent: 'codex' }, mode: 'headless' })!;
    expect(launch.delegationMcp.configPath).toBeUndefined();
    expect(launch.delegationMcp.args).toHaveLength(1);
    launch.finish('cancelled');
  });
});
