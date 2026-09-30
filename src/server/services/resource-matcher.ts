import type { ComputeNode, FabricBinding, ResourceInstance } from './resource-fabric-types.js';
import type { FabricRequirements, ResourceConstraints } from './resource-requirements.js';

export interface MatchCandidate {
  node: ComputeNode; instances: ResourceInstance[];
  leased: Record<string, number>;
  workspacePath?: string;
}
export interface MatchRejection { node_id: string; reasons: string[] }
export interface MatchDecision { binding: Omit<FabricBinding, 'id' | 'request_id'> | null; rejected: MatchRejection[] }
export function capabilityMatches(actual: string | boolean | undefined, expected: string | boolean): boolean {
  if (typeof expected === 'boolean') return expected ? actual !== undefined && actual !== false : actual === undefined || actual === false;
  const comparison = /^(>=|<=|==)(\d+(?:\.\d+){0,3})$/.exec(expected);
  if (!comparison) return actual === expected;
  if (typeof actual !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(actual)) return false;
  const a = actual.split('.').map(Number), b = comparison[2].split('.').map(Number);
  let delta = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) { delta = (a[i] ?? 0) - (b[i] ?? 0); if (delta) break; }
  return comparison[1] === '>=' ? delta >= 0 : comparison[1] === '<=' ? delta <= 0 : delta === 0;
}
export function externallyBusy(node: ComputeNode, instance: ResourceInstance): boolean {
  const observation = node.observation?.gpus.find(gpu => gpu.hardware_uuid === instance.hardware_uuid);
  return !!observation && (observation.compute_pids.length > 0 || (observation.memory_used_bytes ?? 0) >= Math.max(1024 ** 3, instance.vram_bytes * 0.2));
}
const modelKey = (value: string) => value.replace(/^(NVIDIA\s+)?(GeForce\s+)?/i, '').trim().toLowerCase();
const preferredInstance = (instance: ResourceInstance, preferences: ResourceConstraints) => (preferences.resources ?? []).filter(preference => (!preference.key || preference.key === instance.id || preference.key === instance.legacy_key) && preference.kind === instance.kind && (!preference.model || modelKey(preference.model) === modelKey(instance.model)) && (!preference.min_vram_bytes || instance.vram_bytes >= preference.min_vram_bytes)).length;
function test(candidate: MatchCandidate, constraints: ResourceConstraints, runtime: boolean, preferences: ResourceConstraints = {}): { reasons: string[]; resources: ResourceInstance[] } {
  const { node, leased } = candidate, inventory = node.inventory, policy = node.policy;
  const reasons: string[] = [], resources: ResourceInstance[] = [];
  if (constraints.node_id && constraints.node_id !== node.id) reasons.push('node_mismatch');
  for (const [field, value] of Object.entries(constraints.platform ?? {})) {
    if (inventory?.platform[field as 'os' | 'distro' | 'arch'] !== value) reasons.push(`${field}_mismatch`);
  }
  for (const [key, value] of Object.entries(constraints.capabilities ?? {})) {
    if (!capabilityMatches({ ...inventory?.capabilities, ...policy.capability_overrides }[key], value)) reasons.push(`capability_unsatisfied:${key}`);
  }
  const cpuUsed = leased[`node/${node.id}/cpu`] ?? 0;
  const memoryUsed = leased[`node/${node.id}/memory`] ?? 0;
  const threads = constraints.cpu?.threads ?? 0;
  if (threads > Math.max(0, (inventory?.cpu.logical_threads ?? 0) - policy.cpu_reserve_threads - (runtime ? cpuUsed : 0))) reasons.push('cpu_threads_insufficient');
  const physical = inventory?.cpu.physical_cores;
  if (constraints.cpu?.min_physical_cores && (!physical || constraints.cpu.min_physical_cores > physical - Math.ceil((policy.cpu_reserve_threads + (runtime ? cpuUsed : 0)) / (inventory?.cpu.threads_per_core || 1)))) reasons.push('physical_cores_insufficient');
  const memory = constraints.memory?.bytes ?? 0;
  if (memory > Math.max(0, (inventory?.memory.total_bytes ?? 0) - policy.memory_reserve_bytes - (runtime ? memoryUsed : 0))) reasons.push('memory_capacity_insufficient');
  const observationFresh = !!node.observation && Date.now() - Date.parse(node.observation.timestamp) <= 90_000;
  if (runtime && memory && (!observationFresh || memory > Math.max(0, (node.observation?.memory_available_bytes ?? 0) - policy.memory_safety_bytes - memoryUsed))) reasons.push('memory_headroom_insufficient_or_stale');
  if (constraints.storage?.min_free_bytes) {
    const disks = runtime ? (observationFresh ? node.observation?.storage : []) : inventory?.storage;
    const normalizePath = (value: string) => value.replace(/\\/g, '/').toLowerCase();
    const root = node.connection?.workspace_root ?? candidate.workspacePath;
    const disk = root ? [...(disks ?? [])].filter(volume => normalizePath(root) === normalizePath(volume.mount) || normalizePath(root).startsWith(normalizePath(volume.mount).replace(/\/$/, '') + '/')).sort((a, b) => b.mount.length - a.mount.length)[0] : [...(disks ?? [])].sort((a, b) => b.free_bytes - a.free_bytes)[0];
    if (!disk || disk.free_bytes - policy.storage_reserve_bytes < constraints.storage.min_free_bytes) reasons.push('storage_headroom_insufficient');
  }
  for (const requirement of constraints.resources ?? []) {
    const eligible = candidate.instances.filter(instance => {
      if (resources.some(selected => selected.id === instance.id) || !instance.present) return false;
      if (requirement.key) { if (instance.id !== requirement.key && instance.legacy_key !== requirement.key) return false; }
      else if (instance.kind !== requirement.kind) return false;
      if (requirement.model && modelKey(requirement.model) !== modelKey(instance.model)) return false;
      if (requirement.min_vram_bytes && instance.vram_bytes < requirement.min_vram_bytes) return false;
      if (runtime && (instance.policy !== 'enabled' || instance.desired_policy || (leased[instance.id] ?? 0) + (instance.legacy_key ? leased[instance.legacy_key] ?? 0 : 0) > 0)) return false;
      if (runtime && instance.kind === 'gpu' && (!observationFresh || (policy.avoid_external_gpu && externallyBusy(node, instance)))) return false;
      return true;
    }).sort((a, b) => preferredInstance(b, preferences) - preferredInstance(a, preferences) || (a.local_index ?? 999) - (b.local_index ?? 999) || a.id.localeCompare(b.id));
    if (eligible.length < requirement.count) reasons.push(`resource_count_insufficient:${requirement.key ?? requirement.kind}`);
    resources.push(...eligible.slice(0, requirement.count));
  }
  return { reasons, resources };
}

