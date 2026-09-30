import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import ConsensusAnalyticsPanel from '../../components/ConsensusAnalyticsPanel';

const metrics={ sampleCount: 1,totalBatches: 1,completedBatches: 1,failedBatches: 0,approvedBatches: 0,needsChangesBatches: 1,agreementRate: null,disagreementRate: null,reworkRate: 0,judgeInvocationRate: 0,knownCostUsd: .04,knownTokens: 30,costCoverage: .5,tokenCoverage: .5,avgBatchDurationMs: 1000,feedbackBatchesLabeled: 0,feedbackBatchesTotal: 1,feedbackIssuesLabeled: 0,feedbackIssuesTotal: 1 };
const reviewer={ policyMemberId: 'member',label: 'Reviewer A',jobs: 1,approvalVotes: 0,needsChangesVotes: 1,finalAlignmentRate: 1,uniqueIssueCount: 1,confirmedFindingCount: 0,rejectedFindingCount: 0,knownCostUsd: .04,avgDurationMs: 100,sampleCount: 1,telemetryCoverage: { cost: .5,tokens: .5,duration: 1 } };
const issue={ fingerprint: 'fingerprint',description: 'Missing bound',files: ['a.ts'],severity: 'major',reviewerCount: 1,batchCount: 1,uniqueCount: 1,sharedCount: 0,confirmed: 0,rejected: 0 };
const data={ period: { periodStart: null,periodEnd: '2026-10-01T00:00:00Z',timezone: 'UTC' },summary: metrics,strategies: [{ ...metrics,strategy: 'majority' }],policies: [{ ...metrics,policyId: 'policy',policyVariantId: 'variant' }],reviewers: [reviewer],executionIdentities: [{ ...reviewer,label: undefined,grouping: 'provider_model',identity: { provider: 'claude',effectiveModel: 'haiku',effort: null } }],issues: [issue],daily: [{ date: '2026-10-01',batches: 1,agreement: 0,disagreement: 0 }],diversity: [{ ...metrics,cohort: 'provider:homogeneous' }],judge: { judgeInvocations: 0,judgeCompleted: 0,judgeFailed: 0,judgeOverrodeMajority: 0,knownJudgeCostUsd: 0,avgJudgeDurationMs: null,judgeCostCoverage: null },humanFeedback: { batchFeedbackCoverage: 0,reviewerFeedbackCoverage: 0,issueFeedbackCoverage: 0,confirmedIssueCount: 0,rejectedIssueCount: 0 },singleBaseline: { singleReviewRounds: 1,singleNeedsChanges: 0,singleReworkRate: 0,knownCostUsd: 0,knownTokens: 0,avgDurationMs: null,costCoverage: null,tokenCoverage: null },batches: [{ id: 'batch-1234',todoId: 'todo',strategy: 'majority',status: 'completed',finalVerdict: 'needs_changes',agreement: null,reviewerCount: 1,successfulReviewers: 1,failedReviewers: 0,uniqueIssueCount: 1,batchDurationMs: 1000,diversity: { distinctProviders: 1,distinctAccounts: 1,distinctModels: 1 },telemetry: { knownCostUsd: .04,knownTokens: 30,costCoverage: .5,tokenCoverage: .5 },jobs: [{ id: 'job',label: 'Reviewer A',identity: { provider: 'claude',providerAccountLabel: 'Historical account',effectiveModel: 'haiku',effort: null },verdict: 'needs_changes',uniqueIssueCount: 1,decisiveVote: null,judgeTriggerContribution: false,issues: [issue],feedback: [] }],feedback: [],judge: { overrodeMajority: null },humanActions: [] }],pagination: { offset: 0,limit: 200,total: 1,hasMore: false },bounds: { groupRowsOmitted: false,issueRowsOmitted: false,dailyRowsOmitted: false } };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(()=>{ localStorage.setItem('aikombinat-lang','en');fetchMock=vi.fn(async()=>({ ok: true,status: 200,json: async()=>data }));vi.stubGlobal('fetch',fetchMock); });
describe('Consensus evaluation dashboard',()=>{
  it('renders key sections, evidence, samples, unknowns and usage coverage',async()=>{
    render(<I18nProvider><ConsensusAnalyticsPanel projectId="project" /></I18nProvider>);
    await screen.findByText('Daily agreement');
    for (const name of ['Strategies','Historical policies','Reviewers','Diversity (observational)','Judge','Issue fingerprints','Single / Consensus (observational)']) expect(screen.getByRole('heading',{ name })).toBeInTheDocument();
    expect(screen.getByText(/Agreement is not correctness/)).toBeInTheDocument();expect(screen.getAllByText(/Low sample/).length).toBeGreaterThan(0);expect(screen.getAllByText('$0.0400 (50.0%)').length).toBeGreaterThan(0);
    const comparison=screen.getByRole('heading',{ name: 'Single / Consensus (observational)' }).closest('section')!;expect(within(comparison).getAllByText('—').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{ name: 'Provider / model / effort' }));expect(screen.getByText('claude / haiku / —')).toBeInTheDocument();
  });
  it('changes period and filters and exports current bounded page',async()=>{
    render(<I18nProvider><ConsensusAnalyticsPanel projectId="project" /></I18nProvider>);await screen.findByText('Daily agreement');
    fireEvent.click(screen.getByRole('button',{ name: '7D' }));await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('period=7d'),expect.any(Object)));
    fireEvent.change(screen.getByLabelText('Provider'),{ target: { value: 'claude' } });await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('provider=claude'),expect.any(Object)));
    expect(screen.getByRole('link',{ name: 'Export current batch page (CSV)' })).toHaveAttribute('href',expect.stringContaining('export.csv'));
  });
  it.each([[0,'correct','/api/consensus-review-batches/batch-1234/feedback'],[1,'useful','/api/consensus-review-jobs/job/feedback'],[2,'confirmed','/api/consensus-review-jobs/job/issues/fingerprint/feedback']] as const)('drills into batch identity and saves feedback scope %s',async(i,label,path)=>{
    render(<I18nProvider><ConsensusAnalyticsPanel projectId="project" /></I18nProvider>);await screen.findByText('Daily agreement');
    fireEvent.click(screen.getByRole('button',{ name: /batch-12/ }));await screen.findByText(/Historical account/);
    fireEvent.change(screen.getAllByLabelText('Human feedback')[i],{ target: { value: label } });fireEvent.click(screen.getAllByRole('button',{ name: 'Save' })[i]);await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(path,expect.objectContaining({ method: 'PUT',body: expect.stringContaining(`"label":"${label}"`) })));
  });
  it('shows a load failure without stale result exposure after project switch',async()=>{
    fetchMock.mockRejectedValue(new Error('network'));render(<I18nProvider><ConsensusAnalyticsPanel projectId="project" /></I18nProvider>);expect(await screen.findByRole('alert')).toHaveTextContent('Could not load evaluation');
  });
});
