/**
 * Trajectory evals — OFFLINE replay suite (build 2026-10-08 E; runs in CI with
 * the rest of the backend suite; `npm run eval:trajectory` runs it alone and,
 * with EVAL_REPORT_DIR set, writes replay-report.{json,md}).
 *
 * For every frozen incident case: the incident recording still FAILS today's
 * graders (they catch it), the reference recording still PASSES (they accept
 * valid work), a harness-focus incident still PASSES through today's harness
 * (the fix holds) — replayed through the REAL agent loop with mutating tools
 * captured, never executed. A replay that DIVERGES (the harness now asks the
 * model something the recording never answered) fails with a re-record hint.
 */

import './eval-mocks.testkit';
import * as path from 'path';
import { caseFilterFromEnv, loadCasesReport, writeReport, JUDGE_LABELS_FILE } from './suite';
import { runReplaySuite } from './runner.testkit';
import { judgeIsBinding } from './judge';
import type { SuiteReport } from './suite';

jest.setTimeout(120_000);

const { cases, errors: loadErrors } = loadCasesReport(undefined, caseFilterFromEnv());
const judgeBinding = judgeIsBinding(JUDGE_LABELS_FILE);
const reports: SuiteReport[] = [];

afterAll(() => {
  const dir = process.env.EVAL_REPORT_DIR;
  if (!dir || !reports.length) return;
  const merged: SuiteReport = {
    ...reports[0],
    finishedAt: reports[reports.length - 1].finishedAt,
    cases: reports.flatMap((r) => r.cases),
    passHatKCases: reports.reduce((s, r) => s + r.passHatKCases, 0),
    ranCases: reports.reduce((s, r) => s + r.ranCases, 0),
  };
  writeReport(path.resolve(dir), merged, 'replay-report');
});

describe('trajectory evals — frozen incidents replayed through today\'s harness', () => {
  for (const e of loadErrors) {
    it(`case file ${e.file} is valid`, () => { throw new Error(e.message); });
  }

  it('the suite holds 15–40 frozen incidents (simplify.md step 3)', () => {
    if (caseFilterFromEnv()) return; // a filtered run checks only its cases
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.length).toBeLessThanOrEqual(40);
  });

  for (const c of cases) {
    it(`${c.id} — every recording gets its declared grade`, async () => {
      const report = await runReplaySuite([c], { judgeBinding });
      reports.push(report);
      const lines = report.cases[0].trials
        .filter((t) => !t.matchesExpectation)
        .map((t) => {
          const why = t.grade.status === 'diverged'
            ? `DIVERGED — ${t.outcome.diverged}. Today's harness asks the model for more than this recording holds: re-record it (npm run eval:trajectory:live with EVAL_CASES=${c.id} EVAL_RECORD_DIR=…) or update the case.`
            : t.grade.status === 'error'
              ? `ERROR — ${t.outcome.error}`
              : t.expected === 'fail'
                ? `expected FAIL but every grader passed — the graders no longer catch this incident (or the harness now repairs it: then set focus "harness" and expect "pass")`
                : `expected PASS, failed: ${t.grade.checks.filter((x) => !x.pass && !x.advisory && !x.skipped).map((x) => `${x.id} (${x.detail})`).join('; ')}`;
          return `recording "${t.outcome.recordingId}": ${why}`;
        });
      expect(lines).toEqual([]);
    });
  }
});
