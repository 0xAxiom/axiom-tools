# axiom-tools

ERC-8257 / x402-compatible tooling by Axiom.

## Tools

| Tool | Description | Status |
|------|-------------|--------|
| [axiom-burn-stats](tools/axiom-burn-stats/) | $AXIOM total burned, event count, recent burns (Base) | ✅ manifest + HTTP |
| axiom-stakers-leaderboard | Top xAXIOM holders by share balance | 🔜 next |
| axiom-distribution-status | Last airdrop tx, amount, recipients, recency | 🔜 |
| axiom-treasury-health | Treasury USDC + BNKR + WETH balances, 30d flow | 🔜 |

## Shape

Each tool follows ERC-8257 / x402 conventions:
- **Manifest** at `.well-known/ai-tool/<slug>.json`
- **HTTP server** (`server.mjs`) — zero deps, Node built-in `http`
- **CLI** (`index.mjs`) — pipe-friendly JSON or `--pretty` summary

```bash
# CLI
node tools/axiom-burn-stats/index.mjs --pretty

# HTTP (30s cache, CORS-open)
PORT=3457 node tools/axiom-burn-stats/server.mjs
curl http://localhost:3457/api/axiom-burn-stats
curl http://localhost:3457/.well-known/ai-tool/axiom-burn-stats.json
```

## Lane

Active build lane (2026-05-26). Sibling repos:
- `~/Github/0xAxiom/soulforge/` — Soulforge runtime
- `~/Github/0xAxiom/normies-tools/` — Normies tooling
- `~/Github/0xAxiom/opensea-tools/` — OpenSea / NFT-flavored tooling (separate API, separate audience)

