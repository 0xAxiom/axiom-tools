/**
 * x402 helpers for endpoints that grade access by tier rather than 402-or-200.
 *
 * Used by tools like axiom-burn-stats whose manifest declares `pricing.type: "free"`
 * but offer an extra "premium" slice (e.g. recentBurns history) to Tool Pass
 * holders or x402 payers. The endpoint always returns HTTP 200 with a `_tier`
 * field indicating which slice was served.
 *
 * For 402-or-200 paid endpoints, use `checkAccess` in ./gate.mjs instead.
 *
 * Three exports:
 *   - `send402(res, endpoint, desc, amount)`  — legacy 402 helper (kept for compat)
 *   - `hasToolPass(wallet)`                   — onchain Tool Pass check
 *   - `resolveTier(req, opts)`                — verified tier resolution
 *
 * Zero deps.
 */

import {
  buildPaymentRequirements,
  verifyPayment,
  settlePayment,
} from "./facilitator.mjs";

// ─── constants ────────────────────────────────────────────────────────────────

const PAY_TO        = process.env.X402_PAY_TO || "0x523Eff3dB03938eaa31a5a6FBd41E3B9d23edde5";
const USDC_BASE     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PASS_CONTRACT = "0xfc9ce3990f85fA1A3a0eE51a710642396a6Cad82"; // AXIOM Tool Pass on Base
const BASE_RPC      = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const BALANCE_OF    = "0x70a08231";

const balanceCache = new Map(); // wallet → { balance: bigint, ts: number }
const BALANCE_TTL  = 60_000;

// ─── payment required response (legacy helper) ────────────────────────────────

/**
 * Build and send an HTTP 402 response with the x402 PaymentRequired body.
 * Retained for callers that need the bare 402 helper without the gate flow.
 *
 * @param {object} res      Vercel/Node response
 * @param {string} endpoint Full URL of the gated resource
 * @param {string} desc     Human-readable description
 * @param {string} [amount] USDC atomic units (6 decimals). Default "1000" = $0.001
 */
export function send402(res, endpoint, desc, amount = "1000") {
  const paymentRequired = {
    x402Version: 1,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network: "base",
        asset: USDC_BASE,
        payTo: PAY_TO,
        maxAmountRequired: amount,
        maxTimeoutSeconds: 300,
        description: desc,
        resource: endpoint,
      },
    ],
  };
  res.setHeader("x-payment-required", "true");
  res.setHeader("content-type", "application/json");
  res.status(402).json(paymentRequired);
}

// ─── pass holder check ────────────────────────────────────────────────────────

/**
 * Returns true if `wallet` holds ≥1 AXIOM Tool Pass.
 * Cached for 60s. Onchain balanceOf via raw RPC (zero-dep).
 */
export async function hasToolPass(wallet) {
  const w = String(wallet || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(w)) return false;

  const cached = balanceCache.get(w);
  if (cached && Date.now() - cached.ts < BALANCE_TTL) return cached.balance >= 1n;

  try {
    const padded = w.slice(2).padStart(64, "0");
    const r = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: PASS_CONTRACT, data: BALANCE_OF + padded }, "latest"],
      }),
    });
    const j = await r.json();
    const bal = j?.result ? BigInt(j.result) : 0n;
    balanceCache.set(w, { balance: bal, ts: Date.now() });
    return bal >= 1n;
  } catch {
    return false;
  }
}

// ─── tier resolution ──────────────────────────────────────────────────────────

/**
 * Resolve request access tier from headers, with real x402 verification + settlement.
 *
 * Order of evaluation:
 *   1. `x-pass-holder: <wallet>` → onchain Tool Pass balance check
 *      Returns "premium" if ≥1 Pass held.
 *   2. `x-payment: <base64 authorization>` → facilitator verify + settle
 *      Returns "payment" only if both verify and settle succeed onchain.
 *   3. Otherwise → "free"
 *
 * Failed payment verifications/settlements degrade to "free" (the caller still
 * returns HTTP 200 with the free-tier slice; no 402 is sent from this path).
 *
 * @param {import('@vercel/node').VercelRequest} req
 * @param {{ price?: string, resource?: string, description?: string }} [opts]
 * @returns {Promise<"free"|"premium"|"payment">}
 */
export async function resolveTier(req, opts = {}) {
  const passHolder = req.headers["x-pass-holder"];
  if (passHolder && (await hasToolPass(passHolder))) return "premium";

  const xPayment = req.headers["x-payment"];
  if (xPayment) {
    const requirements = buildPaymentRequirements(req, opts);
    const verify = await verifyPayment(requirements, xPayment);
    if (!verify.isValid) return "free";
    const settle = await settlePayment(requirements, xPayment);
    if (!settle.success) return "free";
    return "payment";
  }

  return "free";
}
