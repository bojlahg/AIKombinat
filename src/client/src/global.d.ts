/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface DesktopSettings {
  supported: boolean;
  platform: string;
  packaged: boolean;
  traySupported: boolean;
  autostartSupported: boolean;
  closeBehavior: 'tray' | 'quit';
  openAtLogin: boolean;
}

interface Window {
  electronAPI?: {
    imeReset?: (force?: boolean) => void;
    imeLog?: (payload: unknown) => void;
    imeSetDebug?: (enabled: boolean) => void;
    windowFocus?: () => void;
    windowMinimize?: () => void;
    onTerminalZoom?: (cb: (direction: string) => void) => () => void;
    onWebPanelOpenUrl?: (cb: (url: string) => void) => () => void;
    getDroppedFilePath?: (file: File) => string;
    desktopGetSettings?: () => Promise<DesktopSettings>;
    desktopUpdateSettings?: (patch: Partial<Pick<DesktopSettings, 'closeBehavior' | 'openAtLogin'>>) => Promise<DesktopSettings>;
    desktopSetLanguage?: (language: 'en' | 'ko' | 'ru') => void;
  };
}
