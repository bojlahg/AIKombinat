import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { assertSmokeRemoteRoot, selectSmokeGpu } from '../src/server/services/resource-acceptance.js';

const [alias, remoteRoot, mode = 'parent', suppliedRoot] = process.argv.slice(2);
if (!alias || !remoteRoot) throw new Error('Usage: tsx scripts/resource-fabric-acceptance-smoke.ts <ssh-alias> <new-disposable-remote-root>');
assertSmokeRemoteRoot(remoteRoot);
const root = suppliedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-resource-acceptance-'));
if (suppliedRoot && (!path.isAbsolute(root) || !path.basename(root).startsWith('aikombinat-resource-acceptance-'))) throw new Error('Invalid controller fixture root');
process.env.DB_PATH = path.join(root, 'smoke.db');
process.env.AIKOMBINAT_LOG_DIR = path.join(root, 'logs');
const { getDatabase, closeDatabase } = await import('../src/server/db/connection.js');
const queries = await import('../src/server/db/queries.js');
const { resourceFabric, getComputeNodes, getComputeNode, getResourceInstances, resourceLeaseTotals } = await import('../src/server/services/resource-fabric.js');
const { resourceManager } = await import('../src/server/services/resource-manager.js');
const { orchestrator } = await import('../src/server/services/orchestrator.js');
const { sshTransport, SshTransport } = await import('../src/server/services/execution-transport.js');
const { parseProcessIdentity } = await import('../src/server/utils/process-tree.js');
const { recoverPersistedProcesses, reconcileRetainedProcesses } = await import('../src/server/services/startup-process-recovery.js');
const { discoverRemoteOpenCode } = await import('../src/server/services/remote-opencode.js');
const { runProbe, sshArgs, shellQuote } = await import('../src/server/services/resource-probes.js');
const { claudeManager } = await import('../src/server/services/claude-manager.js');
const db = getDatabase();
const pause = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Acceptance fixture deadline exceeded'); await pause(); }
}
function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const leases = (owner: string) => db.prepare('SELECT * FROM resource_leases WHERE owner_id = ?').all(owner);
const readTodo = (id: string) => queries.getTodoById(id)!;
const stateFile = path.join(root, 'controller.json');
function fixture(command: string, requirements: object, tool: 'raw-shell' | 'opencode' = 'raw-shell', model?: string, files: Record<string, string> = {}) {
  const directory = path.join(root, `fixture-${randomUUID()}`); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'add.cjs'), 'module.exports = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(directory, 'add.test.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./add.cjs')(2,3), 5);\n");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  const git = (args: string[]) => execFileSync('git', args, { cwd: directory, windowsHide: true, stdio: 'ignore' });
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Acceptance smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Disposable fixture']);
  const project = queries.createProject(`Acceptance ${randomUUID()}`, directory);
  queries.updateProject(project.id, { cli_tool: tool, use_worktree: 0, npm_auto_install: 0, sandbox_mode: 'permissive' });
  const todo = queries.createTodo(project.id, 'Owned disposable acceptance fixture', command);
  queries.updateTodo(todo.id, { cli_tool: tool, cli_model: model ?? null, use_worktree: 0, resource_requirements: JSON.stringify(requirements) });
  return todo.id;
}
function initialize() {
  resourceManager.initialize();
  const wake = () => { setImmediate(() => { void orchestrator.wakeWaitingResources(); }); };
  resourceManager.setAvailabilityCallback(wake); resourceFabric.setAvailabilityCallback(wake);
}
async function completed(id: string) { await until(() => ['completed', 'failed', 'stopped'].includes(readTodo(id).status)); ensure(readTodo(id).status === 'completed', `Fixture ${id} ended ${readTodo(id).status}`); ensure(leases(id).length === 0, 'Completed execution retained lease'); }
function cleanup() { resourceManager.shutdown(); resourceFabric.shutdown(); closeDatabase(); }

