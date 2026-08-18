# WellDone Money — desktop app

A personal-finance desktop app. Native window (Electron shell) wrapping a
local, dependency-free server (`scripts/serve.mjs`) that serves the static
frontend and proxies finance data.

## Run in dev
- `npm install` (pulls Electron + electron-builder)
- `npm start` (launches the app window)

## Build the Windows installer
- Double-click `install.cmd` — or `npm run dist` — produces
  `dist/WellDone Money Setup <version>.exe` (NSIS).

## Structure
- `electron/main.cjs` — spawns the local server, opens the window
- `scripts/serve.mjs` — static server (Node builtins, no deps)
- `index.html`, `src/`, `assets/`, `auth.css`, `sw.js` — the app
- `BRIDGE-CONTRACT.md`, `DATA-MODEL.md` — the data model + API contract
  the finance adapter must honor (staleness fields, never silent-zero)
