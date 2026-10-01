import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { translateAuthError } from '../utils/auth-error';
import * as tunnelApi from '../api/tunnel';
import type { TunnelStatus } from '../api/tunnel';
import * as authApi from '../api/auth';
import { useToast } from '../hooks/useToast';

interface PanelProps {
  onClose?: () => void;
}

const MIN_LENGTH = 8;

export default function PasswordSettingsPanel({ onClose }: PanelProps) {
  const { t } = useI18n();
  const { error: toastError, success: toastSuccess } = useToast();

  const [status, setStatus] = useState<authApi.AuthStatus | null>(null);
  const [tunnelState, setTunnelState] = useState<TunnelStatus['status']>('stopped');
  useEffect(() => {
    authApi.getAuthStatus().then(setStatus).catch(() => {});
    tunnelApi.getTunnelStatus().then(s => setTunnelState(s.status)).catch(() => {});
  }, []);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const canSave = !!status && (status.accessMode === 'local' || !!oldPassword)
    && newPassword.length >= MIN_LENGTH
    && newPassword === confirm
    && !saving;

  const reset = () => {
    setOldPassword('');
    setNewPassword('');
    setConfirm('');
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (status?.passwordConfigured) await authApi.changePassword(oldPassword, newPassword, confirm);
      else await authApi.setupPassword(newPassword, confirm);
      setStatus(await authApi.getAuthStatus());
      window.dispatchEvent(new CustomEvent('auth:changed'));
      toastSuccess(t('account.saved'));
      reset();
    } catch (err) {
      toastError(translateAuthError(err instanceof Error ? err.message : 'unknown', t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8">
      <h2 className="text-lg font-semibold text-warm-800 mb-1">{t('auth.remote.password')}</h2>
      <p className="text-xs text-warm-400 mb-6">{t(status?.accessMode === 'local' ? 'auth.access.local' : 'auth.remote.description')}</p>

      <p className="text-sm text-theme-text-secondary mb-4">{t(status?.passwordConfigured ? 'auth.remote.configured' : 'auth.remote.notConfigured')}</p>
      <p className="text-sm text-theme-text-secondary mb-4">{t('tunnel.title')}: {t(`tunnel.status.${tunnelState}`)}</p>
      {status?.accessMode === 'remote' && <div className="mb-4">
        <label className="block text-sm font-medium text-warm-600 mb-2">
          {t('account.oldPassword')}
        </label>
        <input
          type="password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          className="input-field text-sm"
          autoComplete="current-password"
        />
      </div>}

      <div className="mb-4">
        <label className="block text-sm font-medium text-warm-600 mb-2">
          {t('account.newPassword')}
        </label>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="input-field text-sm"
          autoComplete="new-password"
        />
        {tooShort && (
          <p className="mt-1 text-2xs text-status-error">{t('account.tooShort')}</p>
        )}
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-warm-600 mb-2">
          {t('account.confirm')}
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="input-field text-sm"
          autoComplete="new-password"
        />
        {mismatch && (
          <p className="mt-1 text-2xs text-status-error">{t('account.mismatch')}</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        {onClose && (
          <button type="button" onClick={onClose} className="btn-ghost text-sm">
            {t('account.close')}
          </button>
        )}
        <button type="button" onClick={handleSave} disabled={!canSave} className="btn-primary text-sm">
          {saving ? t('account.saving') : t('account.save')}
        </button>
      </div>
    </div>
  );
}
