import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TodoForm from '../../components/TodoForm';
import { I18nProvider } from '../../i18n';

describe('TodoForm model selection', () => {
  beforeEach(() => {
    localStorage.setItem('clitrigger-lang', 'en');
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      json: () => Promise.resolve(url === '/api/models' ? {
        codex: [
          { value: 'gpt-current', label: 'GPT Current', availabilityStatus: 'available' },
          { value: 'gpt-retired', label: 'GPT Retired', status: 'missing' },
        ],
      } : [{ cliTool: 'codex', defaultLevel: 2 }]),
    })));
  });

  it('keeps a selected unavailable model visible but excludes it for new selection', async () => {
    const { unmount } = render(<I18nProvider><TodoForm onSave={vi.fn()} onCancel={vi.fn()} initialCliTool="codex" initialCliModel="gpt-retired" /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('option', { name: /GPT Retired.*Unavailable/ })).toBeInTheDocument());
    unmount();

    render(<I18nProvider><TodoForm onSave={vi.fn()} onCancel={vi.fn()} initialCliTool="codex" /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('option', { name: 'GPT Current' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /GPT Retired/ })).not.toBeInTheDocument();
  });
});
