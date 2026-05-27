/**
 * agent-binding-scout
 *
 * Discovery primitive for ERC-8217 agent-bound NFTs in any OpenSea collection.
 *
 * OpenSea's REST API surfaces the binding inline on the per-NFT endpoint
 * (`/api/v2/chain/{chain}/contract/{contract}/nfts/{id}`) and exposes a
 * `has_agent_binding=true` filter on the collection-list endpoint. The list
 * filter returns identifiers only — the binding payload itself requires a
 * per-NFT fetch. This module fans out, enriches each hit with the binding
 * metadata, and returns the joined view.
 *
 * Usage:
 *   node index.mjs --collection normies
 *   node index.mjs --collection normies --chain ethereum --limit 5
 *
 * Inputs:
 *   collection — OpenSea slug (required)
 *   chain      — OpenSea chain string. Defaults to "ethereum".
 *                Used for the per-NFT enrichment fetch.
 *   limit      — Number of bound NFTs to return (default 5, cap 10).
 *                Capped because each NFT is one extra API call against
 *                a free-tier 60r/5min OpenSea key.
 */

const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || "";
const OPENSEA_BASE    = "https://api.opensea.io/api/v2";
const DEFAULT_LIMIT   = 5;
const MAX_LIMIT       = 10;

function headers() {
  const h = { "accept": "application/json" };
  if (OPENSEA_API_KEY) h["X-API-KEY"] = OPENSEA_API_KEY;
  return h;
}

async function listBoundNfts(collection, limit, cursor) {
  const params = new URLSearchParams({
    has_agent_binding: "true",
    limit: String(limit),
  });
  if (cursor) params.set("next", cursor);
  const url = `${OPENSEA_BASE}/collection/${encodeURIComponent(collection)}/nfts?${params}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`opensea list ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function getNftOnce(chain, contract, identifier) {
  const url = `${OPENSEA_BASE}/chain/${chain}/contract/${contract}/nfts/${identifier}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) {
    return { error: `opensea get_nft ${r.status}`, identifier, contract };
  }
  const data = await r.json();
  return data.nft || data;
}

// OpenSea's get_nft sometimes returns stale data on first hit and triggers
// an async refresh (visible as `updated_at` advancing during the request).
// The list filter (has_agent_binding=true) is authoritative — when it says
// the NFT has a binding but get_nft returns no `agent_binding`, retry once
// after a short delay to pick up the refreshed payload.
async function getNftWithBinding(chain, contract, identifier) {
  const first = await getNftOnce(chain, contract, identifier);
  if (first.agent_binding) return first;
  await new Promise(r => setTimeout(r, 1500));
  const second = await getNftOnce(chain, contract, identifier);
  return second.agent_binding ? second : first;
}

/**
 * Scan a collection for ERC-8217 agent-bound NFTs and enrich each with
 * the inline binding payload.
 *
 * @param {{ collection: string, chain?: string, limit?: number }} opts
 * @returns {Promise<{
 *   collection: string,
 *   chain: string,
 *   fetchedAt: string,
 *   bindingsFound: number,
 *   next: string | null,
 *   bindings: Array<{
 *     nft: { identifier: string, contract: string, name: string|null, image_url: string|null, opensea_url: string|null },
 *     binding: { agent_id: string, binding_contract: string, agent: object, registered_by: string } | null
 *   }>
 * }>}
 */
export async function scanCollection({ collection, chain = "ethereum", limit = DEFAULT_LIMIT } = {}) {
  if (!collection || typeof collection !== "string") {
    throw new Error("collection (OpenSea slug) is required");
  }
  const n = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));

  const list = await listBoundNfts(collection, n);
  const items = Array.isArray(list.nfts) ? list.nfts : [];

  // Per-NFT enrichment must be serialized: OpenSea returns stale data when
  // multiple NFTs in the same collection are requested in parallel and only
  // freshens one of them. Sequential calls hit the freshened cache each time.
  // limit ≤ 10 → bounded latency (~1–2s) is acceptable for a paid endpoint.
  const enriched = [];
  for (const item of items) {
    const detail = await getNftWithBinding(chain, item.contract, item.identifier);
    enriched.push({
      nft: {
        identifier:   item.identifier,
        contract:     item.contract,
        name:         detail.name ?? item.name ?? null,
        image_url:    detail.image_url ?? item.image_url ?? null,
        opensea_url:  detail.opensea_url ?? item.opensea_url ?? null,
      },
      binding: detail.agent_binding || null,
    });
  }

  return {
    collection,
    chain,
    fetchedAt:     new Date().toISOString(),
    bindingsFound: enriched.length,
    next:          list.next || null,
    bindings:      enriched,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isCli = import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  const args = process.argv.slice(2);
  const pretty = args.includes("--pretty");
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const collection = get("--collection", "normies");
  const chain      = get("--chain", "ethereum");
  const limit      = Number(get("--limit", DEFAULT_LIMIT));

  const result = await scanCollection({ collection, chain, limit });

  if (pretty) {
    console.log(`\nagent-binding-scout — ${result.collection} (${result.chain})`);
    console.log("──────────────────────────────────────────────");
    console.log(`fetchedAt:    ${result.fetchedAt}`);
    console.log(`bindings:     ${result.bindingsFound}`);
    console.log(`next cursor:  ${result.next ? "yes" : "—"}\n`);
    for (const b of result.bindings) {
      const id = `#${b.nft.identifier}`.padEnd(8);
      const agentId = b.binding?.agent_id ?? "—";
      const bindingC = (b.binding?.binding_contract ?? "—").slice(0, 12);
      console.log(`  ${id}  agent_id=${agentId}  binding=${bindingC}…  ${b.nft.name ?? ""}`);
    }
    console.log();
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
