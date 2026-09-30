import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '../../i18n';
import OrchestratorPanel from '../../components/OrchestratorPanel';
import * as api from '../../api/orchestrators';
import * as profiles from '../../api/executionProfiles';

vi.mock('../../api/orchestrators', () => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), control: vi.fn(), messages: vi.fn(), send: vi.fn(), children: vi.fn(), resources: vi.fn(), turns: vi.fn(), release: vi.fn() }));
vi.mock('../../api/executionProfiles', () => ({ getProfiles: vi.fn() }));
let current: api.Orchestration;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  current = { id: 'o1', project_id: 'p1', title: 'Utility goal', objective: 'Build utility', status: 'waiting_event', primary_execution_profile_id: 'claude-profile', state_summary: 'Reviewed first child', current_plan: 'Integrate branches', waiting_reason: 'Child completion', wake_condition_json: null, max_turns: 32, max_children: 24, max_concurrent_children: 4, max_active_resource_requests: 2, turn_count: 2, child_count: 1 };
  vi.mocked(api.list).mockImplementation(async () => [current]);
  vi.mocked(api.messages).mockResolvedValue([{ id: 'm1', role: 'assistant', content: 'Child created', created_at: '2026-09-30' }]);
  vi.mocked(api.children).mockResolvedValue([{ id: 'child', todo_id: 'todo1', title: 'Implementation', status: 'completed', pipeline_phase: null, summary: 'Tests passed', execution_profile_id: 'cheap' }]);
  vi.mocked(api.resources).mockResolvedValue([{ request_id: 'resource', purpose: 'Training CPU', status: 'bound', claim_expires_at: null, claimed_todo_id: null, requirements: {}, binding: null }]);
  vi.mocked(api.turns).mockResolvedValue([{ id: 'turn1', turn_index: 1, status: 'completed', process_pid: 0, execution_snapshot: null, error_message: null }]);
  vi.mocked(profiles.getProfiles).mockResolvedValue([
    { id: 'claude-profile', name: 'Strong Claude', slug: 'strong', description: '', isEnabled: true, sortOrder: 0, executors: [{ id: 'e1', cliModelId: 'm1', cliTool: 'claude', modelValue: 'opus', modelLabel: 'Opus', modelStatus: 'available', supportedEfforts: null, effortValue: null, priority: 0, isEnabled: true }] },
    { id: 'codex-only', name: 'Codex Only', slug: 'codex', description: '', isEnabled: true, sortOrder: 1, executors: [{ id: 'e2', cliModelId: 'm2', cliTool: 'codex', modelValue: 'gpt', modelLabel: 'GPT', modelStatus: 'available', supportedEfforts: null, effortValue: null, priority: 0, isEnabled: true }] },
  ]);
});
function panel() { return render(<MemoryRouter><I18nProvider><OrchestratorPanel projectId="p1" connected onEvent={() => () => undefined} /></I18nProvider></MemoryRouter>); }
describe('Orchestrator panel', () => {
  it('shows explicit checkpoint/chat, ordinary child links, resource holds and waiting PID', async () => {
    panel(); await screen.findByText('Integrate branches');
    expect(screen.getByText('Reviewed first child')).toBeInTheDocument();
    expect(await screen.findByText('Child created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Implementation' })).toHaveAttribute('href', '/projects/p1?tab=tasks&todo=todo1');
    expect(screen.getByText('Training CPU · Reserved')).toBeInTheDocument();
    expect(screen.getByText(/PID 0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(api.release).toHaveBeenCalledWith('o1','resource'));
  });
  it('creates with Claude profiles and budgets and sends exact user message', async () => {
    panel(); await screen.findByText('Integrate branches');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'New constraint' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith('o1','New constraint'));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.queryByRole('option', { name: 'Codex Only' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New goal' } });
    fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Ship utility' } });
    fireEvent.change(screen.getByLabelText('Primary Claude profile'), { target: { value: 'claude-profile' } });
    vi.mocked(api.create).mockResolvedValue(current);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('p1', { title: 'New goal', objective: 'Ship utility', primary_execution_profile_id: 'claude-profile', max_turns: 32, max_children: 24, max_concurrent_children: 4, max_active_resource_requests: 2 }));
  });
  it('uses pause/resume/cancel controls and removes release for child-owned holds', async () => {
    vi.mocked(api.resources).mockResolvedValue([{ request_id: 'r', purpose: 'Child CPU', status: 'claimed', claimed_todo_id: 'todo1', claim_expires_at: null, requirements: {}, binding: null }]);
    const view = panel(); await screen.findByText('Integrate branches');
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('o1','pause'));
    current = { ...current, status: 'paused' }; view.unmount(); panel();
    await screen.findByRole('button', { name: 'Resume' });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith('o1','resume'));
  });
});
