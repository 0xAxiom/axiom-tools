// AxiomToolPass — generative ticket SVG renderer
// Deterministic per tokenId. Mirrors the on-chain Solidity renderer 1:1.
// CommonJS-free, no deps. Node >= 18.

const TOTAL_SUPPLY = 1000;
const WIDTH = 720;
const HEIGHT = 300;

// Six paper/ink palettes — first five muted/letterpress (Standard tier),
// last one is a rare "Onyx / Gold" — black paper, gold ink/foil.
// Rare tier fires on ~5% of mints (≈50/1000).
const STANDARD_PALETTES = [
  { name: "Cream / Sepia",         tier: "Standard", paper: "#f1e7d2", grain: "#e6d7b5", ink: "#3a2a18", accent: "#8a5a2b", foil: "#c69a4a" },
  { name: "Ash Blue / Navy",       tier: "Standard", paper: "#d9dde2", grain: "#bcc4cd", ink: "#142133", accent: "#2a4d7a", foil: "#7a93b3" },
  { name: "Ochre / Deep Brown",    tier: "Standard", paper: "#e2c98a", grain: "#cdaf68", ink: "#2b1c0b", accent: "#7a4f1d", foil: "#b88438" },
  { name: "Ivory / Forest",        tier: "Standard", paper: "#ece5d0", grain: "#d4c9a8", ink: "#1c2e1f", accent: "#345437", foil: "#7d9b62" },
  { name: "Dusty Rose / Burgundy", tier: "Standard", paper: "#e7d2cf", grain: "#cfaba6", ink: "#3a1a1d", accent: "#7a3037", foil: "#b06b6f" },
];
const RARE_PALETTE =
  { name: "Onyx / Gold",           tier: "Rare",     paper: "#0d0d0d", grain: "#1c1c1c", ink: "#d4af37", accent: "#f5d36a", foil: "#fff1b8" };

// -------------------------------------------------------------------------
// Rarity tables — weighted draws sum to 1000 each so percentages read directly.
// All distributions are filterable on OpenSea (categorical, finite values).
// -------------------------------------------------------------------------

// Palette weights — indexes parallel STANDARD_PALETTES; RARE handled first.
//   Onyx / Gold              50  (5%)  Rare tier
//   Cream / Sepia           250  (25%) Common
//   Ash Blue / Navy         220  (22%) Common
//   Ochre / Deep Brown      160  (16%) Uncommon
//   Ivory / Forest          190  (19%) Uncommon
//   Dusty Rose / Burgundy   130  (13%) Rare-tone (still Standard tier)
const PALETTE_WEIGHTS = [250, 220, 160, 190, 130]; // standard, in STANDARD_PALETTES order
const RARE_WEIGHT = 50;

function pickPalette(rng) {
  // Single rng() roll mapped onto [0, 1000) for clean percentages.
  let r = rng() * 1000;
  if (r < RARE_WEIGHT) return RARE_PALETTE;
  r -= RARE_WEIGHT;
  for (let i = 0; i < STANDARD_PALETTES.length; i++) {
    if (r < PALETTE_WEIGHTS[i]) return STANDARD_PALETTES[i];
    r -= PALETTE_WEIGHTS[i];
  }
  return STANDARD_PALETTES[STANDARD_PALETTES.length - 1]; // safety
}

// Sigil variant indices (must match sigilSvg() switch):
//   0 Concentric · 1 Star · 2 Hatch · 3 Compass · 4 Spiral
const SIGIL_NAMES = ["Concentric", "Star", "Hatch", "Compass", "Spiral"];
//                  Concentric Star Hatch Compass Spiral
const SIGIL_WEIGHTS = [300,    100,  200,  250,   150];  // sums to 1000

function pickSigil(rng) {
  let r = rng() * 1000;
  for (let i = 0; i < SIGIL_WEIGHTS.length; i++) {
    if (r < SIGIL_WEIGHTS[i]) return { variant: i, name: SIGIL_NAMES[i] };
    r -= SIGIL_WEIGHTS[i];
  }
  return { variant: 0, name: SIGIL_NAMES[0] };
}

