import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/en';
import { ko } from '../../i18n/ko';
import { ru } from '../../i18n/ru';

type LocaleName = 'en' | 'ko' | 'ru';
type Locale = Record<string, string>;

const locales: Record<LocaleName, Locale> = { en, ko, ru };
const localeNames: LocaleName[] = ['en', 'ko', 'ru'];

function sortedKeys(locale: Locale): string[] {
  return Object.keys(locale).sort();
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((key) => !rightSet.has(key)).sort();
}

function placeholders(value: string): string[] {
  return [...new Set(value.match(/\{[A-Za-z_][A-Za-z0-9_.-]*\}/g) ?? [])].sort();
}

function formatList(values: string[]): string {
  return values.length === 0 ? '[]' : `[${values.join(', ')}]`;
}

describe('core i18n structural parity', () => {
  it('keeps EN, KO, and RU keys and placeholders identical', () => {
    const keys = Object.fromEntries(
      localeNames.map((name) => [name, sortedKeys(locales[name])])
    ) as Record<LocaleName, string[]>;
    const canonicalKeys = keys.en;
    const missing = Object.fromEntries(
      localeNames.map((name) => [name, difference(canonicalKeys, keys[name])])
    ) as Record<LocaleName, string[]>;
    const extra = Object.fromEntries(
      localeNames.map((name) => [name, difference(keys[name], canonicalKeys)])
    ) as Record<LocaleName, string[]>;
    const placeholderMismatches: string[] = [];

    for (const name of ['ko', 'ru'] as const) {
      for (const key of canonicalKeys) {
        if (!(key in locales[name])) continue;
        const expected = placeholders(en[key as keyof typeof en]);
        const actual = placeholders(locales[name][key]);
        if (expected.join('\0') !== actual.join('\0')) {
          placeholderMismatches.push(
            `${name}.${key}: expected ${formatList(expected)}, got ${formatList(actual)}`
          );
        }
      }
    }
    placeholderMismatches.sort();

    const hasMismatch = localeNames.some(
      (name) => missing[name].length > 0 || extra[name].length > 0
    ) || placeholderMismatches.length > 0;

    const report = [
      'Core i18n parity failed (English is canonical).',
      `key counts: en=${keys.en.length}, ko=${keys.ko.length}, ru=${keys.ru.length}`,
      'missing keys:',
      ...localeNames.map((name) => `  ${name}: ${formatList(missing[name])}`),
      'extra keys:',
      ...localeNames.map((name) => `  ${name}: ${formatList(extra[name])}`),
      'placeholder mismatches:',
      ...(placeholderMismatches.length > 0
        ? placeholderMismatches.map((mismatch) => `  ${mismatch}`)
        : ['  []']),
    ].join('\n');

    expect(hasMismatch, report).toBe(false);
  });

  it('does not leave required translations empty', () => {
    const empty: string[] = [];
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      if (en[key].trim() === '') continue;
      if (ko[key].trim() === '') empty.push(`ko.${key}`);
      if (ru[key].trim() === '') empty.push(`ru.${key}`);
    }
    expect(empty.sort()).toEqual([]);
  });
});
