import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDetectedPerkUsage, catalogCoverage, mergeCatalogPerks, perksForAccount, resolveCardProfileAccounts } from '../src/card-perks.js';

const now = new Date('2026-08-15T12:00:00Z');
const gold = { id: 'gold', name: 'American Express Gold Card', kind: 'credit' };
const platinum = { id: 'plat', name: 'Platinum Card®', kind: 'credit' };
const delta = { id: 'delta', name: 'Delta SkyMiles Platinum Card', kind: 'credit' };
const venture = { id: 'venture', name: 'Capital One Venture Rewards', kind: 'credit' };
const generic = { id: 'visa', name: 'Visa Classic', kind: 'credit' };

test('matches exact products and prefers a co-brand over a generic Platinum match', () => {
  assert.equal(perksForAccount(gold, now).length, 4);
  assert.equal(perksForAccount(platinum, now).length, 11);
  assert.equal(perksForAccount(delta, now).length, 4);
  assert.match(perksForAccount(delta, now)[0].cardLabel, /Delta/);
  assert.equal(perksForAccount(venture, now)[0].amount, 120);
  assert.equal(perksForAccount(venture, now)[0].periodEnd, '');
  assert.equal(perksForAccount(generic, now).length, 0);
  assert.deepEqual(catalogCoverage([gold, platinum, generic]), { creditCards: 3, matchedCards: 2, unmatchedCards: ['Visa Classic'] });
});

test('private selections support two owners with the same card without collisions', () => {
  const selected = [
    { owner: 'Owner A', profile: 'amex-platinum' },
    { owner: 'Owner B', profile: 'amex-platinum' },
    { owner: 'Owner B', profile: 'citi-aadvantage-platinum-select' },
  ];
  const merged = mergeCatalogPerks([], [], now, selected);
  assert.equal(merged.length, 26);
  assert.equal(new Set(merged.map(item => item.id)).size, merged.length);
  assert.ok(merged.some(item => item.cardLabel === 'Owner A · American Express Platinum Card'));
  assert.ok(merged.some(item => item.name === '$125 American Airlines Flight Discount'));
  assert.deepEqual(catalogCoverage([], selected), { creditCards: 3, matchedCards: 0, unmatchedCards: ['Owner A · American Express Platinum Card', 'Owner B · American Express Platinum Card', 'Owner B · Citi / AAdvantage Platinum Select'] });
});

test('a unique saved product auto-links to one matching connected account', () => {
  const selected = [
    { owner: 'Owner A', profile: 'capital-one-venture' },
    { owner: 'Owner A', profile: 'chase-freedom-flex' },
  ];
  assert.deepEqual(resolveCardProfileAccounts([venture], selected), [
    { owner: 'Owner A', profile: 'capital-one-venture', accountId: 'venture' },
    { owner: 'Owner A', profile: 'chase-freedom-flex', accountId: '' },
  ]);
});

test('two household profiles never auto-claim the same connected account', () => {
  const selected = [
    { owner: 'Owner A', profile: 'amex-platinum' },
    { owner: 'Owner B', profile: 'amex-platinum' },
  ];
  assert.deepEqual(resolveCardProfileAccounts([platinum], selected), [
    { owner: 'Owner A', profile: 'amex-platinum', accountId: '' },
    { owner: 'Owner B', profile: 'amex-platinum', accountId: '' },
  ]);
});

test('an unlinked household profile never borrows another owners connected card activity', () => {
  const selected = [
    { owner: 'Owner A', profile: 'amex-platinum', accountId: 'plat' },
    { owner: 'Owner B', profile: 'amex-platinum', accountId: '' },
  ];
  const catalog = mergeCatalogPerks([platinum], [], now, selected);
  const tracked = applyDetectedPerkUsage(catalog, [
    { accountId: 'plat', date: '2026-07-03', rawName: 'Platinum Resy Credit', amount: 100, pending: false },
  ]).filter(item => item.perkSlug === 'resy');
  assert.deepEqual(tracked.map(item => item.detectionCount), [1, 0]);
});

test('merges official presets without losing manually tracked usage', () => {
  const selected = [{ owner: 'Owner A', profile: 'amex-gold', accountId: 'gold' }];
  const first = mergeCatalogPerks([gold], [], now, selected);
  const dining = first.find(item => item.id.endsWith('-dining'));
  dining.usedAmount = 6;
  const second = mergeCatalogPerks([gold], first, now, selected);
  assert.equal(second.length, first.length);
  assert.equal(second.find(item => item.id === dining.id).usedAmount, 6);
  assert.equal(second.find(item => item.id === dining.id).accountId, 'gold');
});

