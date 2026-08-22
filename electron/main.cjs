const { app, BrowserWindow, dialog, shell, Menu, nativeTheme, ipcMain, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  buildLinuxAutostartEntry,
  isDesktopPlatform,
  linuxAutostartEntryMatches,
  linuxAutostartFile,
  trayIconName,
} = require('./desktop-lifecycle.cjs');

// Windows: Chromium의 네이티브 윈도우 가림 계산이 창을 잘못 "가려짐"으로 판정하면
// 입력/IME가 멎고 IME 조합 창이 화면 좌상단에 고착된다(다른 앱에 포커스를 줬다
// 오면 가림 재계산이 일어나며 풀림). 패키징 exe에서만 재현 — dev는 detached
// DevTools가 떠 있어 가려진다. 이 기능을 끄면 고착이 사라진다.
// 참고: electron/electron#4539, #31917.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

let mainWindow = null;
let tray = null;
let traySupported = false;
let isQuitting = false;
let closeBehavior = 'tray';
let trayLanguage = 'en';
let serverPort = null;
let cleanupStarted = false;
let updateCheckInFlight = false;

const userDataDir = app.getPath('userData');
const configFile = path.join(userDataDir, 'config.json');
const dbPath = path.join(userDataDir, 'clitrigger.db');
const migratedFlag = path.join(userDataDir, '.password-migrated');

const trayLabels = {
  en: { open: 'Open CLITrigger', exit: 'Exit CLITrigger' },
  ru: { open: 'Открыть CLITrigger', exit: 'Выйти из CLITrigger' },
  ko: { open: 'CLITrigger 열기', exit: 'CLITrigger 종료' },
};

// IME diagnostics — toggleable from Settings ▸ Terminal (the renderer sends
// ime:set-debug), or seeded from the CLITRIGGER_IME_DEBUG env var. When
// enabled, JSON lines are appended to userData/ime-debug.log so the packaged
// exe can be observed without DevTools — opening DevTools un-occludes the
// window and masks the very occlusion bug this log exists to diagnose.
let imeDebugEnabled = !!process.env.CLITRIGGER_IME_DEBUG;
const imeDebugLogFile = path.join(userDataDir, 'ime-debug.log');
function imeDebugLog(source, data) {
  if (!imeDebugEnabled) return;
  try {
    fs.appendFileSync(imeDebugLogFile, `${JSON.stringify({ t: new Date().toISOString(), source, ...data })}\n`);
  } catch { /* best-effort diagnostics */ }
}
function logImeStartup() {
  imeDebugLog('startup', {
    isPackaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    disableFeatures: app.commandLine.getSwitchValue('disable-features'),
  });
}
// Attach listeners unconditionally so a runtime toggle takes effect without
// recreating the window — imeDebugLog itself gates on the current flag.
function attachImeWindowLogging(win, label) {
  for (const ev of ['focus', 'blur', 'show', 'hide']) {
    win.on(ev, () => {
      if (win.isDestroyed()) return;
      imeDebugLog(label, { event: ev, visible: win.isVisible(), focused: win.isFocused() });
    });
  }
  // Key arrival at the Chromium layer, before renderer dispatch. Composition
  // events are the first renderer-side log point, so when TSF is stranded the
  // log goes silent — this line distinguishes "key never reached webContents"
  // from "key arrived but composition never started".
  win.webContents.on('before-input-event', (_e, input) => {
    if (!imeDebugEnabled) return;
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    imeDebugLog(label, { event: 'key', key: input.key, code: input.code });
  });
}

