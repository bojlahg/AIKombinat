import { get, post, patch, put, del } from './client';
import type { ResourceStatus, ComputeNode, ResourceInstance, NodeConnection, NodePolicy } from '../types';

export function getResources(): Promise<{ resources: ResourceStatus[]; nodes?: Array<{ id: string; name: string }> }> {
  return get('/api/resources');
}
export interface CapacityView { node_id: string; cpu: { total: number; reserve: number; leased: number; available: number }; memory: { total: number; reserve: number; leased: number; available: number } }
export interface FabricView { nodes: ComputeNode[]; instances: Array<ResourceInstance & { used: number; externally_busy: boolean; runtime_state: string }>; capacity: CapacityView[] }
export interface RequestView { id: string; owner_id: string; owner_type: string; status: string; reasons_json: string; requirements_json: string; created_at: string }
export interface LeaseView { id: string; node_id: string | null; resource_key: string; amount: number; owner_type: 'todo' | 'session'; owner_id: string; owner_title: string; project_id: string; process_pid: number; execution_profile_id: string | null; execution_snapshot: string | null; acquired_at: string; run_token: string; binding_id: string | null }
export const getFabric = () => get<FabricView>('/api/resources/nodes');
export const getResourceRequests = () => get<{ requests: RequestView[] }>('/api/resources/requests');
export const getResourceLeases = () => get<{ leases: LeaseView[] }>('/api/resources/leases');
export const discoverHosts = () => get<{ hosts: string[] }>('/api/resources/ssh-hosts');
export const createSshNode = (name: string, connection: NodeConnection, enabled = true) => post<ComputeNode>('/api/resources/nodes', { name, connection, enabled });
export const updateNode = (id: string, updates: { name?: string; enabled?: boolean; scheduler_state?: ComputeNode['scheduler_state']; connection?: NodeConnection }) => patch<ComputeNode>(`/api/resources/nodes/${id}`, updates);
export const deleteNode = (id: string) => del(`/api/resources/nodes/${id}`);
export const scanNode = (id: string) => post<{ node: ComputeNode; diff: string[] }>(`/api/resources/nodes/${id}/scan`);
export const testNode = (id: string) => post<{ status: string; error?: string }>(`/api/resources/nodes/${id}/test`);
export const updateNodePolicy = (id: string, policy: NodePolicy) => put(`/api/resources/nodes/${id}/policy`, policy);
export const updateGpuPolicy = (id: string, policy: ResourceInstance['policy'], after_current = false, reason?: string) => put(`/api/resources/instances/${id}/policy`, { policy, after_current, reason });
export const stopResourceTodo = (id: string, force = false) => post<{ status: string }>(`/api/resources/todos/${id}/stop`, { force });
export const getScanHistory = (id: string) => get<{ snapshots: Array<{ id: string; diff_json: string; created_at: string }> }>(`/api/resources/nodes/${id}/history`);
