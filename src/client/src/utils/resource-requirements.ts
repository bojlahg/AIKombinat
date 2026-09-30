import type { ResourceRequirements } from '../types';

export function parseResourceRequirements(raw: string | null | undefined): ResourceRequirements {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (parsed?.version === 2 && parsed.requires && parsed.prefers) return parsed;
  } catch { /* preserve form availability for legacy invalid data */ }
  return [];
}
