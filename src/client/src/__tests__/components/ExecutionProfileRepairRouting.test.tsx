import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AgentsSettingsPanel from '../../components/settings/AgentsSettingsPanel';
import { I18nProvider } from '../../i18n';
import type { ReconciledCandidate, Reconciliation } from '../../api/reconciliation';
import { countNeedsAttention } from '../../api/reconciliation';
import type { WsEvent } from '../../hooks/useWebSocket';
const models = { claude: [{ id: 'model', value: 'current', label: 'Current model', status: 'available', source: 'cli', supportedEfforts: ['high'], sortOrder: 0, lastSeenAt: null, lastCheckedAt: null, lastSeenRefreshId: 'refresh' }],
  antigravity: [{ id: 'group', value: 'group', label: 'Grouped model', status: 'available', source: 'cli', supportedEfforts: ['high'], providerVariants: { high: 'variant' }, sortOrder: 0, lastSeenAt: null, lastCheckedAt: null, lastSeenRefreshId: 'refresh' }] };
const candidate = (id: string, kind: ReconciledCandidate['repairKind']): ReconciledCandidate => ({ candidateId: id, provider: kind === 'recreate' ? null : 'claude',
  modelReferenceId: kind === 'recreate' ? 'missing' : 'model', priority: 7, enabled: true, repairKind: kind,
  currentModel: kind === 'recreate' ? null : { id: 'model', value: 'current', label: 'Current model', status: 'available', source: 'cli', lastSeenAt: null },
  catalogState: kind === 'none' ? 'current' : kind === 'recreate' ? 'orphaned' : 'invalid', catalogReasonCode: kind === 'account' ? 'invalid_account_policy' : kind === 'effort' ? 'effort_unsupported' : kind === 'recreate' ? 'model_not_found' : 'latest_refresh_seen',
  runtimeState: 'available', runtimeReasonCode: 'runtime_available', effort: { configured: 'bad', supported: ['high'], state: 'effort_unsupported' },
  account: { policy: 'fixed', accountId: 'old-account', state: 'invalid' }, suggestions: [] });
