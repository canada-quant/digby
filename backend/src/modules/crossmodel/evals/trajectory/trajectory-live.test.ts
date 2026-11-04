/**
 * Trajectory evals — LIVE mode (build 2026-10-08 E). Skipped unless
 * EVAL_TRAJECTORY_LIVE=1 (npm run eval:trajectory:live; the nightly
 * .github/workflows/trajectory-evals.yml). Real seats, real money, capped by
 * EVAL_MAX_USD: k trials per case through the same harness as the offline
 * suite, pass^k per case, the report + every trial's recording written to
 * EVAL_REPORT_DIR. With EVAL_JUDGE_LABELS=1 it also asks the judge for every
 * item of judge-labels.json (judge-labels.judged.json in the report dir).
 *
 * Runner configuration (none is a product switch): EVAL_CASES, EVAL_K,
 * EVAL_MAX_USD, EVAL_CONCURRENCY, EVAL_TRIAL_TIMEOUT_MS, EVAL_EFFORT,
 * EVAL_MODEL, EVAL_SEATS, EVAL_JUDGE_MODEL, EVAL_GATEWAY_BASE_URL,
 * EVAL_GATEWAY_API_KEY, EVAL_REPORT_DIR, EVAL_JUDGE_LABELS.
 */

import './eval-mocks.testkit';
import * as fs from 'fs';
import * as path from 'path';
import { BASELINE_FILE, JUDGE_LABELS_FILE, baselineVerdict, caseFilterFromEnv, loadBaseline, loadCases, writeReport } from './suite';
import { liveOptionsFromEnv, makeLiveJudge, runLiveSuite } from './runner.testkit';
import { JUDGE_SYSTEM_PROMPT, computeCalibration, judgeIsBinding, parseJudgeVerdict, readJudgeLabels } from './judge';

const LIVE = process.env.EVAL_TRAJECTORY_LIVE === '1';
const run = LIVE ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 140 * 60_000;

run('trajectory evals — LIVE on the real seats (cost-capped)', () => {
  const opts = liveOptionsFromEnv();
  const log = (line: string) => { process.stdout.write(`${line}\n`); };

  it('runs every case k times and reports pass^k', async () => {
    const filter = caseFilterFromEnv();
    if (filter?.length === 1 && filter[0] === 'none') return; // judge-labels-only run
    const cases = loadCases(undefined, filter);
    const judgeBinding = judgeIsBinding(JUDGE_LABELS_FILE);
    const report = await runLiveSuite(cases, {
      ...opts,
      judge: opts.judgeModel ? makeLiveJudge(opts.judgeModel) : null,
      judgeBinding,
      log,
    });
    const verdict = baselineVerdict(report, loadBaseline(BASELINE_FILE));
    report.notes.push(`baseline: ${verdict.detail}`);
    const paths = writeReport(opts.reportDir, report, 'live-report');
    log(`[trajectory-eval] pass^${report.k}: ${report.passHatKCases}/${report.ranCases} cases · $${report.costUsd.toFixed(2)} · report ${paths.md}`);
    // Gates only once baseline.json lists measured passing cases (simplify.md:
    // pass^3 ≥ baseline − noise); with no baseline the run reports, never fails.
    if (!verdict.ok) throw new Error(`trajectory evals regressed against the baseline — ${verdict.detail}`);
  }, LIVE_TIMEOUT_MS);

  it('asks the judge for every calibration item (EVAL_JUDGE_LABELS=1)', async () => {
    if (process.env.EVAL_JUDGE_LABELS !== '1' || !opts.judgeModel) return;
    const file = readJudgeLabels(JUDGE_LABELS_FILE);
    if (!file) throw new Error('judge-labels.json is missing — npm run eval:trajectory:calibrate -- --regen');
    const judge = makeLiveJudge(opts.judgeModel);
    let spent = 0;
    for (const item of file.items) {
      if (spent >= opts.maxUsd) break;
      const user = [
        `REQUEST:\n${item.request}`, '', `TOOL CALLS THIS TURN:\n${item.calls}`, '', `DELIVERED REPLY:\n${item.reply}`, '', `RUBRIC: ${item.rubric}`,
      ].join('\n');
      try {
        const r = await judge(JUDGE_SYSTEM_PROMPT, user);
        spent += r.costUsd;
        item.judgeVerdict = parseJudgeVerdict(r.text);
      } catch { /* left unjudged */ }
    }
    fs.mkdirSync(opts.reportDir, { recursive: true });
    const out = path.join(opts.reportDir, 'judge-labels.judged.json');
    fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    log(`[trajectory-eval] judged ${file.items.filter((i) => i.judgeVerdict).length}/${file.items.length} label items ($${spent.toFixed(3)}) → ${out} — ${computeCalibration(file.items).detail}`);
  }, LIVE_TIMEOUT_MS);
});

if (!LIVE) {
  // Keep the file honest in the full suite: one visible no-op instead of a silent skip.
  it('live trajectory evals are off (EVAL_TRAJECTORY_LIVE=1 runs them)', () => {
    expect(process.env.EVAL_TRAJECTORY_LIVE).not.toBe('1');
  });
}
