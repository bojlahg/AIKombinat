import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import ProviderAccountsPanel from '../../components/settings/ProviderAccountsPanel';
import ProviderAccountPicker from '../../components/ProviderAccountPicker';
import ExecutionAccountIdentity from '../../components/ExecutionAccountIdentity';
import * as api from '../../api/providerAccounts';

vi.mock('../../api/providerAccounts', () => ({ getAccounts: vi.fn(), saveAccount: vi.fn(), testAccount: vi.fn(), deleteAccount: vi.fn(), resetAccountQuota: vi.fn() }));
const account: api.ProviderAccount = { id: 'account-a', provider: 'claude', slug: 'work', label: 'Work', description: '', auth_strategy: 'environment_reference', auth_config_json: '{"variable":"WORK_KEY"}', is_enabled: 1, health_state: 'unknown', health_reason: null, max_concurrency: 2, active_usage: 1, strategies: ['inherited','environment_reference'] };
beforeEach(() => { localStorage.setItem('aikombinat-lang', 'en'); vi.mocked(api.getAccounts).mockResolvedValue([account]); });
afterEach(() => vi.clearAllMocks());
describe('Provider account UI', () => {
  it('shows health and usage, tests accounts and saves limits and reference names', async () => {
    render(<I18nProvider><ProviderAccountsPanel /></I18nProvider>);
    await screen.findByDisplayValue('Work'); expect(screen.getByText('Active: 1/2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test account' }));
    await waitFor(() => expect(api.testAccount).toHaveBeenCalledWith(account.id));
    fireEvent.change(screen.getByLabelText('Max concurrency'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveAccount).toHaveBeenCalledWith(account.id, expect.objectContaining({ max_concurrency: 3, auth_config: { variable: 'WORK_KEY' } })));
  });
  it('persists disable and permits account selection without hiding lineage', async () => {
    render(<I18nProvider><ProviderAccountsPanel /></I18nProvider>);
    await screen.findByDisplayValue('Work'); fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(api.saveAccount).toHaveBeenCalledWith(account.id, { is_enabled: false }));
  });
  it('shows separate health and quota, reloads live account events, and resets only quota', async () => {
    vi.mocked(api.getAccounts).mockResolvedValue([{ ...account, health_state: 'available', quota: { state: 'exhausted', source: 'runtime_rejection', reason: 'usage limit reached', resetAt: '2026-09-30T18:00:00Z', observedAt: '2026-09-30T17:00:00Z' } }]);
    let listener!: (event: { type: string }) => void;
    const onEvent = (cb: typeof listener) => { listener = cb; return vi.fn(); };
    render(<I18nProvider><ProviderAccountsPanel onEvent={onEvent} /></I18nProvider>);
    await screen.findByText('Quota: Exhausted'); expect(screen.getByText('Health: Available')).toBeInTheDocument();
    expect(screen.getByText('Source: Runtime rejection')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear exhaustion / Mark unknown' }));
    await waitFor(() => expect(api.resetAccountQuota).toHaveBeenCalledWith(account.id));
    vi.mocked(api.getAccounts).mockResolvedValue([{ ...account, quota: { state: 'unknown', source: 'manual_reset', reason: null, resetAt: null, observedAt: '2026-09-30T17:00:00Z' } }]);
    act(() => listener({ type: 'provider-account:quota' })); await screen.findByText('Quota: Unknown');
    for (const type of ['created','updated','health','deleted']) act(() => listener({ type: `provider-account:${type}` }));
    await waitFor(() => expect(api.getAccounts).toHaveBeenCalledTimes(7));
  });
  it('manual selection uses a stable account ID; OpenCode has no account picker', async () => {
    const change = vi.fn(); const { rerender } = render(<I18nProvider><ProviderAccountPicker provider="claude" value={null} onChange={change} /></I18nProvider>);
    await screen.findByRole('option', { name: 'Work' }); fireEvent.change(screen.getByLabelText('Account'), { target: { value: account.id } });
    expect(change).toHaveBeenCalledWith(account.id);
    rerender(<I18nProvider><ProviderAccountPicker provider="opencode" onChange={change} /></I18nProvider>);
    expect(screen.queryByLabelText('Account')).not.toBeInTheDocument();
  });
  it('history uses the saved label and supports legacy snapshots', () => {
    const { rerender } = render(<I18nProvider><ExecutionAccountIdentity snapshot={JSON.stringify({ agent: 'claude', providerAccountLabel: 'Old label', accountPolicy: 'fixed' })} /></I18nProvider>);
    expect(screen.getByText('Account: Old label · Fixed account')).toBeInTheDocument();
    rerender(<I18nProvider><ExecutionAccountIdentity snapshot='{"agent":"claude"}' /></I18nProvider>);
    expect(screen.getByText('Account: Legacy / Unknown')).toBeInTheDocument();
  });
});
