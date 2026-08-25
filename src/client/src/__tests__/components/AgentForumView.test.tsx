import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AgentForumView from '../../components/experiments/AgentForumView';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from '../../hooks/useToast';
import type { AgentForumDetail } from '../../types';

const mockForum: AgentForumDetail = {
  id: 'forum-1',
  project_id: null,
  title: 'Architecture Forum',
  rules: 'Be constructive and concise.',
  max_reply_length: 1024,
  status: 'idle',
  current_cycle: 1,
  current_member_id: null,
  created_at: '2026-08-25T10:00:00Z',
  updated_at: '2026-08-25T10:00:00Z',
  members: [
    {
      id: 'm1',
      forum_id: 'forum-1',
      name: 'Claude',
      role: 'architect',
      system_prompt: 'Focus on architecture',
      cli_tool: 'claude',
      cli_model: null,
      cli_model_id: null,
      execution_profile_id: null,
      cli_effort: null,
      avatar_color: '#8b5cf6',
      sort_order: 0,
      is_active: 1,
      created_at: '2026-08-25T10:00:00Z',
    },
    {
      id: 'm2',
      forum_id: 'forum-1',
      name: 'Codex',
      role: 'developer',
      system_prompt: 'Focus on code',
      cli_tool: 'codex',
      cli_model: null,
      cli_model_id: null,
      execution_profile_id: null,
      cli_effort: null,
      avatar_color: '#10b981',
      sort_order: 1,
      is_active: 1,
      created_at: '2026-08-25T10:00:00Z',
    },
  ],
  messages: [
    {
      id: 'msg-1',
      forum_id: 'forum-1',
      author_type: 'user',
      author_id: null,
      author_name: 'User',
      author_role: 'User',
      content: 'How should we handle caching?',
      parent_message_id: null,
      turn_id: null,
      created_at: '2026-08-25T10:01:00Z',
    },
    {
      id: 'msg-2',
      forum_id: 'forum-1',
      author_type: 'agent',
      author_id: 'm1',
      author_name: 'Claude',
      author_role: 'architect',
      content: 'Use an in-memory LRU cache.',
      parent_message_id: 'msg-1',
      turn_id: 'turn-1',
      created_at: '2026-08-25T10:02:00Z',
    },
  ],
  turns: [
    {
      id: 'turn-1',
      forum_id: 'forum-1',
      member_id: 'm1',
      cycle_number: 1,
      turn_order: 0,
      status: 'completed',
      execution_snapshot: null,
      raw_output: '{"replies":[{"replyTo":"msg-1","content":"Use an in-memory LRU cache."}]}',
      error_message: null,
      started_at: '2026-08-25T10:01:30Z',
      completed_at: '2026-08-25T10:02:00Z',
      created_at: '2026-08-25T10:01:30Z',
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function renderForumView(initialPath = '/experiments/agent-forum/forum-1', onEvent = vi.fn(() => () => {})) {
  return render(
    <ToastProvider>
      <I18nProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route
              path="/experiments/agent-forum/:forumId"
              element={<AgentForumView onEvent={onEvent} connected={true} />}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ToastProvider>
  );
}

describe('AgentForumView UI Component', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en');
    fetchMock = vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
      if (urlStr === '/api/projects') return jsonResponse([]);
      if (urlStr === '/api/agent-forums') return jsonResponse([mockForum]);
      if (urlStr === '/api/agent-forums/forum-1') return jsonResponse(mockForum);
      if (urlStr.startsWith('/api/models')) return jsonResponse({});
      if (urlStr.startsWith('/api/execution-profiles')) return jsonResponse([]);
      if (init?.method === 'PUT' && urlStr === '/api/agent-forums/forum-1') {
        const body = JSON.parse(init.body as string);
        return jsonResponse({ ...mockForum, ...body });
      }
      if (init?.method === 'POST' && urlStr === '/api/agent-forums/forum-1/messages') {
        const body = JSON.parse(init.body as string);
        const newMsg = {
          id: 'msg-3',
          forum_id: 'forum-1',
          author_type: 'user',
          author_id: null,
          author_name: 'User',
          author_role: 'User',
          content: body.content,
          parent_message_id: body.parent_message_id ?? null,
          turn_id: null,
          created_at: new Date().toISOString(),
        };
        return jsonResponse(newMsg, 201);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders forum details, participants, messages, and reply badges', async () => {
    renderForumView();

    // Forum Title in select option
    expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

    // Participants
    expect(screen.getAllByText('Claude').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('(architect)').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Codex').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('(developer)').length).toBeGreaterThanOrEqual(1);

    // Messages
    expect(screen.getByText('How should we handle caching?')).toBeInTheDocument();
    expect(screen.getByText('Use an in-memory LRU cache.')).toBeInTheDocument();

    // Reply relation
    expect(screen.getByText(/replied to @User/)).toBeInTheDocument();
  });

  it('switches between Chat view and Tree view', async () => {
    renderForumView();

    expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

    const treeButton = screen.getByRole('button', { name: /Tree/i });
    fireEvent.click(treeButton);

    // Tree renders the messages
    expect(screen.getByText('How should we handle caching?')).toBeInTheDocument();
    expect(screen.getByText('Use an in-memory LRU cache.')).toBeInTheDocument();
  });

  it('handles user reply target selection and sending message', async () => {
    renderForumView();

    expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

    // Click "Reply" on Claude's message
    const replyButtons = screen.getAllByRole('button', { name: /Reply/i });
    fireEvent.click(replyButtons[1]);

    // Target preview banner appears
    expect(screen.getByText(/Replying to/i)).toBeInTheDocument();

    // Type input
    const textarea = screen.getByPlaceholderText(/Reply to @Claude/i);
    fireEvent.change(textarea, { target: { value: 'What cache expiration TTL do you recommend?' } });

    // Submit
    const sendButton = screen.getByRole('button', { name: /Save/i });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-forums/forum-1/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            content: 'What cache expiration TTL do you recommend?',
            parent_message_id: 'msg-2',
          }),
        })
      );
    });
  });

  it('creates a new forum with neutral peer participants (no default critic/reviewer)', async () => {
    renderForumView();

    expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /New Forum/i }));

    const titleInput = await screen.findByPlaceholderText(/Database Architecture Discussion/i);
    fireEvent.change(titleInput, { target: { value: 'Neutral Forum' } });

    const saveButtons = screen.getAllByRole('button', { name: /^Save$/i });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-forums',
        expect.objectContaining({ method: 'POST' })
      );
    });

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/agent-forums' && (init as RequestInit | undefined)?.method === 'POST'
    )!;
    const payload = JSON.parse((createCall[1] as RequestInit).body as string);

    expect(payload.members).toHaveLength(3);
    // Every default participant is an equal peer.
    expect(payload.members.map((m: { role: string }) => m.role)).toEqual([
      'participant',
      'participant',
      'participant',
    ]);
    // Provider/model diversity is preserved.
    expect(payload.members.map((m: { cli_tool: string }) => m.cli_tool)).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);
    // No default participant is cast as critic / judge / reviewer.
    const promptText = payload.members
      .map((m: { role: string; system_prompt: string }) => `${m.role} ${m.system_prompt}`)
      .join(' ')
      .toLowerCase();
    expect(promptText).not.toMatch(/critic|judge|reviewer|architect/);
  });

  it('locks configuration and participant controls while a cycle is running', async () => {
    const runningForum = { ...mockForum, status: 'running' as const, current_member_id: 'm1' };
    fetchMock.mockImplementation(async (input: string | Request | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
      if (urlStr === '/api/projects') return jsonResponse([]);
      if (urlStr === '/api/agent-forums') return jsonResponse([runningForum]);
      if (urlStr === '/api/agent-forums/forum-1') return jsonResponse(runningForum);
      if (urlStr.startsWith('/api/models')) return jsonResponse({});
      if (urlStr.startsWith('/api/execution-profiles')) return jsonResponse([]);
      return jsonResponse({});
    });

    renderForumView();

    expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '512' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Rules/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Add participant/i })).toBeDisabled();
    // The project-context selector is locked too.
    const selects = screen.getAllByRole('combobox');
    expect(selects.some((el) => (el as HTMLSelectElement).disabled)).toBe(true);

    // Clicking a locked control issues no mutation request.
    fireEvent.click(screen.getByRole('button', { name: '512' }));
    fireEvent.click(screen.getByRole('button', { name: /Add participant/i }));
    await waitFor(() => {
      const mutations = fetchMock.mock.calls.filter(([, init]) => {
        const method = (init as RequestInit | undefined)?.method;
        return method === 'PUT' || method === 'POST' || method === 'DELETE';
      });
      expect(mutations).toHaveLength(0);
    });
  });

  it('updates max reply length pill selection', async () => {
    renderForumView();

    expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

    const pill512 = screen.getByRole('button', { name: '512' });
    fireEvent.click(pill512);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agent-forums/forum-1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ max_reply_length: 512 }),
        })
      );
    });
  });

  describe('forum awaiting recovery (status=error)', () => {
    const errorForum = { ...mockForum, status: 'error' as const, current_member_id: null };

    /** Serves an error forum; `onStop` decides what POST /stop answers. */
    function mockErrorForum(onStop: () => { status: number; body: unknown }) {
      let current: typeof mockForum = errorForum;
      fetchMock.mockImplementation(async (input: string | Request | URL, init?: RequestInit) => {
        const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        if (urlStr === '/api/projects') return jsonResponse([]);
        if (urlStr === '/api/agent-forums') return jsonResponse([current]);
        if (urlStr === '/api/agent-forums/forum-1/stop' && init?.method === 'POST') {
          const result = onStop();
          if (result.status < 300) current = result.body as typeof mockForum;
          return jsonResponse(result.body, result.status);
        }
        if (urlStr === '/api/agent-forums/forum-1') return jsonResponse(current);
        if (urlStr.startsWith('/api/models')) return jsonResponse({});
        if (urlStr.startsWith('/api/execution-profiles')) return jsonResponse([]);
        return jsonResponse({});
      });
    }

    it('locks the composer and configuration controls, and shows the recovery banner', async () => {
      mockErrorForum(() => ({ status: 503, body: { error: 'still cleaning up' } }));
      renderForumView();

      expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

      // Prominent recovery status + retry affordance.
      expect(screen.getByText(/Stop incomplete — recovery required/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry Stop/i })).toBeEnabled();

      // Composer is disabled and says why.
      const composer = screen.getByPlaceholderText(/Stop incomplete — recovery required/i);
      expect(composer).toBeDisabled();

      // Configuration and participant controls are disabled.
      expect(screen.getByRole('button', { name: '512' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Rules/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Add participant/i })).toBeDisabled();
      const selects = screen.getAllByRole('combobox');
      expect(selects.some((el) => (el as HTMLSelectElement).disabled)).toBe(true);

      // Clicking a locked control issues no mutation.
      fireEvent.click(screen.getByRole('button', { name: '512' }));
      await waitFor(() => {
        const mutations = fetchMock.mock.calls.filter(([url, init]) => {
          const method = (init as RequestInit | undefined)?.method;
          return method === 'PUT' || (method === 'POST' && !String(url).endsWith('/stop')) || method === 'DELETE';
        });
        expect(mutations).toHaveLength(0);
      });
    });

    it('returns the UI to idle after a successful Retry Stop', async () => {
      const recovered = { ...mockForum, status: 'idle' as const, current_member_id: null };
      mockErrorForum(() => ({ status: 200, body: recovered }));
      renderForumView();

      expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Retry Stop/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/agent-forums/forum-1/stop',
          expect.objectContaining({ method: 'POST' })
        );
      });

      // Banner gone, composer usable again.
      await waitFor(() => {
        expect(screen.queryByText(/Stop incomplete — recovery required/i)).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /Retry Stop/i })).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Ask the forum|Type/i)).toBeEnabled();
    });

    it('stays in recovery and keeps the retry button after another 503', async () => {
      mockErrorForum(() => ({ status: 503, body: { error: 'orphan still alive', code: 'forum_stop_incomplete' } }));
      renderForumView();

      expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Retry Stop/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          '/api/agent-forums/forum-1/stop',
          expect.objectContaining({ method: 'POST' })
        );
      });

      // Still in recovery, retry still offered.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Retry Stop/i })).toBeEnabled();
      });
      expect(screen.getByText(/Stop incomplete — recovery required/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Stop incomplete — recovery required/i)).toBeDisabled();
    });

    it('does not regress the running-state behaviour', async () => {
      const runningForum = { ...mockForum, status: 'running' as const, current_member_id: 'm1' };
      fetchMock.mockImplementation(async (input: string | Request | URL) => {
        const urlStr = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        if (urlStr === '/api/projects') return jsonResponse([]);
        if (urlStr === '/api/agent-forums') return jsonResponse([runningForum]);
        if (urlStr === '/api/agent-forums/forum-1') return jsonResponse(runningForum);
        if (urlStr.startsWith('/api/models')) return jsonResponse({});
        if (urlStr.startsWith('/api/execution-profiles')) return jsonResponse([]);
        return jsonResponse({});
      });

      renderForumView();
      expect(await screen.findByText('Architecture Forum')).toBeInTheDocument();

      // Running shows the live cycle affordances, not the recovery ones.
      expect(screen.queryByText(/Stop incomplete — recovery required/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Retry Stop/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '512' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Add participant/i })).toBeDisabled();
    });
  });
});
