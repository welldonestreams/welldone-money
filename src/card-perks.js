const SOURCES = {
  amexGold: 'https://www.americanexpress.com/en-us/account/get-started/gold/explore-benefits',
  amexPlatinum: 'https://www.americanexpress.com/us/credit-cards/card/platinum/',
  deltaPlatinum: 'https://www.americanexpress.com/us/credit-cards/card/delta-skymiles-platinum-american-express-card/',
  sapphireReserve: 'https://creditcards.chase.com/rewards-credit-cards/sapphire/reserve',
  sapphirePreferred: 'https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred',
  freedomFlex: 'https://creditcards.chase.com/cash-back-credit-cards/freedom/flex',
  freedomUnlimited: 'https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited',
  venture: 'https://www.capitalone.com/credit-cards/venture/',
  biltPalladium: 'https://www.bilt.com/card/palladium',
  customCash: 'https://www.citi.com/credit-cards/citi-custom-cash-credit-card',
  appleCard: 'https://www.apple.com/apple-card/',
  citiAadvantagePlatinum: 'https://www.citi.com/credit-cards/credit-card-miles/aadvantage-platinum-select-benefits',
};

function period(cadence, now = new Date()) {
  if (!['monthly', 'quarterly', 'semiannual', 'annual'].includes(cadence)) return { periodStart: '', periodEnd: '' };
  const year = now.getFullYear();
  const month = now.getMonth();
  let startMonth = 0;
  let endMonth = 11;
  if (cadence === 'monthly') startMonth = endMonth = month;
  if (cadence === 'quarterly') { startMonth = Math.floor(month / 3) * 3; endMonth = startMonth + 2; }
  if (cadence === 'semiannual') { startMonth = month < 6 ? 0 : 6; endMonth = startMonth + 5; }
  return { periodStart: new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10), periodEnd: new Date(Date.UTC(year, endMonth + 1, 0)).toISOString().slice(0, 10) };
}

function perk(slug, name, amount, cadence, notes, sourceUrl, now, enrollmentRequired = false) {
  return { id: slug, name, amount, usedAmount: 0, cadence, enrollmentRequired, enrolled: false, sourceUrl, notes, ...period(cadence, now) };
}

// Only explicit issuer reimbursements count as automatic usage. Eligible
// purchases alone are not proof that a statement credit posted.
const issuerCreditRules = {
  'amex-platinum': {
    resy: [/platinum\s+resy\s+credit/i],
    entertainment: [/platinum\s+digital\s+entertainment\s+credit/i],
    lululemon: [/platinum\s+lululemon\s+credit/i],
    walmart: [/platinum\s+walmart\+?\s+credit/i],
    clear: [/(?:amex|platinum)\s+clear(?:\s+plus|\+)?\s+credit/i],
  },
};

function transactionText(transaction) {
  return [transaction?.rawName, transaction?.statementPayee, transaction?.payee, transaction?.originalName, transaction?.name, transaction?.description]
    .map(value => String(value || '').trim()).filter(Boolean).join(' | ');
}

export function applyDetectedPerkUsage(benefits, transactions) {
  const ledger = Array.isArray(transactions) ? transactions : [];
  return (benefits || []).map(benefit => {
    const manualPeriodStart = String(benefit.manualPeriodStart || benefit.periodStart || '');
    const manualUsedAmount = manualPeriodStart === String(benefit.periodStart || '')
      ? Math.max(0, Number(benefit.manualUsedAmount ?? benefit.usedAmount) || 0)
      : 0;
    const rules = issuerCreditRules[benefit.profile]?.[benefit.perkSlug] || [];
    const allMatches = rules.length && benefit.accountId ? ledger.filter(transaction => {
      const amount = Number(transaction.amount) || 0;
      return transaction.accountId === benefit.accountId
        && amount > 0
        && !transaction.pending
        && rules.some(rule => rule.test(transactionText(transaction)));
    }) : [];
    const matches = allMatches.filter(transaction => {
      const date = String(transaction.date || '').slice(0, 10);
      return (!benefit.periodStart || date >= benefit.periodStart)
        && (!benefit.periodEnd || date <= benefit.periodEnd);
    });
    const latestObserved = allMatches.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
    const detectedUsedAmount = matches.reduce((sum, transaction) => sum + Math.max(0, Number(transaction.amount) || 0), 0);
    const cap = Math.max(0, Number(benefit.amount) || 0);
    const detectedWithinCap = cap ? Math.min(cap, detectedUsedAmount) : detectedUsedAmount;
    return {
      ...benefit,
      manualUsedAmount,
      detectedUsedAmount,
      capExceeded: cap > 0 && detectedUsedAmount > cap,
      detectionCount: matches.length,
      lastDetectedAt: matches.map(item => String(item.date || '').slice(0, 10)).sort().at(-1) || '',
      lastObservedCreditAt: String(latestObserved?.date || '').slice(0, 10),
      lastObservedCreditAmount: Math.max(0, Number(latestObserved?.amount) || 0),
      // A manual correction is an override, not an amount to add to the same
      // issuer credit. Taking the maximum prevents double counting.
      usedAmount: Math.max(manualUsedAmount, detectedWithinCap),
    };
  });
}

