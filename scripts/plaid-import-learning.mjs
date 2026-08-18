import { transactionFlags } from '../src/transaction-kind.js';

const PFC_LABELS = {
  INCOME: "Income",
  TRANSFER_IN: "Transfer",
  TRANSFER_OUT: "Transfer",
  LOAN_PAYMENTS: "Loan payments",
  BANK_FEES: "Bank fees",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Food & drink",
  GENERAL_MERCHANDISE: "Shopping",
  GENERAL_SERVICES: "Services",
  GOVERNMENT_AND_NON_PROFIT: "Government & nonprofit",
  HOME_IMPROVEMENT: "Home improvement",
  MEDICAL: "Medical",
  PERSONAL_CARE: "Personal care",
  RENT_AND_UTILITIES: "Rent & utilities",
  TRANSPORTATION: "Transportation",
  TRAVEL: "Travel",
};

export function friendlyPlaidCategory(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (PFC_LABELS[raw]) return PFC_LABELS[raw];
  return raw.toLowerCase().replace(/_/g, " ").replace(/(^|\s)\S/g, char => char.toUpperCase());
}

export function normalizeMerchant(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(purchase|debit|credit|payment|online|recurring|card|pos)\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function affinity(left, right) {
  const a = new Set(normalizeMerchant(left).split(" ").filter(token => token.length > 1));
  const b = new Set(normalizeMerchant(right).split(" ").filter(token => token.length > 1));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function mode(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || ["", 0];
}

export function normalizePlaidTransactions(rawTransactions, accountByName) {
  return (rawTransactions || []).map(item => ({
    accountId: accountByName.get(String(item.account || "")) || "",
    date: String(item.date || "").slice(0, 10),
    // Plaid: positive means money out. WellDone Money: negative means money out.
    amount: -Math.round((Number(item.amount) || 0) * 100) / 100,
    payee: String(item.merchant || item.name || "").trim(),
    merchantKey: normalizeMerchant(item.merchant || item.name),
    category: friendlyPlaidCategory(item.pfc_primary || (Array.isArray(item.category) ? item.category[0] : "")),
    categoryDetail: friendlyPlaidCategory(item.pfc_detailed || ""),
  })).filter(item => item.date && item.payee);
}

export function plaidCoverageByAccount(plaidTransactions) {
  const coverage = new Map();
  for (const item of plaidTransactions || []) {
    if (!item.accountId || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) continue;
    const current = coverage.get(item.accountId);
    if (!current) coverage.set(item.accountId, { start: item.date, end: item.date, count: 1 });
    else {
      current.start = item.date < current.start ? item.date : current.start;
      current.end = item.date > current.end ? item.date : current.end;
      current.count += 1;
    }
  }
  return coverage;
}

export function buildPlaidMerchantModel(plaidTransactions) {
  const groups = new Map();
  for (const item of plaidTransactions || []) {
    if (!item.merchantKey) continue;
    for (const key of [`account:${item.accountId}:${item.merchantKey}`, `global:${item.merchantKey}`]) {
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
  }
  const model = new Map();
  for (const [key, rows] of groups) {
    const [payee, payeeCount] = mode(rows.map(row => row.payee));
    const [category, categoryCount] = mode(rows.map(row => row.category));
    const [categoryDetail] = mode(rows.filter(row => row.category === category).map(row => row.categoryDetail));
    model.set(key, { merchantKey: rows[0].merchantKey, payee, category, categoryDetail, references: rows.length, categoryReferences: categoryCount, payeeReferences: payeeCount });
  }
  return model;
}

function modelMatch(transaction, accountId, model) {
  const key = normalizeMerchant(transaction.payee);
  if (!key) return null;
  const accountKey = `account:${accountId}:${key}`;
  const direct = model.get(accountKey) || model.get(`global:${key}`);
  if (direct) return { ...direct, confidence: 100, scope: model.has(accountKey) ? "account" : "global" };
  let best = null;
  for (const [modelKey, candidate] of model) {
    const accountScoped = modelKey.startsWith(`account:${accountId}:`);
    if (modelKey.startsWith("account:") && !accountScoped) continue;
    const score = affinity(key, candidate.merchantKey);
    const threshold = accountScoped ? 0.8 : 0.9;
    if (score >= threshold && (!best || score * 100 > best.confidence)) best = { ...candidate, confidence: Math.round(score * 100), scope: accountScoped ? "account" : "global" };
  }
  return best;
}

export function enrichStatementTransaction(transaction, accountId, model) {
  const statementPayee = String(transaction.statementPayee || transaction.payee || "Unknown").trim();
  const statementCategory = String(transaction.statementCategory ?? transaction.category ?? "").trim();
  const learned = modelMatch({ ...transaction, payee: statementPayee }, accountId, model);
  if (!learned) {
    const enriched = { ...transaction, statementPayee, statementCategory, category: statementCategory || "Uncategorized", categorySource: statementCategory ? "statement" : "uncategorized" };
    return { ...enriched, ...transactionFlags(enriched) };
  }
  const enriched = {
    ...transaction,
    statementPayee,
    statementCategory,
    payee: learned.payee || transaction.payee,
    category: learned.category || statementCategory || "Uncategorized",
    categoryDetail: learned.categoryDetail || "",
    categorySource: learned.category ? "plaid_merchant" : (statementCategory ? "statement" : "uncategorized"),
    categoryConfidence: learned.confidence,
    plaidReferenceCount: learned.references,
  };
  return { ...enriched, ...transactionFlags(enriched) };
}

export function reconcileImportedTransactions(transactions, plaidTransactions) {
  const coverage = plaidCoverageByAccount(plaidTransactions);
  const model = buildPlaidMerchantModel(plaidTransactions);
  const kept = [];
  const superseded = [];
  for (const item of transactions || []) {
    const accountCoverage = coverage.get(item.accountId);
    if (accountCoverage && item.date >= accountCoverage.start) superseded.push(item);
    else kept.push(enrichStatementTransaction(item, item.accountId, model));
  }
  return { transactions: kept, superseded, coverage, model };
}
