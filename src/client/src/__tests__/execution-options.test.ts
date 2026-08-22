import { describe, expect, it } from 'vitest';
import { effortOptions, visibleModelOptions } from '../execution-options';

describe('execution option capabilities', () => {
  it('does not offer max or xhigh for Antigravity fallback', () => {
    expect(effortOptions('antigravity', [], null).values).toEqual(['low', 'medium', 'high']);
  });

  it('uses model-specific efforts and preserves an unsupported saved value', () => {
    const models = [{ value: 'model-a', label: 'A', supportedEfforts: ['low', 'high'] }];
    expect(effortOptions('codex', models, 'model-a').values).toEqual(['low', 'high']);
    expect(effortOptions('codex', models, 'model-a', 'max')).toEqual({ values: ['max', 'low', 'high'], unsupportedSavedEffort: true, capabilitiesKnown: true });
  });

  it('filters unavailable models for new selection but preserves the selected model', () => {
    const models = [
      { value: 'gone', label: 'Gone', availabilityStatus: 'unavailable' },
      { value: 'current', label: 'Current', availabilityStatus: 'available' },
    ];
    expect(visibleModelOptions(models).map((model) => model.value)).toEqual(['current']);
    expect(visibleModelOptions(models, 'gone').map((model) => model.value)).toEqual(['gone', 'current']);
    expect(visibleModelOptions(models, 'unknown').map((model) => model.value)).toEqual(['unknown', 'current']);
  });
});
