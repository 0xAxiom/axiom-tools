# agent-binding-scout

Discovery primitive for [ERC-8217](https://eips.ethereum.org/EIPS/eip-8217) agent-bound NFTs in any OpenSea collection.

Pass an OpenSea collection slug; receive the subset of NFTs that have an agent bound, each enriched with the inline binding payload (`agent_id`, `binding_contract`, `agent { chain, token_id, contract_address }`, `registered_by`).

Built on the `has_agent_binding=true` filter OpenSea added to its REST API in May 2026 ([CodinCowboy announcement](https://x.com/CodinCowboy/status/2059689161083490796)).

## Endpoint

```
GET /api/agent-binding-scout?collection=<slug>&chain=<chain>&limit=<n>
```

Defaults: `chain=ethereum`, `limit=5` (cap 10).

Pricing: $0.01 USDC on Base (x402) — bypass with `x-pass-holder: <wallet>` if the wallet holds ≥ 1 AXIOM Tool Pass.

## Example

```bash
curl -H "x-pass-holder: 0xYourWallet" \
  "https://axiom-tools-hazel.vercel.app/api/agent-binding-scout?collection=normies&limit=3"
```

Returns:

```json
{
  "collection": "normies",
  "chain": "ethereum",
  "fetchedAt": "2026-05-27T18:00:00.000Z",
  "bindingsFound": 3,
  "next": "WyIyMDI2…",
  "bindings": [
    {
      "nft": {
        "identifier": "9852",
        "contract": "0x9eb6e2025b64f340691e424b7fe7022ffde12438",
        "name": "Normie #9852",
        "image_url": "https://raw2.seadn.io/…",
        "opensea_url": "https://opensea.io/assets/ethereum/0x9eb6…/9852"
      },
      "binding": {
        "agent_id": "32375",
        "binding_contract": "0xde152afb7db5373f34876e1499fbd893a82dd336",
        "agent": {
          "chain": "ethereum",
          "token_id": "32375",
          "contract_address": "0x8004a169fb4a3325136eb29fa0ceb6d2e539a432"
        },
        "registered_by": "0xb3611da4a72fba65a80b0e7025b49431b193873e"
      }
    }
  ]
}
```

## CLI

```bash
OPENSEA_API_KEY=<key> node tools/agent-binding-scout/index.mjs \
  --collection normies --chain ethereum --limit 5 --pretty
```

## Implementation notes

- OpenSea's collection-list endpoint only returns NFT identifiers — the binding payload is on the per-NFT endpoint, so each result requires one extra OpenSea call.
- Per-NFT enrichment is **serialized**, not parallel. Concurrent requests against the same collection hit OpenSea's stale-cache path and return null bindings on first try. Sequential calls always see the freshened payload.
- 60s in-memory cache per `(collection, chain, limit)` key.
