import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AgentsSettingsPanel from '../../components/settings/AgentsSettingsPanel';
import { I18nProvider } from '../../i18n';

const catalog = {
  claude: [
    { id: 'c1', value: 'claude-opus-5', label: 'Opus 5', status: 'available', source: 'cli', supportedEfforts: ['high'], sortOrder: 0, lastSeenAt: null, lastCheckedAt: null },
    { id: 'c2', value: 'claude-sonnet-5', label: 'Sonnet 5', status: 'available', source: 'cli', supportedEfforts: ['medium'], sortOrder: 1, lastSeenAt: null, lastCheckedAt: null },
  ],
  codex: [
    { id: 'x1', value: 'gpt-current', label: 'GPT Current', status: 'available', source: 'cli', supportedEfforts: ['medium'], sortOrder: 0, lastSeenAt: null, lastCheckedAt: null },
    { id: 'x2', value: 'gpt-next', label: 'GPT Next', status: 'available', source: 'cli', supportedEfforts: ['high'], sortOrder: 1, lastSeenAt: null, lastCheckedAt: null },
  ],
  antigravity: [
    { id: 'a1', value: 'gemini-missing', label: 'Gemini Missing', status: 'missing', source: 'cli', supportedEfforts: null, sortOrder: 0, lastSeenAt: null, lastCheckedAt: null },
    { id: 'a2', value: 'gemini-3.7-flash-high', label: 'Gemini High Slug', status: 'available', source: 'cli', supportedEfforts: null, sortOrder: 1, lastSeenAt: null, lastCheckedAt: null },
    { id: 'a3', value: 'gemini-known', label: 'Gemini Known', status: 'available', source: 'cli', supportedEfforts: ['high'], sortOrder: 2, lastSeenAt: null, lastCheckedAt: null },
  ],
};

const profiles = [{
  id: 'p1', slug: 'complex', name: 'Complex', description: 'Hard work', isEnabled: true, sortOrder: 0,
  executors: [
    { id: 'e1', cliModelId: 'a1', cliTool: 'antigravity', modelValue: 'gemini-missing', modelLabel: 'Gemini Missing', modelStatus: 'missing', supportedEfforts: null, effortValue: 'custom', priority: 0, isEnabled: true },
    { id: 'e2', cliModelId: 'a2', cliTool: 'antigravity', modelValue: 'gemini-3.7-flash-high', modelLabel: 'Gemini High Slug', modelStatus: 'available', supportedEfforts: null, effortValue: null, priority: 1, isEnabled: true },
    { id: 'e3', cliModelId: 'a3', cliTool: 'antigravity', modelValue: 'gemini-known', modelLabel: 'Gemini Known', modelStatus: 'available', supportedEfforts: ['high'], effortValue: 'high', priority: 2, isEnabled: true },
  ],
}];

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body) };
}

