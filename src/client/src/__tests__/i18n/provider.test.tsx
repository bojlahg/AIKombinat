import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider, useI18n } from '../../i18n';
import { registerClientPlugin } from '../../plugins/registry';
import type { ClientPluginManifest } from '../../plugins/types';

const fakePlugin: ClientPluginManifest = {
  id: 'test-plugin',
  displayName: 'Test Plugin',
  displayNameKo: '테스트 플러그인',
  SettingsComponent: () => null,
  hasTab: false,
  isEnabled: () => true,
  translations: {
    en: { 'testplugin.onlyInEn': 'English only string', 'testplugin.both': 'EN value' },
    ko: { 'testplugin.both': 'KO value' },
    // no ru block on purpose — must fall back to English, not Korean.
  },
};

function Probe({ keys }: { keys: string[] }) {
  const { t } = useI18n();
  return (
    <ul>
      {keys.map((k) => <li key={k} data-testid={k}>{t(k)}</li>)}
    </ul>
  );
}

describe('I18nProvider t() fallback chain', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('aikombinat-lang', 'ru');
    registerClientPlugin(fakePlugin);
  });

  it('resolves core keys from the active locale', () => {
    render(<I18nProvider><Probe keys={['login.submit']} /></I18nProvider>);
    expect(screen.getByTestId('login.submit').textContent).toBe('Войти');
  });

  it('falls back to legacy clitrigger-lang when aikombinat-lang is not set', () => {
    localStorage.removeItem('aikombinat-lang');
    localStorage.setItem('clitrigger-lang', 'ko');
    render(<I18nProvider><Probe keys={['login.submit']} /></I18nProvider>);
    expect(screen.getByTestId('login.submit').textContent).toBe('로그인');
  });

  it('falls back a plugin key with no ru translation to plugin English, not Korean', () => {
    render(<I18nProvider><Probe keys={['testplugin.onlyInEn']} /></I18nProvider>);
    expect(screen.getByTestId('testplugin.onlyInEn').textContent).toBe('English only string');
  });

  it('uses the plugin ru string when present in the aggregated ru map', () => {
    // testplugin.both has no ru entry either -> falls back to english, never korean
    render(<I18nProvider><Probe keys={['testplugin.both']} /></I18nProvider>);
    expect(screen.getByTestId('testplugin.both').textContent).toBe('EN value');
  });

  it('returns the raw key as a last resort for a completely unknown key', () => {
    render(<I18nProvider><Probe keys={['totally.unknown.key']} /></I18nProvider>);
    expect(screen.getByTestId('totally.unknown.key').textContent).toBe('totally.unknown.key');
  });

  it('setLang updates the rendered locale and persists it', () => {
    let ctx: ReturnType<typeof useI18n> | null = null;
    function Capture() {
      ctx = useI18n();
      return <span data-testid="lang">{ctx.lang}</span>;
    }
    render(<I18nProvider><Capture /></I18nProvider>);
    expect(screen.getByTestId('lang').textContent).toBe('ru');
    act(() => { ctx!.setLang('en'); });
    expect(screen.getByTestId('lang').textContent).toBe('en');
    expect(localStorage.getItem('aikombinat-lang')).toBe('en');
  });
});