function response(body: unknown) { return { ok: true, json: async () => body, text: async () => JSON.stringify(body) }; }
describe('execution profile repair routing and attention', () => {
  let reconciliation: Reconciliation;
  let fetchMock: ReturnType<typeof vi.fn>;
  let scroll: ReturnType<typeof vi.fn>;
  const setup = (kinds: ReconciledCandidate['repairKind'][]) => {
    reconciliation = { generatedAt: '', providers: ['claude', 'antigravity'].map(provider => ({ provider, primarySucceeded: true, refreshId: 'refresh' })),
      profiles: kinds.map((kind, index) => ({ id: `p${index}`, name: `Profile ${index}`, updatedAt: 'version', health: kind === 'none' ? 'ready' : 'blocked', usable: false,
        candidates: [candidate(`e${index}`, kind)], references: { reviewPolicies: [], runningCampaigns: [] } })) };
  };
  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en'); scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/models') return response(models);
      if (url === '/api/execution-profiles/reconciliation') return response(reconciliation);
      if (url.endsWith('/recreate') || url.endsWith('/rebind')) {
        const profile = reconciliation.profiles.find(p => url.includes(p.id))!;
        profile.health = 'ready'; profile.candidates[0] = candidate(profile.candidates[0].candidateId, 'none'); return response({});
      }
      if (url.startsWith('/api/execution-profiles')) {
        const profiles = reconciliation.profiles.map(profile => ({ id: profile.id, name: profile.name, description: '', isEnabled: true, sortOrder: 0,
          executors: profile.candidates.filter(c => c.currentModel).map(c => ({ id: c.candidateId, cliModelId: 'model', cliTool: 'claude', modelValue: 'current', modelLabel: 'Current model', modelStatus: 'available', supportedEfforts: ['high'], effortValue: 'bad', accountPolicy: 'inherited_default', priority: 7, isEnabled: c.enabled })) }));
        if (init?.method === 'PATCH') { const profile = reconciliation.profiles.find(p => url.endsWith(p.id))!; profile.health = 'ready'; profile.candidates[0].repairKind = 'none'; profile.candidates[0].catalogState = 'current'; return response(profiles.find(p => url.endsWith(p.id))); }
        return response(profiles);
      }
      return response([]);
    }); vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([['account', 'Fix account settings', 'Account'], ['effort', 'Fix effort', 'Effort 1']] as const)('expands, scrolls and focuses %s without a model modal', async (kind, action, label) => {
    setup(['none', kind]); render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Models' }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(action) }));
    await waitFor(() => expect(within(document.getElementById('execution-candidate-e1')!).getByLabelText(label)).toHaveFocus());
    expect(scroll).toHaveBeenCalledWith({ block: 'center' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('requires explicit provider and current model, resets unsafe defaults and preserves identity through recreation', async () => {
    setup(['recreate']); render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Recreate executor' })); const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('');
    expect(within(dialog).getByLabelText('Effort')).toHaveValue('');
    expect(within(dialog).getByLabelText('Account')).toHaveValue('inherited_default');
    expect(within(dialog).getByRole('button', { name: 'Apply rebind' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Agent'), { target: { value: 'codex' } });
    expect(within(dialog).getByText('Refresh catalog first')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Agent'), { target: { value: 'claude' } });
    fireEvent.change(within(dialog).getByLabelText('Replacement model'), { target: { value: 'model' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply rebind' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/execution-profiles/p0/executors/e0/recreate', expect.objectContaining({ body: expect.any(String) })));
    const body = JSON.parse(fetchMock.mock.calls.find(call => call[0].endsWith('/recreate'))![1].body);
    expect(body).toMatchObject({ provider: 'claude', expectedOldModelId: 'missing', newEffort: null, accountPolicy: 'inherited_default', providerAccountId: null });
    await waitFor(() => expect(screen.queryByText(/Execution Profiles need attention/)).not.toBeInTheDocument());
  });
  it('grouped Antigravity requires explicit supported effort', async () => {
    setup(['recreate']); render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Recreate executor' })); const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Agent'), { target: { value: 'antigravity' } });
    fireEvent.change(within(dialog).getByLabelText('Replacement model'), { target: { value: 'group' } });
    expect(within(dialog).getByRole('button', { name: 'Apply rebind' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Effort'), { target: { value: 'high' } });
    expect(within(dialog).getByRole('button', { name: 'Apply rebind' })).toBeEnabled();
  });
  it('updates attention 2 to 1 to 0 after ordinary account and effort saves', async () => {
    setup(['account', 'effort']); render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    expect(await screen.findByText('2 Execution Profiles need attention')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'automatic' } });
    fireEvent.click(screen.getByTitle('Save')); await screen.findByText('1 Execution Profiles need attention');
    fireEvent.click(screen.getByRole('button', { name: /Profile 1/ }));
    fireEvent.change(screen.getByLabelText('Effort 1'), { target: { value: 'high' } }); fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(screen.queryByText(/Execution Profiles need attention/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Replace model' })).not.toBeInTheDocument();
  });
  it('updates attention 2 to 1 to 0 immediately after model rebinds', async () => {
    setup(['model', 'model']);
    reconciliation.profiles.forEach(profile => { profile.candidates[0].catalogState = 'stale'; profile.candidates[0].catalogReasonCode = 'authoritative_omission'; });
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    await screen.findByText('2 Execution Profiles need attention');
    for (const remaining of [1, 0]) {
      fireEvent.click(await screen.findByRole('button', { name: 'Replace model' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Replacement model'), { target: { value: 'model' } });
      fireEvent.change(within(dialog).getByLabelText('Effort'), { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Apply rebind' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      if (remaining) { await screen.findByText('1 Execution Profiles need attention'); fireEvent.click(screen.getByRole('button', { name: /Profile 1/ })); }
      else expect(screen.queryByText(/Execution Profiles need attention/)).not.toBeInTheDocument();
    }
  });
  it('offers no repair action for current or disabled candidates', async () => {
    setup(['none', 'none']); reconciliation.profiles[1].health = 'disabled'; reconciliation.profiles[1].candidates[0].catalogState = 'disabled';
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    await screen.findByText('Ready');
    fireEvent.click(screen.getByRole('button', { name: /Profile 1/ }));
    expect(screen.queryByRole('button', { name: /Replace model|Fix effort|Fix account settings|Recreate executor/ })).not.toBeInTheDocument();
  });
  it('shows disabled orphan recreation without attention and allows ordinary profile and healthy executor saves', async () => {
    setup(['none']);
    const orphan = { ...candidate('disabled-orphan', 'recreate'), enabled: false, catalogState: 'disabled' };
    reconciliation.profiles[0].candidates.push(orphan);
    expect(countNeedsAttention(reconciliation)).toBe(0);
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    const recreate = await screen.findByRole('button', { name: 'Recreate executor' });
    const row = within(document.getElementById('execution-candidate-disabled-orphan')!);
    expect(row.getByText('Disabled')).toBeInTheDocument();
    expect(row.getByText('Missing model reference')).toBeInTheDocument();
    expect(row.getByText('This disabled executor references a model that no longer exists. You can recreate it now or leave it disabled.')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /Replace model|Fix effort|Fix account settings/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Execution Profiles need attention/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTitle('Save')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Effort 1'), { target: { value: 'high' } });
    fireEvent.click(screen.getByTitle('Save'));
    await waitFor(() => expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(2));
    const bodies = fetchMock.mock.calls.filter(call => call[1]?.method === 'PATCH').map(call => JSON.parse(call[1].body));
    expect(bodies[0].name).toBe('Renamed');
    expect(bodies[1].executors[0].effortValue).toBe('high');
    expect(bodies.every(body => body.executors.length === 1 && body.executors[0].id === 'e0')).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(recreate);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('');
    expect(within(dialog).getByLabelText('Account')).toHaveValue('inherited_default');
    expect(within(dialog).getByLabelText('Effort')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Apply rebind' })).toBeDisabled();
  });
  it.each(['execution-profile:updated', 'model-catalog:updated'] as const)('recalculates attention on %s with one health reload', async type => {
    setup(['account']); let listener: (event: WsEvent) => void = () => {};
    render(<I18nProvider><AgentsSettingsPanel onEvent={cb => { listener = cb; return () => {}; }} /></I18nProvider>);
    await screen.findByText('1 Execution Profiles need attention'); const before = fetchMock.mock.calls.filter(call => call[0] === '/api/execution-profiles/reconciliation').length;
    reconciliation.profiles[0].health = 'ready'; reconciliation.profiles[0].candidates[0].repairKind = 'none';
    listener({ type } as WsEvent);
    await waitFor(() => expect(screen.queryByText(/Execution Profiles need attention/)).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.filter(call => call[0] === '/api/execution-profiles/reconciliation')).toHaveLength(before + 1);
  });
});
