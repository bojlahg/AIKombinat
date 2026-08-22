import { useI18n } from '../i18n';

interface EffortStarsProps {
  value: number;
  onChange: (value: 1 | 2 | 3 | 4 | 5) => void;
  disabled?: boolean;
}

export default function EffortStars({ value, onChange, disabled }: EffortStarsProps) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label={t('effort.label')}>
      {([1, 2, 3, 4, 5] as const).map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          aria-label={t('effort.level').replace('{level}', String(level))}
          title={t('effort.level').replace('{level}', String(level))}
          disabled={disabled}
          onClick={() => onChange(level)}
          className="text-xl leading-none transition-colors disabled:opacity-50"
          style={{ color: level <= value ? 'var(--color-accent)' : 'var(--color-border)' }}
        >
          ★
        </button>
      ))}
    </div>
  );
}