const profiles = {
  'amex-gold': { label: 'American Express Gold Card', match: ['american express gold', 'amex gold'], perks: now => [
    perk('dining', 'Dining Credit', 10, 'monthly', 'Up to $10 monthly at eligible partners.', SOURCES.amexGold, now, true),
    perk('uber', 'Uber Cash', 10, 'monthly', 'Up to $10 monthly for eligible U.S. rides or orders.', SOURCES.amexGold, now),
    perk('dunkin', 'Dunkin’ Credit', 7, 'monthly', 'Up to $7 monthly at eligible U.S. Dunkin’ locations.', SOURCES.amexGold, now, true),
    perk('resy', 'Resy Credit', 50, 'semiannual', 'Up to $50 January–June and $50 July–December.', SOURCES.amexGold, now, true),
  ] },
  'amex-platinum': { label: 'American Express Platinum Card', match: ['platinum card'], perks: now => [
    perk('hotel', 'Hotel Credit', 300, 'semiannual', 'Eligible prepaid Fine Hotels + Resorts or The Hotel Collection bookings.', SOURCES.amexPlatinum, now),
    perk('resy', 'Resy Credit', 100, 'quarterly', 'Eligible U.S. Resy restaurant purchases.', SOURCES.amexPlatinum, now, true),
    perk('entertainment', 'Digital Entertainment Credit', 25, 'monthly', 'Eligible participating digital-entertainment partners.', SOURCES.amexPlatinum, now, true),
    perk('lululemon', 'lululemon Credit', 75, 'quarterly', 'Eligible U.S. lululemon purchases.', SOURCES.amexPlatinum, now, true),
    perk('walmart', 'Walmart+ Credit', 12.95, 'monthly', 'One eligible monthly Walmart+ membership.', SOURCES.amexPlatinum, now),
    perk('oura', 'Oura Ring Credit', 200, 'annual', 'Eligible Oura Ring purchase.', SOURCES.amexPlatinum, now, true),
    perk('equinox', 'Equinox Credit', 300, 'annual', 'Eligible Equinox membership charges.', SOURCES.amexPlatinum, now, true),
    perk('clear', 'CLEAR+ Credit', 219, 'annual', 'Eligible CLEAR+ membership.', SOURCES.amexPlatinum, now),
    perk('uber-cash', 'Uber Cash', now.getMonth() === 11 ? 35 : 15, 'monthly', '$15 monthly plus an additional $20 in December.', SOURCES.amexPlatinum, now),
    perk('uber-one', 'Uber One Credit', 120, 'annual', 'Eligible auto-renewing Uber One membership.', SOURCES.amexPlatinum, now),
    perk('airline', 'Airline Fee Credit', 200, 'annual', 'Incidental fees with one selected qualifying airline.', SOURCES.amexPlatinum, now),
  ] },
  'amex-delta-platinum': { label: 'Delta SkyMiles Platinum Amex', match: ['delta skymiles platinum', 'delta platinum'], perks: now => [
    perk('resy', 'Resy Credit', 10, 'monthly', 'Eligible U.S. Resy restaurant purchases.', SOURCES.deltaPlatinum, now, true),
    perk('rideshare', 'Rideshare Credit', 10, 'monthly', 'Eligible U.S. rideshare purchases.', SOURCES.deltaPlatinum, now, true),
    perk('delta-stays', 'Delta Stays Credit', 150, 'annual', 'Eligible prepaid hotels or vacation rentals through Delta Stays.', SOURCES.deltaPlatinum, now),
    perk('companion', 'Annual Companion Certificate', 0, 'annual', 'Issued after renewal; taxes, fees, routes, and fare restrictions apply.', SOURCES.deltaPlatinum, now),
  ] },
  'chase-sapphire-reserve': { label: 'Chase Sapphire Reserve', match: ['sapphire reserve'], perks: now => [
    perk('travel', 'Annual Travel Credit', 300, 'annual', 'Eligible travel-category purchases; resets by account anniversary.', SOURCES.sapphireReserve, now),
    perk('edit-hotels', 'The Edit Hotel Credit', 250, 'semiannual', 'Eligible prepaid two-night stays through The Edit by Chase Travel.', SOURCES.sapphireReserve, now),
    perk('dining', 'Exclusive Tables Dining Credit', 150, 'semiannual', 'Eligible restaurants in the Sapphire Reserve Exclusive Tables program.', SOURCES.sapphireReserve, now),
    perk('stubhub', 'StubHub Credit', 150, 'semiannual', 'Eligible StubHub and viagogo purchases through 2027.', SOURCES.sapphireReserve, now, true),
    perk('doordash', 'DoorDash Promos', 25, 'monthly', 'One $5 restaurant promo and two $10 non-restaurant promos through 2027.', SOURCES.sapphireReserve, now),
    perk('lyft', 'Lyft Credit', 10, 'monthly', 'Eligible Lyft rides through September 2027.', SOURCES.sapphireReserve, now),
    perk('peloton', 'Peloton Credit', 10, 'monthly', 'Eligible Peloton memberships through 2027.', SOURCES.sapphireReserve, now, true),
    perk('apple', 'Apple TV and Apple Music', 0, 'annual', 'Complimentary subscriptions currently stated through June 2027.', SOURCES.sapphireReserve, now),
    perk('dashpass', 'DashPass Membership', 0, 'annual', 'Complimentary membership after activation, subject to offer dates.', SOURCES.sapphireReserve, now, true),
  ] },
  'chase-sapphire-preferred': { label: 'Chase Sapphire Preferred', match: ['sapphire preferred'], perks: now => [
    perk('hotel', 'Chase Travel Hotel Credit', 100, 'annual', 'Eligible hotel stays purchased through Chase Travel; account-anniversary reset.', SOURCES.sapphirePreferred, now),
    perk('doordash', 'DoorDash Promo', 10, 'monthly', 'Eligible non-restaurant DoorDash orders while the current offer remains active.', SOURCES.sapphirePreferred, now),
    perk('apple-tv', 'Apple TV', 0, 'annual', 'Complimentary one-year subscription subject to activation deadline.', SOURCES.sapphirePreferred, now, true),
    perk('dashpass', 'DashPass Membership', 0, 'annual', 'Complimentary membership subject to activation deadline.', SOURCES.sapphirePreferred, now, true),
  ] },
  'chase-freedom-flex': { label: 'Chase Freedom Flex', match: ['freedom flex'], perks: now => [
    perk('doordash', 'DoorDash Promo', 10, 'quarterly', 'Eligible non-restaurant DoorDash order while the current offer remains active.', SOURCES.freedomFlex, now),
    perk('dashpass', 'DashPass Trial', 0, 'annual', 'Six complimentary months when activated by the stated deadline.', SOURCES.freedomFlex, now, true),
    perk('quarterly', '5% Quarterly Categories', 0, 'quarterly', 'Activation required; issuer spending cap applies.', SOURCES.freedomFlex, now, true),
  ] },
  'chase-freedom-unlimited': { label: 'Chase Freedom Unlimited', match: ['freedom unlimited'], perks: now => [
    perk('doordash', 'DoorDash Promo', 10, 'quarterly', 'Eligible non-restaurant DoorDash order while the current offer remains active.', SOURCES.freedomUnlimited, now),
    perk('dashpass', 'DashPass Trial', 0, 'annual', 'Six complimentary months when activated by the stated deadline.', SOURCES.freedomUnlimited, now, true),
  ] },
  'capital-one-venture': { label: 'Capital One Venture', match: ['capital one venture', 'venture rewards'], perks: now => [
    perk('trusted-traveler', 'Global Entry or TSA PreCheck Credit', 120, 'multi-year', 'Up to $120 for one eligible application fee; eligibility interval applies.', SOURCES.venture, now),
    perk('lifestyle-collection', 'Lifestyle Collection Experience Credit', 0, 'per-stay', 'Up to $50 toward eligible experiences on each qualifying Lifestyle Collection stay.', SOURCES.venture, now),
    perk('hertz-status', 'Hertz Five Star Status', 0, 'annual', 'Complimentary status for eligible cardholders; enrollment and rental-program terms apply.', SOURCES.venture, now, true),
  ] },
  'bilt-palladium': { label: 'Bilt Palladium', match: ['bilt palladium', 'palladium'], perks: now => [
    perk('bilt-cash', 'Bilt Cash', 200, 'annual', 'Deposited annually; expiration and rollover limits apply.', SOURCES.biltPalladium, now),
    perk('hotel', 'Bilt Travel Hotel Credit', 200, 'semiannual', 'Eligible two-night hotel bookings through Bilt Travel.', SOURCES.biltPalladium, now),
    perk('priority-pass', 'Priority Pass', 0, 'annual', 'Airport-lounge membership; enrollment and access terms apply.', SOURCES.biltPalladium, now),
  ] },
  'citi-custom-cash': { label: 'Citi Custom Cash', match: ['custom cash'], perks: now => [
    perk('top-category', '5% Top Eligible Category', 0, 'monthly', 'Automatic on the highest eligible spend category up to the issuer’s monthly cap.', SOURCES.customCash, now),
  ] },
  'apple-card': { label: 'Apple Card', match: ['apple card'], perks: now => [
    perk('daily-cash', 'Daily Cash', 0, 'monthly', 'Unlimited cash back with rate determined by merchant and payment method.', SOURCES.appleCard, now),
    perk('uber-one', 'Uber One Trial', 0, 'annual', 'Six-month trial subject to the current Apple Card partner offer.', SOURCES.appleCard, now),
  ] },
  'citi-aadvantage-platinum-select': { label: 'Citi / AAdvantage Platinum Select', match: ['aadvantage platinum select', 'aadvantage platinum'], perks: now => [
    perk('flight-discount', '$125 American Airlines Flight Discount', 125, 'annual', 'Requires $20,000 in eligible purchases during the cardmembership year and renewal of the card.', SOURCES.citiAadvantagePlatinum, now),
    perk('checked-bag', 'First Checked Bag Free', 0, 'annual', 'For the primary cardmember and up to four companions on eligible domestic American Airlines itineraries.', SOURCES.citiAadvantagePlatinum, now),
    perk('preferred-boarding', 'Preferred Boarding', 0, 'annual', 'For the primary cardmember and up to four companions on eligible American Airlines itineraries.', SOURCES.citiAadvantagePlatinum, now),
    perk('inflight-savings', '25% Inflight Savings', 0, 'annual', 'Savings on eligible inflight food and beverage purchases on American Airlines flights.', SOURCES.citiAadvantagePlatinum, now),
  ] },
};