describe('Agents settings model catalog and profiles UX', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en');
    fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/models') return response(catalog);
      if (input.startsWith('/api/models/refresh/')) return response({ source: 'test', authoritative: true, added: 0, updated: 1, restored: 0, markedMissing: 0 });
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

  it('persists model reorder as part of only that agent dirty state', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Models' }));
    const opusRow = screen.getByLabelText('Claude Code claude-opus-5 Label').closest('.grid') as HTMLElement;
    fireEvent.click(within(opusRow).getByTitle('Move model down'));
    expect(screen.getAllByLabelText(/Claude Code .* Label/).map((input) => (input as HTMLInputElement).value)).toEqual(['Sonnet 5', 'Opus 5']);

    const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
    const save = within(claudeSection).getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api/models/c') && init?.method === 'PATCH')).toHaveLength(2));
    const payloads = Object.fromEntries(fetchMock.mock.calls
      .filter(([url, init]) => String(url).startsWith('/api/models/c') && init?.method === 'PATCH')
      .map(([url, init]) => [String(url).split('/').pop(), JSON.parse(String(init?.body))]));
    expect(payloads).toMatchObject({ c1: { sortOrder: 1 }, c2: { sortOrder: 0 } });
  });

  it('shows only Name and Description and keeps selects working across collapse cycles', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    await screen.findByDisplayValue('Complex');
    expect(screen.queryByLabelText('Slug')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Description for planning agents')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /Complex/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);

    fireEvent.change(screen.getByLabelText('Agent 1'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Model Catalog 1'), { target: { value: 'x2' } });
    fireEvent.change(screen.getByLabelText('Effort 1'), { target: { value: 'high' } });
    expect(screen.getByLabelText('Agent 1')).toHaveValue('codex');
    expect(screen.getByLabelText('Model Catalog 1')).toHaveValue('x2');
    expect(screen.getByLabelText('Effort 1')).toHaveValue('high');

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Agent 1')).toHaveValue('codex');
    expect(screen.getByLabelText('Model Catalog 1')).toHaveValue('x2');
    fireEvent.change(screen.getByLabelText('Model Catalog 1'), { target: { value: 'x1' } });
    fireEvent.change(screen.getByLabelText('Effort 1'), { target: { value: 'medium' } });
    expect(screen.getByLabelText('Effort 1')).toHaveValue('medium');
  });

  it('does not invent Antigravity efforts and preserves saved custom values', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    await screen.findByDisplayValue('Complex');

    const savedUnknown = screen.getByLabelText('Effort 1');
    expect(within(savedUnknown).getByRole('option', { name: 'custom (Capabilities unknown)' })).toBeInTheDocument();
    expect(screen.getByText('This saved effort remains selected, but the model did not report effort capabilities.')).toBeInTheDocument();
    expect(within(savedUnknown).queryByRole('option', { name: 'low' })).not.toBeInTheDocument();

    const qualifiedSlug = screen.getByLabelText('Effort 2');
    expect(within(qualifiedSlug).getAllByRole('option').map((option) => option.textContent)).toEqual(['Default']);

    const knownCapabilities = screen.getByLabelText('Effort 3');
    expect(within(knownCapabilities).getAllByRole('option').map((option) => option.textContent)).toEqual(['Default', 'high']);
    expect(within(knownCapabilities).queryByRole('option', { name: 'medium' })).not.toBeInTheDocument();
  });

  it('protects dirty agent drafts before refresh and refreshes after confirmation', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Models' }));
    const opus = screen.getByLabelText('Claude Code claude-opus-5 Label');
    fireEvent.change(opus, { target: { value: 'Unsaved Opus' } });
    const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
    const refresh = within(claudeSection).getByRole('button', { name: 'Refresh' });

    vi.mocked(confirm).mockReturnValueOnce(false);
    fireEvent.click(refresh);
    expect(confirm).toHaveBeenCalledWith('Unsaved changes for Claude Code will be lost. Refresh anyway?');
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/models/refresh/claude')).toBe(false);
    expect(screen.getByDisplayValue('Unsaved Opus')).toBeInTheDocument();

    vi.mocked(confirm).mockReturnValueOnce(true);
    fireEvent.click(refresh);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/models/refresh/claude')).toBe(true));
    await waitFor(() => expect(screen.getByDisplayValue('Opus 5')).toBeInTheDocument());
  });

  it('refreshes a clean agent without confirmation', async () => {
    render(<I18nProvider><AgentsSettingsPanel /></I18nProvider>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Models' }));
    const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
    fireEvent.click(within(claudeSection).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/models/refresh/claude')).toBe(true));
    expect(confirm).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getAllByTitle('Remove executor')[0]);
    expect(screen.getByLabelText('Agent 1')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remove executor'));

    fireEvent.click(screen.getByTitle('Delete'));
    expect(confirm).toHaveBeenCalledWith('Delete profile "Complex"?');

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    fireEvent.click(screen.getByTitle('Delete Opus 5'));
    expect(confirm).toHaveBeenCalledWith('Delete model "Opus 5"?');
  });

  it('updates targeted agent quota badge upon receiving quota:updated WebSocket event without full reload', async () => {
    let wsCallback: ((event: any) => void) | undefined;
    const unsubSpy = vi.fn();
    const onEvent = vi.fn((cb: (event: any) => void) => {
      wsCallback = cb;
      return unsubSpy;
    });

    const { unmount } = render(
      <I18nProvider>
        <AgentsSettingsPanel onEvent={onEvent} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Models' }));
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();

    const initialFetchCount = fetchMock.mock.calls.length;

    // Simulate quota:updated WS event for Claude
    expect(wsCallback).toBeDefined();
    wsCallback!({
      type: 'quota:updated',
      tool: 'claude',
      state: 'exhausted',
      reason: 'Usage limit reached',
      resetAt: '2026-08-24T12:00:00.000Z',
    });

    // Claude badge updates to Exhausted
    await waitFor(() => {
      const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
      expect(within(claudeSection).getByText(/Exhausted/)).toBeInTheDocument();
    });

    // Other agents remain Unknown
    const codexSection = screen.getByText('Codex').closest('.rounded-xl') as HTMLElement;
    expect(within(codexSection).getByText(/Unknown/)).toBeInTheDocument();

    // No extra fetch calls made
    expect(fetchMock.mock.calls.length).toBe(initialFetchCount);

    // Transition exhausted -> available: clears reason and resetAt
    wsCallback!({
      type: 'quota:updated',
      tool: 'claude',
      state: 'available',
    });

    await waitFor(() => {
      const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
      expect(within(claudeSection).getByText(/Available/)).toBeInTheDocument();
      expect(within(claudeSection).queryByText(/Exhausted/)).not.toBeInTheDocument();
      expect(within(claudeSection).queryByText(/resets/i)).not.toBeInTheDocument();
    });

    // Re-exhaust Claude with reason and resetAt
    wsCallback!({
      type: 'quota:updated',
      tool: 'claude',
      state: 'exhausted',
      reason: 'Monthly limit reached',
      resetAt: '2026-08-24T15:00:00.000Z',
    });

    await waitFor(() => {
      const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
      expect(within(claudeSection).getByText(/Exhausted/)).toBeInTheDocument();
    });

    // Transition exhausted -> unknown: clears resetAt, updates reason
    wsCallback!({
      type: 'quota:updated',
      tool: 'claude',
      state: 'unknown',
      reason: 'Cooldown expired',
    });

    await waitFor(() => {
      const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
      expect(within(claudeSection).getByText(/Unknown/)).toBeInTheDocument();
      expect(within(claudeSection).queryByText(/resets/i)).not.toBeInTheDocument();
    });

    // Ignore invalid tool or invalid state WebSocket events
    wsCallback!({
      type: 'quota:updated',
      tool: 'invalid-tool',
      state: 'exhausted',
    });
    wsCallback!({
      type: 'quota:updated',
      tool: 'claude',
      state: 'invalid-state',
    });

    // Claude badge remains Unknown
    const claudeSection = screen.getByText('Claude Code').closest('.rounded-xl') as HTMLElement;
    expect(within(claudeSection).getByText(/Unknown/)).toBeInTheDocument();

    // Unmount triggers unsubscribe
    unmount();
    expect(unsubSpy).toHaveBeenCalled();
  });
});
