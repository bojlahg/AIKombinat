export const RESOURCE_CATALOG = [
  { key: 'unity.editor', label: 'Unity Editor', capacity: 1 },
  { key: 'android.emulator', label: 'Android Emulator', capacity: 1 },
  { key: 'gpu.0', label: 'GPU 0', capacity: 1 },
  { key: 'local.llm', label: 'Local LLM', capacity: 1 },
  { key: 'cpu.heavy', label: 'CPU Heavy', capacity: 1 },
] as const;

export type ResourceKey = (typeof RESOURCE_CATALOG)[number]['key'];

export interface ResourceDefinition {
  key: ResourceKey;
  label: string;
  capacity: number;
}

const RESOURCE_KEYS = new Set<string>(RESOURCE_CATALOG.map((resource) => resource.key));
const RESOURCE_ORDER = new Map<string, number>(RESOURCE_CATALOG.map((resource, index) => [resource.key, index]));

export class ResourceValidationError extends Error {}

export function isResourceKey(value: unknown): value is ResourceKey {
  return typeof value === 'string' && RESOURCE_KEYS.has(value);
}

export function normalizeResourceKeys(input: unknown): ResourceKey[] {
  if (!Array.isArray(input)) {
    throw new ResourceValidationError('resource_requirements must be an array of resource keys');
  }
  const normalized = new Set<ResourceKey>();
  for (const value of input) {
    if (!isResourceKey(value)) {
      throw new ResourceValidationError(`Unknown resource key: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    normalized.add(value);
  }
  return [...normalized].sort((a, b) => RESOURCE_ORDER.get(a)! - RESOURCE_ORDER.get(b)!);
}

export function parseStoredResourceRequirements(raw: string | null): ResourceKey[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored resource requirements contain malformed JSON');
  }
  try {
    return normalizeResourceKeys(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid stored resource requirements: ${message}`);
  }
}

export function serializeResourceRequirements(keys: ResourceKey[]): string | null {
  const normalized = normalizeResourceKeys(keys);
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}
