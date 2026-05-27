#!/usr/bin/env node
// axiom-tools endpoint-builder cron.
// Fires 3x/day via launchd. Each fire:
//   1. Picks the first pending entry in endpoint-seeds.json.
//   2. Spawns Claude Code in a fresh tool directory with a build spec.
//   3. Verifies output, commits to axiom-tools main, pushes to GitHub.
//   4. Deploys to Vercel (one project per tool).
//   5. Flips status to "built" (or "failed" with last_error).
//   6. Pings Telegram with the outcome.
//
// ERC-8257 registry registration is not yet wired here — that's a follow-up
// step once the registry's ABI is validated against the deployed contract at
// 0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SEEDS_PATH = resolve(SCRIPT_DIR, "endpoint-seeds.json");
const LOG_PATH = resolve(REPO_ROOT, "state/endpoint-builder-log.jsonl");
const DEMAND_LOG_PATH = resolve(REPO_ROOT, "state/demand-signals.jsonl");
const IDEABANK_PATH = "/Users/axiom/clawd/ideabank.md";
const TELEGRAM_TARGET = "2104116566"; // Melted's chat ID

// ---- helpers --------------------------------------------------------------

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: "utf8",
  }).toString().trim();
}

function logEvent(event) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

function loadSeeds() {
  return JSON.parse(readFileSync(SEEDS_PATH, "utf8"));
}

function saveSeeds(s) {
  writeFileSync(SEEDS_PATH, JSON.stringify(s, null, 2) + "\n");
}

function pickNext(seeds) {
  const pending = seeds.endpoints.filter((e) => e.status === "pending");
  if (pending.length === 0) return null;
  // priority: lower number = higher priority. Entries without priority sort last.
  pending.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return pending[0];
}

