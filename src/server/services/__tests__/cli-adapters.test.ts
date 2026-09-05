import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('../../db/queries.js', () => ({ getModelByValue: () => undefined }));

import { getAdapter, supportsInteractiveMode, parseCliHelpFlags, parseHelpForModels } from '../cli-adapters.js';

const agyHelp = readFileSync(new URL('./fixtures/agy-1.1.20-help.txt', import.meta.url), 'utf8');
const codexExecHelp = readFileSync(new URL('./fixtures/codex-0.150.0-exec-help.txt', import.meta.url), 'utf8');

describe('cli-adapters', () => {
  it('uses non-interactive exec mode for Codex', () => {
    const adapter = getAdapter('codex');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Fix the login disclaimer',
      model: 'o3',
      extraOptions: '--color=never',
    });

    expect(adapter.requiresTty).toBeUndefined();
    expect(args).toEqual(['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'o3', '--color=never']);
  });

  it('does not skip Antigravity permissions in strict mode', () => {
    const adapter = getAdapter('antigravity');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Fix the login disclaimer',
      sandboxMode: 'strict',
    });

    expect(args).toEqual(['--sandbox', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    expect(args).not.toContain('--headless');
    expect(args).not.toContain('--print');
    expect(args).not.toContain('-p');
    expect(args).not.toContain('Fix the login disclaimer');
  });

  it('skips Antigravity permissions in permissive mode', () => {
    const adapter = getAdapter('antigravity');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Fix the login disclaimer',
      sandboxMode: 'permissive',
    });

    expect(args).toEqual(['--dangerously-skip-permissions', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    expect(args).not.toContain('--headless');
  });

  it('uses --continue for Antigravity when continuing a session', () => {
    const adapter = getAdapter('antigravity');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Follow up',
      sandboxMode: 'permissive',
      continueSession: true,
    });

    expect(args).toEqual(['--dangerously-skip-permissions', '--input-format', 'stream-json', '--output-format', 'stream-json', '--continue']);
  });

  it('omits exec subcommand for Codex in interactive mode', () => {
    const adapter = getAdapter('codex');
    const args = adapter.buildArgs({
      mode: 'interactive',
      prompt: '',
      model: 'o3',
      sandboxMode: 'permissive',
    });

    expect(args).not.toContain('exec');
    expect(args).toEqual(['--dangerously-bypass-approvals-and-sandbox', '--model', 'o3']);
  });

  it('uses exec resume --last for Codex when continuing a session', () => {
    const adapter = getAdapter('codex');
    const args = adapter.buildArgs({
      mode: 'headless',
      prompt: 'Follow up',
      model: 'o3',
      continueSession: true,
    });

    expect(args).toEqual(['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', 'o3', 'resume', '--last', '-']);
  });

  it('sends Codex prompts over stdin', () => {
    const adapter = getAdapter('codex');

    expect(adapter.needsStdin('headless')).toBe(true);
    expect(adapter.formatStdinPrompt('hello')).toBe('hello\n');
  });

  it('translates resolved effort for each CLI without touching global config', () => {
    expect(getAdapter('claude').buildArgs({ mode: 'headless', prompt: '', effort: 'high' })).toContain('high');
    expect(getAdapter('antigravity').buildArgs({ mode: 'headless', prompt: '', effort: 'medium', sandboxMode: 'strict' })).toEqual(['--sandbox', '--input-format', 'stream-json', '--output-format', 'stream-json', '--effort', 'medium']);
    expect(getAdapter('codex').buildArgs({ mode: 'headless', prompt: '', effort: 'xhigh' })).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort="xhigh"']));
  });

  it('builds current strict Codex task execution without --full-auto', () => {
    const args = getAdapter('codex').buildArgs({
      mode: 'headless',
      prompt: 'Implement the fix',
      model: 'o3',
      effort: 'high',
      sandboxMode: 'strict',
    });

    expect(args).toEqual([
      'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--approve-for-me',
      '--model', 'o3', '-c', 'model_reasoning_effort="high"',
    ]);
    expect(args).not.toContain('--full-auto');
  });

  it('builds read-only AgentForum headless args for Codex', () => {
    const args = getAdapter('codex').buildArgs({
      mode: 'headless',
      prompt: 'Discuss the design',
      model: 'o3',
      effort: 'medium',
      sandboxMode: 'strict',
      promptPolicy: 'discussion',
      workDir: 'scratch',
      projectPath: 'project',
    });

    expect(args).toEqual([
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'o3',
      '-c', 'model_reasoning_effort="medium"',
    ]);
    expect(args).not.toContain('--approve-for-me');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--full-auto');
  });

  it('uses execution-local Claude permissions without touching project settings', () => {
    const adapter = getAdapter('claude');
    const args = adapter.buildArgs({
      mode: 'headless', prompt: 'Implement', sandboxMode: 'strict',
      promptPolicy: 'implementation', workDir: 'C:\\tmp\\task',
    });
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read(C:/tmp/task/**)');
    expect(args).toContain('Edit(C:/tmp/task/**)');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('makes review intent read-only and omits the task-completion suffix', () => {
    const claude = getAdapter('claude');
    const claudeArgs = claude.buildArgs({
      mode: 'headless', prompt: 'Review', sandboxMode: 'strict', promptPolicy: 'review',
    });
    expect(claudeArgs).toContain('plan');
    expect(claudeArgs).toContain('--disallowedTools');
    expect(claudeArgs).toContain('Edit');
    expect(claude.formatStdinPrompt('Review only', 'headless', 'review').toLowerCase()).not.toContain('commit all changes');
    expect(claude.formatStdinPrompt('Implement', 'headless', 'implementation').toLowerCase()).toContain('commit all changes');

    const codexArgs = getAdapter('codex').buildArgs({
      mode: 'headless', prompt: 'Review', sandboxMode: 'strict', promptPolicy: 'review',
    });
    expect(codexArgs).toContain('read-only');
    expect(codexArgs).not.toContain('--approve-for-me');
  });

  it('matches generated headless flags against current CLI help fixtures', () => {
    const fixtures = [
      {
        adapter: getAdapter('antigravity'),
        help: agyHelp,
        args: getAdapter('antigravity').buildArgs({
          mode: 'headless', prompt: '', model: 'gemini-current', effort: 'high',
          sandboxMode: 'permissive', continueSession: true,
        }),
      },
      {
        adapter: getAdapter('codex'),
        help: codexExecHelp,
        args: getAdapter('codex').buildArgs({
          mode: 'headless', prompt: '', model: 'o3', effort: 'high', sandboxMode: 'strict',
        }),
      },
    ];

    for (const { adapter, help, args } of fixtures) {
      const supported = new Set(parseCliHelpFlags(help));
      const emitted = (adapter.compatibilityFlags ?? []).filter((flag) => args.includes(flag));
      expect(emitted.filter((flag) => !supported.has(flag))).toEqual([]);
    }
  });

  it('prevents the semantically invalid --print --input-format combination', () => {
    const args = getAdapter('antigravity').buildArgs({
      mode: 'headless', prompt: 'never place this prompt in argv', sandboxMode: 'strict',
    });
    const printIndex = args.findIndex((arg) => arg === '--print' || arg === '-p' || arg === '--prompt');
    const inputIndex = args.indexOf('--input-format');

    expect(printIndex).toBe(-1);
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(args).not.toContain('never place this prompt in argv');
  });

  it('enables interactive mode for all CLI tools', () => {
    expect(supportsInteractiveMode('claude')).toBe(true);
    expect(supportsInteractiveMode('antigravity')).toBe(true);
    expect(supportsInteractiveMode('codex')).toBe(true);
  });

  describe('parseHelpForModels', () => {
    it('extracts claude model ids from help with --model flag', () => {
      const help = [
        'Usage: claude [options]',
        '',
        'Options:',
        '  --model <name>      Model to use',
        '                      Choices: claude-opus-4-7, claude-sonnet-4-6,',
        '                      claude-haiku-4-5',
      ].join('\n');
      const models = parseHelpForModels(help);
      const values = models.map((m) => m.value).sort();
      expect(values).toEqual(['claude-haiku-4-5', 'claude-opus-4-7', 'claude-sonnet-4-6']);
    });

    it('extracts codex model ids with mixed formats', () => {
      const help = [
        'codex exec [options]',
        '  --model   <name>  e.g. gpt-4.1, gpt-4.1-mini, o3, o4-mini',
      ].join('\n');
      const models = parseHelpForModels(help);
      const values = models.map((m) => m.value).sort();
      expect(values).toContain('gpt-4.1');
      expect(values).toContain('gpt-4.1-mini');
      expect(values).toContain('o3');
      expect(values).toContain('o4-mini');
    });

    it('returns empty when --model flag is absent', () => {
      const help = 'Usage: foo [options]\n  --color <when>  Colorize output';
      expect(parseHelpForModels(help)).toEqual([]);
    });

    it('returns empty for non-string input', () => {
      expect(parseHelpForModels('')).toEqual([]);
      // @ts-expect-error intentional
      expect(parseHelpForModels(null)).toEqual([]);
    });

    it('deduplicates repeated ids', () => {
      const help = '--model  gpt-4.1 / gpt-4.1 / gpt-4.1';
      const models = parseHelpForModels(help);
      expect(models.length).toBe(1);
      expect(models[0].value).toBe('gpt-4.1');
    });
  });
});
