/**
 * PIN (FO firing 97, 2026-10-08) — citation_retry_outcomes_7d must print the
 * retry-lane cost verdict NATIVELY, so no firing ever re-derives "is the
 * reject-back retry lane earning its cost" by mental division again.
 *
 * THE GAP THIS PINS: the section printed by_outcome (clean / still_dirty /
 * (pass1-only)) and daily totals, but NO verdict — every firing had to divide
 * still_dirty by retries by eye (f97's window: 13/56 ≈ 23 %) to judge whether
 * the citation retry lane (owner steer 2026-09-25, each reject-back re-
 * orchestration costs a full model turn) is wasting turns. The exact by-eye
 * burden the f64 doctrine exists to remove.
 *
 * THE FIX (firing 97, 28th f64 bake): agg_7d — ONE row per 7d window:
 * retries (clean+still_dirty), still_dirty, waste_share (%), verdict.
 * ESCALATE when retries >= 3 AND still_dirty*2 >= retries (>= 50 % wasted —
 * the lane burns more turns than it saves, kill-switch territory). daily rows
 * gain waste_share + the same verdict. still_dirty_by_chat_7d names the
 * concentration: 'live:agent_behavior' at >= 5 (watch-only, the f94 recurring
 * vocabulary — it points the eye, it never escalates on its own).
 *
 * CALIBRATION (measure-first, box A probe-f97-waste.js, 2026-10-08T02:4xZ,
 * 14 days): daily waste share max 37.5 % (2026-10-05, 3/8), median ~15 %;
 * the 50 % bar trips on 0/14 days — every trip is a real waste event. The
 * concentration rung at >= 5 catches the current window's shape: 6 of 13
 * still_dirty from ONE chat (c0e22e36, the Fleet Supervisor lane quoting
 * stored future clocks — watch-only, same class as its i11 recurrence_7d=45).
 *
 * F169 AMENDMENT (2026-10-20, 32nd f64 bake): the daily verdict gains an AGE
 * GUARD — the waste bar ESCALATEs only fresh days (age_d <= 3); an over-bar
 * day older than 3 days reads 'aging' (watch-only: sliding out of the rolling
 * window, agg_7d still covers the window). Motivation: 2026-10-13 printed the
 * audit's ONLY ESCALATE row across f168+f169 while actively improving (total
 * 17→14→11, still_dirty 3→2) — two firings re-adjudicated a day the calendar
 * was already clearing. Fresh-bar behavior unchanged (the 10-13 day WOULD
 * have ESCALATEd on Oct 13-16 when the spike deserved action).
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f96 pins): the
 * shipped audit declares the rollup, its bars and the concentration rung, and
 * a JS model of the ladder reproduces the live window plus synthetic regimes.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92–f96 pin tests declare top-level fs/path the same way)

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
  const m = src.match(/sec\('citation_retry_outcomes_7d', async \(\) => \(\{([\s\S]*?)\n  \}\)\);/);
  if (!m) throw new Error('citation_retry_outcomes_7d section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

describe('PIN f97: citation_retry_outcomes_7d verdict bake (28th f64 bake)', () => {
  test('the section declares agg_7d, the daily verdict columns and still_dirty_by_chat_7d', () => {
    expect(sql).toContain('agg_7d:');
    expect(sql).toContain('still_dirty_by_chat_7d:');
    expect(sql).toContain('AS waste_share');
    expect(sql).toContain('AS verdict');
  });

  test('agg_7d is a single-row rollup (no GROUP BY in its query)', () => {
    const m = sql.match(/agg_7d: await q\(`([^`]+)`\)/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toContain('GROUP BY');
    expect(m![1]).toContain('AS retries');
    expect(m![1]).toContain('AS still_dirty');
    expect(m![1]).toContain('AS clean');
  });

  test('ESCALATE bar is retries >= 3 AND still_dirty*2 >= retries (>= 50% wasted), integer-safe (no float division in the rung)', () => {
    expect(sql).toMatch(/COUNT\(\*\) FILTER \(WHERE meta->>'citationRetry' IN \('clean','still_dirty'\)\) >= 3 AND COUNT\(\*\) FILTER \(WHERE meta->>'citationRetry'='still_dirty'\) \* 2 >= COUNT\(\*\) FILTER \(WHERE meta->>'citationRetry' IN \('clean','still_dirty'\)\) THEN 'ESCALATE'/);
    // the rung must be integer arithmetic (still_dirty*2 >= retries), never a
    // rounded-float compare — a 49.96 % share rounded to 50.0 must NOT trip
    expect(sql).not.toMatch(/waste_share >= 50/);
  });

  test('the waste_share display column divides through NULLIF (a zero-retry window prints null, never a div-by-zero)', () => {
    expect(sql).toMatch(/100\.0 \* COUNT\(\*\) FILTER \(WHERE meta->>'citationRetry'='still_dirty'\) \/ NULLIF\(COUNT\(\*\) FILTER \(WHERE meta->>'citationRetry' IN \('clean','still_dirty'\)\), 0\)/);
  });

  test("still_dirty_by_chat_7d prints the concentration rung: 'live:agent_behavior' at >= 5 (watch-only, the f94 recurring vocabulary — never ESCALATE)", () => {
    const m = sql.match(/still_dirty_by_chat_7d: await q\(`([^`]+)`\)/);
    expect(m).toBeTruthy();
    const byChat = m![1];
    expect(byChat).toMatch(/CASE WHEN COUNT\(\*\) >= 5 THEN 'live:agent_behavior' ELSE 'ok' END AS verdict/);
    expect(byChat).not.toContain("'ESCALATE'");
    // 7d window, still_dirty only, newest-noisiest first
    expect(byChat).toContain(`"createdAt" > now() - interval '7 days'`);
    expect(byChat).toContain("meta->>'citationRetry'='still_dirty'");
    expect(byChat).toContain('ORDER BY 2 DESC');
  });

  test('the daily rows gain waste_share + an AGE-AWARE verdict (f169): the same waste bar as agg_7d, ESCALATE only fresh (age_d <= 3), over-bar older days read aging — never the flat ELSE ok two-way shape', () => {
    const m = sql.match(/daily: await q\(`([^`]+)`\)/);
    expect(m).toBeTruthy();
    const daily = m![1];
    expect(daily).toContain('AS waste_share');
    expect(daily).toContain('AS age_d');
    expect(daily).toContain("<= 3 THEN 'ESCALATE'");
    expect(daily).toContain("THEN 'aging' ELSE 'ok' END AS verdict");
    expect(daily).not.toContain("THEN 'ESCALATE' ELSE 'ok' END AS verdict");
    expect(daily).toContain('GROUP BY 1 ORDER BY 1');
  });

  test('by_outcome keeps its original shape (retry_outcome / n / avg_retry_ms)', () => {
    expect(sql).toMatch(/by_outcome: await q\(`SELECT COALESCE\(meta->>'citationRetry','\(pass1-only\)'\) AS retry_outcome/);
  });
});

/**
 * JS model of the shipped verdict ladder. Inputs mirror what the SQL reads:
 * the 7d window's loop_metrics rows as citationRetry outcome strings
 * ('clean' | 'still_dirty' | null = pass1-only).
 */
