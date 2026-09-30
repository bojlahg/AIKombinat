import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExternalAiCliAllowed } from '../utils/cli-guard.js';
import type { ResolvedExecutionConfig } from '../services/execution-config.js';
import { callTool, toolDefinitions } from './tools.js';
import { getTurn } from './store.js';

export interface PrimaryExecution {
  pid: number;
  exit: Promise<{ code: number; output: string; error: string }>;
  revoke(): Promise<void>;
}
export type PrimaryLauncher = (input: { orchestratorId: string; turnId: string; projectPath: string; config: ResolvedExecutionConfig; context: string }) => Promise<PrimaryExecution>;
export async function createTurnTransport(id: string, turnId: string) {
  const capability = randomBytes(32).toString('base64url');
  let active = true;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const provided = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${capability}`);
    if (!active || req.method !== 'POST' || req.url !== '/' || provided.length !== expected.length || !timingSafeEqual(provided, expected)) { res.writeHead(403).end(JSON.stringify({ error: 'invalid_capability' })); return; }
    const turn = getTurn(turnId);
    if (!turn || turn.orchestrator_id !== id || turn.status !== 'running') { res.writeHead(403).end(JSON.stringify({ error: 'expired_turn' })); return; }
    let body = '', bytes = 0;
    try {
      for await (const part of req) {
        bytes += Buffer.byteLength(part);
        if (bytes > 131072) { res.writeHead(413).end(JSON.stringify({ error: 'payload_too_large' })); req.destroy(); return; }
        body += part.toString();
      }
      const data = JSON.parse(body);
      if (data.method === 'tools/list') res.end(JSON.stringify({ tools: toolDefinitions }));
      else if (data.method === 'tools/call') {
        try {
          const result = await callTool(id, turnId, data.params?.name, data.params?.arguments);
          res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }));
        } catch (error) { res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'tool_error' }] })); }
      } else res.writeHead(400).end(JSON.stringify({ error: 'unknown_method' }));
    } catch { if (!res.headersSent) res.writeHead(400).end(JSON.stringify({ error: 'invalid_request' })); }
  });
  server.requestTimeout = 35_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('transport_address_missing');
  return { capability, endpoint: `http://127.0.0.1:${address.port}/`, async revoke() { active = false; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export const PRIMARY_RULES = `You are the durable Orchestrator Agent for this objective.
Do not directly modify repository files. Use child tasks for implementation and tests.
Do not poll in loops or sleep waiting for work. Use Resource Fabric through request_resources.
A resource is not yours until request_resources says bound/acquired.
When nothing productive remains, call yield. When the objective is complete, call finish.
Every successful turn must call exactly one yield or finish, then end your response immediately.
Persist important plan changes with checkpoint_state. Checkpoints are explicit work state, never hidden reasoning.
Child tasks do not inherit your context. Include objective subset, constraints, expected artifact and validation.
Use integration children for sibling branches; sibling worktrees are never automatically merged.
Mutating tools require stable idempotency keys across fresh turns. Repeated keys must have identical arguments.
All orchestration tools belong to kombinat-orchestrator. Only capability-based resource requests are allowed.`;

export const launchPrimary: PrimaryLauncher = async input => {
  assertExternalAiCliAllowed('claude');
  if (input.config.cliTool !== 'claude') throw new Error('claude_primary_required');
  const transport = await createTurnTransport(input.orchestratorId, input.turnId);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-orchestrator-'));
  const configPath = path.join(directory, 'mcp.json');
  const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/aikombinat-orchestrator-mcp.js');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { 'kombinat-orchestrator': { command: process.execPath, args: [bridge] } } }), { mode: 0o600 });
  const args = ['-p', '--output-format', 'json', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep,mcp__kombinat-orchestrator__*',
    '--disallowedTools', 'Bash,PowerShell,Edit,Write,NotebookEdit,Agent', '--permission-mode', 'dontAsk', '--setting-sources', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', configPath, '--system-prompt', PRIMARY_RULES, '--max-turns', '64'];
  const model = input.config.effectiveModel ?? input.config.model;
  if (model) args.push('--model', model);
  if (input.config.effort.nativeEffort) args.push('--effort', input.config.effort.nativeEffort);
  const environment: NodeJS.ProcessEnv = { ...process.env, AIKOMBINAT_ORCHESTRATOR_ENDPOINT: transport.endpoint, AIKOMBINAT_ORCHESTRATOR_CAPABILITY: transport.capability,
    AIKOMBINAT_ORCHESTRATION_DEPTH: '0', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  delete environment.CLAUDECODE;
  try {
    const child = spawn('claude', args, { cwd: input.projectPath, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.setEncoding('utf8').on('data', (part: string) => { output = (output + part).slice(-131072); });
    child.stderr.setEncoding('utf8').on('data', (part: string) => { error = (error + part).slice(-4096); });
    const exit = new Promise<{ code: number; output: string; error: string }>(resolve => {
      child.once('error', () => resolve({ code: -1, output: '', error: 'primary_spawn_failed' }));
      child.once('close', code => resolve({ code: code ?? -1, output, error }));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input.context);
    return { pid: child.pid ?? 0, exit, async revoke() { await transport.revoke(); fs.rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { await transport.revoke(); fs.rmSync(directory, { recursive: true, force: true }); throw error; }
};
