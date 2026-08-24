import { get } from './client';
import type { ResourceStatus } from '../types';

export function getResources(): Promise<{ resources: ResourceStatus[] }> {
  return get('/api/resources');
}
