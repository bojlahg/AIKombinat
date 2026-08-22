import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { getPluginTranslations } from '../plugins/registry';
import { en } from './en';
import { ko } from './ko';
import { ru } from './ru';
import type { Lang, TranslationKey } from './types';

export type { Lang, TranslationKey } from './types';

const translations: Record<Lang, Record<string, string>> = { en, ko, ru };

const LANG_STORAGE_KEY = 'clitrigger-lang';

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'ko' || value === 'ru';
}

export function detectDefaultLang(): Lang {
  const saved = localStorage.getItem(LANG_STORAGE_KEY);
  if (isLang(saved)) return saved;

  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  const lower = nav.toLowerCase();
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('ko')) return 'ko';
  return 'en';
}

interface I18nContextType {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectDefaultLang);

  const setLang = useCallback((next: Lang) => {
    localStorage.setItem(LANG_STORAGE_KEY, next);
    setLangState(next);
  }, []);

  const pluginT = useMemo(() => getPluginTranslations(), []);

  const t = useCallback(
    (key: string): string => {
      return (
        translations[lang][key] ??
        translations.en[key] ??
        pluginT[lang]?.[key] ??
        pluginT.en[key] ??
        key
      );
    },
    [lang, pluginT]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
