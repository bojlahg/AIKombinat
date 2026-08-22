import type { AgentCliTool } from '../db/queries.js';

export function isAgentCliTool(value: unknown): value is AgentCliTool {
  return value === 'claude' || value === 'codex' || value === 'antigravity';
}
