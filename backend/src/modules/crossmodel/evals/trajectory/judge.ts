/**
 * Trajectory evals — the LLM JUDGE + its calibration against owner labels
 * (build 2026-10-08 E-10). Pure: the model call is injected.
 *
 * Deterministic graders decide the suite. A `judge` grader is used ONLY where
 * no deterministic check can (e.g. "does the opening answer the owner's
 * question?"), asks ONE binary question, and stays ADVISORY until the judge
 * agrees with the owner: judge-labels.json holds ≥ 50 owner-labelled items
 * and the judge's TPR and TNR against them are both ≥ 0.85 (Husain/Shankar:
 * track both rates; Anthropic: calibrate LLM graders against human experts).
 */

import * as fs from 'fs';
import type { TrialOutcome } from './graders';
import type { TrajectoryCase } from './types';

export const JUDGE_MIN_LABELS = 50;
export const JUDGE_MIN_RATE = 0.85;

export const JUDGE_SYSTEM_PROMPT = `You grade ONE outcome of an AI agent's turn against ONE rubric. You see the request the agent received, the tool calls it made (with what each returned), and the reply it delivered. Judge only what the rubric asks — not style, not length, not the path the agent took. Answer with a single line of JSON: {"verdict":"pass"|"fail","reason":"<one sentence>"}.`;

function clip(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}… [${t.length - n} more chars]` : t;
}

/** The judge's user message: request → calls (with outputs) → delivered reply → rubric. */
export function judgeUserMessage(c: TrajectoryCase, o: Pick<TrialOutcome, 'finalText' | 'calls'>, rubric: string): string {
  const calls = o.calls.length
    ? o.calls.map((x) => `#${x.seq} ${x.tool}(${clip(JSON.stringify(x.args), 400)}) → ${clip(x.output, 600)}`).join('\n')
    : '(no tool calls)';
  return [
    `REQUEST (${c.trigger.replace('_', ' ')}, ${c.role.replace('_', ' ')}, at ${c.input.now}):`,
    clip(c.input.message, 3000),
    '',
    'TOOL CALLS THIS TURN:',
    calls,
    '',
    'DELIVERED REPLY:',
    clip(o.finalText, 6000),
    '',
    `RUBRIC: ${rubric}`,
  ].join('\n');
}

/** Parse the judge's reply; null when it is not a verdict. */
export function parseJudgeVerdict(text: string): 'pass' | 'fail' | null {
  const t = String(text ?? '');
  const m = t.match(/\{[^{}]*"verdict"\s*:\s*"(pass|fail)"[^{}]*\}/i);
  if (m) return m[1].toLowerCase() as 'pass' | 'fail';
  const bare = t.trim().toLowerCase();
  if (/^(pass|fail)\b/.test(bare)) return bare.startsWith('pass') ? 'pass' : 'fail';
  return null;
}

export type JudgeCall = (system: string, user: string) => Promise<{ text: string; costUsd: number }>;

/** Judge every `judge` grader of a case on one outcome; returns verdicts by grader id + the spend. */
export async function judgeOutcome(c: TrajectoryCase, o: TrialOutcome, call: JudgeCall): Promise<{ verdicts: Record<string, 'pass' | 'fail'>; costUsd: number }> {
  const verdicts: Record<string, 'pass' | 'fail'> = {};
  let costUsd = 0;
  for (const g of c.graders) {
    if (g.kind !== 'judge') continue;
    try {
      const r = await call(JUDGE_SYSTEM_PROMPT, judgeUserMessage(c, o, g.rubric));
      costUsd += r.costUsd;
      const v = parseJudgeVerdict(r.text);
      if (v) verdicts[g.id] = v;
    } catch { /* an unanswered judge leaves the check unjudged (skipped), never failed */ }
  }
  return { verdicts, costUsd };
}

// ── calibration file ─────────────────────────────────────────────────────────

export interface JudgeLabelItem {
  /** `<caseId>/<graderId>/<recordingId>` — stable across regenerations. */
  id: string;
  caseId: string;
  graderId: string;
  recordingId: string;
  rubric: string;
  request: string;
  calls: string;
  reply: string;
  /** What the judge said (filled by `npm run eval:trajectory:live` with EVAL_JUDGE_LABELS=1). */
  judgeVerdict: 'pass' | 'fail' | null;
  /** THE OWNER'S label — the only field the owner edits ("pass" | "fail"). */
  ownerLabel: 'pass' | 'fail' | null;
}

export interface JudgeLabelsFile {
  instructions: string;
  items: JudgeLabelItem[];
}

export interface Calibration {
  labelled: number;
  judged: number;
  tp: number; tn: number; fp: number; fn: number;
  tpr: number | null;
  tnr: number | null;
  binding: boolean;
  detail: string;
}

/** Agreement of the judge with the owner over items that carry BOTH labels ("pass" = positive). */
export function computeCalibration(items: JudgeLabelItem[]): Calibration {
  const both = items.filter((i) => i.ownerLabel && i.judgeVerdict);
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const i of both) {
    if (i.ownerLabel === 'pass' && i.judgeVerdict === 'pass') tp += 1;
    else if (i.ownerLabel === 'fail' && i.judgeVerdict === 'fail') tn += 1;
    else if (i.ownerLabel === 'fail' && i.judgeVerdict === 'pass') fp += 1;
    else fn += 1;
  }
  const tpr = tp + fn ? tp / (tp + fn) : null;
  const tnr = tn + fp ? tn / (tn + fp) : null;
  const labelled = items.filter((i) => i.ownerLabel).length;
  const binding = both.length >= JUDGE_MIN_LABELS && tpr != null && tnr != null && tpr >= JUDGE_MIN_RATE && tnr >= JUDGE_MIN_RATE;
  const pct = (x: number | null) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
  const detail = binding
    ? `judge calibrated: TPR ${pct(tpr)} · TNR ${pct(tnr)} on ${both.length} owner labels — judge graders are binding`
    : `judge NOT calibrated (${both.length} items with owner + judge labels, need ≥ ${JUDGE_MIN_LABELS}; TPR ${pct(tpr)} · TNR ${pct(tnr)}, need ≥ ${Math.round(JUDGE_MIN_RATE * 100)}% each) — judge graders are advisory`;
  return { labelled, judged: both.length, tp, tn, fp, fn, tpr, tnr, binding, detail };
}

export function readJudgeLabels(file: string): JudgeLabelsFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(j?.items)) return null;
    return j as JudgeLabelsFile;
  } catch {
    return null;
  }
}

/** True when the shipped labels make the judge binding (no file / too few labels ⇒ advisory). */
export function judgeIsBinding(file: string): boolean {
  const f = readJudgeLabels(file);
  return f ? computeCalibration(f.items).binding : false;
}
