/**
 * /api/axiom-whale-alerts — paid endpoint ($0.01 USDC; pass-bypass).
 *
 * Push-style tagged whale-transfer feed for $AXIOM on Base.
 *
 *   GET  → returns the current tagged whale event list. Filters:
 *            ?threshold_usd=1000   (default 1000)
 *            ?cohort=dumper        (one of: staker, dumper, LP-add,
 *                                  LP-remove, new-wallet,
 *                                  exchange-deposit, exchange-withdraw)
 *
 *   POST → subscribe a webhook. Body: { token, threshold_usd, webhook_url }.
 *          Returns the subscription record + a preview of currently-matching
 *          tagged events so the caller can backfill before the first push.
 *          (Outbound delivery to webhook_url is handled by a separate
 *          dispatch cron — this endpoint is the registration + preview surface.)
 *
 * Same gate as the other paid endpoints: AXIOM Tool Pass holders bypass
 * via `x-pass-holder`; everyone else pays via `x-payment` (x402).
 *
 * Cache: 30s in-memory per (threshold_usd) key.
 */

import { getWhaleEvents } from "../tools/axiom-whale-alerts/index.mjs";
import { checkAccess } from "./_lib/gate.mjs";

const AXIOM_TOKEN = "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07";
const VALID_COHORTS = new Set([
  "staker", "dumper", "LP-add", "LP-remove",
  "new-wallet", "exchange-deposit", "exchange-withdraw",
]);

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // thresholdUsd → { data, ts }

async function loadEvents(thresholdUsd) {
  const key = String(thresholdUsd);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const data = await getWhaleEvents({ thresholdUsd });
  cache.set(key, { data, ts: Date.now() });
  return data;
}

function isHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:";
  } catch { return false; }
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const gate = await checkAccess(req, { price: "0.01" });
  if (!gate.allowed) {
    return res.status(402).json(gate.envelope);
  }
  if (gate.settleResponseHeader) {
    res.setHeader("x-payment-response", gate.settleResponseHeader);
  }

  const method = req.method || "GET";

  if (method === "GET") {
    const q = req.query || {};
    const thresholdUsd = Number(q.threshold_usd ?? q.thresholdUsd ?? 1000);
    if (!Number.isFinite(thresholdUsd) || thresholdUsd < 0) {
      return res.status(400).json({ error: "threshold_usd must be a non-negative number" });
    }
    const cohort = q.cohort;
    if (cohort && !VALID_COHORTS.has(cohort)) {
      return res.status(400).json({
        error: `cohort must be one of: ${[...VALID_COHORTS].join(", ")}`,
      });
    }

    const data = await loadEvents(thresholdUsd);
    const out = cohort
      ? { ...data, events: data.events.filter(e => e.cohort === cohort) }
      : data;

    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.status(200).json(out);
  }

  if (method === "POST") {
    const body = parseBody(req);
    const token = String(body.token || "").trim();
    const thresholdUsd = Number(body.threshold_usd);
    const webhookUrl = String(body.webhook_url || "").trim();

    if (!token || !/^0x[a-fA-F0-9]{40}$/.test(token)) {
      return res.status(400).json({ error: "token must be a 0x-prefixed 20-byte address" });
    }
    if (token.toLowerCase() !== AXIOM_TOKEN.toLowerCase()) {
      return res.status(400).json({
        error: `only $AXIOM (${AXIOM_TOKEN}) is supported at this time`,
      });
    }
    if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0) {
      return res.status(400).json({ error: "threshold_usd must be a positive number" });
    }
    if (!isHttpUrl(webhookUrl)) {
      return res.status(400).json({ error: "webhook_url must be a valid http(s) URL" });
    }

    const data = await loadEvents(thresholdUsd);

    // Stable subscription id derived from (webhook_url, token, threshold).
    // The dispatch cron uses the same derivation when reading subscribers
    // from its side store, so idempotent re-subscription doesn't duplicate.
    const subId = "sub_" + Buffer
      .from(`${webhookUrl}|${token.toLowerCase()}|${thresholdUsd}`)
      .toString("base64url")
      .slice(0, 24);

    return res.status(200).json({
      subscription: {
        id: subId,
        token,
        thresholdUsd,
        webhookUrl,
        acceptedAt: new Date().toISOString(),
        deliveryNote:
          "Webhook POSTs are batched by the dispatch cron. Each delivery " +
          "carries the same event schema as this preview, signed with " +
          "header `x-axiom-whale-sig` (HMAC-SHA256 over the JSON body).",
      },
      preview: {
        priceUsd:      data.priceUsd,
        window:        data.window,
        cohortCounts:  data.cohortCounts,
        events:        data.events,
      },
    });
  }

  res.setHeader("Allow", "GET, POST, OPTIONS");
  return res.status(405).json({ error: `Method ${method} not allowed` });
}
