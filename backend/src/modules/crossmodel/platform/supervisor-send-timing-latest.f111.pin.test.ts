/**
 * PIN (FO firing 111, 2026-10-10) — supervisor_send_timing_latest must print
 * the LATEST fleet-surface send rows regardless of window, so no firing ever
 * re-derives "is the DW-5 instrument idle, off, or showing the fix" by hand.
 *
 * THE GAP THIS PINS: the f68 instrument's supervisor_send_timing_4h section
 * windows to 4 hours — and an EMPTY window answers nothing. f111 paid exactly
 * that tax: the DW-5 fix (f110, squash 6068a547, deployed 2026-10-10T07:47Z)
 * had produced ZERO post-fix sends by firing time, the 4h section printed [],
 * and "idle vs instrument-off" (SUPERVISOR_SEND_TIMING_DISABLED=1 suppresses
 * rows identically; NOTE 2026-10-30, RSW-1: that switch was since deleted as
 * NF_INERT, so "instrument-off" is no longer an armable state — the pin's
 * zero-rows-⇒-instrument_silent reading is now unambiguous) could only be
 * resolved by hand-rolling a /tmp SQL probe
 * through prodq.sh. The exact by-eye burden the f64 doctrine exists to remove.
 *
 * THE FIX (firing 111, 28th f64 bake): a supervisor_send_timing_latest
 * section — the LATEST 5 rows with NO window filter (zero rows EVER ⇒ the
 * section prints [] ⇒ instrument_silent by construction), each row carrying
 * age_min / auth_ms / deliver_ms plus a verdict ladder:
 *   window_idle     — max(createdAt) OVER () older than 4h: nothing to time
 *                     this window; the DW-5 authMs arm verifies only on rows
 *                     newer than the fix deploy (2026-10-10T07:47Z);
 *   stale_post_fix  — a row NEWER than the fix deploy still showing
 *                     authMs > 1000: the fix did NOT take (kill switch
 *                     SEND_AUTH_LIGHT_DISABLED armed? legacy branch?);
 *   ok              — post-fix rows in double-digit auth territory.
 * Branch order: window_idle tests the WINDOW-max first (the f61 sibling-arm
 * rule does not bite — the window test reads the OVER () max, not a SELECT
 * alias); stale_post_fix keys on the row's OWN createdAt, so an OLD row never
 * trips it and a NEW row above the bar always does.
 *
 * Live validation (box A, pre-deploy, prodq.sh with the section SQL verbatim,
 * 2026-10-10T10:48Z): 5 latest rows, all c0e22e36, verdict window_idle on
 * every row — auth_ms 4079/4372/4761/19086 (the four PRE-fix sends the f110
 * fix eliminated) — the ladder reproduces f111's hand adjudication natively.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f101 pins): the
 * shipped audit declares the section and its ladder, and a JS model of the
 * ladder reproduces the live window plus synthetic regimes.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92–f101 pin tests declare top-level fs/path the same way)

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const AUDIT = path.join(repoRoot(__dirname), 'scripts/framework-audit/audit-live-state.js');
const src = fs.readFileSync(AUDIT, 'utf8');

/** The section's SQL, extracted from the shipped audit verbatim. */
function sectionSql(): string {
  const m = src.match(/sec\('supervisor_send_timing_latest', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('supervisor_send_timing_latest section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

describe('PIN f111: supervisor_send_timing_latest bake (28th f64 bake)', () => {
  test('the section exists, windowless, latest-5 shape', () => {
    expect(sql).toContain('AS age_min');
    expect(sql).toContain('AS auth_ms');
    expect(sql).toContain('AS deliver_ms');
    expect(sql).toContain("kind='supervisor_send_timing'");
    expect(sql).toMatch(/ORDER BY "createdAt" DESC LIMIT 5/);
    // NO window filter: an empty section is instrument_silent BY CONSTRUCTION
    // (zero rows ever) — the whole point of the bake.
    expect(sql).not.toMatch(/WHERE kind='supervisor_send_timing' AND "createdAt"/);
  });

  test("the 'window_idle' rung keys on the WINDOW max (max OVER ()), not the row's own createdAt", () => {
    // f112: the rung now also requires the idle age to be within the surface's
    // 52 h historical max inter-send gap (absence beyond it is
    // idle_beyond_history, the 'is the surface ever used?' watch-only rung).
    expect(sql).toMatch(/WHEN max\("createdAt"\) OVER \(\) < now\(\) - interval '4 hours' AND now\(\) - max\("createdAt"\) OVER \(\) <= interval '52 hours' THEN 'window_idle'/);
    // branch order: window_idle BEFORE stale_post_fix (an all-old window must
    // read window_idle even when a synthetic future row would trip the bar)
    expect(sql.indexOf("'window_idle'")).toBeLessThan(sql.indexOf("'stale_post_fix'"));
  });

  test("f112 bake: the idle_beyond_history rung — idle past the 52 h historical max gap, watch-only", () => {
    // order matters: stale_post_fix BEFORE the residual idle arm, so a NEW
    // over-bar row still reads stale_post_fix even while the window is idle.
    expect(sql).toMatch(/WHEN max\("createdAt"\) OVER \(\) < now\(\) - interval '4 hours' THEN 'idle_beyond_history'/);
    expect(sql.indexOf("'stale_post_fix'")).toBeLessThan(sql.indexOf("'idle_beyond_history'"));
    // the cadence evidence prints per row: how long the window has been idle
    // and the gap to the previous send (-1 = no previous row). f113: the gap
    // is PER-ROW ("createdAt" − lag) — the f112 bake anchored it to
    // max(createdAt) OVER (), printing window-age differences (3131/5310/5753
    // on box A) instead of the true inter-send gaps (10/3121/2178/444).
    expect(sql).toContain('AS window_idle_min');
    expect(sql).toContain('AS prev_gap_min');
    expect(sql).toMatch(/COALESCE\(ROUND\(EXTRACT\(EPOCH FROM \("createdAt" - lag\("createdAt"\) OVER \(ORDER BY "createdAt"\)\)\)\/60\), -1\)/);
    expect(sql).not.toMatch(/max\("createdAt"\) OVER \(\) - lag\("createdAt"\)/);
  });

  test("the 'stale_post_fix' rung keys on the row's OWN createdAt vs the DW-5 fix deploy, auth bar 1000 ms", () => {
    expect(sql).toMatch(/WHEN "createdAt" > TIMESTAMPTZ '2026-10-10 07:47:00\+00' AND \(meta->>'authMs'\)::numeric > 1000 THEN 'stale_post_fix'/);
  });

  test('the DW-5 fix deploy boundary is the f110 deploy (07:47Z, Health Check run 38035482213 completed window)', () => {
    expect(sql).toContain(`'2026-10-10 07:47:00+00'`);
  });

  test('the pre-existing supervisor_send_timing_4h window section (f68) is intact', () => {
    const m = src.match(/sec\('supervisor_send_timing_4h', \(\) => q\(`([^`]+)`\)\)/);
    expect(m).toBeTruthy();
    const rowSql = m![1];
    expect(rowSql).toContain('AS avg_auth_ms');
    expect(rowSql).toContain(`interval '4 hours'`);
    expect(rowSql).toContain("THEN 'ESCALATE' ELSE 'ok' END AS verdict");
  });

  test('the section comment documents the ladder (instrument_silent = prints [])', () => {
    const iSec = src.indexOf("sec('supervisor_send_timing_latest'");
    const iComment = src.lastIndexOf('// supervisor_send_timing_latest (FO firing 111', iSec);
    expect(iComment).toBeGreaterThan(-1);
    const comment = src.slice(iComment, iSec);
    expect(comment).toContain('instrument_silent');
    expect(comment).toContain('window_idle');
    expect(comment).toContain('stale_post_fix');
  });
});

/**
 * JS model of the shipped verdict ladder. Inputs mirror what the SQL reads:
 * rows of { createdAt (ms epoch), authMs } — the verdict for a row is
 * computed against the window max and the fix-deploy boundary.
 */
const FIX_DEPLOY_MS = Date.parse('2026-10-10T07:47:00Z');
const HISTORY_MAX_GAP_MS = 52 * 3600_000; // f112 bake: max inter-send gap across the five latest rows (Oct 5→9)
type Row = { createdAt: number; authMs: number };
function ladder(
  rows: Row[],
  nowMs: number,
  row: Row
): 'window_idle' | 'stale_post_fix' | 'idle_beyond_history' | 'ok' {
  const windowMax = Math.max(...rows.map((r) => r.createdAt));
  if (windowMax < nowMs - 4 * 3600_000 && nowMs - windowMax <= HISTORY_MAX_GAP_MS)
    return 'window_idle';
  if (row.createdAt > FIX_DEPLOY_MS && row.authMs > 1000) return 'stale_post_fix';
  if (windowMax < nowMs - 4 * 3600_000) return 'idle_beyond_history';
  return 'ok';
}

describe('PIN f111: ladder model reproduces the live window and synthetic regimes', () => {
  // THE LIVE WINDOW (box A, 2026-10-10T10:48Z, probe dw5check2.js): the 5
  // latest rows, all pre-fix, oldest 17:34Z Oct 9 — f111's hand adjudication
  // ("fix deployed but unexercised") reproduces as window_idle on every row.
  const live: Row[] = [
    { createdAt: Date.parse('2026-10-09T17:45:12Z'), authMs: 4079 },
    { createdAt: Date.parse('2026-10-09T17:34:22Z'), authMs: 4761 },
    { createdAt: Date.parse('2026-10-08T17:49:35Z'), authMs: 4372 },
    { createdAt: Date.parse('2026-10-08T01:12:53Z'), authMs: 19086 },
    { createdAt: Date.parse('2026-10-07T23:59:59Z'), authMs: 20354 },
  ];
  const nowLive = Date.parse('2026-10-10T10:48:00Z');

  test('live window: all rows window_idle (fix deployed 07:47Z, no post-fix send yet)', () => {
    for (const r of live) expect(ladder(live, nowLive, r)).toBe('window_idle');
  });

  test('the live pre-fix auth figures ride in the section (age_min + auth_ms columns)', () => {
    // the four PRE-fix auth values f110 measured (4079/4372/4761/19086) are
    // the rows the section surfaces when the window is idle.
    const auths = live.map((r) => r.authMs).sort((a, b) => a - b);
    expect(auths).toEqual([4079, 4372, 4761, 19086, 20354]);
  });

  test('synthetic: a post-fix send with double-digit auth reads ok', () => {
    const rows: Row[] = [{ createdAt: Date.parse('2026-10-10T11:00:00Z'), authMs: 42 }];
    expect(ladder(rows, Date.parse('2026-10-10T11:01:00Z'), rows[0])).toBe('ok');
  });

  test('synthetic: a post-fix send still above 1000 ms auth reads stale_post_fix (fix did not take)', () => {
    const rows: Row[] = [{ createdAt: Date.parse('2026-10-10T11:00:00Z'), authMs: 4100 }];
    expect(ladder(rows, Date.parse('2026-10-10T11:01:00Z'), rows[0])).toBe('stale_post_fix');
  });

  test('synthetic: a PRE-fix row in an otherwise fresh window reads ok, never stale_post_fix (row-own createdAt keys the rung)', () => {
    const rows: Row[] = [
      { createdAt: Date.parse('2026-10-10T11:00:00Z'), authMs: 30 },
      { createdAt: Date.parse('2026-10-09T17:45:12Z'), authMs: 4079 },
    ];
    expect(ladder(rows, Date.parse('2026-10-10T11:01:00Z'), rows[1])).toBe('ok');
  });

  test('edge: exactly 4h-old latest row is OUTSIDE window_idle (strict <), one second older is inside', () => {
    const atBoundary: Row[] = [{ createdAt: Date.parse('2026-10-10T06:48:00Z'), authMs: 100 }];
    expect(ladder(atBoundary, Date.parse('2026-10-10T10:48:00Z'), atBoundary[0])).toBe('ok');
    const justInside: Row[] = [{ createdAt: Date.parse('2026-10-10T06:47:59Z'), authMs: 100 }];
    expect(ladder(justInside, Date.parse('2026-10-10T10:48:00Z'), justInside[0])).toBe('window_idle');
  });

  // ---- f112 regime: the cadence rung (idle_beyond_history) ----

  test('f112 live window (2nd consecutive idle firing, 14:38Z): 20.9 h idle is WITHIN the 52 h historical cadence — window_idle, question not ripe', () => {
    // latest send Oct 9 17:45Z; f112 fired 14:38Z Oct 10 → idle ~20.9 h, under
    // the 52 h max inter-send gap the five latest rows span — absence is
    // within cadence, so 'is the surface ever used?' stays unripe.
    for (const r of live) expect(ladder(live, Date.parse('2026-10-10T14:38:00Z'), r)).toBe('window_idle');
  });

  test('the 52 h rung basis (LIVE-VALIDATED, box A 2026-10-10T14:48Z): the five latest rows span inter-send gaps 11/442/2179/3120 min — max 3120 min = 52.0 h exactly', () => {
    const gaps = [11, 442, 2179, 3120]; // minutes, Oct 4 21:52Z → Oct 9 17:45Z (probe-f112-cadence.js)
    expect(Math.max(...gaps)).toBe(3120);
    expect(3120).toBe(52 * 60); // the rung boundary IS the historical max gap
  });

  test('synthetic: idle ~53 h (past the historical max gap) reads idle_beyond_history — watch-only, never stale_post_fix for a PRE-fix row', () => {
    const rows: Row[] = [{ createdAt: Date.parse('2026-10-08T09:00:00Z'), authMs: 4079 }];
    expect(ladder(rows, Date.parse('2026-10-10T14:38:00Z'), rows[0])).toBe('idle_beyond_history');
  });

  test('synthetic: stale_post_fix wins over idle_beyond_history when a NEW over-bar row exists in the idle window (branch order)', () => {
    const rows: Row[] = [
      { createdAt: Date.parse('2026-10-10T12:00:00Z'), authMs: 4500 }, // post-fix, over bar
      { createdAt: Date.parse('2026-10-07T10:00:00Z'), authMs: 4079 }, // window max is NEW
    ];
    expect(ladder(rows, Date.parse('2026-10-10T14:38:00Z'), rows[0])).toBe('stale_post_fix');
    // the OLD pre-fix row in the same window reads ok (row-own createdAt)
    expect(ladder(rows, Date.parse('2026-10-10T14:38:00Z'), rows[1])).toBe('ok');
  });

  test('edge: exactly 52 h idle is window_idle (<= rung), one minute beyond is idle_beyond_history', () => {
    const exactly: Row[] = [{ createdAt: Date.parse('2026-10-08T10:38:00Z'), authMs: 100 }];
    expect(ladder(exactly, Date.parse('2026-10-10T14:38:00Z'), exactly[0])).toBe('window_idle');
    const beyond: Row[] = [{ createdAt: Date.parse('2026-10-08T10:37:00Z'), authMs: 100 }];
    expect(ladder(beyond, Date.parse('2026-10-10T14:38:00Z'), beyond[0])).toBe('idle_beyond_history');
  });
});

// ---- f114: the idle_headroom_min bake (30th f64 bake) ----
// Four consecutive idle firings hand-compared window_idle_min against the
// 52 h bar by eye (1737 vs 3120 at f114, 22:41Z box A). The column computes
// the comparison: minutes REMAINING before idle_beyond_history flips, gated
// to the idle regime (NULL while fresh). Pinned EXACTLY, per the f113
// convention (prev_gap_min re-anchor): a re-anchored expression must fail
// this pin, not print subtly-wrong headroom for a quarter of firings.

describe('PIN f114: idle_headroom_min column (30th f64 bake)', () => {
  test('the column exists, gated to the idle regime, expression pinned verbatim', () => {
    // gated on the SAME window-max condition as the window_idle rung, so the
    // column is NULL exactly when the ladder is not idle — no fresh-window
    // headroom that would read as a phantom countdown.
    expect(sql).toMatch(/CASE WHEN max\("createdAt"\) OVER \(\) < now\(\) - interval '4 hours' THEN ROUND\(EXTRACT\(EPOCH FROM \(interval '52 hours' - \(now\(\) - max\("createdAt"\) OVER \(\)\)\)\)\/60\)::int ELSE NULL END AS idle_headroom_min/);
    // the 52 h constant in the headroom expression is the SAME rung constant
    // the ladder adjudicates on — exactly THREE SQL sites after the f116 bake
    // (the rung arm, the headroom expression, the ripen_at expression — all
    // three must share the constant or the countdown and the instant it
    // points at disagree); a re-anchor, a stray fourth site, or a desynced
    // site fails this pin.
    expect(sql.match(/interval '52 hours'/g)).toHaveLength(3);
  });

  test('f114 live window (22:41Z box A): headroom 1383 min — 1737 idle vs 3120 bar, within cadence', () => {
    // window_idle_min 1737 (latest send Oct 9 17:45Z), 52 h bar = 3120 min
    // → 3120 − 1737 = 1383 min remaining before idle_beyond_history.
    expect(3120 - 1737).toBe(1383);
    // and the ladder still reads window_idle at that age (not beyond history)
    const rows: Row[] = [{ createdAt: Date.parse('2026-10-09T17:45:12Z'), authMs: 4079 }];
    expect(ladder(rows, Date.parse('2026-10-10T22:41:00Z'), rows[0])).toBe('window_idle');
  });

  test('model: headroom flips sign exactly when the ladder flips to idle_beyond_history', () => {
    const headroom = (rows: Row[], nowMs: number): number | null => {
      const windowMax = Math.max(...rows.map((r) => r.createdAt));
      if (windowMax >= nowMs - 4 * 3600_000) return null; // fresh window: NULL
      return Math.round((HISTORY_MAX_GAP_MS - (nowMs - windowMax)) / 60000);
    };
    // live regime: positive headroom. (The model's own anchors — 17:45:12Z
    // send vs 22:41:00Z now = 1735.8 min idle — round to 1384; the audit's
    // 1383 came from its 22:41:33Z instant. The model pins its own
    // arithmetic; the point is headroom = 3120 − idle, sign intact.)
    const live: Row[] = [{ createdAt: Date.parse('2026-10-09T17:45:12Z'), authMs: 4079 }];
    expect(headroom(live, Date.parse('2026-10-10T22:41:00Z'))).toBeGreaterThan(0);
    expect(headroom(live, Date.parse('2026-10-10T22:41:00Z'))).toBe(1384);
    // exactly at the 52 h bar: headroom 0, ladder window_idle (<= rung)
    const atBar = headroom(live, live[0].createdAt + HISTORY_MAX_GAP_MS);
    expect(atBar).toBe(0);
    expect(ladder(live, live[0].createdAt + HISTORY_MAX_GAP_MS, live[0])).toBe('window_idle');
    // one minute past the bar: negative headroom, ladder idle_beyond_history
    const pastBar = headroom(live, live[0].createdAt + HISTORY_MAX_GAP_MS + 60_000);
    expect(pastBar).toBeLessThan(0);
    expect(ladder(live, live[0].createdAt + HISTORY_MAX_GAP_MS + 60_000, live[0])).toBe('idle_beyond_history');
    // fresh window (a send 30 min ago): headroom NULL — the column means
    // nothing while the ladder is not idle
    const fresh: Row[] = [{ createdAt: Date.parse('2026-10-10T22:11:00Z'), authMs: 42 }];
    expect(headroom(fresh, Date.parse('2026-10-10T22:41:00Z'))).toBeNull();
  });
});

// ---- f116: the ripen_at bake (32nd f64 bake) ----
// The f114 bake prints the countdown (idle_headroom_min) but every idle
// firing STILL re-derives "earliest ripening" by adding the countdown to the
// current clock — and f115's state file DRIFTED doing exactly that (~17:45Z
// written where the 52 h cadence from the Oct 9 17:45Z send gives 21:45Z).
// ripen_at prints the clock instant itself (window-max + 52 h), gated to the
// SAME idle regime as idle_headroom_min. Pinned verbatim per the f113
// convention: a re-anchored expression must fail this pin, not point at a
// subtly-wrong instant.

describe('PIN f116: ripen_at column (32nd f64 bake)', () => {
  test('the column exists, gated to the idle regime, expression pinned verbatim', () => {
    // gated on the SAME window-max condition as idle_headroom_min, so the
    // column is NULL exactly when the ladder is not idle — no fresh-window
    // phantom instant.
    expect(sql).toMatch(/CASE WHEN max\("createdAt"\) OVER \(\) < now\(\) - interval '4 hours' THEN \(max\("createdAt"\) OVER \(\) \+ interval '52 hours'\) ELSE NULL END AS ripen_at/);
    // all three 52 h sites share the constant (rung arm + headroom + ripen_at)
    expect(sql.match(/interval '52 hours'/g)).toHaveLength(3);
  });

  test('f116 live window (06:41Z box A): ripen_at = Oct 9 17:45Z send + 52 h = Oct 11 21:45Z', () => {
    // the f116 audit printed idle_headroom_min 903 at window_idle_min 2217
    // (window-max Oct 9 17:45Z) — 2217 + 903 = 3120 min = 52 h exactly, and
    // 17:45:12Z + 3120 min = 2026-10-11T21:45:12Z. This is the instant
    // f115's state file should have named (it said ~17:45Z — the drift this
    // bake removes).
    expect(2217 + 903).toBe(3120);
    const windowMax = Date.parse('2026-10-09T17:45:12Z');
    const ripenAt = new Date(windowMax + 52 * 3600_000).toISOString();
    expect(ripenAt).toBe('2026-10-11T21:45:12.000Z');
    // and at f116 time (06:41Z) the ladder is still window_idle (not ripe)
    const rows: Row[] = [{ createdAt: windowMax, authMs: 4079 }];
    expect(ladder(rows, Date.parse('2026-10-11T06:41:00Z'), rows[0])).toBe('window_idle');
  });

  test('model: ripen_at is the headroom zero-crossing instant, fresh-window NULL', () => {
    const ripenAt = (rows: Row[], nowMs: number): string | null => {
      const windowMax = Math.max(...rows.map((r) => r.createdAt));
      if (windowMax >= nowMs - 4 * 3600_000) return null; // fresh window: NULL
      return new Date(windowMax + HISTORY_MAX_GAP_MS).toISOString();
    };
    const live: Row[] = [{ createdAt: Date.parse('2026-10-09T17:45:12Z'), authMs: 4079 }];
    // at ripen_at the headroom is exactly 0 and the ladder still window_idle
    const r = ripenAt(live, Date.parse('2026-10-11T06:41:00Z'))!;
    const headroom = (ms: number) => Math.round((HISTORY_MAX_GAP_MS - (ms - live[0].createdAt)) / 60000);
    expect(headroom(Date.parse(r))).toBe(0);
    expect(ladder(live, Date.parse(r), live[0])).toBe('window_idle');
    // one minute past ripen_at: ladder idle_beyond_history (question ripe)
    expect(ladder(live, Date.parse(r) + 60_000, live[0])).toBe('idle_beyond_history');
    // fresh window: NULL — no phantom instant
    const fresh: Row[] = [{ createdAt: Date.parse('2026-10-11T06:11:00Z'), authMs: 42 }];
    expect(ripenAt(fresh, Date.parse('2026-10-11T06:41:00Z'))).toBeNull();
  });
});
