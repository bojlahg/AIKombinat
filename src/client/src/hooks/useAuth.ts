import { useState, useEffect, useCallback } from 'react';
import * as authApi from '../api/auth';

export function useAuth() {
  const [status, setStatus] = useState<authApi.AuthStatus>({
    authenticated: false, authRequired: true, setupRequired: false, accessMode: 'remote',
    passwordConfigured: false, remoteAccessReady: false, remoteAccessBlocked: false,
    passwordSetupAllowed: false,
  });
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const next = await authApi.getAuthStatus();
    setStatus(next);
  }, []);

  useEffect(() => {
    refresh().catch(() => setStatus(s => ({ ...s, authenticated: false })))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const handler = () => {
      if (status.authRequired) setStatus(s => ({ ...s, authenticated: false }));
      refresh().catch(() => {});
    };
    window.addEventListener('auth:unauthorized', handler);
    window.addEventListener('auth:changed', handler);
    return () => {
      window.removeEventListener('auth:unauthorized', handler);
      window.removeEventListener('auth:changed', handler);
    };
  }, [status.authRequired, refresh]);

  const login = useCallback(async (password: string, remember: boolean) => {
    await authApi.login(password, remember);
    await refresh();
  }, [refresh]);
  const logout = useCallback(async () => {
    await authApi.logout();
    setStatus(s => s.authRequired ? { ...s, authenticated: false } : s);
    await refresh();
  }, [refresh]);
  const setup = useCallback(async (password: string, confirmPassword: string) => {
    await authApi.setupPassword(password, confirmPassword);
    await refresh();
  }, [refresh]);
  const changePassword = useCallback(async (
    oldPassword: string, newPassword: string, confirmPassword: string, remember: boolean,
  ) => {
    await authApi.login(oldPassword, remember);
    try {
      await authApi.changePassword(oldPassword, newPassword, confirmPassword);
    } catch (err) {
      await authApi.logout().catch(() => {});
      throw err;
    }
    await refresh();
  }, [refresh]);

  return { ...status, loading, login, logout, setup, changePassword };
}
