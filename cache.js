'use strict';
// In-memory TTL cache. Lives on globalThis so it survives warm invocations
// of the same Vercel function instance. Cold starts begin empty.

const STORE_KEY = '__parallaxCache';
const store = globalThis[STORE_KEY] || (globalThis[STORE_KEY] = { data: new Map(), inflight: new Map() });

function now() { return Date.now(); }

// ttlMs: number of ms, or Infinity to keep forever (per instance).
function set(key, value, ttlMs) {
  store.data.set(key, { value, exp: ttlMs === Infinity ? Infinity : now() + ttlMs, at: now() });
  return value;
}

function getEntry(key) {
  const e = store.data.get(key);
  if (!e) return undefined;
  if (e.exp <= now()) return { value: e.value, at: e.at, stale: true };
  return { value: e.value, at: e.at, stale: false };
}

function get(key) {
  const e = getEntry(key);
  return e && !e.stale ? e.value : undefined;
}

function has(key) { return get(key) !== undefined; }

function del(key) { store.data.delete(key); }

// Returns a fresh cached value or computes it once (concurrent callers share
// the same in-flight promise). ttl may be a number or a function(value) -> ms.
async function wrap(key, ttl, fn) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  if (store.inflight.has(key)) return store.inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      const ms = typeof ttl === 'function' ? ttl(value) : ttl;
      if (ms > 0) set(key, value, ms);
      return value;
    } finally {
      store.inflight.delete(key);
    }
  })();
  store.inflight.set(key, p);
  return p;
}

// Stale value (expired but not evicted) for fallback when upstream fails.
function getStale(key) {
  const e = getEntry(key);
  return e ? e.value : undefined;
}

function clear() { store.data.clear(); store.inflight.clear(); }

module.exports = { get, set, has, del, wrap, getStale, clear };
