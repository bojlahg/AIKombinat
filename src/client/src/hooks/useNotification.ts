import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

interface NotificationContextValue {
  enabled: boolean;
  supported: boolean;
  toggleNotification: () => void;
  sendNotification: (title: string, body: string) => void;
}

export const NotificationContext = createContext<NotificationContextValue>({
  enabled: false,
  supported: false,
  toggleNotification: () => {},
  sendNotification: () => {},
});

const NOTIF_KEY = 'aikombinat-notifications';
const LEGACY_NOTIF_KEY = 'clitrigger-notifications';

export function useNotificationProvider(): NotificationContextValue {
  const supported = 'Notification' in window;

  const [enabled, setEnabled] = useState<boolean>(() => {
    if (!supported) return false;
    const saved = localStorage.getItem(NOTIF_KEY) ?? localStorage.getItem(LEGACY_NOTIF_KEY);
    return saved === 'on' && Notification.permission === 'granted';
  });

  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const toggleNotification = useCallback(async () => {
    if (!supported) return;

    if (enabledRef.current) {
      localStorage.setItem(NOTIF_KEY, 'off');
      setEnabled(false);
    } else {
      if (Notification.permission === 'denied') return;

      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result !== 'granted') return;
      }

      localStorage.setItem(NOTIF_KEY, 'on');
      setEnabled(true);
    }
  }, [supported]);

  const sendNotification = useCallback((title: string, body: string) => {
    if (!enabledRef.current) return;
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }, []);

  return { enabled, supported, toggleNotification, sendNotification };
}

export function useNotification(): NotificationContextValue {
  return useContext(NotificationContext);
}
