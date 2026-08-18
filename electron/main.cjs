// WellDone Money — Electron shell.
// Starts the local finance server (scripts/serve.mjs, plain Node builtins,
// no deps) on an ephemeral port, VERIFIES it is our server via a nonce, and
// only then opens the window. On any startup failure we surface a visible
// error instead of a blank window.
const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const HEALTH_NONCE = 'welldone-money-ok';
let server = null;
let serverPort = null;
let killed = false;

function killServer() {
  if (killed) return;
  killed = true;
  if (server) {
    try { server.kill(); } catch (_) {}
    server = null;
  }
}

function fail(message) {
  killServer();
  dialog.showErrorBox('WellDone Money failed to start', message);
  app.quit();
}

// Resolve to a port only after /__health answers with our nonce — never
// trust a bare TCP connect on a port another process could hold.
function verifyServer(port, cb) {
  let tries = 0;
  (function poll() {
    const req = http.get({ host: '127.0.0.1', port, path: '/__health', timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200 && data.trim() === HEALTH_NONCE) {
          cb(port);
        } else if (++tries > 60) {
          fail('The local server answered on the port but did not identify itself.');
        } else {
          setTimeout(poll, 100);
        }
      });
    });
    req.on('error', () => {
      if (++tries > 60) { fail('The local server did not start.'); }
      else { setTimeout(poll, 100); }
    });
    req.on('timeout', () => { req.destroy(); });
  })();
}

function startServer() {
  const script = path.join(__dirname, '..', 'scripts', 'serve.mjs');
  // ELECTRON_RUN_AS_NODE makes the electron binary behave as plain node,
  // which works both in dev and inside the packaged app. PORT=0 asks
  // serve.mjs for an ephemeral port, reported back as PORT=<n> on stdout.
  server = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    const m = chunk.match(/PORT=(\d+)/);
    if (m && !serverPort) {
      serverPort = Number(m[1]);
      verifyServer(serverPort, (port) => openWindow(port));
    }
  });
  server.on('exit', () => { server = null; });
}

function openWindow(port) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'WellDone Money',
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { killServer(); });
}

app.whenReady().then(startServer);

app.on('before-quit', killServer);
app.on('will-quit', killServer);
app.on('window-all-closed', () => {
  killServer();
  app.quit();
});
