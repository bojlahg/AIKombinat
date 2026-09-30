export interface NodeInventory {
  platform: { os: string; distro?: string; version?: string; arch: string; hostname: string };
  cpu: { model: string; physical_cores: number | null; logical_threads: number; threads_per_core: number | null; flags: string[] };
  memory: { total_bytes: number; available_bytes: number };
  storage: Array<{ mount: string; total_bytes: number; free_bytes: number; filesystem?: string }>;
  gpus: Array<{ hardware_uuid: string; local_index: number; model: string; vram_bytes: number; driver_version?: string; cuda?: string }>;
  capabilities: Record<string, string | boolean>;
}
export interface NodeObservation {
  timestamp: string;
  memory_available_bytes: number;
  storage: NodeInventory['storage'];
  gpus: Array<{ hardware_uuid: string; utilization: number | null; memory_used_bytes: number | null; temperature: number | null; power: number | null; compute_pids: number[] }>;
}
export interface NodePolicy {
  cpu_reserve_threads: number;
  memory_reserve_bytes: number;
  storage_reserve_bytes: number;
  memory_safety_bytes: number;
  avoid_external_gpu: boolean;
  capability_overrides: Record<string, string | boolean>;
}
export interface NodeConnection {
  host: string;
  port?: number;
  user?: string;
  auth_mode: 'config' | 'agent' | 'key';
  key_path?: string;
  workspace_root: string;
}
export type SchedulerState = 'online' | 'draining' | 'maintenance' | 'offline' | 'disabled';
export interface ComputeNode {
  id: string;
  name: string;
  transport: 'local' | 'ssh';
  enabled: boolean;
  scheduler_state: SchedulerState;
  identity: string | null;
  identity_changed: boolean;
  last_scan_at: string | null;
  last_health_at: string | null;
  last_error: string | null;
  connection: NodeConnection | null;
  inventory: NodeInventory | null;
  observation: NodeObservation | null;
  policy: NodePolicy;
}
export interface ResourceInstance {
  id: string; node_id: string; kind: 'gpu' | 'custom'; legacy_key: string | null;
  hardware_uuid: string | null; local_index: number | null; model: string; vram_bytes: number;
  origin: 'detected' | 'manual' | 'configured'; present: number;
  policy: 'enabled' | 'reserved' | 'disabled'; desired_policy: 'reserved' | null; reserve_reason: string | null;
}
export interface FabricBinding {
  id: string; request_id: string; node_id: string; transport: 'local' | 'ssh';
  remote_workspace?: string;
  resource_instances: string[]; capacity: { cpu_threads: number; memory_bytes: number };
  environment: Record<string, string>; platform: NodeInventory['platform'] | null;
}
