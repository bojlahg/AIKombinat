import { useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Bot, Cloud, KeyRound, MonitorCog, Plug, Settings, TerminalSquare } from 'lucide-react';
import { useI18n } from '../../i18n';
import PasswordSettingsPanel from '../PasswordSettingsPanel';
import SessionSettingsPanel from '../SessionSettingsPanel';
import { TunnelSettingsPanel } from '../TunnelSettings';
import McpSettingsPanel from '../McpSettingsPanel';
import GeneralSettingsPanel from './GeneralSettingsPanel';
import AgentsSettingsPanel from './AgentsSettingsPanel';

export default function SettingsPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [tunnelDirty, setTunnelDirty] = useState(false);
  const tabs = [
    { id: 'general', label: t('settings.tabs.general'), icon: MonitorCog },
    { id: 'agents', label: t('settings.tabs.agents'), icon: Bot },
    { id: 'account', label: t('settings.tabs.account'), icon: KeyRound },
    { id: 'terminals', label: t('settings.tabs.session'), icon: TerminalSquare },
    { id: 'tunnel', label: t('settings.tabs.tunnel'), icon: Cloud },
    { id: 'mcp', label: t('settings.tabs.mcp'), icon: Plug },
  ];

  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center gap-3">
          <Settings size={22} style={{ color: 'var(--color-accent)' }} />
          <h1 className="text-2xl font-semibold text-warm-800">{t('settings.title')}</h1>
        </div>
        <div className="card overflow-hidden md:flex" style={{ minHeight: 560 }}>
          <nav className="shrink-0 border-b p-3 md:w-48 md:border-b-0 md:border-r" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg-hover)' }}>
            <div className="flex gap-1 overflow-x-auto md:flex-col">
              {tabs.map(({ id, label, icon: Icon }) => (
                <NavLink
                  key={id}
                  to={`/settings/${id}`}
                  onClick={(event) => {
                    if (id !== 'tunnel' && location.pathname === '/settings/tunnel' && tunnelDirty && !window.confirm(t('settings.discardConfirm'))) {
                      event.preventDefault();
                    }
                  }}
                  className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-colors"
                  style={({ isActive }) => ({
                    color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    backgroundColor: isActive ? 'var(--color-bg-primary)' : 'transparent',
                    fontWeight: isActive ? 600 : 400,
                  })}
                >
                  <Icon size={15} />
                  {label}
                </NavLink>
              ))}
            </div>
            <div className="mt-4 hidden px-3 text-[11px] tracking-wide md:block" style={{ color: 'var(--color-text-muted)' }}>
              v{__APP_VERSION__}
            </div>
          </nav>
          <div className="min-w-0 flex-1">
            <Routes>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<GeneralSettingsPanel />} />
              <Route path="agents" element={<AgentsSettingsPanel />} />
              <Route path="account" element={<PasswordSettingsPanel />} />
              <Route path="terminals" element={<SessionSettingsPanel />} />
              <Route path="tunnel" element={<TunnelSettingsPanel onDirtyChange={setTunnelDirty} />} />
              <Route path="mcp" element={<McpSettingsPanel />} />
              <Route path="*" element={<Navigate to="general" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </div>
  );
}
