/**
 * GET /api/axiom-burn-stats — free demo tier.
 *
 * Returns live $AXIOM burn stats: total burned (canonical balanceOf 0xdEaD +
 * log-sum), event count, % of supply burned, 5 most recent burn txs.
 *
 * Source: Blockscout getLogs + Base RPC eth_call. 30s in-memory cache.
 */

const TOKEN   = "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07";
const DEAD    = "0x000000000000000000000000000000000000dEaD";
const SUPPLY  = 100_000_000_000n;
const D       = 10n ** 18n;

const BLOCKSCOUT     = "https://base.blockscout.com/api";
const BASE_RPC       = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEAD_TOPIC     = "0x000000000000000000000000000000000000000000000000000000000000dead";
const BALANCE_OF     = "0x70a08231";

const CACHE_TTL_MS = 30_000;
let _cache = null;
let _cacheAt = 0;

function fmt(rawBigInt) {
  const whole = rawBigInt / D;
  const frac  = rawBigInt % D;
  return `${whole.toLocaleString()}.${frac.toString().padStart(18, "0").slice(0, 2)}`;
}

async function fetchBurnLogs() {
  const params = new URLSearchParams({
    module: "logs", action: "getLogs",
    address: TOKEN, topic0: TRANSFER_TOPIC,
    topic2: DEAD_TOPIC, topic0_2_opr: "and",
    fromBlock: "0", toBlock: "latest",
  });
  const r = await fetch(`${BLOCKSCOUT}?${params}`);
  const data = await r.json();
  return data.status === "1" ? (data.result ?? []) : [];
}

async function fetchDeadBalance() {
  const padded = DEAD.slice(2).toLowerCase().padStart(64, "0");
  const r = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: TOKEN, data: BALANCE_OF + padded }, "latest"],
    }),
  });
  const j = await r.json();
  return j.result ? BigInt(j.result) : 0n;
}

async function getBurnStats() {
  const [logs, deadBalance] = await Promise.all([fetchBurnLogs(), fetchDeadBalance()]);

  let logTotal = 0n;
  for (const log of logs) logTotal += BigInt(log.data);

  const recent = [...logs].reverse().slice(0, 5).map(log => ({
    txHash:          log.transactionHash,
    blockNumber:     parseInt(log.blockNumber, 16),
    timestamp:       new Date(parseInt(log.timeStamp, 16) * 1000).toISOString(),
    amount:          BigInt(log.data).toString(),
    amountFormatted: fmt(BigInt(log.data)),
  }));

  const supplyRaw = SUPPLY * D;
  return {
    token: TOKEN,
    deadAddress: DEAD,
    fetchedAt: new Date().toISOString(),
    burnStats: {
      fromLogs: {
        totalRaw:   logTotal.toString(),
        total:      fmt(logTotal),
        eventCount: logs.length,
      },
      fromBalanceOf: {
        totalRaw: deadBalance.toString(),
        total:    fmt(deadBalance),
      },
      canonicalBurnedRaw: deadBalance.toString(),
      canonicalBurned:    fmt(deadBalance),
      percentBurned:      ((Number(deadBalance) / Number(supplyRaw)) * 100).toFixed(4) + "%",
    },
    recentBurns: recent,
  };
}

export default async function handler(req, res) {
  try {
    if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
      return res.status(200).json(_cache);
    }
    _cache = await getBurnStats();
    _cacheAt = Date.now();
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    res.status(200).json(_cache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
