/**
 * axiom-narrative-pulse — snapshot refresher
 *
 * Spawns the aeon-narrative-tracker skill via Claude Code in --print mode,
 * captures structured JSON output, and overwrites snapshot.json.
 *
 * Wired into the axiom-tools endpoint-builder cron once narrative-pulse is
 * live — runs daily, independently of the build queue.
 *
 * Why not call aeon at request time?
 *   - Aeon takes ~30-60s per run (web searches + classification).
 *   - x402 expects fast responses (<5s typical).
 *   - Narrative phase doesn't shift hour-to-hour.
 *   - Snapshot model = cheap reads + one daily expensive write.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dir, "snapshot.json");

const PROMPT = `Run the aeon-narrative-tracker skill. Output ONLY a JSON object with this exact shape — no commentary, no markdown fences:

{
  "generatedAt": "<ISO timestamp>",
  "window": "last 72h",
  "transitions": {
    "new": ["<narrative — driver/evidence>"],
    "promoted": ["<narrative — old → new>"],
    "demoted": ["<narrative — old → new>"],
    "dead": ["<narrative>"]
  },
  "reflexivity": [
    { "narrative": "<slug>", "evidence": "<concrete: rebrand, flows, named endorsement>" }
  ],
  "narratives": [
    {
      "slug": "<kebab-case>",
      "mindshare": 1-5,
      "velocity": "↑↑|↑|→|↓|↓↓",
      "phase": "Emerging|Rising|Peak|Fading",
      "position": "FRONT-RUN|RIDE|FADE|WATCH|IGNORE",
      "drivers": ["@handle"],
      "thesis": "<1 sentence>",
      "bearCase": "<1 sentence>"
    }
  ]
}

Hard rules:
- Drop narratives that grade IGNORE.
- Named drivers only — no "people are saying."
- Reflexivity entries require concrete evidence (rebrands, on-chain flows, named endorsements). Empty list is fine.
- Output valid JSON only — first character must be '{', last character must be '}'.`;

function readPrevious() {
  try { return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")); }
  catch { return null; }
}

const result = spawnSync(
  "claude",
  ["--print", "--permission-mode", "bypassPermissions"],
  { input: PROMPT, encoding: "utf8", timeout: 5 * 60 * 1000 },
);

if (result.status !== 0) {
  console.error("claude exit", result.status, (result.stderr || "").slice(0, 500));
  process.exit(1);
}

const out = (result.stdout || "").trim();
const firstBrace = out.indexOf("{");
const lastBrace  = out.lastIndexOf("}");
if (firstBrace < 0 || lastBrace < 0) {
  console.error("no JSON object in claude output");
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(out.slice(firstBrace, lastBrace + 1));
} catch (e) {
  console.error("parse error:", e.message);
  process.exit(1);
}

if (!Array.isArray(parsed.narratives)) {
  console.error("missing narratives array");
  process.exit(1);
}

parsed.generatedAt = parsed.generatedAt || new Date().toISOString();
parsed.generatedBy = "aeon-narrative-tracker skill (claude --print)";

const prev = readPrevious();
if (prev) {
  // Cheap sanity: don't overwrite a valid snapshot with a wildly shorter one.
  if (parsed.narratives.length < Math.floor(prev.narratives.length / 2)) {
    console.error(`refusing to overwrite — new snapshot has ${parsed.narratives.length} narratives vs prev ${prev.narratives.length}`);
    process.exit(1);
  }
}

writeFileSync(SNAPSHOT_PATH, JSON.stringify(parsed, null, 2) + "\n");
console.log(`narrative-pulse snapshot refreshed → ${parsed.narratives.length} narratives`);
