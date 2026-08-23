import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AgentsSettingsPanel from '../../components/settings/AgentsSettingsPanel';
import { I18nProvider } from '../../i18n';

const catalog = {
  claude: [
    { id: 'c1', value: 'claude-opus-5', label: 'Opus 5', status: 'available', source: 'cli', supportedEfforts: ['high'], lastSeenAt: null, lastCheckedAt: null },
    { id: 'c2', value: 'claude-sonnet-5', label: 'Sonnet 5', status: 'available', source: 'cli', supportedEfforts: ['medium'], lastSeenAt: null, lastCheckedAt: null },
  ],
  codex: [
    { id: 'x1', value: 'gpt-current', label: 'GPT Current', status: 'available', source: 'cli', supportedEfforts: ['medium'], lastSeenAt: null, lastCheckedAt: null },
  ],
  antigravity: [
    { id: 'a1', value: 'gemini-missing', label: 'Gemini Missing', status: 'missing', source: 'cli', supportedEfforts: null, lastSeenAt: null, lastCheckedAt: null },
    { id: 'a2', value: 'gemini-current', label: 'Gemini Current', status: 'available', source: 'cli', supportedEfforts: null, lastSeenAt: null, lastCheckedAt: null },
  ],
};

const profiles = [{
  id: 'p1', slug: 'complex', name: 'Complex', description: 'Hard work', isEnabled: true, sortOrder: 0,
  executors: [{ id: 'e1', cliModelId: 'a1', cliTool: 'antigravity', modelValue: 'gemini-missing', modelLabel: 'Gemini Missing', modelStatus: 'missing', supportedEfforts: null, effortValue: null, priority: 0, isEnabled: true }],
}];

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body) };
}

describe('Agents settings model catalog and profiles UX', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem('clitrigger-lang', 'en');
    fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/models') return response(catalog);
      if (input.startsWith('/api/execution-profiles')) return response(profiles);
      if (init?.method === 'PATCH' && input.startsWith('/api/models/')) return response({});
      if (init?.method === 'DELETE') return response(undefined, 204);
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('separates tabs, preserves drafts, bulk-saves only one agent, and collapses sections', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    await screen.findByRole('tab', { name: 'Profiles' });
    expect(screen.getByRole('tab', { name: 'Models' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    const opus = await screen.findByLabelText('Claude Code claude-opus-5 Label');
    const sonnet = screen.getByLabelText('Claude Code claude-sonnet-5 Label');
    const codex = screen.getByLabelText('Codex gpt-current Label');
    fireEvent.change(opus, { target: { value: 'Opus edited' } });
    fireEvent.change(sonnet, { target: { value: 'Sonnet edited' } });
    fireEvent.change(codex, { target: { value: 'Codex edited' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Profiles' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    expect(screen.getByDisplayValue('Opus edited')).toBeInTheDocument();

    const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
    const codexSection = screen.getByText('Codex').closest('.rounded-xl') as HTMLElement;
    const claudeSave = within(claudeSection).getByRole('button', { name: 'Save' });
    const codexSave = within(codexSection).getByRole('button', { name: 'Save' });
    expect(claudeSave).toBeEnabled(); expect(codexSave).toBeEnabled();
    fireEvent.click(claudeSave);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/models/c') && init?.method === 'PATCH')).toHaveLength(2));
    await waitFor(() => expect(claudeSave).toBeDisabled());
    expect(codexSave).toBeEnabled();

    const claudeToggle = within(claudeSection).getByRole('button', { expanded: true });
    fireEvent.click(claudeToggle);
    expect(claudeToggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the current missing model representable and confirms destructive actions', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    await screen.findByDisplayValue('Complex');
    expect(screen.getByRole('option', { name: 'Gemini Missing (Missing)' })).toBeInTheDocument();

    const agentSelect = screen.getByLabelText('Agent 1');
    fireEvent.change(agentSelect, { target: { value: 'codex' } });
    expect(screen.getByRole('option', { name: 'GPT Current' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Gemini Missing (Missing)' })).not.toBeInTheDocument();

    vi.mocked(confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByTitle('Remove executor'));
    expect(screen.getByLabelText('Agent 1')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remove executor'));

    fireEvent.click(screen.getByTitle('Delete'));
    expect(confirm).toHaveBeenCalledWith('Delete profile "Complex"?');

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    fireEvent.click(screen.getByTitle('Delete Opus 5'));
    expect(confirm).toHaveBeenCalledWith('Delete model "Opus 5"?');
  });
});
