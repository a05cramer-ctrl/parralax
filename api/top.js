'use strict';
const hl = require('../lib/hl');
const cache = require('../lib/cache');

const CC_OK = 'public, s-maxage=3600, stale-while-revalidate=600';
const CC_PENDING = 'public, s-maxage=180, stale-while-revalidate=600';

module.exports = async function handler(req, res) {
  if (hl.preflight(req, res)) return;
  try {
    const top = await hl.getTop();
    const body = { ok: true, updatedAt: top.updatedAt, wallets: top.wallets };
    hl.send(res, 200, body, top.rolesPending > 0 ? CC_PENDING : CC_OK);
  } catch (e) {
    const stale = cache.getStale('top');
    if (stale) {
      hl.send(res, 200, { ok: true, updatedAt: stale.updatedAt, wallets: stale.wallets, partial: true }, 'public, s-maxage=60');
      return;
    }
    hl.send(res, 502, { ok: false, error: hl.errorMessage(e) }, 'public, s-maxage=5');
  }
};
