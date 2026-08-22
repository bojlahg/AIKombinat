export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DISABLE_AUTH === 'true') return '127.0.0.1';
  return env.BIND_HOST?.trim() || '127.0.0.1';
}