// Focus-recovery bridge, shared by the main window and popout children.
//
// A focus that FOLLOWS a real OS blur (lock screen, alt-tab, forced IME
// handoff) leaves the Windows TSF IME context stranded — Hangul commits as
// detached jamo and the candidate window jumps to the corner — even though
// webContents.isFocused() reads stale-true (ime-debug 2026-07-11). Force a
// webContents.focus() rebind on post-blur refocus; keep skipping the
// blur-less redundant focus, whose focus() would instead reset a healthy TSF
// context (the original corner-jump this guard was added to prevent).
//
// Stale-event guard: with two app windows open, a 'focus' event can be
// processed AFTER activation has already moved to the other window (the event
// arrives with win.isFocused() === false). Calling webContents.focus() then is
// not a rebind but an HWND activation STEAL from the sibling window — it blurs
// the sibling, re-arms the sibling's bridge, whose own stale rebind steals
// back: a self-sustaining blur→focus ping-pong between the two bridges, no
// renderer involved (ime-debug 2026-08-05: a forced IME handoff's blur handed
// activation to an open popout and the two bridges flickered at 15–30Hz for
// 28s, ~10,400 window events). Skipping the stale rebind breaks the loop:
// a fresh-focus rebind targets the already-active window and cannot steal.
// wasBlurred stays armed on the skip so the eventual real focus still rebinds.
function attachFocusRebindBridge(win, label) {
  let wasBlurred = false;
  win.on('blur', () => { wasBlurred = true; });
  win.on('focus', () => {
    if (win.isDestroyed()) return;
    if (!win.isFocused()) {
      imeDebugLog(label, { event: 'focus-bridge', skipped: 'stale' });
      return;
    }
    const rebind = wasBlurred;
    wasBlurred = false;
    if (!rebind && win.webContents.isFocused()) return;
    imeDebugLog(label, { event: 'focus-bridge', rebind });
    win.webContents.focus();
  });
}

function readOrInitConfig() {
  fs.mkdirSync(userDataDir, { recursive: true });
  let config = {};
  if (fs.existsSync(configFile)) {
    try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}
  }
  let mutated = false;
  // Password is set by the user on first launch via the web UI Setup screen.
  // Legacy plaintext field is migrated to a hash on first server boot, then
  // cleaned up here on the next launch via the migrated flag.
  if (fs.existsSync(migratedFlag) && config.password) {
    delete config.password;
    mutated = true;
    try { fs.unlinkSync(migratedFlag); } catch { /* ignore */ }
  }
  if (typeof config.port !== 'number') {
    config.port = 3737;
    mutated = true;
  }
  if (typeof config.tunnel !== 'boolean') {
    config.tunnel = false;
    mutated = true;
  }
  if (!config.desktop || typeof config.desktop !== 'object' || Array.isArray(config.desktop)) {
    config.desktop = {};
    mutated = true;
  }
  if (config.desktop.closeBehavior !== 'tray' && config.desktop.closeBehavior !== 'quit') {
    config.desktop.closeBehavior = 'tray';
    mutated = true;
  }
  closeBehavior = config.desktop.closeBehavior;
  if (mutated) fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  return config;
}

function updateDesktopConfig(patch) {
  const config = readOrInitConfig();
  config.desktop = { ...config.desktop, ...patch };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  closeBehavior = config.desktop.closeBehavior;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  mainWindow.webContents.focus();
}

function requestRealQuit() {
  isQuitting = true;
  app.quit();
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const labels = trayLabels[trayLanguage] || trayLabels.en;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels.open, click: showMainWindow },
    { type: 'separator' },
    {
      label: labels.exit,
      click: requestRealQuit,
    },
  ]));
}

function createTray() {
  if (!isDesktopPlatform(process.platform)) return;
  if (tray && !tray.isDestroyed()) {
    traySupported = true;
    return;
  }
  try {
    tray = new Tray(path.join(app.getAppPath(), 'build', trayIconName(process.platform)));
    traySupported = true;
    tray.setToolTip('CLITrigger');
    if (process.platform !== 'darwin') tray.on('click', showMainWindow);
    rebuildTrayMenu();
  } catch (err) {
    tray = null;
    traySupported = false;
    console.error(`[desktop] tray initialization failed on ${process.platform}:`, err);
  }
}

function linuxExecutablePath() {
  return process.env.APPIMAGE || process.execPath;
}

function getLinuxAutostartFile() {
  return linuxAutostartFile(process.env.XDG_CONFIG_HOME, os.homedir());
}