if (mode === 'restart-a') {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  initialize(); await orchestrator.startTodo(state.todo, 'headless');
  const todo = readTodo(state.todo); ensure((todo.process_pid ?? 0) > 0 && leases(todo.id).length === 2, 'Restart ownership not persisted');
  fs.writeFileSync(path.join(root, 'a-ready.json'), JSON.stringify({ pid: todo.process_pid, identity: parseProcessIdentity(todo.process_identity), leases: leases(todo.id).length }));
  await new Promise(() => undefined);
} else if (mode === 'restart-b') {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const before = readTodo(state.todo), count = db.prepare('SELECT COUNT(*) n FROM remote_executions').get() as { n: number };
  const recovery = await recoverPersistedProcesses(); initialize();
  ensure(readTodo(state.todo).process_pid === before.process_pid && leases(state.todo).length === 2 && recovery.retained === 1, 'Controller restart lost ownership');
  const identity = parseProcessIdentity(before.process_identity)!;
  const interrupted = new SshTransport(async () => { throw new Error('Controlled test observation interruption'); });
  ensure(await interrupted.reconcile(identity.remote!) === 'unverifiable' && leases(state.todo).length === 2, 'Observation loss freed ownership');
  const waiter = fixture('python3 -c "print(123)"', state.requirements);
  await orchestrator.startTodo(waiter, 'headless');
  ensure(readTodo(waiter).status === 'waiting_resource' && readTodo(waiter).process_pid === 0 && leases(waiter).length === 0, 'Restart admitted duplicate execution');
  ensure((db.prepare('SELECT COUNT(*) n FROM remote_executions').get() as { n: number }).n === count.n, 'Duplicate remote start');
  ensure((await sshTransport.inspect(identity.remote!)).verdict === 'match', 'Identity did not recover');
  const end = Date.now() + 90_000;
  while ((readTodo(state.todo).process_pid ?? 0) > 0 && Date.now() < end) { await reconcileRetainedProcesses(); await pause(500); }
  ensure(readTodo(state.todo).process_pid === 0 && leases(state.todo).length === 0, 'Natural exit not reconciled');
  await completed(waiter);
  fs.writeFileSync(path.join(root, 'b-result.json'), JSON.stringify({ retained_pid: before.process_pid, leases_retained: 2, recovery, no_duplicate: true, observation_interruption_retained: true, identity_recovered: true, natural_exit_released: true, waiter_woke: true }));
  cleanup();
} else if (mode === 'parent' || mode === 'final') {
  const report: Record<string, any> = { timestamp: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), os: `${os.platform()} ${os.release()}`, node: process.version, artifacts: root };
  let server: import('node:http').Server | undefined;
  const controllers: ReturnType<typeof spawn>[] = [];
  const owned: string[] = [];
  try {
    const local = getComputeNodes().find(node => node.transport === 'local')!;
    const remote = resourceFabric.createSshNode('Disposable acceptance SSH', { host: alias, auth_mode: 'config', workspace_root: remoteRoot });
    ensure((await resourceFabric.testConnection(remote.id)).status === 'connected', 'SSH unavailable');
    const absent = await runProbe('ssh', sshArgs(remote.connection!, `test ! -e ${shellQuote(remoteRoot)}`));
    ensure(absent.code === 0, 'Remote acceptance root already exists; use a new root');
    await resourceFabric.scan(local.id); await resourceFabric.scan(remote.id);
    const nodes = getComputeNodes(), instances = getResourceInstances();
    report.topology = nodes.map(({ connection: _connection, identity: _identity, ...node }) => ({ ...node, instances: instances.filter(instance => instance.node_id === node.id), leases: [] }));
    report.external = nodes.flatMap(node => node.observation!.gpus.filter(gpu => gpu.compute_pids.length).map(gpu => ({ node_id: node.id, uuid_suffix: gpu.hardware_uuid.slice(-8), compute_pids: gpu.compute_pids, memory_used_bytes: gpu.memory_used_bytes, application_leases: 0, untouched: true })));
    report.remote_opencode = { ...await discoverRemoteOpenCode(remote.id), contract: 'UNSUPPORTED_IN_V2' };
    initialize();
    const app = express(); app.use(express.json()); app.use('/api', (await import('../src/server/routes/resources.js')).default);
    server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
    const base = `http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/api/resources`;
    const selected = selectSmokeGpu(nodes.map(node => ({ node, instances: instances.filter(instance => instance.node_id === node.id), leased: resourceLeaseTotals() })));
    report.gpu = { result: 'BLOCKED_BY_EXTERNAL_GPU_USAGE', reason: 'No scheduler-eligible free GPU; external workloads untouched' };
    if (selected) {
      const { node, instance, requirements } = selected;
      const python = node.transport === 'local' ? 'python' : 'python3';
      const command = `${python} gpu-fixture.py`;
      const gpuFixture = `import os,subprocess,time\nfrom pathlib import Path\nindex=os.environ['CUDA_VISIBLE_DEVICES']\nassert index=='${instance.local_index}'\nuuid=subprocess.check_output(['nvidia-smi','-i',index,'--query-gpu=uuid','--format=csv,noheader'],text=True).strip()\nassert uuid=='${instance.hardware_uuid}'\nprint(index,uuid,flush=True)\ntime.sleep(18)\nPath('gpu-result.txt').write_text(index+' '+uuid)\n`;
      const pair = async (reserve: boolean) => {
        await resourceFabric.scan(node.id);
        ensure(selectSmokeGpu([{ node: getComputeNode(node.id), instances: [getResourceInstances(node.id).find(gpu => gpu.id === instance.id)!], leased: resourceLeaseTotals() }]), 'Selected GPU became busy');
        const a = fixture(command, requirements, 'raw-shell', undefined, { 'gpu-fixture.py': gpuFixture }), b = fixture(command, requirements, 'raw-shell', undefined, { 'gpu-fixture.py': gpuFixture.replace('time.sleep(18)', 'time.sleep(5)') }); owned.push(a, b);
        db.exec(`CREATE TABLE IF NOT EXISTS smoke_gpu_events (seq INTEGER PRIMARY KEY, event TEXT, owner TEXT, policy TEXT, desired TEXT, leases INTEGER, at TEXT);
          DELETE FROM smoke_gpu_events;
          CREATE TRIGGER IF NOT EXISTS smoke_gpu_insert AFTER INSERT ON resource_leases WHEN NEW.resource_key = '${instance.id}'
          BEGIN INSERT INTO smoke_gpu_events SELECT NULL, 'acquire', NEW.owner_id, policy, desired_policy, (SELECT COUNT(*) FROM resource_leases WHERE resource_key = '${instance.id}'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM resource_instances WHERE id = '${instance.id}'; END;
          CREATE TRIGGER IF NOT EXISTS smoke_gpu_delete AFTER DELETE ON resource_leases WHEN OLD.resource_key = '${instance.id}'
          BEGIN INSERT INTO smoke_gpu_events SELECT NULL, 'release', OLD.owner_id, policy, desired_policy, (SELECT COUNT(*) FROM resource_leases WHERE resource_key = '${instance.id}'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM resource_instances WHERE id = '${instance.id}'; END;
          CREATE TRIGGER IF NOT EXISTS smoke_gpu_policy AFTER UPDATE OF policy, desired_policy ON resource_instances WHEN NEW.id = '${instance.id}'
          BEGIN INSERT INTO smoke_gpu_events VALUES (NULL, 'policy', NULL, NEW.policy, NEW.desired_policy, (SELECT COUNT(*) FROM resource_leases WHERE resource_key = '${instance.id}'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;`);
        const timeline: object[] = [];
        const record = (event: string) => timeline.push({ event, at: new Date().toISOString(), a: { status: readTodo(a).status, pid: readTodo(a).process_pid }, b: { status: readTodo(b).status, pid: readTodo(b).process_pid }, gpu: getResourceInstances(node.id).find(gpu => gpu.id === instance.id), leases: leases(b).length });
        const assertAudit = () => {
          ensure(!db.prepare("SELECT 1 FROM smoke_gpu_events WHERE event = 'acquire' AND (leases > 1 OR policy <> 'enabled' OR desired IS NOT NULL)").get(), 'Transient GPU admission race');
        };
        await orchestrator.startTodo(a, 'headless');
        ensure(readTodo(a).status === 'running' && (readTodo(a).process_pid ?? 0) > 0, 'GPU fixture did not run');
        const snapshot = JSON.parse(readTodo(a).execution_snapshot!);
        const aPid = readTodo(a).process_pid;
        ensure(leases(a).length === 1, 'A GPU lease missing'); record('A running');
        ensure(JSON.stringify(snapshot).includes(instance.id), 'Execution snapshot omitted GPU binding');
        const ownership = await (await fetch(base + '/leases')).json() as any;
        ensure(ownership.leases.some((lease: any) => lease.resource_key === instance.id && lease.owner_id === a && lease.process_pid === readTodo(a).process_pid), 'GPU owner API missing');
        await orchestrator.startTodo(b, 'headless');
        ensure(readTodo(b).status === 'waiting_resource' && readTodo(b).process_pid === 0 && leases(b).length === 0, 'GPU contender not waiting without ownership');
        record('B waiting');
        if (reserve) {
          const response = await fetch(base + `/instances/${instance.id}/policy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: 'reserved', after_current: true }) });
          ensure(response.ok, 'Reservation policy action failed');
          const gpu = getResourceInstances(node.id).find(gpu => gpu.id === instance.id)!;
          ensure(gpu.policy === 'enabled' && gpu.desired_policy === 'reserved' && readTodo(a).status === 'running' && leases(a).length === 1, 'Reservation not pending under running A'); record('reserve-after requested');
        }
        const end = Date.now() + 90_000;
        while (readTodo(a).status === 'running' && Date.now() < end) {
          ensure((resourceLeaseTotals()[instance.id] ?? 0) === 1, 'GPU double lease');
          if (reserve) ensure(readTodo(b).status === 'waiting_resource' && leases(b).length === 0, 'Pending reservation admitted waiter');
          assertAudit();
          await pause();
        }
        await completed(a);
        if (reserve) {
          await pause(1500);
          const gpu = getResourceInstances().find(gpu => gpu.id === instance.id)!;
          ensure(gpu.policy === 'reserved' && gpu.desired_policy === null && readTodo(b).status === 'waiting_resource' && readTodo(b).process_pid === 0 && leases(b).length === 0, 'Reservation release ordering failed');
          assertAudit();
          ensure(!db.prepare("SELECT 1 FROM smoke_gpu_events WHERE event = 'acquire' AND owner = ?").get(b), 'B transiently leased before unreserve'); record('A released; GPU reserved; B stays waiting');
          const response = await fetch(base + `/instances/${instance.id}/policy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: 'enabled' }) });
          ensure(response.ok, 'Unreserve policy action failed'); record('unreserve');
        }
        await until(() => (readTodo(b).status === 'running' && (readTodo(b).process_pid ?? 0) > 0) || ['failed', 'completed'].includes(readTodo(b).status));
        ensure(readTodo(b).status === 'running' && (readTodo(b).process_pid ?? 0) > 0 && leases(b).length === 1, 'B did not auto-wake with binding/lease');
        const bPid = readTodo(b).process_pid, bSnapshot = JSON.parse(readTodo(b).execution_snapshot!); record('B auto-wakes');
        await completed(b);
        assertAudit(); record('B completes');
        const history = await (await fetch(base + '/bindings')).json() as any;
        ensure(history.bindings.filter((binding: any) => JSON.parse(binding.binding_json).resource_instances.includes(instance.id)).every((binding: any) => !binding.active), 'Historical GPU binding is active');
        return { a, b, a_pid: aPid, b_pid: bPid, a_binding: snapshot.resourceBinding, b_binding: bSnapshot.resourceBinding, waiting_pid: 0, automatic_wake: true, no_double_lease: true, max_concurrent_gpu_leases: 1, no_transient_admission: true, owner_api: true, snapshot_binding: true, release: true, history_inactive: true, reserve_ordering: reserve, timeline, events: db.prepare('SELECT * FROM smoke_gpu_events ORDER BY seq').all() };
      };
      report.gpu = { result: 'partial', node: node.transport, model: instance.model, uuid_suffix: instance.hardware_uuid!.slice(-8), local_index: instance.local_index, vram_bytes: instance.vram_bytes, fixture: 'scheduler-level nvidia-smi/environment (no framework installed)' };
      if (mode === 'parent') report.gpu.contention = await pair(false);
      try { report.gpu.reserve_after_current = await pair(true); report.gpu.result = 'passed'; }
      catch (error) { if (String(error).includes('Selected GPU became busy')) { report.gpu.reason = 'External workload appeared before reserve drill; untouched'; report.gpu.reserve_after_current = 'blocked'; } else throw error; }
    }
    const requirements = { version: 2, requires: { node_id: remote.id, cpu: { threads: 1 }, memory: { bytes: 64 * 1024 ** 2 } }, prefers: {} };
    await resourceFabric.scan(remote.id);
    resourceFabric.updatePolicy(remote.id, { ...getComputeNode(remote.id).policy, cpu_reserve_threads: getComputeNode(remote.id).inventory!.cpu.logical_threads - 1 });
    const rejected = fixture('Fix add.cjs.', requirements, 'opencode', 'opencode/fixture-free'); owned.push(rejected);
    const remoteBefore = (db.prepare('SELECT COUNT(*) n FROM remote_executions').get() as { n: number }).n;
    const previousOptIn = process.env.AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE;
    delete process.env.AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE;
    try { await orchestrator.startTodo(rejected, 'headless'); }
    finally { if (previousOptIn !== undefined) process.env.AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE = previousOptIn; }
    ensure(readTodo(rejected).status === 'failed' && readTodo(rejected).process_pid === 0 && leases(rejected).length === 0, 'Unsupported OpenCode leaked ownership');
    ensure(queries.getTaskLogsByTodoId(rejected).some(log => log.message.includes('remote_opencode_unsupported_v2')), 'Unsupported reason missing');
    ensure((db.prepare('SELECT COUNT(*) n FROM remote_executions').get() as { n: number }).n === remoteBefore, 'Unsupported OpenCode launched remotely');
    const activity = await (await fetch(base + '/bindings')).json() as any;
    const rejectedBindings = db.prepare('SELECT b.id FROM resource_bindings b JOIN resource_requests r ON r.id = b.request_id WHERE r.owner_id = ?').all(rejected) as { id: string }[];
    ensure(rejectedBindings.length === 1 && rejectedBindings.every(({ id }) => activity.bindings.some((binding: any) => binding.id === id && !binding.active)), 'Unsupported binding remains active');
    const requestActivity = await (await fetch(base + '/requests')).json() as any;
    ensure(requestActivity.requests.some((request: any) => request.owner_id === rejected && !request.active), 'Unsupported request remains active');
    const { executorPool } = await import('../src/server/services/executor-pool.js');
    ensure(executorPool.getActiveToolUsage('opencode') === 0, 'Unsupported OpenCode retained executor slot');
    report.remote_opencode.rejection = { todo: rejected, reason: 'remote_opencode_unsupported_v2', no_process: true, no_lease: true, inactive_history: true, executor_slot_released: true };
    report.remote_opencode.smoke = { result: 'not_applicable', reason: 'UNSUPPORTED_IN_V2; capability probing retained for future work' };
    if (mode === 'parent') {
      const stopping = fixture('python3 -c "import time; time.sleep(45)"', requirements); owned.push(stopping);
      await orchestrator.startTodo(stopping, 'headless');
      const stopIdentity = parseProcessIdentity(readTodo(stopping).process_identity)!;
      ensure((await sshTransport.inspect(stopIdentity.remote!)).verdict === 'match', 'Force Stop pre-signal identity mismatch');
      const mismatch = { ...stopIdentity, startedAt: '0', remote: { ...stopIdentity.remote!, bindingId: randomUUID(), startedAt: '0' } };
      ensure((await sshTransport.stop(mismatch, true)).status === 'not_owned', 'Mismatched identity signalled');
      ensure((await sshTransport.inspect(stopIdentity.remote!)).verdict === 'match' && leases(stopping).length === 2, 'Mismatch modified actual ownership');
      const forced = await (await fetch(base + `/todos/${stopping}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: true }) })).json();
      await sshTransport.whenExited(stopIdentity.pid, stopIdentity.remote!.bindingId);
      ensure(readTodo(stopping).status === 'stopped' && leases(stopping).length === 0, 'Force Stop lifecycle failed');
      ensure((db.prepare('SELECT status FROM remote_executions WHERE binding_id = ?').get(stopIdentity.remote!.bindingId) as any).status === 'exited', 'Force Stop remote status not terminal');
      report.forced_stop = { pid: stopIdentity.pid, identity_match: true, mismatch_not_signalled: true, result: forced, confirmed_exit: true, todo: 'stopped', leases_released: true };
      const capability = report.remote_opencode;
      const model = capability.models.includes('opencode/muse-spark-1.3-contributor-free') ? 'opencode/muse-spark-1.3-contributor-free' : null;
      if (process.env.AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE === '1' && capability.compatible && model) {
        const ai = fixture('Fix add.cjs so addition is correct. Run node --test add.test.cjs. Do not commit. Explain the result briefly.', requirements, 'opencode', model); owned.push(ai);
        await orchestrator.startTodo(ai, 'headless'); await completed(ai);
        const execution = db.prepare('SELECT e.* FROM remote_executions e JOIN resource_bindings b ON b.id=e.binding_id JOIN resource_requests r ON r.id=b.request_id WHERE r.owner_id=?').get(ai) as any;
        const test = await runProbe('ssh', sshArgs(remote.connection!, `cd ${shellQuote(execution.workspace + '/repo')} && node --test add.test.cjs`));
        ensure(test.code === 0, 'Remote OpenCode edit/test failed');
        report.remote_opencode.smoke = { result: 'passed', model, completed: true, fixture_test: true, leases_released: true };
      }
      resourceManager.shutdown(); resourceFabric.shutdown();
      const restarting = fixture('python3 -c "import time; time.sleep(30)"', requirements); owned.push(restarting);
      fs.writeFileSync(stateFile, JSON.stringify({ todo: restarting, requirements }));
      const controller = (phase: string) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('scripts/resource-fabric-acceptance-smoke.ts'), alias, remoteRoot, phase, root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
        controllers.push(child); return child;
      };
      const a = controller('restart-a'); let errors = ''; a.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-1024); });
      await until(() => fs.existsSync(path.join(root, 'a-ready.json')) || a.exitCode !== null);
      ensure(fs.existsSync(path.join(root, 'a-ready.json')), `Controller A failed: ${errors}`);
      a.kill('SIGKILL'); await new Promise(resolve => a.once('exit', resolve));
      report.controller_a = JSON.parse(fs.readFileSync(path.join(root, 'a-ready.json'), 'utf8'));
      const b = controller('restart-b'); b.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-1024); });
      const code = await new Promise(resolve => {
        const timer = setTimeout(() => b.kill('SIGKILL'), 110_000);
        b.once('exit', code => { clearTimeout(timer); resolve(code); });
      }); ensure(code === 0, `Controller B failed: ${errors}`);
      report.restart = JSON.parse(fs.readFileSync(path.join(root, 'b-result.json'), 'utf8'));
    }
    report.conclusion = report.gpu.result === 'passed' ? 'READY_FOR_ORCHESTRATOR' : 'READY_WITH_LIMITATIONS';
  } catch (error) { report.error = String(error); report.conclusion = 'NOT_READY'; process.exitCode = 1; }
  finally {
    for (const child of controllers) { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } }
    resourceManager.setAvailabilityCallback(null); resourceFabric.setAvailabilityCallback(null);
    for (const id of new Set([...owned, ...queries.getTodosWithPersistedProcess().map(todo => todo.id)])) { if ((readTodo(id)?.process_pid ?? 0) > 0) { try { const identity = parseProcessIdentity(readTodo(id).process_identity); if (identity) await claudeManager.stopClaude(identity.pid, identity, true); await orchestrator.stopTodo(id); if ((readTodo(id).process_pid ?? 0) > 0) report.cleanup_requires_recovery = true; } catch { report.cleanup_requires_recovery = true; } } }
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    fs.mkdirSync('logs', { recursive: true }); fs.writeFileSync('logs/resource-fabric-acceptance.json', JSON.stringify(report, null, 2));
    cleanup(); process.stdout.write(JSON.stringify({ conclusion: report.conclusion, error: report.error, report: path.resolve('logs/resource-fabric-acceptance.json') }) + '\n');
  }
} else throw new Error('Unknown controller phase');
