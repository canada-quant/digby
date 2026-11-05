/**
 * PIN (FO firing 101, 2026-10-08) — the journal-failure ESCALATE bars must
 * count the ADJUDICATED population, never the raw one, and a failed run
 * with a CONCURRENT live sibling is live:retried, not a defect.
 *
 * THE GAP THIS PINS (f101's live window, 2026-10-08T18:38Z audit): all
 * three rollup ESCALATEs were false —
 *   1. journal_failures_4h printed ESCALATE on chat c919294b (run 45c4f136,
 *      provider 400) while that chat had a RUNNING sibling the whole time
 *      (one of the 10 paired all_hb_fresh run locks). The f89 live:retried
 *      subquery only accepts a run created AFTER the journal row — a
 *      CONCURRENT sibling (created before, still running/queued) missed.
 *      Fix: a second EXISTS arm (r3) accepts a concurrent running/queued
 *      sibling.
 *   2. journal_fanout_4h ESCALATEd at 9 raw distinct chats while the detail
 *      adjudicated 10/11 rows watch-only. Measure-first (probe-f101-fanout.js,
 *      box A, 42 non-empty 4h buckets / 7d): raw >= 8 in 4 buckets, ZERO
 *      adjudicated-ESCALATE chats in each — the raw bar fired exclusively
 *      on guard-note storms. Fix: the population is the detail rung VERBATIM
 *      (run missing, or dead run with no newer AND no concurrent sibling)
 *      and the bar is escalate_chats >= 2 (a singleton stays the detail
 *      row the firing probes — single = agent behavior by doctrine).
 *   3. failed_runs_4h (rollup) counted every failed run; the same
 *      concurrent-sibling class made a live chat read as a defect. Fix: the
 *      population excludes runs with a live sibling (newer running/queued/
 *      completed OR concurrent running/queued).
 *
 * This is the f99/f100 lineage discipline: a rollup condition must COPY its
 * detail's rung verbatim, never a simpler proxy (f98 bake; f99 caught the
 * first two instances, f101 the next two).
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f94/f96/f98/f100
 * pins): the shipped audit declares the corrected arms/bars and a JS model
 * reproduces the live false-ESCALATE regimes plus the true-defect regimes.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f94/f96/f98 pin tests declare top-level fs/path the same way)

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

/** A section's SQL, extracted from the shipped audit verbatim. */
function sectionSql(name: string): string {
  const m = src.match(new RegExp(`sec\\('${name}', \\(\\) => q\\(\`([^\`]+)\`\\)\\)`));
  if (!m) throw new Error(`${name} section not found in audit-live-state.js`);
  return m[1];
}

/** The defect_rollup body (async-block shape, like the f98 pin's extractor). */
function rollupBody(): string {
  const m = src.match(/sec\('defect_rollup', async \(\) => \{([\s\S]*?)\n  \}\);/);
  if (!m) throw new Error('defect_rollup section not found in audit-live-state.js');
  return m[1];
}

const journalSql = sectionSql('journal_failures_4h');
const fanoutSql = sectionSql('journal_failure_fanout_4h');
const rollup = rollupBody();