// Sigil Count — Single (80%) / Twin (20%). Twin renders mirrored seals at
// bottom-left AND bottom-right of the body. Same variant + rotation on both.
const TWIN_PROB = 0.2;

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function makeRng(seedStr) {
  const seed = xmur3(seedStr);
  let a = seed(), b = seed(), c = seed(), d = seed();
  return function () {
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const between = (rng, min, max) => min + rng() * (max - min);

function pad4(n) {
  return String(n).padStart(4, "0");
}

// Sigil renderer — variant + rotation + starPoints are pre-picked by render()
// so the same stamp can be drawn at multiple positions (Single vs Twin).
function sigilSvg(variant, rot, cx, cy, r, ink, accent, starPoints) {
  let inner = "";

  if (variant === 0) {
    // Concentric circles
    inner = `
      <circle cx="${cx}" cy="${cy}" r="${r * 0.72}" fill="none" stroke="${ink}" stroke-width="1"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.48}" fill="none" stroke="${ink}" stroke-width="0.8"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.18}" fill="${accent}"/>
    `;
  } else if (variant === 1) {
    // N-pointed star (points pre-rolled in sigil())
    const points = starPoints;
    const outer = r * 0.78, innerR = r * 0.34;
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
      const ang = (i * Math.PI) / points - Math.PI / 2;
      const rr = i % 2 === 0 ? outer : innerR;
      pts.push(`${(cx + Math.cos(ang) * rr).toFixed(2)},${(cy + Math.sin(ang) * rr).toFixed(2)}`);
    }
    inner = `<polygon points="${pts.join(" ")}" fill="none" stroke="${ink}" stroke-width="1.1"/>`;
  } else if (variant === 2) {
    // Cross-hatched square
    const s = r * 1.1;
    const x = cx - s / 2, y = cy - s / 2;
    let hatch = "";
    for (let i = 1; i < 5; i++) {
      const t = (i / 5) * s;
      hatch += `<line x1="${x + t}" y1="${y}" x2="${x + t}" y2="${y + s}" stroke="${ink}" stroke-width="0.5"/>`;
      hatch += `<line x1="${x}" y1="${y + t}" x2="${x + s}" y2="${y + t}" stroke="${ink}" stroke-width="0.5"/>`;
    }
    inner = `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="none" stroke="${ink}" stroke-width="1.2"/>${hatch}`;
  } else if (variant === 3) {
    // Compass rose
    const a = r * 0.78;
    inner = `
      <line x1="${cx}" y1="${cy - a}" x2="${cx}" y2="${cy + a}" stroke="${ink}" stroke-width="1"/>
      <line x1="${cx - a}" y1="${cy}" x2="${cx + a}" y2="${cy}" stroke="${ink}" stroke-width="1"/>
      <line x1="${cx - a * 0.7}" y1="${cy - a * 0.7}" x2="${cx + a * 0.7}" y2="${cy + a * 0.7}" stroke="${ink}" stroke-width="0.5"/>
      <line x1="${cx + a * 0.7}" y1="${cy - a * 0.7}" x2="${cx - a * 0.7}" y2="${cy + a * 0.7}" stroke="${ink}" stroke-width="0.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.22}" fill="${accent}"/>
    `;
  } else {
    // Spiral
    const steps = 90;
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const ang = t * Math.PI * 4;
      const rr = t * r * 0.85;
      pts.push(`${(cx + Math.cos(ang) * rr).toFixed(2)},${(cy + Math.sin(ang) * rr).toFixed(2)}`);
    }
    inner = `<polyline points="${pts.join(" ")}" fill="none" stroke="${ink}" stroke-width="0.9"/>`;
  }

  return `
    <g transform="rotate(${rot} ${cx} ${cy})">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ink}" stroke-width="1.5"/>
      <circle cx="${cx}" cy="${cy}" r="${r * 0.92}" fill="none" stroke="${ink}" stroke-width="0.4" stroke-dasharray="2 2"/>
      ${inner}
    </g>
  `;
}

