// Renders mockup SVGs + OpenSea metadata JSON, and (if qlmanage is available) PNGs.
//
// Default behavior (no args): auto-discovers one representative tokenId per
// palette (including the rare Onyx / Gold tier) so the full generative range
// is visible. Pass tokenIds explicitly to override.
//
// Usage:
//   node batch.mjs                     # one mockup per palette (6 total)
//   node batch.mjs 1 42 137 555 999    # explicit token IDs

import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, metadata } from "./render.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "mockups");
mkdirSync(OUT, { recursive: true });

const ALL_PALETTES = [
  "Cream / Sepia",
  "Ash Blue / Navy",
  "Ochre / Deep Brown",
  "Ivory / Forest",
  "Dusty Rose / Burgundy",
  "Onyx / Gold",
];

// Scan low tokenIds and return the first one that lands on each palette.
function representativesByPalette() {
  const found = new Map();
  for (let id = 1; id <= 1000 && found.size < ALL_PALETTES.length; id++) {
    const { palette } = render({ tokenId: id });
    if (!found.has(palette)) found.set(palette, id);
  }
  // Preserve palette display order.
  return ALL_PALETTES.map((name) => ({ palette: name, tokenId: found.get(name) }));
}

const explicit = process.argv.slice(2).map(Number).filter(Boolean);
const targets = explicit.length
  ? explicit.map((tokenId) => ({ tokenId, palette: null }))
  : representativesByPalette();

const results = [];
for (const { tokenId } of targets) {
  const meta = metadata({ tokenId });
  const r = render({ tokenId });
  const padId = String(tokenId).padStart(4, "0");

  const svgPath = resolve(OUT, `token-${padId}.svg`);
  const jsonPath = resolve(OUT, `token-${padId}.json`);
  writeFileSync(svgPath, r.svg);
  writeFileSync(jsonPath, JSON.stringify(meta, null, 2));

  results.push({
    tokenId,
    tier: r.tier,
    palette: r.palette,
    sigil: r.sigil,
    serial: r.serial,
    svgPath,
    jsonPath,
  });
}

// PNG conversion — prefer `rsvg-convert` (librsvg) since it respects native
// SVG dimensions exactly (720×300, no padding). Falls back to `qlmanage`
// (which forces a square canvas) only if librsvg isn't installed.
let pngOk = false;
let pngTool = "";
try {
  execSync("which rsvg-convert", { stdio: "ignore" });
  for (const { svgPath } of results) {
    const pngPath = `${svgPath}.png`;
    execSync(`rsvg-convert "${svgPath}" -o "${pngPath}"`, { stdio: "ignore" });
  }
  pngOk = true;
  pngTool = "rsvg-convert";
} catch {
  try {
    execSync("which qlmanage", { stdio: "ignore" });
    for (const { svgPath } of results) {
      execSync(`qlmanage -t -s 720 -o "${OUT}" "${svgPath}"`, { stdio: "ignore" });
    }
    pngOk = true;
    pngTool = "qlmanage (square-padded; install librsvg for native dimensions)";
  } catch {
    pngOk = false;
  }
}

console.log(JSON.stringify({ outDir: OUT, pngOk, pngTool, results }, null, 2));
