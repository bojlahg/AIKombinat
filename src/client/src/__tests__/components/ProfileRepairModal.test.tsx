import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import ProfileRepairModal from '../../components/settings/ProfileRepairModal';
import { rebindCandidate, type ReconciledCandidate, type ReconciledProfile } from '../../api/reconciliation';
vi.mock('../../api/reconciliation', () => ({ rebindCandidate: vi.fn() }));
const candidate: ReconciledCandidate = { candidateId: 'c', modelReferenceId: 'old', repairKind: 'model', provider: 'claude', priority: 2, enabled: true,
  currentModel: { id: 'old', value: 'claude-old', label: 'Old model', status: 'missing', source: 'cli', lastSeenAt: null }, catalogState: 'stale', catalogReasonCode: 'authoritative_omission', runtimeState: 'unavailable', runtimeReasonCode: 'runtime_unavailable',
  effort: { configured: 'high', supported: ['high'], state: 'effort_supported' }, account: { policy: 'fixed', accountId: 'account', state: 'available' },
  suggestions: [{ modelId: 'new', modelValue: 'claude-new', label: 'New model', reasonCode: 'same_family', requiresEffortChoice: true }] };
const profile: ReconciledProfile = { id: 'p', name: 'Profile', updatedAt: 'version', health: 'blocked', usable: false, candidates: [candidate], references: { reviewPolicies: [], runningCampaigns: [] } };
const models = [{ id: 'new', value: 'claude-new', label: 'New model', supportedEfforts: ['medium'] }, { id: 'other', value: 'claude-other', label: 'Other model', supportedEfforts: null }];
describe('explicit model repair', () => {
  beforeEach(() => { localStorage.setItem('aikombinat-lang','en'); vi.clearAllMocks(); });
  afterEach(() => vi.restoreAllMocks());
  it('requires an effort choice, previews unchanged account/priority, and submits concurrency tokens', async () => {
    const applied = vi.fn(async () => {}), close = vi.fn();
    render(<I18nProvider><ProfileRepairModal profile={profile} candidate={candidate} models={models} onApplied={applied} onClose={close} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Replacement model'), { target: { value: 'new' } });
    expect(screen.getByRole('button', { name: 'Apply rebind' })).toBeDisabled();
    expect(screen.getByText(/Priority, enabled state and account policy remain unchanged/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply rebind' }));
    await waitFor(() => expect(rebindCandidate).toHaveBeenCalledWith('p','c', { newModelId: 'new', newEffort: null, expectedOldModelId: 'old', expectedProfileUpdatedAt: 'version', confirmActiveCampaignImpact: false }));
    expect(applied).toHaveBeenCalled();
  });
  it('searches all current models and warns for unknown effort capabilities', () => {
    render(<I18nProvider><ProfileRepairModal profile={profile} candidate={candidate} models={models} onApplied={async () => {}} onClose={() => {}} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Search current models from this provider'), { target: { value: 'other' } });
    expect(screen.queryByRole('option', { name: 'New model (claude-new)' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Replacement model'), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: 'Apply rebind' })).toBeEnabled();
    expect(screen.getByText(/high → high/)).toBeInTheDocument();
  });
  it('requires explicit campaign impact confirmation', async () => {
    render(<I18nProvider><ProfileRepairModal profile={{ ...profile, references: { reviewPolicies: [{ id: 'policy', name: 'Policy' }], runningCampaigns: [{ id: 'campaign', name: 'Campaign' }] } }} candidate={candidate} models={models} onApplied={async () => {}} onClose={() => {}} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Replacement model'), { target: { value: 'other' } });
    expect(screen.getByRole('button', { name: 'Apply rebind' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply rebind' }));
    await waitFor(() => expect(rebindCandidate).toHaveBeenCalledWith('p','c', expect.objectContaining({ confirmActiveCampaignImpact: true, newEffort: 'high' })));
  });
  it('localizes stale-preview errors without displaying raw server English', async () => {
    vi.mocked(rebindCandidate).mockRejectedValue(new Error('reconciliation_stale'));
    render(<I18nProvider><ProfileRepairModal profile={profile} candidate={candidate} models={models} onApplied={async () => {}} onClose={() => {}} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Replacement model'), { target: { value: 'other' } }); fireEvent.click(screen.getByRole('button', { name: 'Apply rebind' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The preview is outdated. Close and reopen repair.');
  });
});
