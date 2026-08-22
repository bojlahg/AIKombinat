import { resolveExecutionModel, type CliTool } from './cli-adapters.js';
import { resolveExecutionEffort, type AgentCliTool, type EffortLevel, type ResolvedEffort } from './effort-profiles.js';

export interface ResolvedExecutionConfig {
  requestedModel: string | null;
  model: string | undefined;
  modelAvailability: 'available' | 'unavailable' | 'unknown';
  effort: ResolvedEffort;
}

export function resolveExecutionConfig(input: {
  cliTool: AgentCliTool;
  model?: string;
  effortLevel: EffortLevel | null;
  projectEffortLevel: EffortLevel | null;
}): ResolvedExecutionConfig {
  const model = resolveExecutionModel(input.model, input.cliTool as CliTool, false);
  return {
    requestedModel: model.requestedModel,
    model: model.effectiveModel,
    modelAvailability: model.availability,
    effort: resolveExecutionEffort({
      cliTool: input.cliTool,
      model: model.effectiveModel,
      effortLevel: input.effortLevel,
      projectEffortLevel: input.projectEffortLevel,
    }),
  };
}