export function matchResources(requirements: FabricRequirements, candidates: MatchCandidate[]): MatchDecision {
  const rejected: MatchRejection[] = [], ranked: Array<{ candidate: MatchCandidate; resources: ResourceInstance[]; score: number }> = [];
  for (const candidate of candidates) {
    const result = test(candidate, requirements.requires, true, requirements.prefers);
    if (!candidate.node.enabled || candidate.node.scheduler_state !== 'online' || candidate.node.identity_changed) result.reasons.unshift(`node_${candidate.node.identity_changed ? 'identity_changed' : candidate.node.scheduler_state}`);
    if (result.reasons.length) { rejected.push({ node_id: candidate.node.id, reasons: result.reasons }); continue; }
    let score = 0;
    for (const [key, value] of Object.entries(requirements.prefers)) {
      if (key === 'platform' || key === 'capabilities') {
        for (const [field, entry] of Object.entries(value as object)) if (!test(candidate, { [key]: { [field]: entry } }, false).reasons.length) score++;
      } else if (key === 'resources') { if (!test({ ...candidate, instances: result.resources }, { resources: value as ResourceConstraints['resources'] }, false).reasons.length) score++; }
      else if (!test(candidate, { [key]: value }, false).reasons.length) score++;
    }
    ranked.push({ candidate, resources: result.resources, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.candidate.node.id.localeCompare(b.candidate.node.id));
  const best = ranked[0];
  if (!best) return { binding: null, rejected };
  const node = best.candidate.node;
  const gpus = best.resources.filter(instance => instance.kind === 'gpu');
  return { rejected, binding: { node_id: node.id, transport: node.transport, resource_instances: best.resources.map(instance => instance.id), capacity: { cpu_threads: requirements.requires.cpu?.threads ?? 0, memory_bytes: requirements.requires.memory?.bytes ?? 0 }, environment: gpus.length ? { CUDA_VISIBLE_DEVICES: gpus.map(instance => instance.local_index).join(',') } : {}, platform: node.inventory?.platform ?? null } };
}
