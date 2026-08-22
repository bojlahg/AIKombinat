import * as queries from '../db/queries.js';
import { resolveExecutionModel, type CliTool } from './cli-adapters.js';
import { resolveExecutionEffort, type EffortLevel, type ResolvedEffort } from './effort-profiles.js';

export interface ResolvedExecutionConfig {
  cliTool: CliTool;
  source: 'profile' | 'manual' | 'legacy';
  profileId?: string;
  profileName?: string;
  requestedModel: string | null;
  model: string | undefined;
  modelAvailability: 'available' | 'unavailable' | 'unknown';
  effort: ResolvedEffort;
  warnings: string[];
  resolvedAt: string;
}

export function resolveExecutionConfig(input: {
  cliTool: CliTool;
  model?: string | null;
  cliEffort?: string | null;
  agentProfileId?: string | null;
  effortLevel?: EffortLevel | null;
  projectEffortLevel?: EffortLevel | null;
}): ResolvedExecutionConfig {
  if (input.cliTool === 'raw-shell') {
    return { cliTool: 'raw-shell', source: 'manual', requestedModel: null, model: undefined, modelAvailability: 'unknown', effort: { requestedLevel: null, levelSource: 'record', profileTarget: null, nativeEffort: undefined, supportedEfforts: null, resolution: 'provider-default' }, warnings: [], resolvedAt: new Date().toISOString() };
  }
  const warnings: string[] = [];
  let cliTool = input.cliTool;
  let requestedModel = input.model ?? undefined;
  let nativeEffort = input.cliEffort ?? undefined;
  let source: ResolvedExecutionConfig['source'] = input.cliEffort != null || input.effortLevel == null ? 'manual' : 'legacy';
  let profile: queries.AgentProfile | undefined;
  if (input.agentProfileId) {
    profile = queries.getAgentProfileById(input.agentProfileId);
    if (!profile) throw new Error(`Agent profile "${input.agentProfileId}" no longer exists.`);
    if (!profile.is_enabled) throw new Error(`Agent profile "${profile.name}" is disabled.`);
    if (profile.cli_tool !== cliTool) warnings.push(`Record agent ${cliTool} did not match profile agent ${profile.cli_tool}; profile agent was used.`);
    cliTool = profile.cli_tool;
    requestedModel = profile.model_value ?? undefined;
    nativeEffort = profile.effort_value ?? undefined;
    source = 'profile';
  }
  const model = resolveExecutionModel(requestedModel, cliTool, true);
  const effort: ResolvedEffort = source === 'legacy'
    ? resolveExecutionEffort({ cliTool, model: model.effectiveModel, effortLevel: input.effortLevel ?? null, projectEffortLevel: input.projectEffortLevel ?? null })
    : { requestedLevel: null, levelSource: 'record', profileTarget: nativeEffort ?? null, nativeEffort, supportedEfforts: null, resolution: nativeEffort ? 'capability-unknown' : 'provider-default' };
  if (effort.warning) warnings.push(effort.warning);
  return {
    cliTool,
    source,
    profileId: profile?.id,
    profileName: profile?.name,
    requestedModel: model.requestedModel,
    model: model.effectiveModel,
    modelAvailability: model.availability,
    effort,
    warnings,
    resolvedAt: new Date().toISOString(),
  };
}

export const executionSnapshot = (config: ResolvedExecutionConfig) => ({
  agent: config.cliTool,
  configuration: config.source,
  profileId: config.profileId ?? null,
  profileName: config.profileName ?? null,
  resolvedModel: config.model ?? null,
  resolvedEffort: config.effort.nativeEffort ?? null,
  resolvedAt: config.resolvedAt,
  warnings: config.warnings,
});
