import path from 'path';
import { execFile } from 'child_process';
import { getModelByValue } from '../db/queries.js';
import { assertExternalAiCliAllowed } from '../utils/cli-guard.js';

export type CliTool = 'claude' | 'antigravity' | 'codex' | 'raw-shell';
export type CliMode = 'headless' | 'interactive' | 'verbose';
export type SandboxMode = 'strict' | 'permissive';

export interface CliBuildOptions {
  mode: CliMode;
  prompt: string;
  model?: string;
  effort?: string;
  extraOptions?: string;
  maxTurns?: number;
  workDir?: string;
  projectPath?: string;
  sandboxMode?: SandboxMode;
  continueSession?: boolean;
  promptPolicy?: PromptPolicy;
}

export interface ProbedModel {
  value: string;
  label: string;
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Best-effort parse of a CLI --help dump to extract supported model identifiers.
 *
 * Heuristic: looks for lines that mention the `--model` flag and collects any
 * comma/space-separated identifiers on the same (or next) line that match
 * known model naming patterns (e.g. "claude-sonnet-4-6", "gpt-4.1", "o3",
 * "gemini-2.5-pro"). Returns an empty array if nothing plausible is found;
 * callers should treat empty as "probe failed, use registry".
 */
export function parseHelpForModels(helpText: string): ProbedModel[] {
  if (!helpText || typeof helpText !== 'string') return [];

  // Identifier shape CLI vendors tend to use for model slugs
  const modelIdPattern = /\b(?:claude-[a-z0-9-]+|gpt-[0-9][0-9a-z.-]*|o[0-9][0-9a-z.-]*|gemini-[0-9][0-9a-z.-]*)\b/gi;

  const lines = helpText.split(/\r?\n/);
  const collected = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/--model\b/i.test(line)) continue;
    // Scan current line + next 3 lines (help text often puts choices below)
    const window = lines.slice(i, Math.min(i + 4, lines.length)).join(' ');
    const matches = window.match(modelIdPattern);
    if (matches) {
      for (const m of matches) collected.add(m.toLowerCase());
    }
  }

  return Array.from(collected).map((value) => ({ value, label: value }));
}

/** Extract long and short option names from vendor help output. */
export function parseCliHelpFlags(helpText: string): string[] {
  if (!helpText || typeof helpText !== 'string') return [];
  const flags = new Set<string>();
  for (const match of helpText.matchAll(/(^|[\s,])(--?[a-zA-Z][a-zA-Z0-9-]*)(?=[\s,=]|$)/gm)) {
    flags.add(match[2]);
  }
  return [...flags];
}

function runHelp(command: string): Promise<string | null> {
  assertExternalAiCliAllowed(command);
  return new Promise((resolve) => {
    const opts: { timeout: number; shell?: boolean; maxBuffer: number } = {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    };
    if (process.platform === 'win32') opts.shell = true;
    execFile(command, ['--help'], opts, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        resolve(null);
        return;
      }
      resolve((stdout || '') + '\n' + (stderr || ''));
    });
  });
}

async function probeViaHelp(command: string): Promise<ProbedModel[] | null> {
  assertExternalAiCliAllowed(command);
  try {
    const help = await runHelp(command);
    if (!help) return null;
    const parsed = parseHelpForModels(help);
    return parsed.length > 0 ? parsed : null;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Unexpected real CLI launch from test')) {
      throw err;
    }
    return null;
  }
}

// Allowed CLI option patterns (flags that are safe to pass through)
const ALLOWED_OPTION_PATTERN = /^--?[a-zA-Z][a-zA-Z0-9_-]*(?:=\S+)?$/;

