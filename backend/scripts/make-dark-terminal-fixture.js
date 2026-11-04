#!/usr/bin/env node
/**
 * Generates the SYNTHETIC dark-terminal test fixture
 *   backend/src/modules/crossmodel/computer-agent/__fixtures__/dark-terminal-synthetic.jpg
 *
 * WHY SYNTHETIC: the cu-diag 2026-09-25 incident frame (runs fa6eb1b1 /
 * f19b0636) was a real full-screen capture of the owner's dark Terminal —
 * 1568×1013, 34,932 bytes (0.022 bytes/pixel), two lines of green prompt text
 * showing the owner's hostname and username. That image must never land in
 * the repository history, so the tests use this deterministic stand-in, which
 * reproduces every property the suites pin:
 *   - decodes to 1568×1013 (the incident geometry);
 *   - the DECODED readability metric (frame-readability.ts) calls it READABLE
 *     (score ≥ 0.6, luma σ > 15, ≥ 20 distinct colours): a near-black screen
 *     with a few rows of light-grey "text-like" rectangles, a green/blue prompt
 *     and a bright cursor block;
 *   - the legacy bytes-per-pixel proxy calls it DEGENERATE (< 0.03 bpp) — the
 *     incident's blindness, which the fix #4 tests replay on demand. jpeg-js
 *     writes 4:4:4 with the standard Huffman tables, so a 1568×1013 frame costs
 *     ≈ 44 KB (0.0278 bpp) before any content; the rectangles are aligned to the
 *     8-px DCT grid so every block is flat and the content costs only DC jumps;
 *   - it differs from solid black on a SMALL share (< 10%) of the harness
 *     thumbnail cells (frameDiffPercent).
 *
 * Deterministic: no randomness; re-running yields byte-identical output for the
 * same jpeg-js version (0.4.4, a direct backend dependency).
 *
 * Usage (from backend/ or the repo root):
 *   node backend/scripts/make-dark-terminal-fixture.js
 * The script prints the metric inputs it can compute locally (a port of the
 * readability features — informational; the jest suites are the contract).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const W = 1568;
const H = 1013;
const QUALITY = 60;
const OUT = path.resolve(
  __dirname,
  '..',
  'src/modules/crossmodel/computer-agent/__fixtures__/dark-terminal-synthetic.jpg',
);

// Palette (r, g, b). The background luma (8.2) stays under the harness diff
// threshold (12) so background cells never count as "changed" vs solid black.
const BG = [8, 8, 10];
const GREY = [212, 212, 218]; // output text
const GREEN = [86, 214, 120]; // prompt user@host
const BLUE = [110, 170, 250]; // prompt path
const YELLOW = [240, 200, 90]; // a highlighted word
const CYAN = [100, 220, 230];
const MAGENTA = [220, 120, 220];
const ORANGE = [250, 150, 60];
const CURSOR = [236, 236, 240];
// macOS window traffic lights (16×16 dots): three more distinct colours.
const LIGHT_RED = [255, 95, 87];
const LIGHT_YELLOW = [255, 189, 46];
const LIGHT_GREEN = [40, 201, 64];

// Geometry contract (keeps the encoded content cheap AND the thumbnail metric
// predictable): every rectangle's x/width is a multiple of 8 (no DCT block
// straddles an edge, so each block is flat and costs only its DC jump); text
// rows sit at y multiples of 24 with height 24 — the LCM of the 8-px block and
// the metric's 6-px thumbnail cell — so no thumbnail row is partially covered
// (edges come only from the row above/below and the word boundaries). Word
// x-offsets vary mod 6, so the boundary cells carry partial coverage in
// several distinct levels per colour: that variety is what lifts the
// distinct-colour count well past the metric's 20-colour floor.
const ROW_H = 24;
const X0 = 24;
const GAP = 16;
// [y, [[width, colour], ...]] — y multiples of 24.
const LINES = [
  [72, [[104, GREEN], [72, BLUE], [8, GREY], [160, GREY]]],
  [96, [[200, GREY], [96, CYAN]]],
  [120, [[88, MAGENTA], [160, GREY], [48, ORANGE]]],
  [144, [[240, GREY]]],
  [192, [[104, GREEN], [72, BLUE], [8, GREY], [16, CURSOR]]],
];
const DOTS = [[16, LIGHT_RED], [40, LIGHT_YELLOW], [64, LIGHT_GREEN]]; // x; y = 32, 16×16

const data = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  data[i * 4] = BG[0];
  data[i * 4 + 1] = BG[1];
  data[i * 4 + 2] = BG[2];
  data[i * 4 + 3] = 255;
}
function rect(x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}
for (const [y, segments] of LINES) {
  let x = X0;
  for (const [w, colour] of segments) {
    rect(x, y, w, ROW_H, colour);
    x += w + GAP;
  }
}
for (const [x, colour] of DOTS) rect(x, 32, 16, 16, colour);

const encoded = Buffer.from(jpeg.encode({ data, width: W, height: H }, QUALITY).data);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encoded);

// ── Informational self-check (a port of frame-readability.ts's features) ──
const img = jpeg.decode(encoded, { useTArray: true, formatAsRGBA: true });
const stride = Math.max(1, Math.round(img.width / 256));
const gridW = Math.floor(img.width / stride);
const gridH = Math.floor(img.height / stride);
const grid = new Float32Array(gridW * gridH);
const colours = new Set();
let sum = 0;
for (let gy = 0; gy < gridH; gy++) {
  for (let gx = 0; gx < gridW; gx++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < stride; dy++) {
      let i = ((gy * stride + dy) * img.width + gx * stride) * 4;
      for (let dx = 0; dx < stride; dx++, i += 4) {
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
      }
    }
    const n = stride * stride;
    r /= n; g /= n; b /= n;
    const l = (r * 299 + g * 587 + b * 114) / 1000;
    grid[gy * gridW + gx] = l;
    sum += l;
    colours.add(((Math.round(r) >> 4) << 8) | ((Math.round(g) >> 4) << 4) | (Math.round(b) >> 4));
  }
}
const n = gridW * gridH;
const mean = sum / n;
let v = 0;
for (let i = 0; i < n; i++) v += (grid[i] - mean) ** 2;
const lumaStd = Math.sqrt(v / n);
let edges = 0, pairs = 0, changedVsBlack = 0;
for (let gy = 0; gy < gridH; gy++) {
  for (let gx = 0; gx < gridW; gx++) {
    const l = grid[gy * gridW + gx];
    if (l > 12) changedVsBlack++;
    if (gy < gridH - 1 && gx < gridW - 1) {
      if (Math.abs(l - grid[gy * gridW + gx + 1]) > 12 || Math.abs(l - grid[(gy + 1) * gridW + gx]) > 12) edges++;
      pairs++;
    }
  }
}
const edgeDensity = edges / pairs;
const score = (Math.min(1, lumaStd / 20) + Math.min(1, colours.size / 24) + Math.min(1, edgeDensity / 0.02)) / 3;
const bpp = encoded.length / (img.width * img.height);
console.log(
  `${path.relative(process.cwd(), OUT)}: ${encoded.length} bytes, ${img.width}×${img.height}, ` +
    `bpp ${bpp.toFixed(4)} (${bpp < 0.03 ? 'legacy proxy: degenerate' : 'legacy proxy: readable — TOO LARGE'}), ` +
    `luma σ ${lumaStd.toFixed(1)}, ${colours.size} colours, edges ${(edgeDensity * 100).toFixed(2)}%, ` +
    `score ${score.toFixed(3)}, diff vs black ${((changedVsBlack / n) * 100).toFixed(1)}%`,
);
