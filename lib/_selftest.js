'use strict';
// Self-test for lib/select.js. Fixtures live ONLY in this file.
// Run: node lib/_selftest.js
const assert = require('assert');
const sel = require('./select');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; }
}

const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const wp = (monthPnl, monthVlm) => [
  ['day', { pnl: '10.5', roi: '0.01', vlm: '100' }],
  ['week', { pnl: '20', roi: '0.02', vlm: '200' }],
  ['month', { pnl: String(monthPnl), roi: '0.05', vlm: String(monthVlm) }],
  ['allTime', { pnl: '999', roi: '1.5', vlm: '5000' }],
];

t('leaderboard filter: thresholds, HLP, sort, limit, numbers', () => {
  const rows = [
    { ethAddress: addr(1), accountValue: '200000', displayName: 'A', windowPerformances: wp(5000, 1) },
    { ethAddress: addr(2), accountValue: '99999.99', displayName: null, windowPerformances: wp(9e9, 1) }, // too small
    { ethAddress: addr(3), accountValue: '500000', displayName: null, windowPerformances: wp(0, 10) },    // pnl not > 0
    { ethAddress: addr(4), accountValue: '500000', displayName: null, windowPerformances: wp(100, 0) },   // vlm 0
    { ethAddress: '0xDFC24B077BC1425AD1DEA75BCB6F8158E10DF303', accountValue: '1e9', displayName: 'HLP', windowPerformances: wp(1e8, 1e9) },
    { ethAddress: addr(5).toUpperCase().replace('0X', '0x'), accountValue: '100000', displayName: 'B', windowPerformances: wp(7000, 5) },
    { ethAddress: addr(6), accountValue: '300000', displayName: 'C', windowPerformances: wp(6000, 5) },
  ];
  const out = sel.filterLeaderboard(sel.leaderboardRows({ leaderboardRows: rows }), { limit: 2 });
  assert.deepStrictEqual(out.map((r) => r.address), [addr(5), addr(6)]);
  assert.strictEqual(out[0].name, 'B');
  assert.strictEqual(out[0].accountValue, 100000);
  assert.strictEqual(out[0].pnl.day, 10.5);
  assert.strictEqual(typeof out[0].roi.allTime, 'number');
  const all = sel.filterLeaderboard(rows, { exclude: new Set([addr(6)]) });
  assert.deepStrictEqual(all.map((r) => r.address), [addr(5), addr(1)]);
  const ranked = sel.rankWallets(all, 50);
  assert.deepStrictEqual(ranked.map((r) => r.rank), [1, 2]);
});

t('side from szi sign', () => {
  assert.strictEqual(sel.sideFromSzi('1.5'), 'long');
  assert.strictEqual(sel.sideFromSzi('-0.01'), 'short');
  assert.strictEqual(sel.sideFromSzi('0'), null);
});

