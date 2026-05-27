# axiom-whale-alerts

Push-style tagged whale-transfer feed for $AXIOM on Base — exposed as a paid agent endpoint.

Different shape from the other axiom-tools endpoints: subscribers POST a webhook URL + USD threshold, and tagged transfer events are pushed to them as they happen. GET is also available for pull-style readers.

## Why this exists

Anyone can watch big ERC-20 Transfer events. The value here is the **inline cohort tag** — agents want to route on *"whale dumped"* vs *"whale added LP"* vs *"new wallet just got airdropped"*, not on raw log noise.

Every emitted event carries one of seven cohort labels:

| Cohort              | Trigger |
|---------------------|---------|
| `staker`            | Destination is the StakedAxiom ERC-4626 vault |
| `dumper`            | Destination is a known DEX pair / pool singleton (sell-side) |
| `LP-add`            | Source is a known LP NonfungiblePositionManager (mint side) |
| `LP-remove`         | Source is a DEX pair, destination is a position manager |
| `new-wallet`        | Recipient has zero prior tx history (first ever transaction) |
| `exchange-deposit`  | Destination is a known CEX hot wallet |
| `exchange-withdraw` | Source is a known CEX hot wallet |

Transfers that don't match any of these are dropped — the moat is the tag, not the noise.

## Pricing

| Caller | Cost |
|--------|------|
| AXIOM Tool Pass holder (`x-pass-holder` + onchain `balanceOf ≥ 1`) | Free |
| Everyone else | x402: $0.01 USDC on Base per call |

## Routes

| Method · Path | What |
|---------------|------|
| `GET  /api/axiom-whale-alerts` | Current tagged feed. Optional `?threshold_usd=` and `?cohort=`. |
| `POST /api/axiom-whale-alerts` | Subscribe a webhook. Body: `{ token, threshold_usd, webhook_url }`. Returns the subscription record + a preview of currently-matching events. |
| `GET  /.well-known/ai-tool/axiom-whale-alerts.json` | ERC-8257 manifest |

## Sample curl

GET the feed (free for pass holders):

```bash
curl -H "x-pass-holder: 0xYourWallet" \
     "https://axiom-tools-hazel.vercel.app/api/axiom-whale-alerts?threshold_usd=500&cohort=dumper" | jq
```

Subscribe a webhook:

```bash
curl -X POST -H "x-pass-holder: 0xYourWallet" \
     -H "content-type: application/json" \
     -d '{
       "token": "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07",
       "threshold_usd": 500,
       "webhook_url": "https://agent.example/whale-hook"
     }' \
     https://axiom-tools-hazel.vercel.app/api/axiom-whale-alerts | jq
```

Without a pass, the client receives an HTTP 402 with an `accepts` x402 envelope; sign the payment authorization, replay with `x-payment: <base64>` and the gate verifies+settles before serving.

## Sample response (GET)

```json
{
  "token": "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07",
  "fetchedAt": "2026-05-27T17:12:47.234Z",
  "priceUsd": 0.000001253,
  "window": { "fromBlock": 46551104, "toBlock": 46556104, "blocks": 5000 },
  "thresholdUsd": 100,
  "discoveredPairs": [
    "0x498581ff718922c3f8e6a244956af099b2652b2b",
    "0x6ff5693b99212da76ad316178a184ab56d299b43"
  ],
  "cohortCounts": { "dumper": 4 },
  "events": [
    {
      "cohort": "dumper",
      "txHash": "0x72fef4616e…",
      "blockNumber": 46555820,
      "timestamp": "2026-05-27T16:00:09.000Z",
      "from": "0xe993f92f…",
      "to":   "0x498581ff…",
      "amount":   "319,616,838.49",
      "valueUsd": 400.48
    }
  ]
}
```

## Architecture

```
┌──────────────────────┐    ┌────────────────────┐    ┌────────────────┐
│ Base RPC (eth_getLogs│    │ DexScreener        │    │ Base RPC       │
│  for $AXIOM Transfer)│    │ (pair + priceUsd)  │    │ (batched       │
│                      │    │                    │    │  txCount + ts) │
└──────────┬───────────┘    └─────────┬──────────┘    └────────┬───────┘
           │                          │                        │
           ▼                          ▼                        ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ tools/axiom-whale-alerts/index.mjs   (pure data layer)        │
  │   • amount filter via priceUsd                                │
  │   • address-set classification                                │
  │   • new-wallet check (batched eth_getTransactionCount)        │
  │   • per-tx dedupe                                             │
  └─────────────────────────┬─────────────────────────────────────┘
                            ▼
                ┌────────────────────────┐
                │ api/axiom-whale-alerts │  ──▶ agents (GET / POST)
                │ (gate + cache + route) │
                └────────────────────────┘
```

- **Live-fetch model**, not snapshot. Whale events are time-sensitive — a 24h-old snapshot is useless for a "dumper just hit" alert.
- 30s in-memory cache per `threshold_usd` to flatten request spikes.
- All onchain reads use the zero-dep raw `fetch` + JSON-RPC pattern. The new-wallet check and per-block timestamp lookups are **batched** in a single `rpcBatch()` call to stay friendly to the public Base RPC.
- `discoveredPairs` exposes which addresses the classifier treated as "the pool" — useful to audit when the DEX architecture changes (e.g. Uniswap V3 → V4 singleton).

## Uniswap V4 handling

V4 uses a singleton `PoolManager` — there is no per-pool contract. When DexScreener returns a V4 poolId (64-char hash) in `pairAddress`, the data layer substitutes the V4 PoolManager + Universal Router so the `dumper` / LP rules still fire correctly. This is the reason `discoveredPairs` sometimes contains addresses you won't find in DexScreener's payload.

## Outbound webhook delivery

This endpoint accepts subscriptions and returns the current preview synchronously. Actual outbound `POST` delivery to `webhook_url` is the responsibility of the dispatch cron (separate process, not part of this Vercel function), which:

1. Polls this endpoint (or the underlying data layer directly) on a short interval.
2. Diffs against the last-delivered watermark per subscription.
3. POSTs new events to `webhook_url` with header `x-axiom-whale-sig: <hmac-sha256 of body>`.

That cron is wired up outside this repo. The subscription `id` returned here is a deterministic hash of `(webhook_url, token, threshold_usd)`, so re-subscribing is idempotent.

## Local test

```bash
node tools/axiom-whale-alerts/index.mjs --pretty
node tools/axiom-whale-alerts/index.mjs --threshold 250 --blocks 5000 --pretty
node tools/axiom-whale-alerts/index.mjs > /tmp/whale-feed.json
```

## Configuration

| Env var | Purpose |
|---------|---------|
| `BASE_RPC_URL` | Override the default `https://mainnet.base.org`. Use a paid provider in production to avoid public-RPC rate limits. |
| `STAKED_AXIOM_ADDRESS` | Address of the StakedAxiom ERC-4626 vault. Until set, no transfers will be tagged `staker`. |
| `AXIOM_KNOWN_CEX` | Comma-separated 0x addresses of known CEX hot wallets. Empty by default — false positives are worse than missed tags. |
