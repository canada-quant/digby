/**
 * cu-diag fix #4 (2026-09-25) — the DECODED frame-readability metric that
 * replaces the bytes-per-pixel darkness proxy as the primary readability signal.
 *
 * The incident: every frame of run fa6eb1b1 was the SAME 34,932-byte
 * full-screen dark Terminal JPEG (0.022 bytes/pixel — under the 0.03 bpp
 * floor), so the loop graded a perfectly readable screen "degenerate" 44
 * times, which DISARMED the byte-identity dead-input watchdog for the whole
 * run and escalated to "call done NOW". The fixture below is a SYNTHETIC
 * stand-in for that frame (__fixtures__/dark-terminal-synthetic.jpg, generated
 * deterministically by backend/scripts/make-dark-terminal-fixture.js): the
 * real capture showed the owner's hostname/username and is not in the
 * repository. The stand-in reproduces what these tests pin — the incident
 * geometry, a dark background with a few rows of light "text" (readable to
 * any human; score ≈ 0.86 vs the real frame's 0.84) and the incident's
 * < 0.03 bytes/pixel density.
 *
 * Pinned:
 *   (i)   the dark Terminal frame is READABLE (score ≥ 0.6), so the
 *         watchdog stays armed on dark screens;
 *   (ii)  solid black / white / gray captures score ≈ 0 (unreadable);
 *   (iii) a dark contentless gradient is unreadable; a synthetic dark
 *         terminal (glyph blocks on black) is readable;
 *   (iv)  undecodable payloads (fake base64, empty, PNG) → { decoded:false }
 *         so the caller falls back to the density proxy — never a crash;
 *   (v)   frameDiffPercent: identical → 0, different content → > 0,
 *         geometry mismatch / undecoded → null.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  analyzeFrame,
  describeFrameMetrics,
  frameDiffPercent,
  metricsFromRgba,
  READABLE_SCORE_MIN,
} from './frame-readability';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jpeg = require('jpeg-js');

const FIXTURE = path.join(__dirname, '__fixtures__', 'dark-terminal-synthetic.jpg');
const terminalB64 = fs.readFileSync(FIXTURE).toString('base64');

const W = 1568, H = 1013;
function synth(fn: (x: number, y: number) => [number, number, number], width = W, height = H): string {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 75).data).toString('base64');
}

describe('frame-readability (cu-diag fix #4)', () => {
  it('(i) the incident-class frame — a full-screen dark Terminal JPEG (synthetic stand-in) — is READABLE, so byte-identity dead-input detection stays armed on dark screens', () => {
    const m = analyzeFrame(terminalB64);
    expect(m.decoded).toBe(true);
    if (!m.decoded) return;
    expect(m.width).toBe(1568);
    expect(m.height).toBe(1013);
    expect(m.readable).toBe(true);
    expect(m.score).toBeGreaterThanOrEqual(0.6);
    expect(m.lumaStd).toBeGreaterThan(15);
    expect(m.distinctColors).toBeGreaterThanOrEqual(20);
    // The frame's DENSITY sits in the incident's band (0.022 bpp there, < 0.03
    // here) — the old proxy would have called it degenerate.
    const bpp = (terminalB64.length * 3) / 4 / (1568 * 1013);
    expect(bpp).toBeLessThan(0.03);
    expect(describeFrameMetrics(m)).toMatch(/^readability 0\.\d\d \(luma σ/);
  });

  it('(ii) solid black / white / gray captures score ≈ 0 — unreadable', () => {
    for (const v of [0, 128, 255]) {
      const m = analyzeFrame(synth(() => [v, v, v]));
      expect(m.decoded).toBe(true);
      if (!m.decoded) return;
      expect(m.readable).toBe(false);
      expect(m.score).toBeLessThan(0.1);
      expect(m.distinctColors).toBe(1);
      expect(m.edgeDensity).toBe(0);
    }
  });

  it('(iii) a dark contentless gradient is unreadable; a synthetic dark terminal (glyph blocks on black) is readable', () => {
    const gradient = analyzeFrame(synth((x, y) => [Math.floor((x / W) * 30), 10, Math.floor((y / H) * 30)]));
    expect(gradient.decoded && gradient.readable).toBe(false);
    if (gradient.decoded) expect(gradient.score).toBeLessThan(READABLE_SCORE_MIN);
    const term = analyzeFrame(synth((x, y) => (y % 14 < 8 && x > 10 && x < 700 && (x + y) % 5 === 0 ? [200, 200, 200] : [0, 0, 0])));
    expect(term.decoded && term.readable).toBe(true);
    // A sparse-but-real screen (dark desktop + menu bar) is still readable UI.
    const menubar = analyzeFrame(synth((_x, y) => (y < 24 ? [230, 230, 230] : [18, 18, 20])));
    expect(menubar.decoded && menubar.readable).toBe(true);
  });

  it('(iv) undecodable payloads degrade to { decoded:false } — the caller falls back to the density proxy, never crashes', () => {
    expect(analyzeFrame('RnJhbWUx'.repeat(100)).decoded).toBe(false); // the suites\' fake frames
    expect(analyzeFrame('').decoded).toBe(false);
    expect(analyzeFrame(undefined).decoded).toBe(false);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
    const m = analyzeFrame(png);
    expect(m.decoded).toBe(false);
    if (!m.decoded) expect(m.reason).toBe('not a JPEG');
    // A truncated JPEG (magic bytes, then garbage) is caught, not thrown.
    const truncated = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]).toString('base64');
    expect(() => analyzeFrame(truncated)).not.toThrow();
    expect(analyzeFrame(truncated).decoded).toBe(false);
    expect(metricsFromRgba(new Uint8Array(0), 0, 0).decoded).toBe(false);
  });

  it('(v) frameDiffPercent: identical → 0; different content → > 0; geometry mismatch or undecoded → null', () => {
    const a = analyzeFrame(terminalB64);
    const b = analyzeFrame(terminalB64);
    const black = analyzeFrame(synth(() => [0, 0, 0]));
    const small = analyzeFrame(synth(() => [0, 0, 0], 800, 600));
    expect(frameDiffPercent(a, b)).toBe(0);
    const pct = frameDiffPercent(a, black);
    expect(pct).not.toBeNull();
    expect(pct as number).toBeGreaterThan(0); // the text rows differ from solid black
    expect(pct as number).toBeLessThan(10); // …and they are a small part of the screen
    expect(frameDiffPercent(a, small)).toBeNull();
    expect(frameDiffPercent(a, { decoded: false, reason: 'x' })).toBeNull();
    expect(frameDiffPercent(null, a)).toBeNull();
  });
});
