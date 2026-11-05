/**
 * PIN (FO firing 61, 2026-10-01) — the live audit must CLASSIFY running rows
 * per the charter's suspect rule, not leave it to eyeball.
 *
 * THE GAP THIS PINS: docs/FRAMEWORK_OPERATOR.md names the rule — "a heartbeat
 * older than 5 min or a run past 3 h is suspect" — but audit-live-state.js
 * only listed raw running rows; firings 59/60/61 each re-derived the
 * classification by hand on the 220–260-min nightlies (hb 0, steps advancing,
 * fresh lease ⇒ benign long-run class) before deciding nothing was wrong.
 * Every future firing paid that same eyeball tax, and the actionable classes
 * (hb_stale / long_stale_hb / queued_stale) had no in-audit signal at all.
 *
 * THE FIX (firing 61): a runs_suspect_class section in audit-live-state.js
 * classifies every running/queued row IN-AUDIT:
 *   queued_stale (>15 min queued) / queued_ok — checked FIRST: queued rows
 *     carry NULL startedAt/heartbeatAt, and NULL comparisons fall through the
 *     hb/long branches to 'ok' (a silent misclassification the branch order
 *     exists to prevent);
 *   long_stale_hb (hb>5 AND run>180) — worst case, sorts first;
 *   hb_stale (hb>5) — actionable: the worker may be wedged;
 *   long_fresh_hb (run>180, hb≤5) — the benign nightly class: correlate steps
 *     in runs_running_now, never fail a firing on it alone;
 *   ok — inside every threshold.
 *
 * This pin is TEXTUAL + BEHAVIORAL:
 *  - TEXTUAL: the shipped audit declares the section with the class set, the
 *    branch order (queued before hb/long — the NULL fall-through), the 5/180
 *    thresholds, and the OUTER-query ordering (Postgres resolves ORDER BY
 *    output aliases only as bare names, never inside CASE expressions).
 *  - BEHAVIORAL: a JS model of the same classifier, driven by THIS firing's
 *    live rows (the 222-min fresh-hb nightly 9322c996, the 4-min and 3-min
 *    runs) plus synthetic worst-case rows, must yield the intended classes —
 *    pinning the semantics a future SQL refactor could silently drift from.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f59/f60 pin tests also declare top-level fs/path)

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const AUDIT = path.join(repoRoot(__dirname), 'scripts/framework-audit/audit-live-state.js');

/** The section's SQL, extracted from the shipped audit verbatim. */
function sectionSql(src: string): string {
  const m = src.match(/sec\('runs_suspect_class', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('runs_suspect_class section not found in audit-live-state.js');
  return m[1];
}

/** JS model of the shipped CASE classifier (keeps the same branch order). */
function classify(row: {
  status: 'running' | 'queued';
  createdAtMinAgo?: number; // queued rows: created >15 min ago ⇒ queued_stale
  runMin?: number | null; // now - startedAt (NULL for queued)
  hbMin?: number | null; // now - heartbeatAt (NULL for queued)
}): string {
  if (row.status === 'queued') {
    return (row.createdAtMinAgo ?? 0) > 15 ? 'queued_stale' : 'queued_ok';
  }
  const hb = row.hbMin ?? null;
  const run = row.runMin ?? null;
  if (hb !== null && hb > 5 && run !== null && run > 180) return 'long_stale_hb';
  if (hb !== null && hb > 5) return 'hb_stale';
  if (run !== null && run > 180) return 'long_fresh_hb';
  return 'ok';
}

describe('audit runs_suspect_class (FO firing 61)', () => {
  const auditSrc = fs.readFileSync(AUDIT, 'utf8');
  const sql = sectionSql(auditSrc);

  it('the audit ships the runs_suspect_class section (sec-wired, read-only)', () => {
    expect(sql.length).toBeGreaterThan(200);
    // sec() wraps every read in the { ERR } catch — a section outside sec()
    // would crash the whole audit on one bad query.
    expect(auditSrc).toContain("sec('runs_suspect_class'");
  });

  it('TEXTUAL: the charter thresholds — hb > 5 min, run > 180 min, queued > 15 min', () => {
    expect(sql).toContain("interval '15 minutes'");
    expect(sql).toMatch(/\)\s*\/\s*60\)\s*>\s*5\b/); // heartbeat minutes > 5
    expect(sql).toMatch(/\)\s*\/\s*60\)\s*>\s*180\b/); // run minutes > 180
  });

  it('TEXTUAL: queued branches precede the hb/long branches (NULL startedAt/heartbeatAt fall through to ok otherwise)', () => {
    const queuedIdx = sql.indexOf("WHEN r.status='queued'");
    const hbIdx = sql.indexOf('THEN \'long_stale_hb\'');
    expect(queuedIdx).toBeGreaterThan(-1);
    expect(hbIdx).toBeGreaterThan(queuedIdx); // queued CASE arms come first
    // both queued classes exist
    expect(sql).toContain("'queued_stale'");
    expect(sql).toContain("'queued_ok'");
    // all five classes exist exactly as documented
    for (const cls of ['long_stale_hb', 'hb_stale', 'long_fresh_hb', 'queued_stale', 'queued_ok', 'ok']) {
      expect(sql).toContain(`'${cls}'`);
    }
  });

  it('TEXTUAL: worst-first ordering via an OUTER query (ORDER BY alias-in-CASE is not valid Postgres)', () => {
    // the ordering lives on a real column t.suspect_class, not the bare alias
    expect(sql).toMatch(/ORDER BY CASE t\.suspect_class/);
    expect(sql).toMatch(/FROM \([\s\S]+\)\s*t\s+ORDER BY/); // subquery aliased t
    // actionable classes sort ahead of the benign long_fresh_hb class
    const rank = (cls: string) => sql.indexOf(`WHEN '${cls}' THEN`);
    expect(rank('long_stale_hb')).toBeLessThan(rank('long_fresh_hb'));
    expect(rank('hb_stale')).toBeLessThan(rank('long_fresh_hb'));
    expect(rank('queued_stale')).toBeLessThan(rank('long_fresh_hb'));
  });

  it('BEHAVIORAL: this firing\'s live rows classify as observed at 14:33Z', () => {
    // The 2026-10-01T14:33Z audit (runs_running_now): the 222-min nightly
    // 9322c996 (hb 0, lease fresh) plus two minutes-old runs. The eyeball
    // verdict every firing re-derived by hand — now the section's own classes.
    const nightly = classify({ status: 'running', runMin: 222, hbMin: 0 });
    const thisFiring = classify({ status: 'running', runMin: 4, hbMin: 0 });
    const trendsRun = classify({ status: 'running', runMin: 3, hbMin: 0 });
    expect(nightly).toBe('long_fresh_hb'); // benign: correlate steps, never fail alone
    expect(thisFiring).toBe('ok');
    expect(trendsRun).toBe('ok');
  });

  it('BEHAVIORAL: the actionable classes are reachable and distinct', () => {
    // worst case: long run AND stale heartbeat
    expect(classify({ status: 'running', runMin: 260, hbMin: 40 })).toBe('long_stale_hb');
    // wedged worker, short run
    expect(classify({ status: 'running', runMin: 20, hbMin: 12 })).toBe('hb_stale');
    // queued past the 15-min claim bar
    expect(classify({ status: 'queued', createdAtMinAgo: 42 })).toBe('queued_stale');
    expect(classify({ status: 'queued', createdAtMinAgo: 2 })).toBe('queued_ok');
    // queued rows carry NULL startedAt/heartbeatAt — the queued branch fires
    // BEFORE those NULLs can fall through the hb/long arms to 'ok'
    expect(classify({ status: 'queued', createdAtMinAgo: 42, runMin: null, hbMin: null })).toBe('queued_stale');
    // fresh and short — the common case
    expect(classify({ status: 'running', runMin: 30, hbMin: 1 })).toBe('ok');
  });

  it('BEHAVIORAL: boundary values sit on the correct side of every threshold', () => {
    // hb exactly 5 is FRESH (rule: older than 5 min is suspect); hb 6 is stale
    expect(classify({ status: 'running', runMin: 30, hbMin: 5 })).toBe('ok');
    expect(classify({ status: 'running', runMin: 30, hbMin: 6 })).toBe('hb_stale');
    // run exactly 180 is INSIDE (rule: past 3 h is suspect); 181 is long
    expect(classify({ status: 'running', runMin: 180, hbMin: 0 })).toBe('ok');
    expect(classify({ status: 'running', runMin: 181, hbMin: 0 })).toBe('long_fresh_hb');
    // queued exactly 15 is ok; 16 is stale
    expect(classify({ status: 'queued', createdAtMinAgo: 15 })).toBe('queued_ok');
    expect(classify({ status: 'queued', createdAtMinAgo: 16 })).toBe('queued_stale');
  });
});