function getOpenAtLogin() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return app.getLoginItemSettings().openAtLogin;
  }
  if (process.platform !== 'linux') return false;
  try {
    const contents = fs.readFileSync(getLinuxAutostartFile(), 'utf-8');
    return linuxAutostartEntryMatches(contents, linuxExecutablePath());
  } catch {
    return false;
  }
}

function setOpenAtLogin(enabled) {
  if (!app.isPackaged) throw new Error('Startup is only available in packaged builds');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  if (process.platform !== 'linux') throw new Error('Startup is unavailable');
  const autostartFile = getLinuxAutostartFile();
  if (enabled) {
    fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
    fs.writeFileSync(autostartFile, buildLinuxAutostartEntry(linuxExecutablePath()), 'utf-8');
  } else {
    try { fs.unlinkSync(autostartFile); } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
}

function getDesktopSettings() {
  const supported = isDesktopPlatform(process.platform);
  const autostartSupported = supported && app.isPackaged;
  return {
    supported,
    platform: process.platform,
    packaged: app.isPackaged,
    traySupported,
    autostartSupported,
    closeBehavior: closeBehavior === 'tray' && !traySupported ? 'quit' : closeBehavior,
    openAtLogin: autostartSupported ? getOpenAtLogin() : false,
  };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('No free port available');
}

async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not respond on port ${port} within ${timeoutMs}ms`);
}

function resolveServerEntry() {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'server', 'index.js'),
    path.join(process.resourcesPath || '', 'app.asar', 'dist', 'server', 'index.js'),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

async function bootServer() {
  const config = readOrInitConfig();
  serverPort = await findFreePort(config.port);

  process.env.PORT = String(serverPort);
  process.env.DB_PATH = dbPath;
  // Only forward a legacy plaintext password so the server can migrate it.
  // Without it, the server enters setup mode and the web UI prompts the user.
  if (config.password) {
    process.env.AUTH_PASSWORD = config.password;
  }
  if (config.tunnel) process.env.TUNNEL_ENABLED = 'true';
  if (config.tunnelName) process.env.TUNNEL_NAME = config.tunnelName;
  if (config.tunnelHostname) process.env.TUNNEL_HOSTNAME = config.tunnelHostname;

  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    throw new Error(
      'Server build not found. Run "npm run build" before launching Electron.'
    );
  }
  await import(pathToFileURL(serverEntry).href);
  await waitForServer(serverPort);
  return { port: serverPort };
}

function createWindow(port) {
  logImeStartup();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f0f' : '#ffffff',
    // Dev only — packaged build inherits the icon from the embedded .exe.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const localOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  // Parse a `features` CSV string like "popup,width=800,height=540,left=120,top=80"
  // into numeric x/y/width/height we can forward into Electron's
  // overrideBrowserWindowOptions. Electron drops the features-derived sizing
  // when override is returned, so this re-forwards what the renderer asked
  // for; without it the popout would spawn at Electron's default cascade
  // position instead of under the user's cursor (drag-out is unusable).
  const parseFeatures = (features) => {
    const out = {};
    if (typeof features !== 'string') return out;
    for (const part of features.split(',')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = Number(part.slice(eq + 1).trim());
      if (!Number.isFinite(val)) continue;
      if (key === 'width') out.width = val;
      else if (key === 'height') out.height = val;
      else if (key === 'left') out.x = val;
      else if (key === 'top') out.y = val;
    }
    return out;
  };

  mainWindow.webContents.setWindowOpenHandler(({ url, features }) => {
    const isLocal = localOrigins.some((o) => url.startsWith(o));
    if (!isLocal) {
      // Only hand safe schemes to the OS — never file:/smb:/custom handlers.
      try {
        const proto = new URL(url).protocol;
        if (proto === 'http:' || proto === 'https:' || proto === 'mailto:') shell.openExternal(url);
      } catch { /* invalid url — ignore */ }
      return { action: 'deny' };
    }
    // Session pop-out windows: open as a real OS child window with the same
    // preload + isolation as the main window. Without overrideBrowserWindowOptions
    // Electron uses small defaults and doesn't apply the preload, which
    // breaks IME reset + auto-updater bridges the popout may also call.
    let popoutPath;
    try { popoutPath = new URL(url).pathname; } catch { popoutPath = ''; }
    if (popoutPath.startsWith('/popout/')) {
      const feat = parseFeatures(features);
      // Hide the native title bar + app menu (File/Edit/…) for popouts.
      // PopoutPage renders its own 28px top bar (label / re-dock / close) and
      // marks it as a -webkit-app-region drag handle so the window can still
      // be moved. thickFrame stays default → edge resize + shadow remain.
      //
      // Platform split: a fully frameless window (`frame: false`) on Windows
      // never establishes an IME context, so OS Hangul/CJK composition events
      // don't fire and the terminal silently drops composed input (ASCII still
      // works). `titleBarStyle: 'hidden'` keeps the window OS-managed (IME
      // works) while hiding the title bar. macOS/Linux keep `frame: false`
      // (IME unaffected there). Main window is unaffected either way.
      const framelessOpts = process.platform === 'win32'
        ? { titleBarStyle: 'hidden' }
        : { frame: false };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...framelessOpts,
          width: feat.width || 800,
          height: feat.height || 540,
          // x/y intentionally only forwarded when supplied — Electron treats
          // an absent x/y as "let the OS place the window" which is the right
          // default for the button-click path.
          ...(typeof feat.x === 'number' ? { x: feat.x } : {}),
          ...(typeof feat.y === 'number' ? { y: feat.y } : {}),
          minWidth: 360,
          minHeight: 240,
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f0f0f' : '#ffffff',
          webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    return { action: 'allow' };
  });

  // Block top-level navigation to off-origin URLs so injected content / links
  // can't load a remote page inside the trusted, preload-attached window.
  const blockOffOriginNav = (contents) => {
    contents.on('will-navigate', (e, navUrl) => {
      if (!localOrigins.some((o) => navUrl.startsWith(o))) e.preventDefault();
    });
  };
  blockOffOriginNav(mainWindow.webContents);

  // Chromium handles Ctrl+wheel / pinch as a page-zoom gesture in the browser
  // process and never dispatches a DOM `wheel` event to the renderer, so the
  // terminal's own Ctrl+wheel font-zoom can't see it. Cancel the page zoom
  // (pin the level to 0) and forward the direction so the focused terminal can
  // bump its font size instead.
  const wireTerminalZoom = (contents, label) => {
    contents.on('zoom-changed', (_e, zoomDirection) => {
      contents.setZoomLevel(0);
      contents.send('terminal:zoom', zoomDirection);
      imeDebugLog(label, { event: 'zoom-changed', dir: zoomDirection });
    });
  };
  wireTerminalZoom(mainWindow.webContents, 'mainWindow');

  // Newly-created child windows (popouts) inherit the main window's
  // setWindowOpenHandler but not the lock-screen focus-recovery handler.
  // Attach the same focus → webContents.focus() bridge so xterm typing
  // doesn't go dead after resume.
  mainWindow.webContents.on('did-create-window', (childWin) => {
    blockOffOriginNav(childWin.webContents);
    wireTerminalZoom(childWin.webContents, 'popout');
    attachFocusRebindBridge(childWin, 'popout');
    attachImeWindowLogging(childWin, 'popout');
  });

  attachImeWindowLogging(mainWindow, 'mainWindow');

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (event) => {
    if (!isDesktopPlatform(process.platform) || isQuitting) return;
    event.preventDefault();
    if (closeBehavior === 'tray' && traySupported) mainWindow.hide();
    else requestRealQuit();
  });
  mainWindow.on('query-session-end', () => { isQuitting = true; });
  mainWindow.on('session-end', () => { isQuitting = true; });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Windows lock-screen / screensaver hands the native HWND keyboard focus
  // off to the lock UI; on resume it doesn't always return to webContents,
  // leaving every input (SessionForm, SessionTerminal) dead until the user
  // minimizes and restores.
  attachFocusRebindBridge(mainWindow, 'mainWindow');
}

ipcMain.on('ime:log', (_event, payload) => {
  imeDebugLog('renderer', payload && typeof payload === 'object' ? payload : { payload });
});

ipcMain.on('ime:set-debug', (_event, enabled) => {
  const on = !!enabled;
  // Log a fresh startup snapshot on each enable so the log always opens with
  // the runtime state (occlusion switch value, versions) even mid-session.
  if (on && !imeDebugEnabled) {
    imeDebugEnabled = true;
    logImeStartup();
  } else {
    imeDebugEnabled = on;
  }
});

ipcMain.handle('desktop:get-settings', getDesktopSettings);

ipcMain.handle('desktop:update-settings', (_event, patch) => {
  if (!isDesktopPlatform(process.platform) || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Desktop settings are unavailable');
  }
  if ('closeBehavior' in patch) {
    if (patch.closeBehavior !== 'tray' && patch.closeBehavior !== 'quit') {
      throw new Error('Invalid close behavior');
    }
    if (patch.closeBehavior === 'tray' && !traySupported) {
      throw new Error('Tray integration is unavailable');
    }
    updateDesktopConfig({ closeBehavior: patch.closeBehavior });
  }
  if ('openAtLogin' in patch) {
    if (typeof patch.openAtLogin !== 'boolean' || !getDesktopSettings().autostartSupported) {
      throw new Error('Startup is only available in packaged desktop builds');
    }
    setOpenAtLogin(patch.openAtLogin);
  }
  return getDesktopSettings();
});

ipcMain.on('desktop:set-language', (_event, language) => {
  if (!Object.hasOwn(trayLabels, language)) return;
  trayLanguage = language;
  rebuildTrayMenu();
});

// Raise the sender's OS window to the front. Renderers can't do this
// themselves: window.focus() without user activation is ignored by Chromium,
// and popouts reacting to a BroadcastChannel message never have activation.
ipcMain.on('window:focus-self', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.moveTop();
  // Programmatic raise: OS focus moves to this window but Windows TSF keeps
  // the IME context on the window where the triggering click landed, so
  // Hangul composition never starts (ime-debug 2026-07-09). The focus-bridge
  // skips webContents.focus() because isFocused() is already true — force it
  // here. Safe: no composition can be in flight in a window that wasn't focused.
  event.sender.focus();
  imeDebugLog('window:focus-self', { event: 'ime-rebind' });
});

// Minimize the sender's OS window. Frameless popouts render their own top bar
// (no native minimize button) and the web platform offers no equivalent.
ipcMain.on('window:minimize-self', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.isMinimizable()) return;
  win.minimize();
});

ipcMain.on('ime:reset', (event, payload) => {
  // Route the focus call to the sender's webContents so popout child
  // windows reclaim their own keyboard focus, not the main window's.
  // Falls back to mainWindow only if the sender is gone (race during
  // teardown).
  //
  // `force` (form entry / stranded-focus rescue): a plain focus() is a no-op
  // when the window never lost OS focus — Chromium skips the native focus path
  // and the Windows TSF context stays stranded on a just-destroyed terminal
  // helper textarea, so the new form input can't compose Hangul even though DOM
  // focus reads correct. Cycle the whole BrowserWindow (blur → focus): the OS
  // sees a real WM_KILLFOCUS→WM_SETFOCUS pair and the focus-bridge above
  // rebinds webContents, exactly like the alt-tab recovery — the only recovery
  // ime-debug has ever shown working (2026-07-23: five webview-level rescues
  // failed back-to-back, the alt-tab that followed fixed input instantly; the
  // blurWebView() variant shipped 2026-08-03 and form entry was still dead on
  // 2026-08-05, so a webview-internal cycle provably doesn't rebind TSF).
  // Callers only pass force when no composition is in flight, so the blur
  // can't corrupt a healthy context.
  const force = payload && payload.force;
  const sender = event && event.sender;
  if (sender && !sender.isDestroyed()) {
    const win = force ? BrowserWindow.fromWebContents(sender) : null;
    if (win && !win.isDestroyed()) {
      win.blur();
      win.focus();
    }
    sender.focus();
    imeDebugLog('ime:reset', { force: !!force, target: 'sender' });
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (force) {
      mainWindow.blur();
      mainWindow.focus();
    }
    mainWindow.webContents.focus();
    imeDebugLog('ime:reset', { force: !!force, target: 'mainWindow' });
  }
});

function checkForUpdates({ silent } = { silent: true }) {
  if (!app.isPackaged) {
    if (!silent) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: '개발 모드에서는 업데이트 확인을 사용할 수 없습니다.',
      });
    }
    return;
  }
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      console.error('[updater] check failed:', (err && err.message) || err);
      if (!silent && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: '업데이트 확인 실패',
          message: '업데이트를 확인하는 중 오류가 발생했습니다.',
          detail: String((err && err.message) || err),
        });
      }
    })
    .finally(() => {
      updateCheckInFlight = false;
    });
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', (err && err.message) || err);
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info && info.version);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] up-to-date');
  });

  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading ${Math.round(p.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['지금 재시작', '나중에'],
        defaultId: 0,
        cancelId: 1,
        title: 'CLITrigger 업데이트 준비 완료',
        message: `새 버전 ${info && info.version}이(가) 다운로드되었습니다.`,
        detail: '지금 재시작하면 업데이트가 적용됩니다. 나중에 선택 시 다음 종료 시점에 자동 설치됩니다.',
      })
      .then((result) => {
        if (result.response === 0) {
          isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });

  setTimeout(() => checkForUpdates({ silent: true }), 5000);
}

async function resetWebPassword() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['초기화', '취소'],
    defaultId: 1,
    cancelId: 1,
    message: '비밀번호를 초기화할까요?',
    detail:
      '초기화 후 앱 화면에서 새 비밀번호를 설정합니다. 터널이 켜져 있다면 새 비밀번호를 설정하기 전까지 외부 접속자가 먼저 설정할 수 있습니다.',
  });
  if (response !== 0) return;
  try {
    // The server runs in-process, so reuse its already-open DB connection.
    const connectionJs = path.join(path.dirname(resolveServerEntry()), 'db', 'connection.js');
    const { getDatabase } = await import(pathToFileURL(connectionJs).href);
    const db = getDatabase();
    db.prepare(
      "DELETE FROM app_settings WHERE key IN ('auth.password_hash', 'auth.password_changed_at')"
    ).run();
    db.prepare('DELETE FROM auth_sessions').run();
    mainWindow?.reload();
  } catch (err) {
    dialog.showErrorBox('비밀번호 초기화 실패', String(err));
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Open config folder', click: () => shell.openPath(userDataDir) },
        { type: 'separator' },
        {
          label: 'Open in browser',
          click: () => {
            if (serverPort) shell.openExternal(`http://127.0.0.1:${serverPort}`);
          },
        },
        { type: 'separator' },
        {
          label: '비밀번호 초기화',
          click: () => resetWebPassword(),
        },
        { type: 'separator' },
        {
          label: '업데이트 확인',
          click: () => checkForUpdates({ silent: false }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', () => {
  if (isQuitting || (closeBehavior === 'tray' && traySupported)) return;
  requestRealQuit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createWindow(serverPort);
  } else {
    showMainWindow();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;
  // A rejected second instance never booted the in-process server, so it has
  // nothing to clean up and should exit immediately.
  if (!gotLock) return;
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.preventDefault();
  process.emit('SIGTERM');
  setTimeout(() => app.exit(0), 5000);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      const { port } = await bootServer();
      buildMenu();
      createWindow(port);
      createTray();
      setupAutoUpdater();
    } catch (err) {
      dialog.showErrorBox(
        'CLITrigger failed to start',
        String((err && err.stack) || err)
      );
      app.exit(1);
    }
  });
}

app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
});
