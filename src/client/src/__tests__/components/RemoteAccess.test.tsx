import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, cleanup } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import LoginPage from '../../components/LoginPage';
import RemoteAccessBlockedPage from '../../components/RemoteAccessBlockedPage';
import PasswordSettingsPanel from '../../components/PasswordSettingsPanel';
import { TunnelSettingsPanel } from '../../components/TunnelSettings';
import { useAuth } from '../../hooks/useAuth';
import * as authApi from '../../api/auth';
import * as tunnelApi from '../../api/tunnel';

vi.mock('../../api/auth');
vi.mock('../../api/tunnel');
vi.mock('../../hooks/useToast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const local = { authenticated: true, authRequired: false, accessMode: 'local' as const, setupRequired: false, passwordConfigured: false, remoteAccessReady: false, remoteAccessBlocked: false, passwordSetupAllowed: true };
const remote = { ...local, authenticated: false, authRequired: true, accessMode: 'remote' as const, passwordSetupAllowed: false };
const wrap = (ui: React.ReactElement) => render(<I18nProvider>{ui}</I18nProvider>);
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('remote access localized UX', () => {
  it.each(['ru', 'ko'])('%s translates remote login, errors and recovery text', async lang => {
    localStorage.setItem('aikombinat-lang', lang);
    const onLogin = vi.fn().mockRejectedValue(new Error('invalid_password'));
    const { container } = wrap(<LoginPage onLogin={onLogin} onChangePassword={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('*************'), { target: { value: 'wrong' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    await waitFor(() => expect(container.textContent).toMatch(lang === 'ru' ? /Неверный пароль/ : /비밀번호가 올바르지/));
    const forgot = lang === 'ru' ? 'Забыли пароль?' : '비밀번호를 잊으셨나요?';
    fireEvent.click(screen.getByText(forgot));
    expect(container.textContent).toContain('aikombinat reset-password');
    expect(container.textContent).not.toMatch(/Authentication Required|Forgot your password|This software is provided|Password is required|Invalid password/);
  });
  it('updates an existing error when the login language changes', async () => {
    localStorage.setItem('aikombinat-lang', 'en');
    const { container } = wrap(<LoginPage onLogin={vi.fn().mockRejectedValue(new Error('invalid_password'))} onChangePassword={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('*************'), { target: { value: 'wrong' } });
    fireEvent.submit(container.querySelector('form')!);
    await screen.findByText('Invalid password.');
    fireEvent.click(screen.getByRole('button', { name: /language/i }));
    fireEvent.click(screen.getByText('Русский'));
    expect(screen.getByText('Неверный пароль.')).toBeInTheDocument();
    expect(screen.queryByText('Invalid password.')).not.toBeInTheDocument();
  });
  it.each(['ru', 'ko'])('%s blocked page contains no setup form', lang => {
    localStorage.setItem('aikombinat-lang', lang);
    const { container } = wrap(<RemoteAccessBlockedPage />);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('Remote access is not configured');
  });
  it.each([false, true])('local password settings omit current password (configured=%s)', async configured => {
    localStorage.setItem('aikombinat-lang', 'en');
    vi.mocked(authApi.getAuthStatus).mockResolvedValue({ ...local, passwordConfigured: configured });
    vi.mocked(tunnelApi.getTunnelStatus).mockResolvedValue({ status: 'stopped', url: null });
    wrap(<PasswordSettingsPanel />);
    await screen.findByText(configured ? 'Remote password: Configured' : 'Remote password: Not configured');
    await waitFor(() => expect(document.querySelectorAll('input[type=password]')).toHaveLength(2));
    expect(screen.queryByText('Current password')).not.toBeInTheDocument();
    const fields = document.querySelectorAll('input');
    fireEvent.change(fields[0], { target: { value: 'replacement123' } });
    fireEvent.change(fields[1], { target: { value: 'replacement123' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(configured ? authApi.changePassword : authApi.setupPassword).toHaveBeenCalledOnce());
  });
  it('remote password settings require current password', async () => {
    localStorage.setItem('aikombinat-lang', 'en');
    vi.mocked(authApi.getAuthStatus).mockResolvedValue({ ...remote, authenticated: true, passwordConfigured: true, remoteAccessReady: true });
    vi.mocked(tunnelApi.getTunnelStatus).mockResolvedValue({ status: 'stopped', url: null });
    wrap(<PasswordSettingsPanel />);
    await screen.findByText('Current password');
    expect(document.querySelectorAll('input[type=password]')).toHaveLength(3);
    expect(screen.getByText('Save')).toBeDisabled();
  });
  it('tunnel password CTA guards start and opens local password settings', async () => {
    localStorage.setItem('aikombinat-lang', 'en');
    vi.mocked(authApi.getAuthStatus).mockResolvedValue(local);
    vi.mocked(tunnelApi.getTunnelStatus).mockResolvedValue({ status: 'stopped', url: null });
    vi.mocked(tunnelApi.getTunnelConfig).mockResolvedValue({ tunnelName: '', customHostname: '' });
    wrap(<TunnelSettingsPanel />);
    const button = screen.getByText('Set Remote Access Password');
    expect(screen.getByText('Start tunnel')).toBeDisabled();
    fireEvent.click(button);
    expect(await screen.findByText('Remote Access Password')).toBeInTheDocument();
    expect(tunnelApi.startTunnel).not.toHaveBeenCalled();
  });
  it('local unauthorized events refresh status without entering login', async () => {
    vi.mocked(authApi.getAuthStatus).mockResolvedValue(local);
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => window.dispatchEvent(new CustomEvent('auth:unauthorized')));
    expect(result.current.authenticated).toBe(true);
    expect(result.current.authRequired).toBe(false);
  });
  it('exposes remote missing-password state to the app gate', async () => {
    vi.mocked(authApi.getAuthStatus).mockResolvedValue({ ...remote, remoteAccessBlocked: true });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.remoteAccessBlocked).toBe(true);
    expect(result.current.setupRequired).toBe(false);
  });
});
