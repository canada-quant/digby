/**
 * PIN (FO firing 62, 2026-10-01) — the live audit must CLASSIFY journal-with-
 * failures rows, not leave their identification to a manual box probe.
 *
 * THE GAP THIS PINS: audit-live-state.js's journal_4h section counts rows with
 * a non-empty failures array (with_failures) but says nothing about WHAT they
 * are. Firing 62 saw `schedule n=10 with_failures=3` alongside an EMPTY
 * runs_failed_4h — and paid a manual one-off box probe to identify the rows:
 * two evidence-guard PRE-DELIVERY strikes on the X-feed chat's final notes
 * (a phantom claims-block dispatch entry; output truncated before completion).
 * Both runs COMPLETED — the guard struck the note, it was replaced, nothing
 * else happened. That guard-strike-vs-run-death distinction is exactly the
 * triage a firing must make when with_failures > 0, and until now it required
 * a hand-rolled probe every time.
 *
 * THE FIX (firing 62): a journal_failures_4h section in audit-live-state.js
 * details the failure rows (chat, title, trigger, run, failures head) and
 * CLASSIFIES each by the referenced run's outcome (LEFT JOIN agent_runs —
 * the run may be gone):
 *   guard_note_strike — the run COMPLETED (benign: the note was replaced;
 *     only a repeated strike on the SAME chat warrants a deeper look);
 *   run_died          — the run failed/was cancelled (cross-check
 *     runs_failed_4h; the failures may be the death cause);
 *   run_interrupted   — the run was interrupted (cross-check
 *     runs_interrupted_24h);
 *   run_missing       — the LEFT JOIN found no run (retention-swept, or a
 *     queued run that never claimed).
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f61 runs_suspect_class
 * pin): the shipped audit declares the section, the class set, and the
 * branch order (completed FIRST — a NULL run status from the LEFT JOIN must
 * fall to run_missing, never past the completed arm); a JS model of the same
 * classifier reproduces this firing's live rows (both guard strikes) plus
 * the synthetic worst cases.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f59/f60/f61 pin tests declare top-level fs/path the same way)

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
  const m = src.match(/sec\('journal_failures_4h', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('journal_failures_4h section not found in audit-live-state.js');
  return m[1];
}

/** JS model of the shipped CASE classifier (same branch order as the SQL). */
function classify(runStatus: string | null | undefined): string {
  if (runStatus === 'completed') return 'guard_note_strike';
  if (runStatus === 'failed' || runStatus === 'cancelled') return 'run_died';
  if (runStatus === 'interrupted') return 'run_interrupted';
  // f179: a journal-failures row on a LIVE run is the mid-finalize guard
  // strike (journal + finishedAt stamp at finalize; the post-strike
  // replacement keeps the run running) — watch-only, never run_missing.
  if (runStatus === 'running' || runStatus === 'queued') return 'run_live';
  return 'run_missing'; // NULL (LEFT JOIN miss) and every other status
}

