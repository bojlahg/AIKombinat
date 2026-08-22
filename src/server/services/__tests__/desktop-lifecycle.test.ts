import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildLinuxAutostartEntry,
  isDesktopPlatform,
  linuxAutostartEntryMatches,
  linuxAutostartFile,
  quoteDesktopExecPath,
  trayIconName,
} = require('../../../../electron/desktop-lifecycle.cjs') as {
  buildLinuxAutostartEntry: (executablePath: string) => string;
  isDesktopPlatform: (platform: string) => boolean;
  linuxAutostartEntryMatches: (contents: string, executablePath: string) => boolean;
  linuxAutostartFile: (configHome: string | undefined, homeDir: string) => string;
  quoteDesktopExecPath: (executablePath: string) => string;
  trayIconName: (platform: string) => string;
};

describe('desktop lifecycle helpers', () => {
  it('selects platform tray assets', () => {
    expect(trayIconName('win32')).toBe('icon.ico');
    expect(trayIconName('darwin')).toBe('trayTemplate.png');
    expect(trayIconName('linux')).toBe('tray-linux.png');
  });

  it('recognizes supported desktop platforms', () => {
    expect(['win32', 'darwin', 'linux'].every(isDesktopPlatform)).toBe(true);
    expect(isDesktopPlatform('freebsd')).toBe(false);
  });

  it('uses XDG_CONFIG_HOME with the standard fallback', () => {
    expect(linuxAutostartFile('/xdg', '/home/user')).toBe('/xdg/autostart/clitrigger.desktop');
    expect(linuxAutostartFile(undefined, '/home/user')).toBe('/home/user/.config/autostart/clitrigger.desktop');
    expect(linuxAutostartFile('relative', '/home/user')).toBe('/home/user/.config/autostart/clitrigger.desktop');
  });

  it('quotes Linux executable paths and detects stale entries', () => {
    const executable = '/opt/CLI Trigger/$current%20.AppImage';
    expect(quoteDesktopExecPath(executable)).toBe('"/opt/CLI Trigger/\\$current%%20.AppImage"');
    const entry = buildLinuxAutostartEntry(executable);
    expect(entry).toContain('Terminal=false');
    expect(linuxAutostartEntryMatches(entry, executable)).toBe(true);
    expect(linuxAutostartEntryMatches(entry, '/opt/CLI Trigger/new.AppImage')).toBe(false);
  });
});
