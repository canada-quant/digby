/**
 * Frame readability — a DECODED metric for computer-use screenshots
 * (cu-diag fix #4, 2026-09-25; replaces the bytes-per-pixel darkness proxy of
 * ticket 33401f39 as the primary signal).
 *
 * WHY: the bpp proxy graded the incident's real, readable, full-screen dark
 * Terminal frames (0.022 bytes/pixel — well under the 0.03 floor) as
 * "degenerate", which silently DISARMED the byte-identity dead-input watchdog
 * for the whole run (44 "degenerate" events, 0 strikes) and produced 44 LOW-
 * DENSITY cautions ending in "call done NOW". Compression density measures
 * how much the encoder had to write, not whether a human could read the
 * frame — a dark terminal with two lines of text and a solid black capture
 * land in the same band (and the band moves with the encoder: PIL q75 solids
 * ≈ 0.016, jpeg-js q75 solids ≈ 0.028).
 *
 * WHAT: decode the JPEG (jpeg-js — pure JS, already in the dependency tree via
 * heic-convert; the vendor "sharp" was not a backend dependency and a native
 * module is not worth adding for a 256-px thumbnail), area-average it to a
 * ≈256-px-wide thumbnail, and score three cheap features:
 *   - luma standard deviation  (a solid is 0; any UI ≥ ~20)
 *   - distinct colours          (4-bit/channel quantized; a solid is 1)
 *   - edge density              (fraction of thumbnail cells whose right or
 *                                lower neighbour differs by > 12 luma)
 * score = mean of the three, each saturated at a calibrated ceiling.
 *
 * CALIBRATION (measured 2026-09-25 on the incident frames + jpeg-js q75
 * synthetics at 1568×1013):
 *   real dark Terminal (2 lines of text)   std 21.5  colours 23  edge 0.0115 → 0.84
 *   real TextEdit-on-dark                  std 21.6  colours 25  edge 0.0118 → 0.85
 *   real Finder (content-rich)             std 67.5  colours 925 edge 0.28   → 1.00
 *   solid black / white / gray             std 0     colours 1   edge 0      → 0.00
 *   dark gradient, no UI                   std 2.8   colours 4   edge 0      → 0.10
 *   dark desktop + menu bar only           std 32.4  colours 2   edge 0.006  → 0.46
 *   blank light document, a few text lines std 5.5   colours 3   edge 0.13   → 0.47
 * READABLE_SCORE_MIN = 0.3: every real screen sits ≥ 0.46, every contentless
 * capture ≤ 0.10. Solids score ~0; dark terminals score high — so byte-
 * identity dead-input detection stays ARMED on dark screens.
 *
 * Cost: ~30–70 ms synchronous decode per 1568-px frame (≤ 13 frames per
 * session). Fail-open: an undecodable payload (not a JPEG, corrupt, jpeg-js
 * missing) returns { decoded: false } and the caller falls back to the legacy
 * bpp proxy — never a crash, never a false "unreadable".
 *
 * PURE LEAF (no project imports) — unit-testable with real JPEGs.
 */

/** Score at/above which a frame is treated as READABLE (has UI content). */
export const READABLE_SCORE_MIN = 0.3;
/** Thumbnail width the metric is computed on (area-averaged cells). */
export const THUMB_WIDTH = 256;
/** Luma delta between neighbouring cells that counts as an edge. */
const EDGE_LUMA_DELTA = 12;
/** Cell-diff threshold for the pixel-change percentage between two frames. */
const DIFF_LUMA_DELTA = 12;
/** jpeg-js decode ceiling — a 1568×1013 RGBA frame is ~6 MB; 64 MB bounds abuse. */
const MAX_DECODE_MB = 64;

export interface DecodedFrameMetrics {
  decoded: true;
  width: number;
  height: number;
  lumaStd: number;
  distinctColors: number;
  edgeDensity: number;
  /** 0..1 — see the module header. */
  score: number;
  readable: boolean;
  /** Thumbnail luma grid (row-major, gridW×gridH) — kept for frame diffs. */
  grid: Float32Array;
  gridW: number;
  gridH: number;
}
export interface UndecodedFrameMetrics {
  decoded: false;
  reason: string;
}
export type FrameMetrics = DecodedFrameMetrics | UndecodedFrameMetrics;

type JpegDecoder = (buf: Buffer, opts: Record<string, unknown>) => { width: number; height: number; data: Uint8Array };

