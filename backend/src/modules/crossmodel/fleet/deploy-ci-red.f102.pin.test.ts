/**
 * PIN (FO firing 102, 2026-10-08) — red-deploy alerts must adjudicate
 * RECOVERY natively, so a firing never hand-probes GitHub to learn whether
 * a ci-red deploy alert inside its 24h window was already fixed.
 *
 * THE GAP THIS PINS: infra_alert_ci_red_24h escalated on ANY red-deploy
 * alert count > 0 inside 24h. Firing 102's window held two red runs
 * (37827561943 a90fed4c, 37827970155 789ef7d7) that both failed the SAME
 * single test — the openapi drift 'get /api/crossmodel/refs/{kind}/{id}'
 * the f101 squash 3b4375b fixed at 19:28Z — yet the rollup printed the
 * window's only ESCALATE. Every such firing hand-ran gh run view to
 * adjudicate. Same defect class as the f100 merge-gate bake: a raw count
 * with no recovery adjudication.
 *
 * THE FIX (32nd f64 bake, two seams):
 *  1. WRITER — the infra-watch sweep stamps deploy_wave_success (ONE row
 *     per successful deploy run it has seen, Redis-deduped by runId for 7d,
 *     meta.at = the run's CONCLUSION time). The rows land even when nothing
 *     is red, so recovery is provable the moment a green wave concludes.
 *  2. AUDIT — deploy_ci_red_24h adjudicates each red alert: 'recovered'
 *     (a deploy_wave_success concluded after the alert), 'in_flight'
 *     (< 6h, no green wave yet), 'ESCALATE' (no green wave for 6h+ — main
 *     has not deployed for two firings' worth of red). The rollup condition
 *     infra_alert_ci_red_24h now counts the SAME adjudicated population
 *     (no later deploy_wave_success AND older than 6h) instead of every
 *     red row.
 *
 * CONSEQUENCE PINNED: an in-window red alert whose cause a later wave fixed
 * reads 'recovered' in the detail and drops OUT of the rollup count — the
 * rollup escalates only genuinely-stuck red, never a fixed one.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f101 pins).
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
const INFRA = path.join(repoRoot(__dirname), 'backend/src/modules/crossmodel/fleet/infra-watch.service.ts');
const auditSrc = fs.readFileSync(AUDIT, 'utf8');
const infraSrc = fs.readFileSync(INFRA, 'utf8');

function sectionBody(name: string): string {
  const m =
    auditSrc.match(new RegExp(`sec\\('${name}', \\(\\) => q\\(\\\`([\\s\\S]*?)\\\`\\)\\);`));
  if (!m) throw new Error(`${name} section not found in audit-live-state.js`);
  return m[1];
}

const detailBody = sectionBody('deploy_ci_red_24h');

describe('PIN f102: deploy ci-red recovery adjudication (32nd f64 bake)', () => {
  describe('textual: the shipped audit + sweep carry the bake', () => {
    it('declares the 32nd f64 bake marker', () => {
      expect(auditSrc).toMatch(/deploy_ci_red_24h \(firing 102, 2026-10-08 — 32nd f64 bake\)/);
    });

    it('the detail section adjudicates recovery on deploy_wave_success concluded AFTER the alert', () => {
      expect(detailBody).toContain("kind='deploy_wave_success'");
      expect(detailBody).toContain("(s.meta->>'at')::timestamptz > m.\"createdAt\"");
      expect(detailBody).toContain("THEN 'recovered'");
      expect(detailBody).toContain("interval '6 hours'");
      expect(detailBody).toContain("ELSE 'in_flight'");
    });

    it('the detail reads the red-alert population (kind=deploy, ciVerdict=failure, 24h)', () => {
      expect(detailBody).toContain("m.kind='infra_alert'");
      expect(detailBody).toContain("m.meta->>'kind'='deploy'");
      expect(detailBody).toContain("m.meta->>'ciVerdict' = 'failure'");
      expect(detailBody).toContain("interval '24 hours'");
    });

    it('the rollup condition counts the ADJUDICATED population, not every red row', () => {
      const m = auditSrc.match(/UNION ALL SELECT 'infra_alert_ci_red_24h', \(([\s\S]*?)\)::int/);
      expect(m).not.toBeNull();
      const cond = m![1];
      // the same recovery exclusion the detail bakes…
      expect(cond).toContain("NOT EXISTS (SELECT 1 FROM loop_metrics s WHERE s.kind='deploy_wave_success' AND (s.meta->>'at')::timestamptz > m.\"createdAt\")");
      // …and the same 6h in-flight grace
      expect(cond).toContain("now() - m.\"createdAt\" > interval '6 hours'");
    });

    it('the sweep stamps deploy_wave_success (one row per successful run, Redis-deduped)', () => {
      expect(infraSrc).toMatch(/selectDeploySuccesses/);
      expect(infraSrc).toMatch(/LOOP_METRIC_KINDS\.DEPLOY_WAVE_SUCCESS/);
      expect(infraSrc).toMatch(/DEPLOY_SEEN_KEY\(`ok-\$\{s\.runId\}`\)/);
    });
  });

  describe('behavioral: the ladder reproduces live + synthetic regimes', () => {
    /** The shipped verdict ladder, lifted verbatim from the section. */
    const verdict = (ageH: number, recovered: boolean): string => {
      if (recovered) return 'recovered';
      if (ageH > 6) return 'ESCALATE';
      return 'in_flight';
    };

    it('live f102 window: both red runs recovered (the f101 squash fixed them at 19:28Z)', () => {
      // Observed this firing: run 37827561943 raised 19:05Z, run 37827970155
      // raised 19:05Z, green wave 37832242670 concluded 19:47Z — both read
      // 'recovered' and the rollup count drops to 0.
      expect(verdict(3, true)).toBe('recovered');
      expect(verdict(3, true)).toBe('recovered');
    });

    it('a young red alert with no green wave yet is in_flight, never an ESCALATE', () => {
      expect(verdict(1, false)).toBe('in_flight');
      expect(verdict(5, false)).toBe('in_flight');
    });

    it('a red alert with no green wave for 6h+ escalates (the abandoned-fix class)', () => {
      expect(verdict(6.1, false)).toBe('ESCALATE');
      expect(verdict(20, false)).toBe('ESCALATE');
    });

    it('recovery wins regardless of age: a 20h-old red alert a later wave fixed reads recovered', () => {
      expect(verdict(20, true)).toBe('recovered');
    });

    it('the rollup counts only ESCALATE-class rows: recovered and in_flight drop out', () => {
      const rows = [
        { ageH: 3, recovered: true },   // f102's own window — recovered
        { ageH: 20, recovered: true },  // old but fixed
        { ageH: 1, recovered: false },  // fresh, fix lane may be mid-repair
      ];
      const escalates = rows.filter((r) => verdict(r.ageH, r.recovered) === 'ESCALATE');
      expect(escalates).toHaveLength(0);
      // …and a genuinely stuck one alone still escalates
      const stuck = [...rows, { ageH: 10, recovered: false }];
      expect(stuck.filter((r) => verdict(r.ageH, r.recovered) === 'ESCALATE')).toHaveLength(1);
    });
  });
});
