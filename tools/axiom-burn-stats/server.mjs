/**
 * axiom-burn-stats — HTTP server
 *
 * Zero-dep Node.js server (built-in http module only).
 * Caches results for CACHE_TTL_MS to avoid hammering Blockscout.
 *
 * Routes:
 *   GET /api/axiom-burn-stats              → burn stats JSON
 *   GET /.well-known/ai-tool/axiom-burn-stats.json  → ERC-8257 manifest
 *   GET /health                            → {"status":"ok"}
 *
 * Usage:
 *   PORT=3457 node tools/axiom-burn-stats/server.mjs
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = parseInt(process.env.PORT ?? "3457", 10);
const CACHE_TTL_MS = 30_000; // 30 seconds

// ─── resolve manifest path relative to repo root ─────────────────────────────
const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dir, "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, ".well-known/ai-tool/axiom-burn-stats.json");

// ─── inline the burn-stats core logic (no cross-file import needed) ──────────
const TOKEN   = "0xf3Ce5dDAAb6C133F9875a4a46C55cf0b58111B07";
const DEAD    = "0x000000000000000000000000000000000000dEaD";
const SUPPLY  = 100_000_000_000n;

const BLOCKSCOUT     = "https://base.blockscout.com/api";
const BASE_RPC       = "https://mainnet.base.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEAD_TOPIC     = "0x000000000000000000000000000000000000000000000000000000000000dead";
const BALANCE_OF_SIG = "0x70a08231";

function tokenUnits(rawBigInt, decimals = 18) {
  const d = 10n ** BigInt(decimals);
  return `${(rawBigInt / d).toLocaleString()}.${(rawBigInt % d).toString().padStart(18, "0").slice(0, 2)}`;
}

async function fetchBurnLogs() {
  const params = new URLSearchParams({
    module: "logs", action: "getLogs",
    address: TOKEN, topic0: TRANSFER_TOPIC,
    topic2: DEAD_TOPIC, topic0_2_opr: "and",
    fromBlock: "0", toBlock: "latest",
  });
  const data = await (await fetch(`${BLOCKSCOUT}?${params}`)).json();
  return data.status === "1" ? (data.result ?? []) : [];
}

async function fetchDeadBalance() {
  const padded = DEAD.slice(2).toLowerCase().padStart(64, "0");
  const j = await (await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: TOKEN, data: BALANCE_OF_SIG + padded }, "latest"] }),
  })).json();
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
    amountFormatted: tokenUnits(BigInt(log.data)),
  }));

  const supplyRaw = SUPPLY * (10n ** 18n);
  return {
    token: TOKEN, deadAddress: DEAD,
    fetchedAt: new Date().toISOString(),
    burnStats: {
      fromLogs: {
        totalRaw:   logTotal.toString(),
        total:      tokenUnits(logTotal),
        eventCount: logs.length,
      },
      fromBalanceOf: {
        totalRaw: deadBalance.toString(),
        total:    tokenUnits(deadBalance),
      },
      canonicalBurnedRaw: deadBalance.toString(),
      canonicalBurned:    tokenUnits(deadBalance),
      percentBurned:      ((Number(deadBalance) / Number(supplyRaw)) * 100).toFixed(4) + "%",
    },
    recentBurns: recent,
  };
}

// ─── cache ────────────────────────────────────────────────────────────────────
let _cache = null;
let _cacheAt = 0;

async function getCached() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;
  _cache = await getBurnStats();
  _cacheAt = Date.now();
  return _cache;
}

// ─── server ───────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split("?")[0] ?? "/";

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  if (url === "/health") {
    return json(res, 200, { status: "ok", tool: "axiom-burn-stats" });
  }

  if (url === "/api/axiom-burn-stats") {
    try {
      const stats = await getCached();
      return json(res, 200, stats);
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (url === "/.well-known/ai-tool/axiom-burn-stats.json") {
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
      return json(res, 200, manifest);
    } catch {
      return json(res, 404, { error: "manifest not found" });
    }
  }

  return json(res, 404, { error: "not found", routes: [
    "/api/axiom-burn-stats",
    "/.well-known/ai-tool/axiom-burn-stats.json",
    "/health",
  ]});
});

server.listen(PORT, () => {
  console.log(`axiom-burn-stats server → http://localhost:${PORT}`);
  console.log(`  GET /api/axiom-burn-stats`);
  console.log(`  GET /.well-known/ai-tool/axiom-burn-stats.json`);
  console.log(`  GET /health`);
});
