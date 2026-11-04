/**
 * Trajectory evals — the suite RUNNER (build 2026-10-08 E-11). JEST ONLY:
 * import ./eval-mocks.testkit before this module.
 *
 * replay (offline, CI, free): every recording of every case is replayed
 *   through today's harness; a case holds when each recording still gets its
 *   declared grade (the incident still fails — the graders catch it; the
 *   reference still passes — they accept valid work; a harness-focus incident
 *   still passes — the fix holds). A recording the harness no longer asks the
 *   same questions of is reported as DIVERGED (re-record it live).
 *
 * live (nightly / workflow_dispatch, real seats, cost-capped): k trials per
 *   case on the real model; pass^k = every trial passes. Judges run when a
 *   judge model is configured; the run stops starting trials at the cost cap.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TrajectoryCase } from './types';
import { gradeTrial, type TrialOutcome } from './graders';
import { runTrial } from './harness.testkit';
import { builtInForSpec, summarizeCase, type CaseResult, type SuiteReport, type TrialRecord } from './suite';
import { judgeOutcome, type JudgeCall } from './judge';

const REPLAY_KEYS = ['ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];

/**
 * Replay needs the built-in seats to look servable (a keyless lead seat fails
 * fast by design) — a placeholder key is set for the run and restored after.
 * Nothing reaches a provider in replay: the provider call is the recording.
 */
async function withReplayKeys<T>(fn: () => Promise<T>): Promise<T> {
  const saved = REPLAY_KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of REPLAY_KEYS) if (!process.env[k]) process.env[k] = 'eval-replay-placeholder';
  const backoff = process.env.AGENT_TRANSIENT_BACKOFF_MS;
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1';
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (backoff === undefined) delete process.env.AGENT_TRANSIENT_BACKOFF_MS; else process.env.AGENT_TRANSIENT_BACKOFF_MS = backoff;
  }
}

export async function runReplaySuite(cases: TrajectoryCase[], opts: { judgeBinding?: boolean } = {}): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = await withReplayKeys(async () => {
    const out: CaseResult[] = [];
    for (const c of cases) {
      const trials: TrialRecord[] = [];
      for (const rec of c.recordings) {
        const outcome = await runTrial(c, { mode: 'replay', recording: rec, trialId: rec.id });
        if (rec.judge) outcome.judge = rec.judge;
        const grade = gradeTrial(c, outcome, { judgeBinding: opts.judgeBinding });
        trials.push({ outcome, grade, expected: rec.expect, matchesExpectation: grade.status === rec.expect });
      }
      const summary = summarizeCase(c, trials);
      // Replay semantics: the case HOLDS when every recording got its declared grade.
      const holds = trials.every((t) => t.matchesExpectation);
      out.push({ ...summary, passHatK: holds, passes: trials.filter((t) => t.matchesExpectation).length, k: trials.length, passAt1: trials.length ? trials.filter((t) => t.matchesExpectation).length / trials.length : 0 });
    }
    return out;
  });
  return {
    mode: 'replay',
    startedAt,
    finishedAt: new Date().toISOString(),
    k: 1,
    cases: results,
    passHatKCases: results.filter((r) => r.passHatK).length,
    ranCases: results.length,
    costUsd: 0,
    judgeBinding: !!opts.judgeBinding,
    notes: ['replay: a case holds when every recording gets its declared grade (incident → fail, reference → pass; harness-focus incident → pass)'],
  };
}

export interface LiveOptions {
  k: number;
  maxUsd: number;
  concurrency: number;
  trialTimeoutMs: number;
  effort: 'high' | 'max';
  /** Global model override (EVAL_MODEL); else the role's EVAL_SEATS entry; else the case's seat (a gateway seat mapped to its family built-in without EVAL_GATEWAY_*). */
  model?: string;
  seatOverrides?: Record<string, string>;
  gateway?: { baseUrl: string; apiKey: string } | null;
  judge?: JudgeCall | null;
  judgeBinding?: boolean;
  /** Write each case's live trials as recordings (JSON) here. */
  recordDir?: string;
  /** Tests only: stands in for the provider (see TrialOptions.liveModelOverride). */
  liveModelOverride?: (...args: any[]) => Promise<any>;
  log?: (line: string) => void;
}

