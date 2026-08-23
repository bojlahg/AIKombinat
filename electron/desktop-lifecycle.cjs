const path = require('node:path');

const DESKTOP_PLATFORMS = new Set(['win32', 'darwin', 'linux']);

function isDesktopPlatform(platform) {
  return DESKTOP_PLATFORMS.has(platform);
}

function trayIconName(platform) {
  if (platform === 'win32') return 'icon.ico';
  if (platform === 'darwin') return 'trayTemplate.png';
  if (platform === 'linux') return 'tray-linux.png';
  return 'icon.png';
}

function linuxAutostartFile(configHome, homeDir) {
  const configDir = configHome && path.posix.isAbsolute(configHome)
    ? configHome
    : path.posix.join(homeDir, '.config');
  return path.posix.join(configDir, 'autostart', 'aikombinat.desktop');
}

function legacyLinuxAutostartFile(configHome, homeDir) {
  const configDir = configHome && path.posix.isAbsolute(configHome)
    ? configHome
    : path.posix.join(homeDir, '.config');
  return path.posix.join(configDir, 'autostart', 'clitrigger.desktop');
}

function quoteDesktopExecPath(executablePath) {
  return `"${executablePath
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/%/g, '%%')}"`;
}

function buildLinuxAutostartEntry(executablePath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=AIKombinat',
    `Exec=${quoteDesktopExecPath(executablePath)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function linuxAutostartEntryMatches(contents, executablePath) {
  return contents.split(/\r?\n/).some((line) => line === `Exec=${quoteDesktopExecPath(executablePath)}`);
}

module.exports = {
  buildLinuxAutostartEntry,
  isDesktopPlatform,
  legacyLinuxAutostartFile,
  linuxAutostartEntryMatches,
  linuxAutostartFile,
  quoteDesktopExecPath,
  trayIconName,
};
