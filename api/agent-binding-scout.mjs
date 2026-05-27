/**
 * /api/agent-binding-scout — paid endpoint ($0.01 USDC; pass-bypass).
 *
 * Discovery primitive for ERC-8217 agent-bound NFTs in any OpenSea collection.
 *
 *   GET ?collection=<slug>&chain=<chain>&limit=<n>
 *
 * Returns the subset of NFTs in the collection that have an ERC-8217 agent
 * binding, each enriched with the inline binding payload (agent_id,
 * binding_contract, agent { chain, token_id, contract_address }, registered_by).
 *
 * Defaults:
 *   chain = ethereum, limit = 5 (cap 10)
 *
 * Same gate as the other paid endpoints: AXIOM Tool Pass holders bypass
 * via `x-pass-holder`; everyone else pays via `x-payment` (x402).
 *
 * Cache: 60s in-memory per (collection, chain, limit) key.
 */

import { scanCollection } from "../tools/agent-binding-scout/index.mjs";
import { checkAccess } from "./_lib/gate.mjs";

const CACHE_TTL_MS = 60_000;
const cache = new Map();

async function loadScan({ collection, chain, limit }) {
  const key = `${collection}|${chain}|${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const data = await scanCollection({ collection, chain, limit });
  cache.set(key, { data, ts: Date.now() });
  return data;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const gate = await checkAccess(req, { price: "0.01" });
  if (!gate.allowed) {
    return res.status(402).json(gate.envelope);
  }
  if (gate.settleResponseHeader) {
    res.setHeader("x-payment-response", gate.settleResponseHeader);
  }

  const q = req.query || {};
  const collection = String(q.collection || "").trim();
  if (!collection) {
    return res.status(400).json({
      error: "collection is required (OpenSea slug, e.g. 'normies')",
    });
  }
  if (!/^[a-z0-9-]+$/i.test(collection)) {
    return res.status(400).json({ error: "collection must be a valid OpenSea slug" });
  }

  const chain = String(q.chain || "ethereum").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(chain)) {
    return res.status(400).json({ error: "chain must be a lowercase identifier" });
  }

  const limitRaw = q.limit ?? 5;
  const limit = Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 1 || limit > 10) {
    return res.status(400).json({ error: "limit must be an integer between 1 and 10" });
  }

  try {
    const data = await loadScan({ collection, chain, limit });
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: "upstream scan failed", detail: err.message });
  }
}
