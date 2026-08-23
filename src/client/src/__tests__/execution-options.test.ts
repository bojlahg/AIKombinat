import { describe, expect, it } from 'vitest';
import { effortOptions, visibleModelOptions } from '../execution-options';

describe('execution option capabilities', () => {
  it('does not offer max or xhigh for Antigravity fallback', () => {
    expect(effortOptions('antigravity', [], null).values).toEqual(['low', 'medium', 'high']);
  });

  it('uses model-specific efforts and preserves an unsupported saved value', () => {
    const models = [{ value: 'model-a', label: 'A', supportedEfforts: ['low', 'high'] }];
    expect(effortOptions('codex', models, 'model-a').values).toEqual(['low', 'high']);
    expect(effortOptions('codex', models, 'model-a', 'max')).toMatchObject({ values: ['max', 'low', 'high'], unsupportedSavedEffort: true, capabilitiesKnown: true, allowProviderDefault: true });

    // Grouped Antigravity model does not allow provider default and requires explicit effort
    const groupedAntigravity = [{
      value: 'gemini-3.7-flash',
      label: 'Gemini 3.7 Flash',
      supportedEfforts: ['low', 'medium', 'high'],
      providerVariants: { low: 'gemini-3.7-flash-low', medium: 'gemini-3.7-flash-medium', high: 'gemini-3.7-flash-high' },
    }];
    expect(effortOptions('antigravity', groupedAntigravity, 'gemini-3.7-flash')).toMatchObject({
      values: ['low', 'medium', 'high'],
      isGrouped: true,
      allowProviderDefault: false,
      defaultEffort: 'low',
    });
  });

  it('filters unavailable models for new selection but preserves the selected model', () => {
    const models = [
      { value: 'gone', label: 'Gone', status: 'missing' as const },
      { value: 'current', label: 'Current', status: 'available' as const },
    ];
    expect(visibleModelOptions(models).map((model) => model.value)).toEqual(['current']);
    expect(visibleModelOptions(models, 'gone').map((model) => model.value)).toEqual(['gone', 'current']);
    expect(visibleModelOptions(models, 'unknown').map((model) => model.value)).toEqual(['unknown', 'current']);
  });
});