// Read ideabank.md (fed by twitter-explore Step 8) and pull demand signals
// from the live section above the fossil divider. The cron logs these every
// fire so picks can be cross-checked against what agents/users are actually
// asking for. This is the "consult ideabank before building" hook Melted
// directed on 2026-05-26.
function readIdeabankSignals() {
  if (!existsSync(IDEABANK_PATH)) return { error: "ideabank.md not found", signals: [] };
  const raw = readFileSync(IDEABANK_PATH, "utf8");
  // Live section is at the top, above the first `---` horizontal rule that
  // serves as the live/fossil divider (see project-ideabank-twitter-capture).
  const lines = raw.split("\n");
  const liveEnd = lines.findIndex((l, i) => i > 5 && /^---\s*$/.test(l));
  const live = (liveEnd === -1 ? lines : lines.slice(0, liveEnd)).join("\n");

  // Heuristic signal extraction: any line that mentions tool / endpoint /
  // api / signal / data + a noun, or any bulleted line. Capped at 30 to
  // keep the cron log readable.
  const signals = [];
  const wanted = /\b(tool|endpoint|api|signal|metric|score|data|alert|leaderboard|forecast|projection|attribution|cohort|whale|narrative)\b/i;
  for (const line of live.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (!/^[-*#|]/.test(t)) continue;
    if (!wanted.test(t)) continue;
    signals.push(t.slice(0, 240));
    if (signals.length >= 30) break;
  }
  return { signals, liveSectionBytes: live.length };
}

function telegramPing(message) {
  // Use the openclaw CLI if available; otherwise no-op (log only).
  try {
    spawnSync(
      "/usr/bin/env",
      ["openclaw", "message", "send", "--target", TELEGRAM_TARGET, "--message", message],
      { stdio: "ignore", timeout: 30_000 },
    );
  } catch {}
}

// ---- main -----------------------------------------------------------------

async function main() {
  const seeds = loadSeeds();

  // 0. Consult ideabank.md FIRST. Log what users/agents are actually asking
  // for, so the pick can be cross-checked against demand instead of just
  // marching down the static seed list. Required by Melted 2026-05-26 —
  // axiom-burn-stats shipped against the static list and was correctly
  // flagged as "Dune query in a trench coat."
  const demand = readIdeabankSignals();
  mkdirSync(dirname(DEMAND_LOG_PATH), { recursive: true });
  appendFileSync(DEMAND_LOG_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    signalCount: demand.signals?.length ?? 0,
    liveSectionBytes: demand.liveSectionBytes,
    error: demand.error,
    topSignals: (demand.signals ?? []).slice(0, 10),
  }) + "\n");
  logEvent({ kind: "demand_scan", signalCount: demand.signals?.length ?? 0 });

  const next = pickNext(seeds);
  if (!next) {
    logEvent({ kind: "idle", reason: "no pending endpoints" });
    return;
  }

  const slug = next.slug;
  const toolDir = resolve(REPO_ROOT, "tools", slug);
  logEvent({ kind: "start", slug, title: next.title, priority: next.priority, demandSignals: demand.signals?.length ?? 0 });

  // Mark as building so a concurrent fire skips it.
  next.status = "building";
  next.started_at = new Date().toISOString();
  saveSeeds(seeds);

  // 1. Spawn Claude Code to scaffold.
  // Spec is passed via stdin so quoting stays clean.
  const prompt = buildPrompt(next, toolDir, seeds);
  let claudeOk = false;
  let claudeErr = "";
  try {
    const result = spawnSync(
      "claude",
      ["--print", "--permission-mode", "bypassPermissions"],
      {
        input: prompt,
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 20 * 60 * 1000, // 20 min hard cap
        env: { ...process.env },
      },
    );
    if (result.status === 0) claudeOk = true;
    else claudeErr = `claude exit ${result.status}: ${(result.stderr || "").slice(0, 500)}`;
  } catch (e) {
    claudeErr = `spawn failed: ${e.message}`;
  }

  // 2. Verify Claude produced something usable.
  const expectedEntry = resolve(toolDir, "server.mjs");
  const expectedManifest = resolve(REPO_ROOT, ".well-known/ai-tool", `${slug}.json`);
  if (!claudeOk || !existsSync(expectedEntry) || !existsSync(expectedManifest)) {
    next.status = "failed";
    next.last_error = claudeErr || `missing ${!existsSync(expectedEntry) ? "server.mjs" : "manifest"}`;
    next.failed_at = new Date().toISOString();
    saveSeeds(seeds);
    logEvent({ kind: "fail", slug, stage: "build", error: next.last_error });
    telegramPing(`endpoint-builder · ${slug} · build failed — ${next.last_error.slice(0, 200)}`);
    return;
  }

  // 3. Commit + push.
  try {
    sh(`git add tools/${slug} .well-known/ai-tool/${slug}.json scripts/endpoint-seeds.json`);
    sh(`git -c user.name="Axiom Bot" -c user.email="axiom@clawbots.org" commit -m "ship ${slug}: ${next.title} (pass-gated x402 endpoint)"`);
    sh("git push origin main");
  } catch (e) {
    next.status = "failed";
    next.last_error = `git: ${e.message.slice(0, 300)}`;
    saveSeeds(seeds);
    logEvent({ kind: "fail", slug, stage: "git", error: next.last_error });
    telegramPing(`endpoint-builder · ${slug} · git step failed — ${next.last_error.slice(0, 200)}`);
    return;
  }

  // 4. Deploy to Vercel. Each tool is its own Vercel project. First-time
  //    deploy creates the project; subsequent runs would re-deploy in place.
  //    We only run this on the initial build.
  let deployUrl = "";
  try {
    deployUrl = sh(
      `NODE_OPTIONS=--tls-min-v1.2 vercel deploy --prod --yes --archive=tgz --name axiom-tool-${slug} --token "$VERCEL_TOKEN"`,
      { cwd: toolDir, capture: true, env: { VERCEL_TOKEN: process.env.VERCEL_TOKEN || "" } },
    ).split("\n").reverse().find((l) => l.startsWith("https://"))?.trim() || "";
  } catch (e) {
    next.status = "failed";
    next.last_error = `vercel: ${e.message.slice(0, 300)}`;
    saveSeeds(seeds);
    logEvent({ kind: "fail", slug, stage: "deploy", error: next.last_error });
    telegramPing(`endpoint-builder · ${slug} · vercel deploy failed — ${next.last_error.slice(0, 200)}`);
    return;
  }

  // 5. Success — flip status and log.
  next.status = "built";
  next.built_at = new Date().toISOString();
  next.url = deployUrl;
  delete next.last_error;
  saveSeeds(seeds);
  logEvent({ kind: "built", slug, url: deployUrl });

  telegramPing(
    `endpoint-builder · ${slug} built and deployed\n` +
      `${next.title}\n` +
      `${deployUrl}\n\n` +
      `Pass-holders bypass via ERC-8257 (registry registration still pending).`,
  );
}

// ---- the build prompt -----------------------------------------------------

