import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CliTool } from '../services/cli-adapters.js';
import { createParentExecution, updateParentExecution, type DelegationMode, type ParentExecutionRow } from './store.js';
import { getDelegationSettings } from './settings.js';

let delegationBaseUrl: string | null = null;
const mcpBridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/aikombinat-delegation-mcp.js');

export function setDelegationServerPort(port: number): void {
  delegationBaseUrl = `http://127.0.0.1:${port}`;
}

export interface PreparedDelegationLaunch {
  parent: ParentExecutionRow;
  runtimeEnv: Record<string, string>;
  delegationMcp: { configPath?: string; command: string; args: string[] };
  markStarted(pid: number, processIdentity: unknown): void;
  finish(status: 'completed' | 'failed' | 'cancelled'): void;
}

export function prepareTodoDelegationLaunch(input: {
  todoId: string;
  workDir: string;
  provider: CliTool;
  model?: string | null;
  effectiveModel?: string | null;
  executionSnapshot: unknown;
  mode: string;
}): PreparedDelegationLaunch | null {
  const settings = getDelegationSettings();
  if (!settings.enabled || settings.mode === 'disabled' || !delegationBaseUrl) return null;
  if (input.mode !== 'headless' || (input.provider !== 'claude' && input.provider !== 'codex')) return null;
  const capability = crypto.randomBytes(32).toString('base64url');
  const parent = createParentExecution({
    ownerId: input.todoId, workDir: input.workDir, executionSnapshot: input.executionSnapshot,
    provider: input.provider, model: input.model, effectiveModel: input.effectiveModel,
    policyMode: settings.mode as DelegationMode, capability,
  });
  const command = process.execPath;
  const args = [mcpBridgePath];
  let tempDir: string | null = null;
  let configPath: string | undefined;
  if (input.provider === 'claude') {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-delegation-'));
    configPath = path.join(tempDir, 'mcp.json');
    fs.writeFileSync(configPath, `${JSON.stringify({ mcpServers: { 'kombinat-delegation': { command, args } } }, null, 2)}\n`, { mode: 0o600 });
  }
  let finished = false;
  return {
    parent,
    runtimeEnv: {
      AIKOMBINAT_EXECUTION_ID: parent.id,
      AIKOMBINAT_EXECUTION_KIND: 'todo',
      AIKOMBINAT_DELEGATION_DEPTH: '0',
      AIKOMBINAT_DELEGATION_ENDPOINT: delegationBaseUrl,
      AIKOMBINAT_DELEGATION_CAPABILITY: capability,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    delegationMcp: { command, args, ...(configPath ? { configPath } : {}) },
    markStarted(pid, processIdentity) {
      updateParentExecution(parent.id, { status: 'running', processPid: pid, processIdentity: processIdentity ? JSON.stringify(processIdentity) : null });
    },
    finish(status) {
      if (finished) return;
      finished = true;
      updateParentExecution(parent.id, { status, processPid: null, processIdentity: null, finished: true });
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
      }
    },
  };
}
