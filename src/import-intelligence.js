export function stableAccountId(account) {
  const key = [account.institution, account.account || account.name, account.last4, account.type || account.kind, account.subtype]
    .map(normalizeText).join('|');
  return `bridge-acct-${fnv1a(key)}`;
}

export function statementSignature(statement) {
  const institution = normalizeText(statement.institution);
  const source = institution || normalizeText(statement.filename)
    .replace(/\b(activity|statement|download|transaction|transactions|export|csv|qfx|ofx|qbo)\b/g, ' ')
    .replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  return [normalizeText(statement.format), normalizeDigits(statement.last4), source].join('|');
}

export function matchStatement(statement, accounts, plaidTransactions, mappings = {}) {
  const signature = statementSignature(statement);
  const remembered = mappings?.[signature]?.accountId || mappings?.[signature] || '';
  const suffixMatches = (accounts || []).filter(account => suffixEqual(account.last4, statement.last4));
  const source = sourceIdentity(statement);
  const scored = (accounts || []).map(account => {
    let score = 0;
    const reasons = [];
    let suffixMatched = false;
    if (account.id === remembered) { score += 140; reasons.push('Previously confirmed for this statement source'); }
    if (suffixEqual(account.last4, statement.last4)) {
      suffixMatched = true;
      score += 70;
      reasons.push(`Account suffix matches ••••${normalizeDigits(statement.last4).slice(-4)}`);
      if (suffixMatches.length === 1) score += 20;
    }
    const accountText = normalizeText(`${account.institution || ''} ${account.name || ''}`);
    const sourceAffinity = textAffinity(source, accountText);
    if (sourceAffinity >= 0.5) { score += 18; reasons.push('Institution or filename matches'); }
    else if (sourceAffinity > 0) score += 8;
    if (statement.accountKind && account.kind === statement.accountKind) {
      score += 22;
      reasons.push(`Statement type matches ${statement.accountKind}`);
    } else if (statement.accountKind && account.kind && account.kind !== statement.accountKind) {
      score -= 24;
    }
    const overlaps = overlapCount(statement.transactions, plaidTransactions, account.id);
    if (overlaps >= 3) { score += 65; reasons.push(`${overlaps} transactions overlap Plaid history`); }
    else if (overlaps === 2) { score += 48; reasons.push('2 transactions overlap Plaid history'); }
    else if (overlaps === 1) { score += 28; reasons.push('1 transaction overlaps Plaid history'); }
    return { accountId: account.id, score, overlaps, sourceAffinity, suffixMatched, reasons };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < 20) return { status: 'manual', accountId: '', suggestedAccountId: '', confidence: 0, reasons: ['No reliable Plaid match found'], candidates: scored.slice(0, 3), signature };
  const runnerUp = scored[1]?.score || 0;
  const uniqueLead = top.score - runnerUp >= 20;
  const rememberedMatch = top.accountId === remembered;
  const directEvidence = rememberedMatch || top.suffixMatched || top.overlaps > 0 || top.sourceAffinity >= 0.5;
  if (!directEvidence) return { status: 'manual', accountId: '', suggestedAccountId: '', confidence: 0, reasons: ['No reliable account-specific evidence found'], candidates: scored.slice(0, 3), signature };
  const highEvidence = rememberedMatch || (uniqueLead && (top.score >= 90 || top.overlaps >= 3));
  if (highEvidence) return { status: 'auto', accountId: top.accountId, suggestedAccountId: top.accountId, confidence: Math.min(99, top.score), reasons: top.reasons, candidates: scored.slice(0, 3), signature, confirmed: true };
  return { status: 'confirm', accountId: '', suggestedAccountId: top.accountId, confidence: Math.min(95, top.score), reasons: uniqueLead ? top.reasons : ['More than one account has similar evidence', ...top.reasons], candidates: scored.slice(0, 3), signature, confirmed: false };
}

export function semanticTransactionMatch(left, right) {
  if (!left || !right || left.date !== right.date) return false;
  if (Math.round(Number(left.amount) * 100) !== Math.round(Number(right.amount) * 100)) return false;
  const a = normalizeText(left.payee || left.name || left.merchant);
  const b = normalizeText(right.payee || right.name || right.merchant);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a) || textAffinity(a, b) >= 0.6;
}

function overlapCount(incoming, plaid, accountId) {
  const candidates = (plaid || []).filter(item => item.accountId === accountId);
  let count = 0;
  const used = new Set();
  for (const transaction of (incoming || []).slice(-400)) {
    const index = candidates.findIndex((candidate, i) => !used.has(i) && semanticTransactionMatch(transaction, candidate));
    if (index >= 0) { used.add(index); count += 1; }
    if (count >= 8) break;
  }
  return count;
}

function sourceIdentity(statement) {
  let value = normalizeText(`${statement.institution || ''} ${statement.filename || ''}`);
  value = value.replace(/\bc1\b/g, 'capital one').replace(/\bafcu\b/g, 'america first credit union');
  if (/\bchase\b/.test(value)) value += ' chase';
  if (/\bamex\b|american express/.test(value)) value += ' american express';
  return value;
}

function textAffinity(left, right) {
  const stop = new Set(['activity', 'statement', 'download', 'transaction', 'transactions', 'card', 'account', 'export', 'csv', 'qfx', 'ofx', 'qbo', 'the']);
  const a = new Set(normalizeText(left).split(' ').filter(token => token.length > 1 && !stop.has(token) && !/^\d+$/.test(token)));
  const b = new Set(normalizeText(right).split(' ').filter(token => token.length > 1 && !stop.has(token) && !/^\d+$/.test(token)));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function suffixEqual(left, right) {
  const a = normalizeDigits(left).replace(/^0+/, '');
  const b = normalizeDigits(right).replace(/^0+/, '');
  return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
}

function normalizeDigits(value) { return String(value || '').replace(/\D/g, ''); }
function normalizeText(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function fnv1a(value) { let hash = 2166136261; for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, '0'); }