t('marks + position normalisation (abs size, roe, liq null)', () => {
  const marks = sel.normalizeMarks([
    { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
    [{ markPx: '100000', funding: '0.0000125', openInterest: '10', dayNtlVlm: '1e9', prevDayPx: '99000' },
     { markPx: '3000', funding: '-0.00001', openInterest: '20', dayNtlVlm: '5e8', prevDayPx: '3100' }],
  ]);
  assert.deepStrictEqual(marks.BTC, { mark: 100000, funding: 0.0000125, oi: 10, dayVol: 1e9, prev: 99000 });
  const st = {
    marginSummary: { accountValue: '123' },
    assetPositions: [
      { type: 'oneWay', position: { coin: 'ETH', szi: '-2', entryPx: '3100', positionValue: '6000', unrealizedPnl: '200', liquidationPx: null, leverage: { type: 'cross', value: 10 }, returnOnEquity: '0.33', marginUsed: '600' } },
      { type: 'oneWay', position: { coin: 'BTC', szi: '0.1', entryPx: '95000', positionValue: '10000', unrealizedPnl: '500', liquidationPx: '80000', leverage: { type: 'isolated', value: 5, rawUsd: '-1' }, returnOnEquity: '0.25', marginUsed: '2000' } },
      { type: 'oneWay', position: { coin: 'XYZ', szi: '4', entryPx: '1', positionValue: '-8', unrealizedPnl: '0', liquidationPx: null, leverage: { type: 'cross', value: 3 }, returnOnEquity: '0', marginUsed: '1' } },
    ],
  };
  const ps = sel.normalizePositions(st, marks);
  assert.deepStrictEqual(ps.map((p) => p.coin), ['BTC', 'ETH', 'XYZ']);
  const eth = ps[1];
  assert.strictEqual(eth.side, 'short');
  assert.strictEqual(eth.sizeUsd, 6000);
  assert.strictEqual(eth.szi, -2);
  assert.strictEqual(eth.mark, 3000);
  assert.strictEqual(eth.roe, 0.33);
  assert.strictEqual(eth.liq, null);
  assert.strictEqual(eth.levType, 'cross');
  assert.strictEqual(ps[0].liq, 80000);
  assert.strictEqual(ps[2].sizeUsd, 8);   // abs(positionValue)
  assert.strictEqual(ps[2].mark, 2);      // no mark in meta -> positionValue/|szi|
});

function walletWith(n, positions) { return { address: addr(n), positions }; }
const P = (coin, side, sizeUsd, entry, upnl) => ({ coin, side, sizeUsd, szi: (side === 'long' ? 1 : -1) * sizeUsd / entry, entry, mark: entry, upnl, roe: 0, lev: 1, levType: 'cross', liq: null });

t('clusters: count >= 5, per (coin, side), sorted by count then size', () => {
  const ws = [];
  for (let i = 1; i <= 6; i++) ws.push(walletWith(i, [P('BTC', 'long', 1000 * i, 100000, 10)]));
  for (let i = 7; i <= 11; i++) ws.push(walletWith(i, [P('ETH', 'short', 50000, 3000, -5)]));
  for (let i = 12; i <= 16; i++) ws.push(walletWith(i, [P('SOL', 'short', 100, 200, 1)]));
  for (let i = 17; i <= 20; i++) ws.push(walletWith(i, [P('DOGE', 'long', 1e6, 0.2, 0)])); // only 4
  ws.push(walletWith(21, [P('ETH', 'long', 1e7, 3000, 0)])); // opposite side, not counted with shorts
  ws.push({ address: addr(22), positions: [], error: true });
  const cs = sel.buildClusters(ws, 5);
  assert.deepStrictEqual(cs.map((c) => c.coin + ':' + c.side), ['BTC:long', 'ETH:short', 'SOL:short']);
  assert.ok(!cs.some((c) => c.side === 'long' && c.coin === 'ETH'));
  assert.strictEqual(cs[0].count, 6);
  assert.strictEqual(cs[0].sizeUsd, 21000);
  assert.strictEqual(cs[0].upnl, 60);
  assert.ok(Math.abs(cs[0].avgEntry - 100000) < 1e-6);
  assert.strictEqual(cs[1].count, 5);
  assert.ok(cs[1].sizeUsd > cs[2].sizeUsd);
  assert.strictEqual(cs[0].opens.length, 6);
  assert.strictEqual(cs[0].newestOpenAt, null);
});

t('clusters: side must be >= 2x opposite side on the coin', () => {
  const ws = [];
  // AVAX: 6 short vs 3 long -> short qualifies (6 >= 6); long fails (<5)
  for (let i = 1; i <= 6; i++) ws.push(walletWith(i, [P('AVAX', 'short', 100, 10, 0)]));
  for (let i = 7; i <= 9; i++) ws.push(walletWith(i, [P('AVAX', 'long', 100, 10, 0)]));
  // LINK: 7 short vs 4 long -> 7 < 8, no cluster
  for (let i = 10; i <= 16; i++) ws.push(walletWith(i, [P('LINK', 'short', 100, 10, 0)]));
  for (let i = 17; i <= 20; i++) ws.push(walletWith(i, [P('LINK', 'long', 100, 10, 0)]));
  // ARB: 5 long vs 22 short -> short qualifies, long does not
  for (let i = 21; i <= 25; i++) ws.push(walletWith(i, [P('ARB', 'long', 100, 1, 0)]));
  for (let i = 26; i <= 47; i++) ws.push(walletWith(i, [P('ARB', 'short', 100, 1, 0)]));
  // OP: 5 long vs 5 short -> neither
  for (let i = 48; i <= 52; i++) ws.push(walletWith(i, [P('OP', 'long', 100, 1, 0)]));
  for (let i = 53; i <= 57; i++) ws.push(walletWith(i, [P('OP', 'short', 100, 1, 0)]));
  const cs = sel.buildClusters(ws, 5);
  assert.deepStrictEqual(cs.map((c) => c.coin + ':' + c.side + ':' + c.count), ['ARB:short:22', 'AVAX:short:6']);
  // at most one cluster per coin
  assert.strictEqual(new Set(cs.map((c) => c.coin)).size, cs.length);
});

t('clusters: a wallet with 30 shorts only votes on its 5 biggest', () => {
  const ws = [];
  // wallet 1: 30 shorts, C0 smallest .. C29 biggest -> votes C25..C29 only
  const many = [];
  for (let k = 0; k < 30; k++) many.push(P('C' + k, 'short', 100 + k, 1, 0));
  ws.push(walletWith(1, many));
  // wallets 2..5 short C0 (small for wallet 1) and C29 (top for wallet 1)
  for (let i = 2; i <= 5; i++) ws.push(walletWith(i, [P('C0', 'short', 50, 1, 0), P('C29', 'short', 50, 1, 0)]));
  const cs = sel.buildClusters(ws, 5);
  assert.deepStrictEqual(cs.map((c) => c.coin + ':' + c.side + ':' + c.count), ['C29:short:5']);
  assert.ok(cs[0].wallets.includes(addr(1)));
  assert.deepStrictEqual(sel.votingPositions(many).map((p) => p.coin), ['C29', 'C28', 'C27', 'C26', 'C25']);
  // opposite side uses the same vote set: 5 longs on C1 vs wallet 1's C1 short (not in its top 5) -> long qualifies
  const ws2 = [walletWith(1, many)];
  for (let i = 2; i <= 6; i++) ws2.push(walletWith(i, [P('C1', 'long', 10, 1, 0)]));
  for (let i = 7; i <= 9; i++) ws2.push(walletWith(i, [P('C1', 'short', 10, 1, 0)]));
  // 5 long vs 3 short (wallet 1 not voting on C1) -> 5 < 6, no cluster; with wallet 1 voting it would be 4 short
  assert.deepStrictEqual(sel.buildClusters(ws2, 5).map((c) => c.coin), []);
  ws2.push(walletWith(10, [P('C1', 'long', 10, 1, 0)]));
  assert.deepStrictEqual(sel.buildClusters(ws2, 5).map((c) => c.coin + ':' + c.side + ':' + c.count), ['C1:long:6']);
});

t('clusters: weighted avg entry', () => {
  const ws = [];
  for (let i = 1; i <= 5; i++) ws.push(walletWith(i, [{ coin: 'BTC', side: 'long', sizeUsd: 1, szi: i === 1 ? 3 : 1, entry: i === 1 ? 200 : 100, upnl: 0 }]));
  const c = sel.buildClusters(ws, 5)[0];
  assert.ok(Math.abs(c.avgEntry - (3 * 200 + 4 * 100) / 7) < 1e-9);
});

t('openedAt: Open + startPosition 0 / opposite sign; latest wins; null if none', () => {
  const fills = [
    { coin: 'BTC', dir: 'Open Long', startPosition: '0', time: 1000 },
    { coin: 'BTC', dir: 'Open Long', startPosition: '0.5', time: 1100 },     // add-on, ignored
    { coin: 'BTC', dir: 'Close Long', startPosition: '0.8', time: 1200 },
    { coin: 'BTC', dir: 'Open Long', startPosition: '0.0', time: 1300 },     // re-open: current position
    { coin: 'ETH', dir: 'Open Short', startPosition: '0', time: 5000 },
    { coin: 'BTC', dir: 'Open Short', startPosition: '0', time: 9000 },      // wrong side
  ];
  assert.strictEqual(sel.openedAtFromFills(fills, 'BTC', 'long'), 1300);
  assert.strictEqual(sel.openedAtFromFills(fills, 'ETH', 'short'), 5000);
  assert.strictEqual(sel.openedAtFromFills(fills, 'SOL', 'long'), null);
  assert.strictEqual(sel.openedAtFromFills([{ coin: 'BTC', dir: 'Open Long', startPosition: '0.3', time: 1 }], 'BTC', 'long'), null);
  // flip from short to long
  assert.strictEqual(sel.openedAtFromFills([{ coin: 'BTC', dir: 'Short > Long', startPosition: '-1', time: 77 }], 'BTC', 'long'), 77);
  // Open Long with negative startPosition counts as opposite sign
  assert.strictEqual(sel.openedAtFromFills([{ coin: 'BTC', dir: 'Open Long', startPosition: '-2', time: 88 }], 'BTC', 'long'), 88);
  assert.strictEqual(sel.openedAtFromFills(null, 'BTC', 'long'), null);
});

t('attachOpens sets opens + newestOpenAt, null when fills missing', () => {
  const ws = [];
  for (let i = 1; i <= 5; i++) ws.push(walletWith(i, [P('BTC', 'long', 10, 100, 0)]));
  const cs = sel.buildClusters(ws, 5);
  const fills = {};
  fills[addr(1)] = [{ coin: 'BTC', dir: 'Open Long', startPosition: '0', time: 500 }];
  fills[addr(2)] = [{ coin: 'BTC', dir: 'Open Long', startPosition: '0', time: 900 }];
  fills[addr(3)] = [];
  sel.attachOpens(cs, fills);
  assert.deepStrictEqual(cs[0].opens.map((o) => o.openedAt), [500, 900, null, null, null]);
  assert.strictEqual(cs[0].newestOpenAt, 900);
});

t('fills + portfolio normalisation, address check', () => {
  const f = sel.normalizeFill({ coin: 'BTC', px: '1', sz: '2', side: 'B', time: 3, startPosition: '0', dir: 'Open Long', closedPnl: '0.0' });
  assert.deepStrictEqual(f, { coin: 'BTC', px: 1, sz: 2, side: 'buy', time: 3, startPosition: 0, dir: 'Open Long', closedPnl: 0 });
  const pf = sel.normalizePortfolio([['day', { accountValueHistory: [[1, '10']], pnlHistory: [[1, '-1']], vlm: '5' }]]);
  assert.deepStrictEqual(pf.day, { accountValue: [[1, 10]], pnl: [[1, -1]], vlm: 5 });
  assert.ok(sel.isAddress(addr(5)));
  assert.ok(!sel.isAddress('0x123'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
