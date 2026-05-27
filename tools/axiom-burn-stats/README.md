# axiom-burn-stats

Returns total $AXIOM burned, burn event count, and 5 most recent burns — live from Base mainnet.

Sources: Blockscout `getLogs` (full event history) + direct RPC `balanceOf(0xdEaD)` (canonical total).

## Quick start

```bash
# CLI — pretty summary
node index.mjs --pretty

# CLI — raw JSON
node index.mjs

# HTTP server (zero deps, Node built-in http module)
PORT=3457 node server.mjs
```

## HTTP routes

| Route | Response |
|-------|----------|
| `GET /api/axiom-burn-stats` | Burn stats JSON (30s cache) |
| `GET /.well-known/ai-tool/axiom-burn-stats.json` | ERC-8257 tool manifest |
| `GET /health` | `{"status":"ok"}` |

```bash
# curl examples
curl http://localhost:3457/health
curl http://localhost:3457/api/axiom-burn-stats
curl http://localhost:3457/.well-known/ai-tool/axiom-burn-stats.json
```

## Sample output

```json
{
  "token": "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07",
  "fetchedAt": "2026-05-27T02:48:15.325Z",
  "burnStats": {
    "canonicalBurned": "3,403,421,037.14",
    "percentBurned": "3.4034%",
    "fromLogs": { "eventCount": 70, "total": "3,370,345,907.97" }
  },
  "recentBurns": [
    {
      "timestamp": "2026-05-26T21:01:05.000Z",
      "amountFormatted": "4,513,422.49",
      "txHash": "0xb9169f4b..."
    }
  ]
}
```

## Output fields

| Field | Description |
|-------|-------------|
| `burnStats.canonicalBurned` | `balanceOf(0xdEaD)` — authoritative (includes pre-indexing burns) |
| `burnStats.fromLogs.total` | Sum of Transfer-to-DEAD log events (may be slightly lower) |
| `burnStats.percentBurned` | Out of 100B total supply |
| `recentBurns` | 5 most recent burn transactions, newest first |

## Addresses

- **Token:** `0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07` (Base)
- **Dead:** `0x000000000000000000000000000000000000dEaD`

## Notes

- Uses Blockscout `getLogs` (not `/addresses/DEAD/token-transfers` — that returns empty for burn sinks)
- Burns fire daily via the Clanker fee pipeline (~21:01 UTC)
- As of 2026-05-27: **3.40B AXIOM burned** (3.40% of supply), 70 events
