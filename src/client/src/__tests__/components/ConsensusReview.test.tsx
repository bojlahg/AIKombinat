import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import ReviewPoliciesPanel from '../../components/settings/ReviewPoliciesPanel';
import ConsensusReviewDetails from '../../components/ConsensusReviewDetails';
import TodoForm from '../../components/TodoForm';

const policy = { id: 'policy',name: 'Team review',description: '',strategy: 'majority',failure_policy: 'require_all',
  min_successful_reviewers: 2,judge_execution_profile_id: null,diversity_policy: 'none',max_parallel_reviewers: 3,is_enabled: 1,sort_order: 0,
  members: [0,1].map(i => ({ id: `member-${i}`,execution_profile_id: 'profile',label: `Reviewer ${i}`,weight: 1,priority: i,is_enabled: 1 })) };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.setItem('aikombinat-lang','en');
  fetchMock = vi.fn(async (url: string) => ({ ok: true,status: 200,json: async () => {
    if (url === '/api/review-policies') return [policy];
    if (url.startsWith('/api/execution-profiles')) return [{ id: 'profile',name: 'Reviewer profile',slug: 'reviewer',description: '',isEnabled: true,sortOrder: 0 }];
    if (url.startsWith('/api/resources')) return { resources: [] };
    if (url === '/api/models') return { claude: [] };
    if (url.startsWith('/api/todos/')) return [{ id: 'batch',review_round_id: 'round',status: 'failed',strategy: 'majority',failure_reason: 'judge_failed',
      aggregate_result_json: null,jobs: [{ id: 'job',role: 'reviewer',label: 'Dissent',weight: 2,status: 'completed',execution_profile_id: 'profile',
        final_result_payload: JSON.stringify({ verdict: 'needs_changes',summary: 'Visible minority finding',issues: [{ severity: 'major',description: 'Bug in sum',files: ['sum.js'] }] }),
        attempts: [{ id: 'attempt',attempt_index: 1,status: 'completed',execution_snapshot: JSON.stringify({ profileName: 'Reviewer profile',agent: 'claude',providerAccountLabel: 'Account A',effectiveModel: 'haiku',effort: 'low' }),duration_ms: 100,cost_usd: null }] },
        { id: 'judge',role: 'judge',label: 'Judge',weight: 1,status: 'failed',execution_profile_id: 'profile',final_result_payload: null,final_error_message: 'judge_failed',attempts: [] }] }];
    return [];
  } }));
  vi.stubGlobal('fetch',fetchMock);
});
describe('Consensus review UI', () => {
  it('edits strategy, quorum, judge, members and saves policy through CRUD API', async () => {
    render(<I18nProvider><ReviewPoliciesPanel /></I18nProvider>);
    await screen.findByText('Team review');fireEvent.click(screen.getByRole('button',{ name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Strategy'),{ target: { value: 'judge_on_disagreement' } });
    expect(screen.getByLabelText('Judge profile')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Judge profile'),{ target: { value: 'profile' } });
    fireEvent.change(screen.getByLabelText('Failure policy'),{ target: { value: 'quorum' } });
    expect(screen.getByLabelText('Minimum successful reviewers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{ name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/review-policies/policy',expect.objectContaining({ method: 'PATCH',body: expect.stringContaining('judge_on_disagreement') })));
  });
  it('Todo consensus mode selects policy while retaining common rework profile', async () => {
    render(<I18nProvider><TodoForm onSave={vi.fn()} onCancel={vi.fn()} initialReviewEnabled={1} initialReviewMode="consensus" initialReviewPolicyId="policy" /></I18nProvider>);
    await screen.findByRole('option',{ name: /Team review/ });
    expect(screen.getByText('Review policy')).toBeInTheDocument();expect(screen.getByText('Rework Profile (Optional)')).toBeInTheDocument();
    expect(screen.queryByText('Review Profile')).not.toBeInTheDocument();
  });
  it('renders identity, dissent, judge failure and retries judge; WebSocket refreshes history', async () => {
    let listener!: (event: { type: string; todoId: string }) => void;
    const onEvent = vi.fn(cb => { listener = cb;return vi.fn(); });
    render(<I18nProvider><ConsensusReviewDetails todoId="todo" roundId="round" onEvent={onEvent} /></I18nProvider>);
    await screen.findByText(/Visible minority finding/);expect(screen.getByText(/Account A/)).toHaveTextContent('haiku');
    expect(screen.getByText(/Bug in sum/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{ name: 'Retry judge' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/consensus-review-jobs/judge/retry',expect.objectContaining({ method: 'POST' })));
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('consensus-reviews')).length;
    listener({ type: 'consensus-review:job-updated',todoId: 'todo' });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('consensus-reviews')).length).toBeGreaterThan(before));
  });
});
