import { dedupeTransactions, parseStatementFile, toActualCsv } from './parser.js';
import { backupState, clearState, downloadJson, downloadText, loadState, migrateState, saveState } from './storage.js';
import { sampleState } from './demo.js';
import { financeSummary, holdingReturn, investmentTotals, monthlyFlow, spendingByCategory, transactionFlow } from './finance-model.js';
import { applyPrivateIncomeRules, loadBridgeData, loadCardProfiles, loadImportData, loadPrivateFinanceData, loadRenewals, mapBridgeData } from './bridge.js';
import { applyDetectedPerkUsage, cardProfileLabel, catalogCoverage, mergeCatalogPerks, resolveCardProfileAccounts } from './card-perks.js';
import { matchStatement, statementSignature } from './import-intelligence.js';
import { axisLabelSlots, PLOT_BASELINE, seriesForRange, seriesGeometry } from './investment-chart.js';

let state = loadState();
let pendingImports = [];
let investmentRange = 'YTD';
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const compactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const reportedMoney = value => value == null || value === '' || !Number.isFinite(Number(value)) ? 'Not reported' : money.format(Number(value));
const hasServerAdapter = location.protocol === 'http:' || location.protocol === 'https:';
const safeHttpUrl = value => { try { const url = new URL(String(value || '')); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };

const viewCopy = {
  dashboard: ['YOUR MONEY', greeting(), 'A calm, complete view of what you own, owe, earn, and spend.'],
  accounts: ['EVERY BALANCE', 'Accounts', 'Cash, credit, and investments in one place.'],
  renewals: ['WHAT COMES NEXT', 'Renewals', 'Track subscriptions, bills, and one-time renewals.'],
  transactions: ['SEARCHABLE HISTORY', 'Transactions', 'Your normalized ledger across connected and imported accounts.'],
  investments: ['LONG-TERM VIEW', 'Investments', 'Holdings and performance without tax assumptions.'],
  benefits: ['USE IT OR LOSE IT', 'Card perks', 'Track credits and benefits before they expire.'],
  imports: ['PRIVATE BACKFILL', 'Statement inbox', 'Review intelligent account matches before older history enters your ledger.'],
  settings: ['PRIVACY AND CONNECTIONS', 'Settings', 'Control local data and the future Hermes bridge connection.'],
};

function render() {
  const data = displayState();
  document.body.classList.toggle('privacy', state.settings.privacyMode);
  $('#privacy-toggle').textContent = state.settings.privacyMode ? 'Show amounts' : 'Hide amounts';
  $('#privacy-toggle').setAttribute('aria-pressed', String(state.settings.privacyMode));
  $('#preview-banner').hidden = !isPreview();
  renderStatus(data);
  renderDashboard(data);
  renderAccounts(data);
  renderTransactions(data);
  renderInvestments(data);
  renderBenefits(data);
  renderImports();
  applyDataCss();
  for (const button of $$('.link-plaid')) {
    button.disabled = !hasServerAdapter;
    button.title = hasServerAdapter ? '' : 'Plaid linking is available in the authenticated hosted dashboard. Use statement imports in the desktop app.';
  }
}

function displayState() {
  return isPreview() ? sampleState() : state;
}

function isPreview() {
  if (state.sync?.status === 'healthy') return false; // real bridge data = never preview
  const empty = !state.accounts.length && !state.transactions.length && !state.holdings.length && !state.liabilities.length;
  return empty && state.settings.samplePreview !== false;
}

function renderStatus(data) {
  if (!hasServerAdapter) {
    $('#sidebar-status-dot').classList.remove('healthy');
    $('#sidebar-status').textContent = 'Desktop local mode';
    $('#sidebar-sync').textContent = 'Statement imports stay on this device';
    return;
  }
  const healthy = data.sync?.status === 'healthy';
  $('#sidebar-status-dot').classList.toggle('healthy', healthy);
  $('#sidebar-status').textContent = isPreview() ? 'Preview data' : healthy ? 'Bridge healthy' : 'Local data';
  $('#sidebar-sync').textContent = healthy && data.sync.lastSuccessfulSync ? `Updated ${relativeTime(data.sync.lastSuccessfulSync)}` : 'Bridge adapter ready for wiring';
}

function renderDashboard(data) {
  const summary = financeSummary(data);
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const flow = transactionFlow(data.transactions, monthStart);
  const net = flow.inflow - flow.outflow;
  $('#net-worth').textContent = money.format(summary.netWorth);
  $('#hero-assets').textContent = money.format(summary.assets);
  $('#hero-debt').textContent = money.format(summary.debt);
  $('#overview-freshness').textContent = isPreview() ? 'Sample data' : freshnessLabel(data.sync);
  $('#net-worth-detail').textContent = `${data.accounts.length} accounts included · ${data.sync?.accountsWithErrors || 0} with errors`;
  $('#month-net').textContent = money.format(net);
  $('#month-net').classList.toggle('negative', net < 0);
  $('#month-net-label').textContent = net >= 0 ? 'left after spending' : 'more spent than received';
  $('#month-inflow').textContent = money.format(flow.inflow);
  $('#month-outflow').textContent = money.format(flow.outflow);
  $('#flow-meter-fill').style.width = `${flow.inflow ? Math.min(100, Math.round(flow.outflow / flow.inflow * 100)) : 0}%`;

  const recurringOut = monthlyRecurring(data.recurring.filter(item => item.kind !== 'inflow'));
  const nextDue = [...data.liabilities].filter(item => item.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  $('#kpi-grid').innerHTML = [
    ['Cash on hand', money.format(summary.cash), `${data.accounts.filter(item => ['checking', 'savings'].includes(item.kind)).length} cash accounts`, 'mint'],
    ['Investments', money.format(summary.investments), `${data.holdings.length} holdings`, 'violet'],
    ['Monthly recurring', money.format(recurringOut), `${data.recurring.filter(item => item.kind !== 'inflow').length} expected outflows`, 'gold'],
    ['Next payment', nextDue ? money.format(numeric(nextDue.minimumPayment)) : '—', nextDue?.dueDate ? `Due ${formatDate(nextDue.dueDate)}` : 'No due date reported', 'blue'],
  ].map(kpiCard).join('');

  const buckets = monthlyFlow(data.transactions);
  $('#overview-chart').innerHTML = flowChart(buckets);
  $('#upcoming-summary').innerHTML = renewalRows((data.renewalsTracker || []).filter(item => item.date).sort((a, b) => a.date.localeCompare(b.date)).filter(item => item.date >= today()).slice(0, 3));
  $('#category-summary').innerHTML = categoryBars(spendingByCategory(data.transactions, monthStart).slice(0, 5));
  $('#account-summary').innerHTML = data.accounts.slice(0, 5).map(accountCompactRow).join('') || empty('No accounts yet.');
}

function renderAccounts(data) {
  const editable = !isPreview();
  const items = Number(data.sync?.itemsTracked);
  const connected = Number(data.sync?.accountsConnected);
  $('#plaid-item-coverage').textContent = Number.isFinite(items) ? `${items} of 10 Plaid connections` : '— of 10 Plaid connections';
  $('#plaid-account-coverage').textContent = Number.isFinite(connected) ? `${connected} accounts synced` : '— accounts synced';
  $('#settings-plaid-items').textContent = Number.isFinite(items) ? `${items} of 10 tracked` : '— of 10 tracked';
  $('#settings-plaid-accounts').textContent = Number.isFinite(connected) ? String(connected) : '—';
  if (!hasServerAdapter) {
    $('#plaid-item-coverage').textContent = 'Hosted dashboard only';
    $('#plaid-account-coverage').textContent = 'Use local statement imports here';
    $('#settings-plaid-items').textContent = 'Hosted dashboard only';
    $('#settings-plaid-accounts').textContent = 'Not connected in desktop mode';
  }
  $('#accounts-grid').innerHTML = data.accounts.map(account => accountCard(account, editable)).join('') || empty('Connect the bridge, add an account, or import a private profile backup.');
}

// Accounts that are rebuilt from a server source on every bridge refresh.
//
// refreshBridge drops every row with one of these prefixes and re-adds it from
// the adapter, so deleting one locally does nothing: the tile and its
// transactions reappear on the next refresh, about 800ms after any view
// change. The Remove button and the refresh filter must therefore agree, which
// is why they share this list instead of each spelling it out — the button
// previously tested only the Plaid prefix, so statement and private-investment
// tiles offered a delete that silently undid itself while the confirm dialog
// promised their transactions would go too.
const SERVER_OWNED_PREFIXES = ['bridge-acct-', 'statement-acct-', 'private-investment-'];

function isServerOwned(id) {
  return SERVER_OWNED_PREFIXES.some(prefix => String(id || '').startsWith(prefix));
}

function accountCard(account, editable) {
  const owed = account.kind === 'credit';
  const accentClass = owed ? 'account-card--credit' : account.kind === 'investment' ? 'account-card--investment' : 'account-card--cash';
  const isPlaid = String(account.id || '').startsWith('bridge-acct-');
  const isStatement = String(account.id || '').startsWith('statement-acct-');
  const snapshot = account.balanceAsOf
    ? `${isPlaid ? 'Plaid synced' : isStatement ? 'Statement updated' : 'Manual balance'} · ${formatDate(account.balanceAsOf)}`
    : isStatement ? 'Statement history imported · balance optional' : 'No current balance yet';
  const snapshotAction = editable && !account.balanceAsOf && !isPlaid ? `<button class="text-button edit-account snapshot-action" data-id="${escapeHtml(account.id)}">Add optional balance</button>` : '';
  const canImport = editable && ['credit', 'checking', 'savings'].includes(account.kind);
  const importer = canImport ? `<label class="account-statement-drop" title="Import directly into ${escapeHtml(account.name)}"><input class="account-file-input" type="file" accept=".qfx,.ofx,.qbo,.csv,text/csv" multiple data-account-id="${escapeHtml(account.id)}"><span>Drop CSV, QFX, or OFX here</span><small>Imports directly to this account and skips duplicates</small></label>` : '';
  return `<article class="account-card ${accentClass}" data-account-drop="${escapeHtml(account.id)}"><header><div><span class="institution">${escapeHtml(account.institution || account.kind)}</span><h3>${escapeHtml(account.name)}</h3></div>${editable && !isPlaid ? `<div class="account-actions"><button class="text-button edit-account" data-id="${escapeHtml(account.id)}">Edit</button>${isServerOwned(account.id) ? '' : `<button class="text-button text-button--danger remove-account" data-id="${escapeHtml(account.id)}">Remove</button>`}</div>` : isPlaid ? '<span class="plaid-badge">Plaid</span>' : '<span class="sample-tag">Sample</span>'}</header><div class="balance money ${numeric(account.currentBalance) < 0 ? 'negative' : ''}">${reportedMoney(account.currentBalance)}</div><footer><span class="muted">${snapshot}</span><span>${escapeHtml(account.kind)}</span></footer>${snapshotAction}${owed ? `<dl><dt>Statement</dt><dd class="money">${reportedMoney(account.statementBalance)}</dd><dt>Minimum</dt><dd class="money">${reportedMoney(account.minimumDue)}</dd><dt>Due</dt><dd>${account.dueDate ? formatDate(account.dueDate) : '—'}</dd></dl>` : ''}${importer}</article>`;
}

function accountCompactRow(account) {
  return `<div class="compact-account"><span class="account-icon account-icon--${escapeHtml(account.kind)}">${escapeHtml(account.name.slice(0, 1))}</span><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.institution || account.kind)}</small></div><strong class="money">${reportedMoney(account.currentBalance)}</strong></div>`;
}

function renderTransactions(data) {
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const flow = transactionFlow(data.transactions, monthStart);
  const categories = spendingByCategory(data.transactions, monthStart);
  const top = categories[0];
  $('#transaction-flow-kpis').innerHTML = [
    ['Money in', money.format(flow.inflow), 'Paychecks and other income', 'mint'],
    ['Money out', money.format(flow.outflow), 'Payments and transfers excluded', 'gold'],
    ['Net cash flow', money.format(flow.inflow - flow.outflow), flow.inflow >= flow.outflow ? 'Positive this month' : 'Negative this month', flow.inflow >= flow.outflow ? 'blue' : 'red'],
    ['Top category', top ? money.format(top.amount) : '—', top?.category || 'No categorized spending', 'violet'],
  ].map(kpiCard).join('');
  $('#transaction-flow-chart').innerHTML = flowChart(monthlyFlow(data.transactions));
  $('#transaction-flow-categories').innerHTML = categoryBars(categories.slice(0, 6));
  const search = ($('#transaction-search')?.value || '').trim().toLowerCase();
  const matches = data.transactions.filter(transaction => !search || [transaction.payee, transaction.notes, transaction.category, accountName(transaction.accountId, data)].some(value => String(value || '').toLowerCase().includes(search))).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500);
  $('#transaction-count').textContent = `${data.transactions.length} transactions · showing ${matches.length}`;
  $('#transaction-list').innerHTML = matches.length ? `<div class="transaction-table" role="table"><div class="transaction-row transaction-header" role="row"><span>Date</span><span>Account</span><span>Merchant</span><span>Category</span><span>Amount</span></div>${matches.map(item => `<div class="transaction-row" role="row"><span>${escapeHtml(item.date)}</span><span>${escapeHtml(accountName(item.accountId, data))}</span><span><strong>${escapeHtml(item.payee)}</strong>${item.notes ? `<small>${escapeHtml(item.notes)}</small>` : ''}</span><span>${escapeHtml(item.category || 'Uncategorized')}</span><span class="money ${numeric(item.amount) < 0 ? 'negative' : 'positive'}">${reportedMoney(item.amount)}</span></div>`).join('')}</div>` : empty('No transactions match this view.');
  applyDataCss($('#view-transactions'));
}

function renderInvestments(data) {
  const meta = data.investmentMeta || {};
  const totals = investmentTotals(data.holdings, meta);
  const fundLabel = count => `${count} fund${count === 1 ? '' : 's'}`;
  const contributionScope = totals.fromStatementOnly
    ? (meta.contributionCoverage || 'Reported by statement only')
    : totals.partial
      ? `${fundLabel(totals.reportingCount)} of ${totals.fundCount} report contributions`
      : `All ${fundLabel(totals.fundCount)}`;
  const gainScope = totals.fromStatementOnly
    ? 'Reported by statement only'
    : totals.partial
      ? `Across the ${fundLabel(totals.reportingCount)} reporting contributions`
      : 'Current value minus recorded contributions';
  $('#investment-kpis').innerHTML = [
    ['Current value', money.format(totals.totalValue), fundLabel(totals.fundCount), 'violet'],
    ['Contributed', money.format(totals.contributed), contributionScope, 'blue'],
    ['Investment gain', money.format(totals.gain), gainScope, totals.gain >= 0 ? 'mint' : 'red'],
    ['Personal return', Number.isFinite(Number(meta.personalReturn)) ? `${Number(meta.personalReturn).toFixed(2)}%` : '—', meta.personalReturnPeriod ? `${meta.personalReturnPeriod} · statement funds` : 'Not reported', 'gold'],
  ].map(kpiCard).join('');
  $('#investment-chart').innerHTML = investmentChart(meta, investmentRange, data);
  $$('#investment-ranges button').forEach(button => button.classList.toggle('active', button.dataset.range === investmentRange));
  $('#holding-count').textContent = `${data.holdings.length} fund${data.holdings.length === 1 ? '' : 's'}`;
  $('#holdings-list').innerHTML = data.holdings.length ? `<div class="holding-table"><div class="holding-row holding-header"><span>Fund</span><span>Account</span><span>Recorded contributions</span><span>Current value</span><span>Return</span></div>${data.holdings.map(item => { const performance = holdingReturn(item, investmentRange); return `<div class="holding-row"><span><strong>${escapeHtml(item.ticker || '—')}</strong><small>${escapeHtml(item.name || '')}</small></span><span>${escapeHtml(accountName(item.accountId, data))}</span><span class="money">${reportedMoney(item.costBasis)}</span><span class="money">${reportedMoney(item.value)}</span><span class="money ${performance ? (performance.rate >= 0 ? 'positive' : 'negative') : ''}">${performance ? `${performance.rate.toFixed(2)}%${performance.scope ? `<small>${escapeHtml(performance.scope)}</small>` : ''}` : 'Not available'}</span></div>`; }).join('')}</div>` : empty('No investment funds connected.');
  applyDataCss($('#view-investments'));
}

// Which accounts the history series actually describes. investmentHistory comes
// only from the private statement file, while holdings also include connected
// Plaid accounts that report a current value with no dated history. Without
// this split the chart silently reads as the whole portfolio.
function investmentCoverage(data) {
  const holdings = Array.isArray(data?.holdings) ? data.holdings : [];
  const isPrivate = item => String(item.id || '').startsWith('private-investment-');
  const names = items => [...new Set(items.map(item => accountName(item.accountId, data)))].filter(name => name !== 'Unassigned');
  const covered = holdings.filter(isPrivate);
  return {
    coveredNames: names(covered),
    uncoveredNames: covered.length ? names(holdings.filter(item => !isPrivate(item))) : [],
    totalValue: holdings.reduce((sum, item) => sum + numeric(item.value), 0),
  };
}

function investmentScopeNote(coverage) {
  if (!coverage.uncoveredNames.length) return '';
  const plural = coverage.uncoveredNames.length > 1;
  const scope = coverage.coveredNames.length ? coverage.coveredNames.join(' and ') : 'private statements';
  return `<p class="investment-scope">Plots ${escapeHtml(scope)} only. ${escapeHtml(coverage.uncoveredNames.join(', '))} ${plural ? 'report' : 'reports'} a current value with no dated history, so ${plural ? 'they are' : 'it is'} not charted. Portfolio total is ${money.format(coverage.totalValue)}.</p>`;
}

const SERIES_COLORS = ['var(--violet)', 'var(--green)', 'var(--gold)', 'var(--blue)'];

// Every account with recorded history becomes its own line. The adapter
// supplies any additional series under investments.series, so a brokerage
// account with parsed statements is charted rather than described in a
// footnote.
function investmentSeriesList(data) {
  const coverage = investmentCoverage(data);
  const list = [];
  const legacy = Array.isArray(data.investmentHistory) ? data.investmentHistory : [];
  if (legacy.length) {
    list.push({ label: coverage.coveredNames.join(' and ') || 'Statement balance', points: legacy });
  }
  for (const entry of Array.isArray(data.investmentSeries) ? data.investmentSeries : []) {
    const points = Array.isArray(entry?.points) ? entry.points : [];
    if (points.length) list.push({ label: String(entry.label || 'Account'), points });
  }
  return list;
}

function investmentChart(meta, range, data) {
  const asOf = meta.asOf ? new Date(`${meta.asOf}T12:00:00`) : new Date();
  const benchmark = Number(meta.returnByRange?.[range]);
  const charted = investmentSeriesList(data)
    .map(entry => ({ label: entry.label, points: seriesForRange(entry.points, range, asOf) }))
    .filter(entry => entry.points.length);
  const chartedLabels = charted.map(entry => entry.label);
  // Only accounts with no history at all are missing; a charted account is not.
  const coverage = investmentCoverage(data);
  const missing = coverage.uncoveredNames.filter(name => !chartedLabels.some(label => label.includes(name)));
  const scopeNote = investmentScopeNote({ ...coverage, uncoveredNames: missing, coveredNames: chartedLabels });

  const totalPoints = charted.reduce((sum, entry) => sum + entry.points.length, 0);
  if (!charted.length || totalPoints < 2) return `<div class="investment-empty"><strong>${range} history is not available yet</strong><span>Add more statements to build this range. ${Number.isFinite(benchmark) ? `Reported fund return: ${benchmark.toFixed(2)}%.` : ''}</span></div>${scopeNote}`;

  const { series, dates } = seriesGeometry(charted);
  const single = series.length === 1;
  const lines = series.map((entry, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    const line = entry.points.map(point => `${point.x},${point.y}`).join(' ');
    // A one-point series has no line to draw; its dot still renders below.
    if (entry.points.length < 2) return '';
    const area = single ? `<polygon points="${entry.points[0].x},${PLOT_BASELINE} ${line} ${entry.points.at(-1).x},${PLOT_BASELINE}" fill="url(#investment-fill)"/>` : '';
    return `${area}<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const dots = series.map((entry, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length];
    return entry.points.map(point => `<span class="investment-dot" data-css="left:${point.x}%;top:${point.y}%;border-color:${color}" title="${escapeHtml(entry.label)} · ${escapeHtml(formatDate(point.date))} · ${escapeHtml(money.format(point.value))}"></span>`).join('');
  }).join('');
  const axis = axisLabelSlots(dates).map(index => `<span data-css="left:${dates[index].x}%">${escapeHtml(formatDate(dates[index].date))}</span>`).join('');
  const legend = series.length > 1
    ? `<div class="investment-legend">${series.map((entry, index) => `<span><i data-css="background:${SERIES_COLORS[index % SERIES_COLORS.length]}"></i>${escapeHtml(entry.label)} <strong class="money">${money.format(entry.points.at(-1).value)}</strong></span>`).join('')}</div>`
    : '';
  const headlineLabel = single ? `${chartedLabels[0]} balance` : 'Charted balance';
  const headlineValue = series.reduce((sum, entry) => sum + numeric(entry.points.at(-1).value), 0);

  return `<div class="investment-chart-summary"><div><span>${escapeHtml(headlineLabel)}</span><strong class="money">${money.format(headlineValue)}</strong></div><div><span>${range} fund return</span><strong class="${benchmark >= 0 ? 'positive' : 'negative'}">${Number.isFinite(benchmark) ? `${benchmark.toFixed(2)}%` : 'Not reported'}</strong></div></div>${legend}<div class="investment-plot" role="img" aria-label="${escapeHtml(chartedLabels.join(' and '))} history for ${range}"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><defs><linearGradient id="investment-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--violet)" stop-opacity=".34"/><stop offset="1" stop-color="var(--violet)" stop-opacity="0"/></linearGradient></defs>${lines}</svg>${dots}</div><div class="investment-axis">${axis}</div>${scopeNote}`;
}

function renderBenefits(data) {
  const filter = $('#benefit-filter')?.value || 'open';
  const complete = item => numeric(item.amount) > 0 && numeric(item.usedAmount) >= numeric(item.amount);
  const list = data.benefits.filter(item => filter === 'all' || (filter === 'used' ? complete(item) : !complete(item)));
  const total = data.benefits.reduce((sum, item) => sum + Math.max(0, numeric(item.amount)), 0);
  const used = data.benefits.reduce((sum, item) => sum + Math.min(Math.max(0, numeric(item.amount)), Math.max(0, numeric(item.usedAmount))), 0);
  const coverage = catalogCoverage(data.accounts, data.cardProfiles || []);
  renderCardProfileLinks(data);
  $('#benefit-kpis').innerHTML = [
    ['Available this period', money.format(total), `${data.benefits.length} tracked credits`, 'violet'],
    ['Marked used', money.format(used), `${total ? Math.round(used / total * 100) : 0}% of available value`, 'mint'],
    ['Still available', money.format(Math.max(0, total - used)), 'Review issuer terms before purchase', 'blue'],
    // The KPI detail is a bold accent-coloured line, so listing every unmatched
    // card here turned the tile into a block of gold text that pushed the other
    // tiles out of alignment. The count belongs here; the names belong in the
    // muted note below, where they are readable and actionable.
    ['Cards recognized', `${coverage.matchedCards} of ${coverage.creditCards}`, coverage.unmatchedCards.length ? `${coverage.unmatchedCards.length} card${coverage.unmatchedCards.length === 1 ? '' : 's'} need product details` : 'All connected cards matched', coverage.unmatchedCards.length ? 'gold' : 'mint'],
  ].map(kpiCard).join('');
  $('#benefit-catalog-note').textContent = coverage.unmatchedCards.length
    ? `${coverage.matchedCards} of ${coverage.creditCards} saved cards are linked to transaction history. Still to match: ${coverage.unmatchedCards.join(', ')}. Open Card connections to link them; imported statements work even when Plaid is unavailable.`
    : 'Posted issuer credits are detected automatically for supported cards and periods. Manual amounts remain available as an override.';
  $('#benefits-grid').innerHTML = list.map(item => benefitCard(item, data, !isPreview())).join('') || empty('No perks match this view.');
}

function renderCardProfileLinks(data) {
  const savedProfiles = data.cardProfiles || [];
  const creditAccounts = data.accounts.filter(account => account.kind === 'credit');
  const linked = savedProfiles.filter(profile => creditAccounts.some(account => account.id === profile.accountId)).length;
  $('#card-connection-summary').textContent = `Card connections · ${linked} of ${savedProfiles.length}`;
  $('#card-profile-links').innerHTML = savedProfiles.length ? savedProfiles.map((profile, index) => {
    const connected = creditAccounts.find(account => account.id === profile.accountId);
    return `<label class="card-profile-link"><span><strong>${escapeHtml(profile.owner ? `${profile.owner} · ${cardProfileLabel(profile.profile)}` : cardProfileLabel(profile.profile))}</strong><small>${connected ? `${escapeHtml(connected.institution)} · ${escapeHtml(connected.name)}` : 'Not linked — automatic perk tracking is paused'}</small></span><select class="card-profile-account" data-index="${index}"><option value="">Not linked</option>${creditAccounts.map(account => `<option value="${escapeHtml(account.id)}" ${account.id === profile.accountId ? 'selected' : ''}>${escapeHtml(account.institution)} · ${escapeHtml(account.name)}${account.last4 ? ` ••••${escapeHtml(String(account.last4).slice(-4))}` : ''}</option>`).join('')}</select></label>`;
  }).join('') : empty('No household card profiles are saved yet.');
}

async function saveCardProfileSelection(index, accountId) {
  const profile = state.cardProfiles[index];
  if (!profile) return;
  const next = state.cardProfiles.map((item, position) => {
    if (position !== index) return item;
    const updated = { ...item };
    if (accountId) updated.accountId = accountId;
    else delete updated.accountId;
    return updated;
  });
  try {
    const response = await fetch('/api/card-profiles', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(next) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not save card connection');
    state.cardProfiles = payload;
    state.benefits = applyDetectedPerkUsage(mergeCatalogPerks(state.accounts, state.benefits, new Date(), state.cardProfiles), state.transactions);
    renderBenefits(displayState());
    toast(accountId ? 'Card connected to its transaction history.' : 'Card connection removed.');
  } catch (error) { toast(error.message); }
}

function benefitCard(benefit, data, editable) {
  const amount = Math.max(0, numeric(benefit.amount));
  const used = Math.min(amount, Math.max(0, numeric(benefit.usedAmount)));
  const percent = amount ? Math.round(used / amount * 100) : 0;
  const sourceUrl = safeHttpUrl(benefit.sourceUrl);
  const source = sourceUrl ? `<a class="benefit-source" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">Official terms</a>` : '';
  const detection = benefit.detectionCount
    ? `<div class="benefit-meta benefit-meta--detected"><span>Auto-detected from ${benefit.detectionCount} posted issuer credit${benefit.detectionCount === 1 ? '' : 's'}</span><span>${benefit.lastDetectedAt ? formatDate(benefit.lastDetectedAt) : ''}</span></div>${benefit.capExceeded ? `<div class="benefit-meta"><span>Observed credit ${money.format(benefit.detectedUsedAmount)} exceeded the tracked cap; verify current issuer terms.</span></div>` : ''}`
    : benefit.lastObservedCreditAt ? `<div class="benefit-meta"><span>Last posted issuer credit was ${money.format(benefit.lastObservedCreditAmount)} in a prior period</span><span>${formatDate(benefit.lastObservedCreditAt)}</span></div>`
      : numeric(benefit.manualUsedAmount) > 0 ? `<div class="benefit-meta"><span>Manual usage override — no matching posted issuer credit detected</span></div>` : '';
  const tracker = amount > 0
    ? `<progress class="progress" max="100" value="${percent}" aria-label="${percent}% used">${percent}%</progress><div class="benefit-meta"><span class="money">${money.format(used)} / ${money.format(amount)}</span><span>${benefit.periodEnd ? `Ends ${formatDate(benefit.periodEnd)}` : escapeHtml(benefit.cadence)}</span></div>${detection}`
    : `<div class="benefit-meta benefit-meta--included"><span>Included benefit</span><span>${escapeHtml(benefit.cadence)}</span></div>`;
  return `<article class="benefit-card"><header><div><p class="eyebrow">${escapeHtml(benefit.cardLabel || accountName(benefit.accountId, data))}</p><h3>${escapeHtml(benefit.name)}</h3></div>${editable ? `<button class="text-button edit-benefit" data-id="${escapeHtml(benefit.id)}">Edit</button>` : '<span class="sample-tag">Sample</span>'}</header><p>${escapeHtml(benefit.notes || benefit.cadence)}</p>${tracker}${source}</article>`;
}

function renderImports() {
  const ready = pendingImports.filter(item => item.accountId && item.confirmed && !item.importing).length;
  $('#import-batch-actions').innerHTML = pendingImports.length ? `<div><strong>${pendingImports.length} statement${pendingImports.length === 1 ? '' : 's'} ready for review</strong><span>${ready} can be imported now</span></div><button class="primary commit-ready-imports" ${ready ? '' : 'disabled'}>Import all ready</button>` : '';
  $('#import-review').innerHTML = pendingImports.map((item, index) => {
    const selected = item.accountId || item.match?.suggestedAccountId || '';
    const status = item.match?.status || 'manual';
    const label = status === 'auto' ? 'Matched automatically' : status === 'confirm' ? 'Please confirm this match' : 'Choose the account';
    const reasons = (item.match?.reasons || []).slice(0, 2).map(escapeHtml).join(' · ');
    const canCommit = item.accountId && item.confirmed && !item.importing;
    return `<article class="import-file"><header><div><strong>${escapeHtml(item.filename)}</strong><div class="muted">${escapeHtml(item.format)} · ${escapeHtml(item.institution || 'Unknown institution')}</div></div><button class="text-button remove-import" data-index="${index}" ${item.importing ? 'disabled' : ''}>Remove</button></header><div class="import-match import-match--${status}"><span class="import-match-pill">${label}</span>${reasons ? `<small>${reasons}</small>` : ''}</div><label class="field"><span>Destination account</span><select class="import-account" data-index="${index}" ${item.importing ? 'disabled' : ''}><option value="">Choose an account</option>${state.accounts.map(account => `<option value="${escapeHtml(account.id)}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(account.institution || '')} · ${escapeHtml(account.name)}${account.last4 ? ` ••••${escapeHtml(String(account.last4).slice(-4))}` : ''}</option>`).join('')}</select></label><div class="import-stats"><span>${item.transactions.length} parsed</span><span>${item.rejected.length} rejected</span><span>${item.match?.confidence || 0}% evidence score</span></div><div class="import-actions"><button class="ghost create-statement-account" data-index="${index}">Create statement account</button>${status === 'confirm' && !item.confirmed && selected ? `<button class="ghost confirm-import-match" data-index="${index}">Confirm suggested account</button>` : ''}<button class="primary commit-import" data-index="${index}" ${canCommit ? '' : 'disabled'}>${item.importing ? 'Importing…' : 'Add transactions'}</button></div></article>`;
  }).join('');
  $('#import-history').innerHTML = state.imports.slice().reverse().slice(0, 20).map(item => `<div class="list-row"><div><strong>${escapeHtml(item.filename)}</strong><p>${escapeHtml(accountName(item.accountId, state))} · ${item.accepted} added${item.plaidCovered ? ` · ${item.plaidCovered} handled by Plaid` : ''} · ${item.duplicates} duplicates · ${item.rejected} rejected</p></div><span class="freshness-pill">${formatDate(item.importedAt.slice(0, 10))}</span></div>`).join('') || empty('No files imported yet.');
}

function kpiCard([label, value, detail, accent]) {
  return `<article class="kpi kpi--${accent}"><span>${escapeHtml(label)}</span><strong class="money">${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
}

// Every generated size and position ships as data-css, never an inline style.
//
// The app is served with `style-src 'self'` and no 'unsafe-inline', so the
// browser drops a style attribute out of injected markup before layout runs.
// That silently flattened four charts at once: flow bars collapsed to zero
// height, every category track filled its whole rail so all spending looked
// equal, the investment axis stacked each label at the plot's left edge, and
// the dots landed at their static position. CSSOM writes are not gated by CSP,
// so applyDataCss() re-applies these declarations after each innerHTML write.
function applyDataCss(root = document) {
  for (const node of root.querySelectorAll('[data-css]')) {
    for (const declaration of node.dataset.css.split(';')) {
      const split = declaration.indexOf(':');
      if (split < 0) continue;
      node.style.setProperty(declaration.slice(0, split).trim(), declaration.slice(split + 1).trim());
    }
    delete node.dataset.css;
  }
}

function flowChart(buckets) {
  const max = Math.max(1, ...buckets.flatMap(item => [item.inflow, item.outflow]));
  return buckets.map(item => `<div class="bar-group"><div class="bar-pair"><span class="bar bar--in" data-css="height:${Math.max(item.inflow ? 6 : 0, item.inflow / max * 100)}%" title="Income ${money.format(item.inflow)}"></span><span class="bar bar--out" data-css="height:${Math.max(item.outflow ? 6 : 0, item.outflow / max * 100)}%" title="Spending ${money.format(item.outflow)}"></span></div><small>${escapeHtml(item.label)}</small></div>`).join('');
}

function categoryBars(categories) {
  if (!categories.length) return empty('No categorized spending yet.');
  const max = categories[0].amount || 1;
  return categories.map(item => `<div class="category-row"><div><strong>${escapeHtml(item.category)}</strong><span class="money">${money.format(item.amount)}</span></div><div class="category-track"><span data-css="width:${Math.max(3, item.amount / max * 100)}%"></span></div></div>`).join('');
}

function monthlyRecurring(items) {
  const factors = { weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, semiannual: 1 / 6, annual: 1 / 12 };
  return items.reduce((sum, item) => sum + Math.abs(numeric(item.amount)) * (factors[item.cadence] || 1), 0);
}

async function receiveFiles(files, targetAccountId = '', autoCommit = false) {
  let completed = 0;
  for (const file of files) {
    try {
      const [parsed, fileHash] = await Promise.all([parseStatementFile(file), hashFile(file)]);
      const inferred = matchStatement(parsed, state.accounts, state.transactions.filter(item => String(item.id || '').startsWith('bridge-tx-')), state.importMappings);
      const match = targetAccountId ? { ...inferred, status: 'auto', accountId: targetAccountId, suggestedAccountId: targetAccountId, confidence: 100, reasons: ['Dropped directly on this account tile'], confirmed: true } : inferred;
      pendingImports.push({ ...parsed, fileHash, signature: match.signature || statementSignature(parsed), match, accountId: targetAccountId || (match.status === 'auto' ? match.accountId : ''), confirmed: Boolean(targetAccountId) || match.status === 'auto', importing: false });
      if (targetAccountId && autoCommit && await commitImport(pendingImports.length - 1)) completed += 1;
    } catch (error) { toast(`${file.name}: ${error.message}`); }
  }
  renderImports();
  if (targetAccountId && autoCommit) {
    showView('accounts');
    if (completed) toast(`${completed} statement file${completed === 1 ? '' : 's'} synced to ${accountName(targetAccountId)}.`);
  } else showView('imports');
}

async function hashFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function commitImport(index) {
  const item = pendingImports[index];
  if (!item?.accountId || !item.confirmed || item.importing) return false;
  item.importing = true;
  renderImports();
  try {
    if (!hasServerAdapter) {
      const incoming = item.transactions.map(transaction => ({ ...transaction, accountId: item.accountId, importedAt: new Date().toISOString() }));
      const { accepted, duplicates } = dedupeTransactions(state.transactions, incoming);
      state.transactions.push(...accepted);
      state.imports.push({ id: `local:${item.fileHash.slice(0, 20)}`, fileHash: item.fileHash, filename: item.filename, format: item.format, institution: item.institution, last4: item.last4, accountId: item.accountId, accepted: accepted.length, duplicates: duplicates.length, rejected: item.rejected.length, importedAt: new Date().toISOString() });
      state.importMappings[item.signature] = { accountId: item.accountId, confirmedAt: new Date().toISOString() };
      state.importRevision = Math.max(0, Number(state.importRevision) || 0) + 1;
      pendingImports.splice(index, 1);
      persist();
      toast(`${accepted.length} local transactions added; ${duplicates.length} duplicates skipped.`);
      return true;
    }
    const response = await fetch('/api/imports/commit', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ fileHash: item.fileHash, filename: item.filename, format: item.format, institution: item.institution, last4: item.last4, signature: item.signature, accountId: item.accountId, transactions: item.transactions, rejected: item.rejected.length, confidence: item.match?.confidence || 0 }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Import failed (${response.status})`);
    pendingImports.splice(index, 1);
    await refreshBridge();
    toast(result.alreadyImported ? 'That exact file was already imported; nothing was duplicated.' : `${result.accepted} transactions added; ${result.duplicates} Plaid or statement duplicates skipped.`);
    return true;
  } catch (error) {
    item.importing = false;
    renderImports();
    toast(error.message);
    return false;
  }
}

async function commitReadyImports() {
  let completed = 0;
  while (true) {
    const index = pendingImports.findIndex(item => item.accountId && item.confirmed && !item.importing);
    if (index < 0) break;
    if (!await commitImport(index)) break;
    completed += 1;
  }
  if (completed > 1) toast(`${completed} statements imported successfully.`);
}

function renewalRows(items) {
  if (!items.length) return empty('No upcoming renewals with a future date.');
  return items.map(item => `<div class="list-row"><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.cycle || 'renewal')}</p></div><div class="row-amount"><strong class="money">${money.format(Math.abs(numeric(item.price)))}</strong><small>${formatDate(item.date)}</small></div></div>`).join('');
}

function statementAccountDefaults(item) {
  const source = `${item.institution || ''} ${item.filename || ''}`.toLowerCase();
  const institution = /chase/.test(source) ? 'Chase' : /capital|\bc1\b/.test(source) ? 'Capital One' : /american express|amex/.test(source) ? 'American Express' : /\bafcu\b|america first/.test(source) ? 'America First Credit Union' : item.institution || 'Statement account';
  const suffix = String(item.last4 || '').replace(/\D/g, '').slice(-5);
  return { name: `${institution}${suffix ? ` ••••${suffix.slice(-4)}` : ''}`, institution, last4: suffix, kind: item.accountKind || 'credit' };
}

function openStatementAccountEditor(index) {
  const item = pendingImports[index];
  if (!item) return;
  const value = statementAccountDefaults(item);
  openEditor('Create statement account', [field('Account name', 'name', value.name, 'text', true), field('Institution', 'institution', value.institution, 'text', true), field('Account suffix', 'last4', value.last4), selectField('Type', 'kind', value.kind, ['credit', 'checking', 'savings', 'investment', 'other'])], async data => {
    try {
      const response = await fetch('/api/imports/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not create account');
      state.accounts.push(result.account);
      item.accountId = result.account.id;
      item.confirmed = true;
      item.match = { status: 'auto', accountId: result.account.id, suggestedAccountId: result.account.id, confidence: 100, reasons: ['Private statement account confirmed'] };
      renderImports();
      toast(result.created ? 'Statement account created and selected.' : 'Existing statement account selected.');
    } catch (error) { toast(error.message); }
  });
}

// A card added by hand before Plaid connected it for real leaves two tiles for
// one account, and until now nothing could clear the leftover. Plaid, statement
// and private-investment rows are rebuilt from their source on every refresh,
// so only locally owned rows are removable; the tile hides the button for the
// rest rather than offering a delete that would silently reappear.
function deleteAccount(id) {
  const account = state.accounts.find(item => item.id === id);
  if (!account) return;
  const linked = state.transactions.filter(item => item.accountId === id).length;
  const warning = linked ? `${linked} transaction${linked === 1 ? '' : 's'} recorded against it will be removed too. ` : '';
  if (!confirm(`Remove ${account.name}? ${warning}Connected Plaid accounts are not affected.`)) return;
  state.accounts = state.accounts.filter(item => item.id !== id);
  state.transactions = state.transactions.filter(item => item.accountId !== id);
  state.benefits = (state.benefits || []).filter(item => item.accountId !== id);
  state.cardProfiles = (state.cardProfiles || []).map(profile => {
    if (profile.accountId !== id) return profile;
    const { accountId, ...rest } = profile;
    return rest;
  });
  persist();
  toast(`${account.name} removed.`);
}

function openAccountEditor(account = {}) {
  const value = { id: account.id || crypto.randomUUID(), name: '', institution: '', kind: 'credit', last4: '', currentBalance: '', balanceAsOf: today(), statementBalance: '', minimumDue: '', dueDate: '', annualFee: '', pointsBalance: '', ...account };
  openEditor(account.id ? 'Edit account' : 'Add account', [field('Name', 'name', value.name, 'text', true), field('Institution', 'institution', value.institution), selectField('Type', 'kind', value.kind, ['checking', 'savings', 'credit', 'investment', 'other']), field('Account suffix (optional)', 'last4', value.last4), field('Current balance', 'currentBalance', value.currentBalance, 'number'), field('Balance as of', 'balanceAsOf', value.balanceAsOf, 'date'), field('Statement balance', 'statementBalance', value.statementBalance, 'number'), field('Minimum due', 'minimumDue', value.minimumDue, 'number'), field('Due date', 'dueDate', value.dueDate, 'date'), field('Annual fee', 'annualFee', value.annualFee, 'number'), field('Points / miles', 'pointsBalance', value.pointsBalance, 'number')], data => { upsert(state.accounts, { ...value, ...data }); persist(); });
}

function openBenefitEditor(benefit = {}) {
  const value = { id: benefit.id || crypto.randomUUID(), accountId: state.accounts[0]?.id || '', name: '', amount: '', manualUsedAmount: '', cadence: 'monthly', periodStart: today().slice(0, 8) + '01', periodEnd: '', sourceUrl: '', notes: '', ...benefit, manualUsedAmount: benefit.manualUsedAmount ?? benefit.usedAmount ?? '' };
  openEditor(benefit.id ? 'Edit perk' : 'Add perk', [selectField('Account', 'accountId', value.accountId, state.accounts.map(account => ({ value: account.id, label: account.name }))), field('Perk', 'name', value.name, 'text', true), field('Available amount', 'amount', value.amount, 'number'), field('Manual used override', 'manualUsedAmount', value.manualUsedAmount, 'number'), selectField('Cadence', 'cadence', value.cadence, ['monthly', 'quarterly', 'semiannual', 'annual', 'cardmember-year', 'multi-year']), field('Period starts', 'periodStart', value.periodStart, 'date'), field('Period ends', 'periodEnd', value.periodEnd, 'date'), field('Official source URL', 'sourceUrl', value.sourceUrl, 'url'), field('Notes', 'notes', value.notes, 'text', false, true)], data => { upsert(state.benefits, applyDetectedPerkUsage([{ ...value, ...data, manualPeriodStart: data.periodStart, usedAmount: data.manualUsedAmount }], state.transactions)[0]); persist(); });
}

function openEditor(title, fields, onSave) {
  $('#dialog-title').textContent = title;
  $('#editor-fields').innerHTML = `<div class="field-grid">${fields.join('')}</div>`;
  const dialog = $('#editor-dialog');
  const form = $('#editor-form');
  dialog.showModal();
  const handler = event => {
    if (event.submitter?.value !== 'save') return;
    event.preventDefault();
    onSave(Object.fromEntries(new FormData(form)));
    dialog.close();
  };
  form.addEventListener('submit', handler);
  dialog.addEventListener('close', () => form.removeEventListener('submit', handler), { once: true });
}

// Cancel buttons are type="button" so an empty required field can never trap
// the dialog open (a submit-cancel would be blocked by form validation).
$$('.dialog-cancel').forEach(button => button.addEventListener('click', () => $('#editor-dialog').close()));

function exportActual() {
  const populated = state.accounts.filter(account => state.transactions.some(transaction => transaction.accountId === account.id));
  if (!populated.length) { toast('Import transactions before exporting.'); return; }
  populated.forEach(account => downloadText(`actual-${slug(account.name)}.csv`, toActualCsv(state.transactions.filter(transaction => transaction.accountId === account.id)), 'text/csv;charset=utf-8'));
  toast(`${populated.length} Actual CSV files exported.`);
}

function showView(name) {
  const viewName = name;
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${viewName}`));
  $$('.tabs button').forEach(button => {
    const matchesView = button.dataset.view === viewName;
    button.classList.toggle('active', matchesView);
    if (matchesView) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const [kicker, title, description] = viewCopy[viewName] || viewCopy.dashboard;
  $('#page-kicker').textContent = kicker;
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  document.dispatchEvent(new CustomEvent('wmd:view', { detail: { view: viewName } }));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  scheduleRefresh();
}

function persist() { saveState(state); render(); }
function upsert(list, value) { const index = list.findIndex(item => item.id === value.id); if (index >= 0) list[index] = value; else list.push(value); }
function accountName(id, data = state) { return data.accounts.find(account => account.id === id)?.name || 'Unassigned'; }
function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function formatDate(value) { if (!value) return '—'; return shortDate.format(new Date(`${String(value).slice(0, 10)}T12:00:00`)); }
function relativeTime(value) { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000)); return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`; }
function freshnessLabel(sync) { return sync?.lastSuccessfulSync ? `Updated ${relativeTime(sync.lastSuccessfulSync)}` : 'Local data'; }
function today() { return new Date().toISOString().slice(0, 10); }
function greeting() { const hour = new Date().getHours(); return `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}.`; }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function empty(message) { return `<p class="empty">${escapeHtml(message)}</p>`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function field(label, name, value = '', type = 'text', required = false, full = false) { return `<label class="field ${full ? 'full' : ''}"><span>${escapeHtml(label)}</span><input name="${escapeHtml(name)}" type="${type}" value="${escapeHtml(value)}" ${required ? 'required' : ''} ${type === 'number' ? 'step="0.01"' : ''}></label>`; }
function selectField(label, name, selected, options) { const normalized = options.map(option => typeof option === 'string' ? { value: option, label: option } : option); return `<label class="field"><span>${escapeHtml(label)}</span><select name="${escapeHtml(name)}">${normalized.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === selected ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></label>`; }
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500); }