function wasteVerdict(outcomes: Array<'clean' | 'still_dirty' | null>): {
  retries: number;
  still_dirty: number;
  clean: number;
  waste_share: number | null;
  verdict: string;
} {
  const retries = outcomes.filter((o) => o === 'clean' || o === 'still_dirty').length;
  const still_dirty = outcomes.filter((o) => o === 'still_dirty').length;
  const clean = outcomes.filter((o) => o === 'clean').length;
  const waste_share = retries === 0 ? null : Math.round((1000 * still_dirty) / retries) / 10;
  const verdict = retries >= 3 && still_dirty * 2 >= retries ? 'ESCALATE' : 'ok';
  return { retries, still_dirty, clean, waste_share, verdict };
}

describe('PIN f97: JS model of the waste ladder', () => {
  test('reproduces the live f97 window: 56 retries, 13 still_dirty, 43 clean, 23.2% waste, verdict ok', () => {
    const outcomes: Array<'clean' | 'still_dirty' | null> = [
      ...Array(43).fill('clean'),
      ...Array(13).fill('still_dirty'),
      ...Array(64).fill(null),
    ];
    expect(wasteVerdict(outcomes)).toEqual({
      retries: 56,
      still_dirty: 13,
      clean: 43,
      waste_share: 23.2,
      verdict: 'ok',
    });
  });

  test('a majority-wasted window with >= 3 retries escalates (kill-switch territory)', () => {
    const outcomes: Array<'clean' | 'still_dirty' | null> = [
      'still_dirty', 'still_dirty', 'still_dirty', 'still_dirty', 'clean', null,
    ];
    expect(wasteVerdict(outcomes)).toEqual({
      retries: 5,
      still_dirty: 4,
      clean: 1,
      waste_share: 80,
      verdict: 'ESCALATE',
    });
  });

  test('the retry floor guards small samples: 2/2 wasted stays ok (below 3 retries)', () => {
    const outcomes: Array<'clean' | 'still_dirty' | null> = ['still_dirty', 'still_dirty', null];
    expect(wasteVerdict(outcomes).verdict).toBe('ok');
  });

  test('exactly 50% wasted with >= 3 retries escalates (>= is inclusive)', () => {
    const outcomes: Array<'clean' | 'still_dirty' | null> = ['clean', 'still_dirty', 'clean', 'still_dirty'];
    expect(wasteVerdict(outcomes)).toMatchObject({ retries: 4, waste_share: 50, verdict: 'ESCALATE' });
  });

  test('the calibrated worst live day (3/8 = 37.5%, 2026-10-05) stays ok', () => {
    const outcomes: Array<'clean' | 'still_dirty' | null> = [
      ...Array(5).fill('clean'), ...Array(3).fill('still_dirty'),
    ];
    expect(wasteVerdict(outcomes)).toMatchObject({ retries: 8, waste_share: 37.5, verdict: 'ok' });
  });

  test('a zero-retry window prints null waste_share and ok (NULLIF semantics)', () => {
    expect(wasteVerdict([null, null])).toEqual({
      retries: 0, still_dirty: 0, clean: 0, waste_share: null, verdict: 'ok',
    });
  });

  test('the concentration rung: >= 5 still_dirty from one chat over 7d names live:agent_behavior (watch-only)', () => {
    const rung = (n: number) => (n >= 5 ? 'live:agent_behavior' : 'ok');
    expect(rung(6)).toBe('live:agent_behavior'); // c0e22e36 in the f97 window
    expect(rung(4)).toBe('ok');                   // 41bd202a in the f97 window
  });
});

