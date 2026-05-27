/**
 * axiom-whale-alerts
 *
 * Pure data-gathering logic. No HTTP. Importable from the api handler.
 *
 * Pulls recent ERC-20 Transfer logs for $AXIOM on Base, filters them by
 * USD value (using DexScreener price), and tags each transfer with one
 * of seven cohort labels:
 *
 *   staker             — destination is the StakedAxiom (ERC-4626) vault
 *   exchange-deposit   — destination is a known CEX hot wallet
 *   exchange-withdraw  — source is a known CEX hot wallet
 *   dumper             — destination is a DEX pair (i.e. selling into the pool)
 *   LP-remove          — source is a DEX pair, destination is a known LP position manager
 *   LP-add             — source is a known LP position manager
 *   new-wallet         — recipient has zero prior tx history (first appearance)
 *
 * Transfers that don't match any of the above are dropped — the value of
 * this endpoint is the tag, not raw log noise.
 *
 * Usage:
 *   node index.mjs                       → JSON (default threshold $1k, last ~3h)
 *   node index.mjs --pretty              → formatted summary
 *   node index.mjs --threshold 250       → set USD threshold
 *   node index.mjs --blocks 1500         → lookback window in blocks
 */

const TOKEN          = "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07";
const BASE_RPC       = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const D              = 10n ** 18n;

// ~2s/block on Base → 5000 blocks ≈ 2h 45m. Keeps us well under any
// public-RPC eth_getLogs range cap (most cap at 10k blocks).
const LOOKBACK_BLOCKS_DEFAULT = 5000;

// StakedAxiom ERC-4626 vault — not yet deployed at time of writing.
// Set via env when shipped.
const STAKED_AXIOM = (process.env.STAKED_AXIOM_ADDRESS || "").toLowerCase();

// Known LP position managers on Base. Direct pair transfers from these
// addresses are LP mints; transfers to these from pairs are LP burns.
const POSITION_MANAGERS = new Set([
  "0x03a520b32c04bf3beef7beb72e919cf822ed34f1", // Uniswap V3 NonfungiblePositionManager (Base)
  "0x827922686190790b37229fd06084350e74485b72", // Aerodrome Slipstream NPM
  "0x7c5f5a4bbd8fd63184577525326123b519429bdc", // Uniswap V4 PositionManager (Base)
].map(s => s.toLowerCase()));

// Uniswap V4 on Base uses a singleton PoolManager — there is no per-pool
// contract address. DexScreener returns the V4 poolId (32-byte hash) in
// `pairAddress` for V4 pools, which is NOT a contract. We substitute the
// singleton PoolManager + the V4 Universal Router so the pair-based
// classification rules still fire.
const V4_AUGMENTED = new Set([
  "0x498581ff718922c3f8e6a244956af099b2652b2b", // Uniswap V4 PoolManager (Base, singleton)
  "0x6ff5693b99212da76ad316178a184ab56d299b43", // Uniswap Universal Router v2 (Base)
].map(s => s.toLowerCase()));

