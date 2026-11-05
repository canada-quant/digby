/**
 * PIN (FO firing 93, 2026-10-07) — i11_clock_check.reject_back_with_clockhits_24h
 * must classify its own rows, not print raw clockHits JSON for every firing to
 * re-derive by eye.
 *
 * THE GAP THIS PINS: the i11 hardening wave gave reject-back strike meta
 * clockHits [{token, minutesAhead, line}], but the audit section printed the
 * raw JSON — so each firing re-derived the same two-way read: is this row a
 * QUOTED STORED FUTURE TIME (a lane citing a deadline it read from a card /
 * log line — 526-min "9:00 AM PDT" school-hours tokens, never an estimated
 * now) or a NEAR-TERM claim (minutesAhead small enough that a lane writing
 * "at 4:52 PM PDT" may be estimating instead of quoting)? f92 paid it
 * eyeballing 41bd202a (526 min) and c0e22e36 (14 min); the Charter's
 * machine-wake doctrine says estimate-governed forward clocks are the strike
 * class — the section never said which rows those were. The exact by-eye
 * burden the f64 bake doctrine exists to remove.
 *
 * THE FIX (firing 93, 24th f64 bake): a computed `verdict` column +
 * `minutes_ahead` (int array, ascending) + `recurrence_7d` (prior same-seam
 * strikes in 7 days) per row:
 *   no_hits              — clockHits array empty (defensive; the meta ? check
 *                          makes this near-impossible)
 *   quoted_stored_future — MAX(minutesAhead) > 240: the token is hours ahead,
 *                          which no "estimate of now" can produce — the lane
 *                          is quoting a stored deadline (the i11-exempt class,
 *                          NOT a fresh strike on its own)
 *   recurrence_7d        — any earlier same-session, same-seam strike within
 *                          7 days: single live:once rows are agent behavior;
 *                          a recurrence is the pattern worth the next firing's
 *                          attention, and now it counts itself
 *   near_term_estimate   — small minutesAhead, no prior: the raw i11 verdict
 *                          case, reported as before
 *
 * Live validation (box A, pre-deploy, probe-f93-section.js verbatim SQL):
 * 41bd202a minutes_ahead [526] → quoted_stored_future (was raw JSON);
 * c0e22e36 minutes_ahead [14] → recurrence_7d (44 priors in 7d — the Fleet
 * Supervisor's own gateway-reconciliation line, quoting "4:52 PM PDT").
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92 chatlane pin): the
 * shipped audit declares the verdict column and its branch order (no_hits →
 * quoted_stored_future(>240) → recurrence_7d → near_term_estimate), the
 * minutes_ahead array_agg WITHOUT DISTINCT (the live probe caught BOTH
 * string_agg(int,) not existing AND DISTINCT+ORDER BY needing identical
 * arguments — array_agg(int ORDER BY int) satisfies both), and the FULL
 * joined l."sessionId" (never the truncated LEFT(,8), the f79 trap); a JS
 * model of the same classifier reproduces the live rows plus synthetics.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92/f62 pin tests declare top-level fs/path the same way)

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
  const m = src.match(/reject_back_with_clockhits_24h: await q\(`([^`]+)`\)/);
  if (!m) throw new Error('reject_back_with_clockhits_24h section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

describe('PIN f93: i11_clock_check reject-back verdict bake (24th f64 bake)', () => {
  test('the section exists and carries the computed verdict column', () => {
    expect(sql).toContain('AS verdict');
    expect(sql).toContain('AS minutes_ahead');
    expect(sql).toContain('AS recurrence_7d');
  });

  test('minutes_ahead uses array_agg over the int cast, no DISTINCT (the live-probe traps)', () => {
    // Live probe caught: string_agg(int, unknown) does not exist, and
    // DISTINCT+ORDER BY demands identical argument expressions. array_agg of
    // the int cast ordered by the same int satisfies both.
    expect(sql).toMatch(/array_agg\(\(ch->>'minutesAhead'\)::int ORDER BY \(ch->>'minutesAhead'\)::int\)/);
    expect(sql).not.toMatch(/string_agg\(DISTINCT/);
  });

  test('branch order: no_hits → quoted_stored_future(>240) → recurrence_7d → near_term_estimate', () => {
    const iNoHits = sql.indexOf("'no_hits'");
    const iQuoted = sql.indexOf("'quoted_stored_future'");
    const iRecurrence = sql.indexOf("'recurrence_7d'");
    const iNear = sql.indexOf("'near_term_estimate'");
    expect(iNoHits).toBeGreaterThan(-1);
    expect(iQuoted).toBeGreaterThan(iNoHits);
    expect(iRecurrence).toBeGreaterThan(iQuoted);
    expect(iNear).toBeGreaterThan(iRecurrence);
    // the >240 bar is baked, not prose
    expect(sql).toContain('> 240');
  });

  test('the quoted_stored_future bar reads MAX(minutesAhead), and the 240 applies to the max not the count', () => {
    const m = sql.match(/WHEN \(SELECT MAX\(\(ch->>'minutesAhead'\)::int\) FROM jsonb_array_elements\(l\.meta->'clockHits'\) ch\) > 240 THEN 'quoted_stored_future'/);
    expect(m).not.toBeNull();
  });

  test('recurrence joins the FULL l."sessionId" — never the truncated LEFT(,8) id (the f79 trap)', () => {
    expect(sql).toMatch(/l2\."sessionId" = l\."sessionId"/);
    expect(sql).not.toMatch(/l2\."sessionId"::text,8/);
    // the window: 7 days back, strictly BEFORE this row's createdAt (a row
    // never counts itself)
    expect(sql).toContain("interval '7 days'");
    expect(sql).toMatch(/l2\."createdAt" < l\."createdAt"/);
  });

  test('the row filter is unchanged: guard_strike / machine_wake_reject_back / clockHits present / 24h', () => {
    expect(sql).toContain("l.kind='guard_strike'");
    expect(sql).toContain("l.meta->>'seam'='machine_wake_reject_back'");
    expect(sql).toContain("l.meta ? 'clockHits'");
    expect(sql).toContain("interval '24 hours'");
  });
});

/**
 * JS model of the shipped CASE classifier (same branch order as the SQL).
 * Inputs mirror what the SQL's arms read for one strike row:
 *   minutesAhead — the clockHits minutesAhead values
 *   priorStrikes7d — earlier same-session, same-seam strikes in 7 days
 */
