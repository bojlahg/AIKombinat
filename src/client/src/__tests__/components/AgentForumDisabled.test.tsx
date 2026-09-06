import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Sidebar from '../../components/Sidebar';
import AgentForumRoute from '../../components/experiments/AgentForumRoute';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from '../../hooks/useToast';
import { DialogProvider } from '../../hooks/useDialog';
import { resetFeatureFlagsCache } from '../../hooks/useFeatures';

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

  function renderForumRoute(initialPath: string, enabled: boolean) {
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
});
