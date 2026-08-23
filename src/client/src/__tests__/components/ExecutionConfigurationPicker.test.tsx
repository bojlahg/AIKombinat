import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExecutionConfigurationPicker, { type ExecutionConfigurationValue } from '../../components/ExecutionConfigurationPicker';
import { I18nProvider } from '../../i18n';
import type { ExecutionProfile } from '../../api/executionProfiles';
import type { CatalogModel } from '../../execution-options';
import TodoForm from '../../components/TodoForm';
import SessionForm from '../../components/SessionForm';

const mockProfiles: ExecutionProfile[] = [
  {
    id: 'prof-heavy',
    slug: 'heavy-coding',
    name: 'Heavy Coding',
    description: 'For complex multi-step coding tasks',
    isEnabled: true,
    sortOrder: 0,
    executors: [
      {
        id: 'exec-1',
        cliModelId: 'claude-sonnet-4-6',
        cliTool: 'claude',
        modelValue: 'claude-sonnet-4-6',
        modelLabel: 'Claude Sonnet 4.6',
        modelStatus: 'available',
        supportedEfforts: ['low', 'medium', 'high'],
        effortValue: 'high',
        priority: 1,
        isEnabled: true,
      },
      {
        id: 'exec-2',
        cliModelId: 'gpt-5.6',
        cliTool: 'codex',
        modelValue: 'gpt-5.6',
        modelLabel: 'GPT-5.6',
        modelStatus: 'missing',
        supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
        effortValue: 'xhigh',
        priority: 2,
        isEnabled: true,
      },
      {
        id: 'exec-3',
        cliModelId: 'disabled-model',
        cliTool: 'codex',
        modelValue: 'disabled-model',
        modelLabel: 'Disabled Model',
        modelStatus: 'available',
        supportedEfforts: null,
        effortValue: null,
        priority: 3,
        isEnabled: false,
      },
    ],
  },
  {
    id: 'prof-empty',
    slug: 'empty-profile',
    name: 'Empty Profile',
    description: 'Has no executors',
    isEnabled: true,
    sortOrder: 1,
    executors: [],
  },
];

