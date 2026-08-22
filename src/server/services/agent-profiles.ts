import * as queries from '../db/queries.js';
import { isAgentCliTool } from './effort-profiles.js';

export type AgentProfileInput = {
  cliTool: queries.AgentCliTool;
  name: string;
  modelValue: string | null;
  effortValue: string | null;
  isEnabled: boolean;
};

const optionalString = (value: unknown): string | null => value == null || value === '' ? null : String(value).trim();

export function normalizeAgentProfile(body: Record<string, unknown>, existing?: queries.AgentProfile): AgentProfileInput {
  const cliTool = (body.cliTool ?? existing?.cli_tool) as unknown;
  if (!isAgentCliTool(cliTool)) throw new Error('cliTool must be claude, codex, or antigravity');
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name) throw new Error('name must not be empty');
  return {
    cliTool,
    name,
    modelValue: optionalString(body.modelValue === undefined ? existing?.model_value : body.modelValue),
    effortValue: optionalString(body.effortValue === undefined ? existing?.effort_value : body.effortValue),
    isEnabled: body.isEnabled === undefined ? existing?.is_enabled !== 0 : Boolean(body.isEnabled),
  };
}

export const toApiAgentProfile = (row: queries.AgentProfile) => ({
  id: row.id,
  cliTool: row.cli_tool,
  name: row.name,
  modelValue: row.model_value,
  effortValue: row.effort_value,
  isEnabled: Boolean(row.is_enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