// Dangerous shell characters that could enable injection
const DANGEROUS_CHARS = /[;&|`$(){}[\]<>!#~'"\\]/;

/**
 * Validate and sanitize extra CLI options from user input.
 * Only allows simple flags like --flag or --flag=value.
 */
export function sanitizeExtraOptions(extraOptions: string): string[] {
  if (!extraOptions || typeof extraOptions !== 'string') return [];

  const parts = extraOptions.split(/\s+/).filter(Boolean);
  const sanitized: string[] = [];

  for (const part of parts) {
    if (DANGEROUS_CHARS.test(part)) {
      console.warn(`Rejected dangerous CLI option: ${part}`);
      continue;
    }
    if (!ALLOWED_OPTION_PATTERN.test(part)) {
      console.warn(`Rejected invalid CLI option format: ${part}`);
      continue;
    }
    sanitized.push(part);
  }

  return sanitized;
}

export function resolveExecutionModel(
  model: string | undefined,
  cliTool: CliTool,
  failUnavailable = true,
  effort?: string,
): { requestedModel: string | null; effectiveModel: string | undefined; availability: 'available' | 'unavailable' | 'unknown' } {
  if (!model) return { requestedModel: null, effectiveModel: undefined, availability: 'unknown' };
  let entry: ReturnType<typeof getModelByValue>;
  try { entry = getModelByValue(cliTool, model); } catch { entry = undefined; }
  const availability = entry ? (entry.status === 'missing' ? 'unavailable' : 'available') : 'unknown';
  if (availability === 'unavailable' && failUnavailable) {
    throw new Error(`Selected ${cliTool} model "${model}" is unavailable. Choose another model or refresh the model catalog.`);
  }

  let effectiveModel = model;
  if (cliTool === 'antigravity' && entry?.provider_variants) {
    let variants: Record<string, string> = {};
    try { variants = JSON.parse(entry.provider_variants); } catch { variants = {}; }
    if (Object.keys(variants).length > 0) {
      if (!effort) {
        throw new Error(`Antigravity model "${model}" requires an explicit effort selection.`);
      }
      const mapped = variants[effort];
      if (!mapped) {
        throw new Error(`Effort "${effort}" is not supported for Antigravity model "${model}". Supported efforts: ${Object.keys(variants).join(', ')}.`);
      }
      effectiveModel = mapped;
    }
  }

  return { requestedModel: model, effectiveModel, availability };
}

function normalizeModel(model: string | undefined, cliTool: CliTool, effort?: string): string | undefined {
  if (!model) return undefined;
  return resolveExecutionModel(model, cliTool, true, effort).effectiveModel;
}

/**
 * A rule for auto-responding to a CLI's in-process prompt (trust dialog,
 * update notice, etc). Matched against PTY stdout after ANSI stripping.
 */
export interface AutoRespondRule {
  /** Label for logs */
  name: string;
  /** Regex to match the prompt in the stripped PTY output */
  pattern: RegExp;
  /** Exact string written to PTY in response (include trailing \r to submit) */
  response: string;
  /**
   * If true, defer initial-prompt delivery until this rule's pattern stops
   * matching AND the ready indicator appears. Use for trust dialogs that
   * steal stdin. Non-blocking rules (e.g. update prompts) get dismissed in
   * place without holding up the initial prompt.
   */
  blocksInitialPrompt?: boolean;
}

/**
 * Prompt policy for the trailing instruction block appended to a headless
 * CLI prompt.
 * - 'task-completion': coding-task workflow (default, backwards compatible).
 * - 'discussion': read-only deliberation; no coding/commit completion suffix.
 */
export type PromptPolicy = 'task-completion' | 'discussion';

export interface CliAdapter {
  /** Executable command name */
  command: string;
  /** Display name for logs */
  displayName: string;
  /** Whether this CLI supports long-lived interactive sessions */
  supportsInteractive?: boolean;
  /** Build the args array for spawning */
  buildArgs(opts: CliBuildOptions): string[];
  /** Known flags emitted by this adapter that must exist in the cached CLI help. */
  compatibilityFlags?: readonly string[];
  /** Whether this mode needs stdin pipe */
  needsStdin(mode: CliMode): boolean;
  /**
   * Format prompt for stdin delivery.
   *
   * `promptPolicy` selects the trailing instruction block appended to the
   * prompt. 'task-completion' (default) is the coding-task policy: work
   * efficiently, commit, stop. 'discussion' is for read-only deliberation
   * runs (e.g. AgentForum) where a commit/stop instruction contradicts the
   * caller's own output contract, so no suffix is appended.
   */
  formatStdinPrompt(prompt: string, mode?: CliMode, promptPolicy?: PromptPolicy): string;
  /** Whether this CLI requires a TTY (pseudo-terminal) to run */
  requiresTty?: boolean;
  /** Output format: 'stream-json' for structured JSON lines, 'text' for plain text */
  outputFormat?: 'text' | 'stream-json';
  /**
   * Defer writing the initial prompt to PTY stdin until the CLI's ready
   * indicator appears (or a fallback timeout elapses). Prevents the prompt
   * from being consumed by startup banners or trust dialogs.
   */
  delayStdinUntilReady?: boolean;
  /**
   * Regex that matches the CLI's "ready for input" state in stripped PTY
   * output. Used both to time initial-prompt delivery and to detect the
   * end of a blocking auto-respond rule (e.g. trust dialog dismissed).
   */
  readyIndicatorPattern?: RegExp;
  /** Ordered list of prompts to auto-respond to while the PTY runs */
  autoRespondRules?: AutoRespondRule[];
  /**
   * Byte sequence written to PTY stdin to submit a line of user input.
   * Replaces a trailing '\n' in writes going through the interactive relay
   * and the initial-prompt delivery. Default: '\r'. Some TUIs (e.g. Antigravity)
   * only treat '\r\n' as Enter; others need '\n'.
   */
  stdinSubmitSequence?: string;
  /**
   * Best-effort probe for currently supported models. Returns null when the
   * CLI is unreachable or its help output yields no recognizable model ids;
   * callers should fall back to the bundled registry.
   */
  probeModels?(): Promise<ProbedModel[] | null>;
}

const TASK_COMPLETION_SUFFIX = `

IMPORTANT: Work efficiently and stop when done.
- Use grep/glob to find target files. Do NOT read every file or use Explore agents for simple tasks.
- Only read files you need to modify. Make edits directly without re-reading.
- Once complete, commit all changes and stop. No additional refactoring, testing, or review.`;

const claudeAdapter: CliAdapter = {
  command: 'claude',
  displayName: 'Claude CLI',
  supportsInteractive: true,
  outputFormat: 'stream-json',
  delayStdinUntilReady: true,
  readyIndicatorPattern: /Welcome\s*back|›|>\s*$/,
  autoRespondRules: [
    {
      name: 'claude-trust',
      pattern: /Yes,\s*I\s*trust\s*this/i,
      response: '\r',
      blocksInitialPrompt: true,
    },
  ],
  buildArgs({ mode, prompt, model, effort, extraOptions, maxTurns, sandboxMode, continueSession }) {
    const normalizedModel = normalizeModel(model, 'claude');
    const args: string[] = [];
    if (sandboxMode === 'strict') {
      args.push('--permission-mode', 'dontAsk');
    } else {
      args.push('--dangerously-skip-permissions');
    }
    if (mode !== 'interactive') {
      args.push('--print', '--verbose', '--output-format', 'stream-json');
    }
    if (continueSession) args.push('--continue');
    if (normalizedModel) args.push('--model', normalizedModel);
    if (effort) args.push('--effort', effort);
    if (maxTurns && maxTurns > 0) args.push('--max-turns', String(maxTurns));
    if (extraOptions) {
      args.push(...sanitizeExtraOptions(extraOptions));
    }
    // Prompt is delivered via stdin pipe (avoids shell escaping issues with newlines)
    return args;
  },
  needsStdin(_mode) {
    return true;
  },
  formatStdinPrompt(prompt, mode, promptPolicy) {
    if (mode === 'interactive') return prompt + '\n';
    if (promptPolicy === 'discussion') return prompt + '\n';
    return prompt + TASK_COMPLETION_SUFFIX + '\n';
  },
  probeModels() {
    return probeViaHelp('claude');
  },
};

const antigravityAdapter: CliAdapter = {
  command: 'agy',
  displayName: 'Antigravity CLI',
  supportsInteractive: true,
  delayStdinUntilReady: true,
  // Antigravity's TUI uses CRLF to submit interactive input.
  stdinSubmitSequence: '\r\n',
  // Welcome/ready tokens plus generic cursor glyphs used across releases.
  readyIndicatorPattern: /Type your message|Shortcuts|ctrl\+y|›|>\s*$/i,
  autoRespondRules: [
    {
      name: 'antigravity-trust-folder',
      // First-run folder trust dialog. Option 1 = trust current dir.
      pattern: /Do you trust the files in this folder\?|Trust folder/i,
      response: '1\r',
      blocksInitialPrompt: true,
    },
    {
      // Decline updates to avoid unexpected CLI changes mid-session.
      name: 'antigravity-update-prompt',
      pattern: /update available.*\(y\/n\)|install.*new.*version.*\?/i,
      response: 'n\r',
    },
  ],
  compatibilityFlags: [
    '--print', '--input-format', '--output-format', '--sandbox',
    '--dangerously-skip-permissions', '--continue', '--model', '--effort',
  ],
  buildArgs({ mode, model, effort, extraOptions, sandboxMode, continueSession }) {
    // Antigravity CLI (`agy`):
    //   --print selects the official non-interactive mode. With text input, the
    //   prompt is read from stdin when it is not present on the command line.
    //   --sandbox enables terminal restrictions; permissive execution explicitly
    //   opts into auto-approved tool actions.
    //   --continue resumes the most recent conversation.
    const normalizedModel = normalizeModel(model, 'antigravity', effort);
    const args: string[] = [];
    if (sandboxMode === 'strict') args.push('--sandbox');
    else args.push('--dangerously-skip-permissions');
    if (mode !== 'interactive') {
      args.push('--print', '--input-format', 'text', '--output-format', 'text');
    }
    if (continueSession) args.push('--continue');
    if (normalizedModel) args.push('--model', normalizedModel);
    if (effort) {
      let entry: ReturnType<typeof getModelByValue>;
      try { entry = model ? getModelByValue('antigravity', model) : undefined; } catch { entry = undefined; }
      const hasVariants = !!entry?.provider_variants && Object.keys(JSON.parse(entry.provider_variants || '{}')).length > 0;
      const isConcreteVariantSlug = !!model && /-(low|medium|high)$/i.test(model);
      if (!hasVariants && !isConcreteVariantSlug) {
        args.push('--effort', effort);
      }
    }
    if (extraOptions) {
      args.push(...sanitizeExtraOptions(extraOptions));
    }
    return args;
  },
  needsStdin(_mode) {
    return true;
  },
  formatStdinPrompt(prompt) {
    return prompt + '\n';
  },
  probeModels() {
    return probeViaHelp('agy');
  },
};

const codexAdapter: CliAdapter = {
  command: 'codex',
  displayName: 'Codex CLI',
  supportsInteractive: true,
  delayStdinUntilReady: true,
  // Typical Codex TUI input-cursor glyphs. 5s fallback in claude-manager handles miss.
  readyIndicatorPattern: /▍|›|>\s*$/,
  // No auto-respond rules yet — add once real startup/update prompts are captured.
  autoRespondRules: [],
  compatibilityFlags: [
    '--skip-git-repo-check', '--sandbox', '--approve-for-me',
    '--dangerously-bypass-approvals-and-sandbox', '--add-dir', '--model', '--last', '-c',
  ],
  buildArgs({ mode, model, effort, extraOptions, workDir, projectPath, sandboxMode, continueSession, promptPolicy }) {
    const normalizedModel = normalizeModel(model, 'codex');
    const args: string[] = [];
    if (mode !== 'interactive') {
      args.push('exec');
      // codex exec aborts in a non-trusted / non-git dir unless this is set;
      // worktrees & untrusted project paths can't show the interactive trust prompt.
      args.push('--skip-git-repo-check');
    }
    if (sandboxMode === 'strict') {
      // AgentForum is deliberation-only and must not grant write access. Normal
      // task execution keeps the existing workspace-write/automatic-approval policy.
      if (promptPolicy === 'discussion') {
        args.push('--sandbox', 'read-only');
      } else {
        args.push('--sandbox', 'workspace-write', '--approve-for-me');
      }
      if (promptPolicy !== 'discussion' && workDir && projectPath && workDir !== projectPath) {
        const gitDir = path.join(projectPath, '.git');
        args.push('--add-dir', gitDir);
      }
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (normalizedModel) args.push('--model', normalizedModel);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (extraOptions) {
      args.push(...sanitizeExtraOptions(extraOptions));
    }
    if (mode !== 'interactive' && continueSession) {
      // Exec-level sandbox/approval flags must precede the resume subcommand.
      // A literal '-' makes stdin prompt delivery explicit for resume mode.
      args.push('resume', '--last', '-');
    }
    return args;
  },
  needsStdin(_mode) {
    return true;
  },
  formatStdinPrompt(prompt) {
    return prompt + '\n';
  },
  probeModels() {
    return probeViaHelp('codex');
  },
};

// Raw OS shell session. No AI CLI involved — spawns the platform's default
// interactive shell so the session window doubles as a regular terminal.
// Initial prompt / memory injection / sandbox / --continue are all bypassed
// by session-manager when the tool is raw-shell.
function detectRawShellCommand(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'powershell.exe', args: ['-NoLogo'] };
  }
  const sh = process.env.SHELL || '/bin/bash';
  return { command: sh, args: ['-i'] };
}

const rawShellInfo = detectRawShellCommand();

// Friendly name of the shell raw-shell actually spawns, for the UI dropdown
// (e.g. "Raw Shell (PowerShell)"). Derived from the resolved command basename.
export function getRawShellInfo(): { command: string; args: string[]; name: string } {
  const base = rawShellInfo.command.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
  const PRETTY: Record<string, string> = {
    powershell: 'PowerShell',
    pwsh: 'PowerShell 7',
    cmd: 'Command Prompt',
    bash: 'bash',
    zsh: 'zsh',
    fish: 'fish',
    sh: 'sh',
  };
  return { ...rawShellInfo, name: PRETTY[base] ?? base };
}

const rawShellAdapter: CliAdapter = {
  command: rawShellInfo.command,
  displayName: 'Raw Shell',
  supportsInteractive: true,
  requiresTty: true,
  outputFormat: 'text',
  delayStdinUntilReady: false,
  stdinSubmitSequence: '\r',
  buildArgs() {
    return [...rawShellInfo.args];
  },
  needsStdin() {
    return true;
  },
  formatStdinPrompt() {
    return '';
  },
};

const adapters: Record<CliTool, CliAdapter> = {
  claude: claudeAdapter,
  antigravity: antigravityAdapter,
  codex: codexAdapter,
  'raw-shell': rawShellAdapter,
};

export function getAdapter(tool: CliTool): CliAdapter {
  return adapters[tool] ?? adapters.claude;
}

export function supportsInteractiveMode(tool: CliTool): boolean {
  return !!getAdapter(tool).supportsInteractive;
}
