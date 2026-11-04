/**
 * Trajectory evals — case loading, pass^k aggregation, report rendering
 * (build 2026-10-08 E-9). Pure (fs reads only): used by the jest suites AND
 * the plain CLIs (new-case.ts, calibrate.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseTrajectoryCase, type TrajectoryCase } from './types';
import { passHatK, type TrialGrade, type TrialOutcome } from './graders';

export const EVAL_DIR = __dirname;
export const CASES_DIR = path.join(__dirname, 'cases');
export const JUDGE_LABELS_FILE = path.join(__dirname, 'judge-labels.json');
export const BASELINE_FILE = path.join(__dirname, 'baseline.json');

/** Load + validate every case file (files starting with "_" are templates and skipped). Throws on the first invalid file. */
export function loadCases(dir = CASES_DIR, filter?: string[]): TrajectoryCase[] {
  const r = loadCasesReport(dir, filter);
  if (r.errors.length) throw new Error(r.errors[0].message);
  return r.cases;
}

/** Load every case file, collecting (not throwing) per-file errors — the suite turns each into a failing test. */
export function loadCasesReport(dir = CASES_DIR, filter?: string[]): { cases: TrajectoryCase[]; errors: Array<{ file: string; message: string }> } {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const cases: TrajectoryCase[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const c = parseTrajectoryCase(raw, f);
      if (`${c.id}.json` !== f) throw new Error(`trajectory case ${f}: id "${c.id}" must match the file name`);
      if (filter?.length && !filter.includes(c.id)) continue;
      cases.push(c);
    } catch (err: any) {
      errors.push({ file: f, message: String(err?.message || err) });
    }
  }
  return { cases, errors };
}

/**
 * Live mode without gateway credentials: a `<label>:<model>` seat runs on its
 * family's BUILT-IN model (the GitHub runner holds the provider keys, not the
 * gateway's). A bare built-in id passes through.
 */
export function builtInForSpec(spec: string | undefined | null): string {
  const s = String(spec ?? '').trim();
  if (!s) return 'glm-5.3';
  if (!s.includes(':')) return s;
  const id = s.slice(s.indexOf(':') + 1).toLowerCase();
  if (/glm-?5(\.\d+)?-?flash/.test(id)) return 'glm-5.3-flash';
  if (/glm/.test(id)) return 'glm-5.3';
  if (/kimi|moonshot/.test(id)) return 'kimi-k3';
  if (/deepseek/.test(id)) return 'deepseek-flash';
  if (/qwen.*flash/.test(id)) return 'qwen3.6-flash';
  return 'glm-5.3';
}

