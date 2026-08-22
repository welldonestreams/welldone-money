import { freshState, SCHEMA_VERSION } from './demo.js';

const STORAGE_KEY = 'finance-hub-state';

export function loadState(storage = localStorage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return freshState();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const recovered = freshState();
    recovered.settings = { ...recovered.settings, storageWarning: 'Saved data could not be read. A recovery copy was preserved.' };
    try { storage.setItem(`${STORAGE_KEY}.corrupt.${Date.now()}`, raw); } catch { /* preserve in memory when storage is full */ }
    return recovered;
  }
  if (!parsed || typeof parsed !== 'object') return freshState();
  const migrated = migrateState(parsed);
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    try {
      storage.setItem(`${STORAGE_KEY}.bak.v${parsed.schemaVersion ?? 'unknown'}.${Date.now()}`, raw);
      storage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    } catch {
      // Keep using the migrated in-memory copy even if quota or policy blocks a stash.
    }
  }
  return migrated;
}

export function migrateState(parsed) {
  const base = freshState();
  return {
    ...base,
    ...parsed,
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    cardProfiles: Array.isArray(parsed.cardProfiles) ? parsed.cardProfiles : [],
    benefits: Array.isArray(parsed.benefits) ? parsed.benefits : [],
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    recurring: Array.isArray(parsed.recurring) ? parsed.recurring : [],
    holdings: Array.isArray(parsed.holdings) ? parsed.holdings : [],
    funds: Array.isArray(parsed.funds) ? parsed.funds : [],
    liabilities: Array.isArray(parsed.liabilities) ? parsed.liabilities : [],
    renewalsTracker: Array.isArray(parsed.renewalsTracker) ? parsed.renewalsTracker : [],
    investmentHistory: Array.isArray(parsed.investmentHistory) ? parsed.investmentHistory : [],
    investmentSeries: Array.isArray(parsed.investmentSeries) ? parsed.investmentSeries : [],
    investmentMeta: parsed.investmentMeta && typeof parsed.investmentMeta === 'object' ? parsed.investmentMeta : {},
    imports: Array.isArray(parsed.imports) ? parsed.imports : [],
    importMappings: parsed.importMappings && typeof parsed.importMappings === 'object' ? parsed.importMappings : {},
    importRevision: Math.max(0, Number(parsed.importRevision) || 0),
    sync: { ...base.sync, ...(parsed.sync || {}) },
    settings: { ...base.settings, ...(parsed.settings || {}) },
    schemaVersion: SCHEMA_VERSION,
  };
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }));
}

export function backupState(state, storage = localStorage, label = 'manual') {
  const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 30) || 'manual';
  storage.setItem(`${STORAGE_KEY}.bak.${safeLabel}.${Date.now()}`, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION }));
}

export function clearState(storage = localStorage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === STORAGE_KEY || key?.startsWith(`${STORAGE_KEY}.bak.`) || key?.startsWith(`${STORAGE_KEY}.corrupt.`)) keys.push(key);
  }
  keys.forEach(key => storage.removeItem(key));
}

export function downloadJson(filename, value) {
  downloadBlob(filename, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
}

export function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  downloadBlob(filename, new Blob([text], { type }));
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
