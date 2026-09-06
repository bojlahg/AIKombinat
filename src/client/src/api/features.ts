import { get } from './client';

export interface FeatureFlags {
  agentForum: boolean;
}

export async function getFeatures(): Promise<FeatureFlags> {
  return get<FeatureFlags>('/api/features');
}
