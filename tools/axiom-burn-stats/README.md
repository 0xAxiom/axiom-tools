# axiom-burn-stats

Reads $AXIOM burn stats from Base via Blockscout and a direct RPC `balanceOf` call.

## Usage

```bash
node index.mjs           # JSON output
node index.mjs --pretty  # human-readable summary
```

## Output

- `burnStats.canonicalBurned` — `balanceOf(0xdEaD)` (authoritative; includes pre-indexing burns)
- `burnStats.fromLogs.total` — sum of Transfer-to-DEAD log events (slightly lower, ~69 events)
- `burnStats.percentBurned` — out of 100B total supply
- `recentBurns` — 5 most recent burn transactions with timestamps

## Addresses

- **Token:** `0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07` (Base)
- **Dead:** `0x000000000000000000000000000000000000dEaD`

## Notes

Uses Blockscout `getLogs` endpoint (not `/addresses/DEAD/token-transfers` — that returns empty).
`balanceOf` via `mainnet.base.org` RPC for canonical count.

Burns fire daily via the Clanker fee pipeline (~21:01 UTC).
As of 2026-05-26: **3.40B AXIOM burned** (3.40% of supply), 69 events.
