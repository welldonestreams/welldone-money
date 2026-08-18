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
  await Promise.all(names.map(async (n) => {
    try {
      const r = await fetch(`/api/finance/${n}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      out[n] = r.ok ? await r.json() : null;
    } catch {
      out[n] = null;
    }
  }));
  const accountNames = [...new Set(listOf(out.accounts, 'accounts').map(account => String(account.account || '')).filter(Boolean))];
  const transactionPages = await Promise.all((accountNames.length ? accountNames : ['']).map(async account => {
    try {
      const query = account ? `?limit=1000&account=${encodeURIComponent(account)}` : '?limit=1000';
      const response = await fetch(`/api/finance/transactions${query}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      return response.ok ? listOf(await response.json(), 'transactions') : [];
    } catch { return []; }
  }));
  out.transactions = { transactions: transactionPages.flat() };
  return out;
}

export async function loadCardProfiles() {
  try {
    const response = await fetch('/api/card-profiles', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

export async function loadImportData() {
  try {
    const response = await fetch('/api/imports', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : { revision: 0, mappings: {}, accounts: [], batches: [], transactions: [] };
  } catch {
    return { revision: 0, mappings: {}, accounts: [], batches: [], transactions: [] };
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
    return response.ok ? await response.json() : { investments: {}, incomeRules: [] };
  } catch {
    return { investments: {}, incomeRules: [] };
  }
}

export async function loadRenewals() {
  try {
    const response = await fetch('/api/renewals', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : [];
  } catch { return []; }
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
  const accounts = listOf(d.accounts, "accounts").map((a) => ({
    id: stableAccountId(a),
    name: a.account || "Account",
    institution: institutionLabel(a.institution),
    kind: kindOf(a.type, a.subtype),
    currentBalance: a.balance ?? 0,
    availableBalance: a.available_balance ?? null,
    creditLimit: a.credit_limit ?? null,
    last4: a.last4 || "",
    balanceAsOf: a.last_updated || todayIso(),
  }));

  // map account names -> ids so transactions/holdings/liabilities can link
  const byName = new Map();
  accounts.forEach((a) => { if (a.name) byName.set(a.name, a.id); });
  const acctId = (name) => (name && byName.get(name)) || "";

  const transactions = listOf(d.transactions, "transactions").map((t, i) => {
    const transaction = {
      id: `bridge-tx-${i}`,
      accountId: acctId(t.account),
      accountName: t.account || "",
      accountKind: accounts.find(account => account.id === acctId(t.account))?.kind || '',
      accountInstitution: accounts.find(account => account.id === acctId(t.account))?.institution || '',
      date: t.date || "",
      payee: payeeLabel(t),
      rawName: String(t.name || ''),
      category: categoryLabel(t.pfc_primary || (Array.isArray(t.category) && t.category[0]) || "Other"),
      // Plaid reports spending as positive; the dashboard ledger uses negative.
      amount: -(typeof t.amount === "number" ? t.amount : Number(t.amount) || 0),
      pending: !!t.pending,
      pfc_primary: String(t.pfc_primary || ''),
    };
    return { ...transaction, ...transactionFlags(transaction) };
  });

  const recurring = listOf(d.recurring, "recurring").map((r, i) => ({
    id: `bridge-rec-${i}`,
    accountId: acctId(r.account),
    name: r.description || "Recurring",
    category: r.category || "Other",
    cadence: r.frequency || "",
    nextDate: r.next_date || "",
    lastDate: r.last_date || "",
    amount: r.amount ?? 0,
    kind: r.flow === "in" ? "inflow" : "outflow",
  }));

  const holdings = listOf(d.holdings, "holdings").map((h, i) => ({
    id: `bridge-hold-${i}`,
    accountId: acctId(h.account),
    accountName: h.account || "",
    ticker: h.ticker || "",
    name: h.name || (h.quantity != null && h.price ? `${h.quantity} sh @ ${h.price}` : h.ticker || "Holding"),
    quantity: h.quantity ?? 0,
    price: h.price ?? 0,
    value: h.value ?? 0,
    costBasis: h.cost_basis ?? null,
    isCash: !!h.is_cash,
    asOf: h.as_of || todayIso(),
  }));

  const liabilities = listOf(d.liabilities, "liabilities").map((l, i) => ({
    id: `bridge-liab-${i}`,
    accountId: acctId(l.account),
    name: l.account || "Debt",
    kind: l.type === "loan" ? "loan" : "credit",
    balance: l.balance ?? 0,
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
  const sync = {
    status: lastSync ? "healthy" : "error",
    lastSuccessfulSync: lastSync,
    dataAsOf: s.data_as_of || null,
    coverageStart: s.coverage_start || null,
    coverageEnd: s.coverage_end || null,
    accountsIncluded: s.accounts_included ?? null,
    accountsWithErrors: s.accounts_with_errors ?? null,
    netWorth: s.linked_net_worth ?? null,
    itemsTracked: Number(d.status?.items_tracked) || 0,
    accountsConnected: Number(d.status?.accounts_connected) || accounts.length,
  };

  return { accounts, transactions, recurring, holdings, liabilities, sync };
}
