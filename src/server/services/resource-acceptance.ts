import type { MatchCandidate } from './resource-matcher.js';
import { externallyBusy, matchResources } from './resource-matcher.js';
import type { FabricRequirements } from './resource-requirements.js';

export function gpuSmokeRequirements(nodeId: string, instanceId: string): FabricRequirements {
  return { version: 2, requires: { node_id: nodeId, resources: [{ kind: 'gpu', key: instanceId, count: 1, min_vram_bytes: 1024 ** 3 }] }, prefers: {} };
}

export function selectSmokeGpu(candidates: MatchCandidate[]) {
  for (const candidate of [...candidates].sort((a, b) => Number(a.node.transport === 'ssh') - Number(b.node.transport === 'ssh'))) {
    for (const instance of candidate.instances) {
      if (instance.kind !== 'gpu' || externallyBusy(candidate.node, instance)) continue;
      const requirements = gpuSmokeRequirements(candidate.node.id, instance.id);
      if (matchResources(requirements, [candidate]).binding) return { node: candidate.node, instance, requirements };
    }
  }
  return null;
}

export function assertSmokeRemoteRoot(root: string): void {
  if (!/^\/(?:home\/[^/]+|tmp)\/(?:\.aikombinat-)?resource-acceptance-[a-zA-Z0-9-]+$/.test(root)) {
    throw new Error('Use a dedicated /home/<user>/resource-acceptance-<unique-id> or /tmp/resource-acceptance-<unique-id> root');
  }
}
