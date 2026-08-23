import { del, get, patch, post } from './client';

export type AgentCliTool = 'claude' | 'codex' | 'antigravity';

export interface ExecutionProfileExecutor {
  id: string;
  cliModelId: string;
  cliTool: AgentCliTool;
  modelValue: string;
  modelLabel: string;
  modelStatus: 'available' | 'missing';
  supportedEfforts: string[] | null;
  effortValue: string | null;
  priority: number;
  isEnabled: boolean;
}

export interface ExecutionProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  isEnabled: boolean;
  sortOrder: number;
  executors?: ExecutionProfileExecutor[];
}

export type ExecutionProfileInput = Omit<ExecutionProfile, 'id' | 'executors'> & {
  executors: Array<{ id?: string; cliModelId: string; effortValue: string | null; priority: number; isEnabled: boolean }>;
};

export type ExecutionProfileCreateInput = Omit<ExecutionProfileInput, 'slug'> & { slug?: string };

export const getProfiles = (includeDisabled = true) => get<ExecutionProfile[]>(`/api/execution-profiles?detail=full&includeDisabled=${includeDisabled}`);
export const createProfile = (value: ExecutionProfileCreateInput) => post<ExecutionProfile>('/api/execution-profiles', value);
export const updateProfile = (id: string, value: Partial<ExecutionProfileInput>) => patch<ExecutionProfile>(`/api/execution-profiles/${id}`, value);
export const deleteProfile = (id: string) => del<void>(`/api/execution-profiles/${id}`);
