import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/en';
import { ru } from '../../i18n/ru';
import { ko } from '../../i18n/ko';

const technicalKeys = new Set([
  'fabric.memoryGb', 'fabric.cpu', 'fabric.ram', 'fabric.telemetry',
  'login.title', 'agenda.source.jira', 'agenda.kind.jira', 'agenda.jira.baseUrlPlaceholder',
  'favorites.types.url', 'tunnel.name.placeholder', 'tunnel.hostname.placeholder',
  'catalog.cli', 'settings.tabs.mcp', 'header.cliInstallHint.claude',
  'header.cliInstallHint.antigravity', 'header.cliInstallHint.codex',
  'todo.worktree', 'cron.expression', 'tabs.git', 'tabs.svn', 'tabs.wiki',
  'header.svnTitle', 'web.urlPlaceholder', 'wiki.title', 'wiki.subTab.wiki',
  'git.pull', 'git.push', 'git.pushDialog.submit', 'git.fetch',
]);

const technicalTokens = new Set(`AIKombinat Git GitHub Jira API GPU CPU RAM VRAM SSH JSON CSV URL
OAuth MCP HTTP HTTPS WebSocket WSL SQLite Node Electron Python PowerShell Claude Codex OpenCode
Antigravity npm pnpm yarn bun curl Markdown JQL IME P50 P95 GiB Ctrl Shift Enter Esc HEAD SVN
Subversion Resource Fabric V2 raw-shell true false`.toLowerCase().split(/\s+/));
const ordinaryEnglish = new Set(`turn turns remote workspace scheduler lease leases graceful stop
checkpoint identity ownership capabilities capability system host hosts online offline scan alias config
worker fallback fallbacks history search effort headless passphrase keys`.split(/\s+/));

function englishProse(value: string): string[] {
  const prose = value
    .replace(/https?:\/\/[^\s<>"']+/gi, '')
    .replace(/`[^`]*`/g, '')
    .replace(/--[a-z][a-z-]*(?:=[\w.-]+)?/gi, '')
    .replace(/\{[^{}]+\}/g, '')
    .replace(/\b(?:npm|pnpm|yarn|bun|curl|git|aikombinat|cloudflared)\s+[\w./=:@*-]+(?:[ \t]+[-\w./=:@*]+)*/gi, '')
    .replace(/(?:\*\.)?[\w*-]+(?:[./\\][\w.*-]+)+/g, '')
    .replace(/\braw-shell\b/gi, '');
  return (prose.match(/[A-Za-z]+/g) ?? []).map(word => word.toLowerCase())
    .filter(word => !technicalTokens.has(word) && ordinaryEnglish.has(word));
}

describe('core locale English prose audit', () => {
  it.each([['ru', ru], ['ko', ko]] as const)('%s has no untranslated English outside explicit technical keys', (_, locale) => {
    const leaked = Object.entries(en).filter(([key, value]) =>
      locale[key as keyof typeof en] === value && /[A-Za-z]{3}/.test(value) && !technicalKeys.has(key)
    ).map(([key]) => key);
    expect(leaked).toEqual([]);
  });
  it('allows only existing explicit keys', () => {
    expect([...technicalKeys].filter(key => !(key in en))).toEqual([]);
  });
  it.each([['ru', ru], ['ko', ko]] as const)('%s has no mixed ordinary English prose', (_, locale) => {
    const leaked = Object.entries(locale).flatMap(([key, value]) => {
      const words = englishProse(value);
      return words.length ? [`${key}: ${words.join(', ')}`] : [];
    });
    expect(leaked).toEqual([]);
  });
  it('detects mixed prose while exempting explicit technical tokens, commands, paths, URLs and placeholders', () => {
    expect(englishProse('Лимит основных turns / Корень remote workspace / Capabilities неизвестны'))
      .toEqual(['turns', 'remote', 'workspace', 'capabilities']);
    expect(englishProse('원격 workspace 및 worker')).toEqual(['workspace', 'worker']);
    expect(englishProse('SSH GitHub WebSocket SQLite {workspace} https://host/remote *.trycloudflare.com .env/config /remote/workspace `stop worker` npm install worker; aikombinat reset-password; git init'))
      .toEqual([]);
  });
});
