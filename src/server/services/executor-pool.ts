import * as queries from '../db/queries.js';
import { getAdapter, resolveExecutionModel, supportsInteractiveMode, type CliTool } from './cli-adapters.js';
import { getToolStatus } from './cli-status.js';
import { resolveExecutionConfig, type ResolvedExecutionConfig } from './execution-config.js';

export class ExecutionSelectionError extends Error {}

export interface CandidateEvaluation {
  candidateId: string;
  cliTool: CliTool;
  toolName: string;
  model: string;
  modelLabel: string;
  effort: string | null;
  priority: number;
  status: 'available' | 'busy' | 'unavailable' | 'invalid';
  reason: string;
}

export interface PoolSelectionResult {
  status: 'selected' | 'waiting_executor' | 'no_candidates';
  selectedConfig?: ResolvedExecutionConfig;
  selectedCandidate?: queries.ExecutionProfileExecutor;
  evaluations: CandidateEvaluation[];
  profileId?: string;
  profileSlug?: string;
  profileName?: string;
  evaluatedAt: string;
  rejectionSummary?: string;
}

const DEFAULT_CONCURRENCY: Record<CliTool, number> = {
  claude: 2,
  codex: 2,
  antigravity: 2,
  'raw-shell': 10,
};

function getTodoActiveCliTool(todo: queries.Todo): CliTool {
  if (todo.execution_snapshot) {
    try {
      const snap = JSON.parse(todo.execution_snapshot);
      if (snap?.agent) return snap.agent as CliTool;
    } catch { /* ignore */ }
  }
  if (todo.cli_tool) return todo.cli_tool as CliTool;
  const project = queries.getProjectById(todo.project_id);
  return (project?.cli_tool as CliTool) || 'claude';
}

function getSessionActiveCliTool(session: queries.Session): CliTool {
  if (session.execution_snapshot) {
    try {
      const snap = JSON.parse(session.execution_snapshot);
      if (snap?.agent) return snap.agent as CliTool;
    } catch { /* ignore */ }
  }
  if (session.cli_tool) return session.cli_tool as CliTool;
  const project = queries.getProjectById(session.project_id);
  return (project?.cli_tool as CliTool) || 'claude';
}

function getDiscussionActiveCliTool(discussion: queries.Discussion): CliTool {
  if (discussion.current_agent_id) {
    const agent = queries.getDiscussionAgentById(discussion.current_agent_id);
    if (agent?.execution_profile_id) {
      try {
        const resolved = resolveExecutionConfig({
          cliTool: (agent.cli_tool as CliTool) || undefined,
          model: agent.cli_model ?? undefined,
          cliModelId: agent.cli_model_id,
          cliEffort: agent.cli_effort,
          executionProfileId: agent.execution_profile_id,
        });
        if (resolved?.cliTool) return resolved.cliTool;
      } catch { /* ignore */ }
    }
    if (agent?.cli_tool) return agent.cli_tool as CliTool;
  }
  const project = queries.getProjectById(discussion.project_id);
  return (project?.cli_tool as CliTool) || 'claude';
}

export function formatCandidateDiagnostics(evaluations: CandidateEvaluation[]): string {
  return evaluations.map((e) => {
    const label = `${e.toolName} / ${e.modelLabel || e.model}${e.effort ? ` / ${e.effort}` : ''}:`;
    return `${label}\n  ${e.status} - ${e.reason}`;
  }).join('\n\n');
}

export interface SlotReservation {
  ownerId: string;
  tool: CliTool;
  createdAt: number;
}

export class ExecutorPool {
  private limitOverrides: Map<CliTool, number> = new Map();
  private reservations: Map<string, SlotReservation> = new Map();

