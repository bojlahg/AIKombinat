import { get, post, patch } from './client';

export interface Orchestration {
  id: string; project_id: string; title: string; objective: string; status: string;
  primary_execution_profile_id: string; state_summary: string; current_plan: string;
  waiting_reason: string | null; wake_condition_json: string | null;
  max_turns: number; max_children: number; max_concurrent_children: number; max_active_resource_requests: number;
  turn_count: number; child_count: number;
}
export interface OrchestrationInput {
  title: string; objective: string; primary_execution_profile_id: string;
  max_turns: number; max_children: number; max_concurrent_children: number; max_active_resource_requests: number;
}
export interface Message { id: string; role: string; content: string; created_at: string }
export interface Child { id: string; todo_id: string; title: string; status: string; pipeline_phase: string | null; summary: string | null; execution_profile_id: string | null;
  execution_profile_name?: string; executor?: string; model?: string; resource_binding?: { id: string } | null; latest_error?: string }
export interface Reservation {
  request_id: string; purpose: string; status: string; claim_expires_at: string | null; claimed_todo_id: string | null;
  requirements: unknown; binding: { id: string; capacity: { cpu_threads: number; memory_bytes: number }; transport: string } | null;
}
export interface Turn { id: string; turn_index: number; status: string; process_pid: number; execution_snapshot: string | null; error_message: string | null }
export const list = (projectId: string) => get<Orchestration[]>(`/api/projects/${projectId}/orchestrators`);
export const create = (projectId: string, input: OrchestrationInput) => post<Orchestration>(`/api/projects/${projectId}/orchestrators`, input);
export const update = (id: string, input: Partial<OrchestrationInput>) => patch<Orchestration>(`/api/orchestrators/${id}`, input);
export const control = (id: string, action: 'start' | 'pause' | 'resume' | 'cancel') => post<Orchestration>(`/api/orchestrators/${id}/${action}`);
export const messages = (id: string) => get<Message[]>(`/api/orchestrators/${id}/messages`);
export const send = (id: string, content: string) => post(`/api/orchestrators/${id}/messages`, { content });
export const children = (id: string) => get<Child[]>(`/api/orchestrators/${id}/children`);
export const resources = (id: string) => get<Reservation[]>(`/api/orchestrators/${id}/resources`);
export const turns = (id: string) => get<Turn[]>(`/api/orchestrators/${id}/turns`);
export const release = (id: string, requestId: string) => post(`/api/orchestrators/${id}/resources/${requestId}/release`);
