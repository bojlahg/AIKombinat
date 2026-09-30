import Database from 'better-sqlite3';
import express from 'express';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../../db/schema.js';
import type { ComputeNode, NodeInventory, NodeObservation, ResourceInstance } from '../resource-fabric-types.js';
import type { FabricRequirements } from '../resource-requirements.js';
import { canonicalJson, requirementsSchema } from '../resource-requirements.js';
import { matchResources, capabilityMatches } from '../resource-matcher.js';
import * as probes from '../resource-probes.js';
import { assertManagedOpenCodeShell, OPEN_CODE_SHELL_GUARD, openCodePolicy } from '../opencode.js';
import { discoverRemoteOpenCode, remoteOpenCodeArgs, prepareRemoteOpenCodeArgs, type RemoteOpenCodeCapabilities } from '../remote-opencode.js';
import { selectSmokeGpu, assertSmokeRemoteRoot } from '../resource-acceptance.js';

let db: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDatabase: () => db }));
const { ResourceManager } = await import('../resource-manager.js');
const { ResourceFabric, DEFAULT_NODE_POLICY, getComputeNodes, getResourceInstances } = await import('../resource-fabric.js');
const { normalizeResourceRequirements, parseStoredResourceRequirements, serializeResourceRequirements } = await import('../resource-catalog.js');
const { SshTransport } = await import('../execution-transport.js');
const { broadcaster } = await import('../../websocket/broadcaster.js');

const GiB = 1024 ** 3;
function inventory(): NodeInventory {
  return { platform: { os: 'linux', distro: 'ubuntu', version: '24.04', arch: 'x86_64', hostname: 'fixture' }, cpu: { model: 'Fixture CPU', physical_cores: 16, logical_threads: 32, threads_per_core: 2, flags: ['avx', 'avx2'] }, memory: { total_bytes: 64 * GiB, available_bytes: 60 * GiB }, storage: [{ mount: '/', total_bytes: 1000 * GiB, free_bytes: 500 * GiB }], gpus: [{ hardware_uuid: 'GPU-one', local_index: 0, model: 'NVIDIA GeForce RTX 3070', vram_bytes: 8 * GiB }, { hardware_uuid: 'GPU-two', local_index: 1, model: 'NVIDIA GeForce RTX 3070', vram_bytes: 8 * GiB }], capabilities: { docker: '27.0.0', cuda: '12.4', python: '3.10.11' } };
}
function candidate(id = randomUUID(), changes: Partial<ComputeNode> = {}) {
  const detected = inventory();
  const observation: NodeObservation = { timestamp: new Date().toISOString(), memory_available_bytes: 60 * GiB, storage: detected.storage, gpus: detected.gpus.map(gpu => ({ hardware_uuid: gpu.hardware_uuid, utilization: 2, memory_used_bytes: 128 * 1024 ** 2, compute_pids: [], temperature: 40, power: 20 })) };
  const node: ComputeNode = { id, name: 'Fixture', transport: 'local', enabled: true, scheduler_state: 'online', identity: 'fixture', identity_changed: false, last_scan_at: null, last_health_at: null, last_error: null, connection: null, policy: { ...DEFAULT_NODE_POLICY, cpu_reserve_threads: 8, memory_reserve_bytes: 16 * GiB }, inventory: detected, observation, ...changes };
  const instances: ResourceInstance[] = detected.gpus.map(gpu => ({ id: randomUUID(), node_id: id, kind: 'gpu', legacy_key: null, hardware_uuid: gpu.hardware_uuid, local_index: gpu.local_index, model: gpu.model, vram_bytes: gpu.vram_bytes, origin: 'detected', present: 1, policy: 'enabled', desired_policy: null, reserve_reason: null }));
  return { node, instances, leased: {} as Record<string, number> };
}
function requires(value: FabricRequirements['requires']): FabricRequirements { return { version: 2, requires: value, prefers: {} }; }

beforeEach(() => { db = new Database(':memory:'); initDatabase(db); vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); db.close(); });