function slug(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'owner'; }
function profileForAccount(account) {
  const label = `${account.name || ''} ${account.officialName || ''}`.toLowerCase();
  return Object.entries(profiles)
    .map(entry => ({ entry, specificity: Math.max(0, ...entry[1].match.filter(term => label.includes(term)).map(term => term.length)) }))
    .filter(hit => hit.specificity > 0)
    .sort((a, b) => b.specificity - a.specificity)[0]?.entry;
}

export function cardProfileLabel(profile) {
  return profiles[profile]?.label || String(profile || '').replace(/-/g, ' ');
}

export function resolveCardProfileAccounts(accounts, selectedProfiles = []) {
  const creditAccounts = (accounts || []).filter(account => account.kind === 'credit');
  const counts = new Map();
  for (const selection of selectedProfiles) counts.set(selection.profile, (counts.get(selection.profile) || 0) + 1);
  const claimed = new Set(selectedProfiles.map(item => item.accountId).filter(id => creditAccounts.some(account => account.id === id)));
  return selectedProfiles.map(selection => {
    if (selection.accountId && creditAccounts.some(account => account.id === selection.accountId)) return selection;
    // Only auto-link an unambiguous household profile. If two people own the
    // same product, the owner must choose which connected account belongs to
    // whom instead of silently borrowing the other person's activity.
    if (counts.get(selection.profile) !== 1) return { ...selection, accountId: '' };
    const candidates = creditAccounts.filter(account => profileForAccount(account)?.[0] === selection.profile && !claimed.has(account.id));
    if (candidates.length !== 1) return { ...selection, accountId: '' };
    claimed.add(candidates[0].id);
    return { ...selection, accountId: candidates[0].id };
  });
}

