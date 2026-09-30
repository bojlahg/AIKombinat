// Server authentication and tunnel credentials belong only to the controller.
// Provider credentials (including ANTHROPIC_API_KEY / OPENAI_API_KEY), CLI
// login/config directories and ordinary runtime variables intentionally survive.
export const SERVER_ONLY_ENV_KEYS = ['SESSION_SECRET', 'AUTH_PASSWORD', 'TUNNEL_TOKEN'] as const;
const blocked = new Set<string>(SERVER_ONLY_ENV_KEYS);

export function createChildEnvironment(
  overrides: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...source, ...overrides })) {
    if (value !== undefined && !blocked.has(key.toUpperCase())) environment[key] = value;
  }
  return environment;
}