// Known CEX hot wallets on Base. Conservatively empty by default — false
// positives are worse than missed tags. Extend via env (comma-separated)
// when reliable hot-wallet intel is available.
const KNOWN_CEX = new Set(
  (process.env.AXIOM_KNOWN_CEX || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// ─── rpc ──────────────────────────────────────────────────────────────────────

async function rpc(method, params) {
  const r = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  if (j.result === undefined || j.result === null) {
    throw new Error(`${method}: empty result from Base RPC`);
  }
  return j.result;
}

// JSON-RPC batch: one HTTP call for N independent reads. Public RPCs throttle
// per-request, so a batch is dramatically cheaper than serial calls.
async function rpcBatch(calls) {
  if (calls.length === 0) return [];
  const payload = calls.map((c, i) => ({
    jsonrpc: "2.0", id: i, method: c.method, params: c.params,
  }));
  const r = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!Array.isArray(j)) {
    throw new Error(`rpc batch: non-array response (${JSON.stringify(j).slice(0, 200)})`);
  }
  // Reorder by id — providers don't guarantee order.
  const out = new Array(calls.length);
  for (const resp of j) {
    if (resp.error) throw new Error(`${calls[resp.id].method}: ${resp.error.message}`);
    out[resp.id] = resp.result;
  }
  return out;
}

// ─── dexscreener (pair discovery + price) ─────────────────────────────────────

async function fetchPairsAndPrice() {
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/base/${TOKEN}`);
  if (!r.ok) throw new Error(`dexscreener HTTP ${r.status}`);
  const data = await r.json();
  const pairsArr = Array.isArray(data) ? data : (data.pairs || []);

  const pairAddrs = new Set();
  let sawV4 = false;
  for (const p of pairsArr) {
    const addr = (p.pairAddress || "").toLowerCase();
    if (!addr) continue;
    // V4 poolIds are 64 hex chars; real contract addresses are 40. The
    // poolId isn't a contract — substitute V4 singleton + router below.
    if (addr.length === 42) pairAddrs.add(addr);
    if ((p.labels || []).includes("v4") || addr.length > 42) sawV4 = true;
  }
  if (sawV4) for (const a of V4_AUGMENTED) pairAddrs.add(a);

  // Largest-liquidity pair's price wins. If none, fall back to first non-zero.
  let priceUsd = 0;
  let bestLiq = -1;
  for (const p of pairsArr) {
    const liq = Number(p?.liquidity?.usd || 0);
    const px  = Number(p?.priceUsd || 0);
    if (px > 0 && liq > bestLiq) {
      bestLiq = liq;
      priceUsd = px;
    }
  }
  if (priceUsd === 0) {
    for (const p of pairsArr) {
      const px = Number(p?.priceUsd || 0);
      if (px > 0) { priceUsd = px; break; }
    }
  }

  return { pairs: pairAddrs, priceUsd };
}

// ─── log fetch ────────────────────────────────────────────────────────────────

async function fetchTransfers(fromBlock, toBlock) {
  const logs = await rpc("eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock:   "0x" + toBlock.toString(16),
    address:   TOKEN,
    topics:    [TRANSFER_TOPIC],
  }]);
  return logs.map(l => ({
    blockNumber: parseInt(l.blockNumber, 16),
    txHash:      l.transactionHash,
    logIndex:    parseInt(l.logIndex, 16),
    from:        "0x" + l.topics[1].slice(26),
    to:          "0x" + l.topics[2].slice(26),
    amount:      BigInt(l.data),
  }));
}

// ─── formatting ───────────────────────────────────────────────────────────────

function fmt(rawBigInt) {
  const whole = rawBigInt / D;
  const frac  = rawBigInt % D;
  return `${whole.toLocaleString()}.${frac.toString().padStart(18, "0").slice(0, 2)}`;
}

function tokensFloat(raw) {
  // Lossy below 1 wei precision, but fine for USD valuation of whale-sized amounts.
  return Number(raw) / 1e18;
}

// ─── classification ───────────────────────────────────────────────────────────

// First-pass classification — uses only address-set membership. Returns the
// cohort label or "needs-tx-count" for candidates we can't decide locally.
function classifySync(t, ctx) {
  const from = t.from.toLowerCase();
  const to   = t.to.toLowerCase();

  if (ctx.stakedAxiom && to === ctx.stakedAxiom) return "staker";
  if (ctx.cex.has(to))                            return "exchange-deposit";
  if (ctx.cex.has(from))                          return "exchange-withdraw";

  if (ctx.pairs.has(to)) return "dumper"; // direct transfer to pool = swap-in
  if (ctx.pairs.has(from)) {
    if (ctx.positionMgrs.has(to)) return "LP-remove";
    return null; // pool → arbitrary wallet = buy. Not whale-alert grade.
  }
  if (ctx.positionMgrs.has(from)) return "LP-add";

  return "needs-tx-count";
}

// ─── main ─────────────────────────────────────────────────────────────────────

export async function getWhaleEvents({
  thresholdUsd   = 1000,
  lookbackBlocks = LOOKBACK_BLOCKS_DEFAULT,
} = {}) {
  const head = parseInt(await rpc("eth_blockNumber", []), 16);
  const fromBlock = Math.max(0, head - lookbackBlocks);

  const [{ pairs, priceUsd }, transfers] = await Promise.all([
    fetchPairsAndPrice(),
    fetchTransfers(fromBlock, head),
  ]);

  if (priceUsd <= 0) {
    throw new Error("no priceUsd available from DexScreener — token has no live pair");
  }

  const ctx = {
    pairs,
    cex:          KNOWN_CEX,
    positionMgrs: POSITION_MANAGERS,
    stakedAxiom:  STAKED_AXIOM,
  };

  // First-pass amount filter — cuts the candidate set before any extra RPC calls.
  const meetsThreshold = (raw) => tokensFloat(raw) * priceUsd >= thresholdUsd;
  const candidates = transfers.filter(t => meetsThreshold(t.amount));

  // First-pass classification (zero RPC). Anything labeled "needs-tx-count"
  // gets resolved in a batched second pass below.
  const tagged = candidates
    .map(t => ({ t, cohort: classifySync(t, ctx) }))
    .filter(x => x.cohort !== null);

  // Batched eth_getTransactionCount for the "needs-tx-count" candidates,
  // and batched eth_getBlockByNumber for every block we'll emit. One round
  // trip each — friendly to the public RPC.
  const needsTxCount = tagged.filter(x => x.cohort === "needs-tx-count");
  const uniqueRecipients = [...new Set(needsTxCount.map(x => x.t.to.toLowerCase()))];
  const uniqueBlocks     = [...new Set(tagged.map(x => x.t.blockNumber))];

  const [txCounts, blocks] = await Promise.all([
    rpcBatch(uniqueRecipients.map(a => ({
      method: "eth_getTransactionCount",
      params: [a, "latest"],
    }))),
    rpcBatch(uniqueBlocks.map(n => ({
      method: "eth_getBlockByNumber",
      params: ["0x" + n.toString(16), false],
    }))),
  ]);

  const txCountByAddr = new Map();
  uniqueRecipients.forEach((a, i) => txCountByAddr.set(a, parseInt(txCounts[i], 16)));
  const tsByBlock = new Map();
  uniqueBlocks.forEach((n, i) => tsByBlock.set(n, blocks[i] ? parseInt(blocks[i].timestamp, 16) : 0));

  const events = [];
  for (const { t, cohort: pre } of tagged) {
    let cohort = pre;
    if (cohort === "needs-tx-count") {
      const n = txCountByAddr.get(t.to.toLowerCase());
      if (n === 0) cohort = "new-wallet";
      else continue; // not classifiable into one of the seven tags — drop
    }
    const ts = tsByBlock.get(t.blockNumber) || 0;
    const tokens = tokensFloat(t.amount);
    events.push({
      cohort,
      txHash:      t.txHash,
      logIndex:    t.logIndex,
      blockNumber: t.blockNumber,
      timestamp:   new Date(ts * 1000).toISOString(),
      from:        t.from,
      to:          t.to,
      amountRaw:   t.amount.toString(),
      amount:      fmt(t.amount),
      tokens,
      valueUsd:    Math.round(tokens * priceUsd * 100) / 100,
    });
  }

  // V4/router swap settlement can emit multiple Transfer logs per swap
  // (user→router, router→poolManager). Both tag identically and would
  // double-count. Dedupe to the lowest-logIndex entry per tx — that's the
  // one originating from the actual user wallet.
  const byTx = new Map();
  for (const e of events) {
    const prev = byTx.get(e.txHash);
    if (!prev || e.logIndex < prev.logIndex) byTx.set(e.txHash, e);
  }
  const deduped = [...byTx.values()];
  deduped.sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));

  const cohortCounts = deduped.reduce((acc, e) => {
    acc[e.cohort] = (acc[e.cohort] || 0) + 1;
    return acc;
  }, {});

  return {
    token: TOKEN,
    fetchedAt: new Date().toISOString(),
    priceUsd,
    window: {
      fromBlock,
      toBlock: head,
      blocks:  head - fromBlock,
    },
    thresholdUsd,
    discoveredPairs: [...pairs],
    knownCexCount:   KNOWN_CEX.size,
    stakedAxiomConfigured: Boolean(STAKED_AXIOM),
    cohortCounts,
    events: deduped,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isCli = import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  const args = process.argv.slice(2);
  const pretty = args.includes("--pretty");
  const tIdx = args.indexOf("--threshold");
  const bIdx = args.indexOf("--blocks");
  const thresholdUsd   = tIdx >= 0 ? Number(args[tIdx + 1]) : 100; // low default = smoke-friendly
  const lookbackBlocks = bIdx >= 0 ? Number(args[bIdx + 1]) : LOOKBACK_BLOCKS_DEFAULT;

  const result = await getWhaleEvents({ thresholdUsd, lookbackBlocks });

  if (pretty) {
    console.log(`\n$AXIOM Whale Alerts (${result.fetchedAt})`);
    console.log("──────────────────────────────────────────────");
    console.log(`Price:           $${result.priceUsd}`);
    console.log(`Window:          blocks ${result.window.fromBlock} → ${result.window.toBlock} (${result.window.blocks} blocks)`);
    console.log(`Threshold:       $${result.thresholdUsd}`);
    console.log(`Pairs found:     ${result.discoveredPairs.length}`);
    console.log(`StakedAxiom set: ${result.stakedAxiomConfigured ? "yes" : "no (pre-launch)"}`);
    console.log(`Tagged events:   ${result.events.length}`);
    console.log("Cohorts:        ", JSON.stringify(result.cohortCounts));
    if (result.events.length) {
      console.log("\nRecent tagged transfers:");
      for (const e of result.events.slice(0, 15)) {
        const c = e.cohort.padEnd(18);
        console.log(`  [${c}] ${e.timestamp}  ${e.amount} AXIOM  $${e.valueUsd.toLocaleString()}  ${e.txHash.slice(0, 12)}…`);
      }
    }
    console.log();
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