/**
 * JS model of the f169 age-aware DAILY verdict. Inputs mirror the shipped
 * daily SQL: retries = clean+still_dirty for the day, stillDirty the wasted
 * count, ageD = now()::date - day. Bar identical to agg_7d; age decides
 * ESCALATE (fresh, <= 3 days) vs 'aging' (older — sliding out, watch-only).
 */
function dailyVerdict(retries: number, stillDirty: number, ageD: number): string {
  const overBar = retries >= 3 && stillDirty * 2 >= retries;
  if (overBar && ageD <= 3) return 'ESCALATE';
  if (overBar) return 'aging';
  return 'ok';
}

describe('PIN f169: JS model of the age-aware daily ladder', () => {
  test('the 2026-10-13 row that motivated the bake (retries 3, still_dirty 2 = 66.7%) reads aging at age 7 — but WOULD have ESCALATEd fresh', () => {
    expect(dailyVerdict(3, 2, 7)).toBe('aging');  // f169 live row, age 7
    expect(dailyVerdict(3, 2, 6)).toBe('aging');  // f168 live row, age 6
    expect(dailyVerdict(3, 2, 3)).toBe('ESCALATE'); // boundary: 3 days old is still fresh
    expect(dailyVerdict(3, 2, 0)).toBe('ESCALATE'); // same-day spike stays loud
  });

  test('an over-bar day crossing the boundary flips ESCALATE -> aging at age 4', () => {
    expect(dailyVerdict(11, 11, 3)).toBe('ESCALATE');
    expect(dailyVerdict(11, 11, 4)).toBe('aging');
  });

  test('an under-bar day is ok at ANY age (age never invents an escalation)', () => {
    expect(dailyVerdict(8, 3, 0)).toBe('ok');  // 37.5% — the calibrated worst live day
    expect(dailyVerdict(8, 3, 6)).toBe('ok');
    expect(dailyVerdict(2, 2, 1)).toBe('ok');  // below the 3-retry floor
  });
});
