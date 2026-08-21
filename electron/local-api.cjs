// WellDone Money — local same-origin API for the desktop shell.
//
// The hosted adapter (scripts/adapter.mjs) answers the /api/* routes for the
// web build. The desktop build has no server by design (see app-protocol.cjs),
// so the app:// protocol handler routes /api/* here instead, where the same
// store shapes are persisted as JSON files under the userData directory.
//
// There is no bridge inside the desktop app: /api/finance/* and Plaid linking
// return clean "unavailable" responses that the frontend already handles, and
// the local stores (card profiles, imports, renewals) are what make the
// packaged app's durable features actually work.
//
// Deliberately dependency-free (no electron import) so it can be exercised
// under plain node --test.
'use strict';

const { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { SECURITY_HEADERS } = require('./app-protocol.cjs');

const JSON_TYPE = 'application/json; charset=utf-8';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': JSON_TYPE },
  });
}

// A parse failure must never silently destroy the only recovery copy: the
// damaged file is moved aside before an empty store is returned, so the next
// write cannot overwrite it. Mirrors the hosted adapter's store behaviour.
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    if (existsSync(file)) {
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch { /* the damaged original stays put if it cannot be moved */ }
    }
    return fallback;
  }
}

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function sanitizeCardProfile(item) {
  if (!item || typeof item !== 'object') return null;
  const owner = String(item.owner || '').trim().slice(0, 60);
  const profile = String(item.profile || '').trim().toLowerCase().slice(0, 80);
  const accountId = String(item.accountId || '').trim().slice(0, 120);
  if (!profile || !/^[a-z0-9-]+$/.test(profile)) return null;
  return { owner, profile, ...(accountId ? { accountId } : {}) };
}

function emptyImportStore() {
  return { schemaVersion: 2, revision: 0, mappings: {}, accounts: [], batches: [], transactions: [], plaidReconciliation: null };
}

// Durable statement backfill. The browser submits normalized transactions and
// audit metadata after confirmation; the local store dedupes by the same
// signature the hosted adapter uses and bumps the revision monotonically.
function commitImportBatch(store, payload) {
  const batch = {
    fileHash: String(payload.fileHash || ''),
    filename: String(payload.filename || '').slice(0, 200),
    format: String(payload.format || '').slice(0, 40),
    institution: String(payload.institution || '').slice(0, 80),
    last4: String(payload.last4 || '').slice(0, 8),
    signature: String(payload.signature || ''),
    accountId: String(payload.accountId || ''),
    rejected: Math.max(0, Number(payload.rejected) || 0),
    confidence: payload.confidence == null ? null : Math.max(0, Math.min(1, Number(payload.confidence) || 0)),
    committedAt: new Date().toISOString(),
  };
  if (!batch.signature) return { error: 'missing signature' };
  const incoming = Array.isArray(payload.transactions) ? payload.transactions : [];
  const seen = new Set(store.transactions.map(t => t.signature).filter(Boolean));
  const fresh = incoming.filter(t => t && typeof t === 'object' && !seen.has(t.signature));
  store.transactions.push(...fresh);
  store.batches.push(batch);
  store.revision = Math.max(store.revision, 0) + 1;
  return { revision: store.revision, batchCount: store.batches.length, transactionCount: store.transactions.length };
}

function createStatementAccount(store, data) {
  if (!data || typeof data !== 'object') throw Object.assign(new Error('account data required'), { status: 400 });
  const account = {
    id: String(data.id || `stmt-${store.accounts.length + 1}`),
    name: String(data.name || '').trim().slice(0, 80),
    institution: String(data.institution || '').trim().slice(0, 80),
    last4: String(data.last4 || '').trim().slice(0, 8),
    kind: String(data.kind || 'checking').slice(0, 20),
  };
  if (!account.name) throw Object.assign(new Error('account name required'), { status: 400 });
  const dup = store.accounts.some(a =>
    a.name.toLowerCase() === account.name.toLowerCase()
    && (a.institution || '').toLowerCase() === (account.institution || '').toLowerCase());
  if (!dup) store.accounts.push(account);
  return account;
}

// Renewals run through the same server-authoritative store class as the hosted
// adapter, so revisions and renew math behave identically in both builds.
let renewalsPromise = null;
function renewalsStore(dataDir) {
  if (!renewalsPromise) {
    renewalsPromise = import(pathToFileURL(join(__dirname, '..', 'scripts', 'renewals-store.mjs')).href)
      .then(({ RenewalsStore }) => new RenewalsStore(join(dataDir, 'renewals.json')));
  }
  return renewalsPromise;
}

