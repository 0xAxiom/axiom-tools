/**
 * GET /api/axiom-narrative-pulse — paid endpoint ($0.01 USDC; pass-bypass).
 *
 * Serves the latest narrative-pulse snapshot. Filterable by ?narrative= ,
 * ?phase= , ?position=. Snapshot is regenerated daily by
 * tools/axiom-narrative-pulse/refresh-snapshot.mjs (cron).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { checkAccess } from "./_lib/gate.mjs";

const SNAPSHOT = path.join(process.cwd(), "tools/axiom-narrative-pulse/snapshot.json");

function loadSnapshot() {
  const raw = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const ageMs = Date.now() - new Date(raw.generatedAt).getTime();
  raw.stalenessHours = Math.round((ageMs / 3_600_000) * 10) / 10;
  return raw;
}

function filterSnapshot(snap, q) {
  let narratives = snap.narratives;
  if (q.narrative) narratives = narratives.filter(n => n.slug === q.narrative);
  if (q.phase)     narratives = narratives.filter(n => n.phase === q.phase);
  if (q.position)  narratives = narratives.filter(n => n.position === q.position);
  return { ...snap, narratives };
}

export default async function handler(req, res) {
  const gate = await checkAccess(req, { price: "0.01" });
  if (!gate.allowed) {
    return res.status(402).json(gate.envelope);
  }

  try {
    const snap = loadSnapshot();
    const filtered = filterSnapshot(snap, req.query ?? {});
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.status(200).json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
