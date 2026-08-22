import { describe, it, expect } from 'vitest';
import { en } from '../../i18n/en';
import { ko } from '../../i18n/ko';
import { ru } from '../../i18n/ru';

function placeholders(value: string): string[] {
  return (value.match(/\{[a-zA-Z_]+\}/g) ?? []).sort();
}

describe('i18n key parity', () => {
  it('en/ko/ru declare exactly the same set of keys', () => {
    const enKeys = Object.keys(en).sort();
    expect(Object.keys(ko).sort()).toEqual(enKeys);
    expect(Object.keys(ru).sort()).toEqual(enKeys);
  });

  it('placeholders in each ko/ru value match the corresponding en value', () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      const enPlaceholders = placeholders(en[key]);
      const koPlaceholders = placeholders(ko[key]);
      const ruPlaceholders = placeholders(ru[key]);
      if (koPlaceholders.join(',') !== enPlaceholders.join(',')) {
        mismatches.push(`ko.${key}: expected [${enPlaceholders}] got [${koPlaceholders}]`);
      }
      if (ruPlaceholders.join(',') !== enPlaceholders.join(',')) {
        mismatches.push(`ru.${key}: expected [${enPlaceholders}] got [${ruPlaceholders}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('no translation value is empty unless the English source is also empty', () => {
    const empty: string[] = [];
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      if (en[key].trim() === '') continue;
      if (ko[key].trim() === '') empty.push(`ko.${key}`);
      if (ru[key].trim() === '') empty.push(`ru.${key}`);
    }
    expect(empty).toEqual([]);
  });
});