function buildPrompt(seed, toolDir, seeds) {
  const demand = readIdeabankSignals();
  const signalBlock = (demand.signals ?? []).slice(0, 15).map(s => `- ${s}`).join("\n") || "(no recent demand signals captured)";

  return `You are scaffolding a new pass-gated x402 endpoint for the axiom-tools monorepo. The two existing tools you should mirror exactly in shape are \`tools/axiom-burn-stats/\` and \`tools/axiom-narrative-pulse/\`. Read those first to learn the pattern.

# What you are building

Slug: \`${seed.slug}\`
Title: ${seed.title}
Priority: ${seed.priority ?? "(unranked)"}

Spec:
${seed.spec}

Why this exists (rationale):
${seed.rationale ?? "(no rationale recorded)"}

# Demand signals from ideabank.md (live section)

This block is pulled fresh from \`~/clawd/ideabank.md\` — the live signal feed from twitter-explore. Use it to sanity-check that what you are building actually maps to what people are asking for. If the spec drifts from the signals here, prefer the signals.

${signalBlock}

# Required structure

Create exactly these files. Mirror the burn-stats + narrative-pulse pattern — zero external deps unless absolutely needed, plain Node \`http\` server, snapshot/cache model where appropriate.

1. \`${toolDir}/server.mjs\` — zero-dep Node HTTP server using \`node:http\`. Routes:
   - \`GET /api/${seed.slug}\` — the data (or 402 envelope for non-pass non-paid callers)
   - \`GET /.well-known/ai-tool/${seed.slug}.json\` — reads + returns the manifest
   - \`GET /health\` — \`{ "status": "ok", "tool": "${seed.slug}" }\`
   - Defaults: \`PORT=\${process.env.PORT ?? 3460}\`, CORS headers on every response.
2. \`${toolDir}/index.mjs\` (optional) — the core data-gathering logic, importable + CLI-runnable with \`--pretty\`.
3. \`${toolDir}/README.md\` — what the endpoint does, sample curl, how the pass-bypass works.
4. \`${resolve(REPO_ROOT, ".well-known/ai-tool")}/${seed.slug}.json\` — ERC-8257 manifest. REQUIRED FIELDS: \`$schema\`, \`name\`, \`version\`, \`description\`, \`url\`, \`pricing\` (type: x402 with passBypass.contract = \`${seeds.pass_contract}\`), \`authentication\`, \`inputSchema\`, \`outputSchema\`, \`examples\`, \`contact\`, \`tags\`, \`updatedAt\`. Mirror the burn-stats manifest shape exactly.

# Payment / pass-bypass model

x402 envelope on cache-miss + non-pass:
- HTTP 402 body: \`{ "x402Version": 1, "accepts": [{ "scheme": "exact", "network": "base", "maxAmountRequired": "${seeds.price_default_usdc}", "resource": "<this endpoint URL>", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }] }\`
- Pass bypass: caller sends \`x-pass-holder: <wallet>\`. Server does onchain \`balanceOf(wallet)\` on Tool Pass contract \`${seeds.pass_contract}\` (Base, via \`BASE_RPC_URL\` env; default \`https://mainnet.base.org\`). If balance ≥ 1, serve free.
- Paid: caller sends \`x-payment: <verified envelope>\`. Trust the verifier upstream, serve.

# Hard rules

- Mirror burn-stats + narrative-pulse: zero npm deps unless the spec truly requires one. No Next.js, no \`api/route.ts\`, no Vercel functions style — this is a plain \`node server.mjs\` process.
- Do not modify any file outside \`${toolDir}\` and the single manifest file at \`${resolve(REPO_ROOT, ".well-known/ai-tool")}/${seed.slug}.json\`.
- Do not run \`npm install\`, \`git\`, \`vercel\`, or any deploy command.
- Smoke-test the server before finishing: run it on a temporary port, curl all three routes, kill it.
- No try/catch swallowing errors — let real failure modes surface as 4xx/5xx.

When done, do nothing else. Do not summarize. Do not explain.`;
}

// Only auto-run when executed directly (node scripts/endpoint-builder.mjs),
// not when imported for unit tests or dry-runs of helper functions.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main().catch((e) => {
    logEvent({ kind: "crash", error: e.message, stack: e.stack });
    telegramPing(`endpoint-builder · crashed — ${e.message.slice(0, 200)}`);
    process.exit(1);
  });
}

export { readIdeabankSignals, pickNext, loadSeeds };
