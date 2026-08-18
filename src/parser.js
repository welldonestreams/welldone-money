const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function parseStatementFile(file, accountId = '') {
  if (file.size > MAX_FILE_BYTES) throw new Error('File is larger than the 20 MB safety limit.');
  const text = await file.text();
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['qfx', 'ofx', 'qbo'].includes(extension)) return parseOfx(text, { filename: file.name, accountId });
  if (extension === 'csv') return parseCsv(text, { filename: file.name, accountId });
  throw new Error(`Unsupported file type: ${extension || 'unknown'}`);
}

export function parseOfx(text, { filename = 'statement.ofx', accountId = '' } = {}) {
  const normalized = String(text).replace(/\r/g, '');
  const institution = tagValue(normalized, 'ORG');
  const rawAccount = tagValue(normalized, 'ACCTID');
  const last4 = accountSuffix(rawAccount, 4);
  const accountType = tagValue(normalized, 'ACCTTYPE').toLowerCase();
  const accountKind = /<CCACCTFROM\b|<CCSTMTRS\b/i.test(normalized) ? 'credit' : accountType === 'savings' ? 'savings' : accountType === 'checking' ? 'checking' : '';
  const blocks = [...normalized.matchAll(/<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>))/gi)].map(match => match[1]);
  const rejected = [];
  const transactions = [];
  const idCounts = new Map();
  blocks.forEach((block, index) => {
    const date = normalizeOfxDate(tagValue(block, 'DTPOSTED'));
    const amount = parseAmount(tagValue(block, 'TRNAMT'));
    const payee = cleanText(tagValue(block, 'NAME') || tagValue(block, 'MEMO') || tagValue(block, 'TRNTYPE') || 'Unknown');
    const notes = cleanText(tagValue(block, 'MEMO'));
    const fitid = normalizeFitid(tagValue(block, 'FITID'));
    if (!date || !Number.isFinite(amount)) {
      rejected.push({ row: index + 1, reason: 'Missing date or amount' });
      return;
    }
    const transaction = { accountId, date, payee, notes, category: '', amount, cleared: true, fitid, sourceType: 'OFX', sourceFile: filename };
    transaction.id = uniqueOccurrenceId(fitid ? `fitid:${fitid}` : fingerprint(transaction), idCounts);
    transactions.push(transaction);
  });
  return { filename, format: 'OFX', institution, last4, accountKind, transactions, rejected };
}

export function parseCsv(text, { filename = 'statement.csv', accountId = '' } = {}) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return { filename, format: 'CSV', institution: '', last4: '', transactions: [], rejected: [{ row: 1, reason: 'No transaction rows' }] };
  const headers = rows[0].map(value => value.trim());
  const lower = headers.map(value => value.toLowerCase());
  const isAmex = lower.includes('card member') && lower.includes('amount') && lower.includes('description');
  const isBilt = ['transaction date', 'posted date', 'card last 4', 'raw merchant name'].every(header => lower.includes(header));
  const dateIndex = isBilt ? lower.indexOf('posted date') : findHeader(lower, ['date', 'transaction date', 'posted date']);
  const payeeIndex = findHeader(lower, ['payee', 'description', 'appears on your statement as', 'name']);
  const amountIndex = findHeader(lower, ['amount']);
  const debitIndex = findHeader(lower, ['debit', 'payment']);
  const creditIndex = findHeader(lower, ['credit', 'deposit']);
  const notesIndex = findHeader(lower, ['notes', 'extended details', 'memo', 'raw merchant name']);
  const categoryIndex = findHeader(lower, ['category']);
  const referenceIndex = findHeader(lower, ['reference', 'fitid', 'id']);
  const accountIndex = findHeader(lower, ['account #', 'account', 'card last 4']);
  const rejected = [];
  const transactions = [];
  const idCounts = new Map();
  let detectedLast4 = '';
  rows.slice(1).forEach((row, index) => {
    if (row.every(value => !String(value).trim())) return;
    const date = normalizeDate(row[dateIndex]);
    let amount = amountIndex >= 0 ? parseAmount(row[amountIndex]) : NaN;
    if (amountIndex < 0 && (debitIndex >= 0 || creditIndex >= 0)) amount = (parseAmount(row[creditIndex]) || 0) - (parseAmount(row[debitIndex]) || 0);
    if ((isAmex || isBilt) && Number.isFinite(amount)) amount *= -1;
    const payee = cleanText(row[payeeIndex] || 'Unknown');
    const notes = cleanText(row[notesIndex] || '');
    const fitid = normalizeFitid(row[referenceIndex] || '');
    const accountRaw = cleanText(row[accountIndex] || '');
    if (!detectedLast4 && accountRaw) detectedLast4 = accountSuffix(accountRaw, isAmex ? 5 : 4);
    if (!date || !Number.isFinite(amount)) {
      rejected.push({ row: index + 2, reason: 'Missing date or amount' });
      return;
    }
    const sourceType = isAmex ? 'AMEX_CSV' : isBilt ? 'BILT_CSV' : 'CSV';
    const transaction = { accountId, date, payee, notes, category: cleanText(row[categoryIndex] || ''), amount, cleared: true, fitid, sourceType, sourceFile: filename };
    transaction.id = uniqueOccurrenceId(fitid ? `fitid:${fitid}` : fingerprint(transaction), idCounts);
    transactions.push(transaction);
  });
  const format = isAmex ? 'AMEX_CSV' : isBilt ? 'BILT_CSV' : 'CSV';
  const institution = isAmex ? 'American Express' : isBilt ? 'Bilt' : '';
  return { filename, format, institution, last4: detectedLast4, accountKind: isAmex || isBilt ? 'credit' : '', transactions, rejected };
}

