import * as queries from '../db/queries.js';

export type AgentCliTool = queries.AgentCliTool;
export type EffortLevel = 1 | 2 | 3 | 4 | 5;
export type EffortMapping = queries.EffortMapping;

export interface AgentEffortProfile {
  cliTool: AgentCliTool;
  defaultLevel: EffortLevel;
  mapping: EffortMapping;
  updatedAt?: string;
}

export interface ResolvedEffort {
  requestedLevel: EffortLevel | null;
  levelSource: 'record' | 'project' | 'profile';
  profileTarget: string | null;
  nativeEffort: string | undefined;
  supportedEfforts: string[] | null;
  resolution: 'exact' | 'clamped' | 'provider-default' | 'capability-unknown';
  warning?: string;
}

export const NATIVE_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const RECOMMENDED_PROFILES: Record<AgentCliTool, AgentEffortProfile> = {
  claude: { cliTool: 'claude', defaultLevel: 3, mapping: { 1: 'low', 2: 'medium', 3: 'high', 4: 'xhigh', 5: 'max' } },
  codex: { cliTool: 'codex', defaultLevel: 2, mapping: { 1: 'low', 2: 'medium', 3: 'high', 4: 'xhigh', 5: 'max' } },
  antigravity: { cliTool: 'antigravity', defaultLevel: 2, mapping: { 1: 'low', 2: 'medium', 3: 'high', 4: 'high', 5: 'high' } },
};

export function isAgentCliTool(value: unknown): value is AgentCliTool {
  return value === 'claude' || value === 'codex' || value === 'antigravity';
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5;
}

export function validateMapping(value: unknown): value is EffortMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.join(',') === '1,2,3,4,5'
    && keys.every((key) => typeof record[key] === 'string' && (record[key] as string).trim().length > 0);
}

export function areMappingValuesAllowed(cliTool: AgentCliTool, mapping: EffortMapping): boolean {
  const allowed = new Set([...NATIVE_EFFORT_ORDER, 'provider-default']);
  Object.values(getProfile(cliTool).mapping).forEach((value) => allowed.add(value));
  for (const model of queries.getModelsByTool(cliTool)) {
    if (!model.supported_efforts) continue;
    try {
      const values = JSON.parse(model.supported_efforts);
      if (Array.isArray(values)) values.filter((value) => typeof value === 'string').forEach((value) => allowed.add(value));
    } catch { /* retain the last valid catalog */ }
  }
  return Object.values(mapping).every((value) => allowed.has(value));
}

function fromRow(row: queries.AgentEffortProfileRow): AgentEffortProfile {
  return {
    cliTool: row.cli_tool,
    defaultLevel: row.default_level as EffortLevel,
    mapping: JSON.parse(row.mapping_json) as EffortMapping,
    updatedAt: row.updated_at,
  };
}

export function getProfiles(): AgentEffortProfile[] {
  return queries.getAgentEffortProfiles().map(fromRow);
}

export function getProfile(cliTool: AgentCliTool): AgentEffortProfile {
  const row = queries.getAgentEffortProfile(cliTool);
  return row ? fromRow(row) : RECOMMENDED_PROFILES[cliTool];
}

export function saveProfile(cliTool: AgentCliTool, defaultLevel: EffortLevel, mapping: EffortMapping): AgentEffortProfile {
  return fromRow(queries.updateAgentEffortProfile(cliTool, defaultLevel, mapping));
}

export function resetProfile(cliTool: AgentCliTool): AgentEffortProfile {
  const defaults = RECOMMENDED_PROFILES[cliTool];
  return saveProfile(cliTool, defaults.defaultLevel, defaults.mapping);
}

export function getMappingWarnings(mapping: EffortMapping): string[] {
  const warnings: string[] = [];
  for (let level = 1; level < 5; level += 1) {
    const current = NATIVE_EFFORT_ORDER.indexOf(mapping[String(level) as keyof EffortMapping]);
    const next = NATIVE_EFFORT_ORDER.indexOf(mapping[String(level + 1) as keyof EffortMapping]);
    if (current >= 0 && next >= 0 && next < current) {
      warnings.push(`This mapping decreases effort between levels ${level} and ${level + 1}.`);
    }
  }
  return warnings;
}

function modelSupportedEfforts(cliTool: AgentCliTool, model?: string): string[] | null {
  if (cliTool === 'antigravity') return ['low', 'medium', 'high'];
  if (!model) return null;
  const row = queries.getModelsByTool(cliTool).find((item) => item.model_value === model);
  if (!row?.supported_efforts) return null;
  try {
    const parsed = JSON.parse(row.supported_efforts);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveExecutionEffort(input: {
  cliTool: AgentCliTool;
  model?: string;
  effortLevel: EffortLevel | null;
  projectEffortLevel?: EffortLevel | null;
  supportedEfforts?: string[] | null;
}): ResolvedEffort {
  const profile = getProfile(input.cliTool);
  const requestedLevel = isEffortLevel(input.effortLevel)
    ? input.effortLevel
    : isEffortLevel(input.projectEffortLevel)
      ? input.projectEffortLevel
      : profile.defaultLevel;
  const levelSource = isEffortLevel(input.effortLevel) ? 'record' : isEffortLevel(input.projectEffortLevel) ? 'project' : 'profile';
  const target = profile.mapping[String(requestedLevel) as keyof EffortMapping];
  if (target === 'provider-default') {
    return { requestedLevel, levelSource, profileTarget: target, nativeEffort: undefined, supportedEfforts: null, resolution: 'provider-default' };
  }
  const supported = input.supportedEfforts === undefined
    ? modelSupportedEfforts(input.cliTool, input.model)
    : input.supportedEfforts;
  if (!supported || supported.length === 0) {
    return { requestedLevel, levelSource, profileTarget: target, nativeEffort: target, supportedEfforts: null, resolution: 'capability-unknown' };
  }
  if (supported.includes(target)) {
    return { requestedLevel, levelSource, profileTarget: target, nativeEffort: target, supportedEfforts: supported, resolution: 'exact' };
  }
  const targetRank = NATIVE_EFFORT_ORDER.indexOf(target);
  const ranked = supported
    .map((value) => ({ value, rank: NATIVE_EFFORT_ORDER.indexOf(value) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (targetRank < 0 || ranked.length === 0) {
    return { requestedLevel, levelSource, profileTarget: target, nativeEffort: target, supportedEfforts: supported, resolution: 'capability-unknown', warning: `Unknown effort capability for ${target}.` };
  }
  const lower = ranked.filter((item) => item.rank <= targetRank).at(-1);
  const effective = lower ?? ranked[0];
  return {
    requestedLevel,
    levelSource,
    profileTarget: target,
    nativeEffort: effective.value,
    supportedEfforts: supported,
    resolution: 'clamped',
    warning: `Configured effort ${target} was clamped to ${effective.value}.`,
  };
}

export function resolveInheritedLevel(input: {
  recordLevel: number | null;
  projectLevel: number | null;
  cliTool: AgentCliTool;
}): EffortLevel {
  if (isEffortLevel(input.recordLevel)) return input.recordLevel;
  if (isEffortLevel(input.projectLevel)) return input.projectLevel;
  return getProfile(input.cliTool).defaultLevel;
}
