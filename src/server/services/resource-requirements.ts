import { z } from 'zod';

const text = z.string().trim().min(1).max(128).regex(/^[\w .:+/=-]+$/);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const capability = z.union([z.boolean(), text]).refine(value => typeof value !== 'string' || !/^[<>!=~^]/.test(value) || /^(>=|<=|==)\d+(\.\d+){0,3}$/.test(value), 'Unsupported capability comparator');
const constraints = z.object({
  node_id: z.string().uuid().optional(),
  platform: z.object({ os: text.optional(), distro: text.optional(), arch: text.optional() }).strict().optional(),
  capabilities: z.record(text, capability).refine(value => Object.keys(value).length <= 32).optional(),
  cpu: z.object({ threads: quantity.max(65536).optional(), min_physical_cores: quantity.max(65536).optional() }).strict().optional(),
  memory: z.object({ bytes: quantity.optional() }).strict().optional(),
  storage: z.object({ min_free_bytes: quantity.optional() }).strict().optional(),
  resources: z.array(z.object({ kind: z.enum(['gpu', 'custom']), count: quantity.min(1).max(64).default(1), model: text.optional(), min_vram_bytes: quantity.optional(), same_node: z.boolean().optional(), key: text.optional() }).strict()).max(32).optional(),
}).strict();
export const requirementsSchema = z.object({ version: z.literal(2), requires: constraints.default({}), prefers: constraints.default({}) }).strict();
export type ResourceConstraints = z.infer<typeof constraints>;
export type FabricRequirements = z.infer<typeof requirementsSchema>;
export type ResourceRequirements = string[] | FabricRequirements;

export function canonicalJson(value: unknown): string {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sort(entry)]));
    return item;
  }
  return JSON.stringify(sort(value));
}

export function toFabricRequirements(value: ResourceRequirements): FabricRequirements {
  return Array.isArray(value) ? { version: 2, requires: { resources: value.map(key => ({ kind: 'custom', count: 1, key })) }, prefers: {} } : value;
}

export function hasResourceRequirements(value: ResourceRequirements): boolean {
  return Array.isArray(value) ? value.length > 0 : Object.keys(value.requires).length > 0 || Object.keys(value.prefers).length > 0;
}
