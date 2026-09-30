import { getProviderAccount } from './provider-account-service.js';
import { createChildEnvironment } from '../utils/child-environment.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { getDatabase } from '../db/connection.js';
import { logger } from '../logging/logger.js';
import { getComputeNode } from './resource-fabric.js';
import { shellQuote, sshArgs, type ProbeResult } from './resource-probes.js';
import { getAdapter, type CliTool, type CliBuildOptions } from './cli-adapters.js';
import { createOpenCodeConfig, OPEN_CODE_SHELL_GUARD } from './opencode.js';
import { assertRemoteOpenCodeEnabled, prepareRemoteOpenCodeArgs } from './remote-opencode.js';
import { canonicalJson } from './resource-requirements.js';
import type { FabricBinding } from './resource-fabric-types.js';
import type { ProcessIdentity } from '../utils/process-tree.js';
import type { StopResult } from './claude-manager.js';
import { assertExternalAiCliAllowed, isTestEnvironment } from '../utils/cli-guard.js';

export interface RemoteIdentity { nodeId: string; bindingId: string; workspace: string; pid: number; startedAt: string; bootId: string }
interface RemoteState { status: 'preparing' | 'running' | 'exited'; identity: { pid: number; startedAt: string; bootId: string }; exit_code?: number }
interface RemoteProbe { verdict: 'match' | 'mismatch' | 'unverifiable' | 'exited' | 'signalled'; state?: RemoteState; stdout?: string; stderr?: string; stdout_offset?: number; stderr_offset?: number; stdout_more?: boolean; stderr_more?: boolean }
export interface TransportResult { pid: number; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; stdin: NodeJS.WritableStream | null; exitPromise: Promise<number>; command: string; args: string[]; processIdentity?: ProcessIdentity | null }
export interface ExecutionTransport { readonly kind: 'local' | 'ssh' }
export class LocalTransport implements ExecutionTransport {
  readonly kind = 'local';
  launch(start: () => Promise<TransportResult>): Promise<TransportResult> { return start(); }
}
export class RemoteLaunchUnresolved extends Error {
  constructor(readonly identity: ProcessIdentity) { super('Remote launch ownership is unresolved; leases retained for recovery'); }
}
const helper = () => fs.readFileSync(fileURLToPath(new URL('../resources/resource-remote-helper.py', import.meta.url)), 'utf8');
function git(command: string[], cwd: string): Promise<string> { return new Promise((resolve, reject) => execFile('git', command, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new Error('Git bundle preparation failed')) : resolve(stdout.trim()))); }
export function remoteWorkspace(binding: FabricBinding): string {
  if (binding.remote_workspace) return binding.remote_workspace.replace(/\/repo$/, '');
  const node = getComputeNode(binding.node_id); if (!node.connection) throw new Error('SSH connection missing');
  return `${node.connection.workspace_root.replace(/\/$/, '')}/jobs/${binding.id}`;
}
export class SshTransport implements ExecutionTransport {
  readonly kind = 'ssh';
  private exits = new Map<string, { pid: number; promise: Promise<number> }>();
  constructor(private call: (nodeId: string, source: string, payload: object) => Promise<ProbeResult> = async (nodeId, source, payload) => {
    const node = getComputeNode(nodeId);
    if (isTestEnvironment()) return { stdout: '', stderr: 'Real SSH probe prohibited in tests; inject a runner', code: null, timed_out: false };
    const args = sshArgs(node.connection!, `python3 -c ${shellQuote(source)}`);
    return new Promise(resolve => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn('ssh', args, { env: createChildEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', bytes = 0, done = false;
        const finish = (code: number | null, timed_out: boolean) => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, stderr: stderr.slice(-512), code, timed_out }); };
        const timer = setTimeout(() => { child.kill(); finish(null, true); }, 20_000);
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) { child.kill(); finish(null, false); } else stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-512); });
        child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify(payload));
        child.on('error', () => finish(null, false)); child.on('close', code => finish(code, false));
      });
    });
  }) {}
  hasPid(pid: number) { return [...this.exits.values()].some(entry => entry.pid === pid); }
  retainedIdentity(bindingId: string): ProcessIdentity | null {
    const row = getDatabase().prepare("SELECT identity_json FROM remote_executions WHERE binding_id = ? AND status <> 'exited'").get(bindingId) as { identity_json: string | null } | undefined;
    return row?.identity_json ? JSON.parse(row.identity_json) : null;
  }
  async whenExited(pid: number, bindingId?: string): Promise<void> { await Promise.all([...this.exits.entries()].filter(([id, entry]) => entry.pid === pid && (!bindingId || id === bindingId)).map(([, entry]) => entry.promise)); }
  async inspect(remote: RemoteIdentity, mode: 'probe' | 'stop' = 'probe', force = false, offsets?: { stdout_offset: number; stderr_offset: number }): Promise<RemoteProbe> {
    try {
      const node = getComputeNode(remote.nodeId);
      if (!node.identity || node.identity_changed || (mode === 'stop' && remote.pid <= 0)) return { verdict: 'unverifiable' };
      const result = await this.call(node.id, helper(), { mode, workspace: remote.workspace, node_identity: node.identity, identity: remote.pid > 0 ? { pid: remote.pid, startedAt: remote.startedAt, bootId: remote.bootId } : undefined, force, ...offsets });
      if (result.code !== 0) return { verdict: 'unverifiable' };
      const data = JSON.parse(result.stdout) as RemoteProbe;
      if (!['match', 'mismatch', 'unverifiable', 'exited', 'signalled'].includes(data.verdict)) return { verdict: 'unverifiable' };
      return data;
    } catch { return { verdict: 'unverifiable' }; }
  }
  async reconcile(remote: RemoteIdentity): Promise<'match' | 'mismatch' | 'unverifiable' | 'exited'> {
    const result = await this.inspect(remote);
    if (result.verdict === 'match' && remote.pid === 0 && result.state?.identity) {
      const identity: ProcessIdentity = { pid: result.state.identity.pid, startedAt: result.state.identity.startedAt, remote: { ...remote, ...result.state.identity } };
      const db = getDatabase();
      db.transaction(() => {
        db.prepare("UPDATE remote_executions SET pid = ?, identity_json = ?, status = 'recovery_required' WHERE binding_id = ?").run(identity.pid, canonicalJson(identity), remote.bindingId);
        const request = db.prepare('SELECT r.owner_type, r.owner_id FROM resource_requests r JOIN resource_bindings b ON b.request_id = r.id WHERE b.id = ?').get(remote.bindingId) as { owner_type: 'todo'; owner_id: string } | undefined;
        if (request) db.prepare('UPDATE todos SET process_pid = ?, process_identity = ? WHERE id = ? AND process_pid = 1').run(identity.pid, canonicalJson(identity), request.owner_id);
      })();
      return 'unverifiable';
    }
    if (result.verdict === 'exited' || result.verdict === 'mismatch') getDatabase().prepare("UPDATE remote_executions SET status = 'exited', exit_code = ? WHERE binding_id = ?").run(result.state?.exit_code ?? 1, remote.bindingId);
    else if (result.verdict === 'unverifiable') getDatabase().prepare("UPDATE remote_executions SET status = 'recovery_required' WHERE binding_id = ?").run(remote.bindingId);
    return result.verdict === 'signalled' ? 'unverifiable' : result.verdict;
  }
  async stop(identity: ProcessIdentity, force = false): Promise<StopResult> {
    const remote = identity.remote!;
    const before = await this.inspect(remote);
    if (before.verdict === 'exited') { await this.reconcile(remote); return { status: 'already_exited', pid: identity.pid }; }
    if (before.verdict === 'mismatch') { await this.reconcile(remote); return { status: 'not_owned', pid: identity.pid, reason: 'process_identity_mismatch' }; }
    if (before.verdict !== 'match') return { status: 'unresolved', pid: identity.pid, reason: 'remote_identity_unverifiable' };
    const signalled = await this.inspect(remote, 'stop', force);
    if (signalled.verdict !== 'signalled') return { status: 'unresolved', pid: identity.pid, reason: 'remote_stop_unverifiable' };
    for (let attempt = 0; attempt < 5; attempt++) {
      const verdict = await this.reconcile(remote);
      if (verdict === 'exited' || verdict === 'mismatch') return { status: 'terminated', pid: identity.pid, graceful: !force };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { status: 'unresolved', pid: identity.pid, reason: 'remote_termination_not_confirmed' };
  }
  async launch(binding: FabricBinding, localWorkspace: string, tool: CliTool, options: CliBuildOptions): Promise<TransportResult> {
    if (options.providerAccountId && getProviderAccount(options.providerAccountId)?.auth_strategy !== 'inherited') throw new Error('Provider account strategy is not supported on SSH nodes');
    if (tool === 'opencode') assertRemoteOpenCodeEnabled();
    assertExternalAiCliAllowed(tool);
    if (options.mode !== 'headless' || options.continueSession || !['raw-shell', 'opencode'].includes(tool)) throw new Error('SSH V2 supports headless raw-shell/OpenCode without resume');
    const node = getComputeNode(binding.node_id);
    if (!node.identity || node.identity_changed || node.scheduler_state !== 'online') throw new Error('SSH node identity/health not verified');
    const openCodeArgs = tool === 'opencode' ? await prepareRemoteOpenCodeArgs(node.id, options) : null;
    const commit = await git(['rev-parse', 'HEAD'], localWorkspace);
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Remote execution requires a committed Git repository');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-bundle-'));
    let bundle: string;
    try {
      const bundlePath = path.join(temporary, 'input.bundle');
      await git(['bundle', 'create', bundlePath, 'HEAD'], localWorkspace);
      if (fs.statSync(bundlePath).size > 16 * 1024 * 1024) throw new Error('SSH V2 Git bundle limit is 16 MiB');
      bundle = fs.readFileSync(bundlePath).toString('base64');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    const workspace = remoteWorkspace(binding), adapter = getAdapter(tool);
    const argv = tool === 'raw-shell' ? ['sh', '-c', options.prompt] : [adapter.command, ...openCodeArgs!];
    const managed = tool === 'opencode' ? createOpenCodeConfig(options.promptPolicy) : undefined;
    const config = managed ? JSON.parse(managed.env.OPENCODE_CONFIG_CONTENT) : undefined; managed?.cleanup();
    const pending: ProcessIdentity = { pid: 1, startedAt: `preparing:${binding.id}`, remote: { nodeId: node.id, bindingId: binding.id, workspace, pid: 0, startedAt: '', bootId: '' } };
    const db = getDatabase();
    db.transaction(() => {
      db.prepare("INSERT INTO remote_executions (binding_id, workspace, status, identity_json) VALUES (?, ?, 'preparing', ?)").run(binding.id, workspace, canonicalJson(pending));
      const request = db.prepare('SELECT owner_type, owner_id FROM resource_requests WHERE id = ?').get(binding.request_id) as { owner_type: string; owner_id: string };
      if (request.owner_type !== 'todo') throw new Error('Remote Sessions are unsupported in V2');
      db.prepare('UPDATE todos SET process_pid = ?, process_identity = ? WHERE id = ?').run(pending.pid, canonicalJson(pending), request.owner_id);
    })();
    let state: RemoteState;
    try {
      const result = await this.call(node.id, helper(), { mode: 'launch', workspace, node_identity: node.identity, helper: helper(), bundle, commit, argv, stdin: tool === 'raw-shell' ? '' : adapter.formatStdinPrompt?.(options.prompt) ?? options.prompt, environment: binding.environment, opencode_config: config, opencode_guard: OPEN_CODE_SHELL_GUARD });
      if (result.code !== 0) throw new Error('Remote launch not confirmed');
      state = JSON.parse(result.stdout);
      if (!state.identity?.pid || !state.identity.startedAt || !state.identity.bootId) throw new Error('Remote process identity missing');
    } catch {
      getDatabase().prepare("UPDATE remote_executions SET status = 'recovery_required' WHERE binding_id = ?").run(binding.id);
      throw new RemoteLaunchUnresolved(pending);
    }
    const processIdentity: ProcessIdentity = { pid: state.identity.pid, startedAt: state.identity.startedAt, command: tool, remote: { ...pending.remote!, ...state.identity } };
    getDatabase().prepare('UPDATE remote_executions SET pid = ?, identity_json = ?, status = ? WHERE binding_id = ?').run(processIdentity.pid, canonicalJson(processIdentity), state.status, binding.id);
    const stdout = new PassThrough(), stderr = new PassThrough();
    const decoder = tool === 'opencode' ? adapter.createOutputDecoder?.() : undefined;
    const exitPromise = (async () => {
      let offsets = { stdout_offset: 0, stderr_offset: 0 };
      while (true) {
        const probe = await this.inspect(processIdentity.remote!, 'probe', false, offsets);
        if (probe.stdout) { const data = Buffer.from(probe.stdout, 'base64'); if (decoder) decoder.push(data.toString()); else stdout.write(data); }
        if (probe.stderr) stderr.write(Buffer.from(probe.stderr, 'base64'));
        offsets = { stdout_offset: probe.stdout_offset ?? offsets.stdout_offset, stderr_offset: probe.stderr_offset ?? offsets.stderr_offset };
        if (['exited', 'mismatch'].includes(probe.verdict) && !probe.stdout_more && !probe.stderr_more) {
          const code = probe.state?.exit_code ?? 1;
          getDatabase().prepare("UPDATE remote_executions SET status = 'exited', exit_code = ? WHERE binding_id = ?").run(code, binding.id);
          let finalCode = code;
          if (decoder) { const decoded = decoder.finish(code); stdout.write(decoded.output); if (decoded.diagnostic) stderr.write(decoded.diagnostic); finalCode = decoded.exitCode; }
          stdout.end(); stderr.end(); this.exits.delete(binding.id); return finalCode;
        }
        if (probe.verdict === 'unverifiable') {
          getDatabase().prepare("UPDATE remote_executions SET status = 'recovery_required' WHERE binding_id = ?").run(binding.id);
          logger.debug('resource.recovery.required', { msg: 'Remote observation unresolved; leases retained', nodeId: node.id, bindingId: binding.id });
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    })();
    this.exits.set(binding.id, { pid: processIdentity.pid, promise: exitPromise });
    return { pid: processIdentity.pid, processIdentity, stdout, stderr, stdin: null, exitPromise, command: tool, args: [] };
  }
}
export const localTransport = new LocalTransport();
export const sshTransport = new SshTransport();
