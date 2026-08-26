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

  it('resolves Antigravity canonical model + effort to provider variant slug without --effort flag', () => {
    getModelByValue.mockReturnValue({
      id: 'm1',
      cli_tool: 'antigravity',
      model_value: 'gemini-3.7-flash',
      model_label: 'Gemini 3.7 Flash',
      status: 'available',
      supported_efforts: JSON.stringify(['low', 'medium', 'high']),
      provider_variants: JSON.stringify({
        low: 'gemini-3.7-flash-low',
        medium: 'gemini-3.7-flash-medium',
        high: 'gemini-3.7-flash-high',
      }),
    });
    expect(resolveExecutionModel('gemini-3.7-flash', 'antigravity', true, 'medium')).toEqual({
      requestedModel: 'gemini-3.7-flash',
      effectiveModel: 'gemini-3.7-flash-medium',
      availability: 'available',
    });
    const args = getAdapter('antigravity').buildArgs({ mode: 'headless', prompt: '', model: 'gemini-3.7-flash', effort: 'medium', sandboxMode: 'strict' });
    expect(args).toEqual(['--sandbox', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-3.7-flash-medium']);
    expect(args).not.toContain('--effort');
  });

  it('passes singleton / un-grouped Antigravity models through unchanged', () => {
    getModelByValue.mockReturnValue({
      id: 'm2',
      cli_tool: 'antigravity',
      model_value: 'gpt-oss-120b-medium',
      model_label: 'GPT-OSS 120B (Medium)',
      status: 'available',
      supported_efforts: null,
      provider_variants: null,
    });
    expect(resolveExecutionModel('gpt-oss-120b-medium', 'antigravity', true)).toEqual({
      requestedModel: 'gpt-oss-120b-medium',
      effectiveModel: 'gpt-oss-120b-medium',
      availability: 'available',
    });
    const args = getAdapter('antigravity').buildArgs({ mode: 'headless', prompt: '', model: 'gpt-oss-120b-medium', sandboxMode: 'strict' });
    expect(args).toEqual(['--sandbox', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gpt-oss-120b-medium']);
  });
});
