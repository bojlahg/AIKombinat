import { useI18n } from '../i18n';
import LanguageSelector from './LanguageSelector';

export default function RemoteAccessBlockedPage() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-theme-bg flex items-center justify-center p-6">
      <div className="card-static p-8 max-w-lg space-y-4">
        <LanguageSelector />
        <h1 className="text-xl font-semibold text-theme-text">{t('auth.blocked.title')}</h1>
        <p className="text-theme-text-secondary">{t('auth.blocked.description')}</p>
      </div>
    </div>
  );
}
