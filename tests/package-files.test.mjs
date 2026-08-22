import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// styles.css was linked by index.html but missing from electron-builder's
// files array, so the packaged installer shipped an unstyled app while every
// test passed. This closes that gap: anything the page loads must be packaged.
const root = new URL('..', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const pkg = JSON.parse(read('package.json'));

function packaged(path) {
  return pkg.build.files.some((pattern) => {
    const base = pattern.replace(/\/\*\*$/, '');
    return pattern.endsWith('/**') ? path === base || path.startsWith(`${base}/`) : path === pattern;
  });
}

test('every asset index.html loads is in the packaged files list', () => {
  const html = read('index.html');
  const referenced = [...html.matchAll(/(?:src|href)="\.?\/?([^"#:]+?)"/g)]
    .map(match => match[1].replace(/^\.\//, ''))
    .filter(path => !path.startsWith('http') && path.includes('.'));
  assert.ok(referenced.length >= 4, 'expected to find the page assets');
  const missing = referenced.filter(path => !packaged(path));
  assert.deepEqual(missing, [], `these are loaded but would not ship: ${missing.join(', ')}`);
});

test('the window icon and the installer icon are both configured', () => {
  // A missing icon key is why the app would otherwise show the default
  // Electron logo in the taskbar, Start Menu and installer.
  assert.equal(pkg.build.icon, 'build/icon.ico');
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.nsis.installerIcon, 'build/icon.ico');
  assert.match(read('electron/main.cjs'), /icon: path\.join\(BUNDLE_ROOT, 'assets', 'icon\.png'\)/);
  // build/ is generated, so dist must regenerate it rather than assume it.
  assert.match(pkg.scripts.dist, /npm run icons/);
});

test('the shell keeps its security posture', () => {
  const main = read('electron/main.cjs');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /corsEnabled: true/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /safeExternalUrl/);
  assert.match(main, /requestSingleInstanceLock/);
  // registerSchemesAsPrivileged has to run before the app is ready, so it
  // must not be inside whenReady().
  const privileged = main.indexOf('registerSchemesAsPrivileged');
  const ready = main.indexOf('app.whenReady()');
  assert.ok(privileged !== -1 && ready !== -1 && privileged < ready,
    'registerSchemesAsPrivileged must run before app.whenReady()');
  assert.doesNotMatch(main, /child_process|spawn\(/, 'the shell must not spawn a server');
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false, 'uninstall must preserve local financial data');
});