function createLocalApi(dataDir) {
  const files = {
    cardProfiles: join(dataDir, 'card-profiles.json'),
    imports: join(dataDir, 'imports.json'),
  };

  return async function handleApi(request, pathname) {
    const method = request.method || 'GET';
    const url = new URL(request.url);
    const bodyText = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await request.text().catch(() => '') : '';

    // --- card profiles (GET list / PUT replace-all, sanitized) ---
    if (pathname === '/api/card-profiles') {
      if (method === 'GET') {
        const list = readJson(files.cardProfiles, []);
        return jsonResponse(200, Array.isArray(list) ? list.map(sanitizeCardProfile).filter(Boolean) : []);
      }
      if (method === 'PUT') {
        let data;
        try { data = JSON.parse(bodyText || '[]'); } catch { return jsonResponse(400, { error: 'invalid JSON' }); }
        if (!Array.isArray(data) || data.length > 100) return jsonResponse(400, { error: 'expected an array with at most 100 entries' });
        const clean = data.map(sanitizeCardProfile).filter(Boolean);
        writeJson(files.cardProfiles, clean);
        return jsonResponse(200, { ok: true, count: clean.length });
      }
      return jsonResponse(405, { error: 'method not allowed' });
    }

    // --- imports (durable statement store) ---
    if (pathname === '/api/imports' && method === 'GET') {
      return jsonResponse(200, readJson(files.imports, emptyImportStore()));
    }
    if (pathname === '/api/imports/commit' && method === 'POST') {
      let payload;
      try { payload = JSON.parse(bodyText || '{}'); } catch { return jsonResponse(400, { error: 'invalid JSON' }); }
      const store = readJson(files.imports, emptyImportStore());
      const result = commitImportBatch(store, payload);
      if (result.error) return jsonResponse(400, result);
      writeJson(files.imports, store);
      return jsonResponse(200, result);
    }
    if (pathname === '/api/imports/accounts' && method === 'POST') {
      let data;
      try { data = JSON.parse(bodyText || '{}'); } catch { return jsonResponse(400, { error: 'invalid JSON' }); }
      try {
        const store = readJson(files.imports, emptyImportStore());
        const account = createStatementAccount(store, data);
        writeJson(files.imports, store);
        return jsonResponse(201, account);
      } catch (error) {
        return jsonResponse(error.status || 400, { error: String(error?.message || error).slice(0, 160) });
      }
    }

    // --- renewals (server-authoritative store, schema v3) ---
    const rnMatch = pathname.match(/^\/api\/renewals(?:\/([^/]+))?(?:\/(renew|undo-renew))?$/);
    if (rnMatch) {
      const [_, rnId, rnAction] = rnMatch;
      try {
        const store = await renewalsStore(dataDir);
        if (!rnId && method === 'GET') return jsonResponse(200, store.list());
        if (pathname === '/api/renewals/summary' && method === 'GET') return jsonResponse(200, store.summary());
        if (!rnId && method === 'POST') return jsonResponse(201, store.create(JSON.parse(bodyText || '{}')));
        if (rnId && rnAction === 'renew' && method === 'POST') return jsonResponse(200, store.renew(rnId, String((JSON.parse(bodyText || '{}').opId) || '')));
        if (rnId && rnAction === 'undo-renew' && method === 'POST') return jsonResponse(200, store.undoRenew(rnId));
        if (rnId && !rnAction && method === 'PATCH') {
          const body = JSON.parse(bodyText || '{}');
          return jsonResponse(200, store.patch(rnId, body.rev, body));
        }
        if (rnId && !rnAction && method === 'DELETE') {
          const body = JSON.parse(bodyText || '{}');
          return jsonResponse(200, store.remove(rnId, body.rev));
        }
        return jsonResponse(405, { error: 'method not allowed' });
      } catch (error) {
        if (error && error.status === 409) return jsonResponse(409, { error: 'conflict', current: (await renewalsStore(dataDir)).list() });
        if (error && error.status === 404) return jsonResponse(404, { error: 'not found' });
        if (error && error.status === 400) return jsonResponse(400, { error: String(error.message || error).slice(0, 160) });
        return jsonResponse(500, { error: String(error?.message || error).slice(0, 160) });
      }
    }

    // --- private finance (empty in the public build) ---
    if (pathname === '/api/private-finance' && method === 'GET') {
      return jsonResponse(200, { investments: {}, incomeRules: [] });
    }

    // --- bridge data and Plaid linking need the hosted bridge ---
    if (pathname.startsWith('/api/finance/') && method === 'GET') {
      return jsonResponse(404, { error: 'live bridge data is only available in the hosted build' });
    }
    if (pathname === '/api/plaid/connect/start' && method === 'POST') {
      return jsonResponse(503, { error: 'Plaid linking requires the hosted bridge' });
    }
    if (pathname.startsWith('/api/plaid/connect/status/') && method === 'GET') {
      return jsonResponse(404, { error: 'no Plaid session in the desktop build' });
    }

    return jsonResponse(404, { error: 'not found' });
  };
}

module.exports = { createLocalApi, emptyImportStore, commitImportBatch, createStatementAccount };
