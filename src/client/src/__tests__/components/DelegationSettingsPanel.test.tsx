import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import DelegationSettingsPanel from '../../components/settings/DelegationSettingsPanel';
import { I18nProvider } from '../../i18n';
import { ToastProvider } from '../../hooks/useToast';

const settings = {
  enabled: false, mode: 'telemetry', workerExecutionProfileId: null,
  fullFileThresholdLines: 400, maxTargetedReadLines: 250, maxInputBytes: 1048576,
  maxInputLines: 20000, maxWorkerRanges: 8, maxTotalRecommendedLines: 800,
  workerTimeoutSeconds: 60, telemetryRetentionDays: 30, workerProfile: null,
};
const profiles = [{
  id: 'worker', slug: 'worker', name: 'Fast reader', description: '', isEnabled: true, sortOrder: 0,
  executors: [{ id: 'executor', cliModelId: 'model', cliTool: 'antigravity', modelValue: 'gemini-flash', modelLabel: 'Gemini Flash', modelStatus: 'available', supportedEfforts: ['low'], effortValue: 'low', priority: 0, isEnabled: true }],
}];
const hooks = [
  { provider: 'claude', state: 'installed_unverified', installed: true, verified: false, needsTrust: false, version: '1.0', error: null },
  { provider: 'codex', state: 'needs_trust', installed: true, verified: false, needsTrust: true, version: '0.149.0', error: null },
];
const stats = { toolObservations: 12, largeReadsObserved: 3, averageHookLatencyMs: 5, bulkReadRuns: 2, bulkReadSucceeded: 1, fallbacks: 1, sourceCharsProcessed: 1000, returnedChars: 200, contextAvoidedChars: 800, workerInputTokens: null, workerOutputTokens: null, averageLatencyMs: 40 };

function response(body: unknown) { return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; }

describe('Delegation settings UI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en');
    fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/delegation' && !init?.method) return response(settings);
      if (input.startsWith('/api/execution-profiles')) return response(profiles);
      if (input === '/api/delegation/hooks') return response(hooks);
      if (input === '/api/delegation/statistics') return response(stats);
      if (input === '/api/delegation/settings' && init?.method === 'PUT') return response({ ...settings, ...JSON.parse(String(init.body)) });
      return response(hooks[0]);
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the cross-provider data warning, honest hook state and character statistics', async () => {
    render(<I18nProvider><ToastProvider><DelegationSettingsPanel /></ToastProvider></I18nProvider>);
    expect(await screen.findByText('Delegation Router')).toBeInTheDocument();
    expect(screen.getByText(/sends the selected file content/)).toBeInTheDocument();
    expect(screen.getByText(/manual trust required/)).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('previews the selected profile provider before saving enforcement', async () => {
    render(<I18nProvider><ToastProvider><DelegationSettingsPanel /></ToastProvider></I18nProvider>);
    const selector = await screen.findByLabelText('Worker Execution Profile');
    fireEvent.change(selector, { target: { value: 'worker' } });
    expect(screen.getByText('antigravity / Gemini Flash / low')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'enforce_bulk_read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/delegation/settings', expect.objectContaining({ method: 'PUT' })));
  });
});
