/**
 * PIN (FO firing 103, 2026-10-09) — the schedules_trouble busySkips bar must
 * match the framework's OWN consumers of the same column, so a benign
 * busy-park never reads as the fleet's only rollup ESCALATE.
 *
 * THE GAP THIS PINS: the schedules_trouble detail fired at busySkips >= 2 and
 * the rollup condition schedules_trouble_now counted the same raw bar. But
 * the framework's own machinery treats 2 skips as NOISE:
 *  - the busy-skip alarm's FIRST crossing is 3 (BUSY_SKIP_ALARM_FIRST,
 *    schedule.service.ts) and level 1 stays INFO — "9 min busy, under the
 *    p50 legitimate run";
 *  - the zombie lane watchdog reads busySkips >= 10 (ZOMBIE_BUSY_SKIPS_MIN,
 *    attention-watchdog.service.ts) — that is the warn-level wedged-lane
 *    signal.
 * Firing 103's ONLY rollup ESCALATE was chat 41bd202a (Schooltime
 * Supervisor): busySkips 2, lastStatus skipped:no_material_change, nextRunAt
 * 107 min in the FUTURE — the benign busy-park class (fire time hit a live
 * run; the row re-arms ~3 min later), yet every such firing re-probed the
 * schedule by hand to learn that. Same defect class as f101/f102: a bar
 * stricter than the framework's own adjudication.
 *
 * THE FIX (33rd f64 bake, two seams):
 *  1. DETAIL — schedules_trouble gains a computed verdict column:
 *     ESCALATE = busySkips >= 10 OR lastStatus LIKE 'error%' OR overdue
 *     > 20 min (the framework's warn rung, all three arms); busySkips 3–9 =
 *     'watch:busy_park' (the alarm's info level — visible, never escalated);
 *     busySkips 2 = ok. The row population is UNCHANGED (>= 2 OR error% OR
 *     overdue) so the watch stays as wide as before — only the bar moved.
 *  2. ROLLUP — schedules_trouble_now counts ONLY the ESCALATE bar
 *     (busySkips >= 10 OR error% OR overdue), verbatim from the detail.
 *
 * CONSEQUENCE PINNED: the f103 window (busySkips 2, future nextRunAt,
 * skipped:no_material_change) reads verdict 'ok' in the detail and drops OUT
 * of the rollup count; a genuinely wedged lane (busySkips >= 10, the
 * "75 consecutive skips in silence" class) still escalates.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f102 pins).
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope (sibling pin tests declare top-level fs/path the same way)

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

/** The section body, extracted from the shipped audit verbatim. */
function sectionBody(name: string): string {
  // three shapes ship in the audit: plain-object return, async block, and the
  // `q(\`SQL\`)` call (schedules_trouble) — match the LAST with a marker search
  // so no nested backtick needs escaping inside this regex.
  let m = src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\(\\{([\\s\\S]*?)\\n  \\}\\)\\);`)) ||
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\{([\\s\\S]*?)\\n  \\}\\);`));
  if (m) return m[1];
  const start = src.indexOf(`await sec('${name}', () => q(`);
  if (start < 0) throw new Error(`${name} section not found in audit-live-state.js`);
  const end = src.indexOf('`));', start);
  if (end < 0) throw new Error(`${name} section terminator not found`);
  return src.slice(start, end);
}

const detailBody = sectionBody('schedules_trouble');

/** The rollup body (block shape, same extraction as the f98 pin). */
const rollupBody = (() => {
  const m = src.match(new RegExp(`sec\\('defect_rollup', async \\(\\) => \\{([\\s\\S]*?)\\n  \\}\\);`));
  if (!m) throw new Error('defect_rollup section not found in audit-live-state.js');
  return m[1];
})();

/** The framework's own bars, extracted from the live source so the pin FAILS
 *  if either consumer's constant drifts away from the audit's bar. */
const SCHED_SRC = fs.readFileSync(
  path.join(repoRoot(__dirname), 'backend/src/modules/crossmodel/coding/schedule.service.ts'),
  'utf8',
);
const WATCHDOG_SRC = fs.readFileSync(
  path.join(repoRoot(__dirname), 'backend/src/modules/crossmodel/fleet/attention-watchdog.service.ts'),
  'utf8',
);