describe('Resource Fabric matcher', () => {
  it('selects only a free scheduler-eligible GPU even when external avoidance is disabled', () => {
    const a = candidate(); a.node.policy.avoid_external_gpu = false;
    a.node.observation!.gpus[0].compute_pids = [123];
    expect(selectSmokeGpu([a])?.instance.id).toBe(a.instances[1].id);
    a.instances[1].desired_policy = 'reserved'; expect(selectSmokeGpu([a])).toBeNull();
    a.instances[1].desired_policy = null; a.leased[a.instances[1].id] = 1; expect(selectSmokeGpu([a])).toBeNull();
    a.leased = {}; a.node.observation!.timestamp = '2000-01-01'; expect(selectSmokeGpu([a])).toBeNull();
  });
  it.each(['/', '/home/user', '/tmp', '/home/user/repo', '/home/user/resource-acceptance-x/../repo'])('refuses unsafe smoke root %s', root => expect(() => assertSmokeRemoteRoot(root)).toThrow());
  it.each([
    ['OS', { platform: { os: 'windows' } }, 'os_mismatch'],
    ['distro', { platform: { distro: 'debian' } }, 'distro_mismatch'],
    ['architecture', { platform: { arch: 'aarch64' } }, 'arch_mismatch'],
    ['boolean capability', { capabilities: { docker: false } }, 'capability_unsatisfied:docker'],
    ['version capability', { capabilities: { cuda: '>=12.5' } }, 'capability_unsatisfied:cuda'],
    ['GPU count', { resources: [{ kind: 'gpu', count: 3 }] }, 'resource_count_insufficient:gpu'],
    ['GPU model', { resources: [{ kind: 'gpu', count: 1, model: 'RTX 5060 Ti' }] }, 'resource_count_insufficient:gpu'],
    ['GPU VRAM', { resources: [{ kind: 'gpu', count: 2, min_vram_bytes: 16 * GiB }] }, 'resource_count_insufficient:gpu'],
    ['CPU', { cpu: { threads: 25 } }, 'cpu_threads_insufficient'],
    ['physical cores', { cpu: { min_physical_cores: 13 } }, 'physical_cores_insufficient'],
    ['RAM', { memory: { bytes: 49 * GiB } }, 'memory_capacity_insufficient'],
    ['storage', { storage: { min_free_bytes: 600 * GiB } }, 'storage_headroom_insufficient'],
  ])('rejects unsatisfied %s', (_label, constraint, reason) => {
    const result = matchResources(requires(constraint as FabricRequirements['requires']), [candidate()]);
    expect(result.binding).toBeNull(); expect(result.rejected[0].reasons).toContain(reason);
  });
  it.each([['12.4', '>=12.4', true], ['12.4.1', '>=12.4', true], ['12.3', '>=12.4', false], ['12.4', '<=12.4.0', true], ['12.4', '==12.4.0', true], ['27.0.0', '27.0.0', true], [true, true, true], [undefined, false, true], [false, true, false]])('compares capabilities %s / %s', (actual, expected, matches) => expect(capabilityMatches(actual as string | boolean | undefined, expected as string | boolean)).toBe(matches));
  it('selects two distinct GPUs on the same Ubuntu node and binds node-local indices', () => {
    const linux = candidate(), windows = candidate(randomUUID(), { inventory: { ...inventory(), platform: { os: 'windows', arch: 'x86_64', hostname: 'desktop' } } });
    const result = matchResources(requires({ platform: { os: 'linux', distro: 'ubuntu' }, cpu: { threads: 8, min_physical_cores: 4 }, memory: { bytes: 16 * GiB }, resources: [{ kind: 'gpu', count: 2, min_vram_bytes: 8 * GiB, same_node: true }] }), [windows, linux]);
    expect(result.binding).toMatchObject({ node_id: linux.node.id, environment: { CUDA_VISIBLE_DEVICES: '0,1' }, capacity: { cpu_threads: 8, memory_bytes: 16 * GiB } });
    expect(new Set(result.binding!.resource_instances).size).toBe(2);
  });
  it('binds the preferred available GPU and falls back when it is externally occupied', () => {
    const a = candidate(); a.instances[1].model = 'RTX 5060 Ti';
    const request: FabricRequirements = { ...requires({ resources: [{ kind: 'gpu', count: 1 }] }), prefers: { resources: [{ kind: 'gpu', count: 1, model: 'RTX 5060 Ti' }] } };
    expect(matchResources(request, [a]).binding?.resource_instances).toEqual([a.instances[1].id]);
    a.node.observation!.gpus[1].compute_pids = [123];
    expect(matchResources(request, [a]).binding?.resource_instances).toEqual([a.instances[0].id]);
  });
  it('never combines GPUs from different nodes', () => {
    const a = candidate(), b = candidate(); a.instances.pop(); b.instances.pop();
    expect(matchResources(requires({ resources: [{ kind: 'gpu', count: 2, same_node: true }] }), [a, b]).binding).toBeNull();
  });
  it('does not allocate the same GPU to multiple requirement clauses', () => {
    const a = candidate(); a.instances.pop();
    expect(matchResources(requires({ resources: [{ kind: 'gpu', count: 1 }, { kind: 'gpu', count: 1 }] }), [a]).binding).toBeNull();
  });
  it('ranks preferences deterministically without turning preferences into hard constraints', () => {
    const a = candidate('00000000-0000-4000-8000-000000000001'), b = candidate('00000000-0000-4000-8000-000000000002');
    const request = { ...requires({ cpu: { threads: 8 } }), prefers: { node_id: b.node.id } };
    expect(matchResources(request, [a, b]).binding?.node_id).toBe(b.node.id);
    expect(matchResources({ ...request, prefers: { node_id: randomUUID() } }, [b, a]).binding?.node_id).toBe(a.node.id);
  });
  it.each(['offline', 'draining', 'maintenance', 'disabled'] as const)('rejects %s nodes', state => expect(matchResources(requires({ cpu: { threads: 1 } }), [candidate(randomUUID(), { scheduler_state: state })]).binding).toBeNull());
  it('rejects stale telemetry, identity changes, reserves and external compute while ignoring desktop utilization', () => {
    const a = candidate(), request = requires({ resources: [{ kind: 'gpu', count: 2 }] });
    expect(matchResources(request, [a]).binding).not.toBeNull();
    a.node.observation!.gpus[0].compute_pids = [111]; expect(matchResources(request, [a]).binding).toBeNull();
    a.node.observation!.gpus[0].compute_pids = []; a.instances[0].desired_policy = 'reserved'; expect(matchResources(request, [a]).binding).toBeNull();
    a.instances[0].desired_policy = null; a.node.observation!.timestamp = '2000-01-01'; expect(matchResources(request, [a]).binding).toBeNull();
    a.node.observation!.timestamp = new Date().toISOString(); a.node.identity_changed = true; expect(matchResources(request, [a]).binding).toBeNull();
  });
  it('requires real RAM headroom and the workspace volume storage headroom', () => {
    const a = candidate(); a.node.observation!.memory_available_bytes = 2 * GiB;
    expect(matchResources(requires({ memory: { bytes: 2 * GiB } }), [a]).binding).toBeNull();
    a.node.observation!.storage.push({ mount: '/jobs', free_bytes: 1 * GiB, total_bytes: 100 * GiB });
    a.node.connection = { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs/fixture' };
    expect(matchResources(requires({ storage: { min_free_bytes: 2 * GiB } }), [a]).binding).toBeNull();
  });
});

describe('Atomic bindings and persisted capacity', () => {
  function install() {
    const local = getComputeNodes()[0], a = candidate(local.id);
    db.prepare('INSERT INTO inventory_snapshots VALUES (?, ?, ?, ?, ?)').run(randomUUID(), local.id, canonicalJson(a.node.inventory), '[]', new Date().toISOString());
    db.prepare('INSERT INTO resource_observations VALUES (?, ?, ?)').run(local.id, canonicalJson(a.node.observation), a.node.observation!.timestamp);
    db.prepare('INSERT INTO resource_policies VALUES (?, ?)').run(local.id, canonicalJson(a.node.policy));
    for (const gpu of a.instances) db.prepare('INSERT INTO resource_instances (id, node_id, kind, hardware_uuid, local_index, model, vram_bytes, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(gpu.id, local.id, gpu.kind, gpu.hardware_uuid, gpu.local_index, gpu.model, gpu.vram_bytes, gpu.origin);
    const projectId = randomUUID(); db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(projectId, 'Fixture', '/fixture');
    const owner = () => { const id = randomUUID(); db.prepare('INSERT INTO todos (id, project_id, title) VALUES (?, ?, ?)').run(id, projectId, 'Fixture'); return id; };
    return { local, a, owner };
  }
  it('atomically leases GPU + CPU + RAM and retains an explainable waiting request without partial leases', () => {
    const { owner } = install(), manager = new ResourceManager(), first = owner(), second = owner();
    const resources = requires({ cpu: { threads: 8 }, memory: { bytes: 24 * GiB }, resources: [{ kind: 'gpu', count: 2 }] });
    const acquired = manager.acquireAtomic({ ownerType: 'todo', ownerId: first, runToken: 'one', resources });
    expect(acquired.status).toBe('acquired');
    expect(db.prepare('SELECT COUNT(*) count FROM resource_leases').get()).toEqual({ count: 4 });
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second, runToken: 'two', resources }).status).toBe('busy');
    expect(db.prepare('SELECT COUNT(*) count FROM resource_leases WHERE run_token = ?').get('two')).toEqual({ count: 0 });
    expect(db.prepare('SELECT status FROM resource_requests WHERE run_token = ?').get('two')).toEqual({ status: 'waiting' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const wake = vi.fn(); manager.setAvailabilityCallback(wake); manager.releaseRun('one'); expect(wake).toHaveBeenCalledOnce();
    expect(manager.acquireAtomic({ ownerType: 'todo', ownerId: second, runToken: 'two', resources }).status).toBe('acquired');
  });
  it('resolves detected SSH instance IDs from checkbox arrays without imposing the legacy local node', () => {
    const { a, owner } = install();
    const node = new ResourceFabric().createSshNode('Remote', { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs' });
    db.prepare("UPDATE compute_nodes SET scheduler_state = 'online' WHERE id = ?").run(node.id);
    db.prepare('INSERT INTO inventory_snapshots VALUES (?, ?, ?, ?, ?)').run(randomUUID(), node.id, canonicalJson(a.node.inventory), '[]', new Date().toISOString());
    db.prepare('INSERT INTO resource_observations VALUES (?, ?, ?)').run(node.id, canonicalJson(a.node.observation), new Date().toISOString());
    db.prepare('UPDATE resource_instances SET node_id = ? WHERE id = ?').run(node.id, a.instances[0].id);
    const result = new ResourceManager().acquireAtomic({ ownerType: 'todo', ownerId: owner(), runToken: 'remote-checkbox', resources: [a.instances[0].id] });
    expect(result).toMatchObject({ status: 'acquired', binding: { node_id: node.id, transport: 'ssh', resource_instances: [a.instances[0].id] } });
  });
  it('rolls back request, binding, items and leases on insert failure', () => {
    const { owner } = install();
    db.exec("CREATE TRIGGER reject_memory BEFORE INSERT ON resource_leases WHEN NEW.resource_key LIKE '%/memory' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(() => new ResourceManager().acquireAtomic({ ownerType: 'todo', ownerId: owner(), runToken: 'rollback', resources: requires({ cpu: { threads: 8 }, memory: { bytes: GiB } }) })).toThrow('fixture failure');
    for (const table of ['resource_leases', 'resource_bindings', 'resource_binding_items', 'resource_requests']) expect(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({ count: 0 });
  });
  it('accounts quantitative contention and prevents duplicate acquisition on the same attempt', () => {
    const { owner } = install(), manager = new ResourceManager(), first = owner(), second = owner();
    const request = { ownerType: 'todo' as const, ownerId: first, runToken: 'one', resources: requires({ cpu: { threads: 16 }, memory: { bytes: 24 * GiB } }) };
    manager.acquireAtomic(request); manager.acquireAtomic(request);
    expect(db.prepare('SELECT COUNT(*) count FROM resource_leases').get()).toEqual({ count: 2 });
    expect(manager.acquireAtomic({ ...request, ownerId: second, runToken: 'two' }).status).toBe('busy');
    manager.releaseRun('one');
    expect(() => manager.acquireAtomic(request)).toThrow('new run token');
    expect(manager.acquireAtomic({ ...request, ownerId: second, runToken: 'two' }).status).toBe('acquired');
  });
  it('blocks pending/reserved admission before release wake and admits automatically on unreserve', () => {
    const { a, owner } = install(), manager = new ResourceManager(), fabric = new ResourceFabric();
    const resources = requires({ resources: [{ kind: 'gpu', count: 2 }] });
    manager.acquireAtomic({ ownerType: 'todo', ownerId: owner(), runToken: 'one', resources });
    fabric.setInstancePolicy(a.instances[0].id, 'reserved', true, 'desktop');
    expect(getResourceInstances().find(instance => instance.id === a.instances[0].id)?.desired_policy).toBe('reserved');
    const second = owner(); let result = '';
    const admit = () => { result = manager.acquireAtomic({ ownerType: 'todo', ownerId: second, runToken: 'two', resources }).status; };
    admit(); expect(result).toBe('busy');
    const inserted = vi.fn(); db.function('observe_waiter_lease', inserted);
    db.exec(`CREATE TRIGGER observe_waiter AFTER INSERT ON resource_leases WHEN NEW.owner_id = '${second}' BEGIN SELECT observe_waiter_lease(); END`);
    manager.setAvailabilityCallback(admit);
    manager.releaseRun('one'); expect(result).toBe('busy');
    expect(getResourceInstances().find(instance => instance.id === a.instances[0].id)).toMatchObject({ policy: 'reserved', desired_policy: null });
    expect(inserted).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) count FROM resource_leases WHERE owner_id = ?').get(second)).toEqual({ count: 0 });
    fabric.setAvailabilityCallback(admit); fabric.setInstancePolicy(a.instances[0].id, 'enabled');
    expect(result).toBe('acquired'); expect(inserted).toHaveBeenCalledTimes(2);
  });
  it('returns immutable bound history as inactive after confirmed release and retains unresolved remote activity', async () => {
    const { owner } = install(), manager = new ResourceManager();
    const result = manager.acquireAtomic({ ownerType: 'todo', ownerId: owner(), runToken: 'history', resources: requires({ cpu: { threads: 1 } }) });
    if (result.status !== 'acquired') throw new Error('fixture admission');
    const app = express(); app.use((await import('../../routes/resources.js')).default);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/resources`;
    const activity = async () => {
      const requests = await (await fetch(base + '/requests')).json();
      const bindings = await (await fetch(base + '/bindings')).json();
      return { request: requests.requests[0], binding: bindings.bindings[0] };
    };
    try {
      expect(await activity()).toMatchObject({ request: { status: 'bound', active: 1 }, binding: { active: 1 } });
      manager.releaseRun('history');
      expect(await activity()).toMatchObject({ request: { status: 'bound', active: 0 }, binding: { active: 0 } });
      db.prepare("INSERT INTO remote_executions (binding_id, workspace, status) VALUES (?, '/fixture', 'recovery_required')").run(result.binding!.id);
      expect(await activity()).toMatchObject({ request: { active: 1 }, binding: { active: 1 } });
      db.prepare("UPDATE remote_executions SET status = 'exited'").run();
      expect(await activity()).toMatchObject({ request: { active: 0 }, binding: { active: 0 } });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('adopts a persisted preparing supervisor identity without freeing leases or starting a duplicate', async () => {
    const { local, owner } = install(), manager = new ResourceManager(), todo = owner();
    const result = manager.acquireAtomic({ ownerType: 'todo', ownerId: todo, runToken: 'adoption', resources: requires({ cpu: { threads: 1 } }) });
    if (result.status !== 'acquired') throw new Error('fixture admission');
    db.prepare('UPDATE compute_nodes SET identity = ? WHERE id = ?').run('fixture', local.id);
    const pending = { pid: 1, startedAt: 'preparing', remote: { nodeId: local.id, bindingId: result.binding!.id, workspace: '/fixture', pid: 0, startedAt: '', bootId: '' } };
    db.prepare('UPDATE todos SET process_pid = 1, process_identity = ? WHERE id = ?').run(canonicalJson(pending), todo);
    db.prepare("INSERT INTO remote_executions (binding_id, workspace, status, identity_json) VALUES (?, '/fixture', 'preparing', ?)").run(result.binding!.id, canonicalJson(pending));
    const call = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ verdict: 'match', state: { identity: { pid: 123, startedAt: '100', bootId: 'boot' }, status: 'running' } }) });
    expect(await new SshTransport(call).reconcile(pending.remote)).toBe('unverifiable');
    expect(db.prepare('SELECT process_pid FROM todos WHERE id = ?').get(todo)).toEqual({ process_pid: 123 });
    expect(db.prepare('SELECT status, pid FROM remote_executions').get()).toEqual({ status: 'recovery_required', pid: 123 });
    expect(db.prepare('SELECT COUNT(*) n FROM resource_leases').get()).toEqual({ n: 1 });
    expect(call).toHaveBeenCalledOnce();
  });
  it('retains expired remote leases when SSH ownership is unresolved, even without a live local PID', () => {
    const { local, owner } = install(), manager = new ResourceManager(() => false), first = owner();
    const result = manager.acquireAtomic({ ownerType: 'todo', ownerId: first, runToken: 'remote', resources: requires({ cpu: { threads: 8 } }) });
    if (result.status !== 'acquired') throw new Error('fixture admission');
    db.prepare("INSERT INTO remote_executions (binding_id, workspace, status) VALUES (?, '/fixture', 'recovery_required')").run(result.binding!.id);
    db.prepare("UPDATE compute_nodes SET scheduler_state = 'offline' WHERE id = ?").run(local.id);
    db.prepare("UPDATE resource_leases SET expires_at = '2000-01-01'").run();
    expect(new ResourceManager(() => false).recoverStaleLeases(true)).toEqual({ released: 0, recovered: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM resource_leases').get()).toEqual({ count: 1 });
  });
  it('migrates legacy data idempotently without losing old leases, waiting Todos or FK integrity', () => {
    const { owner } = install(), id = owner();
    db.prepare("UPDATE todos SET status = 'waiting_resource', resource_requirements = '[\"gpu.0\",\"cpu.heavy\"]' WHERE id = ?").run(id);
    db.prepare("INSERT INTO resource_leases (id, resource_key, amount, owner_type, owner_id, run_token, acquired_at, heartbeat_at, expires_at) VALUES (?, 'gpu.0', 1, 'todo', ?, 'legacy', '2000-01-01', '2000-01-01', '2099-01-01')").run(randomUUID(), id);
    const localId = getComputeNodes()[0].id;
    initDatabase(db); initDatabase(db);
    expect(getComputeNodes()[0].id).toBe(localId);
    expect(parseStoredResourceRequirements((db.prepare('SELECT resource_requirements FROM todos WHERE id = ?').get(id) as { resource_requirements: string }).resource_requirements)).toEqual(['gpu.0', 'cpu.heavy']);
    expect(db.prepare('SELECT status FROM todos WHERE id = ?').get(id)).toEqual({ status: 'waiting_resource' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('Scanner and secret boundaries', () => {
  const fixtureRunner = async (command: string, args: string[]): Promise<probes.ProbeResult> => {
    const request = command === 'ssh' ? args.at(-1)! : `${command} ${args.join(' ')}`;
    const output = request.includes('powershell.exe') ? JSON.stringify({ hostname: 'fixture', version: '11', model: 'Fixture CPU', physical: 16, logical: 32, total: 64 * GiB, free: 60 * GiB, identity: 'machine', storage: [] })
      : request.includes("'uname' '-s'") ? 'Linux\n' : request.includes("'uname' '-mn'") ? 'fixture x86_64\n'
      : request.includes('/etc/os-release') ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : request.includes('lscpu') ? JSON.stringify({ lscpu: [{ field: 'CPU(s):', data: '32' }, { field: 'Core(s) per socket:', data: '16' }, { field: 'Socket(s):', data: '1' }, { field: 'Model name:', data: 'Fixture CPU' }] })
      : request.includes('/proc/meminfo') ? 'MemTotal: 67108864 kB\nMemAvailable: 62914560 kB\n' : request.includes('/etc/machine-id') ? 'fixture-machine\n'
      : request.includes("'df'") ? 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 1048576000 0 524288000 0% /\n'
      : request.includes('--query-compute-apps') ? 'GPU-one, 101\n'
      : request.includes('--query-gpu') ? '0, GPU-one, NVIDIA GeForce RTX 3070, 8192, 570.0, 2, 128, 40, 20\n1, GPU-two, RTX 3070, 8192, 570.0, 0, 0, 40, 20\n'
      : request.includes('nvidia-smi') ? 'CUDA Version: 12.4\n'
      : request.includes('docker') || request.includes('python') ? '' : '1.0.0\n';
    return { stdout: output, stderr: '', code: output ? 0 : 127, timed_out: false };
  };
  it('scans a real typed Ubuntu fixture with two GPUs despite missing optional tools', async () => {
    const node = candidate(randomUUID(), { transport: 'ssh', connection: { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs' } }).node;
    const result = await probes.scanNode(node, fixtureRunner);
    expect(result.inventory.platform).toMatchObject({ os: 'linux', distro: 'ubuntu' });
    expect(result.inventory.gpus).toHaveLength(2); expect(result.inventory.cpu).toMatchObject({ logical_threads: 32, physical_cores: 16 });
    expect(result.inventory.capabilities.docker).toBeUndefined(); expect(result.observation.gpus[0].compute_pids).toEqual([101]);
  });
  it('scans local Windows fixtures and tolerates absent NVIDIA', async () => {
    if (process.platform !== 'win32') return;
    const result = await probes.scanNode(candidate().node, async (command, args) => command === 'nvidia-smi' ? { stdout: '', stderr: 'missing', code: 127, timed_out: false } : fixtureRunner(command, args));
    expect(result.inventory.cpu.physical_cores).toBe(16); expect(result.inventory.gpus).toEqual([]);
  });
  it('ignores malformed GPU rows and unavailable metrics', () => {
    const result = probes.parseNvidia('bad row\n0, GPU-valid, RTX 3070, 8192, 570, N/A, N/A, N/A, N/A\n1, GPU-bad, RTX, invalid, 570, 1, 2, 3, 4', 'GPU-valid, 123\nGPU-valid, bad');
    expect(result.gpus).toHaveLength(1); expect(result.telemetry[0]).toMatchObject({ utilization: null, memory_used_bytes: null, compute_pids: [123] });
  });
  it('uses strict host keys and rejects shell-injected connection values and secrets', () => {
    expect(probes.sshArgs({ host: 'fixture', auth_mode: 'config', workspace_root: '/jobs' }, 'uname -s')).toContain('StrictHostKeyChecking=yes');
    for (const input of [{ host: '-oProxyCommand=bad', auth_mode: 'config', workspace_root: '/jobs' }, { host: 'fixture;bad', auth_mode: 'config', workspace_root: '/jobs' }, { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs', passphrase: 'secret' }]) expect(probes.connectionSchema.safeParse(input).success).toBe(false);
    const diagnostic = probes.boundedDiagnostic('x'.repeat(2000) + ' password=abc token=def');
    expect(diagnostic.length).toBeLessThanOrEqual(512); expect(diagnostic).not.toContain('abc'); expect(diagnostic).not.toContain('def');
  });
  it('reports unknown SSH host keys as manual action and never persists secret fields', async () => {
    const fabric = new ResourceFabric(async () => ({ code: 255, stdout: '', stderr: 'Host key verification failed.', timed_out: false }));
    const node = fabric.createSshNode('Fixture', { host: 'fixture', auth_mode: 'key', key_path: '/keys/id_ed25519', workspace_root: '/jobs' });
    expect(await fabric.testConnection(node.id)).toMatchObject({ status: 'manual_action_required' });
    expect(() => fabric.createSshNode('Invalid', { ...node.connection!, private_key: 'KEY', passphrase: 'SECRET' } as never)).toThrow();
    expect(JSON.stringify(getComputeNodes())).not.toContain('SECRET');
  });
  it('coalesces concurrent scans, retains manual policy and bounds history', async () => {
    const fabric = new ResourceFabric(); const local = getComputeNodes()[0];
    fabric.updatePolicy(local.id, { ...DEFAULT_NODE_POLICY, cpu_reserve_threads: 8, capability_overrides: { docker: true } });
    const result = { inventory: inventory(), observation: candidate().node.observation!, identity: 'same' };
    const probe = vi.spyOn(probes, 'scanNode').mockResolvedValue(result);
    await Promise.all([fabric.scan(local.id), fabric.scan(local.id)]); expect(probe).toHaveBeenCalledOnce();
    for (let i = 0; i < 8; i++) await fabric.scan(local.id);
    expect(getComputeNodes()[0].policy.capability_overrides).toEqual({ docker: true });
    expect(db.prepare('SELECT COUNT(*) count FROM inventory_snapshots').get()).toEqual({ count: 5 });
    expect(db.prepare('SELECT COUNT(*) count FROM resource_observations').get()).toEqual({ count: 1 });
  });
  it('retains leases and blocks admission on scan timeout or changed host identity', async () => {
    const fabric = new ResourceFabric(), local = getComputeNodes()[0];
    vi.spyOn(probes, 'scanNode').mockRejectedValueOnce(new Error('SSH timeout')).mockResolvedValueOnce({ inventory: inventory(), observation: candidate().node.observation!, identity: 'other' });
    await expect(fabric.scan(local.id)).rejects.toThrow('SSH timeout'); expect(getComputeNodes()[0].scheduler_state).toBe('offline');
    db.prepare('UPDATE compute_nodes SET identity = ? WHERE id = ?').run('original', local.id);
    await expect(fabric.scan(local.id)).rejects.toThrow('identity_changed'); expect(getComputeNodes()[0].identity_changed).toBe(true);
  });
});

describe('Requirements and OpenCode shell hardening', () => {
  it('rejects unsupported comparators, invalid sizes and arbitrary prompt fields', () => {
    for (const input of [{ version: 2, requires: { memory: { bytes: -1 } } }, { version: 2, requires: { capabilities: { cuda: '^12.4' } } }, { version: 2, requires: { prompt: 'secret' } }, { version: 2, requires: { resources: [{ kind: 'gpu', count: 0 }] } }]) expect(requirementsSchema.safeParse(input).success).toBe(false);
  });
  it('canonicalizes V2 deterministically while retaining the V1 parser', () => {
    const first = serializeResourceRequirements(normalizeResourceRequirements({ version: 2, requires: { memory: { bytes: GiB }, platform: { os: 'linux' } } }));
    const second = serializeResourceRequirements(normalizeResourceRequirements({ requires: { platform: { os: 'linux' }, memory: { bytes: GiB } }, version: 2 }));
    expect(first).toBe(second); expect(parseStoredResourceRequirements('["gpu.0"]')).toEqual(['gpu.0']);
  });
  it.each(['npm test > ../outside.txt', 'npm test && echo second', 'npm test | cat', 'git diff > ../outside.txt', 'npm test >> ../outside.txt', 'npm test || echo second', 'npm test; echo second', 'npm test $(echo second)', 'npm test\necho second'])('rejects %s at the raw provider edge', async command => {
    expect(() => assertManagedOpenCodeShell(command)).toThrow('shell');
    const plugin = new Function(OPEN_CODE_SHELL_GUARD.replace('export const AIKombinatShellGuard =', 'return'))() as () => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>>;
    const hooks = await plugin(); await expect(hooks['tool.execute.before']({ tool: 'bash' }, { args: { command } })).rejects.toThrow('shell');
  });
  it.each(['npm test', 'npm run build', 'npm run typecheck', 'npx vitest run src/fixture.test.ts', 'git diff --no-ext-diff --no-textconv'])('permits routine %s', command => expect(() => assertManagedOpenCodeShell(command)).not.toThrow());
  it('removes broad test/build allowances', () => {
    const policy = openCodePolicy(false);
    for (const pattern of ['npm test *', 'npm run build*', 'git diff *']) expect(policy.bash[pattern]).toBeUndefined();
  });
});

describe('Remote process identity and Stop', () => {
  async function setup(verdict: string) {
    const fabric = new ResourceFabric(), node = fabric.createSshNode('Fixture', { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs' });
    db.prepare('UPDATE compute_nodes SET identity = ? WHERE id = ?').run('fixture', node.id);
    const call = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify({ verdict }), stderr: '', timed_out: false });
    const transport = new SshTransport(call);
    const identity = { pid: 123, startedAt: '100', remote: { nodeId: node.id, bindingId: randomUUID(), workspace: '/jobs/fixture', pid: 123, startedAt: '100', bootId: 'boot' } };
    return { call, transport, identity };
  }
  it.each(['mismatch', 'unverifiable'])('does not signal %s processes', async verdict => {
    const { call, transport, identity } = await setup(verdict);
    const result = await transport.stop(identity);
    expect(result.status).toBe(verdict === 'mismatch' ? 'not_owned' : 'unresolved');
    expect(call.mock.calls.every(args => args[2].mode === 'probe')).toBe(true);
  });
  it('verifies creation identity before signalling and confirms exit before releasing ownership', async () => {
    const { call, transport, identity } = await setup('match');
    call.mockResolvedValueOnce({ code: 0, stdout: '{"verdict":"match"}', stderr: '', timed_out: false }).mockResolvedValueOnce({ code: 0, stdout: '{"verdict":"signalled"}', stderr: '', timed_out: false }).mockResolvedValueOnce({ code: 0, stdout: '{"verdict":"exited"}', stderr: '', timed_out: false });
    expect(await transport.stop(identity)).toMatchObject({ status: 'terminated', graceful: true });
    expect(call.mock.calls[1][2]).toMatchObject({ mode: 'stop', identity: { pid: 123, startedAt: '100', bootId: 'boot' } });
  });
  it('retains ownership on connection loss', async () => {
    const { call, transport, identity } = await setup('match'); call.mockRejectedValue(new Error('connection lost'));
    expect(await transport.reconcile(identity.remote)).toBe('unverifiable'); expect(await transport.stop(identity)).toMatchObject({ status: 'unresolved' });
  });
  it('passes force only after identity verification and confirms exit', async () => {
    const { call, transport, identity } = await setup('match');
    call.mockResolvedValueOnce({ code: 0, stdout: '{"verdict":"match"}' }).mockResolvedValueOnce({ code: 0, stdout: '{"verdict":"signalled"}' }).mockResolvedValueOnce({ code: 0, stdout: '{"verdict":"exited"}' });
    expect(await transport.stop(identity, true)).toMatchObject({ status: 'terminated', graceful: false });
    expect(call.mock.calls[1][2]).toMatchObject({ mode: 'stop', force: true });
  });
});

describe('Remote OpenCode capability and exact-model contract', () => {
  const capabilities = (standalone = false): RemoteOpenCodeCapabilities => ({ observed_at: new Date().toISOString(), context: 'fixture', installed: true, compatible: true, version: '1.18.33', flags: ['--format', '--model', '--agent', ...(standalone ? ['--standalone'] : [])], models: ['opencode/fixture-free'], models_verified: true });
  const options = { mode: 'headless' as const, prompt: 'fixture', model: 'opencode/fixture-free' };
  it.each([undefined, '0', 'true'])('rejects without explicit opt-in (%s) before probes or transport preparation', async value => {
    vi.stubEnv('AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE', value);
    const runner = vi.fn(), call = vi.fn();
    await expect(prepareRemoteOpenCodeArgs('absent-node', options, runner)).rejects.toThrow('remote_opencode_unsupported_v2');
    await expect(new SshTransport(call).launch({} as never, '/nonexistent-fixture', 'opencode', options)).rejects.toThrow('remote_opencode_unsupported_v2');
    expect(runner).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) count FROM remote_executions').get()).toEqual({ count: 0 });
  });
  it('opt-in still probes capabilities and requires the exact model', async () => {
    vi.stubEnv('AIKOMBINAT_EXPERIMENTAL_REMOTE_OPENCODE', '1');
    const node = new ResourceFabric().createSshNode('Opt-in fixture', { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs' });
    db.prepare('UPDATE compute_nodes SET identity = ? WHERE id = ?').run('host', node.id);
    db.prepare('INSERT INTO resource_observations VALUES (?, ?, ?)').run(node.id, canonicalJson(candidate().node.observation), new Date().toISOString());
    const runner = vi.fn(async (_command: string, args: string[]) => ({ code: 0, timed_out: false, stderr: '', stdout: args.at(-1)!.includes('--version') ? '1.18.33\n' : args.at(-1)!.includes("'run'") ? '--format --model --agent' : args.at(-1)!.includes('--help') ? 'models help' : 'opencode/fixture-free\n' }));
    await expect(prepareRemoteOpenCodeArgs(node.id, { ...options, model: 'opencode/missing' }, runner)).rejects.toThrow('model_unavailable_on_node');
    expect(runner).toHaveBeenCalledTimes(4);
    expect(await prepareRemoteOpenCodeArgs(node.id, options, runner)).not.toContain('--standalone');
    db.prepare('DELETE FROM resource_observations WHERE node_id = ?').run(node.id);
    runner.mockResolvedValue({ code: 0, timed_out: false, stderr: '', stdout: '2.0.0' });
    await expect(prepareRemoteOpenCodeArgs(node.id, options, runner)).rejects.toThrow('remote_opencode_unsupported');
  });
  it('does not inject --standalone when the remote CLI lacks it', () => expect(remoteOpenCodeArgs({ ...options, opencodeStandalone: true }, capabilities())).not.toContain('--standalone'));
  it('includes --standalone when the remote CLI advertises it', () => expect(remoteOpenCodeArgs(options, capabilities(true))).toContain('--standalone'));
  it('rejects an exact model absent on the remote node', () => expect(() => remoteOpenCodeArgs({ ...options, effectiveModel: 'opencode/missing' }, capabilities())).toThrow('model_unavailable_on_node'));
  it('admits an exact model present on the remote node', () => expect(remoteOpenCodeArgs(options, capabilities())).toEqual(['run', '--format', 'json', '--model', options.model, '--agent', 'aikombinat-build']));
  it('fails closed on unsupported CLI and failed model discovery', () => {
    expect(() => remoteOpenCodeArgs(options, { ...capabilities(), compatible: false })).toThrow('unsupported');
    expect(() => remoteOpenCodeArgs(options, { ...capabilities(), models_verified: false })).toThrow('models_unverified');
  });
  it('probes the selected remote node, persists freshness and invalidates on connection change', async () => {
    const node = new ResourceFabric().createSshNode('Remote fixture', { host: 'fixture', auth_mode: 'config', workspace_root: '/jobs' });
    db.prepare('UPDATE compute_nodes SET identity = ? WHERE id = ?').run('host', node.id);
    db.prepare('INSERT INTO resource_observations VALUES (?, ?, ?)').run(node.id, canonicalJson(candidate().node.observation), new Date().toISOString());
    const runner = vi.fn(async (_command: string, args: string[]) => ({ code: 0, timed_out: false, stderr: '', stdout: args.at(-1)!.includes('--version') ? '1.18.33\n' : args.at(-1)!.includes("'run'") ? '--format --model --agent' : args.at(-1)!.includes('--help') ? 'models help' : 'opencode/fixture-free\nopencode/other\n' }));
    const first = await discoverRemoteOpenCode(node.id, runner);
    expect(first).toMatchObject({ compatible: true, models: ['opencode/fixture-free', 'opencode/other'] });
    expect(first.flags).not.toContain('--standalone');
    expect(runner.mock.calls).toHaveLength(4); expect(runner.mock.calls.every(([command, args]) => command === 'ssh' && args.includes('fixture'))).toBe(true);
    expect(await discoverRemoteOpenCode(node.id, runner)).toEqual(first); expect(runner).toHaveBeenCalledTimes(4);
    db.prepare("UPDATE resource_observations SET observation_json = json_set(observation_json, '$.remote_opencode.observed_at', '2000-01-01') WHERE node_id = ?").run(node.id);
    await discoverRemoteOpenCode(node.id, runner); expect(runner).toHaveBeenCalledTimes(8);
    db.prepare('UPDATE compute_node_connections SET connection_json = ? WHERE node_id = ?').run(canonicalJson({ ...node.connection, host: 'other' }), node.id);
    await discoverRemoteOpenCode(node.id, runner); expect(runner).toHaveBeenCalledTimes(12);
    db.prepare('UPDATE compute_nodes SET identity = ? WHERE id = ?').run('new-host', node.id);
    await discoverRemoteOpenCode(node.id, runner); expect(runner).toHaveBeenCalledTimes(16);
    db.prepare('UPDATE compute_nodes SET identity_changed = 1 WHERE id = ?').run(node.id);
    await expect(discoverRemoteOpenCode(node.id, runner)).rejects.toThrow('remote_opencode_node_unverified');
  });
});