describe('audit journal_failures_4h (FO firing 62)', () => {
  const auditSrc = fs.readFileSync(AUDIT, 'utf8');
  const sql = sectionSql(auditSrc);

  it('the audit ships the journal_failures_4h section (sec-wired, read-only)', () => {
    expect(sql.length).toBeGreaterThan(200);
    // sec() wraps every read in the { ERR } catch — a section outside sec()
    // would crash the whole audit on one bad query.
    expect(auditSrc).toContain("sec('journal_failures_4h'");
    // it reads run_journal_entries filtered to non-empty failures, 4h window
    expect(sql).toContain('FROM run_journal_entries j');
    expect(sql).toContain("array_length(j.failures, 1) > 0");
    expect(sql).toContain("interval '4 hours'");
  });

  it('TEXTUAL: LEFT JOIN agent_runs — the run may be gone (retention-swept)', () => {
    // an INNER join would DROP the run_missing class instead of classifying it
    expect(sql).toMatch(/LEFT JOIN agent_runs r ON r\.id = j\."runId"/);
  });

  it('TEXTUAL: all four classes exist, completed arm FIRST (NULL must fall to run_missing)', () => {
    for (const cls of ['guard_note_strike', 'run_died', 'run_interrupted', 'run_missing']) {
      expect(sql).toContain(`'${cls}'`);
    }
    // branch order: the completed arm precedes every other arm — a NULL run
    // status falls THROUGH to run_missing only because completed was checked
    // first (f61 doctrine: branch on run status before anything else).
    const completedIdx = sql.indexOf("WHEN r.status = 'completed'");
    const diedIdx = sql.indexOf("WHEN r.status IN ('failed','cancelled')");
    const missingIdx = sql.indexOf("'run_missing'");
    expect(completedIdx).toBeGreaterThan(-1);
    expect(diedIdx).toBeGreaterThan(completedIdx);
    expect(missingIdx).toBeGreaterThan(diedIdx);
  });

  it('TEXTUAL: failures head is bounded (LEFT 160) and rows capped (LIMIT 15)', () => {
    expect(sql).toContain('LEFT(j.failures::text,160)');
    expect(sql).toContain('LIMIT 15');
  });

  it('BEHAVIORAL: this firing\'s live rows classify as observed at 18:47Z', () => {
    // The 2026-10-01T18:47:51Z box probe (firing 62): two journal rows on the
    // X-feed chat dddb9ba, failures = evidence-guard note strikes; both runs
    // COMPLETED (active_chats_4h: 2 runs, ok 2, failed 0).
    expect(classify('completed')).toBe('guard_note_strike');
  });

  it('BEHAVIORAL: the synthetic worst cases classify to their intended classes', () => {
    expect(classify('failed')).toBe('run_died');
    expect(classify('cancelled')).toBe('run_died');
    expect(classify('interrupted')).toBe('run_interrupted');
    // LEFT JOIN miss = NULL, and any unexpected status also lands here
    expect(classify(null)).toBe('run_missing');
    expect(classify(undefined)).toBe('run_missing');
    // f179: run still going = the mid-finalize guard strike, watch-only
    // (wedge detection stays with runs_suspect_class, never this section)
    expect(classify('running')).toBe('run_live');
    expect(classify('queued')).toBe('run_live');
  });

  it('TEXTUAL: the f179 run_live arm sits between interrupted and the ELSE fall-through', () => {
    // branch order contract (f61): completed first, ELSE 'run_missing' LAST —
    // a NULL run status falls through every arm to run_missing.
    const interruptedIdx = sql.indexOf("WHEN r.status = 'interrupted'");
    const liveIdx = sql.indexOf("WHEN r.status IN ('running','queued') THEN 'run_live'");
    const missingIdx = sql.indexOf("'run_missing'");
    expect(interruptedIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(interruptedIdx);
    expect(missingIdx).toBeGreaterThan(liveIdx);
    // and the verdict CASE carries the matching watch rung before live:retried
    const verdictLiveIdx = sql.indexOf("WHEN r.status IN ('running','queued') THEN 'live:finalizing'");
    expect(verdictLiveIdx).toBeGreaterThan(-1);
    expect(verdictLiveIdx).toBeLessThan(sql.indexOf("'live:retried'"));
  });

  it('BEHAVIORAL: the classifier is total — every possible run status yields a class', () => {
    const statuses = ['completed', 'failed', 'cancelled', 'interrupted', 'running', 'queued', 'skipped', null, undefined];
    const classes = new Set(statuses.map(classify));
    // no status produces undefined/empty — the section never emits a blank class
    for (const s of statuses) {
      expect(typeof classify(s)).toBe('string');
      expect(classify(s).length).toBeGreaterThan(0);
    }
    expect(classes.has('guard_note_strike')).toBe(true);
    expect(classes.has('run_died')).toBe(true);
    expect(classes.has('run_interrupted')).toBe(true);
    expect(classes.has('run_live')).toBe(true);
    expect(classes.has('run_missing')).toBe(true);
  });
});
