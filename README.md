# axiom-tools

Paid agent endpoints for the AXIOM ecosystem. Single Vercel project, every tool mounted under `/api/<slug>`. ERC-8257 manifests at `/.well-known/ai-tool/<slug>.json`. Pass-bypass via the AXIOM Tool Pass; otherwise x402 USDC-on-Base.

**Live:** `https://axiom-tools-hazel.vercel.app`

## Endpoints

| Tool | Description | Tier |
|------|-------------|------|
| [axiom-burn-stats](tools/axiom-burn-stats/) | Live $AXIOM burn stats: canonical burned, event count, recent burns | Free (demo) |
| [axiom-narrative-pulse](tools/axiom-narrative-pulse/) | Crypto/AI narrative map: phase, velocity, drivers, position calls | x402 $0.01 |
| [axiom-influence-impact](tools/axiom-influence-impact/) | CT-account → onchain-volume attribution per token | x402 $0.01 |
| [axiom-whale-alerts](tools/axiom-whale-alerts/) | Webhook push feed for large transfers with cohort tagging | x402 $0.01 |
| [agent-binding-scout](tools/agent-binding-scout/) | ERC-8217 agent-bound NFTs in any OpenSea collection, with binding payload | x402 $0.01 |
| axiom-sweep-forecast | NFT sweep-quote + forward floor projection | 🔜 queued |

The 3 queued endpoints will ship via the [`endpoint-builder` cron](scripts/endpoint-builder.mjs), which consults `~/clawd/ideabank.md` for demand signals before each pick and orders the queue by priority.

## Architecture

```
                                  ┌──────────────────────────┐
   GET /api/<slug>      ────────▶ │ api/<slug>.mjs           │
                                  │   import gate            │
                                  │   import data logic      │
                                  │   serve or 402           │
   GET /.well-known/   ────────▶  │ api/manifest.mjs         │
       ai-tool/<slug>.json        │   (rewritten by vercel)  │
                                  └────────────┬─────────────┘
                                               │
                                               ▼
                                  ┌──────────────────────────┐
                                  │ tools/<slug>/index.mjs   │ ← pure data logic
                                  │ tools/<slug>/snapshot.*  │ ← snapshot model (optional)
                                  │ .well-known/ai-tool/...  │ ← manifest source
                                  └──────────────────────────┘
```

- **One Vercel project**, deployed from the repo root.
- **`api/_lib/gate.mjs`** is the shared access gate — every paid handler calls `checkAccess(req)` first and either gets `{ allowed: true }` or an x402 envelope to return.
- **Pass bypass:** caller sends `x-pass-holder: <wallet>`; the gate does a zero-dep `balanceOf` RPC call against the [AXIOM Tool Pass](https://basescan.org/address/0xfc9ce3990f85fA1A3a0eE51a710642396a6Cad82) on Base. Balance ≥ 1 → free.
- **x402 paid:** caller sends a verified `x-payment` envelope; the gate trusts it (the verifier sits upstream).
- **Local dev:** `vercel dev` from repo root; or run `node tools/<slug>/server.mjs` for the standalone version of any tool with one.

## Bypass via Tool Pass

```bash
# Free if your wallet holds 1+ AXIOM Tool Pass NFT:
curl -H "x-pass-holder: 0xYourWallet" https://axiom-tools-hazel.vercel.app/api/axiom-narrative-pulse

# Otherwise x402 paywall:
curl https://axiom-tools-hazel.vercel.app/api/axiom-narrative-pulse
# → 402 + x402 envelope with USDC payment details
```

Mint a Tool Pass: [https://axiom-tools-hazel.vercel.app/pass](https://axiom-tools-hazel.vercel.app/pass) (1000 supply, 0.005 ETH, 10/wallet — `0xfc9ce3990f85fA1A3a0eE51a710642396a6Cad82` on Base).

## Lane

Active build lane (2026-05-26). Sibling repos:
- `~/Github/0xAxiom/soulforge/` — Soulforge runtime
- `~/Github/0xAxiom/normies-tools/` — Normies tooling
- `~/Github/0xAxiom/opensea-tools/` — OpenSea / NFT-flavored tooling (separate API, separate audience)
