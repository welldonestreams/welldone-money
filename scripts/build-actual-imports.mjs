import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseCsv, parseOfx, toActualCsv } from '../src/parser.js';

const [profilePath, mappingPath, outputDir] = process.argv.slice(2);
if (!profilePath || !mappingPath || !outputDir) {
  console.error('Usage: node scripts/build-actual-imports.mjs <profile.json> <mapping.json> <output-directory>');
  process.exit(2);
}

const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
const grouped = new Map(profile.accounts.map(account => [account.id, []]));
const audit = [];

for (const [filePath, accountId] of Object.entries(mapping.files || {})) {
  const text = await readFile(filePath, 'utf8');
  const filename = basename(filePath);
  const extension = filename.split('.').pop().toLowerCase();
  const parsed = extension === 'csv' ? parseCsv(text, { filename, accountId }) : parseOfx(text, { filename, accountId });
  grouped.get(accountId)?.push(...parsed.transactions);
  audit.push({ filename, accountId, parsed: parsed.transactions.length, rejected: parsed.rejected.length });
}

await mkdir(outputDir, { recursive: true });
for (const account of profile.accounts) {
  if (account.excludeFromActual) continue;
  const transactions = grouped.get(account.id) || [];
  const target = account.kind === 'credit' ? -Number(account.currentBalance || 0) : Number(account.currentBalance || 0);
  const ledger = transactions.reduce((sum, item) => sum + Number(item.amount), 0);
  const adjustment = Number((target - ledger).toFixed(2));
  if (Math.abs(adjustment) >= 0.005) {
    const earliest = transactions.map(item => item.date).sort()[0];
    const date = earliest ? dayBefore(earliest) : (account.balanceAsOf || new Date().toISOString().slice(0, 10));
    transactions.push({ date, payee: 'Opening balance adjustment', notes: `Reconciles downloaded history to the ${account.balanceAsOf || 'current'} balance snapshot`, category: 'Starting Balances', amount: adjustment, cleared: true });
  }
  if (!transactions.length && !account.currentBalance) continue;
  const filename = `actual-${slug(account.name)}.csv`;
  await writeFile(join(outputDir, filename), toActualCsv(transactions), 'utf8');
  audit.push({ accountId: account.id, output: filename, rows: transactions.length, targetBalance: target, calculatedBalance: Number(transactions.reduce((sum, item) => sum + Number(item.amount), 0).toFixed(2)) });
}

await writeFile(join(outputDir, 'import-audit.json'), JSON.stringify(audit, null, 2), 'utf8');
console.log(`Prepared ${audit.filter(item => item.output).length} Actual import files in ${outputDir}`);

function dayBefore(value) { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

