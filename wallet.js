'use strict';
const hl = require('../lib/hl');
const cache = require('../lib/cache');
const sel = require('../lib/select');

const CC_OK = 'public, s-maxage=10, stale-while-revalidate=20';

function queryAddress(req) {
  if (req.query && typeof req.query.address === 'string') return req.query.address;
  try { return new URL(req.url || '', 'http://x').searchParams.get('address'); } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  if (hl.preflight(req, res)) return;
  const raw = queryAddress(req);
  if (!sel.isAddress(raw)) {
    hl.send(res, 400, { ok: false, error: 'address must be 0x + 40 hex chars' }, 'public, s-maxage=60');
    return;
  }
  const address = raw.toLowerCase();
  try {
    const body = await cache.wrap('wallet:' + address, 8000, async () => {
      const [stR, fillsR, pfR] = await Promise.allSettled([
        hl.info({ type: 'clearinghouseState', user: address }),
        hl.info({ type: 'userFills', user: address }),
        hl.info({ type: 'portfolio', user: address }),
      ]);
      if (stR.status !== 'fulfilled') throw stR.reason;
      let partial = false;
      const marks = cache.get('marks') || null; // reuse if warm, never spend weight here
      const st = stR.value || {};
      const top = cache.get('top');
      const inTop = top && top.wallets.find((w) => w.address === address);
      const out = {
        ok: true,
        updatedAt: Date.now(),
        address,
        rank: inTop ? inTop.rank : null,
        name: inTop ? inTop.name : null,
        accountValue: sel.num(st.marginSummary && st.marginSummary.accountValue),
        positions: sel.normalizePositions(st, marks),
        fills: [],
        portfolio: {},
      };
      if (fillsR.status === 'fulfilled' && Array.isArray(fillsR.value)) {
        out.fills = fillsR.value.slice().sort((a, b) => Number(b.time) - Number(a.time)).slice(0, 50).map(sel.normalizeFill);
      } else partial = true;
      if (pfR.status === 'fulfilled') out.portfolio = sel.normalizePortfolio(pfR.value);
      else partial = true;
      if (partial) out.partial = true;
      return out;
    });
    hl.send(res, 200, body, CC_OK);
  } catch (e) {
    hl.send(res, 502, { ok: false, error: hl.errorMessage(e) }, 'public, s-maxage=5');
  }
};