/** EVAL_CASES="a,b" → ['a','b']; blank / 'all' → undefined. */
export function caseFilterFromEnv(v = process.env.EVAL_CASES): string[] | undefined {
  const s = (v ?? '').trim();
  if (!s || s === 'all') return undefined;
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export interface TrialRecord {
  outcome: TrialOutcome;
  grade: TrialGrade;
  /** Replay only: the recording's declared grade, and whether today's harness still gives it. */
  expected?: 'pass' | 'fail';
  matchesExpectation?: boolean;
}

export interface CaseResult {
  caseId: string;
  title: string;
  role: string;
  mast?: string[];
  trials: TrialRecord[];
  passHatK: boolean;
  passes: number;
  k: number;
  passAt1: number;
  costUsd: number;
  skipped?: string;
}

export function summarizeCase(c: TrajectoryCase, trials: TrialRecord[], skipped?: string): CaseResult {
  const p = passHatK(trials.map((t) => t.grade));
  return {
    caseId: c.id,
    title: c.title,
    role: c.role,
    mast: c.mast,
    trials,
    passHatK: p.passHatK,
    passes: p.passes,
    k: p.k,
    passAt1: p.passAt1,
    costUsd: trials.reduce((s, t) => s + (t.outcome.costUsd || 0), 0),
    ...(skipped ? { skipped } : {}),
  };
}

export interface SuiteReport {
  mode: 'replay' | 'live';
  startedAt: string;
  finishedAt: string;
  k: number;
  model?: string;
  cases: CaseResult[];
  /** Cases whose every trial passed. */
  passHatKCases: number;
  /** Cases that ran (not skipped). */
  ranCases: number;
  costUsd: number;
  judgeBinding: boolean;
  notes: string[];
}

function cell(s: string): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** The markdown report (CI step summary / artifact). */
export function renderMarkdown(r: SuiteReport): string {
  const lines: string[] = [];
  lines.push(`# Trajectory evals — ${r.mode}${r.model ? ` (${r.model})` : ''}`);
  lines.push('');
  lines.push(`**pass^${r.k}: ${r.passHatKCases} / ${r.ranCases} cases** · cost $${r.costUsd.toFixed(2)} · judge ${r.judgeBinding ? 'calibrated (binding)' : 'not calibrated (advisory)'} · ${r.startedAt} → ${r.finishedAt}`);
  if (r.notes.length) { lines.push(''); for (const n of r.notes) lines.push(`- ${n}`); }
  lines.push('');
  lines.push('| case | role | pass^k | trials | cost | first failing check |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of r.cases) {
    if (c.skipped) { lines.push(`| ${cell(c.caseId)} | ${c.role} | — | skipped | — | ${cell(c.skipped)} |`); continue; }
    const firstFail = c.trials.map((t) => {
      if (t.grade.status === 'diverged') return `diverged: ${t.outcome.diverged}`;
      if (t.grade.status === 'error') return `error: ${t.outcome.error}`;
      const f = t.grade.checks.find((x) => !x.pass && !x.advisory && !x.skipped);
      return f ? `${f.id}: ${f.detail}` : '';
    }).find(Boolean) ?? '';
    const trials = c.trials.map((t) => (t.grade.status === 'pass' ? '✓' : t.grade.status === 'fail' ? '✗' : t.grade.status === 'diverged' ? '↯' : '!')).join('');
    lines.push(`| ${cell(c.caseId)} | ${c.role} | ${c.passHatK ? 'PASS' : 'FAIL'} | ${trials} (${c.passes}/${c.k}) | $${c.costUsd.toFixed(2)} | ${cell(firstFail).slice(0, 220)} |`);
  }
  lines.push('');
  lines.push('✓ pass · ✗ an outcome check failed · ↯ the replay diverged from today\'s harness (re-record) · ! harness error');
  return lines.join('\n');
}

/** Write report.json + report.md into `dir` (created). Returns the paths. */
export function writeReport(dir: string, r: SuiteReport, stem = `${r.mode}-report`): { json: string; md: string } {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, `${stem}.json`);
  const md = path.join(dir, `${stem}.md`);
  const slim = {
    ...r,
    cases: r.cases.map((c) => ({
      ...c,
      trials: c.trials.map((t) => ({
        recordingId: t.outcome.recordingId,
        status: t.grade.status,
        failed: t.grade.failed,
        checks: t.grade.checks,
        expected: t.expected,
        matchesExpectation: t.matchesExpectation,
        model: t.outcome.model,
        modelCalls: t.outcome.modelCalls,
        calls: t.outcome.calls.map((x) => ({ seq: x.seq, tool: x.tool, mutating: x.mutating, source: x.source, args: x.args })),
        finalText: t.outcome.finalText,
        costUsd: t.outcome.costUsd,
        durationMs: t.outcome.durationMs,
        diverged: t.outcome.diverged,
        error: t.outcome.error,
        judge: t.outcome.judge,
      })),
    })),
  };
  fs.writeFileSync(json, JSON.stringify(slim, null, 1));
  fs.writeFileSync(md, renderMarkdown(r));
  return { json, md };
}

// ── baseline gate (simplify.md: pass^3 ≥ baseline − 1 case) ─────────────────

export interface Baseline {
  /** Case ids that passed pass^k in the measured baseline runs. */
  passing: string[];
  /** How many cases the suite may lose before the live run fails (measured noise). */
  noiseCases: number;
  measuredAt?: string;
  note?: string;
}

export function loadBaseline(file = BASELINE_FILE): Baseline | null {
  try {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(b?.passing)) return null;
    return { passing: b.passing.map(String), noiseCases: Number.isFinite(b?.noiseCases) ? Number(b.noiseCases) : 1, measuredAt: b.measuredAt, note: b.note };
  } catch {
    return null;
  }
}

/** Regressions against the baseline: baseline-passing cases that ran and failed pass^k. */
export function baselineVerdict(r: SuiteReport, b: Baseline | null): { ok: boolean; regressed: string[]; detail: string } {
  if (!b || !b.passing.length) return { ok: true, regressed: [], detail: 'no baseline recorded yet — reporting only' };
  const ran = new Map(r.cases.filter((c) => !c.skipped).map((c) => [c.caseId, c]));
  const regressed = b.passing.filter((id) => ran.has(id) && !ran.get(id)!.passHatK);
  const ok = regressed.length <= b.noiseCases;
  return { ok, regressed, detail: `${regressed.length} baseline case(s) regressed (noise allowance ${b.noiseCases})${regressed.length ? `: ${regressed.join(', ')}` : ''}` };
}
