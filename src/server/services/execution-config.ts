import * as queries from '../db/queries.js';
import { resolveExecutionModel, supportsInteractiveMode, type CliTool, type LaunchModelSelection } from './cli-adapters.js';

export interface ResolvedExecutionConfig {
  cliTool: CliTool;
  source: 'profile' | 'manual';
  profileId?: string;
  profileSlug?: string;
  profileName?: string;
  executorCandidateId?: string;
  cliModelId?: string;
  requestedModel: string | null;
  model: string | undefined;
  effectiveModel?: string | null;
  modelAvailability: 'available' | 'unavailable' | 'unknown';
  effort: { nativeEffort: string | undefined; supportedEfforts: string[] | null; resolution: 'exact' | 'capability-unknown' | 'provider-default' };
  warnings: string[];
  resolvedAt: string;
}

function parsedEfforts(model: queries.CliModel): string[] | null {
  if (!model.supported_efforts) return null;
  try {
    const values = JSON.parse(model.supported_efforts);
    return Array.isArray(values) && values.every((value) => typeof value === 'string') ? values : null;
  } catch { return null; }
}

function effortConfig(model: queries.CliModel | undefined, effort: string | null | undefined) {
  const nativeEffort = effort && effort !== 'provider-default' ? effort : undefined;
  const supportedEfforts = model ? parsedEfforts(model) : null;
  if (model?.cli_tool === 'antigravity' && model.provider_variants && !nativeEffort) {
    throw new Error(`Antigravity model "${model.model_label}" requires an explicit effort selection (${(supportedEfforts ?? []).join(', ')}).`);
  }
  if (nativeEffort && supportedEfforts && !supportedEfforts.includes(nativeEffort)) {
    throw new Error(`Effort "${nativeEffort}" is not supported by model "${model!.model_label}"`);
  }
  return { nativeEffort, supportedEfforts, resolution: !nativeEffort ? 'provider-default' as const : supportedEfforts ? 'exact' as const : 'capability-unknown' as const };
}

export function resolveExecutionConfig(input: {
  cliTool?: CliTool | null;
  model?: string | null;
  cliModelId?: string | null;
  cliEffort?: string | null;
  executionProfileId?: string | null;
  interactive?: boolean;
}): ResolvedExecutionConfig {
  const resolvedAt = new Date().toISOString();
  if (input.executionProfileId) {
    const profile = queries.getExecutionProfileById(input.executionProfileId);
    if (!profile) throw new Error(`Execution profile "${input.executionProfileId}" no longer exists.`);
    if (!profile.is_enabled) throw new Error(`Execution profile "${profile.name}" is disabled.`);
    for (const executor of profile.executors.filter((candidate) => candidate.is_enabled).sort((a, b) => a.priority - b.priority)) {
      if (executor.model_status === 'missing') continue;
      if (input.interactive && !supportsInteractiveMode(executor.cli_tool)) continue;
      const model = queries.getModelById(executor.cli_model_id);
      if (!model) continue;
      try {
        const effortConf = effortConfig(model, executor.effort_value);
        const resolved = resolveExecutionModel(model.model_value, executor.cli_tool as CliTool, true, effortConf.nativeEffort);
        return {
          cliTool: executor.cli_tool, source: 'profile', profileId: profile.id, profileSlug: profile.slug, profileName: profile.name,
          executorCandidateId: executor.id, cliModelId: model.id, requestedModel: model.model_value, model: model.model_value,
          effectiveModel: resolved.effectiveModel ?? model.model_value,
          modelAvailability: 'available', effort: effortConf, warnings: [], resolvedAt,
        };
      } catch { /* saved unsupported candidates remain visible but are ineligible */ }
    }
    throw new Error(`Execution profile "${profile.name}" has no eligible executors.`);
  }

  const catalogModel = input.cliModelId ? queries.getModelById(input.cliModelId) : undefined;
  if (input.cliModelId && !catalogModel) throw new Error('Selected model no longer exists.');
  if (catalogModel?.status === 'missing') throw new Error(`Selected model "${catalogModel.model_label}" is missing from the latest CLI refresh.`);
  const cliTool = (catalogModel?.cli_tool ?? input.cliTool ?? 'claude') as CliTool;
  if (cliTool === 'raw-shell') {
    return { cliTool, source: 'manual', requestedModel: null, model: undefined, effectiveModel: undefined, modelAvailability: 'unknown', effort: effortConfig(undefined, null), warnings: [], resolvedAt };
  }
  const requested = catalogModel?.model_value ?? input.model ?? undefined;
  const catalog = catalogModel ?? (requested ? queries.getModelByValue(cliTool, requested) : undefined);
  const effortConf = effortConfig(catalog, input.cliEffort);
  const resolved = resolveExecutionModel(requested, cliTool, true, effortConf.nativeEffort);
  return {
    cliTool, source: 'manual', cliModelId: catalogModel?.id, requestedModel: resolved.requestedModel, model: requested,
    effectiveModel: resolved.effectiveModel ?? requested ?? null,
    modelAvailability: resolved.availability,
    effort: effortConf,
    warnings: [], resolvedAt,
  };
}

/**
 * Everything a spawn needs from an already-resolved execution config.
 *
 * This is the single launch boundary shared by every feature (AgentForum,
 * Discussion, Todo/Review/Rework, Session). `effectiveModel` is the frozen
 * provider slug resolution picked at admission and is what the CLI actually
 * receives; `model` is kept alongside it only so the provider adapter can tell
 * a grouped variant slug (effort already encoded) from a plain one. Neither is
 * resolved again at spawn time.
 */
export interface LaunchSelection extends LaunchModelSelection {
  effort?: string;
}

export function launchSelection(config: ResolvedExecutionConfig | null | undefined): LaunchSelection {
  return {
    model: config?.model ?? undefined,
    effectiveModel: config?.effectiveModel ?? undefined,
    effort: config?.effort.nativeEffort,
  };
}

export const executionSnapshot = (config: ResolvedExecutionConfig) => ({
  configuration: config.source,
  profileId: config.profileId ?? null,
  profileSlug: config.profileSlug ?? null,
  profileName: config.profileName ?? null,
  executorCandidateId: config.executorCandidateId ?? null,
  agent: config.cliTool,
  cliModelId: config.cliModelId ?? null,
  model: config.model ?? null,
  effectiveModel: config.effectiveModel ?? config.model ?? null,
  effort: config.effort.nativeEffort ?? null,
  resolvedAt: config.resolvedAt,
  warnings: config.warnings,
});