// Light grain — RNG advance only (no visual output). On-chain renderer omits
// grain dots for gas reasons, so we drop them here too to keep previews and
// chain output 1:1. The RNG state must still advance by 220*3 rolls so the
// downstream watermark angle picks the same value the chain does.
function grain(rng /*, w, h, color */) {
  for (let i = 0; i < 220; i++) {
    rng(); // x
    rng(); // y
    rng(); // size
  }
  return "";
}

// Generative watermark band — diagonal stripes behind the main text, very faint.
// Returns the SVG string AND the chosen angle for metadata.
function watermark(rng, ink) {
  const angle = pick(rng, [-22, -15, 15, 22]);
  const svg = `
    <g opacity="0.06">
      <g transform="rotate(${angle} 360 150)">
        ${Array.from({ length: 9 }).map((_, i) => {
          const x = -100 + i * 100;
          return `<rect x="${x}" y="-50" width="40" height="400" fill="${ink}"/>`;
        }).join("")}
      </g>
    </g>
  `;
  return { svg, angle };
}

export function render({ tokenId, totalSupply = TOTAL_SUPPLY, seedSalt = "axiom-tool-pass-v1" }) {
  const rng = makeRng(`${seedSalt}:${tokenId}`);

  // All trait picks up front so the RNG-consumption order is explicit and
  // the on-chain Solidity port can mirror it 1:1.
  const palette = pickPalette(rng);                                  // 1 roll
  const sigilPick = pickSigil(rng);                                  // 1 roll
  const sigilRot = Math.floor(rng() * 360);                          // 1 roll
  const sigilStarPts = sigilPick.variant === 1                       // conditional
    ? 4 + Math.floor(rng() * 4)
    : 0;
  const sigilCount = rng() < TWIN_PROB ? "Twin" : "Single";          // 1 roll

  const serial = `${pad4(tokenId)} / ${pad4(totalSupply)}`;

  // Ticket geometry
  const pad = 14;
  const bodyX = pad, bodyY = pad;
  const bodyW = WIDTH - pad * 2;
  const bodyH = HEIGHT - pad * 2;
  const stubX = bodyX + bodyW - 130;

  // Perforation dots between body and stub
  const perfDots = [];
  for (let y = bodyY + 12; y < bodyY + bodyH - 6; y += 12) {
    perfDots.push(`<circle cx="${stubX}" cy="${y}" r="2" fill="${palette.paper}" stroke="${palette.grain}" stroke-width="0.5"/>`);
  }

  // Foil strip — thin gradient band on the stub
  const foilY = bodyY + 20;

  // Grain + watermark consume the remaining RNG (kept after picks so visual
  // noise still varies per token even when discrete traits coincide).
  const grainSvg = grain(rng, WIDTH, HEIGHT, palette.grain);
  const wm = watermark(rng, palette.ink);

  // Sigil placement — Single sits near the stub; Twin adds a mirrored seal
  // at the bottom-left of the body (same variant + rotation).
  const sigilR = 32;
  const sigilRightCx = stubX - 60;
  const sigilLeftCx = bodyX + 60;
  const sigilCy = bodyY + bodyH - 60;
  const sigilRightSvg = sigilSvg(sigilPick.variant, sigilRot, sigilRightCx, sigilCy, sigilR, palette.ink, palette.accent, sigilStarPts);
  const sigilLeftSvg = sigilCount === "Twin"
    ? sigilSvg(sigilPick.variant, sigilRot, sigilLeftCx, sigilCy, sigilR, palette.ink, palette.accent, sigilStarPts)
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    <linearGradient id="foil" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.foil}" stop-opacity="0.9"/>
      <stop offset="50%" stop-color="${palette.paper}" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="${palette.foil}" stop-opacity="0.9"/>
    </linearGradient>
    <clipPath id="ticket">
      <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="6" ry="6"/>
    </clipPath>
  </defs>

  <!-- Outer canvas -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#1a1a1a"/>

  <!-- Ticket body -->
  <g clip-path="url(#ticket)">
    <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" fill="${palette.paper}"/>
    ${grainSvg}
    ${wm.svg}

    <!-- Double-line top border -->
    <line x1="${bodyX + 20}" y1="${bodyY + 18}" x2="${bodyX + bodyW - 20}" y2="${bodyY + 18}" stroke="${palette.ink}" stroke-width="1.2"/>
    <line x1="${bodyX + 20}" y1="${bodyY + 22}" x2="${bodyX + bodyW - 20}" y2="${bodyY + 22}" stroke="${palette.ink}" stroke-width="0.5"/>
    <line x1="${bodyX + 20}" y1="${bodyY + bodyH - 22}" x2="${bodyX + bodyW - 20}" y2="${bodyY + bodyH - 22}" stroke="${palette.ink}" stroke-width="0.5"/>
    <line x1="${bodyX + 20}" y1="${bodyY + bodyH - 18}" x2="${bodyX + bodyW - 20}" y2="${bodyY + bodyH - 18}" stroke="${palette.ink}" stroke-width="1.2"/>

    <!-- Header label -->
    <text x="${bodyX + 32}" y="${bodyY + 48}" font-family="Georgia, 'Times New Roman', serif" font-size="11" letter-spacing="3" fill="${palette.ink}">AXIOM · BASE · ERC-8257</text>

    <!-- Main title -->
    <text x="${bodyX + 32}" y="${bodyY + 110}" font-family="Georgia, 'Times New Roman', serif" font-size="46" font-weight="700" fill="${palette.ink}">AXIOM</text>
    <text x="${bodyX + 32}" y="${bodyY + 150}" font-family="Georgia, 'Times New Roman', serif" font-size="34" font-style="italic" fill="${palette.accent}">tool pass</text>

    <!-- Tagline -->
    <text x="${bodyX + 32}" y="${bodyY + 182}" font-family="Georgia, serif" font-size="10" letter-spacing="4" fill="${palette.ink}">ADMIT ONE · BYPASS x402 · LIFETIME</text>

    <!-- Serial -->
    <text x="${bodyX + 32}" y="${bodyY + bodyH - 38}" font-family="Courier, monospace" font-size="11" letter-spacing="2" fill="${palette.ink}">№ ${serial}</text>

    <!-- Sigil(s) — right side always, plus mirrored left side if Twin -->
    ${sigilRightSvg}
    ${sigilLeftSvg}

    <!-- Stub background tint -->
    <rect x="${stubX}" y="${bodyY}" width="${bodyW - (stubX - bodyX)}" height="${bodyH}" fill="${palette.grain}" opacity="0.45"/>

    <!-- Foil strip on stub -->
    <rect x="${stubX + 12}" y="${foilY}" width="${bodyW - (stubX - bodyX) - 24}" height="6" fill="url(#foil)"/>

    <!-- Stub rotated text -->
    <g transform="translate(${stubX + (bodyW - (stubX - bodyX)) / 2}, ${bodyY + bodyH / 2}) rotate(-90)">
      <text text-anchor="middle" font-family="Georgia, serif" font-size="20" font-weight="700" letter-spacing="6" fill="${palette.ink}">AXIOM TOOL PASS</text>
      <text y="22" text-anchor="middle" font-family="Courier, monospace" font-size="9" letter-spacing="3" fill="${palette.ink}">№ ${serial}</text>
    </g>
  </g>

  <!-- Perforation -->
  ${perfDots.join("")}

  <!-- Outer ticket outline -->
  <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="6" ry="6" fill="none" stroke="${palette.ink}" stroke-width="1" opacity="0.4"/>
