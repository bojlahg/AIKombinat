import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import {
  getCliVersion,
  markUnavailableExcept,
  setCliDetectedVersion,
  setModelCatalogRefreshedAt,
  upsertDiscoveredModel,
  type ModelSource,
} from '../db/queries.js';
import { getAdapter, type CliTool, type ProbedModel } from './cli-adapters.js';

const MODEL_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10_000;

export interface DiscoveredModel extends ProbedModel {
  supportedEfforts?: string[] | null;
}

export interface ModelDiscoveryResult {
  models: DiscoveredModel[];
  source: ModelSource;
  authoritative: boolean;
  primarySucceeded: boolean;
  added?: number;
  updated?: number;
  restored?: number;
  markedMissing?: number;
  diagnostics?: DiscoveryDiagnostic[];
}

export interface DiscoveryDiagnostic {
  command: string;
  exitCode: number | null;
  stdoutLength: number;
  stderr: string;
  parsedModelCount: number;
  source: ModelSource;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const CLAUDE_BASE_EFFORTS = ['low', 'medium', 'high'];
const CLAUDE_MAX_EFFORTS = [...CLAUDE_BASE_EFFORTS, 'max'];
const CLAUDE_FULL_EFFORTS = [...CLAUDE_BASE_EFFORTS, 'xhigh', 'max'];

export const DOCUMENTED_CLAUDE_MODELS: DiscoveredModel[] = [
  { value: 'claude-fable-5', label: 'Claude Fable 5', supportedEfforts: CLAUDE_FULL_EFFORTS },
  { value: 'claude-opus-5', label: 'Claude Opus 5', supportedEfforts: CLAUDE_FULL_EFFORTS },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', supportedEfforts: CLAUDE_FULL_EFFORTS },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8', supportedEfforts: CLAUDE_FULL_EFFORTS },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7', supportedEfforts: CLAUDE_FULL_EFFORTS },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', supportedEfforts: CLAUDE_MAX_EFFORTS },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportedEfforts: CLAUDE_MAX_EFFORTS },
  { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', supportedEfforts: CLAUDE_BASE_EFFORTS },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', supportedEfforts: null },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', supportedEfforts: null },
];

function execCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      ...(process.platform === 'win32' ? { shell: true } : {}),
    }, (error, stdout, stderr) => {
      const code = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? null : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: code });
    });
  });
}

function stripTerminalSequences(value: string): string {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, '');
}

function safeDiagnosticStderr(value: string): string {
  return stripTerminalSequences(value)
    .replace(/(api[_-]?key|authorization|token|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .trim().slice(0, 1000);
}

function diagnostic(command: string, result: CommandResult, parsedModelCount: number, source: ModelSource): DiscoveryDiagnostic {
  return { command, exitCode: result.exitCode, stdoutLength: result.stdout.length, stderr: safeDiagnosticStderr(result.stderr), parsedModelCount, source };
}

function effortValues(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.map((item) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return null;
    const obj = item as Record<string, unknown>;
    return obj.reasoningEffort ?? obj.effort ?? obj.value ?? obj.id ?? null;
  }).filter((value): value is string => typeof value === 'string' && value.length > 0);
  return values.length > 0 ? [...new Set(values)] : null;
}

function parseModelObjects(raw: unknown): DiscoveredModel[] {
  let items: unknown = raw;
  if (!Array.isArray(items) && items && typeof items === 'object') {
    const obj = items as Record<string, unknown>;
    items = obj.data ?? obj.models ?? obj.items ?? obj.result ?? [];
    if (!Array.isArray(items) && items && typeof items === 'object') {
      const nested = items as Record<string, unknown>;
      items = nested.data ?? nested.models ?? nested.items ?? [];
    }
  }
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): DiscoveredModel[] => {
    if (typeof item === 'string') return [{ value: item, label: item }];
    if (!item || typeof item !== 'object') return [];
    const obj = item as Record<string, unknown>;
    const value = obj.id ?? obj.slug ?? obj.model ?? obj.value ?? obj.name;
    if (typeof value !== 'string' || !value.trim()) return [];
    const label = obj.displayName ?? obj.display_name ?? obj.label ?? obj.name ?? value;
    const supportedEfforts = effortValues(obj.supportedReasoningEfforts ?? obj.supported_efforts ?? obj.reasoningEfforts ?? obj.efforts);
    return [{ value: value.trim(), label: typeof label === 'string' ? label : value.trim(), supportedEfforts }];
  });
}

export function parseAntigravityModels(output: string): DiscoveredModel[] {
  const ignored = /^(available|models?|name|slug|default|[-=]+)$/i;
  const values = new Map<string, DiscoveredModel>();
  for (const rawLine of stripTerminalSequences(output).split(/\r?\n/)) {
    const line = rawLine.replace(/^[*✓>\s]+/, '').trim();
    if (!line) continue;
    const match = line.match(/^([a-z0-9][a-z0-9._:/-]+)\s+(.+)$/i);
    if (!match || ignored.test(match[1])) continue;
    const value = match[1].trim();
    const label = match[2].trim();
    if (!label) continue;
    values.set(value, { value, label, supportedEfforts: null });
  }
  return [...values.values()];
}

