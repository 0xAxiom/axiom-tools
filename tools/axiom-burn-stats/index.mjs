/**
 * axiom-burn-stats
 * Reads $AXIOM burn events from Blockscout (Base).
 * Returns: total burned (from logs + from balanceOf), event count, most-recent burns.
 *
 * Usage:
 *   node index.mjs              → JSON output
 *   node index.mjs --pretty     → formatted summary
 */

const TOKEN   = "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07";
const DEAD    = "0x000000000000000000000000000000000000dEaD";
const SUPPLY  = 100_000_000_000n; // 100B, 18 decimals assumed but we work in raw BigInt

const BLOCKSCOUT = "https://base.blockscout.com/api";
const BASE_RPC   = "https://mainnet.base.org";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// DEAD address, padded to 32 bytes as a topic
const DEAD_TOPIC     = "0x000000000000000000000000000000000000000000000000000000000000dead";

// ERC-20 balanceOf(address) selector
const BALANCE_OF_SIG = "0x70a08231";

// ─── helpers ──────────────────────────────────────────────────────────────────

function hexToDecimal(hex) {
  return BigInt(hex);
}

function tokenUnits(rawBigInt, decimals = 18) {
  const d = 10n ** BigInt(decimals);
  const whole = rawBigInt / d;
  const frac  = rawBigInt % d;
  return `${whole.toLocaleString()}.${frac.toString().padStart(18, "0").slice(0, 2)}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// ─── blockscout getLogs ────────────────────────────────────────────────────────

async function fetchBurnLogs() {
  const params = new URLSearchParams({
    module:       "logs",
    action:       "getLogs",
    address:      TOKEN,
    topic0:       TRANSFER_TOPIC,
    topic2:       DEAD_TOPIC,
    topic0_2_opr: "and",
    fromBlock:    "0",
    toBlock:      "latest",
  });

  const data = await fetchJson(`${BLOCKSCOUT}?${params}`);

  if (data.status !== "1") {
    // status 0 with empty result just means no logs found yet
    return [];
  }

  return data.result ?? [];
}

// ─── balanceOf via RPC ────────────────────────────────────────────────────────

async function fetchDeadBalance() {
  const padded = DEAD.slice(2).toLowerCase().padStart(64, "0");
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: TOKEN, data: BALANCE_OF_SIG + padded },
        "latest",
      ],
    }),
  });
  const j = await res.json();
  if (!j.result) return 0n;
  return BigInt(j.result);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function getBurnStats() {
  const [logs, deadBalance] = await Promise.all([
    fetchBurnLogs(),
    fetchDeadBalance(),
  ]);

  // Sum log amounts
  let logTotal = 0n;
  for (const log of logs) {
    logTotal += hexToDecimal(log.data);
  }

  // Recent 5 burns (logs are oldest-first from blockscout; reverse for recency)
  const recent = [...logs].reverse().slice(0, 5).map(log => ({
    txHash:    log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
    timestamp: new Date(parseInt(log.timeStamp, 16) * 1000).toISOString(),
    amount:    hexToDecimal(log.data).toString(),
    amountFormatted: tokenUnits(hexToDecimal(log.data)),
  }));

  const decimals = 18;
  const D = 10n ** BigInt(decimals);
  const supplyRaw = SUPPLY * D;

  return {
    token:           TOKEN,
    deadAddress:     DEAD,
    fetchedAt:       new Date().toISOString(),
    burnStats: {
      fromLogs: {
        totalRaw:       logTotal.toString(),
        total:          tokenUnits(logTotal),
        eventCount:     logs.length,
      },
      fromBalanceOf: {
        totalRaw:       deadBalance.toString(),
        total:          tokenUnits(deadBalance),
      },
      // canonical = balanceOf (includes any pre-indexing burns)
      canonicalBurnedRaw: deadBalance.toString(),
      canonicalBurned:    tokenUnits(deadBalance),
      percentBurned:      ((Number(deadBalance) / Number(supplyRaw)) * 100).toFixed(4) + "%",
    },
    recentBurns: recent,
  };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const pretty = process.argv.includes("--pretty");

try {
  const stats = await getBurnStats();

  if (pretty) {
    const b = stats.burnStats;
    console.log(`\n$AXIOM Burn Stats (${stats.fetchedAt})`);
    console.log("─────────────────────────────────────────");
    console.log(`Burned (balanceOf DEAD): ${b.fromBalanceOf.total} AXIOM`);
    console.log(`Burned (log sum):        ${b.fromLogs.total} AXIOM (${b.fromLogs.eventCount} events)`);
    console.log(`% of supply burned:      ${b.percentBurned}`);
    if (stats.recentBurns.length) {
      console.log("\nMost recent burns:");
      for (const r of stats.recentBurns) {
        console.log(`  ${r.timestamp}  ${r.amountFormatted} AXIOM  (${r.txHash.slice(0,10)}…)`);
      }
    }
    console.log();
  } else {
    console.log(JSON.stringify(stats, null, 2));
  }
} catch (err) {
  console.error("axiom-burn-stats error:", err.message);
  process.exit(1);
}