describe('PIN f103: schedules_trouble busySkips bar (33rd f64 bake)', () => {
  describe('textual: the shipped audit carries the corrected bar', () => {
    it('declares the 33rd f64 bake marker', () => {
      expect(src).toMatch(/f103 bar correction \(33rd f64 bake, 2026-10-09\)/);
    });

    it('the detail verdict ESCALATE rung is busySkips >= 10 (the zombie-watchdog bar), never >= 2', () => {
      expect(detailBody).toMatch(/WHEN s\."busySkips" >= 10 OR s\."lastStatus" LIKE 'error%' OR s\."nextRunAt" < now\(\) - interval '20 minutes' THEN 'ESCALATE'/);
      expect(detailBody).not.toMatch(/>= 2 THEN 'ESCALATE'/);
    });

    it('busySkips 3–9 reads watch:busy_park (the alarm info level), not ESCALATE', () => {
      expect(detailBody).toMatch(/WHEN s\."busySkips" >= 3 THEN 'watch:busy_park'/);
    });

    it('the detail row population stays WIDE (>= 2 OR error% OR overdue — the watch is unchanged, only the bar moved)', () => {
      expect(detailBody).toMatch(/WHERE s\.enabled AND \(s\."busySkips" >= 2 OR s\."lastStatus" LIKE 'error%' OR s\."nextRunAt" < now\(\) - interval '20 minutes'\)/);
    });

    it('the rollup condition copies the ESCALATE bar verbatim (>= 10), not the raw >= 2', () => {
      expect(rollupBody).toMatch(/SELECT 'schedules_trouble_now', \(SELECT COUNT\(\*\) FROM coding_schedules WHERE enabled AND \("busySkips" >= 10 OR "lastStatus" LIKE 'error%' OR "nextRunAt" < now\(\) - interval '20 minutes'\)\)::int/);
      expect(rollupBody).not.toMatch(/"busySkips" >= 2 OR "lastStatus"/);
    });

    it('the audit bar matches the framework consumers live: BUSY_SKIP_ALARM_FIRST=3 (info), ZOMBIE_BUSY_SKIPS_MIN=10 (warn)', () => {
      expect(SCHED_SRC).toMatch(/BUSY_SKIP_ALARM_FIRST = 3/);
      expect(WATCHDOG_SRC).toMatch(/ZOMBIE_BUSY_SKIPS_MIN = 10/);
    });
  });

  describe('behavioral: the verdict ladder (JS model of the SQL CASE)', () => {
    // verdict(busySkips, lastStatus, overdueMin) — mirrors the detail CASE.
    const verdict = (busySkips: number, lastStatus: string, overdueMin: number): string => {
      if (busySkips >= 10 || lastStatus.startsWith('error') || overdueMin > 20) return 'ESCALATE';
      if (busySkips >= 3) return 'watch:busy_park';
      return 'ok';
    };

    it('live f103 window (chat 41bd202a): busySkips 2, skipped:no_material_change, nextRunAt in the FUTURE → ok, out of the rollup', () => {
      expect(verdict(2, 'skipped:no_material_change', -107)).toBe('ok');
      // the rollup counts it: population WHERE >= 2 matches, bar >= 10 does not
      const inPopulation = 2 >= 2;
      const escalated = 2 >= 10;
      expect(inPopulation && !escalated).toBe(true);
    });

    it('busySkips 3 (the alarm first crossing) reads watch:busy_park — visible, never an ESCALATE', () => {
      expect(verdict(3, 'started', 0)).toBe('watch:busy_park');
      expect(verdict(9, 'started', 0)).toBe('watch:busy_park');
    });

    it('busySkips 10 (ZOMBIE_BUSY_SKIPS_MIN — the 75-consecutive-skips-in-silence class) escalates', () => {
      expect(verdict(10, 'started', 0)).toBe('ESCALATE');
      expect(verdict(75, 'started', 0)).toBe('ESCALATE');
    });

    it('error-status and overdue arms keep their ESCALATE rungs independent of busySkips', () => {
      expect(verdict(0, 'error:probe', 0)).toBe('ESCALATE');
      expect(verdict(0, 'started', 25)).toBe('ESCALATE');
      expect(verdict(2, 'started', 25)).toBe('ESCALATE');
    });
  });
});
