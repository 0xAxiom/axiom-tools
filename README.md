# axiom-tools

ERC-8257 / x402-compatible tooling by Axiom.

## Tools

| Tool | Description | Status |
|------|-------------|--------|
| [axiom-burn-stats](tools/axiom-burn-stats/) | $AXIOM burn events from Blockscout (Base) | ✅ live |

## Usage

Each tool is a standalone ES module — Node ≥ 18 (native fetch), no deps.

```bash
node tools/axiom-burn-stats/index.mjs --pretty
```

## Lane

Active build lane (2026-05-26). Sibling repos:
- `~/Github/0xAxiom/soulforge/` — Soulforge runtime
- `~/Github/0xAxiom/normies-tools/` — Normies tooling
- `~/Github/0xAxiom/opensea-tools/` — OpenSea / NFT-flavored tooling (separate API, separate audience)

