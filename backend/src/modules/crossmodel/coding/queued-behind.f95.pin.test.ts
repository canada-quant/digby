/**
 * PIN (FO firing 95, 2026-10-07) — runs_suspect_class must disambiguate a
 * queued-stale row that sits BEHIND a running sibling in the SAME session
 * (queue-behind-running, the benign one-run-per-session lock class) from a
 * genuine claim wedge.
 *
 * THE GAP THIS PINS: firing 61 baked the suspect ladder but left queued rows
 * one-class: a queued row older than 15 min printed queued_stale whether the
 * session already had a healthy RUNNING run (the queue is just waiting its
 * turn — benign) or nothing was claiming it (the actionable wedge). f95 paid
 * exactly that tax: bbf48604 and 23a827a5 both printed queued_stale and the
 * adjudication (both chats had hb-fresh running siblings a22d91d6 hb 2 min /
 * 33468968 hb 0 min) was done BY EYE. The exact by-eye burden the f64
 * doctrine exists to remove.
 *
 * THE FIX (firing 95, 26th f64 bake): a computed `sibling` column (the
 * 8-char id of a RUNNING sibling in the same session, NULL when none) and a
 * `queued_behind` suspect class: queued > 15 min AND a running sibling
 * exists. Only a queued row with NO running sibling stays queued_stale
 * (the actionable wedge class). The sibling match is on the FULL
 * r."sessionId" — never LEFT(,8), the f79 id-truncation trap.
 *
 * Live validation (box A, pre-deploy, probe-f95-section.js verbatim SQL,
 * 2026-10-07T18:5xZ): the f95 queued pair prints queued_behind with sibling
 * ids a22d91d6/33468968; running rows keep suspect_class ok and sibling NULL.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92/f93/f94 pins): the
 * shipped audit declares the sibling column, the queued_behind rung BEFORE
 * queued_stale in the CASE (branch order: the more specific class must test
 * first or queued_stale swallows it), the full-sessionId EXISTS join, and a
 * JS model of the same ladder reproduces the live rows plus synthetics.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92/f93/f94 pin tests declare top-level fs/path the same way)

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
  const m = src.match(/sec\('runs_suspect_class', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('runs_suspect_class section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

describe('PIN f95: runs_suspect_class queued_behind bake (26th f64 bake)', () => {
  test('the section exists and carries the sibling column + queued_behind class', () => {
    expect(sql).toContain('AS sibling');
    expect(sql).toContain("'queued_behind'");
  });

  test('queued_behind tests BEFORE queued_stale in the CASE (branch order)', () => {
    const iBehind = sql.indexOf("'queued_behind'");
    const iStale = sql.indexOf("'queued_stale'");
    expect(iBehind).toBeGreaterThan(-1);
    // the FIRST queued_stale literal must come after the queued_behind arm
    // (both classes also appear in the ORDER BY — indexOf finds the CASE arm first)
    expect(iStale).toBeGreaterThan(iBehind);
  });

  test('queued_behind requires BOTH > 15 min AND a running sibling in the same session', () => {
    expect(sql).toMatch(/WHEN r\.status='queued' AND r\."createdAt" < now\(\) - interval '15 minutes' AND EXISTS/);
    expect(sql).toMatch(/s2\."sessionId" = r\."sessionId" AND s2\.status='running' AND s2\.id <> r\.id/);
  });

  test('the sibling match joins the FULL sessionId — never the truncated LEFT(,8) id (the f79 trap)', () => {
    expect(sql).toMatch(/s2\."sessionId" = r\."sessionId"/);
    expect(sql).not.toMatch(/s2\."sessionId"::text,8/);
  });

  test('the sibling column reads a RUNNING sibling only, self-excluded, LIMIT 1', () => {
    expect(sql).toMatch(/\(SELECT LEFT\(s\.id::text,8\) FROM agent_runs s WHERE s\."sessionId" = r\."sessionId" AND s\.status='running' AND s\.id <> r\.id LIMIT 1\) AS sibling/);
  });

  test('the pre-existing ladder is intact (f61 rungs unchanged)', () => {
    for (const c of ["'long_stale_hb'", "'hb_stale'", "'queued_stale'", "'queued_ok'", "'long_fresh_hb'"]) {
      expect(sql).toContain(c);
    }
    // the outer-subquery rule (f61): suspect_class must be a real column of a
    // subquery t, ordered by a CASE over bare t.suspect_class
    expect(sql).toContain('AS suspect_class');
    expect(sql).toMatch(/ORDER BY CASE t\.suspect_class/);
    // queued_behind slots between queued_stale and long_fresh_hb in priority
    const order = sql.match(/ORDER BY CASE t\.suspect_class[^,]*/);
    expect(order).toBeTruthy();
    expect(order![0]).toContain("'queued_behind' THEN 3");
  });

  test('the row filter is unchanged: running+queued, LIMIT 30', () => {
    expect(sql).toContain("IN ('running','queued')");
    expect(sql).toContain('LIMIT 30');
  });
});

