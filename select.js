'use strict';
// Pure functions: leaderboard filtering, position normalisation, clusters,
// openedAt from fills. No I/O here.

const HLP_ADDRESS = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const WINDOWS = ['day', 'week', 'month', 'allTime'];

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function num0(v) { const n = num(v); return n === null ? 0 : n; }

// [["day",{pnl,roi,vlm}],...] -> {day:{pnl,roi,vlm},...}
function parseWindows(wp) {
  const out = {};
  for (const w of WINDOWS) out[w] = { pnl: 0, roi: 0, vlm: 0 };
  if (!Array.isArray(wp)) return out;
  for (const pair of wp) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [name, perf] = pair;
    if (!WINDOWS.includes(name) || !perf) continue;
    out[name] = { pnl: num0(perf.pnl), roi: num0(perf.roi), vlm: num0(perf.vlm) };
  }
  return out;
}

// Accepts the raw leaderboard JSON ({leaderboardRows:[...]} or a bare array).
function leaderboardRows(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.leaderboardRows)) return json.leaderboardRows;
  if (json && Array.isArray(json.rows)) return json.rows;
  return [];
}

// Filter + sort leaderboard. Returns at most `limit` normalised candidates.
// opts: {minAccountValue=100000, limit=60, exclude:Set<lowercase address>}
function filterLeaderboard(rows, opts) {
  const o = Object.assign({ minAccountValue: 100000, limit: 60, exclude: null }, opts || {});
  const exclude = o.exclude || new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r || typeof r.ethAddress !== 'string') continue;
    const address = r.ethAddress.toLowerCase();
    if (address === HLP_ADDRESS || exclude.has(address)) continue;
    const accountValue = num0(r.accountValue);
    if (accountValue < o.minAccountValue) continue;
    const w = parseWindows(r.windowPerformances);
    if (!(w.month.pnl > 0) || !(w.month.vlm > 0)) continue;
    out.push({
      address,
      name: r.displayName || null,
      accountValue,
      pnl: { day: w.day.pnl, week: w.week.pnl, month: w.month.pnl, allTime: w.allTime.pnl },
      roi: { day: w.day.roi, week: w.week.roi, month: w.month.roi, allTime: w.allTime.roi },
    });
  }
  out.sort((a, b) => b.pnl.month - a.pnl.month);
  return out.slice(0, o.limit);
}

// Assign ranks 1..n after vault removal.
function rankWallets(list, n) {
  return list.slice(0, n).map((w, i) => Object.assign({ rank: i + 1 }, w));
}

function sideFromSzi(szi) {
  const s = num0(szi);
  if (s > 0) return 'long';
  if (s < 0) return 'short';
  return null;
}

// metaAndAssetCtxs -> {COIN:{mark,funding,oi,dayVol,prev}}
function normalizeMarks(json) {
  const marks = {};
  if (!Array.isArray(json) || json.length < 2) return marks;
  const universe = (json[0] && json[0].universe) || [];
  const ctxs = json[1] || [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const c = ctxs[i];
    if (!u || !u.name || !c) continue;
    marks[u.name] = {
      mark: num(c.markPx),
      funding: num(c.funding),
      oi: num(c.openInterest),
      dayVol: num(c.dayNtlVlm),
      prev: num(c.prevDayPx),
    };
  }
  return marks;
}

// One assetPositions[] entry -> contract position (or null if flat).
function normalizePosition(ap, marks) {
  const p = ap && (ap.position || ap);
  if (!p || !p.coin) return null;
  const szi = num0(p.szi);
  const side = sideFromSzi(szi);
  if (!side) return null;
  const positionValue = num0(p.positionValue);
  const sizeUsd = Math.abs(positionValue);
  const m = marks && marks[p.coin];
  let mark = m && m.mark !== null && m.mark !== undefined ? m.mark : null;
  if (mark === null && szi !== 0) mark = sizeUsd / Math.abs(szi);
  const lev = p.leverage || {};
  return {
    coin: p.coin,
    side,
    sizeUsd,
    szi,
    entry: num(p.entryPx),
    mark,
    upnl: num0(p.unrealizedPnl),
    roe: num0(p.returnOnEquity),
    lev: num(lev.value),
    levType: lev.type || null,
    liq: num(p.liquidationPx),
  };
}

function normalizePositions(clearinghouseState, marks) {
  const aps = (clearinghouseState && clearinghouseState.assetPositions) || [];
  const out = [];
  for (const ap of aps) {
    const p = normalizePosition(ap, marks);
    if (p) out.push(p);
  }
  out.sort((a, b) => b.sizeUsd - a.sizeUsd);
  return out;
}

