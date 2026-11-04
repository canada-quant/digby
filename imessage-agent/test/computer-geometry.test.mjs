/**
 * Regression tests for the computer-use input-integrity path (feedback ticket
 * 4e4d56ff).
 *
 * The mishap (2026-09-09, Mac agent v0.4.2): five consecutive computer_task
 * runs returned perfect screenshots while synthetic input failed — clicks
 * landed at wrong coordinates (a "People" nav click focused Chrome's address
 * bar), wheel-scrolls never moved the page, and arrow keys were dead after
 * defocus. Every action reported SUCCESS while the pointer was somewhere else
 * — nothing verified that input actually landed where the model aimed.
 *
 * The hardening (agent v0.4.3) is VERIFY-OR-REFUSE:
 *   1. clicks move the pointer, read the cursor back (CGEventGetLocation of a
 *      fresh event), retry once, and REFUSE to click blind when the pointer
 *      verifiably did not arrive;
 *   2. scroll accepts an optional x/y target — the pointer is moved+verified
 *      there before the wheel event, so scrolls hit the content the model
 *      pointed at (previously the wheel fired under the STALE cursor, which a
 *      mis-landed click had left over non-scrollable chrome);
 *   3. the display's point size is cross-checked (CGDisplayBounds vs NSScreen
 *      vs the screenshot's aspect ratio) and clicks/targeted scrolls are
 *      REFUSED on an unreconciled mismatch — a wrong-display point size is
 *      exactly how clicks get scaled into wrong coordinates.
 *
 * These tests pin: (a) the image-pixel → CG-point conversion against the
 * ticket's exact numbers, (b) the geometry reconciliation decision table,
 * (c) the fail-loud refusal shape, and (d) structural pins that the built
 * (shipped) runner keeps the cursor read-back + targeted scroll + refusal.
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first — tests import the
 * BUILT module, i.e. exactly what ships in the app bundle).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const { pickScreenSize, screenPointFor } = await import(join(pkgRoot, 'dist', 'computer.js'));

// ── (a) the coordinate conversion, pinned to the ticket's exact numbers ──────

test('4e4d56ff replay: ticket screenshot geometry converts to the documented contract', () => {
  // The incident screenshot space: 1568×882 px on a 1920×1080-pt display.
  const shot = { imageWidth: 1568, imageHeight: 882, screenWidth: 1920, screenHeight: 1080 };
  // The ticket's "People" nav click at (797,183) image px → (976,224) CG pt.
  assert.deepEqual(screenPointFor(797, 183, shot), { px: 976, py: 224 });
  // Dead-center card click (484,307) → (593,376).
  assert.deepEqual(screenPointFor(484, 307, shot), { px: 593, py: 376 });
  // Corners map to corners (no offset, no drift).
  assert.deepEqual(screenPointFor(0, 0, shot), { px: 0, py: 0 });
  assert.deepEqual(screenPointFor(1568, 882, shot), { px: 1920, py: 1080 });
});

test('Retina geometry: downscaled pixel image → POINT space (not pixel space)', () => {
  // 14" MacBook Pro class: 1512×982 pt, Retina capture downscaled by sips.
  const shot = { imageWidth: 1568, imageHeight: 1018, screenWidth: 1512, screenHeight: 982 };
  const p = screenPointFor(784, 509, shot); // image center → screen center
  assert.equal(p.px, 756);
  assert.equal(p.py, 491);
  // A 2x (pixel-space) result would be ~1512×1018 — the pre-fix confusion the
  // ticket probed with its "2x-coordinate test". Points stay points.
  assert.ok(p.px < 1512 && p.py < 982);
});

// ── (b) geometry reconciliation decision table ───────────────────────────────

test('pickScreenSize: matching CG bounds win', () => {
  const r = pickScreenSize(1568, 882, 1920, 1080, 1512, 982);
  assert.deepEqual(r, { width: 1920, height: 1080 });
});

test('pickScreenSize: CG mismatch + NSScreen match self-heals to NSScreen', () => {
  // Multi-display trap: CGDisplayBounds glitched to the wrong display (16:10)
  // while NSScreen still reports the captured 16:9 display.
  const r = pickScreenSize(1568, 882, 1512, 982, 1920, 1080);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.mismatch, undefined);
});

test('4e4d56ff replay: unreconciled mismatch is FLAGGED (the fail-loud guard)', () => {
  // NEITHER source matches the screenshot's aspect — sizing clicks off either
  // would land them at wrong coordinates. This is the incident shape: the
  // agent must refuse to guess rather than mis-scale.
  const r = pickScreenSize(1568, 882, 1512, 982, 1440, 900);
  assert.equal(r.width, 1512); // CG kept (the CGEvent-native source)…
  assert.equal(r.height, 982);
  assert.ok(r.mismatch, 'mismatch must be flagged so toPoints refuses');
  assert.match(r.mismatch, /1512×982/);
  assert.match(r.mismatch, /1440×900/); // NSScreen disagreement is diagnostic context
});

test('pickScreenSize: total geometry failure is flagged, not silent zeros', () => {
  const r = pickScreenSize(1568, 882, 0, 0, 0, 0);
  assert.equal(r.width, 0);
  assert.ok(r.mismatch);
});

test('pickScreenSize: CG-only (NSScreen unreadable) still serves CG when it matches', () => {
  const r = pickScreenSize(1568, 882, 1920, 1080, 0, 0);
  assert.deepEqual(r, { width: 1920, height: 1080 });
});

// ── (c) structural pins on the shipped source (the dist ships verbatim) ─────

test('structural pin (4e4d56ff): click verifies the cursor landing before clicking', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  // The read-back idiom must be inside a moveAndVerify helper…
  assert.match(src, /function moveAndVerify\(x, y\)/, 'cursor read-back helper missing');
  assert.match(src, /CGEventGetLocation\(\$\.CGEventCreate\(\$\(\)\)\)/, 'cursor read-back idiom missing');
  // …and the click action must REFUSE when the pointer verifiably mis-landed.
  const clickAction = src.split("if (action === 'click')")[1].split("if (action === 'scroll')")[0];
  assert.match(clickAction, /moveAndVerify\(x, y\)/, 'click does not verify the pointer landing');
  assert.match(clickAction, /!mv\.verified/, 'click has no refuse-on-mis-land branch');
  assert.match(clickAction, /NOT clicking blind/, 'click refusal error text missing');
});

test('structural pin (4e4d56ff): scroll can be targeted, and refuses a mis-landed move', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  const scrollAction = src.split("if (action === 'scroll')")[1].split("if (action === 'type')")[0];
  assert.match(scrollAction, /moveAndVerify\(p\.x, p\.y\)/, 'targeted scroll does not move+verify first');
  assert.match(scrollAction, /NOT scrolling blind/, 'scroll refusal error text missing');
});

test('structural pin (4e4d56ff): toPoints refuses on unreconciled geometry', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  const toPoints = src.split('function toPoints(')[1].split('export async function click')[0];
  assert.match(toPoints, /geometryMismatch/, 'toPoints has no geometry-mismatch guard');
  assert.match(toPoints, /refusing to guess click coordinates/, 'toPoints refusal error text missing');
});

test('structural pin (4e4d56ff): screen_size returns BOTH geometry sources', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  const screenSize = src.split("if (action === 'screen_size')")[1].split("if (action === 'preflight')")[0];
  for (const field of ['cgWidth', 'cgHeight', 'nsWidth', 'nsHeight']) {
    assert.ok(screenSize.includes(field), `screen_size must return ${field} for cross-validation`);
  }
});
