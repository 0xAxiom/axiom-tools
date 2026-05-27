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
  const expectedHandler = resolve(REPO_ROOT, "api", `${slug}.mjs`);
  const expectedManifest = resolve(REPO_ROOT, ".well-known/ai-tool", `${slug}.json`);
  if (!claudeOk || !existsSync(expectedHandler) || !existsSync(expectedManifest)) {
    next.status = "failed";
    next.last_error = claudeErr || `missing ${!existsSync(expectedHandler) ? `api/${slug}.mjs` : "manifest"}`;
    next.failed_at = new Date().toISOString();
    saveSeeds(seeds);
    logEvent({ kind: "fail", slug, stage: "build", error: next.last_error });
    telegramPing(`endpoint-builder · ${slug} · build failed — ${next.last_error.slice(0, 200)}`);
    return;
  }

  // 3. Commit + push.
  try {
    sh(`git add tools/${slug} api/${slug}.mjs .well-known/ai-tool/${slug}.json scripts/endpoint-seeds.json`);
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

  // 4. Deploy. Single Vercel project (axiom-tools) hosts every endpoint
  //    under /api/<slug>; deploy from REPO_ROOT, not per-tool dir. The
  //    project must already be `vercel link`-ed (one-time human step).
  let deployUrl = "";
  try {
    deployUrl = sh(
      `NODE_OPTIONS=--tls-min-v1.2 vercel deploy --prod --yes --archive=tgz --token "$VERCEL_TOKEN"`,
      { cwd: REPO_ROOT, capture: true, env: { VERCEL_TOKEN: process.env.VERCEL_TOKEN || "" } },
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

# Required structure — single Vercel project (axiom-tools)

All paid endpoints live under \`/api/<slug>\` in ONE Vercel project. The deployable shape is:

1. \`${resolve(REPO_ROOT, "api")}/${seed.slug}.mjs\` — Vercel function (\`export default async function handler(req, res)\`). MUST:
   - Import \`checkAccess\` from \`./_lib/gate.mjs\` and call it FIRST. If \`!gate.allowed\`, \`res.status(402).json(gate.envelope)\` and return.
   - Otherwise serve the data per the spec above.
   - Cache where sensible (set \`Cache-Control: public, max-age=N, s-maxage=N\`).
   - All responses JSON. Errors → \`res.status(5xx).json({ error })\`.
2. \`${toolDir}/index.mjs\` — pure data-gathering logic (no HTTP). Importable from the api handler. CLI-runnable with \`node tools/${seed.slug}/index.mjs [--pretty]\` for local testing.
3. \`${toolDir}/README.md\` — what the endpoint does, sample curl, pass-bypass usage.
4. \`${resolve(REPO_ROOT, ".well-known/ai-tool")}/${seed.slug}.json\` — ERC-8257 manifest. REQUIRED FIELDS: \`$schema\`, \`name\`, \`version\`, \`description\`, \`url\` (= \`https://axiom-tools.vercel.app/api/${seed.slug}\`), \`pricing\` (type: x402 with passBypass.contract = \`${seeds.pass_contract}\`), \`authentication\`, \`inputSchema\`, \`outputSchema\`, \`examples\`, \`contact\`, \`tags\`, \`updatedAt\`. Mirror the burn-stats manifest shape exactly.
5. \`${toolDir}/snapshot.json\` + \`${toolDir}/refresh-*.mjs\` (OPTIONAL) — only if the data source is too slow for request-time. See narrative-pulse for the pattern.

# Payment / pass-bypass model

The shared gate at \`api/_lib/gate.mjs\` handles all of this. Your handler just needs to:

\`\`\`js
import { checkAccess } from "./_lib/gate.mjs";
export default async function handler(req, res) {
  const gate = await checkAccess(req, { price: "${seeds.price_default_usdc}" });
  if (!gate.allowed) return res.status(402).json(gate.envelope);
  // ... serve data ...
}
\`\`\`

If your endpoint is the free tier (rare), skip the gate entirely.

# Hard rules

- Mirror axiom-burn-stats + axiom-narrative-pulse exactly. Read \`api/axiom-burn-stats.mjs\` and \`api/axiom-narrative-pulse.mjs\` first to learn the shape.
- Zero external npm deps unless the spec truly requires one. Use the existing zero-dep RPC pattern (raw \`fetch\` + JSON-RPC POST) for onchain reads.
- Do not modify ANY file outside \`${toolDir}\`, the api handler at \`api/${seed.slug}.mjs\`, and the manifest at \`.well-known/ai-tool/${seed.slug}.json\`.
- Do not run \`npm install\`, \`git\`, \`vercel\`, or any deploy command. The cron handles deploy.
- Smoke-test locally: \`node tools/${seed.slug}/index.mjs --pretty\` should print real data. Do NOT skip this — failed smoke = failed build.
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
