import type { TranslationKey } from '../i18n/types';

const codes = new Set(['password_required', 'password_too_short', 'passwords_do_not_match',
  'invalid_password', 'current_password_required', 'current_password_incorrect',
  'already_initialized', 'remote_password_required', 'remote_access_not_configured',
  'local_only', 'unauthorized', 'too_many_auth_attempts', 'logout_failed']);

export function translateAuthError(code: string, t: (key: TranslationKey) => string): string {
  return t(codes.has(code) ? `auth.errors.${code}` as TranslationKey : 'auth.errors.unknown');
}