  getLimit(tool: CliTool): number {
    const override = this.limitOverrides.get(tool);
    if (override !== undefined) return override;

    const envKey = `EXECUTOR_LIMIT_${tool.toUpperCase().replace(/-/g, '_')}`;
    if (process.env[envKey]) {
      const parsed = parseInt(process.env[envKey]!, 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }

    return DEFAULT_CONCURRENCY[tool] ?? 2;
  }

  setLimit(tool: CliTool, limit: number): void {
    this.limitOverrides.set(tool, limit);
  }

  resetLimits(): void {
    this.limitOverrides.clear();
    this.reservations.clear();
  }

  reserveSlot(ownerId: string, tool: CliTool): boolean {
    if (!this.hasAvailableSlot(tool, { excludeReservationOwnerId: ownerId })) {
      return false;
    }
    this.reservations.set(ownerId, { ownerId, tool, createdAt: Date.now() });
    return true;
  }

  releaseReservation(ownerId: string): void {
    this.reservations.delete(ownerId);
  }

  resetReservations(): void {
    this.reservations.clear();
  }

  getReservations(): SlotReservation[] {
    return Array.from(this.reservations.values());
  }

  getActiveToolUsage(
    tool: CliTool,
    options: { excludeTodoId?: string; excludeReservationOwnerId?: string } = {},
  ): number {
    let count = 0;

    const runningTodos = queries.getTodosByStatus('running');
    for (const todo of runningTodos) {
      if (options.excludeTodoId && todo.id === options.excludeTodoId) continue;
      if (getTodoActiveCliTool(todo) === tool) count++;
    }

    const runningSessions = queries.getSessionsByStatus('running');
    for (const session of runningSessions) {
      if (getSessionActiveCliTool(session) === tool) count++;
    }

    const runningDiscussions = queries.getDiscussionsByStatus('running');
    for (const discussion of runningDiscussions) {
      if (getDiscussionActiveCliTool(discussion) === tool) count++;
    }

    for (const res of this.reservations.values()) {
      if (options.excludeReservationOwnerId && res.ownerId === options.excludeReservationOwnerId) continue;
      if (res.tool === tool) count++;
    }

    return count;
  }

  hasAvailableSlot(
    tool: CliTool,
    options: { excludeTodoId?: string; excludeReservationOwnerId?: string } = {},
  ): boolean {
    const active = this.getActiveToolUsage(tool, options);
    const limit = this.getLimit(tool);
    return active < limit;
  }

  getSlotStatus(
    tool: CliTool,
    options: { excludeTodoId?: string; excludeReservationOwnerId?: string } = {},
  ): { active: number; limit: number; available: boolean } {
    const active = this.getActiveToolUsage(tool, options);
    const limit = this.getLimit(tool);
    return { active, limit, available: active < limit };
  }

  async evaluateCandidate(
    candidate: queries.ExecutionProfileExecutor,
    options: { interactive?: boolean; excludeTodoId?: string; excludeReservationOwnerId?: string } = {},
  ): Promise<CandidateEvaluation> {
    const cliTool = candidate.cli_tool as CliTool;
    const adapter = getAdapter(cliTool);
    const toolName = cliTool === 'claude' ? 'Claude' : cliTool === 'codex' ? 'Codex' : cliTool === 'antigravity' ? 'Antigravity' : adapter.displayName;
    const model = candidate.model_value;
    const modelLabel = candidate.model_label;
    const effort = candidate.effort_value;
    const priority = candidate.priority;

    // 4. Candidate is not disabled
    if (candidate.is_enabled === 0) {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'invalid', reason: 'Candidate is disabled',
      };
    }

    // 1. CLI/tool is installed and usable
    const toolStatus = await getToolStatus(cliTool);
    if (!toolStatus || !toolStatus.installed) {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'unavailable', reason: 'CLI not installed',
      };
    }

