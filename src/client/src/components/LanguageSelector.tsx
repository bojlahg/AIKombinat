// Reusable language dropdown — replaces the old two-way EN/KO toggle now
// that a third language (ru) exists. Renders a compact code (EN/KO/RU) as
// the trigger and a portal-anchored menu of native language names below it.
import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useI18n, type Lang } from '../i18n';
import { AnchoredPopover } from './AnchoredPopover';
import { cn } from '../lib/cn';

const LANG_OPTIONS: Array<{ value: Lang; nativeName: string; code: string }> = [
  { value: 'en', nativeName: 'English', code: 'EN' },
  { value: 'ko', nativeName: '한국어', code: 'KO' },
  { value: 'ru', nativeName: 'Русский', code: 'RU' },
];

interface LanguageSelectorProps {
  className?: string;
}

export default function LanguageSelector({ className }: LanguageSelectorProps) {
  const { lang, setLang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = LANG_OPTIONS.find((o) => o.value === lang) ?? LANG_OPTIONS[0];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('lang.select')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('lang.select')}
        className={className}
      >
        {current.code}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={btnRef}
          width={160}
          onClose={() => setOpen(false)}
          flip
          className="z-tooltip"
          style={{
            background: 'var(--color-bg-elevated, #1f1f23)',
            border: '1px solid var(--color-border)',
            borderRadius: 10,
            padding: 4,
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}
        >
          <div role="menu">
            {LANG_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={opt.value === lang}
                onClick={() => { setLang(opt.value); setOpen(false); }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors',
                  opt.value === lang ? 'bg-accent/10 text-accent' : 'text-theme-text hover:bg-theme-bg-tertiary',
                )}
              >
                <span>{opt.nativeName}</span>
                {opt.value === lang && <Check size={14} />}
              </button>
            ))}
          </div>
        </AnchoredPopover>
      )}
    </>
  );
}
