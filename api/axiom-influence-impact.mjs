/**
 * GET /api/axiom-influence-impact — paid endpoint ($0.01 USDC; pass-bypass).
 *
 * Returns the per-token influence-to-volume attribution leaderboard from the
 * latest snapshot. Filter with ?token=<SYMBOL> to fetch one token; omit
 * to get the full snapshot.
 *
 * Methodology, caveats, and refresh cadence live in
 * tools/axiom-influence-impact/README.md.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { checkAccess } from "./_lib/gate.mjs";

const SNAPSHOT = path.join(process.cwd(), "tools/axiom-influence-impact/snapshot.json");

function loadSnapshot() {
  const raw = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const ageMs = Date.now() - new Date(raw.generatedAt).getTime();
  raw.stalenessHours = Math.round((ageMs / 3_600_000) * 10) / 10;
  return raw;
}

export default async function handler(req, res) {
  const gate = await checkAccess(req, { price: "0.01" });
  if (!gate.allowed) {
    return res.status(402).json(gate.envelope);
  }

  try {
    const snap = loadSnapshot();

    const token = (req.query?.token || "").toUpperCase();
    if (token) {
      const entry = snap.tokens[token];
      if (!entry) {
        return res.status(404).json({
          error: "token not in watched list",
          known: Object.keys(snap.tokens),
        });
      }
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
      return res.status(200).json({
        generatedAt: snap.generatedAt,
        stalenessHours: snap.stalenessHours,
        ...entry,
      });
    }

    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.status(200).json(snap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
