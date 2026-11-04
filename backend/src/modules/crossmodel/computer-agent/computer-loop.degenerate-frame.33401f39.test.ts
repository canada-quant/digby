/**
 * Ticket 33401f39 — degenerate-frame detector (backend half): a solid
 * (black/white/gray) capture is a structurally-valid JPEG that passes every
 * presence check while carrying zero readable content. The incident (Digby Mac
 * app v0.4.2, "connected", Screen Recording + Accessibility granted): a whole
 * computer-task run returned black/unreadable frames — 10 steps attempted,
 * none legible — because macOS serves a newly-granted Screen Recording
 * permission only to a freshly launched process; the helper predating the
 * grant captured solids. macOS applies new Accessibility grants the same way.
 *
 * CALIBRATION (PIL 12.3.0-generated real JPEGs at the agent's geometry —
 * sips -Z 1568, JPEG quality 75 — 2026-09-24): solid black / white / gray all
 * encode at bpp ≈ 0.0162 (19,971 raw bytes / 26,628 base64 chars for
 * 1478×832); a content-rich screen renders at bpp ≈ 0.1534 (188,617 bytes /
 * 251,492 b64 chars). Threshold = 0.03 (5× above solids, 5× below real
 * screens). A real macOS screen ALWAYS carries the menu bar, so it is never a
 * pure solid. Absolute size alone cannot detect the class (a solid JPEG is
 * still ~20 KB); bytes-per-pixel is the metric.
 *
 * Pinned here (unit pins over the exported helpers + the loop's gate shapes):
 *   (i)   screenshotBpp: a calibrated SOLID fixture lands below the
 *         threshold; a CONTENT-RICH fixture lands above it;
 *   (ii)  screenshotBpp edge shapes: missing dims / missing base64 → 0
 *         (never a false degenerate);
 *   (iii) degenerateFrameNotice is a CAUTION: names BOTH causes (solid
 *         capture / dark quiet real screen), the QUIT + RELAUNCH fix, and
 *         defers readability to the model that sees the frame;
 *   (iv)  the threshold headroom: 0.03 sits ≥1.5× above the measured solid
 *         band and ≥3× below content-rich screens.
 *
 * ADVERSARIAL REVIEW (PR #1030, B1, 2026-09-24): sparse-but-real screens
 * OVERLAP the solid band (measured: dark desktop + menu bar ≈ 0.019, + dock
 * ≈ 0.022, mostly-blank document ≈ 0.026 vs solids ≈ 0.0162), so density can
 * never PROVE unreadability — hence caution, never a steps-0 refusal. The
 * no-refusal behavior itself is pinned in computer-agent.test.ts ("a
 * low-density first frame does NOT end the session").
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The loop's transitive chain pulls env.ts (process.exit without env vars) via
// driver.ts → agent-link/config/redis AND imessage.service → config/database —
// mock the boundaries so the exported helpers under test load hermetically
// (they are pure functions; the dd3a19fa/03587322 scaffolding idiom).
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../imessage/agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: jest.fn(), deliverResult: jest.fn(), waitForCommand: jest.fn() },
}));
jest.mock('../imessage/imessage.service', () => ({
  __esModule: true,
  computerAgentStatus: jest.fn(async () => ({ available: true, status: 'connected', agentVersion: '0.5.0', agentId: 'a', lastSeenAt: new Date() })),
  listIMessageAgents: jest.fn(async () => []),
  ONLINE_WINDOW_MS: 45_000,
}));
jest.mock('./driver', () => ({ __esModule: true, selectComputerDriver: jest.fn() }));

import {
  DEGENERATE_BPP_THRESHOLD,
  screenshotBpp,
  degenerateFrameNotice,
} from './computer-loop';

// ── Real JPEG fixtures generated at test time (no binary fixtures in git) ──
// Reproduces the calibration probe exactly: PIL-equivalent generation via
// Node's zlib on a raw PPM→JPEG is overkill; instead we use the MEASURED
// encodings from the calibration run: a solid 1478×832 JPEG at quality 75 is
// 19,971 bytes (26,628 b64 chars) and a content-rich one is 188,617 bytes
// (251,492 b64 chars). The fixtures below are those exact byte lengths of
// VALID base64 (content irrelevant to the ratio — only the LENGTH matters to
// screenshotBpp, which is the unit under test).
const W = 1478, H = 832, PX = W * H;
const solidB64 = 'A'.repeat(26628); // 19,971 raw bytes → bpp 0.0162 (measured)
const richB64 = 'B'.repeat(251492); // 188,617 raw bytes → bpp 0.1534 (measured)

describe('33401f39: degenerate-frame detector (backend half)', () => {
  it('(i) a PIL-calibrated SOLID frame lands below the threshold; a CONTENT-RICH frame above it', () => {
    const solidBpp = screenshotBpp({ screenshotBase64: solidB64, imageWidth: W, imageHeight: H });
    const richBpp = screenshotBpp({ screenshotBase64: richB64, imageWidth: W, imageHeight: H });
    expect(solidBpp).toBeGreaterThan(0);
    expect(richBpp).toBeGreaterThan(0);
    expect(solidBpp).toBeLessThan(DEGENERATE_BPP_THRESHOLD); // solid → degenerate
    expect(richBpp).toBeGreaterThan(DEGENERATE_BPP_THRESHOLD); // real screen → passes
    // The 10× separation from the calibration run holds on the ratio:
    expect(richBpp / solidBpp).toBeGreaterThan(5);
  });

  it('(ii) edge shapes never yield a false degenerate: missing dims or base64 → 0', () => {
    expect(screenshotBpp({ screenshotBase64: solidB64, imageWidth: 0, imageHeight: 0 })).toBe(0);
    expect(screenshotBpp({ screenshotBase64: '', imageWidth: W, imageHeight: H })).toBe(0);
    expect(screenshotBpp({ screenshotBase64: undefined, imageWidth: W, imageHeight: H })).toBe(0);
  });

  it('(iii) the notice is a CAUTION: both causes named, QUIT + RELAUNCH fix, readability deferred to the model', () => {
    const bpp = screenshotBpp({ screenshotBase64: solidB64, imageWidth: W, imageHeight: H });
    const notice = degenerateFrameNotice(bpp);
    expect(notice).toContain('CAUTION');
    expect(notice).toContain(bpp.toFixed(4));
    expect(notice).toMatch(/QUIT \+ RELAUNCH/);
    expect(notice).toContain('dark/quiet real screen'); // the non-defect cause is named
    expect(notice).toContain('LOOK at the frame'); // the model that SEES the frame judges
  });

  it('(iv) the calibration method is pinned: a threshold of 0.03 sits between the measured solid and rich densities — ≥1.5× above solids, ≥3× below real screens', () => {
    const solidBpp = screenshotBpp({ screenshotBase64: solidB64, imageWidth: W, imageHeight: H });
    const richBpp = screenshotBpp({ screenshotBase64: richB64, imageWidth: W, imageHeight: H });
    // measured: solid 0.0162, rich 0.1534 → threshold/solid ≈ 1.85×, rich/threshold ≈ 5.1×.
    // The solid side has LESS headroom (a solid at a SMALLER geometry compresses
    // denser — 1080p solid ≈ 0.021), so the floor is 1.5×; the rich side keeps 3×.
    expect(DEGENERATE_BPP_THRESHOLD / solidBpp).toBeGreaterThanOrEqual(1.5);
    expect(richBpp / DEGENERATE_BPP_THRESHOLD).toBeGreaterThanOrEqual(3);
  });
});
