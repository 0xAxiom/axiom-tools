/**
 * axiom-influence-impact — snapshot refresher.
 *
 * Iterates every token in known-tokens.json, runs the attribution pipeline,
 * and writes a combined snapshot.json. Tokens without a configured
 * geckoterminalPool produce an entry with `error: ...` and an empty
 * leaderboard — they don't block the rest.
 *
 * Wire this into the axiom-tools cron (separate from endpoint-builder)
 * for daily refresh. Run manually:
 *
 *   node tools/axiom-influence-impact/refresh-snapshot.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { computeForToken } from "./index.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dir, "known-tokens.json");
const SNAPSHOT_PATH = path.join(__dir, "snapshot.json");

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const tokens = registry.tokens;

const out = {
  generatedAt: new Date().toISOString(),
  window: "7d",
  description: "Per-token influence-to-volume attribution. See README for methodology.",
  tokens: {},
};

let i = 0;
for (const [symbol, token] of Object.entries(tokens)) {
  // GeckoTerminal free tier is ~30 req/min. Space requests by 3s to stay clear.
  if (i++ > 0) await new Promise(r => setTimeout(r, 3000));
  process.stderr.write(`[${symbol}] computing... `);
  try {
    const result = await computeForToken(token);
    out.tokens[symbol] = result;
    process.stderr.write(`${result.leaderboard.length} authors, baseline $${result.baseline_hourly_usd}/hr\n`);
  } catch (e) {
    out.tokens[symbol] = {
      token: symbol,
      contract: token.contract,
      window: "7d",
      computedAt: new Date().toISOString(),
      error: e.message,
      leaderboard: [],
    };
    process.stderr.write(`FAILED: ${e.message}\n`);
  }
}

writeFileSync(SNAPSHOT_PATH, JSON.stringify(out, null, 2) + "\n");
console.log(`influence-impact snapshot → ${Object.keys(out.tokens).length} tokens`);