export function liveSeatFor(c: TrajectoryCase, opts: Pick<LiveOptions, 'model' | 'seatOverrides' | 'gateway'>): string {
  if (opts.model) return opts.model;
  const byRole = opts.seatOverrides?.[c.role];
  if (byRole) return byRole;
  const spec = c.seat?.model || 'glm-5.3';
  return spec.includes(':') && !opts.gateway ? builtInForSpec(spec) : spec;
}

export async function runLiveSuite(cases: TrajectoryCase[], opts: LiveOptions): Promise<SuiteReport> {
  const startedAt = new Date().toISOString();
  const log = opts.log ?? (() => {});
  let spent = 0;
  const capped = () => spent >= opts.maxUsd;
  const perCase = new Map<string, TrialRecord[]>();
  const skippedCases = new Map<string, string>();
  const cappedCount = (m: Map<string, string>) => [...m.values()].filter((v) => v.startsWith('cost cap')).length;
  const tasks: Array<{ c: TrajectoryCase; n: number }> = [];
  for (const c of cases) {
    // A harness-focus case freezes a PROVIDER behaviour (a content-filter refusal …) that a live
    // seat will not reproduce on demand — it is graded by the replay only.
    if (c.focus === 'harness') { skippedCases.set(c.id, 'harness-focus case — graded by the offline replay only'); continue; }
    for (let n = 1; n <= opts.k; n += 1) tasks.push({ c, n });
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const { c, n } = tasks[next++];
      if (capped()) { skippedCases.set(c.id, `cost cap $${opts.maxUsd} reached`); continue; }
      const model = liveSeatFor(c, opts);
      const trialId = `live-${startedAt.slice(0, 10)}-${model.replace(/[^a-z0-9.]+/gi, '_')}-k${n}`;
      const outcome: TrialOutcome = await runTrial(c, {
        mode: 'live', model, trialId, timeoutMs: opts.trialTimeoutMs, effort: opts.effort, stopRequested: capped, gateway: opts.gateway,
        ...(opts.liveModelOverride ? { liveModelOverride: opts.liveModelOverride } : {}),
      });
      if (opts.judge && !outcome.error) {
        const j = await judgeOutcome(c, outcome, opts.judge);
        if (Object.keys(j.verdicts).length) outcome.judge = j.verdicts;
        outcome.costUsd += j.costUsd;
      }
      spent += outcome.costUsd;
      const grade = gradeTrial(c, outcome, { judgeBinding: opts.judgeBinding });
      log(`[trajectory-eval] ${c.id} k${n} ${model}: ${grade.status}${grade.failed.length ? ` (${grade.failed.join(', ')})` : ''} · $${outcome.costUsd.toFixed(3)} · ${Math.round(outcome.durationMs / 1000)}s · spent $${spent.toFixed(2)}`);
      if (!perCase.has(c.id)) perCase.set(c.id, []);
      perCase.get(c.id)!.push({ outcome, grade });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));

  const results: CaseResult[] = cases.map((c) => {
    const trials = perCase.get(c.id) ?? [];
    const partial = trials.length < opts.k;
    return summarizeCase(c, trials, trials.length === 0 ? (skippedCases.get(c.id) ?? 'not run') : partial ? `only ${trials.length}/${opts.k} trials ran (${skippedCases.get(c.id) ?? 'stopped'})` : undefined);
  }).map((r) => (r.skipped && r.trials.length ? { ...r, passHatK: false } : r));

  if (opts.recordDir) {
    fs.mkdirSync(opts.recordDir, { recursive: true });
    for (const r of results) {
      if (!r.trials.length) continue;
      const recs = r.trials.map((t) => ({
        id: t.outcome.recordingId,
        kind: 'live',
        expect: t.grade.status === 'pass' ? 'pass' : 'fail',
        model: t.outcome.model,
        note: `live ${t.outcome.recordingId}: ${t.grade.status}${t.grade.failed.length ? ` (${t.grade.failed.join(', ')})` : ''}`,
        turns: t.outcome.turns ?? [],
        ...(t.outcome.judge ? { judge: t.outcome.judge } : {}),
      })).filter((x) => x.turns.length);
      fs.writeFileSync(path.join(opts.recordDir, `${r.caseId}.recordings.json`), JSON.stringify(recs, null, 1));
    }
  }

  return {
    mode: 'live',
    startedAt,
    finishedAt: new Date().toISOString(),
    k: opts.k,
    model: opts.model,
    cases: results,
    // A case counts only when all k trials ran (a cost-capped partial case is reported, never scored).
    passHatKCases: results.filter((r) => !r.skipped && r.passHatK).length,
    ranCases: results.filter((r) => !r.skipped).length,
    costUsd: spent,
    judgeBinding: !!opts.judgeBinding,
    notes: [
      `effort ${opts.effort === 'max' ? 'max (prod machine-wake effort)' : 'capped at high (cost / time — EVAL_EFFORT=max for prod effort)'}`,
      opts.gateway ? 'gateway seats ran on the gateway' : 'gateway seats mapped to their family built-in (no EVAL_GATEWAY_* set)',
      ...(cappedCount(skippedCases) ? [`${cappedCount(skippedCases)} case(s) hit the $${opts.maxUsd} cost cap`] : []),
    ],
  };
}