export function dedupeTransactions(existing, incoming) {
  const ids = new Set(existing.map(item => `${item.accountId}:${item.id}`));
  const accepted = [];
  const duplicates = [];
  for (const item of incoming) {
    const key = `${item.accountId}:${item.id}`;
    if (ids.has(key)) duplicates.push(item);
    else { ids.add(key); accepted.push(item); }
  }
  return { accepted, duplicates };
}

export function toActualCsv(transactions) {
  const header = ['Date', 'Payee', 'Notes', 'Category', 'Amount', 'Cleared'];
  const rows = transactions.slice().sort((a, b) => a.date.localeCompare(b.date)).map(item => [item.date, item.payee, item.notes, item.category, item.amount.toFixed(2), item.cleared ? 'true' : 'false']);
  return [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
}

export function fingerprint(transaction) {
  const raw = [transaction.date, Number(transaction.amount).toFixed(2), normalizeKey(transaction.payee), normalizeKey(transaction.notes)].join('|');
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) { hash ^= raw.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `fp:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function suffixMatches(left, right) {
  const a = String(left || '').replace(/\D/g, '');
  const b = String(right || '').replace(/\D/g, '');
  return Boolean(a && b && (a.endsWith(b) || b.endsWith(a)));
}

function uniqueOccurrenceId(base, counts) {
  const seen = counts.get(base) || 0;
  counts.set(base, seen + 1);
  return seen ? `${base}#${seen}` : base;
}

function accountSuffix(value, length) {
  const accountPart = String(value || '').split('~', 1)[0];
  return accountPart.replace(/\D/g, '').slice(-length);
}

function normalizeFitid(value) {
  return cleanText(value).replace(/^'+|'+$/g, '');
}

function tagValue(text, tag) {
  const match = String(text).match(new RegExp(`<${tag}>([^<\\n]+)`, 'i'));
  return match ? match[1].trim() : '';
}

function normalizeOfxDate(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (us) { const year = us[3].length === 2 ? `20${us[3]}` : us[3]; return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`; }
  const date = new Date(raw);
  return Number.isNaN(date.valueOf()) ? '' : date.toISOString().slice(0, 10);
}

function parseAmount(value) {
  const normalized = String(value ?? '').trim().replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

function cleanText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function normalizeKey(value) { return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function findHeader(headers, candidates) { return headers.findIndex(header => candidates.includes(header)); }
function csvEscape(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }

function parseCsvRows(text) {
  const rows = []; let row = []; let value = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (value.length || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
