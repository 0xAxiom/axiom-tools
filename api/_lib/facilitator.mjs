/**
 * x402 facilitator client — verify and settle payment authorizations.
 *
 * Default facilitator: Coinbase's public endpoint at https://x402.org/facilitator
 * (no auth required). Override via X402_FACILITATOR_URL.
 *
 * If CDP_API_KEY_ID + CDP_API_KEY_SECRET are set, those headers are passed
 * through for facilitators that accept CDP-keyed access. The public facilitator
 * ignores them.
 *
 * Zero deps — pure fetch.
 *
 * Spec: https://github.com/coinbase/x402
 */

const FACILITATOR_URL =
  (process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator").replace(/\/$/, "");

const CDP_KEY_ID     = process.env.CDP_API_KEY_ID     || null;
const CDP_KEY_SECRET = process.env.CDP_API_KEY_SECRET || null;

const PAY_TO_DEFAULT = process.env.X402_PAY_TO || "0x523Eff3dB03938eaa31a5a6FBd41E3B9d23edde5";
const USDC_BASE      = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK        = process.env.X402_NETWORK || "base";
const FACILITATOR_TIMEOUT_MS = 15_000;

function authHeaders() {
  const h = { "content-type": "application/json", "accept": "application/json" };
  if (CDP_KEY_ID && CDP_KEY_SECRET) {
    h["x-cdp-key-id"]     = CDP_KEY_ID;
    h["x-cdp-key-secret"] = CDP_KEY_SECRET;
  }
  return h;
}

/**
 * Convert dollars (e.g. "0.01") to USDC atomic units (6 decimals).
 * "0.001" → "1000"; "0.01" → "10000"; "1" → "1000000".
 */
export function dollarsToAtomicUSDC(dollarsStr) {
  const n = Number(dollarsStr);
  if (!Number.isFinite(n) || n < 0) return "0";
  return Math.round(n * 1_000_000).toString();
}

/**
 * Build the paymentRequirements object the client must have used to construct
 * its signed authorization. Must match byte-for-byte (network, asset, payTo,
 * resource, maxAmountRequired) or the facilitator will reject.
 */
export function buildPaymentRequirements(req, opts = {}) {
  const proto    = req.headers["x-forwarded-proto"] || "https";
  const host     = req.headers["x-forwarded-host"]  || req.headers.host;
  const resource = opts.resource ?? `${proto}://${host}${req.url}`;
  const atomic   = dollarsToAtomicUSDC(opts.price ?? "0.01");

  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: atomic,
    asset: USDC_BASE,
    payTo: opts.payTo || PAY_TO_DEFAULT,
    resource,
    description: opts.description ?? "AXIOM agentic tool endpoint",
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

async function callFacilitator(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FACILITATOR_TIMEOUT_MS);
  try {
    const r = await fetch(`${FACILITATOR_URL}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { ok: r.ok, status: r.status, json, raw: text };
  } catch (e) {
    return { ok: false, status: 0, json: null, raw: null, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Verify a payment authorization with the facilitator. Does NOT move funds.
 * @returns {Promise<{isValid: boolean, payer?: string, reason?: string}>}
 */
export async function verifyPayment(paymentRequirements, paymentPayloadB64) {
  const r = await callFacilitator("/verify", {
    paymentRequirements,
    paymentPayload: paymentPayloadB64,
  });
  if (!r.ok) {
    const detail = r.error || (r.raw || "").slice(0, 200);
    return { isValid: false, reason: `facilitator /verify ${r.status}: ${detail}` };
  }
  const j = r.json || {};
  return {
    isValid: j.isValid === true,
    payer:   j.payer || j.payerAddress || null,
    reason:  j.invalidReason || j.error || null,
  };
}

/**
 * Settle a verified payment onchain. Transfers USDC from payer to payTo.
 * @returns {Promise<{success: boolean, transaction?: string, payer?: string, network?: string, reason?: string}>}
 */
export async function settlePayment(paymentRequirements, paymentPayloadB64) {
  const r = await callFacilitator("/settle", {
    paymentRequirements,
    paymentPayload: paymentPayloadB64,
  });
  if (!r.ok) {
    const detail = r.error || (r.raw || "").slice(0, 200);
    return { success: false, reason: `facilitator /settle ${r.status}: ${detail}` };
  }
  const j = r.json || {};
  return {
    success:     j.success === true,
    transaction: j.transaction || j.txHash || null,
    payer:       j.payer || j.payerAddress || null,
    network:     j.network || NETWORK,
    reason:      j.errorReason || j.error || null,
  };
}

/**
 * Encode the settlement result as the value for the X-Payment-Response header
 * (base64 JSON). Clients use it to retrieve the settlement transaction hash.
 */
export function encodeSettleResponse(settleResult) {
  const obj = {
    success:     !!settleResult.success,
    transaction: settleResult.transaction || null,
    network:     settleResult.network || NETWORK,
    payer:       settleResult.payer || null,
  };
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}
