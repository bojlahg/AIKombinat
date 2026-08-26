import { describe, expect, it } from 'vitest';
import { classifyProviderFailure } from '../failure-classifier.js';

describe('failure-classifier', () => {
  it('keeps Claude Not logged in failures classified as auth_error with actionable guidance', () => {
    expect(classifyProviderFailure('claude', 1, 'auth_error: Not logged in')).toEqual({
      category: 'auth_error',
      reason: 'Claude CLI is not authenticated. Run `claude` interactively and use `/login`.',
    });
  });
});
