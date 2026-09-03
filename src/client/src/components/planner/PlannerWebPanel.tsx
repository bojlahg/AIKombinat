import { createElement, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useI18n } from '../../i18n';
import Button from '../Button';

const URL_KEY = 'plannerWebPanelUrl';
const DEFAULT_URL = 'https://www.notion.so';
// The <webview> tag only exists in the Electron shell; browsers get a fallback
// because sites like notion.so send X-Frame-Options and refuse iframes.
const isElectron = 'electronAPI' in window;

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_URL;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export default function PlannerWebPanel() {
  const { t } = useI18n();
  const [url, setUrl] = useState(() => localStorage.getItem(URL_KEY) || DEFAULT_URL);
  const [draft, setDraft] = useState(url);

  const go = () => {
    const next = normalizeUrl(draft);
    setDraft(next);
    setUrl(next);
    localStorage.setItem(URL_KEY, next);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <form onSubmit={(e) => { e.preventDefault(); go(); }} className="flex items-center gap-2 p-2 border-b border-theme-border">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('planner.web.urlPlaceholder')}
          className="input-field flex-1"
          spellCheck={false}
        />
        <Button type="submit" size="sm">{t('planner.web.go')}</Button>
      </form>
      {isElectron ? (
        // createElement instead of JSX: @types/react types `allowpopups` as boolean,
        // but React 19 strips boolean values from attributes it doesn't know, so the
        // guest would silently lose window.open (target=_blank links). Electron only
        // checks attribute presence, so an empty string is the correct value.
        // ponytail: leaving the panel unmounts the guest and reloads it on return;
        // keep it mounted with visibility:hidden if that ever bothers.
        createElement('webview', { src: url, partition: 'persist:webpanel', allowpopups: '', className: 'flex-1 min-h-0' })
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-theme-text-secondary">
          <span>{t('planner.web.desktopOnly')}</span>
          <Button size="sm" className="flex items-center gap-1.5" onClick={() => window.open(url, '_blank', 'noopener')}>
            <ExternalLink size={14} />
            {t('planner.web.openExternal')}
          </Button>
        </div>
      )}
    </div>
  );
}