/** Parse a "role=model,role=model" seat list (EVAL_SEATS). */
export function parseSeatOverrides(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(v ?? '').split(',')) {
    const [k, ...rest] = part.split('=');
    const model = rest.join('=').trim();
    if (k?.trim() && model) out[k.trim()] = model;
  }
  return out;
}

function numEnv(v: string | undefined, dflt: number, min: number, max: number): number {
  if (v == null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

/**
 * Live-run options from the environment (the nightly workflow sets these from
 * its inputs). Runner configuration — none of these is a product switch.
 */
export function liveOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<LiveOptions, 'judge' | 'log'> & { judgeModel: string | null; reportDir: string } {
  const gatewayUrl = (env.EVAL_GATEWAY_BASE_URL ?? '').trim();
  const gatewayKey = (env.EVAL_GATEWAY_API_KEY ?? '').trim();
  const judgeModel = (env.EVAL_JUDGE_MODEL ?? 'deepseek-flash').trim();
  const reportDir = (env.EVAL_REPORT_DIR ?? '').trim() || path.resolve(process.cwd(), 'eval-out');
  return {
    k: numEnv(env.EVAL_K, 3, 1, 10),
    maxUsd: numEnv(env.EVAL_MAX_USD, 10, 0, 500),
    concurrency: numEnv(env.EVAL_CONCURRENCY, 4, 1, 16),
    trialTimeoutMs: numEnv(env.EVAL_TRIAL_TIMEOUT_MS, 15 * 60_000, 30_000, 60 * 60_000),
    effort: env.EVAL_EFFORT === 'max' ? 'max' : 'high',
    ...(env.EVAL_MODEL?.trim() ? { model: env.EVAL_MODEL.trim() } : {}),
    seatOverrides: parseSeatOverrides(env.EVAL_SEATS),
    gateway: gatewayUrl && gatewayKey ? { baseUrl: gatewayUrl, apiKey: gatewayKey } : null,
    judgeModel: judgeModel && judgeModel !== 'off' ? judgeModel : null,
    reportDir,
    recordDir: path.join(reportDir, 'recordings'),
  };
}

/**
 * The live judge: one non-tool call on a built-in seat (outside any trial, so
 * the real provider call runs). Priced with the spend meter's own table.
 */
export function makeLiveJudge(model: string): JudgeCall {
  return async (system: string, user: string) => {
    const cm = require('../../coding/coding-model');
    const { turnCostUsd } = require('../../coding/cost');
    const provider = await cm.resolveProviderForRun(model, undefined, { fastSeat: true });
    const r = await cm.runModelTurn(provider, [{ role: 'system', content: system }, { role: 'user', content: user }], undefined, {}, 120_000);
    const usage = r?.usage
      ? { promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, ...(r.usage.cachedTokens ? { cachedTokens: r.usage.cachedTokens } : {}), estimated: false }
      : { promptTokens: Math.ceil((system.length + user.length) / 4), completionTokens: Math.ceil(String(r?.content ?? '').length / 4), estimated: true };
    return { text: String(r?.content ?? ''), costUsd: turnCostUsd(String(provider.model), usage) };
  };
}
