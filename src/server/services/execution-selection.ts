import * as queries from '../db/queries.js';

export class ExecutionSelectionError extends Error {}

export function validateAntigravityExecutionEffort(
  model: queries.CliModel,
  rawEffort: unknown,
): string | null {
  if (model.cli_tool !== 'antigravity') {
    return typeof rawEffort === 'string' && rawEffort.trim() && rawEffort.trim() !== 'provider-default'
      ? rawEffort.trim()
      : null;
  }

  let variants: Record<string, string> = {};
  if (model.provider_variants) {
    try { variants = JSON.parse(model.provider_variants); } catch { variants = {}; }
  }

  const isGrouped = Object.keys(variants).length > 0;
  if (!isGrouped) {
    return typeof rawEffort === 'string' && rawEffort.trim() && rawEffort.trim() !== 'provider-default'
      ? rawEffort.trim()
      : null;
  }

  const effort = typeof rawEffort === 'string' && rawEffort.trim() && rawEffort.trim() !== 'provider-default'
    ? rawEffort.trim()
    : null;

  if (!effort) {
    throw new ExecutionSelectionError(`Antigravity model "${model.model_label}" requires an explicit effort selection`);
  }

  let supported: string[] | null = null;
  if (model.supported_efforts) {
    try {
      const parsed = JSON.parse(model.supported_efforts);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        supported = parsed;
      }
    } catch { supported = null; }
  }

  if (supported && !supported.includes(effort)) {
    throw new ExecutionSelectionError(`Effort "${effort}" is not supported for Antigravity model "${model.model_label}"`);
  }

  if (!variants[effort]) {
    throw new ExecutionSelectionError(`Provider variant mapping for effort "${effort}" does not exist for model "${model.model_label}"`);
  }

  return effort;
}

export function normalizeExecutionSelection(input: {
  cliTool?: unknown;
  cliModel?: unknown;
  cliModelId?: unknown;
  cliEffort?: unknown;
  executionProfileId?: unknown;
  executionProfile?: unknown;
}) {
  let profileId = typeof input.executionProfileId === 'string' && input.executionProfileId.trim() ? input.executionProfileId.trim() : null;
  if (!profileId && typeof input.executionProfile === 'string' && input.executionProfile.trim()) {
    const profile = queries.getExecutionProfileBySlug(input.executionProfile.trim());
    if (!profile || !profile.is_enabled) throw new ExecutionSelectionError('Unknown or disabled execution profile');
    profileId = profile.id;
  }
  const profile = profileId ? queries.getExecutionProfileById(profileId) : undefined;
  if (profileId && !profile) throw new ExecutionSelectionError('Execution profile not found');
  if (profile && !profile.is_enabled) throw new ExecutionSelectionError('Execution profile is disabled');

  const requestedModelId = !profile && typeof input.cliModelId === 'string' && input.cliModelId.trim() ? input.cliModelId.trim() : null;
  const requestedTool = typeof input.cliTool === 'string' ? input.cliTool : null;
  const requestedValue = typeof input.cliModel === 'string' && input.cliModel.trim() ? input.cliModel.trim() : null;
  const model = requestedModelId ? queries.getModelById(requestedModelId) : requestedTool && requestedValue ? queries.getModelByValue(requestedTool, requestedValue) : undefined;
  const modelId = model?.id ?? requestedModelId;
  if (modelId && !model) throw new ExecutionSelectionError('Model not found');

  const validatedEffort = model
    ? validateAntigravityExecutionEffort(model, input.cliEffort)
    : (typeof input.cliEffort === 'string' && input.cliEffort.trim() && input.cliEffort.trim() !== 'provider-default' ? input.cliEffort.trim() : null);

  return {
    cliTool: profile ? null : model?.cli_tool ?? (typeof input.cliTool === 'string' ? input.cliTool : null),
    cliModel: profile ? null : model?.model_value ?? (typeof input.cliModel === 'string' && input.cliModel.trim() ? input.cliModel.trim() : null),
    cliModelId: profile ? null : modelId,
    cliEffort: profile ? null : validatedEffort,
    executionProfileId: profileId,
  };
}
