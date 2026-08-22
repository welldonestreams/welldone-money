# WellDone Money — desktop app

A personal-finance desktop app: a native window with its own installer, icon,
and Start Menu entry. The interface is served inside the app from a registered
`app://` scheme — there is no local web server, no port, and no browser.

## Install
Download the latest `WellDone-Money-Setup-<version>.exe` from Releases and run
it. Windows SmartScreen warns on installers that are not code-signed; choose
**More info -> Run anyway**.

## Run from source
- `npm install` (pulls Electron + electron-builder)
- `npm start` (launches the app window)
- `npm test` (the full suite, no Electron needed)

## Build the installer yourself
- `npm run dist` — regenerates the icons and produces
  `dist/WellDone-Money-Setup-<version>.exe` (NSIS). `install.cmd` is a
  double-click wrapper for the same thing and needs Node installed.

## Structure
- `electron/main.cjs` — opens the sandboxed native window; it never starts a
  server or binds a port
- `electron/app-protocol.cjs` — serves the bundle over `app://`, with the
  security headers, and is unit-tested without Electron
- `scripts/make-icons.mjs` — renders `assets/icon.svg` to `build/icon.ico`
  and `assets/icon.png` with no image dependencies (`npm run icons`)
- `index.html`, `src/`, `assets/`, `auth.css`, `sw.js` — the app
- `BRIDGE-CONTRACT.md`, `DATA-MODEL.md` — the data model + API contract
  the finance adapter must honor (staleness fields, never silent-zero)

## Data and uninstall behavior

The desktop build is local-first. Manual accounts, statement imports, and app
preferences stay in the Electron profile on this Windows account. Uninstalling
the application preserves that profile so an accidental uninstall is not a
data-loss event; use **Settings -> Clear local data** when deletion is intended.
The app does not add its own at-rest encryption, so use Windows device
encryption or BitLocker for protection when the computer is powered off.

The packaged `app://` build does not embed the private server adapter or bank
credentials. Hosted Plaid sync and server-authoritative household features are
available only in a separately deployed, authenticated dashboard that follows
`BRIDGE-CONTRACT.md`; the desktop app must remain useful with local imports
when that service is unavailable.
