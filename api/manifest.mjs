/**
 * Dynamic manifest server. Rewrite rule in vercel.json maps
 *   GET /.well-known/ai-tool/<slug>.json
 *   →    /api/manifest?slug=<slug>
 *
 * Reads the manifest JSON file from .well-known/ai-tool/ at the project root.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export default function handler(req, res) {
  const slug = String(req.query?.slug ?? "").replace(/[^a-zA-Z0-9-_]/g, "");
  if (!slug) {
    return res.status(400).json({ error: "missing slug" });
  }
  const file = path.join(process.cwd(), ".well-known/ai-tool", `${slug}.json`);
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
    res.status(200).json(m);
  } catch {
    res.status(404).json({ error: "manifest not found", slug });
  }
}
