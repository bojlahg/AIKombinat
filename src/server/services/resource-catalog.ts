import { getDatabase } from '../db/connection.js';
import { canonicalJson, requirementsSchema, type ResourceRequirements } from './resource-requirements.js';

const LEGACY_RESOURCES = [
  { key: 'unity.editor', label: 'Unity Editor', capacity: 1 },
  { key: 'android.emulator', label: 'Android Emulator', capacity: 1 },
  { key: 'gpu.0', label: 'GPU 0', capacity: 1 },
  { key: 'local.llm', label: 'Local LLM', capacity: 1 },
  { key: 'cpu.heavy', label: 'CPU Heavy', capacity: 1 },
] as const;

export type ResourceKey = string;

export interface ResourceDefinition {
  key: ResourceKey;
  label: string;
  capacity: number;
}

export { LEGACY_RESOURCES };
const RESOURCE_ORDER = new Map<string, number>(LEGACY_RESOURCES.map((resource, index) => [resource.key, index]));

export class ResourceValidationError extends Error {}

export function isResourceKey(value: unknown): value is ResourceKey {
  return typeof value === 'string' && !!getDatabase().prepare('SELECT id FROM resource_instances WHERE legacy_key = ? OR id = ?').get(value, value);
}

export function normalizeResourceKeys(input: unknown): ResourceKey[] {
  if (!Array.isArray(input)) {
    throw new ResourceValidationError('resource_requirements must be an array of resource keys');
  }
  if (input.length > 32) throw new ResourceValidationError('Resource requirements may contain at most 32 keys');
  const normalized = new Set<ResourceKey>();
  for (const value of input) {
    if (typeof value !== 'string' || value.length > 128 || !/^[\w.:-]+$/.test(value)) throw new ResourceValidationError('Invalid resource key format');
    if (!isResourceKey(value)) {
      throw new ResourceValidationError(`Unknown resource key: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    normalized.add(value);
  }
  return [...normalized].sort((a, b) => (RESOURCE_ORDER.get(a) ?? 99) - (RESOURCE_ORDER.get(b) ?? 99) || a.localeCompare(b));
}

export function normalizeResourceRequirements(input: unknown): ResourceRequirements {
  if (Array.isArray(input)) return normalizeResourceKeys(input);
  const parsed = requirementsSchema.safeParse(input);
  if (!parsed.success) throw new ResourceValidationError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  if (canonicalJson(parsed.data).length > 16384) throw new ResourceValidationError('Resource requirements are too large');
  return parsed.data;
}

export function parseStoredResourceRequirements(raw: string | null): ResourceRequirements {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored resource requirements contain malformed JSON');
  }
  try {
    return normalizeResourceRequirements(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid stored resource requirements: ${message}`);
  }
}

export function serializeResourceRequirements(keys: ResourceRequirements): string | null {
  const normalized = normalizeResourceRequirements(keys);
  return Array.isArray(normalized) ? (normalized.length > 0 ? JSON.stringify(normalized) : null) : canonicalJson(normalized);
}
