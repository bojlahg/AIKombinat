import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectDefaultLang } from '../../i18n';

function setNavigatorLanguage(value: string) {
  Object.defineProperty(window.navigator, 'language', { value, configurable: true });
}

describe('detectDefaultLang', () => {
  const originalLanguage = window.navigator.language;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    setNavigatorLanguage(originalLanguage);
    localStorage.clear();
  });

  it('prefers a previously saved valid language over navigator.language', () => {
    localStorage.setItem('aikombinat-lang', 'ko');
    setNavigatorLanguage('ru-RU');
    expect(detectDefaultLang()).toBe('ko');
  });

  it('falls back to legacy clitrigger-lang when aikombinat-lang is not set', () => {
    localStorage.setItem('clitrigger-lang', 'ru');
    setNavigatorLanguage('ko-KR');
    expect(detectDefaultLang()).toBe('ru');
  });

  it('ignores an invalid/obsolete saved value and falls through to detection', () => {
    localStorage.setItem('aikombinat-lang', 'fr');
    setNavigatorLanguage('en-US');
    expect(detectDefaultLang()).toBe('en');
  });

  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['ko', 'ko'],
    ['ko-KR', 'ko'],
    ['en-US', 'en'],
    ['fr-FR', 'en'],
    ['de', 'en'],
  ])('navigator.language=%s -> %s when nothing is saved', (navLang, expected) => {
    setNavigatorLanguage(navLang);
    expect(detectDefaultLang()).toBe(expected);
  });
});
