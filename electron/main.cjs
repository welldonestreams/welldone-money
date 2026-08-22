// WellDone Money — Electron shell.
//
// The bundle is served from a registered app:// scheme rather than a spawned
// loopback HTTP server. See app-protocol.cjs for why. There is no child
// process, no port, and no startup handshake: the window either loads or the
// failure is shown in a dialog.
const { app, BrowserWindow, Menu, dialog, protocol, screen, session, shell } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { SCHEME, ORIGIN, createHandler } = require('./app-protocol.cjs');

const BUNDLE_ROOT = path.join(__dirname, '..');
const DEFAULT_BOUNDS = { width: 1200, height: 800 };
const MIN_SIZE = { width: 900, height: 640 };
// A corrupted or hand-edited window-state.json could hold a huge finite number
// (e.g. 1e9); Math.max floors it but nothing capped it, so the window would
// open larger than any display with no in-app way to recover. 8K is a generous
// ceiling that no real monitor exceeds.
const MAX_SIZE = { width: 7680, height: 4320 };

// Must run before the app is ready. Without `standard` the scheme cannot
// resolve relative URLs, and without `secure` the page is treated as an
// insecure origin, which disables service workers and storage APIs.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let mainWindow = null;

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadBounds() {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8'));
    const width = Number(saved.width);
    const height = Number(saved.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return { ...DEFAULT_BOUNDS };
    const bounds = {
      width: Math.min(MAX_SIZE.width, Math.max(MIN_SIZE.width, Math.round(width))),
      height: Math.min(MAX_SIZE.height, Math.max(MIN_SIZE.height, Math.round(height))),
      maximized: saved.maximized === true,
    };
    // A saved position is only restored if it still lands on a connected
    // display. Unplugging the monitor it was on must not open the window
    // somewhere the user cannot reach it.
    const x = Number(saved.x);
    const y = Number(saved.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const visible = screen.getAllDisplays().some(({ workArea }) =>
        x + bounds.width > workArea.x
        && y + bounds.height > workArea.y
        && x < workArea.x + workArea.width
        && y < workArea.y + workArea.height);
      if (visible) { bounds.x = Math.round(x); bounds.y = Math.round(y); }
    }
    return bounds;
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

function saveBounds(win) {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds reports the restored geometry, so maximizing and
    // quitting does not persist the screen-sized window as the normal size.
    const bounds = win.getNormalBounds();
    writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }), 'utf8');
  } catch { /* a window that cannot be persisted is not worth failing quit over */ }
}

function showAbout() {
  dialog.showMessageBox(mainWindow ?? undefined, {
    type: 'info',
    title: 'About WellDone Money',
    message: 'WellDone Money',
    detail: [
      `Version ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node ${process.versions.node}`,
      '',
      'A privacy-first personal finance app. Statement files are parsed on',
      'this machine and are never uploaded by the application.',
    ].join('\n'),
    buttons: ['Close'],
  });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '&File', submenu: [{ role: 'quit' }] },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' }, { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { label: '&Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    { label: '&Help', submenu: [{ label: 'About WellDone Money', click: showAbout }] },
  ]));
}

function createWindow() {
  const bounds = loadBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    backgroundColor: '#0f1115',
    title: 'WellDone Money',
    icon: path.join(BUNDLE_ROOT, 'assets', 'icon.png'),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (bounds.maximized) mainWindow.maximize();
  // Painting an empty frame first is the flash of white every Electron app
  // gets blamed for; wait for the first render instead.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // A link to somewhere else belongs in the user's browser, not in a window
  // with no address bar.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) shell.openExternal(external);
    return { action: 'deny' };
  });
  // Same rule for in-place navigation: nothing may replace the bundle.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) {
      event.preventDefault();
      const external = safeExternalUrl(url);
      if (external) shell.openExternal(external);
    }
  });

  mainWindow.on('close', () => saveBounds(mainWindow));
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // A subframe failing is not the app failing, and ERR_ABORTED (-3) is the
    // cancelled navigation raised by will-navigate/openExternal above — not a
    // real load failure. Showing the error box on either fires a spurious
    // "failed to start" dialog over a perfectly healthy window.
    if (!isMainFrame) return;
    if (code === -3) return;
    dialog.showErrorBox('WellDone Money failed to start',
      `The app could not load its interface.\n\n${description} (${code})\n${url}`);
  });

  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  // A second launch during the startup window (or against a window hidden by a
  // future tray/minimise-to-background behaviour) would otherwise focus a
  // window that is not visible.
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Only one copy of a finance app should ever be open: two windows over the
// same local state would write over each other. A second launch hands focus
// to the running window through the second-instance event above.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    // Finance data never needs camera, location, notifications, clipboard
    // read, or any other Chromium permission. Deny both checks and prompts.
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    protocol.handle(SCHEME, createHandler(BUNDLE_ROOT));
    buildMenu();
    createWindow();
    // macOS keeps the process alive with no windows; reopening from the dock
    // must rebuild one.
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
