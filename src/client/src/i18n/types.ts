import type { en } from './en';

export type Lang = 'en' | 'ko' | 'ru';

export type TranslationKey = keyof typeof en;
