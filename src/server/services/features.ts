/**
 * Central source of truth for experimental feature flags.
 *
 * AgentForum V1 is currently a paused experiment: the implementation, schema,
 * migrations, historical data, and startup recovery are all retained, but no
 * new forum activity may start unless a developer explicitly opts in.
 *
 * Disabled != deleted. Re-enabling is `AIKOMBINAT_EXPERIMENTAL_AGENT_FORUM=1`
 * plus a restart — no code or data changes required.
 */

export const AGENT_FORUM_ENV_VAR = 'AIKOMBINAT_EXPERIMENTAL_AGENT_FORUM';

/** Key used in the `/api/features` payload and in disabled error bodies. */
export const AGENT_FORUM_FEATURE_KEY = 'agentForum' as const;

export const AGENT_FORUM_DISABLED_MESSAGE = 'AgentForum is temporarily disabled';

/**
 * Developer-only opt-in. Default is disabled: a fresh install or an ordinary
 * launch must never enable the experiment on its own. Read dynamically (never
 * cached) so tests can flip it per case and a restart always re-reads it.
 */
export function isAgentForumEnabled(): boolean {
  const raw = process.env[AGENT_FORUM_ENV_VAR]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

export interface FeatureFlags {
  agentForum: boolean;
}

/** The exact shape served by `GET /api/features`. */
export function getFeatureFlags(): FeatureFlags {
  return { agentForum: isAgentForumEnabled() };
}

/** Controlled error body for requests blocked by the disabled feature. */
export function agentForumDisabledBody(): { error: string; code: string; feature: string } {
  return {
    error: AGENT_FORUM_DISABLED_MESSAGE,
    code: 'feature_disabled',
    feature: AGENT_FORUM_FEATURE_KEY,
  };
}