export function perksForAccount(account, now = new Date()) {
  const hit = profileForAccount(account);
  return hit ? hit[1].perks(now).map(item => ({ ...item, id: `catalog-${hit[0]}-${item.id}`, cardLabel: hit[1].label })) : [];
}

export function mergeCatalogPerks(accounts, benefits, now = new Date(), selectedProfiles = []) {
  const existing = new Map((benefits || []).map(item => [item.id, item]));
  const claimedLegacy = new Set();
  const selected = selectedProfiles.length ? selectedProfiles : (accounts || []).map(account => {
    const hit = profileForAccount(account);
    return hit ? { profile: hit[0], owner: '', accountId: account.id } : null;
  }).filter(Boolean);
  const catalog = [];
  selected.forEach((selection, index) => {
    const profile = profiles[selection.profile];
    if (!profile) return;
    // Private selections may include two household members with the same card.
    // Never borrow another profile's matching account when this selection is
    // not explicitly linked; that would duplicate observed usage.
    const account = selection.accountId
      ? (accounts || []).find(item => item.id === selection.accountId)
      : (!selectedProfiles.length ? (accounts || []).find(item => profile.match.some(term => `${item.name || ''}`.toLowerCase().includes(term))) : null);
    const instance = `${slug(selection.owner || selection.accountId || index)}-${selection.profile}`;
    for (const template of profile.perks(now)) {
      const id = `catalog-${instance}-${template.id}`;
      const legacyId = `catalog-${selection.profile}-${template.id}`;
      const prior = existing.get(id) || (!claimedLegacy.has(legacyId) ? existing.get(legacyId) : null) || {};
      const sameManualPeriod = String(prior.manualPeriodStart || prior.periodStart || template.periodStart) === template.periodStart;
      const manualUsedAmount = sameManualPeriod
        ? Math.max(0, Number(prior.detectedUsedAmount ? (prior.manualUsedAmount ?? 0) : Math.max(Number(prior.manualUsedAmount) || 0, Number(prior.usedAmount) || 0)) || 0)
        : 0;
      const usage = { usedAmount: manualUsedAmount, manualUsedAmount, manualPeriodStart: template.periodStart, enrolled: Boolean(prior.enrolled) };
      if (existing.has(legacyId) && !existing.has(id)) claimedLegacy.add(legacyId);
      catalog.push({ ...template, ...usage, id, profile: selection.profile, perkSlug: template.id, accountId: account?.id || '', cardLabel: `${selection.owner ? `${selection.owner} · ` : ''}${profile.label}` });
      existing.delete(id);
      existing.delete(legacyId);
    }
  });
  const manual = [...existing.values()].filter(item => !String(item.id || '').startsWith('catalog-'));
  return [...manual, ...catalog];
}

export function catalogCoverage(accounts, selectedProfiles = []) {
  const credit = (accounts || []).filter(account => account.kind === 'credit');
  const matchedAccounts = credit.filter(account => profileForAccount(account));
  const accountIds = new Set(credit.map(account => account.id));
  const unlinkedProfiles = selectedProfiles.filter(item => !profiles[item.profile] || !item.accountId || !accountIds.has(item.accountId))
    .map(item => `${item.owner ? `${item.owner} · ` : ''}${cardProfileLabel(item.profile)}`);
  return { creditCards: selectedProfiles.length || credit.length, matchedCards: selectedProfiles.length ? selectedProfiles.length - unlinkedProfiles.length : matchedAccounts.length, unmatchedCards: selectedProfiles.length ? unlinkedProfiles : credit.filter(account => !profileForAccount(account)).map(account => account.name) };
}
