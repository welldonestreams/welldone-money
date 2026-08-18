// WellDone Money — same-origin server adapter (BRIDGE-CONTRACT.md).
//
// Serves the static dashboard AND proxies ONLY the whitelisted read-only
// /api/finance/* routes to the Hermes bridge, attaching the bridge read token
// server-side. Browser JavaScript never sees the token. No arbitrary paths,
// methods, admin ops, or Plaid calls are proxied.

import http from "node:http";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";

// ---- Owner sessions ----
// The cookie carries a RANDOM per-login session id (never the auth token).
// Only a SHA-256 hash + expiry lives server-side, so logout can invalidate
// exactly that session and a leaked cookie dies with it.
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 720); // 30 days
const COOKIE = "wmd_session";
const sessions = new Map(); // sha256(sid) -> { exp }

function sessionHash(sid) {
  return createHash("sha256").update(String(sid)).digest("hex");
}

function createSession() {
  const sid = randomBytes(32).toString("hex");
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  sessions.set(sessionHash(sid), { exp });
  return sid;
}

function destroySession(sid) {
  sessions.delete(sessionHash(sid));
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((c) => c.trim());
  const hit = cookies.find((c) => c.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : "";
}

function isAuthed(req) {
  if (!sessions.size) return false;
  const sid = cookieValue(req, COOKIE);
  if (!sid) return false;
  const rec = sessions.get(sessionHash(sid));
  return Boolean(rec) && rec.exp > Date.now();
}

// ---- 4-digit PIN login with brute-force throttling (per client IP) ----
// NPM is the only ingress (direct port is closed). It appends the real client
// to X-Forwarded-For, so use the last value; the first value is spoofable.
const PIN = process.env.PIN || "";
const pinFails = new Map(); // ip -> { count, until }

function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "");
  const chain = xff.split(",").map(value => value.trim()).filter(Boolean);
  return (chain.at(-1) || req.socket.remoteAddress || "unknown");
}

function pinBlocked(ip) {
  const e = pinFails.get(ip);
  if (!e) return false;
  if (e.until && Date.now() > e.until) { pinFails.delete(ip); return false; }
  return e.count >= 5;
}

function pinCheck(ip, pin) {
  if (!PIN || !safeEqual(pin, PIN)) {
    const e = pinFails.get(ip) || { count: 0, until: 0 };
    e.count += 1;
    if (e.count >= 5) e.until = Date.now() + 60000 * (2 ** Math.min(e.count - 5, 4)); // 60,120,240...
    pinFails.set(ip, e);
    return false;
  }
  pinFails.delete(ip);
  return true;
}

