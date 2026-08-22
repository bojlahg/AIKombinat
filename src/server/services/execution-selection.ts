import * as queries from '../db/queries.js';

export class ExecutionSelectionError extends Error {}

export function normalizeExecutionSelection(input: { cliTool?: unknown; cliModel?: unknown; cliModelId?: unknown; cliEffort?: unknown; executionProfileId?: unknown; executionProfile?: unknown }) {
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
  return {
    cliTool: profile ? null : model?.cli_tool ?? (typeof input.cliTool === 'string' ? input.cliTool : null),
    cliModel: profile ? null : model?.model_value ?? (typeof input.cliModel === 'string' && input.cliModel.trim() ? input.cliModel.trim() : null),
    cliModelId: profile ? null : modelId,
    cliEffort: profile ? null : typeof input.cliEffort === 'string' && input.cliEffort.trim() ? input.cliEffort.trim() : null,
    executionProfileId: profileId,
  };
}
