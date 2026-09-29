import type { AgentCliTool, QuotaProviderTool } from '../db/queries.js';

export function isQuotaProviderTool(value: unknown): value is QuotaProviderTool {
  return value === 'claude' || value === 'codex' || value === 'antigravity';
}

export function isAgentCliTool(value: unknown): value is AgentCliTool {
  return value === 'claude' || value === 'codex' || value === 'antigravity' || value === 'opencode';
}
