import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ScheduleForm from '../../components/ScheduleForm';
import AgentManager from '../../components/AgentManager';
import { I18nProvider } from '../../i18n';

const catalog = {
  codex: [
    { value: 'current', label: 'Current', availabilityStatus: 'available', supportedEfforts: ['low', 'high'] },
    { value: 'retired', label: 'Retired', availabilityStatus: 'unavailable', deprecated: true, supportedEfforts: ['low'] },
  ],
};

describe('shared execution model selectors', () => {
  beforeEach(() => {
    localStorage.setItem('clitrigger-lang', 'en');
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ json: () => Promise.resolve(url === '/api/models' ? catalog : []) })));
  });

  it('ScheduleForm excludes unavailable models for new selection and preserves a previous selection', async () => {
    const props = { onSave: vi.fn(), onCancel: vi.fn(), initialCliTool: 'codex', initialTitle: 'Run', initialCronExpression: '0 0 * * *' };
    const { unmount } = render(<I18nProvider><ScheduleForm {...props} /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Current' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Retired/ })).not.toBeInTheDocument();
    unmount();
    render(<I18nProvider><ScheduleForm {...props} initialCliModel="retired" /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('option', { name: /Retired.*Unavailable/ })).toBeInTheDocument());
  });

  it('Discussion AgentManager uses the same unavailable model filtering', async () => {
    render(<I18nProvider><AgentManager projectId="project" agents={[]} onAgentsChange={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Add agent/i }));
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'codex' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Current' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /Retired/ })).not.toBeInTheDocument();
  });
});
