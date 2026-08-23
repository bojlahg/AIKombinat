import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { useToast } from '../../hooks/useToast';

function initialParticlesEnabled() {
  const saved = localStorage.getItem('aikombinat-home-particles') ?? localStorage.getItem('clitrigger-home-particles');
  if (saved !== null) return saved === 'on';
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function GeneralSettingsPanel() {
  const { t } = useI18n();
  const { error: toastError } = useToast();
  const [particles, setParticles] = useState(initialParticlesEnabled);
  const [desktop, setDesktop] = useState<DesktopSettings | null>(null);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const trayHintKey = desktop?.traySupported
    ? desktop.platform === 'darwin'
      ? 'settings.desktop.keepRunningMacHint'
      : desktop.platform === 'linux'
        ? 'settings.desktop.keepRunningLinuxHint'
        : 'settings.desktop.keepRunningWindowsHint'
    : 'settings.desktop.trayUnavailable';

  useEffect(() => {
    window.electronAPI?.desktopGetSettings?.().then(setDesktop).catch(() => setDesktop(null));
  }, []);

  const toggleParticles = (enabled: boolean) => {
    setParticles(enabled);
    localStorage.setItem('aikombinat-home-particles', enabled ? 'on' : 'off');
    window.dispatchEvent(new CustomEvent('home-particles:changed', { detail: enabled }));
  };

  const updateDesktop = async (patch: Partial<Pick<DesktopSettings, 'closeBehavior' | 'openAtLogin'>>) => {
    if (!window.electronAPI?.desktopUpdateSettings) return;
    setDesktopBusy(true);
    try {
      setDesktop(await window.electronAPI.desktopUpdateSettings(patch));
    } catch {
      toastError(t('settings.desktop.saveFailed'));
    } finally {
      setDesktopBusy(false);
    }
  };

  return (
    <div className="p-6 sm:p-8">
      <h2 className="mb-1 text-lg font-semibold text-warm-800">{t('settings.tabs.general')}</h2>
      <p className="mb-7 text-xs text-warm-400">{t('settings.general.description')}</p>

      <section>
        <h3 className="mb-3 text-sm font-semibold text-warm-700">{t('settings.appearance.title')}</h3>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl p-3 hover:bg-theme-hover">
          <input type="checkbox" checked={particles} onChange={(e) => toggleParticles(e.target.checked)} className="mt-0.5 rounded border-warm-300" />
          <span>
            <span className="block text-sm text-warm-700">{t('settings.appearance.particles')}</span>
            <span className="mt-1 block text-xs text-warm-400">{t('settings.appearance.particlesHint')}</span>
          </span>
        </label>
      </section>

      {desktop?.supported && (
        <section className="mt-8 border-t pt-7" style={{ borderColor: 'var(--color-border)' }}>
          <h3 className="mb-3 text-sm font-semibold text-warm-700">{t('settings.desktop.title')}</h3>
          <label className={`flex items-start gap-3 rounded-xl p-3 ${desktop.autostartSupported ? 'cursor-pointer hover:bg-theme-hover' : 'opacity-60'}`}>
            <input
              type="checkbox"
              checked={desktop.openAtLogin}
              disabled={!desktop.autostartSupported || desktopBusy}
              onChange={(e) => updateDesktop({ openAtLogin: e.target.checked })}
              className="mt-0.5 rounded border-warm-300"
            />
            <span>
              <span className="block text-sm text-warm-700">{t('settings.desktop.openAtLogin')}</span>
              {!desktop.autostartSupported && <span className="mt-1 block text-xs text-warm-400">{t('settings.desktop.packagedOnly')}</span>}
            </span>
          </label>

          <fieldset className="mt-5" disabled={desktopBusy}>
            <legend className="mb-2 text-sm font-medium text-warm-700">{t('settings.desktop.closePrompt')}</legend>
            <label className={`flex items-start gap-3 rounded-xl px-3 py-2.5 ${desktop.traySupported ? 'cursor-pointer hover:bg-theme-hover' : 'opacity-60'}`}>
              <input className="mt-0.5" type="radio" name="closeBehavior" disabled={!desktop.traySupported} checked={desktop.closeBehavior === 'tray'} onChange={() => updateDesktop({ closeBehavior: 'tray' })} />
              <span>
                <span className="block text-sm text-warm-600">{t('settings.desktop.closeToTray')}</span>
                <span className="mt-1 block text-xs text-warm-400">{t(trayHintKey)}</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-theme-hover">
              <input type="radio" name="closeBehavior" checked={desktop.closeBehavior === 'quit'} onChange={() => updateDesktop({ closeBehavior: 'quit' })} />
              <span className="text-sm text-warm-600">{t('settings.desktop.quit')}</span>
            </label>
          </fieldset>
        </section>
      )}
    </div>
  );
}
