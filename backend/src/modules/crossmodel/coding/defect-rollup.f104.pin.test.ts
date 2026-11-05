/**
 * PIN (FO firing 104, 2026-10-09) — the merge_gate_failure moved_on rung
 * (34th f64 bake), live-proven by this firing's own hand-run box-A probe.
 *
 * DEFECT (audit bar, not backend): a PR the owner closes UNMERGED can never
 * grow a merge_success, so the f100 dangling rung read it ESCALATE for its
 * whole 24h life — twice in two days: firing 101 (PR #1344, hand-adjudicated
 * "by-design-closed-unmerged; allow to age out") and firing 104 (PR #27
 * stanne-ctrlplaneui, gate-failed 00:09Z, closed by the owner 02:43Z,
 * superseded by PR #33 from the SAME lane at 03:07Z). Every firing that saw
 * the row hand-probed GitHub to learn this — the f64 doctrine exists to
 * retire exactly that by-eye adjudication.
 *
 * BAKE: a fourth rung, moved_on — no recovery for THIS PR, but the same
 * session has NEWER merge-gate traffic (merge_gate_failure or merge_success)
 * on a DIFFERENT repo+PR: the successor traffic IS the evidence the lane
 * moved on, DB-native, no GitHub call needed. The rollup condition
 * merge_gate_failure_dangling_24h copies the exclusion verbatim (the f98
 * contract: the rollup counts ONLY the rows the detail adjudicates ESCALATE).
 *
 * LIVE-PROVEN 2026-10-09 07:02Z (probe-f104-mgf.js on box A): new rollup read
 * merge_gate_failure_dangling_24h = 0, PR #27 read moved_on, the old-bar
 * control read 1, and all six genuinely-recovered rows stayed recovered.
 *
 * TEXTUAL + BEHAVIORAL, same shape as the f92–f103 pins.
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
    src.match(new RegExp(`sec\\('${name}', \\(\\) => q\\((.+)\\)\\);`));
  if (!m) throw new Error(`${name} section not found in audit-live-state.js`);
  return m[1];
}

const detailBody = sectionBody('merge_gate_failure_24h');
const rollupBody = sectionBody('defect_rollup');

describe('PIN f104: merge_gate_failure moved_on rung (34th f64 bake)', () => {
  describe('the detail section adjudicates the closed-unmerged class', () => {
    it('carries the moved_on rung between recovered and the 6h ESCALATE rung', () => {
      expect(detailBody).toMatch(/THEN 'recovered'/);
      expect(detailBody).toMatch(/THEN 'moved_on'/);
      expect(detailBody).toMatch(/THEN 'moved_on' WHEN now\(\) - m\."createdAt" > interval '6 hours' THEN 'ESCALATE'/);
      expect(detailBody).toMatch(/ELSE 'in_flight'/);
    });

    it('keys moved_on on newer same-session merge traffic on a DIFFERENT repo+PR', () => {
      expect(detailBody).toMatch(/t\.kind IN \('merge_gate_failure','merge_success'\)/);
      expect(detailBody).toMatch(/t\."sessionId" = m\."sessionId"/);
      expect(detailBody).toMatch(/t\."createdAt" > m\."createdAt"/);
      // row-comparison form, not OR-of-equalities: a PR number alone must not
      // match (PR 27 vs PR 33 in the same repo MUST differ)
      expect(detailBody).toMatch(/\(t\.meta->>'repo', t\.meta->>'pullNumber'\) <> \(m\.meta->>'repo', m\.meta->>'pullNumber'\)/);
    });

    it('names the firing-104 live row (PR #27 closed-unmerged, superseded by PR #33)', () => {
      // the bake's own comment carries the live evidence for the next reader
      expect(src).toMatch(/PR #27 stanne-ctrlplaneui/);
      expect(src).toMatch(/superseded by PR #33 from the same lane/);
    });
  });

  describe('the rollup condition excludes the moved_on class verbatim', () => {
    it('merge_gate_failure_dangling_24h keeps no-recovery + 6h AND adds the exclusion', () => {
      const cond = rollupBody.match(/UNION ALL SELECT 'merge_gate_failure_dangling_24h', ([^\n]+)/)?.[1] ?? '';
      expect(cond).toContain("m.kind='merge_gate_failure'");
      expect(cond).toMatch(/NOT EXISTS \(SELECT 1 FROM loop_metrics s WHERE s\.kind='merge_success'/);
      expect(cond).toMatch(/NOT EXISTS \(SELECT 1 FROM loop_metrics t WHERE t\.kind IN \('merge_gate_failure','merge_success'\)/);
      expect(cond).toMatch(/t\."sessionId" = m\."sessionId"/);
      expect(cond).toMatch(/now\(\) - m\."createdAt" > interval '6 hours'/);
    });

    it('the f103 schedules bar survives untouched (no regression to the 33rd bake)', () => {
      const sked = rollupBody.match(/UNION ALL SELECT 'schedules_trouble_now', ([^\n]+)/)?.[1] ?? '';
      expect(sked).toMatch(/"busySkips" >= 10/);
      expect(sked).toMatch(/"lastStatus" LIKE 'error%'/);
      expect(sked).toMatch(/"nextRunAt" < now\(\) - interval '20 minutes'/);
    });
  });

  describe('behavioral: the ladder firing 104 live-proved', () => {
    const ladder = (recovered: boolean, movedOn: boolean, ageHours: number) =>
      recovered ? 'recovered'
        : movedOn ? 'moved_on'
        : ageHours > 6 ? 'ESCALATE'
        : 'in_flight';

    it('PR #27 (closed 02:43Z, successor PR #33 gate traffic 03:07Z) reads moved_on', () => {
      // no merge_success for #27, but the same session wrote PR #33 traffic
      // 24 minutes later — and recovered=false, so only the new rung saves it
      expect(ladder(false, true, 7)).toBe('moved_on');
    });

    it('a genuinely dangling row (no recovery, no successor, > 6h) still escalates', () => {
      expect(ladder(false, false, 7)).toBe('ESCALATE');
    });

    it('a recovered row never reads moved_on (recovered wins the ladder)', () => {
      expect(ladder(true, true, 7)).toBe('recovered');
    });

    it('a fresh unrecovered row still reads in_flight (< 6h)', () => {
      expect(ladder(false, false, 3)).toBe('in_flight');
    });
  });
});
