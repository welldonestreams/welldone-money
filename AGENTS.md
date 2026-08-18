# WellDone Money (public) — agent guide

Read this file first, then `README.md`, `BRIDGE-CONTRACT.md`, and
`DATA-MODEL.md` before making changes.

## Scope — this is the PUBLIC product

This repo is the public, multi-user WellDone Money desktop app. It is a fork of
the owner's personal app with the private features removed, and it must stay
that way.

- Never add the private app's paystub features here: pay-document upload, PDF
  pay-statement parsing, payroll-deduction classification, or brokerage
  statement archives. Those belong to the private sibling app only and must not
  be reintroduced, including in comments, fixtures, or test data.
- This repository is public. Never commit real transactions, balances, account
  numbers, statement files, API credentials, access tokens, personal addresses,
  employer or employment details, or screenshots.
- The history is intentionally rootless — it does not descend from the private
  app, so none of the removed code is recoverable from this repo's log. Never
  merge, rebase, or cherry-pick from the private repo; port changes by hand.

## Commits

- Every commit must be authored as `welldonestreams <chanceweldon11@gmail.com>`.
- Never use an AI agent name as author or committer.
- No AI-attribution trailers or footers in commit messages ("Co-Authored-By:
  Claude", "Generated with Claude Code", etc.) and none in PR bodies, unless
  the user explicitly asks for one.
- Non-trivial work goes on `feat/*` branches; surface the branch name in
  handoffs so other agents don't collide on a shared checkout.

## Purpose

A privacy-first personal-finance desktop app and companion for Actual Budget.
It tracks accounts, card perks, deadlines, statement credits, and import
history while producing clean Actual-compatible CSV files. Live bank data
arrives through Plaid via the hosted backend; see `BRIDGE-CONTRACT.md`.

## Safety boundaries

- Keep real user data in browser storage or ignored `private/`, `imports/`, and
  `exports/` paths only.
- Use masked labels in documentation. Four-digit suffixes are still private and
  should not be committed unless the user explicitly requests it.
- Do not connect to banks by scraping credentials or automating bank logins.
  Live sync must use an approved aggregator with revocable tokens stored
  outside the repository.
- Imported files are untrusted. Parse defensively, cap file sizes, normalize
  dates and amounts, and never execute file content.
- Never mutate Actual Budget automatically until the destination account and
  duplicate behavior have been verified.
- Never render missing data as zero. Absent and zero are different facts; see
  the staleness fields required by `BRIDGE-CONTRACT.md`.

## Engineering rules

- The frontend is static, local-first, and dependency-free at runtime. Electron
  is the shell only.
- `electron/app-protocol.cjs` is the desktop serving path. It must carry the
  same security headers as `nginx.conf`, and the CSP stays a real response
  header — a `<meta>` policy silently drops `frame-ancestors`, `base-uri`, and
  `form-action`. `tests/app-protocol.test.mjs` asserts the served headers, not
  the source text.
- The shell must never spawn a server or bind a port. The bundle is served from
  the registered `app://` scheme; `protocol.registerSchemesAsPrivileged` has to
  run at module scope, before `app.whenReady()`.
- The CSP has no `'unsafe-inline'` for scripts, so `index.html` must not carry
  an inline `<script>` — it will be blocked silently. Put it in a file.
- `src/parser.js` is the authoritative transaction parser. Add fixtures and
  tests for every supported format or institution variant.
- Preserve stable transaction IDs. Prefer OFX/QFX `FITID`; otherwise use the
  deterministic fingerprint in `src/parser.js`.
- Credit-card imports must use Actual's sign convention: purchases are negative
  and payments/refunds are positive.
- Never mix current balance snapshots with transaction-history totals. A
  snapshot is an as-of observation; imports are a ledger.
- Keep storage migrations backward-compatible and increment `SCHEMA_VERSION`
  when persisted data changes.
- Anything listed in `index.html` must also appear in the electron-builder
  `files` array in `package.json`, or the packaged app ships without it.
- The app must remain usable on mobile and keyboard-accessible.

## Verification

Run before every commit:

```text
npm test
```

Then confirm the private features have not crept back in:

```text
grep -rnE 'paystub|pay-parse|pay-statement|pdf-text|allotment' --include='*.js' --include='*.mjs' --include='*.html' --include='*.css' --include='*.md' --exclude=AGENTS.md .
```

For UI changes, also run the app (`npm start`) and verify dashboard, accounts,
benefits, imports, and settings at desktop and narrow widths.

## Publishing

- Inspect `git status` and `git diff` before staging.
- Never stage ignored financial data.
- Keep commits focused.
