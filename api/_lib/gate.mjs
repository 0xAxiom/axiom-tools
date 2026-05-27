/**
 * Shared access gate for paid tools.
 *
 * Two ways to pass:
 *   1. `x-pass-holder: <wallet>` header. We verify the wallet's AXIOM Tool
 *      Pass balance onchain via raw RPC (zero-dep). balance >= 1 → free access.
 *   2. `x-payment: <base64 authorization>` header. We call the x402 facilitator
 *      to verify the signed authorization and settle it onchain. Settlement
 *      transfers USDC from the payer to the Axiom treasury before access is
 *      granted. If either step fails, return 402.
 *
 * Otherwise: return the x402 payment-required envelope (HTTP 402).
 *
 * Free endpoints skip the gate entirely.
 */

import {
  buildPaymentRequirements,
  verifyPayment,
  settlePayment,
  encodeSettleResponse,
} from "./facilitator.mjs";

const PASS_CONTRACT = "0xfc9ce3990f85fA1A3a0eE51a710642396a6Cad82";
const BASE_RPC      = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const BALANCE_OF    = "0x70a08231";

const balanceCache = new Map(); // wallet → { balance: bigint, ts: number }
const BALANCE_TTL  = 60_000;     // 60s — pass holdings don't churn

async function passBalance(wallet) {
  const w = String(wallet).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(w)) return 0n;

  const cached = balanceCache.get(w);
  if (cached && Date.now() - cached.ts < BALANCE_TTL) return cached.balance;

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
  const bal = j.result ? BigInt(j.result) : 0n;
  balanceCache.set(w, { balance: bal, ts: Date.now() });
  return bal;
}

/**
 * @param {import('@vercel/node').VercelRequest} req
 * @param {{ price?: string, resource?: string, description?: string, payTo?: string }} opts
 * @returns {Promise<{
 *   allowed: boolean,
 *   payment?: { type: 'pass'|'x402', wallet?: string, transaction?: string, verified?: boolean },
 *   envelope?: object,
 *   settleResponseHeader?: string
 * }>}
 *
 * Caller behavior:
 *   - If `allowed === false`, respond `res.status(402).json(envelope)`.
 *   - If `allowed === true` and `settleResponseHeader` is set, set the
 *     `x-payment-response` header on the response so the client can retrieve
 *     the settlement transaction hash.
 */
export async function checkAccess(req, opts = {}) {
  // Path 1 — Tool Pass NFT (free for holders)
  const wallet = req.headers["x-pass-holder"];
  if (wallet) {
    const bal = await passBalance(wallet);
    if (bal >= 1n) return { allowed: true, payment: { type: "pass", wallet } };
  }

  // Path 2 — x402 payment authorization (verify + settle inline)
  const xPayment = req.headers["x-payment"];
  if (xPayment) {
    const paymentRequirements = buildPaymentRequirements(req, opts);

    const verify = await verifyPayment(paymentRequirements, xPayment);
    if (!verify.isValid) {
      return {
        allowed: false,
        envelope: {
          x402Version: 1,
          error: `payment verification failed: ${verify.reason || "unknown"}`,
          accepts: [paymentRequirements],
        },
      };
    }

    const settle = await settlePayment(paymentRequirements, xPayment);
    if (!settle.success) {
      return {
        allowed: false,
        envelope: {
          x402Version: 1,
          error: `payment settlement failed: ${settle.reason || "unknown"}`,
          accepts: [paymentRequirements],
        },
      };
    }

    return {
      allowed: true,
      payment: {
        type: "x402",
        wallet: settle.payer || verify.payer,
        transaction: settle.transaction,
        verified: true,
      },
      settleResponseHeader: encodeSettleResponse(settle),
    };
  }

  // Path 3 — no payment header: return 402 with payment requirements
  const paymentRequirements = buildPaymentRequirements(req, opts);
  return {
    allowed: false,
    envelope: {
      x402Version: 1,
      accepts: [paymentRequirements],
    },
  };
}