function classify(minutesAhead: number[], priorStrikes7d: number): string {
  if (minutesAhead.length === 0) return 'no_hits';
  if (Math.max(...minutesAhead) > 240) return 'quoted_stored_future';
  if (priorStrikes7d > 0) return 'recurrence_7d';
  return 'near_term_estimate';
}

describe('PIN f93: behavioral model vs the live box-A rows (probe-f93-section.js)', () => {
  // Live validation 2026-10-07T10:44Z, SECTION_OK n=2:
  //   41bd202a minutes_ahead [526] → quoted_stored_future (recurrence_7d 10)
  //   c0e22e36 minutes_ahead [14]  → recurrence_7d (44 priors)
  test('41bd202a live row: 526-min stored deadline → quoted_stored_future (not recurrence, not estimate)', () => {
    expect(classify([526], 10)).toBe('quoted_stored_future');
  });

  test('c0e22e36 live row: 14-min token WITH 44 priors → recurrence_7d', () => {
    expect(classify([14], 44)).toBe('recurrence_7d');
  });

  test('the same 14-min token with NO priors stays the raw i11 class: near_term_estimate', () => {
    expect(classify([14], 0)).toBe('near_term_estimate');
  });

  test('a multi-hit row classifies on its MAX (any stored-future token wins)', () => {
    expect(classify([14, 526, 200], 0)).toBe('quoted_stored_future');
    expect(classify([14, 200], 3)).toBe('recurrence_7d');
  });

  test('exactly 240 is NOT quoted_stored_future (the bar is > 240)', () => {
    expect(classify([240], 0)).toBe('near_term_estimate');
    expect(classify([241], 0)).toBe('quoted_stored_future');
  });

  test('empty clockHits (defensive) → no_hits', () => {
    expect(classify([], 0)).toBe('no_hits');
  });
});
