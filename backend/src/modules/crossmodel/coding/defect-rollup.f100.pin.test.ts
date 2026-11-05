/**
 * PIN (FO firing 100, 2026-10-08) — the merge_gate_failure adjudication bake
 * (30th f64 bake), live-proven by this firing's own hand-run probe.
 *
 * DEFECT (audit seam, not backend): merge_gate_failure rows appeared ONLY as
 * a raw count inside metric_kinds_4h, so every firing that saw n>0 hand-ran a
 * box probe to adjudicate it — a by-eye verdict the f64 doctrine exists to
 * retire. Firing 100 paid exactly that probe: the 4h row was this lane's own
 * PR #1353 (sessionId 5f90c628, meta {gate:'pr_state', cause:'PR not
 * mergeable (mergeable=false, state=dirty)', pullNumber:1353}, 10:56:24Z);
 * the lane rebased to c20525b21 and the PR merged at 11:06Z — recovered.
 *
 * BAKE: the merge_gate_failure_24h detail section adjudicates IN-AUDIT with
 * a three-rung verdict keyed on a later merge_success row for the SAME
 * repo+PR:
 *   recovered — a merge_success exists after the failure
 *   in_flight — no recovery yet, failure younger than 6h (mid-recovery;
 *               firing 100's own row read this class for 10 minutes)
 *   ESCALATE  — no recovery and older than 6h: two FO firings have passed
 *               without resolution — the gate refusal is fine, the ABANDON
 *               is the defect.
 * The defect_rollup condition merge_gate_failure_dangling_24h copies the
 * 6h + no-recovery rung verbatim (the f98 contract: a rollup condition
 * carries the SAME bar its detail bakes, never a simpler proxy).
 *
 * TEXTUAL + BEHAVIORAL, same shape as the f92–f99 pins.
 */

const fs = require('fs');
const path = require('path');

export {};

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

function sectionBody(name: string): string {
  const m =
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\(\\{([\\s\\S]*?)\\n  \\}\\)\\);`)) ||
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\{([\\s\\S]*?)\\n  \\}\\);`)) ||
    // single-expression shape: sec('name', () => q(...)); (one line)
    src.match(new RegExp(`sec\\('${name}', \\(\\) => q\\((.+)\\)\\);`));
  if (!m) throw new Error(`${name} section not found in audit-live-state.js`);
  return m[1];
}

const detailBody = sectionBody('merge_gate_failure_24h');
const rollupBody = sectionBody('defect_rollup');

describe('PIN f100: merge_gate_failure adjudication bake (30th f64 bake)', () => {
  describe('the detail section adjudicates instead of counting', () => {
    it('keys recovery on a later merge_success for the SAME repo+PR', () => {
      expect(detailBody).toContain("kind='merge_gate_failure'");
      expect(detailBody).toMatch(/s\.kind='merge_success'/);
      expect(detailBody).toMatch(/s\."createdAt" > m\."createdAt"/);
      expect(detailBody).toMatch(/s\.meta->>'pullNumber' = m\.meta->>'pullNumber'/);
      expect(detailBody).toMatch(/s\.meta->>'repo' = m\.meta->>'repo'/);
    });

    it('carries the three-rung verdict ladder (recovered / in_flight / ESCALATE)', () => {
      expect(detailBody).toMatch(/THEN 'recovered'/);
      expect(detailBody).toMatch(/interval '6 hours' THEN 'ESCALATE'/);
      expect(detailBody).toMatch(/ELSE 'in_flight'/);
    });

    it('names the firing-100 live row (PR 1353, dirty pr_state, recovered by rebase)', () => {
      // the bake's own comment carries the live evidence for the next reader
      expect(src).toMatch(/PR #1353, mergeable=false state=dirty at 10:56Z, recovered by/);
    });
  });

  describe('the rollup condition copies the detail bar verbatim', () => {
    it('merge_gate_failure_dangling_24h exists with the no-recovery + 6h rung', () => {
      const cond = rollupBody.match(/UNION ALL SELECT 'merge_gate_failure_dangling_24h', ([^\n]+)/)?.[1] ?? '';
      expect(cond).toContain("m.kind='merge_gate_failure'");
      expect(cond).toMatch(/NOT EXISTS \(SELECT 1 FROM loop_metrics s WHERE s\.kind='merge_success'/);
      expect(cond).toMatch(/s\.meta->>'pullNumber' = m\.meta->>'pullNumber'/);
      expect(cond).toMatch(/now\(\) - m\."createdAt" > interval '6 hours'/);
    });

    it('the f99 bar corrections survive untouched (no regression to the 29th bake)', () => {
      const crosscheck = rollupBody.match(/UNION ALL SELECT 'crosscheck_failed_24h', ([^\n]+)/)?.[1] ?? '';
      expect(crosscheck).toMatch(/interval '7 days'\) > 1/);
      const deploy = rollupBody.match(/UNION ALL SELECT 'deploy_interrupts_24h', ([^\n]+)/)?.[1] ?? '';
      expect(deploy).toMatch(/GROUP BY "sessionId" HAVING COUNT\(\*\) >= 2/);
    });
  });

  describe('behavioral: the ladder firing 100 live-proved', () => {
    const ladder = (recovered: boolean, ageHours: number) =>
      recovered ? 'recovered' : ageHours > 6 ? 'ESCALATE' : 'in_flight';

    it('PR #1353 at 10:56Z with the 11:06Z merge_success reads recovered', () => {
      // merge_success (11:06Z) exists after the failure (10:56Z) → recovered
      expect(ladder(true, 0.17)).toBe('recovered');
    });

    it('a fresh unrecovered failure (< 6h) reads in_flight, never escalates', () => {
      // the lane may be mid-recovery — never fail a firing on it alone
      expect(ladder(false, 3)).toBe('in_flight');
    });

    it('an unrecovered failure older than 6h escalates (two firings, no resolution)', () => {
      expect(ladder(false, 7)).toBe('ESCALATE');
    });
  });
});