// wallets: [{address, positions:[...]}] -> clusters with count >= minCount.
// opens/newestOpenAt are filled later by attachOpens().
function buildClusters(wallets, minCount) {
  const min = minCount || 5;
  const groups = new Map();
  for (const w of wallets || []) {
    if (!w || !Array.isArray(w.positions)) continue;
    const seen = new Set();
    for (const p of w.positions) {
      if (!p || !p.side) continue;
      const key = p.coin + '|' + p.side;
      if (seen.has(key)) continue; // one vote per wallet per (coin, side)
      seen.add(key);
      let g = groups.get(key);
      if (!g) { g = { coin: p.coin, side: p.side, items: [] }; groups.set(key, g); }
      g.items.push({ address: w.address, p });
    }
  }
  const clusters = [];
  for (const g of groups.values()) {
    if (g.items.length < min) continue;
    let sizeUsd = 0, upnl = 0, wsum = 0, wentry = 0;
    for (const { p } of g.items) {
      sizeUsd += p.sizeUsd;
      upnl += p.upnl;
      const wt = Math.abs(p.szi);
      if (p.entry !== null && wt > 0) { wsum += wt; wentry += wt * p.entry; }
    }
    clusters.push({
      coin: g.coin,
      side: g.side,
      count: g.items.length,
      wallets: g.items.map((x) => x.address),
      sizeUsd,
      avgEntry: wsum > 0 ? wentry / wsum : null,
      upnl,
      newestOpenAt: null,
      opens: g.items.map((x) => ({ address: x.address, openedAt: null })),
    });
  }
  clusters.sort((a, b) => (b.count - a.count) || (b.sizeUsd - a.sizeUsd));
  return clusters;
}

// When did the CURRENT (coin, side) position start, from fills in the window?
// A qualifying fill: same coin, dir starts with "Open <Side>" and startPosition
// is 0 or of the opposite sign; flips ("Short > Long" / "Long > Short") ending
// in the cluster side also qualify. Returns the latest qualifying fill time
// (the start of the position still held), or null if none (opened > window).
function openedAtFromFills(fills, coin, side) {
  if (!Array.isArray(fills)) return null;
  const want = side === 'long' ? 'Long' : 'Short';
  let best = null;
  for (const f of fills) {
    if (!f || f.coin !== coin) continue;
    const dir = typeof f.dir === 'string' ? f.dir : '';
    const start = num0(f.startPosition);
    const isOpen = dir === 'Open ' + want;
    const isFlip = dir.indexOf('>') !== -1 && dir.trim().endsWith(want);
    if (!isOpen && !isFlip) continue;
    const fromFlatOrOpposite = start === 0 || (side === 'long' ? start < 0 : start > 0);
    if (!fromFlatOrOpposite) continue;
    const t = num(f.time);
    if (t === null) continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

// fillsByAddress: {address: fills[] | null}. Mutates and returns clusters.
function attachOpens(clusters, fillsByAddress) {
  for (const c of clusters) {
    let newest = null;
    c.opens = c.wallets.map((address) => {
      const fills = fillsByAddress ? fillsByAddress[address] : null;
      const openedAt = fills ? openedAtFromFills(fills, c.coin, c.side) : null;
      if (openedAt !== null && (newest === null || openedAt > newest)) newest = openedAt;
      return { address, openedAt };
    });
    c.newestOpenAt = newest;
  }
  return clusters;
}

function normalizeFill(f) {
  return {
    coin: f.coin,
    px: num(f.px),
    sz: num(f.sz),
    side: f.side === 'B' ? 'buy' : f.side === 'A' ? 'sell' : f.side || null,
    time: num(f.time),
    startPosition: num(f.startPosition),
    dir: f.dir || null,
    closedPnl: num(f.closedPnl),
  };
}

// portfolio -> {day:{accountValue:[[t,v]],pnl:[[t,v]],vlm}, ...}
function normalizePortfolio(json) {
  const out = {};
  if (!Array.isArray(json)) return out;
  for (const pair of json) {
    if (!Array.isArray(pair) || pair.length < 2 || !pair[1]) continue;
    const d = pair[1];
    const series = (arr) => (Array.isArray(arr) ? arr.map((x) => [num(x[0]), num(x[1])]) : []);
    out[pair[0]] = { accountValue: series(d.accountValueHistory), pnl: series(d.pnlHistory), vlm: num(d.vlm) };
  }
  return out;
}

function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }

module.exports = {
  HLP_ADDRESS,
  num,
  parseWindows,
  leaderboardRows,
  filterLeaderboard,
  rankWallets,
  sideFromSzi,
  normalizeMarks,
  normalizePosition,
  normalizePositions,
  buildClusters,
  openedAtFromFills,
  attachOpens,
  normalizeFill,
  normalizePortfolio,
  isAddress,
};
