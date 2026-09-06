import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Sidebar from '../../components/Sidebar';
import AgentForumRoute from '../../components/experiments/AgentForumRoute';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from '../../hooks/useToast';
import { DialogProvider } from '../../hooks/useDialog';
import { resetFeatureFlagsCache, useAgentForumEnabled } from '../../hooks/useFeatures';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('AgentForum disabled UI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let forumFetchCount: number;
  let featuresImpl: () => Promise<unknown>;

  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en');
    resetFeatureFlagsCache();
    forumFetchCount = 0;
    featuresImpl = async () => jsonResponse({ agentForum: false });
    fetchMock = vi.fn(async (input: string | Request | URL) => {
      const urlStr = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (urlStr === '/api/features') return featuresImpl();
      if (urlStr === '/api/projects') return jsonResponse([]);
      if (urlStr.startsWith('/api/review/summary')) return jsonResponse({ total_todos: 0 });
      if (urlStr === '/api/favorites') return jsonResponse([]);
      if (urlStr === '/api/tunnel/status') return jsonResponse({ status: 'stopped', url: null });
      if (urlStr === '/api/agent-forums') {
        forumFetchCount += 1;
        return jsonResponse([]);
      }
      if (urlStr.startsWith('/api/agent-forums/')) {
        forumFetchCount += 1;
        const forumId = urlStr.split('/').pop() ?? 'forum-1';
        return jsonResponse({
          id: forumId,
          project_id: null,
          title: 'Forum 1',
          rules: '',
          max_reply_length: 1024,
          status: 'idle',
          current_cycle: 0,
          current_member_id: null,
          created_at: '2026-08-25T10:00:00Z',
          updated_at: '2026-08-25T10:00:00Z',
          members: [],
          messages: [],
          turns: [],
        });
      }
      if (urlStr.startsWith('/api/agent-forums')) {
        forumFetchCount += 1;
        return jsonResponse([]);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetFeatureFlagsCache();
  });

  function renderSidebar(collapsed = false) {
    return render(
      <ToastProvider>
        <DialogProvider>
          <I18nProvider>
            <MemoryRouter initialEntries={['/']}>
              <Sidebar
                onLogout={vi.fn()}
                authRequired={false}
                connected={true}
                onEvent={vi.fn(() => () => {})}
                collapsed={collapsed}
              />
            </MemoryRouter>
          </I18nProvider>
        </DialogProvider>
      </ToastProvider>,
    );
  }

  function renderForumRoute(initialPath: string, enabled: boolean | null) {
    return render(
      <ToastProvider>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/" element={<div>Home</div>} />
              <Route
                path="/experiments/agent-forum"
                element={<AgentForumRoute enabled={enabled} onEvent={vi.fn(() => () => {})} connected={true} />}
              />
              <Route
                path="/experiments/agent-forum/:forumId"
                element={<AgentForumRoute enabled={enabled} onEvent={vi.fn(() => () => {})} connected={true} />}
              />
            </Routes>
          </MemoryRouter>
        </I18nProvider>
      </ToastProvider>,
    );
  }

  it('hides the AgentForum navigation entry when the feature is disabled', async () => {
    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/features',
      expect.anything(),
    ));

    await waitFor(() => {
      expect(screen.queryByText('AgentForum')).not.toBeInTheDocument();
      expect(screen.queryByText('Experiments')).not.toBeInTheDocument();
    });

    // Ordinary navigation keeps working.
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Review Queue')).toBeInTheDocument();
    expect(screen.getByText('My Schedule')).toBeInTheDocument();
  });

  it('hides the collapsed-rail AgentForum icon when the feature is disabled', async () => {
    renderSidebar(true);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/features',
      expect.anything(),
    ));

    await waitFor(() => {
      expect(screen.queryByTitle('AgentForum')).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('Home')).toBeInTheDocument();
  });

  it('stays hidden (fail-closed) when the features request fails', async () => {
    featuresImpl = async () => {
      throw new Error('network down');
    };
    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/features',
      expect.anything(),
    ));
    // Give the rejection a chance to settle into state.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText('AgentForum')).not.toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('shows the AgentForum navigation entry when the server enables it', async () => {
    featuresImpl = async () => jsonResponse({ agentForum: true });
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByText('AgentForum')).toBeInTheDocument();
    });
    expect(screen.getByText('Experiments')).toBeInTheDocument();
  });

  it('redirects a direct forum deep-link without fetching forum state when disabled', async () => {
    renderForumRoute('/experiments/agent-forum/forum-1', false);

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    expect(screen.queryByText('AgentForum')).not.toBeInTheDocument();
    expect(forumFetchCount).toBe(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/agent-forums'))).toBe(false);
  });

  it('renders no Create/Send controls on the disabled forum root route', async () => {
    renderForumRoute('/experiments/agent-forum', false);

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });

    expect(forumFetchCount).toBe(0);
  });

  it('renders a loading placeholder (no redirect, no forum fetch) while the feature state is unknown', async () => {
    renderForumRoute('/experiments/agent-forum/forum-1', null);

    expect(await screen.findByTestId('agent-forum-loading')).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(forumFetchCount).toBe(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/agent-forums'))).toBe(false);
  });

  function renderColdDeepLink(initialPath: string) {
    function ColdGate() {
      const enabled = useAgentForumEnabled(true);
      return (
        <Routes>
          <Route path="/" element={<div>Home</div>} />
          <Route
            path="/experiments/agent-forum"
            element={<AgentForumRoute enabled={enabled} onEvent={vi.fn(() => () => {})} connected={true} />}
          />
          <Route
            path="/experiments/agent-forum/:forumId"
            element={<AgentForumRoute enabled={enabled} onEvent={vi.fn(() => () => {})} connected={true} />}
          />
        </Routes>
      );
    }
    return render(
      <ToastProvider>
        <I18nProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <ColdGate />
          </MemoryRouter>
        </I18nProvider>
      </ToastProvider>,
    );
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('cold deep-link with delayed enabled response: no redirect before, forum opens after true', async () => {
    const gate = deferred<unknown>();
    featuresImpl = () => gate.promise;
    forumFetchCount = 0;
    renderColdDeepLink('/experiments/agent-forum/forum-1');

    // Before the features response: loading placeholder, no Home, no forum fetch.
    expect(await screen.findByTestId('agent-forum-loading')).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(forumFetchCount).toBe(0);

    gate.resolve(jsonResponse({ agentForum: true }));

    // After true: route stays mounted, forum state is fetched, still no Home.
    await waitFor(() => {
      expect(forumFetchCount).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('agent-forum-loading')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
  });

  it('cold deep-link with delayed disabled response: redirects home without fetching forum state', async () => {
    const gate = deferred<unknown>();
    featuresImpl = () => gate.promise;
    forumFetchCount = 0;
    renderColdDeepLink('/experiments/agent-forum/forum-1');

    expect(await screen.findByTestId('agent-forum-loading')).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(forumFetchCount).toBe(0);

    gate.resolve(jsonResponse({ agentForum: false }));

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('agent-forum-loading')).not.toBeInTheDocument();
    expect(forumFetchCount).toBe(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/agent-forums'))).toBe(false);
  });

  it('cold deep-link fails closed when the features request fails', async () => {
    const gate = deferred<unknown>();
    featuresImpl = () => gate.promise;
    forumFetchCount = 0;
    renderColdDeepLink('/experiments/agent-forum/forum-1');

    expect(await screen.findByTestId('agent-forum-loading')).toBeInTheDocument();

    gate.reject(new Error('network down'));

    await waitFor(() => {
      expect(screen.getByText('Home')).toBeInTheDocument();
    });
    expect(forumFetchCount).toBe(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/agent-forums'))).toBe(false);
  });

  it('keeps the sidebar hidden while unknown, then shows it once enabled', async () => {
    const gate = deferred<unknown>();
    featuresImpl = () => gate.promise;
    renderSidebar();

    // Unknown: no AgentForum entry yet (and no flash of forum controls).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/features',
      expect.anything(),
    ));
    expect(screen.queryByText('AgentForum')).not.toBeInTheDocument();

    gate.resolve(jsonResponse({ agentForum: true }));

    await waitFor(() => {
      expect(screen.getByText('AgentForum')).toBeInTheDocument();
    });
  });
});
