import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_FORUM_ENV_VAR,
  AGENT_FORUM_FEATURE_KEY,
  agentForumDisabledBody,
  getFeatureFlags,
  isAgentForumEnabled,
} from '../features.js';

describe('AgentForum feature flag', () => {
  beforeEach(() => {
    delete process.env[AGENT_FORUM_ENV_VAR];
  });

  afterEach(() => {
    delete process.env[AGENT_FORUM_ENV_VAR];
  });

  it('is disabled by default (fresh install / ordinary launch)', () => {
    expect(isAgentForumEnabled()).toBe(false);
    expect(getFeatureFlags()).toEqual({ agentForum: false });
  });

  it.each(['1', 'true', 'TRUE', ' True '])('is enabled by %j (developer-only opt-in)', (value) => {
    process.env[AGENT_FORUM_ENV_VAR] = value;
    expect(isAgentForumEnabled()).toBe(true);
    expect(getFeatureFlags()).toEqual({ agentForum: true });
  });

  it.each(['0', 'false', '', 'yes', 'on', 'disabled'])('stays disabled for %j (no accidental auto-enable)', (value) => {
    process.env[AGENT_FORUM_ENV_VAR] = value;
    expect(isAgentForumEnabled()).toBe(false);
    expect(getFeatureFlags()).toEqual({ agentForum: false });
  });

  it('uses a single shared key and a controlled error contract', () => {
    expect(AGENT_FORUM_FEATURE_KEY).toBe('agentForum');
    expect(agentForumDisabledBody()).toEqual({
      error: 'AgentForum is temporarily disabled',
      code: 'feature_disabled',
      feature: 'agentForum',
    });
  });
});
