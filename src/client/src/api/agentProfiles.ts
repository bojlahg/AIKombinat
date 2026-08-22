import { del, get, patch, post } from './client';

export type AgentCliTool = 'claude' | 'codex' | 'antigravity';
export interface AgentProfile {
  id: string;
  cliTool: AgentCliTool;
  name: string;
  modelValue: string | null;
  effortValue: string | null;
  isEnabled: boolean;
}

export const getProfiles = (cliTool?: AgentCliTool) => get<AgentProfile[]>(`/api/agent-profiles${cliTool ? `?cliTool=${cliTool}` : ''}`);
export const createProfile = (value: Omit<AgentProfile, 'id'>) => post<AgentProfile>('/api/agent-profiles', value);
export const updateProfile = (id: string, value: Partial<Omit<AgentProfile, 'id' | 'cliTool'>>) => patch<AgentProfile>(`/api/agent-profiles/${id}`, value);
export const deleteProfile = (id: string) => del<void>(`/api/agent-profiles/${id}`);