describe('PIN f101: adjudicated-population bar corrections (31st f64 bake)', () => {
  describe('textual: the shipped audit declares the corrections', () => {
    it('journal_failures_4h live:retried accepts a CONCURRENT in-flight sibling (the c919294b class)', () => {
      // the f89 newer-run arm is intact
      expect(journalSql).toMatch(/r2\."createdAt" > j\."createdAt" AND r2\.status IN \('running','queued','completed'\)/);
      // the f101 concurrent arm: sibling created before-or-at the journal
      // row and in flight at journal time — running/queued now, or finished
      // AFTER the journal row (c919294b's sibling completed 18:50Z, 33 min
      // after the 18:17:07Z journal row — a status-only arm missed it)
      expect(journalSql).toMatch(/r3\."sessionId" = j\."chatId"/);
      expect(journalSql).toMatch(/r3\.id <> j\."runId"/);
      expect(journalSql).toMatch(/r3\."createdAt" <= j\."createdAt" AND \(r3\.status IN \('running','queued'\) OR \(r3\."finishedAt" IS NOT NULL AND r3\."finishedAt" > j\."createdAt"\)\)/);
      // both arms live inside the live:retried rung, before the ESCALATE fallthrough
      const iRung = journalSql.indexOf("'live:retried'");
      const iEsc = journalSql.indexOf('ELSE ' + "'ESCALATE'");
      expect(iRung).toBeGreaterThan(-1);
      expect(iEsc).toBeGreaterThan(iRung);
      const rung = journalSql.slice(journalSql.lastIndexOf('WHEN', iRung), iEsc);
      expect(rung).toContain('OR EXISTS');
    });

    it('journal_failure_fanout_4h counts the ADJUDICATED population with the bar at escalate_chats >= 2', () => {
      expect(fanoutSql).toContain('AS escalate_chats');
      expect(fanoutSql).toMatch(/WHEN f\.escalate_chats >= 2 THEN 'ESCALATE'/);
      // the adjudicated population is the detail rung verbatim: run-missing
      // OR dead run with NO newer live run AND NO concurrent sibling
      // f159 (c5a11e496, landed 2026-10-18): the run-missing arm now requires a
      // NON-NULL runId — supervisor chat turns journal with runId NULL by design,
      // and PR #1712's failures[] channel leaked 8 chats into run_missing/ESCALATE.
      // Pin updated to the shipped adjudicated form (this lane, ticket 405927c9:
      // the pin was missed when the SQL changed — jest pin vs the shell test that
      // WAS run).
      expect(fanoutSql).toMatch(/\(j\."runId" IS NOT NULL AND r\.id IS NULL\) OR \(r\.status IN \('failed','cancelled','interrupted'\)/);
      expect(fanoutSql).toMatch(/r2\."createdAt" > j\."createdAt" AND r2\.status IN \('running','queued','completed'\)/);
      expect(fanoutSql).toMatch(/r3\."createdAt" <= j\."createdAt" AND \(r3\.status IN \('running','queued'\) OR \(r3\."finishedAt" IS NOT NULL AND r3\."finishedAt" > j\."createdAt"\)\)/);
      // the f96 top_recurrence rung is unchanged and tests AFTER ESCALATE
      expect(fanoutSql).toMatch(/WHEN f\.distinct_chats >= 4 AND f\.top_chat_recurrence_7d >= 20 THEN 'top_recurrence'/);
      expect(fanoutSql.indexOf("'ESCALATE'")).toBeLessThan(fanoutSql.indexOf("'top_recurrence'"));
    });

    it('defect_rollup failed_runs_4h excludes dead runs with a live sibling (adjudicated population)', () => {
      const m = rollup.match(/SELECT 'failed_runs_4h' AS cond, (\(SELECT[\s\S]*?\))::int AS n/);
      expect(m).not.toBeNull();
      const cond = m![1];
      expect(cond).toMatch(/r\.status='failed' AND r\."createdAt" > now\(\) - interval '4 hours'/);
      // both sibling arms present (newer live run, concurrent in-flight run)
      expect(cond).toMatch(/r2\."createdAt" > r\."createdAt" AND r2\.status IN \('running','queued','completed'\)/);
      expect(cond).toMatch(/r2\."createdAt" <= r\."createdAt" AND \(r2\.status IN \('running','queued'\) OR \(r2\."finishedAt" IS NOT NULL AND r2\."finishedAt" > r\."createdAt"\)\)/);
    });

    it('defect_rollup journal_fanout_4h carries the detail rung verbatim (f99 contract)', () => {
      const m = rollup.match(/UNION ALL SELECT 'journal_fanout_4h', (\(SELECT[\s\S]*?\))::int/);
      expect(m).not.toBeNull();
      const cond = m![1];
      expect(cond).toMatch(/COUNT\(DISTINCT j\."chatId"\)/);
      // f159 (c5a11e496): the rollup's run-missing arm also requires NON-NULL
      // runId (same adjudicated predicate split as the detail rung).
      expect(cond).toMatch(/\(j\."runId" IS NOT NULL AND r\.id IS NULL\) OR \(r\.status IN \('failed','cancelled','interrupted'\)/);
      expect(cond).toMatch(/r2\."createdAt" > j\."createdAt" AND r2\.status IN \('running','queued','completed'\)/);
      expect(cond).toMatch(/r3\."createdAt" <= j\."createdAt" AND \(r3\.status IN \('running','queued'\) OR \(r3\."finishedAt" IS NOT NULL AND r3\."finishedAt" > j\."createdAt"\)\)/);
      // the ladder: >= 2 adjudicated chats escalates, 1 stays ok
      expect(rollup).toMatch(/cond = 'journal_fanout_4h' AND n >= 2 THEN 'ESCALATE'/);
      expect(rollup).toMatch(/cond = 'journal_fanout_4h' THEN 'ok'/);
    });

    it('declares the 31st bake marker', () => {
      expect(src).toMatch(/31st f64 bake/);
    });
  });

  describe('behavioral: JS models reproduce the live + synthetic regimes', () => {
    /** The live:retried adjudication, modelled on the shipped SQL. */
    function adjudicate(row: { runStatus: string | null; newerLiveRun: boolean; concurrentLiveRun: boolean }): string {
      if (row.runStatus === 'completed') return 'guard_note_strike';
      if (['failed', 'cancelled', 'interrupted'].includes(row.runStatus ?? '')) {
        if (row.newerLiveRun || row.concurrentLiveRun) return 'live:retried';
        return 'ESCALATE';
      }
      return 'run_missing';
    }

    it('the live c919294b row (failed run, concurrent running sibling, no newer run) adjudicates live:retried, not ESCALATE', () => {
      // probe-f101-retry.js, box A 2026-10-08T18:5xZ: run 45c4f136 failed
      // 18:17:03Z, journaled 18:17:07Z, retry_created=null — the sibling was
      // already running when the death was journaled.
      expect(adjudicate({ runStatus: 'failed', newerLiveRun: false, concurrentLiveRun: true })).toBe('live:retried');
    });

    it('a true dead-end failure (no sibling either side) still ESCALATEs', () => {
      expect(adjudicate({ runStatus: 'failed', newerLiveRun: false, concurrentLiveRun: false })).toBe('ESCALATE');
    });

    it('a dead run with a NEWER live run stays live:retried (the f89 arm is intact)', () => {
      expect(adjudicate({ runStatus: 'failed', newerLiveRun: true, concurrentLiveRun: false })).toBe('live:retried');
    });

    it('the fanout ladder: the f101 live window (9 raw chats, 0-1 adjudicated) reads ok; two dead-end chats escalate', () => {
      const ladder = (escalateChats: number) => (escalateChats >= 2 ? 'ESCALATE' : 'ok');
      // live window: 11 rows / 9 chats, one concurrent-sibling miss → after
      // the fix 0 adjudicated chats (the c919294b row flips live:retried)
      expect(ladder(0)).toBe('ok');
      expect(ladder(1)).toBe('ok');
      expect(ladder(2)).toBe('ESCALATE');
    });

    it('the failed_runs ladder: a window whose only failure has a live sibling reads n=0 (the f101 live window)', () => {
      // model of the corrected rollup condition
      const n = (failures: Array<{ newerLiveRun: boolean; concurrentLiveRun: boolean }>) =>
        failures.filter((f) => !f.newerLiveRun && !f.concurrentLiveRun).length;
      expect(n([{ newerLiveRun: false, concurrentLiveRun: true }])).toBe(0);
      expect(n([{ newerLiveRun: false, concurrentLiveRun: false }])).toBe(1);
    });
  });
});