$$('.tabs button').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
document.addEventListener('click', event => {
  const jump = event.target.closest('[data-jump]'); if (jump) showView(jump.dataset.jump);
  const account = event.target.closest('.edit-account'); if (account) openAccountEditor(state.accounts.find(item => item.id === account.dataset.id));
  const removeAccount = event.target.closest('.remove-account'); if (removeAccount) deleteAccount(removeAccount.dataset.id);
  const benefit = event.target.closest('.edit-benefit'); if (benefit) openBenefitEditor(state.benefits.find(item => item.id === benefit.dataset.id));
  const remove = event.target.closest('.remove-import'); if (remove) { pendingImports.splice(Number(remove.dataset.index), 1); renderImports(); }
  const commit = event.target.closest('.commit-import'); if (commit) commitImport(Number(commit.dataset.index));
  const confirmMatch = event.target.closest('.confirm-import-match'); if (confirmMatch) { const item = pendingImports[Number(confirmMatch.dataset.index)]; item.accountId = item.match.suggestedAccountId; item.confirmed = true; renderImports(); }
  const createStatement = event.target.closest('.create-statement-account'); if (createStatement) openStatementAccountEditor(Number(createStatement.dataset.index));
  if (event.target.closest('.commit-ready-imports')) commitReadyImports();
  const range = event.target.closest('#investment-ranges [data-range]'); if (range) { investmentRange = range.dataset.range; renderInvestments(displayState()); }
  if (event.target.closest('.link-plaid')) startPlaidLink(event.target.closest('.link-plaid'));
});

