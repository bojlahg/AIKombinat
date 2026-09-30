import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CliDecodedOutput, CliOutputDecoder, PromptPolicy } from './cli-adapters.js';

export const OPEN_CODE_MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_./:+-]*(?:#[a-zA-Z0-9_.-]+)?$/;

export function assertManagedOpenCodeShell(command: unknown): void {
  if (typeof command !== 'string' || command.length > 8192 || /[><|&;`$\r\n\0]/.test(command)) {
    throw new Error('Managed OpenCode rejects shell redirection, composition and substitution');
  }
}

export const OPEN_CODE_SHELL_GUARD = `export const AIKombinatShellGuard = async () => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool === 'bash' && (typeof output.args.command !== 'string' || output.args.command.length > 8192 || /[><|&;\\x60$\\r\\n\\0]/.test(output.args.command))) {
      throw new Error('Managed OpenCode rejects shell redirection, composition and substitution');
    }
  }
});`;

export function openCodePolicy(review: boolean) {
  const bash: Record<string, 'allow' | 'deny'> = { '*': 'deny' };
  const commands = review
    ? ['git status', 'git status --short', 'git diff --no-ext-diff --no-textconv', 'git diff --no-ext-diff --no-textconv --stat']
    : ['git status', 'git status --short', 'git diff --no-ext-diff --no-textconv', 'git diff --no-ext-diff --no-textconv --stat',
      'git log --oneline -10', 'git ls-files', 'git rev-parse HEAD', 'git add *', 'git commit *',
      'npm test', 'npm run test', 'npm run test:server', 'npm run test:client', 'npm run build', 'npm run build:server', 'npm run build:client',
      'npm run typecheck', 'npm run typecheck:server', 'npm run typecheck:client', 'npx vitest run', 'npx vitest run *'];
  for (const command of commands) bash[command] = 'allow';
  for (const command of ['git push *', 'git reset *', 'git clean *', 'git checkout *', 'git restore *']) bash[command] = 'deny';
  for (const construct of ['>', '|', '&', ';', '`', '$', '\n', '\r']) bash[`*${construct}*`] = 'deny';
  const sensitive = ['*.env', '*.env.*', '**/.env', '**/.env.*', '**/.git/**', '.git/**',
    '**/.aws/**', '**/.ssh/**', '**/credentials*', '**/secrets/**', '../*'];
  const read: Record<string, 'allow' | 'deny'> = { '*': 'allow' };
  const edit: Record<string, 'allow' | 'deny'> = { '*': review ? 'deny' : 'allow' };
  for (const pattern of sensitive) { read[pattern] = 'deny'; edit[pattern] = 'deny'; }
  return { '*': 'deny', read, glob: 'allow', grep: 'allow', edit, bash,
    external_directory: 'deny', task: 'deny', question: 'deny', plan_enter: 'deny', plan_exit: 'deny' };
}

export function createOpenCodeConfig(policy?: PromptPolicy) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aikombinat-opencode-'));
  const pluginPath = path.join(directory, 'shell-guard.mjs');
  const config = {
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    plugin: [pathToFileURL(pluginPath).href],
    permission: { '*': 'deny' },
    agent: {
      'aikombinat-build': { description: 'AIKombinat implementation and rework', mode: 'primary',
        permission: openCodePolicy(false) },
      'aikombinat-review': { description: 'AIKombinat read-only review', mode: 'primary',
        permission: openCodePolicy(true) },
    },
    default_agent: policy === 'review' || policy === 'discussion' ? 'aikombinat-review' : 'aikombinat-build',
  };
  const content = JSON.stringify(config);
  try {
    fs.writeFileSync(pluginPath, OPEN_CODE_SHELL_GUARD, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'opencode.json'), content, { mode: 0o600 });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, env: { OPENCODE_CONFIG_CONTENT: content },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

export class OpenCodeOutputDecoder implements CliOutputDecoder {
  private buffer = '';
  private text = new Map<string, string>();
  private anonymous: string[] = [];
  private failed = false;
  private diagnostic = '';
  private inputTokens?: number;
  private outputTokens?: number;

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.fail('OpenCode transport/decode failure: oversized JSON event');
      this.buffer = '';
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.consume(line);
    }
  }

  private fail(message: string): void {
    this.failed = true;
    this.diagnostic = message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/(api[_-]?key|token|password)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(-1000);
  }

  private consume(line: string): void {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        this.fail('OpenCode transport/decode failure: invalid event'); return;
      }
      if (event.type === 'error') {
        this.fail(`OpenCode runtime/provider error: ${event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? 'unknown error'}`);
      } else if (event.type === 'text' && typeof event.part?.text === 'string' && !event.part.synthetic && !event.part.ignored) {
        if (typeof event.part.id === 'string') this.text.set(event.part.id, event.part.text);
        else this.anonymous.push(event.part.text);
      } else if (event.type === 'step_finish') {
        const tokens = event.part?.tokens;
        if (Number.isFinite(tokens?.input) && tokens.input >= 0) this.inputTokens = (this.inputTokens ?? 0) + tokens.input;
        if (Number.isFinite(tokens?.output) && tokens.output >= 0) this.outputTokens = (this.outputTokens ?? 0) + tokens.output;
      }
    } catch { this.fail('OpenCode transport/decode failure: malformed JSON stream'); }
  }

  finish(exitCode: number): CliDecodedOutput {
    if (this.buffer.trim()) this.consume(this.buffer.trim());
    this.buffer = '';
    const output = [...this.text.values(), ...this.anonymous].filter((text) => text.trim()).join('\n');
    if (exitCode === 0 && !output && !this.failed) this.fail('OpenCode empty-success anomaly: no assistant result');
    return { output, exitCode: this.failed && exitCode === 0 ? 1 : exitCode,
      diagnostic: this.diagnostic || undefined, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}
