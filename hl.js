'use strict';
// Hyperliquid public API wrapper: 8 s timeout, JSON, one retry on 429/5xx with
// backoff, and per-instance weight accounting (limit 1200 weight/min/IP).

const cache = require('./cache');
const sel = require('./select');

const INFO_URL = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const TIMEOUT_MS = 8000;
const LEADERBOARD_TIMEOUT_MS = 15000; // tens-of-MB static file; download needs longer than an info call
const WEIGHT_LIMIT = 1200;
const WEIGHT_BUDGET = 1100; // headroom under the 1200/min IP limit

const WEIGHTS = {
  clearinghouseState: 2,
  metaAndAssetCtxs: 20,
  userFillsByTime: 20,
  userFills: 20,
  userRole: 60,
  portfolio: 20,
};

// ---- weight accounting (sliding 60 s window, per warm instance) ----
const W = globalThis.__parallaxWeight || (globalThis.__parallaxWeight = { log: [] });

function weightUsed() {
  const cutoff = Date.now() - 60000;
  while (W.log.length && W.log[0][0] < cutoff) W.log.shift();
  let s = 0;
  for (const e of W.log) s += e[1];
  return s;
}

function addWeight(w) { W.log.push([Date.now(), w]); }

class HLError extends Error {
  constructor(message, status, code) { super(message); this.status = status || 0; this.code = code || 'HL'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, init, weight, timeoutMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (weight) {
      if (weightUsed() + weight > WEIGHT_BUDGET) throw new HLError('weight budget exhausted', 429, 'BUDGET');
      addWeight(weight);
    }
    let res;
    try {
      res = await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(timeoutMs || TIMEOUT_MS) }));
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new HLError(timeout ? 'upstream timeout' : 'upstream network error', 0, timeout ? 'TIMEOUT' : 'NETWORK');
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 0) {
        try { await res.arrayBuffer(); } catch (_) { /* drain */ }
        await sleep((res.status === 429 ? 1000 : 400) + Math.floor(Math.random() * 300));
        continue;
      }
      throw new HLError('upstream ' + res.status, res.status, 'UPSTREAM');
    }
    if (!res.ok) throw new HLError('upstream ' + res.status, res.status, 'UPSTREAM');
    try {
      return await res.json();
    } catch (e) {
      throw new HLError('bad upstream json', res.status, 'JSON');
    }
  }
  throw new HLError('unreachable', 0, 'HL');
}

function info(body) {
  const weight = WEIGHTS[body.type] || 20;
  return fetchJson(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, weight);
}

// Run fn over items with at most `size` in flight per batch.
async function inBatches(items, size, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const res = await Promise.allSettled(chunk.map((x, j) => fn(x, i + j)));
    res.forEach((r, j) => { out[i + j] = r; });
  }
  return out;
}

// ---- higher-level reads ----

// userRole, cached forever per instance. Returns role string or null (unknown).
async function getRole(address) {
  const key = 'role:' + address;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const json = await info({ type: 'userRole', user: address });
  const role = (json && json.role) || 'unknown';
  cache.set(key, role, Infinity);
  return role;
}

const TOP_N = 50;
const OVERSELECT = 60;
const TOP_TTL_MS = 3600 * 1000;
const TOP_TTL_PARTIAL_MS = 180 * 1000; // re-run sooner while vault roles are still unchecked
const ROLE_WEIGHT_CEILING = 600;        // keep room for positions in the same minute

async function buildTop() {
  const json = await fetchJson(LEADERBOARD_URL, { method: 'GET' }, 0, LEADERBOARD_TIMEOUT_MS);
  let candidates = sel.filterLeaderboard(sel.leaderboardRows(json), { minAccountValue: 100000, limit: OVERSELECT });
  // `json` falls out of scope here; only the 60 normalised candidates are kept.

  const kept = [];
  let unchecked = 0;
  for (const c of candidates) {
    if (kept.length >= TOP_N) break;
    let role = cache.get('role:' + c.address);
    if (role === undefined && weightUsed() + WEIGHTS.userRole <= ROLE_WEIGHT_CEILING) {
      try { role = await getRole(c.address); } catch (_) { role = undefined; } // failure -> keep wallet
    }
    if (role === 'vault') continue;
    if (role === undefined) unchecked++;
    kept.push(c);
  }
  candidates = null;
  return {
    ok: true,
    updatedAt: Date.now(),
    wallets: sel.rankWallets(kept, TOP_N),
    rolesPending: unchecked,
  };
}

async function getTop() {
  return cache.wrap('top', (v) => (v.rolesPending > 0 ? TOP_TTL_PARTIAL_MS : TOP_TTL_MS), buildTop);
}

async function getMarks() {
  return cache.wrap('marks', 5000, async () => sel.normalizeMarks(await info({ type: 'metaAndAssetCtxs' })));
}

async function getFills24h(address) {
  return cache.wrap('fills24:' + address, 60000, () =>
    info({ type: 'userFillsByTime', user: address, startTime: Date.now() - 24 * 3600 * 1000 }));
}

// ---- response helpers ----
function send(res, status, body, cacheControl) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', cacheControl || 'no-store');
  res.end(body === null ? '' : JSON.stringify(body));
}

// Handles OPTIONS / non-GET. Returns true if the request was answered.
function preflight(req, res) {
  if (req.method === 'OPTIONS') { send(res, 204, null, 'public, max-age=86400'); return true; }
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { ok: false, error: 'method not allowed' }); return true;
  }
  return false;
}

function errorMessage(e) { return (e && e.message) || 'upstream error'; }

module.exports = {
  INFO_URL, LEADERBOARD_URL, WEIGHTS, WEIGHT_LIMIT, WEIGHT_BUDGET,
  HLError, fetchJson, info, inBatches, weightUsed,
  getRole, getTop, getMarks, getFills24h,
  send, preflight, errorMessage,
};