</svg>`;

  return {
    svg,
    tokenId,
    serial,
    palette: palette.name,
    tier: palette.tier,
    sigil: sigilPick.name,
    sigilCount,
    sigilRotation: sigilRot, // internal only — not surfaced as a trait
    watermarkAngle: wm.angle,
  };
}

// ----- OpenSea metadata ---------------------------------------------------
//
// Generates the JSON ERC-721 contracts return from tokenURI(). The Solidity
// renderer mirrors this 1:1: base64-encoded JSON with base64-encoded SVG
// inlined into `image`, plus an OpenSea-compliant `attributes` array.
//
// Fields covered:
//   name           — "AXIOM Tool Pass #0001"
//   description    — collection blurb (markdown allowed; OpenSea renders it)
//   image          — data:image/svg+xml;base64,<…>  (fully on-chain)
//   external_url   — https://clawbots.org/tool-pass/<id>
//   background_color — hex without leading # (OpenSea card backdrop)
//   attributes     — Palette, Tier, Sigil, Watermark Angle, Serial, Edition
//
// Per OpenSea metadata standards:
// https://docs.opensea.io/docs/metadata-standards

const COLLECTION_DESCRIPTION =
  "AXIOM Tool Pass — lifetime bypass for x402-paywalled AXIOM endpoints. " +
  "1000 supply, fully on-chain SVG art, ERC-8257 token-bound. " +
  "Standard tier rolls one of five letterpress palettes; ~5% mint the rare Onyx / Gold pass.";

// Single landing page for all tokens — every pass does the same thing
// (bypass x402), so no per-token URL is needed.
const EXTERNAL_URL = "https://clawbots.org/tool-pass";
const DEFAULT_BACKGROUND = "1a1a1a"; // matches the SVG outer canvas

function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

export function metadata({
  tokenId,
  totalSupply = TOTAL_SUPPLY,
  seedSalt = "axiom-tool-pass-v1",
  externalUrl = EXTERNAL_URL,
}) {
  const r = render({ tokenId, totalSupply, seedSalt });
  const image = `data:image/svg+xml;base64,${b64(r.svg)}`;

  return {
    name: `AXIOM Tool Pass #${pad4(tokenId)}`,
    description: COLLECTION_DESCRIPTION,
    image,
    external_url: externalUrl,
    background_color: DEFAULT_BACKGROUND,
    // Five filterable traits — every value is categorical so OpenSea can
    // build clean filter facets. Serial / edition / rotation are intentionally
    // not exposed (unique-per-token noise → useless filters).
    attributes: [
      { trait_type: "Tier",            value: r.tier },
      { trait_type: "Palette",         value: r.palette },
      { trait_type: "Sigil",           value: r.sigil },
      { trait_type: "Sigil Count",     value: r.sigilCount },
      { trait_type: "Watermark Angle", value: `${r.watermarkAngle}°` },
    ],
  };
}

// Returns the data URI that tokenURI() would emit on-chain. Safe for OpenSea
// "Refresh metadata" requests — fully self-contained, no IPFS / HTTP fetch.
export function tokenURI(args) {
  const json = JSON.stringify(metadata(args));
  return `data:application/json;base64,${b64(json)}`;
}

// Direct invocation:
//   node render.mjs <tokenId>             → write SVG to stdout
//   node render.mjs <tokenId> --metadata  → write metadata JSON to stdout
//   node render.mjs <tokenId> --tokenuri  → write tokenURI data URI to stdout
if (import.meta.url === `file://${process.argv[1]}`) {
  const tokenId = Number(process.argv[2] || 1);
  const mode = process.argv[3] || "";
  if (mode === "--metadata") {
    process.stdout.write(JSON.stringify(metadata({ tokenId }), null, 2));
  } else if (mode === "--tokenuri") {
    process.stdout.write(tokenURI({ tokenId }));
  } else {
    const r = render({ tokenId });
    process.stderr.write(
      `tokenId=${tokenId} tier="${r.tier}" palette="${r.palette}" sigil="${r.sigil}" count="${r.sigilCount}" serial="${r.serial}"\n`,
    );
    process.stdout.write(r.svg);
  }
}
