/**
 * Shared access gate for paid tools.
 *
 * Two ways to pass:
 *   1. `x-pass-holder: <wallet>` header. We verify the wallet's AXIOM Tool
 *      Pass balance onchain via raw RPC (zero-dep). balance >= 1 → free.
 *   2. `x-payment: <envelope>` header. x402 verifier upstream is expected to
 *      have validated this; we trust it. (TODO: facilitator-side verify.)
 *
 * Otherwise: return the x402 payment-required envelope (HTTP 402).
 *
 * Free endpoints skip the gate entirely.
 */

const PASS_CONTRACT = "0xfc9ce3990f85fA1A3a0eE51a710642396a6Cad82";
const USDC_BASE     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC      = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const BALANCE_OF    = "0x70a08231";

const balanceCache = new Map(); // wallet → { balance: bigint, ts: number }
const BALANCE_TTL  = 60_000; // 60s — pass holdings don't churn

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
 * @param {{ price?: string, resource?: string }} opts
 * @returns {Promise<{ allowed: boolean, payment?: { type: 'pass'|'x402', wallet?: string } }>}
 *   If allowed=false, the caller should respond 402 with `envelope`.
 */
export async function checkAccess(req, opts = {}) {
  const wallet = req.headers["x-pass-holder"];
  if (wallet) {
    const bal = await passBalance(wallet);
    if (bal >= 1n) return { allowed: true, payment: { type: "pass", wallet } };
  }

  if (req.headers["x-payment"]) {
    // Upstream facilitator (or middleware) is expected to verify. Trust for now.
    return { allowed: true, payment: { type: "x402" } };
  }

  const price = opts.price ?? "0.01";
  const proto = (req.headers["x-forwarded-proto"] || "https");
  const host  = req.headers["x-forwarded-host"] || req.headers.host;
  const resource = opts.resource ?? `${proto}://${host}${req.url}`;

  return {
    allowed: false,
    envelope: {
      x402Version: 1,
      accepts: [{
        scheme: "exact",
        network: "base",
        maxAmountRequired: price,
        asset: USDC_BASE,
        resource,
        description: "AXIOM Tool Pass holders bypass this paywall — send x-pass-holder: <wallet>",
      }],
    },
  };
}
