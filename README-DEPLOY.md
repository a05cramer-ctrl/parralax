# PARALLAX - deploy

1. Import this `site/` folder as a Vercel project (framework preset: Other, no build command, output = root).
2. No environment variables are required. `TELEGRAM_BOT_TOKEN` is reserved for later alerts and is not read yet.
3. Node 24 (set by `engines` in package.json). No dependencies, no crons (Hobby plan safe).

Endpoints: `/api/top`, `/api/positions`, `/api/wallet?address=0x...`.

## How it stays under 1200 weight/min (Hyperliquid per-IP limit)
- `/api/top`: leaderboard file (static, not weighted) parsed once, filtered to 60 candidates, top 50 kept; cached 1 h in memory and at the CDN (`s-maxage=3600, stale-while-revalidate=600`). Vault check (`userRole`, weight 60) only for candidates, cached forever per instance, capped so roles never push the minute past ~600 weight; while some roles are unchecked the list is cached 3 min instead of 1 h so the rest get checked on the next runs.
- `/api/positions`: 50 x clearinghouseState (2) + metaAndAssetCtxs (20) = ~120 weight per rebuild. CDN `s-maxage=10, swr=20` plus an 8 s in-memory cache, so at most ~6 rebuilds/min per instance (~720). userFillsByTime (20+) only for wallets inside a 5+ convergence cluster, cached 60 s each.
- `/api/wallet`: clearinghouseState + userFills + portfolio (~42), cached 10 s at the CDN and 8 s in memory.
- `lib/hl.js` keeps a sliding 60 s weight log per instance and refuses calls past 1100; failed wallets come back with `error:true` and the response gets `partial:true` instead of failing.
- Every upstream call: 8 s timeout (leaderboard 15 s), one retry on 429/5xx with backoff.

Accounting is per function instance; several cold instances in parallel share one IP limit, so CDN caching is what really bounds the load.
