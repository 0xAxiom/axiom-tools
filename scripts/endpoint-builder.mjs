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
  return seeds.endpoints.find((e) => e.status === "pending");
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
  const next = pickNext(seeds);
  if (!next) {
    logEvent({ kind: "idle", reason: "no pending endpoints" });
    return;
  }

  const slug = next.slug;
  const toolDir = resolve(REPO_ROOT, "tools", slug);
  logEvent({ kind: "start", slug, title: next.title });

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
  const expectedEntry = resolve(toolDir, "api/route.ts");
  if (!claudeOk || !existsSync(expectedEntry)) {
    next.status = "failed";
    next.last_error = claudeErr || `missing ${expectedEntry}`;
    next.failed_at = new Date().toISOString();
    saveSeeds(seeds);
    logEvent({ kind: "fail", slug, stage: "build", error: next.last_error });
    telegramPing(`endpoint-builder · ${slug} · build failed — ${next.last_error.slice(0, 200)}`);
    return;
  }

  // 3. Commit + push.
  try {
    sh(`git add tools/${slug}`);
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
  return `You are scaffolding a new pass-gated x402 endpoint for the axiom-tools monorepo. Build it as a Vercel project at \`${toolDir}\`. Do not modify any other files in the repo.

# What you are building

Slug: \`${seed.slug}\`
Title: ${seed.title}

Spec:
${seed.spec}

# Required structure

Create exactly these files (and only these files) inside \`${toolDir}\`:

1. \`api/route.ts\` — the Vercel serverless handler (Node 20 runtime).
   - Default export an async function \`(req, res) => ...\`
   - On every request:
     a. Read \`x-pass-holder\` header (caller asserts they hold a pass; verified by step b).
     b. If header is present, do an onchain \`balanceOf\` call to the Tool Pass contract \`${seeds.pass_contract}\` on Base via the env var \`BASE_RPC_URL\` (fallback: \`https://mainnet.base.org\`). If balance ≥ 1, skip x402.
     c. Otherwise, return HTTP 402 with the x402 payment-required envelope: \`{ "x402Version": 1, "accepts": [{ "scheme": "exact", "network": "base", "maxAmountRequired": "${seeds.price_default_usdc}", "resource": "<this endpoint>", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }] }\` (USDC on Base).
     d. If the request includes a verified payment header (look for \`x-payment\`), trust it and serve.
     e. Otherwise (pass holder OR paid), serve the data per the spec above.
   - All responses are JSON. Errors return \`{ error: "..." }\` with appropriate status.
2. \`manifest.json\` — ERC-8257 tool manifest. Required fields:
   - \`name\`: "${seed.title}"
   - \`slug\`: "${seed.slug}"
   - \`description\`: 1-sentence description.
   - \`accessPredicate\`: "${seeds.pass_contract}"
   - \`price\`: { "amount": "${seeds.price_default_usdc}", "asset": "USDC", "chain": "base" }
   - \`endpoints\`: [{ "method": "GET", "path": "/api/route", "params": [...] }]
   - \`schema_version\`: 1
3. \`package.json\` — minimal, with \`"type": "module"\`, \`name: "axiom-tool-${seed.slug}"\`, and one dependency: \`viem\` (latest). No build step needed.
4. \`vercel.json\` — \`{ "version": 2, "functions": { "api/route.ts": { "runtime": "nodejs20.x" } } }\`
5. \`README.md\` — short doc: what the endpoint does, how to call it, how the pass-bypass works. Include a curl example.

# Hard rules

- Do not edit ANY file outside \`${toolDir}\`.
- Do not run \`npm install\`, \`git\`, \`vercel\`, or any deploy command. The cron handles deploy.
- Keep the handler under 200 lines. No external API mocks — call the real APIs (OpenSea, RPCs). It is fine for the handler to read OPENSEA_API_KEY from process.env (the env var will be set in Vercel project config).
- All onchain reads use \`viem.createPublicClient({ chain: base, transport: http(BASE_RPC_URL) })\`.
- No try/catch swallowing errors — let the caller see real failure modes via 4xx/5xx status.

When done, do nothing else. Do not summarize. Do not explain.`;
}

main().catch((e) => {
  logEvent({ kind: "crash", error: e.message, stack: e.stack });
  telegramPing(`endpoint-builder · crashed — ${e.message.slice(0, 200)}`);
  process.exit(1);
});
