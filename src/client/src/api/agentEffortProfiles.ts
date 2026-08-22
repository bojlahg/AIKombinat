import { get, patch, post } from './client';

export type AgentCliTool = 'claude' | 'codex' | 'antigravity';
export type EffortMapping = Record<'1' | '2' | '3' | '4' | '5', string>;

export interface AgentEffortProfile {
  cliTool: AgentCliTool;
  defaultLevel: 1 | 2 | 3 | 4 | 5;
  mapping: EffortMapping;
  warnings: string[];
}

export const getProfiles = () => get<AgentEffortProfile[]>('/api/agent-effort-profiles');
export const saveProfile = (profile: AgentEffortProfile) => patch<AgentEffortProfile>(`/api/agent-effort-profiles/${profile.cliTool}`, {
  defaultLevel: profile.defaultLevel,
  mapping: profile.mapping,
});
export const resetProfile = (cliTool: AgentCliTool) => post<AgentEffortProfile>(`/api/agent-effort-profiles/${cliTool}/reset`);
export const refreshModels = (cliTool: AgentCliTool) => post<{ success: boolean; source: string; authoritative: boolean; count: number }>(`/api/models/refresh/${cliTool}`);
