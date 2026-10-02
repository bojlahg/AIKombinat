import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '../../i18n';
import { en } from '../../i18n/en';
import { ru } from '../../i18n/ru';
import { ko } from '../../i18n/ko';
import TodoForm from '../../components/TodoForm';
import EvaluationCampaignsPanel from '../../components/EvaluationCampaignsPanel';
import CampaignAssignmentDetails from '../../components/CampaignAssignmentDetails';
import * as api from '../../api/evaluationCampaigns';
import type { WsEvent } from '../../hooks/useWebSocket';

vi.mock('../../api/evaluationCampaigns',()=>({ listCampaigns: vi.fn(),getCampaignAssignment: vi.fn(),withdrawCampaignAssignment: vi.fn(),saveCampaignFeedback: vi.fn(),getCampaignAnalytics: vi.fn(),getCampaignAssignments: vi.fn(),campaignAction: vi.fn(),deleteCampaign: vi.fn(),downloadCampaignCsv: vi.fn(),saveCampaign: vi.fn() }));
vi.mock('../../api/executionProfiles',()=>({ getProfiles: vi.fn(async()=>[{ id: 'profile',name: 'Reviewer' }]) }));
vi.mock('../../api/consensusReview',()=>({ getPolicies: vi.fn(async()=>[]) }));
vi.mock('../../components/ExecutionConfigurationPicker',()=>({ default: ()=>null }));
vi.mock('../../components/ResourceRequirementPicker',()=>({ default: ()=>null }));
vi.mock('../../components/VaultInjectControl',()=>({ default: ()=>null }));
const c: api.Campaign={ id: 'campaign',project_id: 'project',name: 'Baseline',description: '',status: 'running',auto_enroll: 1,max_assignments: null,assigned: 2,cleanPercentage: .5,started_at: '2026-10-01',assignment_algorithm: 'sha256_weighted_v1',campaign_definition_hash: 'hash',arms: [
  { id: 'control',name: 'Single',description: '',is_control: 1,weight: 1,sort_order: 0,is_enabled: 1,review_mode: 'single',review_profile_id: 'profile',review_policy_id: null,rework_profile_id: null,max_review_rounds: null },
  { id: 'experiment',name: 'Other Single',description: '',is_control: 0,weight: 1,sort_order: 1,is_enabled: 1,review_mode: 'single',review_profile_id: 'profile',review_policy_id: null,rework_profile_id: null,max_review_rounds: null },
] };
const assignment: api.CampaignAssignment={ id: 'assignment',campaign_id: c.id,campaign_name: c.name,arm_id: 'control',todo_id: 'todo',integrity_state: 'clean',integrity_reason: null,first_execution_at: null,review_started_at: null,campaign_definition_hash: 'campaign-hash',arm_definition_hash: 'arm-hash',assigned_review_config_hash: 'config-hash',arm_snapshot: c.arms[0],explanation: { algorithm: 'sha256_weighted_v1',bucket: 0,totalWeight: 2,rangeStart: 0,rangeEnd: 1 },feedback: null };
const m: api.CampaignMetrics={ assignments: 1,started: 1,reachedReview: 1,terminal: 1,completed: 1,failed: 0,stopped: 0,completionRate: 1,failureRate: 0,approvedFinalReview: 1,needsChangesFinalReview: 0,finalReviewSamples: 1,needsChangesRate: 0,todosWithRework: 0,reworkDenominator: 1,reworkRate: 0,manualApprove: 0,manualRework: 0,avgTodoDurationMs: null,p50TodoDurationMs: null,p95TodoDurationMs: null,durationSamples: 0,knownTodoCostUsd: null,todoCostKnown: 0,todoCostTotal: 1,todoCostCoverage: 0,knownTodoTokens: null,todoTokensKnown: 0,todoTokensTotal: 1,todoTokenCoverage: 0,knownTreatmentCostUsd: null,treatmentCostAttemptsKnown: 0,treatmentCostAttemptsTotal: 1,treatmentCostCoverage: 0,knownTreatmentIoTokens: null,treatmentTokenAttemptsKnown: 0,treatmentTokenAttemptsTotal: 1,treatmentTokenCoverage: 0,treatmentCostTodosFullyCovered: 0,treatmentCostTodosStarted: 1,treatmentCostTodoCoverage: 0,avgTreatmentCostUsd: null,p50TreatmentCostUsd: null,knownCacheReadTokens: null,cacheReadCoverage: 0,knownCacheCreationTokens: null,cacheCreationCoverage: 0,knownAttemptWallDurationMs: null,attemptWallDurationAttemptsKnown: 0,attemptWallDurationAttemptsTotal: 1,attemptWallDurationCoverage: 0,providerDurationAttemptsKnown: 0,providerDurationAttemptsTotal: 1,knownProviderDurationMs: null,providerDurationCoverage: 0,treatmentProcessAttempts: 1,lowSample: true,feedback: { responses: 0,evaluative: 0,denominator: 1,helpful: 0,notHelpful: 0,mixed: 0,unknown: 0,helpfulRate: null,responseCoverage: 0,evaluativeCoverage: 0 } };
const stats: api.CampaignAnalytics={ campaignId: c.id,totalAssigned: 2,arms: c.arms.map(a=>({ id: a.id!,name: a.name,isControl: !!a.is_control,weight: 1,expectedPercentage: .5,observedCount: 1,observedPercentage: .5,clean: 1,contaminated: 0,excluded: 0,attrition: m,itt: m,pp: { ...m,assignments: 0 },actualIdentities: { itt: {},pp: {} } })),comparisons: [] };
beforeEach(()=>{
  vi.clearAllMocks();localStorage.setItem('aikombinat-lang','en');
  vi.mocked(api.listCampaigns).mockResolvedValue([c]);vi.mocked(api.getCampaignAssignment).mockResolvedValue(assignment);vi.mocked(api.withdrawCampaignAssignment).mockResolvedValue({ ...assignment,integrity_state: 'excluded' });
  vi.mocked(api.getCampaignAnalytics).mockResolvedValue(stats);vi.mocked(api.getCampaignAssignments).mockResolvedValue({ total: 2,limit: 100,offset: 0,hasMore: false,assignments: [] });
});
describe('evaluation campaign UX',()=>{
  it('labels partial treatment cost with attempt coverage and renders unknowns as unavailable',async()=>{
    const partial={ ...m,knownTreatmentCostUsd: .04,treatmentCostAttemptsKnown: 2,treatmentCostAttemptsTotal: 3,treatmentCostCoverage: 2/3 };
    vi.mocked(api.getCampaignAnalytics).mockResolvedValue({ ...stats,arms: stats.arms.map(a=>({ ...a,itt: partial })) });
    render(<I18nProvider><EvaluationCampaignsPanel projectId="project" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button',{ name: 'Baseline' }));
    const cost=await screen.findByText(en['campaign.knownTreatmentCostUsd']);
    expect(within(cost.closest('tr')!).getAllByText('0.040')).toHaveLength(2);
    expect(within(screen.getByText(en['campaign.treatmentCostCoverage']).closest('tr')!).getAllByText('66.7%')).toHaveLength(2);
    expect(within(screen.getByText(en['campaign.p50TreatmentCostUsd']).closest('tr')!).getAllByText('—')).toHaveLength(2);
    expect(within(screen.getByText(en['campaign.knownTreatmentIoTokens']).closest('tr')!).getAllByText('—')).toHaveLength(2);
    expect(screen.getByText(en['campaign.costCaveat'],{ exact: false })).toBeInTheDocument();
    expect(screen.queryByText(en['campaign.knownTodoCostUsd'])).not.toBeInTheDocument();
  });
  it('defaults auto enrollment on, permits opt-out, and does not reveal the arm before creation',async()=>{
    const save=vi.fn();const { container }=render(<I18nProvider><TodoForm projectId="project" initialTitle="Task" onSave={save} onCancel={vi.fn()} /></I18nProvider>);
    const participate=await screen.findByRole('checkbox',{ name: en['campaign.participate'] });expect(participate).toBeChecked();expect(screen.queryByText('Other Single')).not.toBeInTheDocument();
    fireEvent.submit(container.querySelector('form')!);expect(save.mock.calls[0].at(-1)).toEqual({ evaluation_campaign_enroll: true,evaluation_campaign_id: c.id });
    fireEvent.click(participate);fireEvent.submit(container.querySelector('form')!);expect(save.mock.calls[1].at(-1)).toEqual({ evaluation_campaign_enroll: false });
  });
  it('locks review controls, offers explicit override and submits the override flag',async()=>{
    const save=vi.fn();const { container }=render(<I18nProvider><TodoForm projectId="project" todoId="todo" initialTitle="Task" initialReviewEnabled={1} initialReviewProfileId="profile" onSave={save} onCancel={vi.fn()} /></I18nProvider>);
    const button=await screen.findByRole('button',{ name: en['campaign.override'] });const fieldset=container.querySelector('fieldset')!;expect(fieldset).toBeDisabled();
    fireEvent.click(button);expect(fieldset).not.toBeDisabled();fireEvent.submit(container.querySelector('form')!);expect(save.mock.calls[0].at(-1)).toEqual({ evaluation_override: true });
  });
  it('withdrawal unlocks review fields, and feedback is unavailable before review',async()=>{
    const { container }=render(<I18nProvider><TodoForm projectId="project" todoId="todo" initialTitle="Task" onSave={vi.fn()} onCancel={vi.fn()} /></I18nProvider>);
    const withdraw=await screen.findByRole('button',{ name: en['campaign.withdraw'] });expect(screen.queryByRole('button',{ name: en['campaign.saveFeedback'] })).not.toBeInTheDocument();
    vi.mocked(api.getCampaignAssignment).mockResolvedValue({ ...assignment,integrity_state: 'excluded' });fireEvent.click(withdraw);
    await waitFor(()=>expect(container.querySelector('fieldset')).not.toBeDisabled());expect(api.withdrawCampaignAssignment).toHaveBeenCalledWith('todo','project');
  });
  it('saves independent helpfulness feedback after review and displays deterministic explanation',async()=>{
    vi.mocked(api.getCampaignAssignment).mockResolvedValue({ ...assignment,first_execution_at: 'time',review_started_at: 'time' });
    render(<I18nProvider><CampaignAssignmentDetails todoId="todo" projectId="project" /></I18nProvider>);
    const select=await screen.findByRole('combobox',{ name: en['campaign.feedback'] });fireEvent.change(select,{ target: { value: 'not_helpful' } });fireEvent.change(screen.getByRole('textbox',{ name: en['campaign.note'] }),{ target: { value: 'Useful note' } });
    fireEvent.click(screen.getByRole('button',{ name: en['campaign.saveFeedback'] }));await waitFor(()=>expect(api.saveCampaignFeedback).toHaveBeenCalledWith('todo','project','not_helpful','Useful note'));
    expect(screen.getByText(/sha256_weighted_v1/)).toBeInTheDocument();expect(screen.queryByRole('button',{ name: en['campaign.withdraw'] })).not.toBeInTheDocument();
  });
  it('refreshes an open Todo assignment when its review-start event arrives',async()=>{
    let listener: (event: WsEvent)=>void=()=>{};
    const onEvent=vi.fn((callback: (event: WsEvent)=>void)=>{ listener=callback;return vi.fn(); });
    render(<I18nProvider><CampaignAssignmentDetails todoId="todo" projectId="project" onEvent={onEvent} /></I18nProvider>);
    await screen.findByRole('button',{ name: en['campaign.withdraw'] });
    vi.mocked(api.getCampaignAssignment).mockResolvedValue({ ...assignment,first_execution_at: 'time',review_started_at: 'time' });
    listener({ type: 'evaluation-campaign:assignment-updated',projectId: 'project',campaignId: c.id,todoId: 'todo',status: 'running' });
    expect(await screen.findByRole('button',{ name: en['campaign.saveFeedback'] })).toBeInTheDocument();
    expect(screen.queryByRole('button',{ name: en['campaign.withdraw'] })).not.toBeInTheDocument();
  });
  it.each([['en',en],['ru',ru],['ko',ko]] as const)('renders lifecycle, editor, ITT/PP and CSV in %s without missing locale keys',async(lang,locale)=>{
    localStorage.setItem('aikombinat-lang',lang);
    const { container }=render(<I18nProvider><EvaluationCampaignsPanel projectId="project" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button',{ name: 'Baseline' }));const pp=await screen.findByRole('button',{ name: locale['campaign.pp'] });expect(screen.getByRole('button',{ name: locale['campaign.itt'] })).toHaveAttribute('aria-pressed','true');fireEvent.click(pp);expect(pp).toHaveAttribute('aria-pressed','true');
    fireEvent.click(screen.getByRole('button',{ name: locale['campaign.pause'] }));await waitFor(()=>expect(api.campaignAction).toHaveBeenCalledWith(c.id,'project','pause'));
    fireEvent.click(screen.getByRole('button',{ name: locale['campaign.csv'] }));await waitFor(()=>expect(api.downloadCampaignCsv).toHaveBeenCalledWith(c.id,'project'));
    expect(screen.getByText(locale['campaign.knownAttemptWallDurationMs'])).toBeInTheDocument();
    expect(screen.getByText(locale['campaign.knownProviderDurationMs'])).toBeInTheDocument();
    expect(screen.getByText(locale['campaign.attemptWallDurationCoverage'])).toBeInTheDocument();
    expect(screen.getByText(locale['campaign.providerDurationCoverage'])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{ name: locale['campaign.create'] }));const dialog=document.querySelector('[role="dialog"]') ?? document.body;
    expect(within(dialog as HTMLElement).getByText(locale['campaign.autoEnroll'])).toBeInTheDocument();expect(container.textContent).not.toContain('campaign.');

  });
});
