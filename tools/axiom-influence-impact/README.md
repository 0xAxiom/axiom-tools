# axiom-influence-impact

Which CT accounts actually move onchain volume when they post about a token, vs who is just loud.

## Why this exists

Every crypto Twitter raid claims their thought leader "moved the chart." Most of them didn't. This endpoint quantifies it: for a given token, it pairs recent tweets with hourly DEX volume bars, computes how much excess volume each tweet's hour-window saw vs the running baseline, and aggregates per author. Across enough samples, the ranking is harder to fake than mindshare.

## Pricing

| Caller | Cost |
|--------|------|
| AXIOM Tool Pass holder | Free |
| Everyone else | x402: $0.01 USDC on Base per call |

## Routes

| Path | What |
|------|------|
| `GET /api/axiom-influence-impact` | Full snapshot — every watched token |
| `GET /api/axiom-influence-impact?token=AXIOM` | One token only |
| `GET /.well-known/ai-tool/axiom-influence-impact.json` | ERC-8257 manifest |

## Methodology

1. **Tweet ingest** — `twitter-api.py search` for each search term in `known-tokens.json` (cashtag + plaintext + handle variants). Dedupe by tweet ID. Filter to a 7-day window.
2. **Volume bars** — GeckoTerminal `/networks/base/pools/<id>/ohlcv/hour` for the deepest-liquidity pool of the token. Last 168 hours.
3. **Per-tweet attribution** — for each tweet at time `t`:
   - Bucket: `hourBucket = floor(t / 3600) * 3600`
   - Window volume = `bar[hourBucket] + bar[hourBucket + 1h]`
   - Expected = `2 * baseline_hourly` (median over the 168 bars — median, not mean, to resist the spikes we're attributing)
   - Attributed delta = `max(0, window_volume - expected)`
4. **Per-author dedup** — if an author posts twice in the same hour bucket, only one window is counted. Their `posts` count still increments; only `total_attributed_usd` is dedup'd.
5. **Aggregate** — sum attributed, count posts, capture last-seen + sample tweet URL. Sort descending. Top 50 returned.

### Caveats

- **Correlational, not causal.** This is "who posted close to volume spikes," not "who caused them." But across N samples, an author consistently appearing pre-spike is itself signal — and that's the actual question agents want answered.
- **7-day window only.** Twitter free-tier search returns ~7d. 30d requires Pro.
- **Snapshot, not live.** Recomputing for every request would burn 30s+ on Twitter search + GT API. Refresh runs daily via `refresh-snapshot.mjs`.
- **Watched-list only.** Adding a token = adding its contract + pool ID to `known-tokens.json`. Tokens without a `geckoterminalPool` return `error: ...` and an empty leaderboard rather than blocking the rest of the snapshot.

## Sample response (`?token=AXIOM`)

```json
{
  "token": "AXIOM",
  "contract": "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07",
  "pool": "0x10a0b8eba9d4e0f772c8c47968ee819bb4609ef4454409157961570cdce9a735",
  "window": "7d",
  "computedAt": "2026-05-27T03:36:00.000Z",
  "stalenessHours": 0,
  "sampleSize": { "tweets": 252, "bars": 168 },
  "baseline_hourly_usd": 225.91,
  "leaderboard": [
    {
      "author": "Sam_2S4",
      "posts": 4,
      "total_attributed_usd": 16753.01,
      "avg_per_post": 4188.25,
      "last_seen": "2026-05-20T20:42:19.000Z",
      "sample_tweet_url": "https://x.com/Sam_2S4/status/2057200267100029024"
    }
  ]
}
```

## Local

```bash
# CLI run for one token
node tools/axiom-influence-impact/index.mjs AXIOM

# Refresh the snapshot (iterates every watched token)
node tools/axiom-influence-impact/refresh-snapshot.mjs
```

`refresh-snapshot.mjs` needs `TWITTER_API_PY` resolvable + `~/.axiom/wallet.env` sourced for the Twitter OAuth credentials. GeckoTerminal is unauthed.

## Adding a token

Edit `known-tokens.json` and add an entry under `tokens`:

```json
"GITLAWB": {
  "symbol": "GITLAWB",
  "contract": "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3",
  "geckoterminalPool": "<pool-id-from-GT>",
  "searchTerms": ["$GITLAWB", "gitlawb"]
}
```

Find the pool ID via:

```bash
curl -s "https://api.geckoterminal.com/api/v2/networks/base/tokens/<CONTRACT>/pools" | jq '.data[0].id'
```

Pick the pool with the highest `attributes.reserve_in_usd`.
