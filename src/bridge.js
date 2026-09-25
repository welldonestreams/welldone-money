// WellDone Money — live bridge client (BRIDGE-CONTRACT.md).
// Fetches the sanitized read-only /api/finance/* endpoints through the
// same-origin adapter and maps them onto the app's local state model.
// Browser JavaScript never sees a Plaid or bridge token — the adapter adds it.

import { stableAccountId } from './import-intelligence.js';
import { transactionFlags } from './transaction-kind.js';

function kindOf(type, subtype) {
  if (type === "credit") return "credit";
  if (type === "loan") return "loan";
  if (type === "investment") return "investment";
  return subtype === "savings" ? "savings" : "checking";
}

function institutionLabel(value) {
  const label = String(value || '').trim();
  return label && label.toLowerCase() !== 'pending' ? label : 'Connected via Plaid';
}

function todayIso() {
  return new Date().toISOString();
}

export async function loadBridgeData() {
  const names = ["summary", "accounts", "recurring", "holdings", "liabilities", "status"];
  const out = {};
  const failures = [];
  await Promise.all(names.map(async (n) => {
    try {
      const r = await fetch(`/api/finance/${n}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) { failures.push(n); out[n] = null; return; }
      out[n] = await r.json();
    } catch {
      failures.push(n);
      out[n] = null;
    }
  }));
  const accountRefs = [...new Map(listOf(out.accounts, 'accounts').map(account => {
    const key = String(account.account_key || '').trim();
    const alias = String(account.account || '').trim();
    return [key || alias, { key, alias }];
  }).filter(([ref]) => ref)).values()];
  const transactionResults = await Promise.all((accountRefs.length ? accountRefs : [{ key: '', alias: '' }]).map(async account => {
    const rows = [];
    const pageSignatures = new Set();
    let offset = 0;
    try {
      while (offset < 100000) {
        const selector = account.key ? `account_key=${encodeURIComponent(account.key)}` : account.alias ? `account=${encodeURIComponent(account.alias)}` : '';
        const query = `?limit=1000&offset=${offset}${selector ? `&${selector}` : ''}`;
        const response = await fetch(`/api/finance/transactions${query}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const page = listOf(await response.json(), 'transactions');
        const signature = page.length === 1000 ? JSON.stringify([page[0], page.at(-1)]) : '';
        if (signature && pageSignatures.has(signature)) throw new Error('transaction endpoint ignored pagination');
        if (signature) pageSignatures.add(signature);
        rows.push(...page);
        if (page.length < 1000) return { account, rows, ok: true };
        offset += page.length;
      }
      throw new Error('transaction pagination safety limit reached');
    } catch { return { account, rows: [], ok: false }; }
  }));
  out.transactions = { transactions: transactionResults.filter(result => result.ok).flatMap(result => result.rows) };
  out._failures = failures;
  out._transactionFailures = transactionResults.filter(result => !result.ok).map(result => result.account.key || result.account.alias);
  out._successfulTransactionAccounts = transactionResults.filter(result => result.ok).map(result => result.account.key || result.account.alias);
  return out;
}