/**
 * JS model of the shipped suspect ladder (queued arm + the running arm's
 * staleness classes, enough to reproduce the live f95 rows). Inputs mirror
 * what the SQL reads for one run row: status, queueAgeMin, hbAgeMin,
 * runMin, and runningSibling (a RUNNING row exists in the same session).
 */
function classify(input: {
  status: string;
  queueAgeMin: number;
  hbAgeMin?: number;
  runMin?: number;
  runningSibling: boolean;
}): string {
  const { status, queueAgeMin, hbAgeMin = 0, runMin = 0, runningSibling } = input;
  if (status === 'queued') {
    if (queueAgeMin > 15 && runningSibling) return 'queued_behind';
    if (queueAgeMin > 15) return 'queued_stale';
    return 'queued_ok';
  }
  if (hbAgeMin > 5 && runMin > 180) return 'long_stale_hb';
  if (hbAgeMin > 5) return 'hb_stale';
  if (runMin > 180) return 'long_fresh_hb';
  return 'ok';
}

describe('PIN f95: behavioral model vs the live box-A rows (probe-f95-section.js)', () => {
  // Live validation 2026-10-07T18:5xZ: the f95 queued pair (bbf48604 behind
  // a22d91d6, 23a827a5 behind 33468968) prints queued_behind with sibling ids;
  // the running siblings themselves stay 'ok' (hb 2 min / 0 min).
  test('bbf48604: queued 100+ min behind running a22d91d6 → queued_behind, not queued_stale', () => {
    expect(classify({ status: 'queued', queueAgeMin: 120, runningSibling: true })).toBe('queued_behind');
  });

  test('23a827a5: queued behind running 33468968 → queued_behind', () => {
    expect(classify({ status: 'queued', queueAgeMin: 90, runningSibling: true })).toBe('queued_behind');
  });

  test('a queued row with NO running sibling stays queued_stale (the actionable wedge)', () => {
    expect(classify({ status: 'queued', queueAgeMin: 20, runningSibling: false })).toBe('queued_stale');
  });

  test('a young queued row behind a sibling is queued_ok (the 15-min bar does not fire)', () => {
    expect(classify({ status: 'queued', queueAgeMin: 5, runningSibling: true })).toBe('queued_ok');
  });

  test('running rows are untouched by the new arm: hb-fresh → ok, hb-stale → hb_stale', () => {
    expect(classify({ status: 'running', queueAgeMin: 0, hbAgeMin: 2, runMin: 145, runningSibling: true })).toBe('ok');
    expect(classify({ status: 'running', queueAgeMin: 0, hbAgeMin: 12, runMin: 40, runningSibling: false })).toBe('hb_stale');
  });

  test('the 3-hour long-run classes survive: fresh hb at 200 min → long_fresh_hb (nightly benign)', () => {
    expect(classify({ status: 'running', queueAgeMin: 0, hbAgeMin: 1, runMin: 220, runningSibling: false })).toBe('long_fresh_hb');
  });
});
