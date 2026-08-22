import { EyeOff, Eye, MousePointerClick, GitBranch } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';

interface Props {
  saving: boolean;
  onIgnoreAll: () => void;
  onShowAll: () => void;
}

// First-visit gate for the Vault tab. Large projects choke on the initial
// scan + force-directed graph, so before anything renders we offer to start
// from an "ignore everything" .vaultignore and teach the unhide flow.
// Rendering begins only after a choice; the choice is remembered per project
// (vault:onboarded:<projectId>) and a pre-existing .vaultignore skips this
// entirely.
export function VaultOnboardingModal({ saving, onIgnoreAll, onShowAll }: Props) {
  const { t } = useI18n();
  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50">
      <div className="bg-[var(--color-bg-card)] border border-warm-200 rounded-lg shadow-elevated w-[min(560px,90vw)] max-h-[85vh] overflow-y-auto flex flex-col">
        <div className="px-5 py-4 border-b border-warm-200">
          <div className="text-sm font-semibold text-warm-800">{t('vault.onboarding.title')}</div>
          <p className="mt-1.5 text-xs text-warm-500 leading-relaxed">
            {t('vault.onboarding.introPart1')}
            <code className="text-warm-700">.md</code>/<code className="text-warm-700">.html</code>
            {t('vault.onboarding.introPart2')}
            <code className="text-warm-700">[[wikilink]]</code>
            {t('vault.onboarding.introPart3')}
            <code className="text-warm-700">.vaultignore</code>
            {t('vault.onboarding.introPart5')}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3 text-xs text-warm-600">
          <div className="flex items-start gap-2.5">
            <EyeOff className="w-4 h-4 mt-0.5 text-warm-400 flex-shrink-0" />
            <p className="leading-relaxed">
              <span className="font-semibold text-warm-700">{t('vault.onboarding.step1Heading')}</span> —{' '}
              <code className="text-warm-700">.vaultignore</code>
              {t('vault.onboarding.step1Mid')}
              <code className="text-warm-700">*</code>
              {t('vault.onboarding.step1After')}
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <MousePointerClick className="w-4 h-4 mt-0.5 text-warm-400 flex-shrink-0" />
            <p className="leading-relaxed">
              <span className="font-semibold text-warm-700">{t('vault.onboarding.step2Heading')}</span> —{' '}
              {t('vault.onboarding.step2Body1')}
              <span className="font-semibold text-warm-700">"{t('vault.onboarding.step2Quoted')}"</span>
              {t('vault.onboarding.step2Body2')}
              <Eye className="w-3 h-3 inline" />
              {t('vault.onboarding.step2Body3')}
            </p>
          </div>
          <div className="flex items-start gap-2.5">
            <GitBranch className="w-4 h-4 mt-0.5 text-warm-400 flex-shrink-0" />
            <p className="leading-relaxed">
              <span className="font-semibold text-warm-700">{t('vault.onboarding.step3Heading')}</span> —{' '}
              {t('vault.onboarding.step3Body1')}
              <code className="text-warm-700">.vaultignore</code>
              {t('vault.onboarding.step3Body2')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 px-5 py-4 border-t border-warm-200">
          <button
            type="button"
            onClick={onIgnoreAll}
            disabled={saving}
            className="w-full px-3 py-2.5 rounded-md text-xs font-semibold bg-accent text-white hover:bg-accent-dark disabled:opacity-50"
          >
            {saving ? t('vault.onboarding.saving') : t('vault.onboarding.startHidden')}
          </button>
          <button
            type="button"
            onClick={onShowAll}
            disabled={saving}
            className="w-full px-3 py-2 rounded-md text-xs text-warm-600 hover:bg-warm-200 disabled:opacity-50"
          >
            {t('vault.onboarding.startAll')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
