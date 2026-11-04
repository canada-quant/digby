/**
 * Trajectory evals — judge calibration CLI (build 2026-10-08 E-13).
 *
 *   npm run eval:trajectory:calibrate            # print the judge's agreement with the owner's labels
 *   npm run eval:trajectory:calibrate -- --regen # rebuild judge-labels.json from the cases (keeps every label already set)
 *
 * Pure file work — no model calls (judge verdicts come from the live mode).
 */

import * as fs from 'fs';
import { JUDGE_LABELS_FILE, loadCases } from './suite';
import { computeCalibration, readJudgeLabels } from './judge';
import { regenerateLabels } from './labels';

function main(argv: string[]): number {
  if (argv.includes('--regen')) {
    const cases = loadCases();
    const next = regenerateLabels(cases, readJudgeLabels(JUDGE_LABELS_FILE));
    fs.writeFileSync(JUDGE_LABELS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`judge-labels.json: ${next.items.length} items (${next.items.filter((i) => i.ownerLabel).length} owner-labelled)`);
  }
  const file = readJudgeLabels(JUDGE_LABELS_FILE);
  if (!file) { console.log('no judge-labels.json — run with --regen'); return 1; }
  const cal = computeCalibration(file.items);
  console.log(cal.detail);
  console.log(`items ${file.items.length} · owner-labelled ${cal.labelled} · labelled + judged ${cal.judged} · TP ${cal.tp} TN ${cal.tn} FP ${cal.fp} FN ${cal.fn}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