test('migrates one legacy catalog tracker and removes stale generated rows', () => {
  const selected = [
    { owner: 'Owner A', profile: 'amex-gold' },
    { owner: 'Owner B', profile: 'amex-gold' },
  ];
  const prior = [
    { id: 'catalog-amex-gold-dining', usedAmount: 8, name: 'old generated row' },
    { id: 'catalog-retired-product-credit', usedAmount: 1 },
    { id: 'manual-benefit', name: 'Keep me', amount: 20, usedAmount: 2 },
  ];
  const merged = mergeCatalogPerks([], prior, now, selected);
  assert.equal(merged.filter(item => item.name === 'Dining Credit' && item.usedAmount === 8).length, 1);
  assert.ok(merged.some(item => item.id === 'manual-benefit'));
  assert.ok(!merged.some(item => item.id === 'catalog-retired-product-credit'));
});

test('detects posted Platinum issuer credits only for the same card and current benefit period', () => {
  const selected = [{ owner: 'Owner A', profile: 'amex-platinum', accountId: 'plat' }];
  const catalog = mergeCatalogPerks([platinum], [], now, selected);
  const transactions = [
    { id: 'q3-resy', accountId: 'plat', date: '2026-07-03', payee: 'Platinum Resy Credit', amount: 100, pending: false },
    { id: 'q2-resy', accountId: 'plat', date: '2026-06-12', payee: 'Platinum Resy Credit', amount: 100, pending: false },
    { id: 'july-ent', accountId: 'plat', date: '2026-07-20', originalName: 'Platinum Digital Entertainment Credit', amount: 25, pending: false },
    { id: 'purchase', accountId: 'plat', date: '2026-08-10', payee: 'Eligible restaurant', amount: -80, pending: false },
    { id: 'other-card', accountId: 'other', date: '2026-08-02', payee: 'Platinum Resy Credit', amount: 100, pending: false },
    { id: 'pending', accountId: 'plat', date: '2026-08-03', payee: 'Platinum Digital Entertainment Credit', amount: 25, pending: true },
  ];
  const tracked = applyDetectedPerkUsage(catalog, transactions);
  const resy = tracked.find(item => item.perkSlug === 'resy');
  const entertainment = tracked.find(item => item.perkSlug === 'entertainment');
  assert.equal(resy.detectedUsedAmount, 100);
  assert.equal(resy.detectionCount, 1);
  assert.equal(entertainment.detectedUsedAmount, 0);
  assert.equal(entertainment.lastObservedCreditAt, '2026-07-20');
  assert.equal(entertainment.lastObservedCreditAmount, 25);
});

test('manual usage overrides rather than double-counting an automatically detected credit', () => {
  const selected = [{ owner: 'Owner A', profile: 'amex-platinum', accountId: 'plat' }];
  const catalog = mergeCatalogPerks([platinum], [], now, selected);
  const resy = catalog.find(item => item.perkSlug === 'resy');
  resy.manualUsedAmount = 100;
  const tracked = applyDetectedPerkUsage(catalog, [
    { accountId: 'plat', date: '2026-07-03', payee: 'Platinum Resy Credit', amount: 100, pending: false },
  ]);
  assert.equal(tracked.find(item => item.perkSlug === 'resy').usedAmount, 100);
});

test('caps display usage, flags an issuer-credit overage, and resets manual usage after rollover', () => {
  const selected = [{ owner: 'Owner A', profile: 'amex-platinum', accountId: 'plat' }];
  const july = new Date('2026-07-15T12:00:00Z');
  const catalog = mergeCatalogPerks([platinum], [], july, selected);
  const walmart = catalog.find(item => item.perkSlug === 'walmart');
  const tracked = applyDetectedPerkUsage(catalog, [
    { accountId: 'plat', date: '2026-07-13', rawName: 'Platinum Walmart+ Credit', amount: 14.03, pending: false },
  ]).find(item => item.perkSlug === 'walmart');
  assert.equal(tracked.usedAmount, 12.95);
  assert.equal(tracked.detectedUsedAmount, 14.03);
  assert.equal(tracked.capExceeded, true);
  walmart.manualUsedAmount = 12.95;
  walmart.manualPeriodStart = '2026-07-01';
  const august = mergeCatalogPerks([platinum], catalog, now, selected).find(item => item.perkSlug === 'walmart');
  assert.equal(august.manualUsedAmount, 0);
});