const LOGIN_FORM = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WellDone Money — Sign in</title><script>
  (function(){try{var t=localStorage.getItem('wmd_theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();
</script><link rel="stylesheet" href="/auth.css"><link rel="icon" href="/assets/icon.svg"></head><body>
<div class="auth-wrap">
  <div class="auth-card">
    <div class="brand"><span class="brand-mark" aria-hidden="true">W</span><div><strong>WellDone</strong><span>Money</span></div></div>
    <h1>Sign in</h1>
    <p class="sub">Enter your 4-digit PIN to open the dashboard.</p>
    <form method="post" action="/login" autocomplete="off">
      <label class="pin-label" for="p">PIN</label>
      <input id="p" name="p" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="one-time-code" autofocus required>
      <button type="submit">Sign in</button>
      <p class="err" role="alert">%ERR%</p>
    </form>
  </div>
  <p class="foot">Private dashboard · LAN &amp; Tailscale only</p>
</div>
</body></html>`;

function loginForm(err) {
  const e = err ? String(err) : "";
  return LOGIN_FORM.replace("%ERR%", e);
}


import { readFile, stat } from "node:fs/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { buildPlaidMerchantModel, enrichStatementTransaction, normalizePlaidTransactions, plaidCoverageByAccount, reconcileImportedTransactions } from "./plaid-import-learning.mjs";

const ROOT = process.env.STATIC_ROOT || "/app/www";
const DATA_DIR = process.env.DATA_DIR || "/data";
const PORT = Number(process.env.PORT || 8080);
const BRIDGE = process.env.BRIDGE_BASE || "";
const WHITELIST = new Set(["summary", "accounts", "transactions", "recurring", "holdings", "liabilities", "status"]);

// Bridge read token: single-file secret mount preferred, env fallback.
function readBridgeToken() {
  if (process.env.BRIDGE_READ_TOKEN) return process.env.BRIDGE_READ_TOKEN;
  const p = "/run/secrets/read_token";
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  return "";
}
const BRIDGE_TOKEN = readBridgeToken();

function readBridgeAdminToken() {
  if (process.env.BRIDGE_ADMIN_TOKEN) return process.env.BRIDGE_ADMIN_TOKEN;
  const path = "/run/secrets/admin_token";
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  return "";
}
const BRIDGE_ADMIN_TOKEN = readBridgeAdminToken();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cache-Control": "no-store",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { ...HEADERS, "Content-Type": type });
  res.end(body);
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const file = resolve(join(ROOT, "." + rel));
  if (!file.startsWith(ROOT + sep) && file !== ROOT) return send(res, 403, "forbidden\n");
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, "not found\n");
    const data = await readFile(file);
    // sw.js must never be cached, or SW updates never reach the browser.
    const headers = rel === "/sw.js"
      ? { ...HEADERS, "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" }
      : { ...HEADERS, "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" };
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    // SPA fallback: unknown paths serve the app shell (like nginx try_files)
    try {
      const idx = await readFile(join(ROOT, "index.html"));
      send(res, 200, idx, MIME[".html"]);
    } catch {
      send(res, 404, "not found\n");
    }
  }
}

async function proxyFinance(req, res, endpoint, query) {
  if (!WHITELIST.has(endpoint)) return send(res, 404, "not found\n");
  if (!BRIDGE_TOKEN) return send(res, 503, "bridge token not configured\n");
  const qs = query && query.length > 1 ? "?" + query : "";
  const target = `${BRIDGE}/v1/finance/${endpoint}${qs}`;
  try {
    const resp = await fetch(target, {
      headers: { "X-Finance-Token": BRIDGE_TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const body = await resp.text();
    // pass through status + JSON (bridge already sanitizes; metadata preserved)
    res.writeHead(resp.status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  } catch (e) {
    send(res, 502, JSON.stringify({ error: "upstream unavailable", detail: String(e).slice(0, 120) }));
  }
}

// ---- Renewals (server-authoritative store, schema v3) ----
// Item-level operations with per-item revisions; stale writes 409. The renew
// endpoint computes dates + records payments server-side. See renewals-store.mjs.
const RENEWALS_FILE = join(DATA_DIR, "renewals.json");
import { RenewalsStore } from "./renewals-store.mjs";
const renewals = new RenewalsStore(RENEWALS_FILE);
const CARD_PROFILES_FILE = join(DATA_DIR, "card-profiles.json");
const IMPORTS_FILE = join(DATA_DIR, "imports.json");
const PRIVATE_FINANCE_FILE = join(DATA_DIR, "private-finance.json");
function loadPrivateFinance() {
  try {
    const parsed = JSON.parse(readFileSync(PRIVATE_FINANCE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { investments: {}, incomeRules: [] };
  } catch {
    return { investments: {}, incomeRules: [] };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function loadCardProfiles() {
  try {
    const parsed = JSON.parse(readFileSync(CARD_PROFILES_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.map(sanitizeCardProfile).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveCardProfiles(list) {
  const tmp = CARD_PROFILES_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CARD_PROFILES_FILE);
}

function sanitizeCardProfile(item) {
  if (!item || typeof item !== "object") return null;
  const owner = String(item.owner || "").trim().slice(0, 60);
  const profile = String(item.profile || "").trim().toLowerCase().slice(0, 80);
  const accountId = String(item.accountId || "").trim().slice(0, 120);
  if (!profile || !/^[a-z0-9-]+$/.test(profile)) return null;
  return { owner, profile, ...(accountId ? { accountId } : {}) };
}

function safePlaidUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && (url.hostname === "plaid.com" || url.hostname.endsWith(".plaid.com")) ? url.href : "";
  } catch { return ""; }
}

async function startPlaidLink(res) {
  if (!BRIDGE_ADMIN_TOKEN) return sendJson(res, 503, { error: "Plaid linking is not configured" });
  try {
    const response = await fetch(`${BRIDGE}/admin/connect/start?mode=banking&days_requested=730`, {
      method: "POST",
      headers: { "X-Admin-Token": BRIDGE_ADMIN_TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({}));
    const linkUrl = safePlaidUrl(payload.link_url);
    const sessionId = String(payload.session_id || "");
    if (!response.ok || !linkUrl || !/^[a-f0-9]{32}$/i.test(sessionId)) return sendJson(res, 502, { error: "Plaid could not start a secure link session" });
    return sendJson(res, 200, { sessionId, linkUrl });
  } catch {
    return sendJson(res, 502, { error: "Plaid is temporarily unavailable" });
  }
}

async function plaidLinkStatus(res, sessionId) {
  if (!BRIDGE_ADMIN_TOKEN || !/^[a-f0-9]{32}$/i.test(sessionId)) return sendJson(res, 404, { error: "not found" });
  try {
    const response = await fetch(`${BRIDGE}/admin/connect/status/${sessionId}`, {
      headers: { "X-Admin-Token": BRIDGE_ADMIN_TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return sendJson(res, response.status === 404 ? 404 : 502, { error: "Plaid session status unavailable" });
    return sendJson(res, 200, { status: payload.status === "completed" ? "completed" : "waiting_for_user" });
  } catch {
    return sendJson(res, 502, { error: "Plaid session status unavailable" });
  }
}

function emptyImportStore() {
  return { schemaVersion: 2, revision: 0, mappings: {}, accounts: [], batches: [], transactions: [], plaidReconciliation: null };
}

function loadImportStore() {
  try {
    const parsed = JSON.parse(readFileSync(IMPORTS_FILE, "utf8"));
    return {
      ...emptyImportStore(),
      ...parsed,
      revision: Math.max(0, Number(parsed.revision) || 0),
      mappings: parsed.mappings && typeof parsed.mappings === "object" ? parsed.mappings : {},
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map(sanitizeStatementAccount).filter(Boolean).slice(-200) : [],
      batches: Array.isArray(parsed.batches) ? parsed.batches.slice(-500) : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions.slice(-100000) : [],
    };
  } catch {
    return emptyImportStore();
  }
}

function saveImportStore(store) {
  const tmp = IMPORTS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, IMPORTS_FILE);
  chmodSync(IMPORTS_FILE, 0o600);
}

async function readJsonBody(req, maxBytes = 6 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function bridgeList(endpoint, key) {
  if (!BRIDGE_TOKEN || !BRIDGE) return [];
  try {
    const response = await fetch(`${BRIDGE}/v1/finance/${endpoint}`, {
      headers: { "X-Finance-Token": BRIDGE_TOKEN, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.[key])) return payload[key];
    return Object.values(payload || {}).find(Array.isArray) || [];
  } catch {
    return [];
  }
}

function stableBridgeAccountId(account) {
  const key = [account.institution, account.account || account.name, account.last4, account.type || account.kind, account.subtype]
    .map(normalizeImportText).join("|");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `bridge-acct-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizeStatementAccount(item) {
  if (!item || typeof item !== "object") return null;
  const institution = String(item.institution || "Statement").trim().slice(0, 120);
  const name = String(item.name || "").trim().slice(0, 120);
  const last4 = String(item.last4 || "").replace(/\D/g, "").slice(-5);
  const kind = ["checking", "savings", "credit", "investment", "other"].includes(String(item.kind)) ? String(item.kind) : "credit";
  if (!name) return null;
  const key = [institution, name, last4, kind].map(normalizeImportText).join("|");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) { hash ^= key.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return { id: `statement-acct-${(hash >>> 0).toString(16).padStart(8, "0")}`, institution, name, last4, kind, source: "statement" };
}

function createStatementAccount(payload) {
  const account = sanitizeStatementAccount(payload);
  if (!account) throw new Error("account name is required");
  const store = loadImportStore();
  const existing = store.accounts.find(item => item.id === account.id);
  if (existing) return { account: existing, created: false, revision: store.revision };
  store.accounts.push(account);
  store.revision += 1;
  saveImportStore(store);
  return { account, created: true, revision: store.revision };
}

function sanitizeImportedTransaction(item) {
  if (!item || typeof item !== "object") return null;
  const date = String(item.date || "").slice(0, 10);
  const amount = Math.round(Number(item.amount) * 100) / 100;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount)) return null;
  return {
    sourceId: String(item.id || item.sourceId || "").slice(0, 180),
    date,
    payee: String(item.payee || "Unknown").trim().slice(0, 240),
    notes: String(item.notes || "").trim().slice(0, 500),
    category: String(item.category || "").trim().slice(0, 120),
    amount,
    cleared: item.cleared !== false,
    sourceType: String(item.sourceType || "statement").slice(0, 40),
  };
}

function normalizeImportText(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function importTextAffinity(left, right) {
  const a = new Set(normalizeImportText(left).split(" ").filter(Boolean));
  const b = new Set(normalizeImportText(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
function sameImportedTransaction(left, right) {
  if (left.accountId && right.accountId && left.accountId !== right.accountId) return false;
  if (left.date !== right.date || Math.round(Number(left.amount) * 100) !== Math.round(Number(right.amount) * 100)) return false;
  const a = normalizeImportText(left.payee || left.name || left.merchant);
  const b = normalizeImportText(right.payee || right.name || right.merchant);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a) || importTextAffinity(a, b) >= 0.6));
}

async function currentPlaidContext(rawAccounts = null, rawTransactions = null) {
  const accounts = rawAccounts || await bridgeList("accounts", "accounts");
  const accountByName = new Map(accounts.map(account => [String(account.account || account.name || ""), stableBridgeAccountId(account)]));
  const transactions = rawTransactions || (await Promise.all(accounts.map(account => {
    const name = String(account.account || account.name || "");
    return bridgeList(`transactions?limit=1000&account=${encodeURIComponent(name)}`, "transactions");
  }))).flat();
  const plaid = normalizePlaidTransactions(transactions, accountByName);
  return { accounts, accountByName, plaid, coverage: plaidCoverageByAccount(plaid), model: buildPlaidMerchantModel(plaid) };
}

async function reconcileImportStoreWithPlaid({ force = false } = {}) {
  const store = loadImportStore();
  const lastRun = Date.parse(store.plaidReconciliation?.at || "");
  if (!force && Number.isFinite(lastRun) && Date.now() - lastRun < 15 * 60 * 1000) {
    return { ...store.plaidReconciliation, revision: store.revision, cached: true };
  }
  const context = await currentPlaidContext();
  if (!context.accounts.length || !context.plaid.length) throw new Error("Plaid history unavailable; existing imports left unchanged");
  const result = reconcileImportedTransactions(store.transactions, context.plaid);
  const now = new Date().toISOString();
  const changed = result.superseded.length > 0 || JSON.stringify(result.transactions) !== JSON.stringify(store.transactions);
  const supersededByBatch = new Map();
  for (const item of result.superseded) {
    const prefix = String(item.id || "").split(":")[1] || "";
    if (prefix) supersededByBatch.set(prefix, (supersededByBatch.get(prefix) || 0) + 1);
  }
  for (const batch of store.batches) {
    const prefix = String(batch.fileHash || "").slice(0, 16);
    const newlyCovered = supersededByBatch.get(prefix) || 0;
    if (newlyCovered) batch.plaidCovered = Math.max(0, Number(batch.plaidCovered) || 0) + newlyCovered;
  }
  store.schemaVersion = 2;
  store.transactions = result.transactions;
  store.plaidReconciliation = {
    at: now,
    superseded: result.superseded.length,
    activeImported: result.transactions.length,
    coverage: [...result.coverage.entries()].map(([accountId, value]) => ({ accountId, ...value })),
  };
  if (changed) store.revision += 1;
  saveImportStore(store);
  return { ...store.plaidReconciliation, revision: store.revision };
}

async function commitImportBatch(payload) {
  if (!payload || typeof payload !== "object") throw new Error("invalid import payload");
  const fileHash = String(payload.fileHash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fileHash)) throw new Error("invalid file hash");
  const accountId = String(payload.accountId || "").slice(0, 80);
  const signature = String(payload.signature || "").slice(0, 300);
  const incoming = Array.isArray(payload.transactions) ? payload.transactions.map(sanitizeImportedTransaction).filter(Boolean) : [];
  if (!accountId || !signature || !incoming.length || incoming.length > 10000) throw new Error("invalid import batch");

  const store = loadImportStore();
  const priorBatch = store.batches.find(batch => batch.fileHash === fileHash);

  const context = await currentPlaidContext();
  const validIds = new Set([...context.accountByName.values(), ...store.accounts.map(account => account.id)]);
  if (!validIds.has(accountId)) throw new Error("destination account is not a current Plaid account");
  const plaid = context.plaid.filter(item => item.accountId === accountId);
  const before = store.transactions.filter(item => item.accountId === accountId);
  const usedPlaid = new Set();
  const accepted = [];
  let duplicates = 0;
  incoming.forEach((item, index) => {
    const candidate = { ...item, accountId };
    const plaidIndex = plaid.findIndex((existing, i) => !usedPlaid.has(i) && sameImportedTransaction(candidate, existing));
    const storedDuplicate = before.some(existing => existing.sourceId && candidate.sourceId && existing.sourceId === candidate.sourceId) || before.some(existing => sameImportedTransaction(candidate, existing));
    if (plaidIndex >= 0 || storedDuplicate) {
      if (plaidIndex >= 0) usedPlaid.add(plaidIndex);
      duplicates += 1;
      return;
    }
    accepted.push({ ...enrichStatementTransaction(candidate, accountId, context.model), id: `import:${fileHash.slice(0, 16)}:${index}`, importedAt: new Date().toISOString() });
  });
  const batch = priorBatch || {
    id: `batch:${fileHash.slice(0, 20)}`,
    fileHash,
    filename: String(payload.filename || "statement").replace(/[\r\n]/g, " ").slice(0, 240),
    format: String(payload.format || "").slice(0, 40),
    institution: String(payload.institution || "").slice(0, 120),
    last4: String(payload.last4 || "").replace(/\D/g, "").slice(-5),
    signature,
    accountId,
    accepted: 0,
    duplicates: 0,
    plaidCovered: 0,
    rejected: Math.max(0, Number(payload.rejected) || 0),
    confidence: Math.max(0, Math.min(100, Number(payload.confidence) || 0)),
    importedAt: new Date().toISOString(),
  };
  batch.accepted = Math.max(0, Number(batch.accepted) || 0) + accepted.length;
  batch.duplicates = duplicates;
  batch.plaidCovered = 0;
  batch.importedAt = new Date().toISOString();
  store.transactions.push(...accepted);
  if (!priorBatch) store.batches.push(batch);
  store.mappings[signature] = { accountId, confirmedAt: batch.importedAt };
  store.revision += 1;
  store.schemaVersion = 2;
  saveImportStore(store);
  return { ...batch, alreadyImported: Boolean(priorBatch) && accepted.length === 0, reprocessed: Boolean(priorBatch) && accepted.length > 0, revision: store.revision };
}



const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  // /login: GET shows the PIN form; POST validates the PIN and issues a
  // random per-login session cookie. The old /login?t= bearer path is REMOVED.
  if (url.pathname === "/login") {
    const ip = clientIp(req);
    if (pinBlocked(ip)) return send(res, 429, "too many attempts — try again later\n");
    if (req.method === "GET") {
      res.writeHead(200, { ...HEADERS, "Content-Type": "text/html; charset=utf-8" });
      return res.end(loginForm(""));
    }
    if (req.method !== "POST") return send(res, 405, "method not allowed\n");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const pin = new URLSearchParams(Buffer.concat(chunks).toString()).get("p") || "";
    if (!PIN || !pinCheck(ip, pin)) {
      res.writeHead(401, { ...HEADERS, "Content-Type": "text/html; charset=utf-8" });
      return res.end(loginForm("Wrong PIN — try again"));
    }
    const sid = createSession();
    res.writeHead(302, {
      ...HEADERS,
      Location: "/",
      "Set-Cookie": `${COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    });
    return res.end();
  }

  // /logout: invalidate the exact session server-side and expire the cookie.
  if (url.pathname === "/logout") {
    destroySession(cookieValue(req, COOKIE));
    res.writeHead(302, {
      ...HEADERS,
      Location: "/login",
      "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    });
    return res.end();
  }
  // Public assets that must load WITHOUT a session (SW updates, PWA manifest,
  // app icon) — everything else stays gated.
  const PUBLIC_PATHS = new Set(["/sw.js", "/manifest.webmanifest", "/assets/icon.svg", "/auth.css"]);
  if (req.method === "GET" && PUBLIC_PATHS.has(url.pathname)) {
    return serveStatic(req, res, url.pathname);
  }

  // Everything else — static, API, healthz — requires the cookie. Browser
  // page loads get redirected to the PIN form; API/programmatic clients get 401.
  if (!isAuthed(req)) {
    const accept = String(req.headers.accept || "");
    if (accept.includes("text/html")) {
      res.writeHead(302, { ...HEADERS, Location: "/login" });
      return res.end();
    }
    return send(res, 401, "unauthorized\n");
  }
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok\n");
  if (url.pathname === "/api/plaid/connect/start" && req.method === "POST") return startPlaidLink(res);
  const plaidStatusMatch = url.pathname.match(/^\/api\/plaid\/connect\/status\/([a-f0-9]{32})$/i);
  if (plaidStatusMatch && req.method === "GET") return plaidLinkStatus(res, plaidStatusMatch[1]);
  // Renewals API (authenticated): GET list, PUT replace-all, GET summary.
  // Renewals API (server-authoritative, schema v3): item-level operations
  // with per-item revisions. Stale writes -> 409 + authoritative list.
  const rnMatch = url.pathname.match(/^\/api\/renewals(?:\/([^/]+))?(?:\/(renew|undo-renew))?$/);
  const rnId = rnMatch && rnMatch[1];
  const rnAction = rnMatch && rnMatch[2];
  try {
    if (url.pathname === "/api/renewals" && req.method === "GET") {
      return sendJson(res, 200, renewals.list());
    }
    if (url.pathname === "/api/renewals/summary" && req.method === "GET") {
      return sendJson(res, 200, renewals.summary());
    }
    if (url.pathname === "/api/renewals" && req.method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 201, renewals.create(body));
    }
    if (rnMatch && rnId && rnAction === "renew" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      return sendJson(res, 200, renewals.renew(rnId, String(body.opId || "")));
    }
    if (rnMatch && rnId && rnAction === "undo-renew" && req.method === "POST") {
      return sendJson(res, 200, renewals.undoRenew(rnId));
    }
    if (rnMatch && rnId && req.method === "PATCH") {
      const body = await readBody(req);
      return sendJson(res, 200, renewals.patch(rnId, body.rev, body));
    }
    if (rnMatch && rnId && req.method === "DELETE") {
      const body = await readBody(req).catch(() => ({}));
      return sendJson(res, 200, renewals.remove(rnId, body.rev));
    }
  } catch (e) {
    if (e.status === 409) return sendJson(res, 409, { error: "conflict", current: e.current || renewals.list() });
    if (e.status === 404) return sendJson(res, 404, { error: "not found" });
    if (e.status === 400) return sendJson(res, 400, { error: String(e.message) });
    throw e;
  }
  // Private card-product selections. The public repo contains only the generic
  // issuer catalog; household ownership lives in this authenticated data file.
  if (url.pathname === "/api/card-profiles" && req.method === "GET") {
    return send(res, 200, JSON.stringify(loadCardProfiles()), "application/json; charset=utf-8");
  }
  if (url.pathname === "/api/card-profiles" && req.method === "PUT") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(res, 400, "invalid JSON\n"); }
    if (!Array.isArray(data) || data.length > 100) return send(res, 400, "expected an array with at most 100 entries\n");
    const clean = data.map(sanitizeCardProfile).filter(Boolean);
    saveCardProfiles(clean);
    return send(res, 200, JSON.stringify({ ok: true, count: clean.length }), "application/json; charset=utf-8");
  }
  if (url.pathname === "/api/private-finance" && req.method === "GET") {
    return sendJson(res, 200, loadPrivateFinance());
  }
  // Durable statement backfill. Raw files never reach the server; the browser
  // submits normalized transactions and audit metadata after confirmation.
  if (url.pathname === "/api/imports" && req.method === "GET") {
    return send(res, 200, JSON.stringify(loadImportStore()), "application/json; charset=utf-8");
  }
  if (url.pathname === "/api/imports/reconcile" && req.method === "POST") {
    return send(res, 503, JSON.stringify({ error: "automatic Plaid reconciliation is paused pending a non-destructive ledger repair" }), "application/json; charset=utf-8");
  }
  if (url.pathname === "/api/imports/accounts" && req.method === "POST") {
    try {
      return send(res, 201, JSON.stringify(createStatementAccount(await readJsonBody(req, 64 * 1024))), "application/json; charset=utf-8");
    } catch (error) {
      return send(res, 400, JSON.stringify({ error: String(error?.message || error).slice(0, 160) }), "application/json; charset=utf-8");
    }
  }
  if (url.pathname === "/api/imports/commit" && req.method === "POST") {
    try {
      const payload = await readJsonBody(req);
      const result = await commitImportBatch(payload);
      return send(res, 200, JSON.stringify(result), "application/json; charset=utf-8");
    } catch (error) {
      const message = String(error?.message || error).slice(0, 160);
      const code = message === "request too large" ? 413 : 400;
      return send(res, code, JSON.stringify({ error: message }), "application/json; charset=utf-8");
    }
  }
  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "GET") return send(res, 405, "method not allowed\n");
    const endpoint = url.pathname.slice("/api/finance/".length);
    if (!endpoint || endpoint.includes("/")) return send(res, 404, "not found\n");
    return proxyFinance(req, res, endpoint, url.search.slice(1));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed\n");
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => console.log(`welldone-money adapter on :${PORT}`));
