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
});