const mockModels: Record<string, CatalogModel[]> = {
  claude: [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', status: 'available', supportedEfforts: ['low', 'medium', 'high'] },
  ],
  antigravity: [
    {
      value: 'gemini-3.7-flash',
      label: 'Gemini 3.7 Flash',
      status: 'available',
      supportedEfforts: ['low', 'medium', 'high'],
      providerVariants: {
        low: 'gemini-3.7-flash-low',
        medium: 'gemini-3.7-flash-medium',
        high: 'gemini-3.7-flash-high',
      },
    },
  ],
  codex: [
    { value: 'gpt-5.6', label: 'GPT-5.6', status: 'available', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
};

describe('ExecutionConfigurationPicker', () => {
  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en');
  });

  it('renders Manual mode by default when executionProfileId is null', () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ExecutionConfigurationPicker
          executionProfileId={null}
          cliTool="claude"
          cliModel="claude-sonnet-4-6"
          cliEffort="high"
          profiles={mockProfiles}
          models={mockModels}
          onChange={onChange}
        />
      </I18nProvider>
    );

    // Shows mode buttons
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manual' })).toBeInTheDocument();

    // Shows manual dropdowns
    expect(screen.getByLabelText('CLI Tool')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Effort')).toBeInTheDocument();

    // Does NOT show profile selector or preview
    expect(screen.queryByLabelText('Profile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-executor-preview')).not.toBeInTheDocument();
  });

  it('renders Profile mode with executor chain preview when executionProfileId is provided', () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ExecutionConfigurationPicker
          executionProfileId="prof-heavy"
          cliTool="claude"
          cliModel=""
          cliEffort={null}
          profiles={mockProfiles}
          models={mockModels}
          onChange={onChange}
        />
      </I18nProvider>
    );

    // Profile selector is shown
    expect(screen.getByLabelText('Profile')).toBeInTheDocument();

    // Manual controls are NOT shown
    expect(screen.queryByLabelText('CLI Tool')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument();

    // Candidate preview is shown with enabled executors in priority order
    const preview = screen.getByTestId('profile-executor-preview');
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveTextContent('Claude Code / Claude Sonnet 4.6 / high');
    expect(preview).toHaveTextContent('Codex CLI / GPT-5.6 / xhigh');
    expect(preview).toHaveTextContent('Unavailable'); // Missing model tagged

    // Disabled executor is not in active chain
    expect(preview).not.toHaveTextContent('Disabled Model');
  });

  it('shows visible warning when selected profile has no eligible executors', () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <ExecutionConfigurationPicker
          executionProfileId="prof-empty"
          profiles={mockProfiles}
          models={mockModels}
          onChange={onChange}
        />
      </I18nProvider>
    );

    const preview = screen.getByTestId('profile-executor-preview');
    expect(preview).toHaveTextContent('Profile has no eligible executors.');
  });

  it('preserves previous manual and profile selections when toggling between modes', () => {
    let currentValue: ExecutionConfigurationValue = {
      mode: 'manual',
      executionProfileId: null,
      cliTool: 'claude',
      cliModel: 'claude-sonnet-4-6',
      cliEffort: 'high',
    };

    const handleChange = (next: ExecutionConfigurationValue) => {
      currentValue = next;
    };

    const { rerender } = render(
      <I18nProvider>
        <ExecutionConfigurationPicker
          mode={currentValue.mode}
          executionProfileId={currentValue.executionProfileId}
          cliTool={currentValue.cliTool}
          cliModel={currentValue.cliModel}
          cliEffort={currentValue.cliEffort}
          profiles={mockProfiles}
          models={mockModels}
          onChange={handleChange}
        />
      </I18nProvider>
    );

    // Switch to Profile mode
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    expect(currentValue.mode).toBe('profile');
    expect(currentValue.executionProfileId).toBe('prof-heavy');

    rerender(
      <I18nProvider>
        <ExecutionConfigurationPicker
          mode={currentValue.mode}
          executionProfileId={currentValue.executionProfileId}
          cliTool={currentValue.cliTool}
          cliModel={currentValue.cliModel}
          cliEffort={currentValue.cliEffort}
          profiles={mockProfiles}
          models={mockModels}
          onChange={handleChange}
        />
      </I18nProvider>
    );

    // Switch back to Manual mode: previous manual values are restored
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    expect(currentValue.mode).toBe('manual');
    expect(currentValue.executionProfileId).toBeNull();
    expect(currentValue.cliTool).toBe('claude');
    expect(currentValue.cliModel).toBe('claude-sonnet-4-6');
    expect(currentValue.cliEffort).toBe('high');
  });

  it('enforces explicit effort for grouped Antigravity models in Manual mode', () => {
    let currentValue: ExecutionConfigurationValue = {
      mode: 'manual',
      executionProfileId: null,
      cliTool: 'antigravity',
      cliModel: '',
      cliEffort: null,
    };

    const handleChange = (next: ExecutionConfigurationValue) => {
      currentValue = next;
    };

    const { rerender } = render(
      <I18nProvider>
        <ExecutionConfigurationPicker
          mode={currentValue.mode}
          executionProfileId={currentValue.executionProfileId}
          cliTool={currentValue.cliTool}
          cliModel={currentValue.cliModel}
          cliEffort={currentValue.cliEffort}
          profiles={mockProfiles}
          models={mockModels}
          onChange={handleChange}
        />
      </I18nProvider>
    );

    // Select grouped antigravity model
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemini-3.7-flash' } });

    // Auto-selects supported effort (e.g. low or medium) and doesn't leave effort null
    expect(currentValue.cliModel).toBe('gemini-3.7-flash');
    expect(currentValue.cliEffort).toBe('low');

    rerender(
      <I18nProvider>
        <ExecutionConfigurationPicker
          mode={currentValue.mode}
          executionProfileId={currentValue.executionProfileId}
          cliTool={currentValue.cliTool}
          cliModel={currentValue.cliModel}
          cliEffort={currentValue.cliEffort}
          profiles={mockProfiles}
          models={mockModels}
          onChange={handleChange}
        />
      </I18nProvider>
    );

    // Effort selector does not contain Default option for grouped Antigravity models
    const effortOptions = screen.getAllByRole('option').map((o) => o.textContent);
    expect(effortOptions).not.toContain('Default');
  });
});

describe('TodoForm & SessionForm integration with ExecutionConfigurationPicker', () => {
  beforeEach(() => {
    localStorage.setItem('aikombinat-lang', 'en');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/api/models')) return Promise.resolve({ json: () => Promise.resolve(mockModels) });
        if (url.includes('/api/execution-profiles')) return Promise.resolve({ json: () => Promise.resolve(mockProfiles) });
        return Promise.resolve({ json: () => Promise.resolve([]) });
      })
    );
  });

  it('TodoForm submits execution_profile_id in Profile mode and manual fields in Manual mode', async () => {
    const onSave = vi.fn();
    render(
      <I18nProvider>
        <TodoForm onSave={onSave} onCancel={vi.fn()} initialTitle="Task 1" />
      </I18nProvider>
    );

    // Switch to Profile mode
    await waitFor(() => expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Add Task|Save/i }));
    expect(onSave).toHaveBeenCalled();
    const lastCall = onSave.mock.calls[0];
    // executionProfileId is last arg (12th arg in TodoForm signature)
    expect(lastCall[10]).toBeUndefined(); // cli_model undefined
    expect(lastCall[11]).toBeNull(); // cli_effort null
    expect(lastCall[12]).toBe('prof-heavy'); // execution_profile_id
  });

  it('SessionForm submits execution_profile_id in Profile mode', async () => {
    const onSave = vi.fn();
    render(
      <I18nProvider>
        <SessionForm projectId="proj-1" onSave={onSave} onCancel={vi.fn()} />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Terminal Title'), { target: { value: 'My Session' } });
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));

    fireEvent.click(screen.getByRole('button', { name: /Create Terminal|Save/i }));
    expect(onSave).toHaveBeenCalled();
    const lastCall = onSave.mock.calls[0];
    expect(lastCall[8]).toBeUndefined(); // cli_model undefined
    expect(lastCall[9]).toBeNull(); // cli_effort null
    expect(lastCall[10]).toBe('prof-heavy'); // execution_profile_id
  });
});
