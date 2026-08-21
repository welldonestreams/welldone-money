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
- `electron/main.cjs` — the Electron entry point: registers the `app://` scheme, opens the window, and wires the local `/api/*` stores
- `electron/app-protocol.cjs` — serves the bundle over `app://`, with the
  security headers, and is unit-tested without Electron
- `electron/local-api.cjs` — answers the durable `/api/*` stores (card
  profiles, imports, renewals) from JSON files under the app's userData
  directory; bridge and Plaid routes are unavailable in the desktop build
- `scripts/make-icons.mjs` — renders `assets/icon.svg` to `build/icon.ico`
  and `assets/icon.png` with no image dependencies (`npm run icons`)
- `index.html`, `src/`, `assets/`, `auth.css`, `sw.js` — the app
- `BRIDGE-CONTRACT.md`, `DATA-MODEL.md` — the data model + API contract
  the finance adapter must honor (staleness fields, never silent-zero)