export function parseAntigravityModelEnvelope(output: string): DiscoveredModel[] | null {
  try {
    const payload = JSON.parse(output) as { status?: unknown; response?: unknown };
    if (payload.status !== 'SUCCESS' || typeof payload.response !== 'string') return null;
    const models = parseAntigravityModels(payload.response);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export function parseCodexModelList(payload: unknown): DiscoveredModel[] {
  return parseModelObjects(payload);
}

export async function discoverAntigravity(run = execCommand): Promise<ModelDiscoveryResult> {
  const diagnostics: DiscoveryDiagnostic[] = [];
  const primary = await run('agy', ['models']);
  const primaryModels = primary.exitCode === 0 ? parseAntigravityModels(primary.stdout) : [];
  diagnostics.push(diagnostic('agy models', primary, primaryModels.length, 'antigravity-models'));
  if (primaryModels.length > 0) {
    console.info('[model-sync] Antigravity discovery', diagnostics[0]);
    return { models: primaryModels, source: 'antigravity-models', authoritative: true, primarySucceeded: true, diagnostics };
  }

  const fallback = await run('agy', ['-p', '/model', '--output-format', 'json']);
  const fallbackModels = fallback.exitCode === 0 ? parseAntigravityModelEnvelope(fallback.stdout) : null;
  diagnostics.push(diagnostic('agy -p "/model" --output-format json', fallback, fallbackModels?.length ?? 0, 'antigravity-model-command'));
  console.info('[model-sync] Antigravity discovery', diagnostics);
  if (fallbackModels) {
    return { models: fallbackModels, source: 'antigravity-model-command', authoritative: true, primarySucceeded: true, diagnostics };
  }
  return { models: [], source: 'antigravity-model-command', authoritative: false, primarySucceeded: false, diagnostics };
}

async function discoverCodexAppServer(): Promise<ModelDiscoveryResult | null> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
    let buffer = '';
    let settled = false;
    const finish = (result: ModelDiscoveryResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), DISCOVERY_TIMEOUT_MS);
    child.on('error', () => finish(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (message.id === 2) {
            if (message.error) finish(null);
            else {
              const models = parseCodexModelList(message.result);
              finish({ models, source: 'codex-app-server', authoritative: models.length > 0, primarySucceeded: models.length > 0 });
            }
          }
        } catch { /* ignore diagnostics */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'clitrigger', title: 'CLITrigger', version: '1' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ method: 'model/list', id: 2, params: { cursor: null } })}\n`);
  });
}

function readCodexCache(): DiscoveredModel[] {
  try {
    return parseModelObjects(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf-8')));
  } catch {
    return [];
  }
}

async function discoverClaude(version: string): Promise<ModelDiscoveryResult> {
  const weak = await getAdapter('claude').probeModels?.() ?? [];
  const merged = new Map<string, DiscoveredModel>();
  [...DOCUMENTED_CLAUDE_MODELS, ...weak].forEach((model) => merged.set(model.value, model));
  return { models: [...merged.values()], source: 'claude-documented', authoritative: false, primarySucceeded: true };
}

export async function discoverModelCatalog(tool: CliTool, version = ''): Promise<ModelDiscoveryResult> {
  if (tool === 'antigravity') {
    const primary = await discoverAntigravity();
    return primary ?? { models: [], source: 'registry', authoritative: false, primarySucceeded: false };
  }
  if (tool === 'codex') {
    const primary = await discoverCodexAppServer();
    if (primary) return primary;
    const cached = readCodexCache();
    if (cached.length > 0) return { models: cached, source: 'codex-cache', authoritative: false, primarySucceeded: false };
    return { models: [], source: 'registry', authoritative: false, primarySucceeded: false };
  }
  return discoverClaude(version);
}

export async function refreshModelCatalog(
  tool: CliTool,
  options: { version?: string; discover?: (tool: CliTool, version: string) => Promise<ModelDiscoveryResult> } = {},
): Promise<ModelDiscoveryResult> {
  const now = new Date().toISOString();
  const discover = options.discover ?? discoverModelCatalog;
  const discovered = await discover(tool, options.version ?? '');
  const result = discovered.models.length > 0 ? discovered : { ...discovered, authoritative: false, primarySucceeded: false };
  if (result.models.length === 0) return { ...result, added: 0, updated: 0, restored: 0, markedMissing: 0 };

  const counts = { added: 0, updated: 0, restored: 0, markedMissing: 0 };
  for (const model of result.models) {
    counts[upsertDiscoveredModel(tool, model.value, model.label, result.source, now, model.supportedEfforts ?? null)] += 1;
  }
  if (result.authoritative && result.primarySucceeded) {
    counts.markedMissing = markUnavailableExcept(tool, result.models.map((model) => model.value), now);
  }
  if (result.primarySucceeded) setModelCatalogRefreshedAt(tool, now);
  return { ...result, ...counts };
}

export async function syncModels(tool: CliTool, version: string): Promise<void> {
  await refreshModelCatalog(tool, { version });
}

export async function maybeTriggerSync(tool: CliTool, version: string | null): Promise<void> {
  if (!version) return;
  const previous = getCliVersion(tool);
  const versionChanged = previous?.last_version !== version;
  const stale = !previous?.last_synced_at || Date.now() - new Date(previous.last_synced_at).getTime() >= MODEL_REFRESH_TTL_MS;
  setCliDetectedVersion(tool, version);
  if (!versionChanged && !stale) return;
  try {
    await refreshModelCatalog(tool, { version });
  } catch (err) {
    console.warn(`[model-sync] refreshModelCatalog(${tool}) failed:`, err);
  }
}