export async function loadCardProfiles() {
  try {
    const response = await fetch('/api/card-profiles', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function loadImportData() {
  try {
    const response = await fetch('/api/imports', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// The bridge wraps each list endpoint in its own key ({"accounts": [...]});
// unwrap either that key or the first array found in the object.
function listOf(value, key) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value[key])) return value[key];
    for (const v of Object.values(value)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

// Normalize raw bank descriptions: prefer the merchant label when present;
// ALL-CAPS statement strings become Title Case instead of shouting.
function payeeLabel(t) {
  const m = String(t.merchant || "").trim();
  if (m) return m;
  const n = String(t.name || "").trim();
  if (!n) return "Unknown";
  if (n === n.toUpperCase() && /[A-Z]{4,}/.test(n)) {
    return n.toLowerCase().replace(/(^|\s)([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }
  return n;
}

export async function loadPrivateFinanceData() {
  try {
    const response = await fetch('/api/private-finance', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function loadRenewals() {
  try {
    const response = await fetch('/api/renewals', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

export function applyPrivateIncomeRules(transactions, rules) {
  const cleanRules = (Array.isArray(rules) ? rules : []).map(rule => String(rule?.contains || '').trim().toLowerCase()).filter(Boolean);
  return (transactions || []).map(transaction => {
    const haystack = [transaction.rawName, transaction.payee, transaction.accountName, transaction.accountInstitution].join(' ').toLowerCase();
    const isIncome = Number(transaction.amount) > 0 && cleanRules.some(pattern => haystack.includes(pattern));
    return isIncome ? { ...transaction, isIncome: true, category: 'Income' } : transaction;
  });
}

function categoryLabel(value) {
  const labels = {
    INCOME: 'Income', TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer', LOAN_PAYMENTS: 'Loan payments',
    BANK_FEES: 'Bank fees', ENTERTAINMENT: 'Entertainment', FOOD_AND_DRINK: 'Food & drink',
    GENERAL_MERCHANDISE: 'Shopping', GENERAL_SERVICES: 'Services', GOVERNMENT_AND_NON_PROFIT: 'Government & nonprofit',
    HOME_IMPROVEMENT: 'Home improvement', MEDICAL: 'Medical', PERSONAL_CARE: 'Personal care',
    RENT_AND_UTILITIES: 'Rent & utilities', TRANSPORTATION: 'Transportation', TRAVEL: 'Travel',
  };
  const raw = String(value || '').trim();
  return labels[raw] || (raw ? raw.toLowerCase().replace(/_/g, ' ').replace(/(^|\s)\S/g, c => c.toUpperCase()) : 'Other');
}

export function mapBridgeData(d) {
  const rawAccounts = listOf(d.accounts, "accounts");
  const accounts = rawAccounts.map((a) => ({
    id: stableAccountId(a),
    bridgeKey: String(a.account_key || ''),
    name: a.account || "Account",
    institution: institutionLabel(a.institution),
    kind: kindOf(a.type, a.subtype),
    currentBalance: a.balance ?? null,
    availableBalance: a.available_balance ?? null,
    creditLimit: a.credit_limit ?? null,
    last4: a.last4 || "",
    balanceAsOf: a.last_updated || todayIso(),
  }));

  // Prefer the backend's opaque stable key. Legacy aliases are usable only
  // when unique; duplicate display names must never silently route money to
  // whichever account happened to be last in the response.
  const byKey = new Map(accounts.filter(a => a.bridgeKey).map(a => [a.bridgeKey, a.id]));
  const aliasGroups = new Map();
  accounts.forEach((a) => { if (a.name) aliasGroups.set(a.name, [...(aliasGroups.get(a.name) || []), a.id]); });
  const acctId = (item) => {
    const key = String(item?.account_key || '');
    if (key && byKey.has(key)) return byKey.get(key);
    const ids = aliasGroups.get(String(item?.account || '')) || [];
    return ids.length === 1 ? ids[0] : '';
  };

  const transactionKeyCounts = new Map();
  const transactions = listOf(d.transactions, "transactions").map((t) => {
    const accountId = acctId(t);
    const plaidAmount = t.amount == null || t.amount === '' ? NaN : (typeof t.amount === 'number' ? t.amount : Number(t.amount));
    const baseKey = String(t.transaction_key || stableRowKey(t));
    const occurrence = transactionKeyCounts.get(baseKey) || 0;
    transactionKeyCounts.set(baseKey, occurrence + 1);
    const transaction = {
      id: `bridge-tx-${baseKey}${occurrence ? `#${occurrence}` : ''}`,
      accountId,
      accountName: t.account || "",
      accountKind: accounts.find(account => account.id === accountId)?.kind || '',
      accountInstitution: accounts.find(account => account.id === accountId)?.institution || '',
      date: t.date || "",
      payee: payeeLabel(t),
      rawName: String(t.name || ''),
      category: categoryLabel(t.pfc_primary || (Array.isArray(t.category) && t.category[0]) || "Other"),
      // Plaid reports spending as positive; the dashboard ledger uses negative.
      amount: Number.isFinite(plaidAmount) ? -plaidAmount : null,
      pending: !!t.pending,
      pfc_primary: String(t.pfc_primary || ''),
    };
    return { ...transaction, ...transactionFlags(transaction) };
  });

  const recurring = listOf(d.recurring, "recurring").map((r, i) => ({
    id: `bridge-rec-${i}`,
    accountId: acctId(r),
    name: r.description || "Recurring",
    category: r.category || "Other",
    cadence: r.frequency || "",
    nextDate: r.next_date || "",
    lastDate: r.last_date || "",
    amount: r.amount ?? null,
    kind: r.flow === "in" ? "inflow" : "outflow",
  }));

  const holdings = listOf(d.holdings, "holdings").map((h, i) => ({
    id: `bridge-hold-${i}`,
    accountId: acctId(h),
    accountName: h.account || "",
    ticker: h.ticker || "",
    name: h.name || (h.quantity != null && h.price ? `${h.quantity} sh @ ${h.price}` : h.ticker || "Holding"),
    quantity: h.quantity ?? null,
    price: h.price ?? null,
    value: h.value ?? null,
    costBasis: h.cost_basis ?? null,
    isCash: !!h.is_cash,
    asOf: h.as_of || todayIso(),
  }));

  const liabilities = listOf(d.liabilities, "liabilities").map((l, i) => ({
    id: `bridge-liab-${i}`,
    accountId: acctId(l),
    name: l.account || "Debt",
    kind: l.type === "loan" ? "loan" : "credit",
    balance: l.balance ?? null,
    creditLimit: l.credit_limit ?? null,
    statementBalance: l.statement_balance ?? null,
    minimumPayment: l.minimum_payment ?? null,
    dueDate: l.payment_due_date || "",
    apr: l.apr ?? (l.interest_rate ?? null),
    aprType: l.apr_type || "",
    overdue: !!l.overdue,
  }));

  const s = d.summary || {};
  const lastSync = s.last_successful_sync || null;
  const accountErrors = Number(s.accounts_with_errors) || 0;
  const partial = accountErrors > 0 || (d._failures || []).length > 0 || (d._transactionFailures || []).length > 0;
  const resolveRef = (ref) => byKey.get(ref) || ((aliasGroups.get(ref) || []).length === 1 ? aliasGroups.get(ref)[0] : '');
  const sync = {
    status: !lastSync ? "error" : partial ? "partial" : "healthy",
    lastSuccessfulSync: lastSync,
    dataAsOf: s.data_as_of || null,
    coverageStart: s.coverage_start || null,
    coverageEnd: s.coverage_end || null,
    accountsIncluded: s.accounts_included ?? null,
    accountsWithErrors: s.accounts_with_errors ?? null,
    netWorth: s.linked_net_worth ?? null,
    itemsTracked: Number(d.status?.items_tracked) || 0,
    accountsConnected: Number(d.status?.accounts_connected) || accounts.length,
    failedEndpoints: [...(d._failures || [])],
    failedTransactionAccounts: [...(d._transactionFailures || [])],
    successfulTransactionAccounts: [...(d._successfulTransactionAccounts || [])],
    failedTransactionAccountIds: (d._transactionFailures || []).map(resolveRef).filter(Boolean),
    successfulTransactionAccountIds: (d._successfulTransactionAccounts || []).map(resolveRef).filter(Boolean),
  };

  return { accounts, transactions, recurring, holdings, liabilities, sync };
}

function stableRowKey(row) {
  const raw = [row.account_key, row.account, row.date, row.amount, row.name, row.merchant, row.pending].join('|');
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) { hash ^= raw.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
