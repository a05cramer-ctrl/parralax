'use strict';
const hl = require('../lib/hl');
const cache = require('../lib/cache');
const sel = require('../lib/select');

const CC_OK = 'public, s-maxage=10, stale-while-revalidate=20';
const BATCH = 10;
const MIN_CLUSTER = 5;
const RESULT_TTL_MS = 8000; // per-instance cache on top of the CDN cache

async function buildPositions() {
  const top = await hl.getTop();
  let partial = false;

  const [marksR, statesR] = await Promise.all([
    hl.getMarks().then((v) => ({ ok: true, v }), () => ({ ok: false })),
    hl.inBatches(top.wallets, BATCH, (w) => hl.info({ type: 'clearinghouseState', user: w.address })),
  ]);
  const marks = marksR.ok ? marksR.v : {};
  if (!marksR.ok) partial = true;

  const wallets = top.wallets.map((w, i) => {
    const r = statesR[i];
    const base = { rank: w.rank, address: w.address, name: w.name, accountValue: w.accountValue };
    if (!r || r.status !== 'fulfilled' || !r.value) {
      partial = true;
      return Object.assign(base, { positions: [], error: true });
    }
    const st = r.value;
    const av = st.marginSummary && sel.num(st.marginSummary.accountValue);
    if (av !== null && av !== undefined) base.accountValue = av;
    return Object.assign(base, { positions: sel.normalizePositions(st, marks) });
  });

  const clusters = sel.buildClusters(wallets, MIN_CLUSTER);

  // Fill lookups only for wallets that sit in a cluster (cached 60 s each).
  const addrs = [...new Set(clusters.flatMap((c) => c.wallets))];
  const fillsR = await hl.inBatches(addrs, 5, (a) => hl.getFills24h(a));
  const fillsByAddress = {};
  addrs.forEach((a, i) => {
    const r = fillsR[i];
    if (r && r.status === 'fulfilled' && Array.isArray(r.value)) fillsByAddress[a] = r.value;
    else partial = true;
  });
  sel.attachOpens(clusters, fillsByAddress);

  const body = { ok: true, updatedAt: Date.now(), marks, wallets, clusters };
  if (partial) body.partial = true;
  return body;
}

module.exports = async function handler(req, res) {
  if (hl.preflight(req, res)) return;
  try {
    const body = await cache.wrap('positions', RESULT_TTL_MS, buildPositions);
    hl.send(res, 200, body, CC_OK);
  } catch (e) {
    const stale = cache.getStale('positions');
    if (stale) {
      hl.send(res, 200, Object.assign({}, stale, { partial: true }), 'public, s-maxage=5');
      return;
    }
    hl.send(res, 502, { ok: false, error: hl.errorMessage(e) }, 'public, s-maxage=5');
  }
};
