// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title AXIOM Tool Pass — fully on-chain renderer
/// @notice Implements IAxiomPassRenderer (see AxiomToolPass.sol). Returns a
///         data URI containing base64-encoded JSON with a base64-encoded SVG
///         inlined as `image`. No IPFS, no off-chain fetch.
///
/// @dev Trait selection mirrors `renderer/render.mjs` bit-for-bit so OpenSea
///      indexed attributes match the off-chain reference exactly. The visual
///      SVG also matches the JS output structurally; only the 220 random grain
///      dots are omitted on-chain (purely visual, not an indexed trait — gas
///      saving ≈8M per tokenURI call). The page-side preview gallery is
///      updated in lockstep so what users see on /mint matches what the
///      contract emits.
///
///      RNG: JS xmur3 → xoshiro128-style. All uint32 wrap-around math; the
///      `unchecked` blocks below match Math.imul / `| 0` / `>>>` semantics.
contract AxiomToolPassRenderer {
    using Strings for uint256;

    uint256 public constant TOTAL_SUPPLY = 1000;
    bytes private constant SEED_SALT = "axiom-tool-pass-v1";

    string private constant COLLECTION_DESCRIPTION =
        "AXIOM Tool Pass \\u2014 lifetime bypass for x402-paywalled AXIOM endpoints. "
        "1000 supply, fully on-chain SVG art, ERC-8257 token-bound. "
        "Standard tier rolls one of five letterpress palettes; ~5% mint the rare Onyx / Gold pass.";

    // Precomputed N-point star polygons (cx=0,cy=0; rendered inside a
    // <g transform="translate(cx cy) rotate(rot)"> wrapper).
    // Strings come from render.mjs at the same precision (.toFixed(2)).
    string private constant STAR_4 =
        "0.00,-24.96 7.69,-7.69 24.96,0.00 7.69,7.69 0.00,24.96 -7.69,7.69 -24.96,0.00 -7.69,-7.69";
    string private constant STAR_5 =
        "0.00,-24.96 6.40,-8.80 23.74,-7.71 10.35,3.36 14.67,20.19 0.00,10.88 -14.67,20.19 -10.35,3.36 -23.74,-7.71 -6.40,-8.80";
    string private constant STAR_6 =
        "0.00,-24.96 5.44,-9.42 21.62,-12.48 10.88,0.00 21.62,12.48 5.44,9.42 0.00,24.96 -5.44,9.42 -21.62,12.48 -10.88,0.00 -21.62,-12.48 -5.44,-9.42";
    string private constant STAR_7 =
        "0.00,-24.96 4.72,-9.80 19.51,-15.56 10.61,-2.42 24.33,5.55 8.51,6.78 10.83,22.49 0.00,10.88 -10.83,22.49 -8.51,6.78 -24.33,5.55 -10.61,-2.42 -19.51,-15.56 -4.72,-9.80";

    // Spiral polyline (90 points, r=32 * 0.85, deterministic — same shape for
    // every spiral sigil, varies only by palette + rotation).
    string private constant SPIRAL_POINTS =
        "0.00,0.00 0.30,0.04 0.58,0.17 0.83,0.37 1.03,0.64 1.16,0.97 1.21,1.35 1.18,1.75 1.06,2.17 0.84,2.59 0.52,2.98 0.12,3.32 -0.38,3.61 -0.95,3.81 -1.59,3.92 -2.27,3.93 -2.98,3.81 -3.70,3.57 -4.40,3.20 -5.07,2.70 -5.68,2.07 -6.21,1.32 -6.63,0.46 -6.93,-0.48 -7.09,-1.51 -7.10,-2.58 -6.94,-3.69 -6.60,-4.80 -6.09,-5.88 -5.40,-6.91 -4.53,-7.85 -3.51,-8.69 -2.34,-9.38 -1.04,-9.92 0.36,-10.27 1.84,-10.42 3.36,-10.35 4.90,-10.05 6.42,-9.52 7.89,-8.76 9.26,-7.77 10.51,-6.57 11.60,-5.16 12.49,-3.58 13.17,-1.85 13.60,-0.00 13.77,1.93 13.65,3.92 13.25,5.90 12.56,7.85 11.58,9.71 10.31,11.45 8.79,13.03 7.02,14.40 5.04,15.52 2.89,16.37 0.59,16.91 -1.80,17.13 -4.24,17.01 -6.68,16.53 -9.07,15.70 -11.35,14.53 -13.48,13.02 -15.40,11.19 -17.08,9.08 -18.46,6.72 -19.51,4.15 -20.20,1.41 -20.50,-1.43 -20.40,-4.34 -19.88,-7.24 -18.95,-10.07 -17.60,-12.79 -15.87,-15.33 -13.77,-17.62 -11.33,-19.63 -8.60,-21.30 -5.63,-22.58 -2.46,-23.44 0.83,-23.86 4.20,-23.81 7.56,-23.28 10.86,-22.27 14.03,-20.80 16.99,-18.87 19.68,-16.51 22.04,-13.77 24.02,-10.69 25.57,-7.33 26.64,-3.74";

    // ---------------------------------------------------------------
    //  Palettes (index 0 = rare Onyx/Gold; 1-5 = five Standard tiers)
    //
    //  These mirror STANDARD_PALETTES + RARE_PALETTE in render.mjs in the
    //  same order the JS picks them (rare first, then PALETTE_WEIGHTS order).
    // ---------------------------------------------------------------
    function _paletteName(uint8 idx) internal pure returns (string memory) {
        if (idx == 0) return "Onyx / Gold";
        if (idx == 1) return "Cream / Sepia";
        if (idx == 2) return "Ash Blue / Navy";
        if (idx == 3) return "Ochre / Deep Brown";
        if (idx == 4) return "Ivory / Forest";
        return "Dusty Rose / Burgundy";
    }

    function _paletteTier(uint8 idx) internal pure returns (string memory) {
        return idx == 0 ? "Rare" : "Standard";
    }

    // Colors: paper, grain, ink, accent, foil (all "#RRGGBB").
    function _paletteColors(uint8 idx)
        internal
        pure
        returns (string memory paper, string memory grain, string memory ink, string memory accent, string memory foil)
    {
        if (idx == 0) {
            return ("#0d0d0d", "#1c1c1c", "#d4af37", "#f5d36a", "#fff1b8");
        } else if (idx == 1) {
            return ("#f1e7d2", "#e6d7b5", "#3a2a18", "#8a5a2b", "#c69a4a");
        } else if (idx == 2) {
            return ("#d9dde2", "#bcc4cd", "#142133", "#2a4d7a", "#7a93b3");
        } else if (idx == 3) {
            return ("#e2c98a", "#cdaf68", "#2b1c0b", "#7a4f1d", "#b88438");
        } else if (idx == 4) {
            return ("#ece5d0", "#d4c9a8", "#1c2e1f", "#345437", "#7d9b62");
        } else {
            return ("#e7d2cf", "#cfaba6", "#3a1a1d", "#7a3037", "#b06b6f");
        }
    }

    function _sigilName(uint8 variant) internal pure returns (string memory) {
        if (variant == 0) return "Concentric";
        if (variant == 1) return "Star";
        if (variant == 2) return "Hatch";
        if (variant == 3) return "Compass";
        return "Spiral";
    }

    // ---------------------------------------------------------------
    //  PRNG — xmur3 seed → xoshiro128-style next(). uint32 wrap.
    // ---------------------------------------------------------------
    struct Rng {
        uint32 a;
        uint32 b;
        uint32 c;
        uint32 d;
    }

    function _xmur3Mix(uint32 h) private pure returns (uint32) {
        unchecked {
            h = (h ^ (h >> 16)) * 2246822507;
            h = (h ^ (h >> 13)) * 3266489909;
            return h ^ (h >> 16);
        }
    }

    function _initRng(uint256 tokenId) internal pure returns (Rng memory rng) {
        // Build "axiom-tool-pass-v1:<tokenId>" exactly like the JS does.
        bytes memory seed = bytes(string(abi.encodePacked(SEED_SALT, ":", tokenId.toString())));

        uint32 h = uint32(1779033703) ^ uint32(seed.length);
        unchecked {
            for (uint256 i = 0; i < seed.length; i++) {
                h = (h ^ uint32(uint8(seed[i]))) * 3432918353;
                h = (h << 13) | (h >> 19);
            }
        }
        // Pull four state words by re-mixing h sequentially.
        h = _xmur3Mix(h);
        rng.a = h;
        h = _xmur3Mix(h);
        rng.b = h;
        h = _xmur3Mix(h);
        rng.c = h;
        h = _xmur3Mix(h);
        rng.d = h;
    }

    /// @notice Pulls one uint32 from the PRNG, matching JS rng()*2^32.
    function _next(Rng memory rng) internal pure returns (uint32 r) {
        unchecked {
            uint32 t = rng.a + rng.b;
            rng.a = rng.b ^ (rng.b >> 9);
            rng.b = rng.c + (rng.c << 3);
            rng.c = (rng.c << 21) | (rng.c >> 11);
            rng.d = rng.d + 1;
            r = t + rng.d;
            rng.c = rng.c + r;
        }
    }

    // ---------------------------------------------------------------
    //  Trait selection (mirror render.mjs RNG-consumption order)
    // ---------------------------------------------------------------
    struct Pass {
        uint8 paletteIdx;     // 0=Onyx/Gold rare, 1-5=Standard palettes
        uint8 sigilVariant;   // 0..4 (Concentric/Star/Hatch/Compass/Spiral)
        uint16 sigilRotation; // 0..359
        uint8 sigilStarPts;   // 4..7 when variant==1 (Star), else 0
        bool twin;            // sigilCount: true=Twin, false=Single
        int16 watermarkAngle; // one of {-22, -15, 15, 22}
    }

    /// @dev Replicates the JS palette pick:
    ///        r = rng()*1000;  if (r<50) Rare;  r-=50;
    ///        for each weight w: if (r<w) return; r-=w;
    ///      Using uint64 = u*1000 lets us subtract weight<<32 exactly,
    ///      matching JS float math (all values < 2^53 so float is exact).
    function _pickPalette(uint32 u) private pure returns (uint8) {
        uint64 r = uint64(u) * 1000;
        if (r < uint64(50) << 32) return 0; // Onyx / Gold
        r -= uint64(50) << 32;
        uint16[5] memory weights = [uint16(250), 220, 160, 190, 130];
        for (uint8 i = 0; i < 5; i++) {
            uint64 w = uint64(weights[i]) << 32;
            if (r < w) return i + 1;
            r -= w;
        }
        return 5; // safety (Dusty Rose / Burgundy)
    }

    function _pickSigil(uint32 u) private pure returns (uint8) {
        uint64 r = uint64(u) * 1000;
        uint16[5] memory weights = [uint16(300), 100, 200, 250, 150]; // Conc, Star, Hatch, Compass, Spiral
        for (uint8 i = 0; i < 5; i++) {
            uint64 w = uint64(weights[i]) << 32;
            if (r < w) return i;
            r -= w;
        }
        return 0; // safety
    }

    function _pickWatermarkAngle(uint32 u) private pure returns (int16) {
        // pick(rng, [-22, -15, 15, 22]) → idx = floor(rng()*4)
        uint256 idx = (uint256(u) * 4) >> 32;
        if (idx == 0) return -22;
        if (idx == 1) return -15;
        if (idx == 2) return 15;
        return 22;
    }

    function _generate(uint256 tokenId) internal pure returns (Pass memory p) {
        Rng memory rng = _initRng(tokenId);
        p.paletteIdx = _pickPalette(_next(rng));
        p.sigilVariant = _pickSigil(_next(rng));
        p.sigilRotation = uint16((uint256(_next(rng)) * 360) >> 32);
        if (p.sigilVariant == 1) {
            // 4 + floor(rng()*4) → 4..7
            p.sigilStarPts = uint8(4 + ((uint256(_next(rng)) * 4) >> 32));
        }
        // rng() < 0.2 ⟺ u < ceil(0.2_f * 2^32) — see render.mjs port notes.
        p.twin = _next(rng) < 858993460;

        // The JS reference consumes 220 grain dots × 3 rolls each = 660 rolls
        // between sigilCount and watermark. We skip drawing grain on-chain
        // (gas) but must still advance the RNG so the watermark angle matches
        // the off-chain trait.
        for (uint256 i = 0; i < 660; i++) {
            _next(rng);
        }

        p.watermarkAngle = _pickWatermarkAngle(_next(rng));
    }

    // ---------------------------------------------------------------
    //  Sigil SVG
    // ---------------------------------------------------------------
    function _sigilSvg(Pass memory p, uint16 cx, uint16 cy, string memory ink, string memory accent)
        private
        pure
        returns (string memory)
    {
        // Outer ring + dashed ring are constant across all variants.
        // r=32, r*0.92=29.44 (use 29.44 directly).
        string memory wrap =
            string(abi.encodePacked('<circle cx="0" cy="0" r="32" fill="none" stroke="', ink, '" stroke-width="1.5"/>'));
        wrap = string(
            abi.encodePacked(
                wrap,
                '<circle cx="0" cy="0" r="29.44" fill="none" stroke="',
                ink,
                '" stroke-width="0.4" stroke-dasharray="2 2"/>'
            )
        );

        string memory inner;
        if (p.sigilVariant == 0) {
            // Concentric: r*0.72=23.04, r*0.48=15.36, r*0.18=5.76
            inner = string(
                abi.encodePacked(
                    '<circle cx="0" cy="0" r="23.04" fill="none" stroke="',
                    ink,
                    '" stroke-width="1"/>',
                    '<circle cx="0" cy="0" r="15.36" fill="none" stroke="',
                    ink,
                    '" stroke-width="0.8"/>',
                    '<circle cx="0" cy="0" r="5.76" fill="',
                    accent,
                    '"/>'
                )
            );
        } else if (p.sigilVariant == 1) {
            string memory pts = p.sigilStarPts == 4
                ? STAR_4
                : p.sigilStarPts == 5 ? STAR_5 : p.sigilStarPts == 6 ? STAR_6 : STAR_7;
            inner = string(
                abi.encodePacked(
                    '<polygon points="', pts, '" fill="none" stroke="', ink, '" stroke-width="1.1"/>'
                )
            );
        } else if (p.sigilVariant == 2) {
            // Hatch: square r*1.1=35.2 centered at 0; x=-17.6, side 35.2.
            // hatch lines at t = (i/5)*35.2 for i=1..4: 7.04, 14.08, 21.12, 28.16
            // → x at -17.6+t. Same for y.
            inner = string(
                abi.encodePacked(
                    '<rect x="-17.6" y="-17.6" width="35.2" height="35.2" fill="none" stroke="',
                    ink,
                    '" stroke-width="1.2"/>'
                )
            );
            // Four pairs of crossing lines.
            string[4] memory offsets = ["-10.56", "-3.52", "3.52", "10.56"]; // -17.6 + {7.04,14.08,21.12,28.16}
            for (uint256 i = 0; i < 4; i++) {
                inner = string(
                    abi.encodePacked(
                        inner,
                        '<line x1="',
                        offsets[i],
                        '" y1="-17.6" x2="',
                        offsets[i],
                        '" y2="17.6" stroke="',
                        ink,
                        '" stroke-width="0.5"/>',
                        '<line x1="-17.6" y1="',
                        offsets[i],
                        '" x2="17.6" y2="',
                        offsets[i],
                        '" stroke="',
                        ink,
                        '" stroke-width="0.5"/>'
                    )
                );
            }
        } else if (p.sigilVariant == 3) {
            // Compass: a = r*0.78 = 24.96; diag a*0.7 = 17.472; center dot r*0.22 = 7.04
            inner = string(
                abi.encodePacked(
                    '<line x1="0" y1="-24.96" x2="0" y2="24.96" stroke="',
                    ink,
                    '" stroke-width="1"/>',
                    '<line x1="-24.96" y1="0" x2="24.96" y2="0" stroke="',
                    ink,
                    '" stroke-width="1"/>',
                    '<line x1="-17.47" y1="-17.47" x2="17.47" y2="17.47" stroke="',
                    ink,
                    '" stroke-width="0.5"/>',
                    '<line x1="17.47" y1="-17.47" x2="-17.47" y2="17.47" stroke="',
                    ink,
                    '" stroke-width="0.5"/>',
                    '<circle cx="0" cy="0" r="7.04" fill="',
                    accent,
                    '"/>'
                )
            );
        } else {
            // Spiral
            inner = string(
                abi.encodePacked(
                    '<polyline points="', SPIRAL_POINTS, '" fill="none" stroke="', ink, '" stroke-width="0.9"/>'
                )
            );
        }

        return string(
            abi.encodePacked(
                '<g transform="translate(',
                Strings.toString(uint256(cx)),
                " ",
                Strings.toString(uint256(cy)),
                ") rotate(",
                Strings.toString(uint256(p.sigilRotation)),
                ')">',
                wrap,
                inner,
                "</g>"
            )
        );
    }

    // ---------------------------------------------------------------
    //  Watermark SVG (9 stripes rotated about center 360,150)
    // ---------------------------------------------------------------
    function _watermarkSvg(int16 angle, string memory ink) private pure returns (string memory) {
        string memory angleStr = _intToString(angle);
        string memory stripes;
        for (int256 i = 0; i < 9; i++) {
            int256 x = -100 + i * 100;
            stripes = string(
                abi.encodePacked(stripes, '<rect x="', _intToString(int16(x)), '" y="-50" width="40" height="400" fill="', ink, '"/>')
            );
        }
        return string(
            abi.encodePacked(
                '<g opacity="0.06"><g transform="rotate(', angleStr, ' 360 150)">', stripes, "</g></g>"
            )
        );
    }

    // ---------------------------------------------------------------
    //  Main SVG
    // ---------------------------------------------------------------
    function _svg(uint256 tokenId, Pass memory p) internal pure returns (bytes memory) {
        (string memory paper, string memory grain, string memory ink, string memory accent, string memory foil) =
            _paletteColors(p.paletteIdx);

        // Geometry constants from render.mjs (WIDTH=720, HEIGHT=300, pad=14)
        //   bodyX=14, bodyY=14, bodyW=692, bodyH=272, stubX=576
        //   sigilRightCx=516, sigilLeftCx=74, sigilCy=226 (bodyY+bodyH-60)
        //   foilY=34
        string memory serial = _serial(tokenId);

        bytes memory svg = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300" width="720" height="300">',
            '<defs>',
            '<linearGradient id="foil" x1="0" y1="0" x2="1" y2="1">',
            '<stop offset="0%" stop-color="', foil, '" stop-opacity="0.9"/>',
            '<stop offset="50%" stop-color="', paper, '" stop-opacity="0.4"/>',
            '<stop offset="100%" stop-color="', foil, '" stop-opacity="0.9"/>',
            '</linearGradient>',
            '<clipPath id="ticket"><rect x="14" y="14" width="692" height="272" rx="6" ry="6"/></clipPath>',
            '</defs>',
            '<rect width="720" height="300" fill="#1a1a1a"/>'
        );

        // Ticket body (clipped)
        svg = abi.encodePacked(
            svg,
            '<g clip-path="url(#ticket)">',
            '<rect x="14" y="14" width="692" height="272" fill="', paper, '"/>',
            _watermarkSvg(p.watermarkAngle, ink),
            // Top & bottom double-line borders
            '<line x1="34" y1="32" x2="686" y2="32" stroke="', ink, '" stroke-width="1.2"/>',
            '<line x1="34" y1="36" x2="686" y2="36" stroke="', ink, '" stroke-width="0.5"/>',
            '<line x1="34" y1="264" x2="686" y2="264" stroke="', ink, '" stroke-width="0.5"/>',
            '<line x1="34" y1="268" x2="686" y2="268" stroke="', ink, '" stroke-width="1.2"/>'
        );

        svg = abi.encodePacked(
            svg,
            '<text x="46" y="62" font-family="Georgia,Times New Roman,serif" font-size="11" letter-spacing="3" fill="', ink, '">AXIOM \xc2\xb7 BASE \xc2\xb7 ERC-8257</text>',
            '<text x="46" y="124" font-family="Georgia,Times New Roman,serif" font-size="46" font-weight="700" fill="', ink, '">AXIOM</text>',
            '<text x="46" y="164" font-family="Georgia,Times New Roman,serif" font-size="34" font-style="italic" fill="', accent, '">tool pass</text>',
            '<text x="46" y="196" font-family="Georgia,serif" font-size="10" letter-spacing="4" fill="', ink, '">ADMIT ONE \xc2\xb7 BYPASS x402 \xc2\xb7 LIFETIME</text>',
            '<text x="46" y="248" font-family="Courier,monospace" font-size="11" letter-spacing="2" fill="', ink, '">\xe2\x84\x96 ', serial, '</text>'
        );

        // Sigils — right always, left if Twin
        svg = abi.encodePacked(svg, _sigilSvg(p, 516, 226, ink, accent));
        if (p.twin) {
            svg = abi.encodePacked(svg, _sigilSvg(p, 74, 226, ink, accent));
        }

        // Stub tint + foil strip + rotated stub text
        svg = abi.encodePacked(
            svg,
            '<rect x="576" y="14" width="130" height="272" fill="', grain, '" opacity="0.45"/>',
            '<rect x="588" y="34" width="106" height="6" fill="url(#foil)"/>',
            '<g transform="translate(641,150) rotate(-90)">',
            '<text text-anchor="middle" font-family="Georgia,serif" font-size="20" font-weight="700" letter-spacing="6" fill="', ink, '">AXIOM TOOL PASS</text>',
            '<text y="22" text-anchor="middle" font-family="Courier,monospace" font-size="9" letter-spacing="3" fill="', ink, '">\xe2\x84\x96 ', serial, '</text>',
            '</g>',
            '</g>'
        );

        // Perforation dots (every 12px between y=26 and y=280)
        for (uint256 y = 26; y < 280; y += 12) {
            svg = abi.encodePacked(
                svg,
                '<circle cx="576" cy="',
                Strings.toString(y),
                '" r="2" fill="',
                paper,
                '" stroke="',
                grain,
                '" stroke-width="0.5"/>'
            );
        }

        // Outer outline
        svg = abi.encodePacked(
            svg,
            '<rect x="14" y="14" width="692" height="272" rx="6" ry="6" fill="none" stroke="', ink, '" stroke-width="1" opacity="0.4"/>',
            '</svg>'
        );

        return svg;
    }

    // ---------------------------------------------------------------
    //  tokenURI — JSON metadata wrapped in data: URI
    // ---------------------------------------------------------------
    function tokenURI(uint256 tokenId) external pure returns (string memory) {
        require(tokenId >= 1 && tokenId <= TOTAL_SUPPLY, "tokenId out of range");
        Pass memory p = _generate(tokenId);
        bytes memory svg = _svg(tokenId, p);
        string memory imgB64 = Base64.encode(svg);

        bytes memory json = abi.encodePacked(
            '{"name":"AXIOM Tool Pass #', _pad4(tokenId),
            '","description":"', COLLECTION_DESCRIPTION,
            '","image":"data:image/svg+xml;base64,', imgB64,
            '","external_url":"https://clawbots.org/tool-pass",',
            '"background_color":"1a1a1a",',
            '"attributes":', _attributes(p, tokenId),
            "}"
        );

        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    function _attributes(Pass memory p, uint256 /*tokenId*/) private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '[',
                '{"trait_type":"Tier","value":"', _paletteTier(p.paletteIdx), '"},',
                '{"trait_type":"Palette","value":"', _paletteName(p.paletteIdx), '"},',
                '{"trait_type":"Sigil","value":"', _sigilName(p.sigilVariant), '"},',
                '{"trait_type":"Sigil Count","value":"', p.twin ? "Twin" : "Single", '"},',
                '{"trait_type":"Watermark Angle","value":"', _intToString(p.watermarkAngle), '\xc2\xb0"}',
                ']'
            )
        );
    }

    // ---------------------------------------------------------------
    //  Public read helpers — useful for off-chain verification & tests.
    // ---------------------------------------------------------------
    function traits(uint256 tokenId)
        external
        pure
        returns (
            string memory tier,
            string memory palette,
            string memory sigil,
            string memory sigilCount,
            int16 watermarkAngle,
            uint16 sigilRotation
        )
    {
        require(tokenId >= 1 && tokenId <= TOTAL_SUPPLY, "tokenId out of range");
        Pass memory p = _generate(tokenId);
        return (
            _paletteTier(p.paletteIdx),
            _paletteName(p.paletteIdx),
            _sigilName(p.sigilVariant),
            p.twin ? "Twin" : "Single",
            p.watermarkAngle,
            p.sigilRotation
        );
    }

    function svg(uint256 tokenId) external pure returns (string memory) {
        require(tokenId >= 1 && tokenId <= TOTAL_SUPPLY, "tokenId out of range");
        Pass memory p = _generate(tokenId);
        return string(_svg(tokenId, p));
    }

    // ---------------------------------------------------------------
    //  Misc helpers
    // ---------------------------------------------------------------
    function _pad4(uint256 n) private pure returns (string memory) {
        if (n < 10) return string(abi.encodePacked("000", n.toString()));
        if (n < 100) return string(abi.encodePacked("00", n.toString()));
        if (n < 1000) return string(abi.encodePacked("0", n.toString()));
        return n.toString();
    }

    function _serial(uint256 tokenId) private pure returns (string memory) {
        return string(abi.encodePacked(_pad4(tokenId), " / 1000"));
    }

    function _intToString(int256 v) private pure returns (string memory) {
        if (v < 0) return string(abi.encodePacked("-", uint256(-v).toString()));
        return uint256(v).toString();
    }
}
