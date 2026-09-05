import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import Modal from '../Modal';
import Button from '../Button';
import { getVaultIgnore, saveVaultIgnore } from '../../api/vault';
import { useI18n } from '../../i18n';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}

// Static usage guide behind the "?" button in the vault sidebar rail.
// Same modal shell as VaultIgnoreModal.
export function VaultIgnoreHelpModal({ open, onClose, onOpenEditor }: {
  open: boolean;
  onClose: () => void;
  onOpenEditor: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal open={open} onClose={onClose} size="xl">
      <div className="bg-theme-card border border-theme-border rounded-2xl shadow-elevated max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-warm-200">
          <div className="text-sm font-semibold text-warm-800">{t('vault.ignore.helpTitle')}</div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-warm-200 text-warm-500 hover:text-warm-800"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 text-xs text-warm-600 space-y-3 overflow-y-auto">
          <p>
            {t('vault.ignore.helpIntro1')}
            <code className="text-warm-800">.vaultignore</code>
            {t('vault.ignore.helpIntro2')}
            <code>*</code>, <code>**</code>, <code>!</code>
            {t('vault.ignore.helpIntro5')}
          </p>
          <pre className="rounded-md border border-warm-300 bg-[var(--color-bg-input)] text-warm-800 px-3 py-2 font-mono leading-relaxed">
{`*.draft.md        # ${t('vault.ignore.example.line1Comment')}
private/**        # ${t('vault.ignore.example.line2Comment')}
!private/keep.md  # ${t('vault.ignore.example.line3Comment')}
*                 # ${t('vault.ignore.example.line4Comment')}`}
          </pre>
          <ul className="list-disc pl-4 space-y-1">
            <li>
              <code className="text-warm-800">*</code>
              {t('vault.ignore.item1Part1')} "{t('vault.ignore.startHiddenLabel')}"{t('vault.ignore.item1Part2')}
              <span className="text-warm-800">"{t('vault.onboarding.step2Quoted')}"</span>
              {t('vault.ignore.item1Part3')}
            </li>
            <li>
              {t('vault.ignore.item2Part1')}
              <span className="text-warm-800">"{t('vault.ignore.hideLabel')}"</span>
              {t('vault.ignore.item2Part2')}
            </li>
            <li>
              <code className="text-warm-800">node_modules</code>, <code className="text-warm-800">.git</code>, <code className="text-warm-800">dist</code>
              {t('vault.ignore.item3After')}
            </li>
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-warm-200">
          <Button variant="ghost" size="sm" onClick={onOpenEditor}>
            {t('vault.ignore.editDirectly')}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            {t('vault.ignore.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function VaultIgnoreModal({ open, projectId, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeholder = `${t('vault.ignore.placeholderHeader')}\n${t('vault.ignore.placeholderExamples')}\n# *.draft.md\n# private/**\n# !private/keep.md\n# release-notes-*.md`;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    getVaultIgnore(projectId)
      .then((r) => setContent(r.content))
      .catch(() => setError(t('vault.ignore.loadError')))
      .finally(() => setLoading(false));
  }, [open, projectId, t]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveVaultIgnore(projectId, content);
      onSaved();
      onClose();
    } catch {
      setError(t('vault.ignore.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="xl">
      <div className="bg-theme-card border border-theme-border rounded-2xl shadow-elevated max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-warm-200">
          <div className="text-sm font-semibold text-warm-800">.vaultignore</div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-warm-200 text-warm-500 hover:text-warm-800"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 text-xs text-warm-600 border-b border-warm-200">
          {t('vault.ignore.desc1')}
          <code className="text-warm-800">.vaultignore</code>
          {t('vault.ignore.desc2')}
          <code>*</code>, <code>**</code>, <code>!</code>
          {t('vault.ignore.desc3')}
          <code className="text-warm-800">node_modules</code>, <code className="text-warm-800">.git</code>
          {t('vault.ignore.desc4')}
        </div>

        <div className="flex-1 p-4 min-h-0">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={placeholder}
            disabled={loading || saving}
            spellCheck={false}
            className="w-full h-[300px] resize-none rounded-md border border-warm-300 bg-[var(--color-bg-input)] text-warm-800 placeholder:text-warm-400 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {error && (
            <div className="mt-2 text-xs text-status-error">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-warm-200">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('vault.ignore.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={loading || saving}
          >
            {saving ? t('vault.ignore.saving') : t('vault.ignore.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