let decoderCache: JpegDecoder | null | undefined;
/** jpeg-js is loaded lazily so a missing module degrades to { decoded:false }. */
function loadDecoder(): JpegDecoder | null {
  if (decoderCache !== undefined) return decoderCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('jpeg-js');
    decoderCache = typeof mod?.decode === 'function' ? (mod.decode as JpegDecoder) : null;
  } catch {
    decoderCache = null;
  }
  return decoderCache;
}

/** Decode a base64 JPEG payload and compute the readability metrics. */
export function analyzeFrame(base64: string | undefined | null): FrameMetrics {
  if (!base64) return { decoded: false, reason: 'no payload' };
  const decode = loadDecoder();
  if (!decode) return { decoded: false, reason: 'jpeg decoder unavailable' };
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return { decoded: false, reason: 'invalid base64' };
  }
  // JPEG magic (FF D8) — anything else (PNG, placeholder text) is not ours to decode.
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { decoded: false, reason: 'not a JPEG' };
  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: MAX_DECODE_MB, tolerantDecoding: true });
  } catch (e: any) {
    return { decoded: false, reason: `decode failed: ${e?.message || e}` };
  }
  return metricsFromRgba(img.data, img.width, img.height);
}

/** The metric over raw RGBA pixels (exported so tests can feed synthetic frames). */
export function metricsFromRgba(data: Uint8Array, width: number, height: number): FrameMetrics {
  if (!width || !height || data.length < width * height * 4) return { decoded: false, reason: 'empty image' };
  const stride = Math.max(1, Math.round(width / THUMB_WIDTH));
  const gridW = Math.max(1, Math.floor(width / stride));
  const gridH = Math.max(1, Math.floor(height / stride));
  const grid = new Float32Array(gridW * gridH);
  const colors = new Set<number>();
  const cellN = stride * stride;
  let sum = 0;
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      let r = 0, g = 0, b = 0;
      const y0 = gy * stride, x0 = gx * stride;
      for (let dy = 0; dy < stride; dy++) {
        let i = ((y0 + dy) * width + x0) * 4;
        for (let dx = 0; dx < stride; dx++, i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2];
        }
      }
      r /= cellN; g /= cellN; b /= cellN;
      const l = (r * 299 + g * 587 + b * 114) / 1000;
      grid[gy * gridW + gx] = l;
      sum += l;
      colors.add(((Math.round(r) >> 4) << 8) | ((Math.round(g) >> 4) << 4) | (Math.round(b) >> 4));
    }
  }
  const n = gridW * gridH;
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) { const d = grid[i] - mean; varSum += d * d; }
  const lumaStd = Math.sqrt(varSum / n);
  let edges = 0, pairs = 0;
  for (let gy = 0; gy < gridH - 1; gy++) {
    for (let gx = 0; gx < gridW - 1; gx++) {
      const l = grid[gy * gridW + gx];
      if (Math.abs(l - grid[gy * gridW + gx + 1]) > EDGE_LUMA_DELTA || Math.abs(l - grid[(gy + 1) * gridW + gx]) > EDGE_LUMA_DELTA) edges++;
      pairs++;
    }
  }
  const edgeDensity = pairs ? edges / pairs : 0;
  const score = (Math.min(1, lumaStd / 20) + Math.min(1, colors.size / 24) + Math.min(1, edgeDensity / 0.02)) / 3;
  return {
    decoded: true,
    width,
    height,
    lumaStd,
    distinctColors: colors.size,
    edgeDensity,
    score,
    readable: score >= READABLE_SCORE_MIN,
    grid,
    gridW,
    gridH,
  };
}

/**
 * Percentage (0..100) of thumbnail cells whose luma moved by > DIFF_LUMA_DELTA
 * between two decoded frames of the same geometry; null when either frame is
 * undecoded or the geometries differ (a display switch — the caller reports
 * that separately).
 */
export function frameDiffPercent(a: FrameMetrics | null | undefined, b: FrameMetrics | null | undefined): number | null {
  if (!a || !b || !a.decoded || !b.decoded) return null;
  if (a.gridW !== b.gridW || a.gridH !== b.gridH) return null;
  const n = a.grid.length;
  if (!n) return null;
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a.grid[i] - b.grid[i]) > DIFF_LUMA_DELTA) changed++;
  return Math.round((changed / n) * 1000) / 10;
}

/** One-line human summary of a frame's metrics (rides harness notes). */
export function describeFrameMetrics(m: FrameMetrics): string {
  if (!m.decoded) return `undecoded (${m.reason})`;
  return `readability ${m.score.toFixed(2)} (luma σ ${m.lumaStd.toFixed(1)}, ${m.distinctColors} colours, edges ${(m.edgeDensity * 100).toFixed(1)}%)`;
}