async function startPlaidLink(button) {
  if (!hasServerAdapter) {
    toast('Plaid linking requires the authenticated hosted dashboard. Import a statement here instead.');
    return;
  }
  const original = button.textContent;
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  button.disabled = true;
  button.textContent = 'Opening Plaid…';
  try {
    const response = await fetch('/api/plaid/connect/start', { method: 'POST', headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok || !payload.linkUrl || !payload.sessionId) throw new Error(payload.error || 'Plaid could not start');
    if (popup) popup.location.href = payload.linkUrl; else window.open(payload.linkUrl, '_blank', 'noopener,noreferrer');
    toast('Plaid opened in a new tab. Finish linking there.');
    pollPlaidLink(payload.sessionId);
  } catch (error) {
    if (popup) popup.close();
    toast(error.message || 'Plaid could not start.');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function pollPlaidLink(sessionId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const response = await fetch(`/api/plaid/connect/status/${encodeURIComponent(sessionId)}`, { headers: { Accept: 'application/json' } });
      const payload = await response.json();
      if (response.ok && payload.status === 'completed') {
        toast('Plaid connection complete. Refreshing accounts…');
        await refreshBridge();
        return;
      }
    } catch { /* keep polling while the Hosted Link tab is open */ }
  }
  toast('Plaid is still waiting. Refresh after finishing the Link window.');
}
$('#add-account').addEventListener('click', () => openAccountEditor());
$('#add-benefit').addEventListener('click', () => openBenefitEditor());
$('#dismiss-preview').addEventListener('click', () => { state.settings.samplePreview = false; persist(); });
$('#privacy-toggle').addEventListener('click', () => { state.settings.privacyMode = !state.settings.privacyMode; persist(); });
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('wmd_theme', next); } catch (e) {}
  $('#theme-toggle').textContent = next === 'light' ? '☀️' : '🌙';
});
$('#logout-btn').addEventListener('click', () => { location.href = '/logout'; });
$('#quick-import').addEventListener('click', () => { showView('imports'); $('#file-input').click(); });
$('#file-input').addEventListener('change', event => receiveFiles(event.target.files));
$('#benefit-filter').addEventListener('change', () => renderBenefits(displayState()));
$('#transaction-search').addEventListener('input', () => renderTransactions(displayState()));
$('#import-review').addEventListener('change', event => { if (!event.target.matches('.import-account')) return; const item = pendingImports[Number(event.target.dataset.index)]; item.accountId = event.target.value; item.confirmed = Boolean(item.accountId); renderImports(); });
$('#card-profile-links').addEventListener('change', event => { if (event.target.matches('.card-profile-account')) saveCardProfileSelection(Number(event.target.dataset.index), event.target.value); });
document.addEventListener('change', event => { if (!event.target.matches('.account-file-input')) return; receiveFiles(event.target.files, event.target.dataset.accountId, true); event.target.value = ''; });
document.addEventListener('dragover', event => { const tile = event.target.closest?.('[data-account-drop]'); if (!tile) return; event.preventDefault(); tile.classList.add('account-card--drag'); });
document.addEventListener('dragleave', event => { const tile = event.target.closest?.('[data-account-drop]'); if (!tile || tile.contains(event.relatedTarget)) return; tile.classList.remove('account-card--drag'); });
document.addEventListener('drop', event => { const tile = event.target.closest?.('[data-account-drop]'); if (!tile) return; event.preventDefault(); tile.classList.remove('account-card--drag'); if (event.dataTransfer?.files?.length) receiveFiles(event.dataTransfer.files, tile.dataset.accountDrop, true); });
$('#export-actual').addEventListener('click', exportActual);
$('#export-profile').addEventListener('click', () => { if (!confirm('This backup is unencrypted and contains normalized transactions. Store it securely. Continue?')) return; downloadJson(`well-done-money-backup-UNENCRYPTED-${today()}.json`, state); });
$('#profile-input').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) throw new Error('Backup is larger than the 20 MB safety limit.');
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.transactions)) throw new Error('Invalid WellDone Money backup');
    if (parsed.accounts.length > 1000 || parsed.transactions.length > 200000) throw new Error('Backup exceeds the supported record limits.');
    if (!confirm(`Replace this profile with ${parsed.accounts.length} accounts and ${parsed.transactions.length} transactions? A recovery copy of the current profile will be kept.`)) return;
    backupState(state, localStorage, 'before-import');
    state = migrateState(parsed);
    persist();
    toast('Profile restored.');
  } catch (error) { toast(error.message); }
  finally { event.target.value = ''; }
});
$('#clear-data').addEventListener('click', () => { if (!confirm('Delete WellDone Money data from this browser?')) return; clearState(); state = loadState(); render(); toast('Local data cleared.'); });
const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', event => receiveFiles(event.dataTransfer.files));
// Web-only. Inside the desktop shell the bundle is already local, and a
// service worker would keep serving the previous build after an update.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();

