function textOf(transaction) {
  return [
    transaction?.rawName,
    transaction?.statementPayee,
    transaction?.payee,
    transaction?.originalName,
    transaction?.name,
    transaction?.description,
  ].map(value => String(value || '').trim()).filter(Boolean).join(' | ');
}

export function isCardPayment(transaction) {
  if (transaction?.isPayment === true) return true;
  const category = String(transaction?.category || transaction?.pfc_primary || '').toLowerCase().replace(/_/g, ' ');
  if (category === 'loan payments') return true;
  const text = textOf(transaction);
  return /\b(?:mobile|online|automatic|autopay)?\s*payment(?:\s+received)?\s*(?:-|–)?\s*(?:thank\s+you)?\b/i.test(text)
    || /\bpayment\s+thank\s+you\b/i.test(text);
}

export function isStatementCredit(transaction) {
  if (transaction?.isStatementCredit === true) return true;
  const text = textOf(transaction);
  return /\bplatinum\s+.+?\s+credit\b/i.test(text)
    || /\bstatement\s+credit\b/i.test(text)
    || /\brewards?\s+credit\b/i.test(text);
}

// Paycheck: money IN from a payroll-like source. Plaid often tags employer
// direct deposits as TRANSFER_IN, which would otherwise hide the actual
// income. Counts as inflow regardless of the transfer category.
export function isPaycheck(transaction) {
  if (transaction?.isPaycheck === true) return true;
  if ((Number(transaction?.amount) || 0) <= 0) return false;
  const text = textOf(transaction);
  return /\b(?:direct deposit|payroll|paycheck|salary|wages|earnings statement)\b/i.test(text)
    || /^dd\s*[\/\-]/i.test(text);
}

export function statementCreditOffsetCategory(transaction) {
  const text = textOf(transaction);
  if (/\bplatinum\s+resy\s+credit\b/i.test(text)) return 'Food & drink';
  if (/\bplatinum\s+digital\s+entertainment\s+credit\b/i.test(text)) return 'Entertainment';
  if (/\bplatinum\s+(?:lululemon|walmart\+?)\s+credit\b/i.test(text)) return 'Shopping';
  if (/\b(?:amex|platinum)\s+clear(?:\s+plus|\+)?\s+credit\b/i.test(text)) return 'Travel';
  return String(transaction?.category || 'Uncategorized');
}

export function transactionFlags(transaction) {
  return {
    isPayment: isCardPayment(transaction),
    isStatementCredit: isStatementCredit(transaction),
    isPaycheck: isPaycheck(transaction),
  };
}