    if (options.interactive && !supportsInteractiveMode(cliTool)) {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'unavailable', reason: `${toolName} does not support interactive mode`,
      };
    }

    // 2. Referenced model exists and is status=available
    const catalogModel = queries.getModelById(candidate.cli_model_id);
    if (!catalogModel) {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'invalid', reason: 'Referenced model does not exist',
      };
    }

    if (catalogModel.status === 'missing' || candidate.model_status === 'missing') {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'unavailable', reason: `Model "${catalogModel.model_label}" is missing from CLI discovery`,
      };
    }

    // 3. Configured effort/model combination is valid
    let supported: string[] | null = null;
    if (catalogModel.supported_efforts) {
      try {
        const parsed = JSON.parse(catalogModel.supported_efforts);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          supported = parsed;
        }
      } catch { supported = null; }
    }

    if (cliTool === 'antigravity') {
      let variants: Record<string, string> = {};
      if (catalogModel.provider_variants) {
        try { variants = JSON.parse(catalogModel.provider_variants); } catch { variants = {}; }
      }
      const isGrouped = Object.keys(variants).length > 0;
      if (isGrouped) {
        if (!effort) {
          return {
            candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
            status: 'invalid', reason: `Antigravity model "${catalogModel.model_label}" requires an explicit effort selection`,
          };
        }
        if (supported && !supported.includes(effort)) {
          return {
            candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
            status: 'invalid', reason: `Effort "${effort}" is not supported for Antigravity model "${catalogModel.model_label}"`,
          };
        }
        if (!variants[effort]) {
          return {
            candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
            status: 'invalid', reason: `Provider variant mapping for effort "${effort}" does not exist for model "${catalogModel.model_label}"`,
          };
        }
      }
    } else if (effort && supported && !supported.includes(effort)) {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'invalid', reason: `Effort "${effort}" is not supported by model "${catalogModel.model_label}"`,
      };
    }

    // 5. Provider/tool has an available concurrency slot
    if (!this.hasAvailableSlot(cliTool, {
      excludeTodoId: options.excludeTodoId,
      excludeReservationOwnerId: options.excludeReservationOwnerId,
    })) {
      return {
        candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
        status: 'busy', reason: 'provider concurrency limit reached',
      };
    }

    return {
      candidateId: candidate.id, cliTool, toolName, model, modelLabel, effort, priority,
      status: 'available', reason: 'available',
    };
  }

  private selectMutex: Promise<void> = Promise.resolve();

  async selectExecutor(input: {
    executionProfileId: string | null | undefined;
    interactive?: boolean;
    excludeTodoId?: string;
    reserveOwnerId?: string;
  }): Promise<PoolSelectionResult> {
    let release: () => void;
    const prevMutex = this.selectMutex;
    this.selectMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await prevMutex;
      return await this._doSelectExecutor(input);
    } finally {
      release!();
    }
  }

  private async _doSelectExecutor(input: {
    executionProfileId: string | null | undefined;
    interactive?: boolean;
    excludeTodoId?: string;
    reserveOwnerId?: string;
  }): Promise<PoolSelectionResult> {
    const evaluatedAt = new Date().toISOString();
    if (!input.executionProfileId) {
      throw new ExecutionSelectionError('Execution profile is required.');
    }
    const profile = queries.getExecutionProfileById(input.executionProfileId);
    if (!profile) {
      throw new ExecutionSelectionError(`Execution profile "${input.executionProfileId}" no longer exists.`);
    }
    if (!profile.is_enabled) {
      throw new ExecutionSelectionError(`Execution profile "${profile.name}" is disabled.`);
    }

    // Keep deterministic priority ordering
    const sortedExecutors = [...profile.executors].sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));

    const evaluations: CandidateEvaluation[] = [];
    let selectedCandidate: queries.ExecutionProfileExecutor | undefined;

    for (const candidate of sortedExecutors) {
      const evaluation = await this.evaluateCandidate(candidate, {
        interactive: input.interactive,
        excludeTodoId: input.excludeTodoId,
        excludeReservationOwnerId: input.reserveOwnerId,
      });
      evaluations.push(evaluation);

      if (!selectedCandidate && evaluation.status === 'available') {
        selectedCandidate = candidate;
      }
    }

    if (selectedCandidate) {
      if (input.reserveOwnerId) {
        this.reserveSlot(input.reserveOwnerId, selectedCandidate.cli_tool as CliTool);
      }

      const model = queries.getModelById(selectedCandidate.cli_model_id)!;
      const nativeEffort = selectedCandidate.effort_value && selectedCandidate.effort_value !== 'provider-default'
        ? selectedCandidate.effort_value
        : undefined;
      let supportedEfforts: string[] | null = null;
      if (model.supported_efforts) {
        try {
          const parsed = JSON.parse(model.supported_efforts);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) supportedEfforts = parsed;
        } catch { /* ignore */ }
      }

      const resolved = resolveExecutionModel(model.model_value, selectedCandidate.cli_tool as CliTool, true, nativeEffort);
      const selectedConfig: ResolvedExecutionConfig = {
        cliTool: selectedCandidate.cli_tool as CliTool,
        source: 'profile',
        profileId: profile.id,
        profileSlug: profile.slug,
        profileName: profile.name,
        executorCandidateId: selectedCandidate.id,
        cliModelId: model.id,
        requestedModel: model.model_value,
        model: model.model_value,
        effectiveModel: resolved.effectiveModel ?? model.model_value,
        modelAvailability: 'available',
        effort: {
          nativeEffort,
          supportedEfforts,
          resolution: !nativeEffort ? 'provider-default' : supportedEfforts ? 'exact' : 'capability-unknown',
        },
        warnings: [],
        resolvedAt: evaluatedAt,
      };

      return {
        status: 'selected',
        selectedConfig,
        selectedCandidate,
        evaluations,
        profileId: profile.id,
        profileSlug: profile.slug,
        profileName: profile.name,
        evaluatedAt,
      };
    }

    const rejectionSummary = formatCandidateDiagnostics(evaluations);
    const hasBusyCandidate = evaluations.some((e) => e.status === 'busy');

    if (hasBusyCandidate) {
      return {
        status: 'waiting_executor',
        evaluations,
        profileId: profile.id,
        profileSlug: profile.slug,
        profileName: profile.name,
        evaluatedAt,
        rejectionSummary,
      };
    }

    return {
      status: 'no_candidates',
      evaluations,
      profileId: profile.id,
      profileSlug: profile.slug,
      profileName: profile.name,
      evaluatedAt,
      rejectionSummary,
    };
  }
}

export const executorPool = new ExecutorPool();
