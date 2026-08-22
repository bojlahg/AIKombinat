import { beforeEach, describe, expect, it, vi } from 'vitest';

const getModelByValue = vi.hoisted(() => vi.fn());
vi.mock('../../db/queries.js', () => ({ getModelByValue }));

const { getAdapter, resolveExecutionModel } = await import('../cli-adapters.js');

describe('explicit model resolution', () => {
  beforeEach(() => getModelByValue.mockReset());

  it('passes an unknown explicitly requested model through unchanged', () => {
    getModelByValue.mockReturnValue(undefined);
    expect(resolveExecutionModel('gpt-private-preview', 'codex')).toEqual({
      requestedModel: 'gpt-private-preview',
      effectiveModel: 'gpt-private-preview',
      availability: 'unknown',
    });
    expect(getAdapter('codex').buildArgs({ mode: 'headless', prompt: '', model: 'gpt-private-preview' })).toContain('gpt-private-preview');
  });

  it('fails clearly when the explicitly requested model is definitely unavailable', () => {
    getModelByValue.mockReturnValue({ availability_status: 'unavailable', deprecated: 1 });
    expect(() => resolveExecutionModel('gpt-retired', 'codex')).toThrow('Selected codex model "gpt-retired" is unavailable');
    expect(() => getAdapter('codex').buildArgs({ mode: 'headless', prompt: '', model: 'gpt-retired' })).toThrow('Selected codex model "gpt-retired" is unavailable');
  });
});
