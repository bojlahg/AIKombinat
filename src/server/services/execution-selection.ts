import * as queries from '../db/queries.js';

export function normalizeExecutionSelection(input: { cliTool?: unknown; cliModel?: unknown; cliEffort?: unknown; agentProfileId?: unknown }) {
  const profileId = typeof input.agentProfileId === 'string' && input.agentProfileId.trim() ? input.agentProfileId.trim() : null;
  const profile = profileId ? queries.getAgentProfileById(profileId) : undefined;
  if (profileId && !profile) throw new Error('Agent profile not found');
  if (profile && !profile.is_enabled) throw new Error('Agent profile is disabled');
  const cliTool = profile?.cli_tool ?? (typeof input.cliTool === 'string' ? input.cliTool : null);
  return {
    cliTool,
    cliModel: profile ? null : typeof input.cliModel === 'string' && input.cliModel.trim() ? input.cliModel.trim() : null,
    cliEffort: profile ? null : typeof input.cliEffort === 'string' && input.cliEffort.trim() ? input.cliEffort.trim() : null,
    agentProfileId: profileId,
  };
}
