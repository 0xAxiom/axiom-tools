/**
 * x402 payment scaffolding for axiom-tools.
 *
 * Implements the x402 PaymentRequired response format (spec v1).
 * Ref: https://x402.org / github.com/coinbase/x402
 *
 * Current state:
 *   - 402 response format: ✓ live
 *   - x-pass-holder onchain gate: ✓ live (balanceOf AXIOM Tool Pass)
 *   - x-payment signature verification: ⧗ TODO (needs x402 facilitator wiring)
 *
 * Until full verification is wired, x-pass-holder is the production gate.
 * x-payment callers who can parse 402s correctly will get the full response
 * once the facilitator is wired.
 */

// ─── constants ────────────────────────────────────────────────────────────────

const PAY_TO     = "0x523Eff3dB03938eaa31a5a6FBd41E3B9d23edde5"; // Axiom treasury
const USDC_BASE  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const BASE_RPC   = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// AXIOM Tool Pass — ERC-721 on Base (placeholder addr; real one TBD)
// When deployed: replace with actual contract address from ERC-8257 registry.
const TOOL_PASS  = process.env.AXIOM_TOOL_PASS || null;

const BALANCE_OF = "0x70a08231"; // ERC-20/721 balanceOf(address) selector

// ─── payment required response ────────────────────────────────────────────────

/**
 * Build and send an HTTP 402 response with the proper x402 PaymentRequired body.
 *
 * @param {object} res      - Node/Vercel response object
 * @param {string} endpoint - Full URL of the gated resource
 * @param {string} desc     - Human-readable description shown in paywalls
 * @param {string} [amount] - USDC atomic units (6 decimals). Default "1000" = $0.001
 */
export function send402(res, endpoint, desc, amount = "1000") {
  const paymentRequired = {
    x402Version: 1,
    error: "Payment required",
    resource: {
      url: endpoint,
      description: desc,
    },
    accepts: [
      {
        scheme: "exact",
        network: "base-mainnet",
        asset: USDC_BASE,
        payTo: PAY_TO,
        maxAmountRequired: amount,
        maxTimeoutSeconds: 300,
        description: desc,
        resource: endpoint,
      },
    ],
  };

  // Some clients look for the header too
  res.setHeader("x-payment-required", "true");
  res.setHeader("content-type", "application/json");
  res.status(402).json(paymentRequired);
}

// ─── pass holder gate ─────────────────────────────────────────────────────────

/**
 * Returns true if the wallet holds ≥ 1 AXIOM Tool Pass (ERC-721).
 * Falls back to false if the contract address isn't configured yet.
 *
 * @param {string} wallet - Checksummed or lowercase 0x address
 */
export async function hasToolPass(wallet) {
  if (!TOOL_PASS) return false;
  if (!wallet || !wallet.startsWith("0x") || wallet.length < 40) return false;

  try {
    const padded = wallet.slice(2).toLowerCase().padStart(64, "0");
    const r = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: TOOL_PASS, data: BALANCE_OF + padded }, "latest"],
      }),
    });
    const j = await r.json();
    if (!j?.result || j.result === "0x" || j.result === "0x0") return false;
    return BigInt(j.result) > 0n;
  } catch {
    return false;
  }
}

// ─── tier resolution ──────────────────────────────────────────────────────────

/**
 * Resolve request access tier from headers.
 *
 * Returns:
 *   "premium"  — x-pass-holder wallet verified onchain as pass holder
 *   "payment"  — x-payment header present (payment received but not yet verified)
 *   "free"     — no elevated header
 */
export async function resolveTier(req) {
  const passHolder = req.headers["x-pass-holder"];
  if (passHolder) {
    const ok = await hasToolPass(passHolder);
    if (ok) return "premium";
  }
  if (req.headers["x-payment"]) {
    // TODO: call x402 facilitator to verify EIP-712 payment proof
    // For now, treat as premium (will tighten once facilitator is wired)
    return "payment";
  }
  return "free";
}
