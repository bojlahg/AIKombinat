import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useAuth } from '../hooks/useAuth';
import * as authApi from '../api/auth';

vi.mock('../api/auth');

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor() { Socket.instances.push(this); }
}

beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('WS logout lifecycle', () => {
  it('cancels a reconnect already scheduled when authentication becomes false', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ authenticated }) => useWebSocket(authenticated), { initialProps: { authenticated: true } });
    act(() => Socket.instances[0].onopen?.());
    expect(result.current.connected).toBe(true);
    act(() => Socket.instances[0].onclose?.());
    rerender({ authenticated: false });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.connected).toBe(false);
    expect(Socket.instances).toHaveLength(1);
  });
  it('ignores late callbacks after logout, unmount and subsequent login', () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(({ authenticated }) => useWebSocket(authenticated), { initialProps: { authenticated: true } });
    const old = Socket.instances[0];
    const callback = vi.fn();
    result.current.onEvent(callback);
    rerender({ authenticated: false });
    act(() => { old.onopen?.(); old.onmessage?.({ data: '{"type":"connected"}' }); old.onclose?.(); });
    expect(result.current.connected).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    rerender({ authenticated: true });
    act(() => Socket.instances[1].onopen?.());
    act(() => old.onclose?.());
    expect(result.current.connected).toBe(true);
    unmount();
    act(() => { Socket.instances[1].onclose?.(); vi.advanceTimersByTime(60_000); });
    expect(Socket.instances).toHaveLength(2);
  });
  it('successful remote HTTP logout disables WS before status refresh finishes', async () => {
    const remote: authApi.AuthStatus = {
      authenticated: true, authRequired: true, accessMode: 'remote', setupRequired: false,
      passwordConfigured: true, remoteAccessReady: true, remoteAccessBlocked: false, passwordSetupAllowed: false,
    };
    let refresh: (status: authApi.AuthStatus) => void = () => {};
    vi.mocked(authApi.getAuthStatus).mockResolvedValueOnce(remote)
      .mockImplementationOnce(() => new Promise(resolve => { refresh = resolve; }));
    vi.mocked(authApi.logout).mockResolvedValue(undefined);
    const { result } = renderHook(() => {
      const auth = useAuth();
      return { ...auth, ws: useWebSocket(auth.authenticated) };
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const socket = Socket.instances[0];
    act(() => socket.onopen?.());
    let logout: Promise<void>;
    await act(async () => { logout = result.current.logout(); await Promise.resolve(); });
    expect(result.current.authenticated).toBe(false);
    expect(result.current.ws.connected).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    act(() => { socket.onclose?.(); vi.advanceTimersByTime(60_000); });
    expect(Socket.instances).toHaveLength(1);
    await act(async () => { refresh({ ...remote, authenticated: false }); await logout; });
  });
});