// Live bridge refresh: merge real data from the same-origin adapter into the
// local state. Bridge rows (id prefix) are replaced on every fetch; manual and
// imported rows are preserved. Preview data stays if the bridge is down.
async function refreshBridge() {
  try {
    const [d, cardProfiles, importData, privateFinance, renewals] = await Promise.all([loadBridgeData(), loadCardProfiles(), loadImportData(), loadPrivateFinanceData(), loadRenewals()]);
    const m = mapBridgeData(d);
    if (!m.accounts.length) return;
    const keepLocal = (list, prefix) => (list || []).filter(item => !String(item.id || '').startsWith(prefix));
    const localAccounts = (state.accounts || []).filter(item => !isServerOwned(item.id));
    const priorStatementAccounts = (state.accounts || []).filter(item => String(item.id || '').startsWith('statement-acct-'));
    const priorPrivateAccounts = (state.accounts || []).filter(item => String(item.id || '').startsWith('private-investment-'));
    const statementAccounts = importData && Array.isArray(importData.accounts) ? importData.accounts : priorStatementAccounts;
    const privateAccounts = privateFinance && Array.isArray(privateFinance.investments?.accounts) ? privateFinance.investments.accounts : priorPrivateAccounts;
    state.accounts = [...localAccounts, ...m.accounts, ...statementAccounts, ...privateAccounts];
    const priorBridgeTransactions = (state.transactions || []).filter(item => String(item.id || '').startsWith('bridge-tx-'));
    const manualTransactions = (state.transactions || []).filter(item => !String(item.id || '').startsWith('bridge-tx-') && !String(item.id || '').startsWith('import:'));
    const priorImportedTransactions = (state.transactions || []).filter(item => String(item.id || '').startsWith('import:'));
    const failedIds = new Set(m.sync.failedTransactionAccountIds || []);
    const preservedBridgeTransactions = priorBridgeTransactions.filter(item => failedIds.has(item.accountId));
    const importedTransactions = importData && Array.isArray(importData.transactions) ? importData.transactions : priorImportedTransactions;
    state.transactions = applyPrivateIncomeRules([...manualTransactions, ...preservedBridgeTransactions, ...m.transactions, ...importedTransactions], privateFinance?.incomeRules || []);
    if (!m.sync.failedEndpoints.includes('recurring')) state.recurring = [...keepLocal(state.recurring, 'bridge-rec-'), ...m.recurring];
    const priorPrivateHoldings = (state.holdings || []).filter(item => String(item.id || '').startsWith('private-investment-'));
    const privateHoldings = privateFinance && Array.isArray(privateFinance.investments?.holdings) ? privateFinance.investments.holdings : priorPrivateHoldings;
    const bridgeHoldings = m.sync.failedEndpoints.includes('holdings') ? (state.holdings || []).filter(item => String(item.id || '').startsWith('bridge-hold-')) : m.holdings;
    state.holdings = [...keepLocal(state.holdings, 'bridge-hold-').filter(item => !String(item.id || '').startsWith('private-investment-')), ...bridgeHoldings, ...privateHoldings];
    if (!m.sync.failedEndpoints.includes('liabilities')) state.liabilities = [...keepLocal(state.liabilities, 'bridge-liab-'), ...m.liabilities];
    // Profiles created before stable bridge IDs used array positions. Preserve
    // those private selections in memory while the durable profile store is
    // migrated separately, without writing financial metadata from the client.
    const migratedProfiles = (Array.isArray(cardProfiles) ? cardProfiles : state.cardProfiles).map(profile => {
      const legacy = String(profile.accountId || '').match(/^bridge-acct-(\d{1,3})$/);
      return legacy && m.accounts[Number(legacy[1])] ? { ...profile, accountId: m.accounts[Number(legacy[1])].id } : profile;
    });
    state.cardProfiles = resolveCardProfileAccounts(state.accounts, migratedProfiles);
    if (Array.isArray(cardProfiles) && JSON.stringify(state.cardProfiles) !== JSON.stringify(migratedProfiles)) {
      fetch('/api/card-profiles', { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(state.cardProfiles) }).catch(() => {});
    }
    if (importData) {
      state.imports = Array.isArray(importData.batches) ? importData.batches : [];
      state.importMappings = importData.mappings && typeof importData.mappings === 'object' ? importData.mappings : {};
      state.importRevision = Math.max(0, Number(importData.revision) || 0);
    }
    if (Array.isArray(renewals)) state.renewalsTracker = renewals;
    if (privateFinance) {
      state.investmentHistory = Array.isArray(privateFinance.investments?.history) ? privateFinance.investments.history : [];
      state.investmentMeta = privateFinance.investments?.meta && typeof privateFinance.investments.meta === 'object' ? privateFinance.investments.meta : {};
    }
    // Additional per-account balance histories, e.g. a brokerage account whose
    // monthly statements were parsed. Plaid supplies no dated history of its
    // own, so without these an account can only ever show a current value.
    if (privateFinance) state.investmentSeries = Array.isArray(privateFinance.investments?.series) ? privateFinance.investments.series : [];
    state.benefits = applyDetectedPerkUsage(mergeCatalogPerks(state.accounts, state.benefits, new Date(), state.cardProfiles), state.transactions);
    state.sync = m.sync;
    state.settings.samplePreview = false;
    persist();
  } catch { /* bridge unreachable: keep current data */ }
}

refreshBridge();
let refreshTimer;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshBridge, 800); }
setInterval(refreshBridge, 90000);
