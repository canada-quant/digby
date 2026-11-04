/**
 * Trajectory evals — the judge CALIBRATION set (build 2026-10-08 E-12). Pure.
 *
 * Builds the owner-label items from the cases' judge graders × their frozen
 * recordings (the request, the calls with what each returned, the reply) —
 * statically, from the recording turns and the fixtures, no harness run. The
 * owner fills `ownerLabel` on ≥ 50 items; the live mode fills `judgeVerdict`;
 * judge.ts computeCalibration decides whether judge graders bind.
 */

import { PLATFORM_MUTATING_TOOLS } from '../../platform/platform-tool-names';
import { answerToolCall } from './fixtures';
import { JUDGE_MIN_LABELS, type JudgeLabelItem, type JudgeLabelsFile } from './judge';
import type { Recording, TrajectoryCase } from './types';

const CODING_MUTATING = ['write_file', 'edit_file', 'run_command', 'git_commit', 'git_push', 'open_pull_request', 'merge_pull_request'];
const MUTATING = new Set<string>([...PLATFORM_MUTATING_TOOLS, ...CODING_MUTATING]);

export const LABEL_INSTRUCTIONS = [
  'OWNER LABELS for the trajectory-eval judge (simplify.md step 3).',
  'For each item read `request`, `calls` and `reply`, then set "ownerLabel" to "pass" or "fail" for the item\'s `rubric` — judge only what the rubric asks.',
  `The judge becomes BINDING once ≥ ${JUDGE_MIN_LABELS} items carry both your label and a judge verdict and it agrees with you at TPR ≥ 85 % and TNR ≥ 85 %; until then judge checks are advisory.`,
  'Fill judge verdicts with: EVAL_TRAJECTORY_LIVE=1 EVAL_JUDGE_LABELS=1 EVAL_CASES=none npm run eval:trajectory:live (provider keys required; writes eval-out/judge-labels.judged.json — copy its judgeVerdict values here), or the nightly workflow\'s judge_labels input.',
  'Check the agreement any time: npm run eval:trajectory:calibrate. Regenerate items after editing cases: npm run eval:trajectory:calibrate -- --regen (keeps every label you already set).',
].join(' ');

function clip(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** The calls a recording makes, each with the output the fixtures give it. */
export function staticCallsText(c: TrajectoryCase, rec: Recording): string {
  let seq = 0;
  const lines: string[] = [];
  for (const t of rec.turns) {
    if (t.error) { lines.push(`(provider refused the request: HTTP ${t.error.status})`); continue; }
    for (const tc of t.toolCalls ?? []) {
      seq += 1;
      const args = typeof tc.args === 'string' ? (() => { try { return JSON.parse(tc.args as string); } catch { return {}; } })() : (tc.args ?? {});
      const ans = answerToolCall({ caseId: c.id, fixtures: c.fixtures, tool: tc.name, args, seq, isMutating: (x) => MUTATING.has(x) });
      lines.push(`#${seq} ${tc.name}(${clip(JSON.stringify(args), 300)}) → ${clip(ans.output, 400)}`);
    }
  }
  return lines.length ? lines.join('\n') : '(no tool calls)';
}

export function staticReply(rec: Recording): string {
  const finals = rec.turns.filter((t) => (t.agent ?? 'lead') === 'lead' && !t.error && !(t.toolCalls?.length) && t.content);
  return finals.length ? String(finals[finals.length - 1].content) : '';
}

/** Every (judge grader × recording) candidate, round-robin over cases so a 50-item cut spans the suite. */
export function candidateItems(cases: TrajectoryCase[]): JudgeLabelItem[] {
  const perCase: JudgeLabelItem[][] = cases.map((c) => {
    const judges = c.graders.filter((g) => g.kind === 'judge') as Array<{ id: string; rubric: string }>;
    const frozen = c.recordings.filter((rec) => rec.kind !== 'live');
    // Per grader, alternate the recording order (g1: incident, reference · g2:
    // reference, incident …) and then zip the graders, so a round-robin cut
    // over cases mixes rubrics AND expected verdicts.
    const perGrader: JudgeLabelItem[][] = [];
    judges.forEach((g, gi) => {
      const items: JudgeLabelItem[] = [];
      perGrader.push(items);
      for (const rec of gi % 2 === 0 ? frozen : [...frozen].reverse()) {
        items.push({
          id: `${c.id}/${g.id}/${rec.id}`,
          caseId: c.id,
          graderId: g.id,
          recordingId: rec.id,
          rubric: g.rubric,
          request: clip(c.input.message, 1500),
          calls: staticCallsText(c, rec),
          reply: clip(staticReply(rec), 3000),
          judgeVerdict: null,
          ownerLabel: null,
        });
      }
    });
    const zipped: JudgeLabelItem[] = [];
    for (let i = 0; perGrader.some((l) => i < l.length); i += 1) {
      for (const l of perGrader) if (i < l.length) zipped.push(l[i]);
    }
    return zipped;
  });
  const out: JudgeLabelItem[] = [];
  for (let i = 0; perCase.some((l) => i < l.length); i += 1) {
    for (const l of perCase) if (i < l.length) out.push(l[i]);
  }
  return out;
}

/**
 * Regenerate the label file: the first `size` candidates, carrying over every
 * owner label / judge verdict already recorded for the same item id (an item
 * the owner labelled is always kept, even past the cut).
 */
export function regenerateLabels(cases: TrajectoryCase[], existing: JudgeLabelsFile | null, size = JUDGE_MIN_LABELS): JudgeLabelsFile {
  const prior = new Map((existing?.items ?? []).map((i) => [i.id, i] as const));
  const all = candidateItems(cases);
  const keepLabelled = all.filter((i) => prior.get(i.id)?.ownerLabel);
  const rest = all.filter((i) => !prior.get(i.id)?.ownerLabel);
  const picked = [...keepLabelled, ...rest].slice(0, Math.max(size, keepLabelled.length));
  const items = picked.map((i) => {
    const p = prior.get(i.id);
    return { ...i, judgeVerdict: p?.judgeVerdict ?? null, ownerLabel: p?.ownerLabel ?? null };
  });
  return { instructions: LABEL_INSTRUCTIONS, items };
}
