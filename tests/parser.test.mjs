import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dedupeTransactions, parseCsv, parseOfx, suffixMatches, toActualCsv } from '../src/parser.js';

test('parses OFX transactions and preserves FITID', () => {
  const result = parseOfx(`<OFX><SIGNONMSGSRSV1><SONRS><FI><ORG>Demo</FI></SONRS></SIGNONMSGSRSV1><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>1234<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260728120000<TRNAMT>-12.34<FITID>abc-1<NAME>Coffee shop<MEMO>Breakfast</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`, { accountId: 'a1' });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].date, '2026-07-28');
  assert.equal(result.transactions[0].amount, -12.34);
  assert.equal(result.transactions[0].id, 'fitid:abc-1');
  assert.equal(result.last4, '1234');
  assert.equal(result.accountKind, 'checking');
});

test('recognizes credit-card OFX account type without relying on transactions', () => {
  const result = parseOfx('<OFX><CCSTMTRS><CCACCTFROM><ACCTID>00007788</ACCTID></CCACCTFROM><BANKTRANLIST></BANKTRANLIST></CCSTMTRS></OFX>');
  assert.equal(result.accountKind, 'credit');
});

test('inverts Amex CSV purchase signs for Actual', () => {
  const result = parseCsv("Date,Description,Card Member,Account #,Amount,Extended Details,Reference,Category\n07/28/2026,Restaurant,User,-59876,42.50,Dinner,'ref-1',Restaurant\n", { accountId: 'gold' });
  assert.equal(result.format, 'AMEX_CSV');
  assert.equal(result.transactions[0].amount, -42.5);
  assert.equal(result.transactions[0].date, '2026-07-28');
  assert.equal(result.last4, '59876');
  assert.equal(result.transactions[0].fitid, 'ref-1');
});

test('detects Bilt CSV and converts purchases and payments to Actual signs', async () => {
  const csv = await readFile(new URL('./fixtures/bilt.csv', import.meta.url), 'utf8');
  const result = parseCsv(csv, { accountId: 'bilt' });
  assert.equal(result.format, 'BILT_CSV');
  assert.equal(result.institution, 'Bilt');
  assert.equal(result.last4, '1234');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].date, '2026-07-27');
  assert.equal(result.transactions[0].amount, -18.94);
  assert.equal(result.transactions[0].notes, 'BOOK STORE 123');
  assert.equal(result.transactions[1].amount, 100);
});

test('keeps a debit and offsetting credit when an issuer reuses a FITID', () => {
  const result = parseOfx('<OFX><CCSTMTRS><CCACCTFROM><ACCTID>00001234</CCACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260728120000<TRNAMT>150.00<FITID>same-id<NAME>Travel credit</STMTTRN><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260728120000<TRNAMT>-156.61<FITID>same-id<NAME>Ticket purchase</STMTTRN></BANKTRANLIST></CCSTMTRS></OFX>', { accountId: 'card' });
  assert.deepEqual(result.transactions.map(item => item.id), ['fitid:same-id', 'fitid:same-id#1']);
  assert.equal(Math.round(result.transactions.reduce((sum, item) => sum + item.amount, 0) * 100), -661);
});

test('keeps genuine identical CSV purchases and remains idempotent on re-import', async () => {
  const csv = await readFile(new URL('./fixtures/demo.csv', import.meta.url), 'utf8');
  const first = parseCsv(csv, { accountId: 'checking' });
  const second = parseCsv(csv, { accountId: 'checking' });
  assert.equal(first.transactions.length, 3);
  assert.notEqual(first.transactions[1].id, first.transactions[2].id);
  assert.equal(dedupeTransactions(first.transactions, second.transactions).duplicates.length, 3);
});

test('normalizes OFX check digits and matches 4- or 5-digit suffixes', () => {
  const result = parseOfx('<OFX><BANKMSGSRSV1><STMTRS><BANKACCTFROM><ACCTID>99887654~2</BANKACCTFROM><BANKTRANLIST></BANKTRANLIST></STMTRS></BANKMSGSRSV1></OFX>');
  assert.equal(result.last4, '7654');
  assert.equal(suffixMatches('59876', '9876'), true);
  assert.equal(suffixMatches('1234', '9876'), false);
});

test('deduplicates within an account but not across accounts', () => {
  const transaction = { id: 'fitid:one', accountId: 'a1' };
  assert.equal(dedupeTransactions([transaction], [{ ...transaction }]).duplicates.length, 1);
  assert.equal(dedupeTransactions([transaction], [{ ...transaction, accountId: 'a2' }]).accepted.length, 1);
});

test('exports Actual-compatible CSV escaping commas and quotes', () => {
  const csv = toActualCsv([{ date: '2026-07-28', payee: 'Shop, Inc.', notes: 'Said "hi"', category: 'Food', amount: -10, cleared: true }]);
  assert.match(csv, /"Shop, Inc\."/);
  assert.match(csv, /"Said ""hi"""/);
  assert.match(csv, /-10\.00,true/);
});
