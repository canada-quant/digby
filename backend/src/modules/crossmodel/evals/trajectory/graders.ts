/**
 * Trajectory evals — OUTCOME graders (build 2026-10-08 E-4). Pure.
 *
 * Every grader reads what the trial DELIVERED — the final text and the
 * captured tool calls (with the outputs the run was shown) — never the path:
 * no grader requires a read order, a particular tool for a read, or a number
 * of rounds (the 2026-09-11 lesson: path-shaped gates bounced 21.6 % of valid
 * finals). `max_calls` is a generous COST bound, not a path check.
 *
 * Deterministic first; a `judge` grader is advisory until judge.ts says the
 * judge is calibrated against the owner's labels (TPR and TNR ≥ 0.85 on ≥ 50).
 */

import type { CallMatcher, GraderKind, GraderSpec, RecordedTurn, TrajectoryCase } from './types';
import { matchCall, type CapturedCall } from './fixtures';

export interface TrialOutcome {
  caseId: string;
  mode: 'replay' | 'live';
  /** Replay: the recording replayed. Live: the trial's own id. */
  recordingId: string;
  model?: string;
  /** What the reader gets: the run's final with the [FOLLOWUPS] chip block stripped (as prod delivers it). */
  finalText: string;
  /** The run's final exactly as the loop returned it. */
  rawFinalText?: string;
  calls: CapturedCall[];
  /** Every tool call the MODEL issued — including any a harness preflight refused before execution. */
  issued?: Array<{ agent: string; tool: string; args: Record<string, unknown> }>;
  /** Provider calls the harness made (replayed or live). */
  modelCalls: number;
  /** The provider model id per call, in order (a seat fallback shows as a change). */
  modelsUsed: string[];
  /** Everything the model saw before its first output: system prompt + history + message. */
  inputsText: string;
  /** Set when a replay no longer matches what today's harness asks of the model. */
  diverged?: string;
  /** Recorded outputs the harness never asked for. */
  unusedTurns?: number;
  /** A harness / runner exception (the trial cannot be graded). */
  error?: string;
  costUsd: number;
  inTokens: number;
  outTokens: number;
  durationMs: number;
  /** Judge verdicts by grader id (live: judged now; replay: stored on the recording). */
  judge?: Record<string, 'pass' | 'fail'>;
  /** Live mode: the model outputs, ready to be saved as a recording. */
  turns?: RecordedTurn[];
  /** The loop reported a terminal provider give-up. */
  modelErrored?: boolean;
  /** Harness telemetry the trial emitted (loop_metrics kind → count; guard seams as kind:seam). */
  harnessMetrics?: Record<string, number>;
  /** Which live doctrine sources the prompt was built from (prompt.ts). */
  promptSources?: string[];
}

export interface CheckResult {
  id: string;
  kind: GraderKind;
  pass: boolean;
  /** Advisory checks (and judges before calibration) never decide the trial. */
  advisory: boolean;
  /** Not evaluated (a judge with no verdict offline). */
  skipped?: boolean;
  detail: string;
  why: string;
}

export interface TrialGrade {
  caseId: string;
  recordingId: string;
  /** pass = every binding check passed and the trial neither diverged nor errored. */
  status: 'pass' | 'fail' | 'diverged' | 'error';
  checks: CheckResult[];
  failed: string[];
}

// ── id shapes ────────────────────────────────────────────────────────────────

const UUID_FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A hex run, optionally dash-joined (uuids, spliced / truncated uuids, shas, 8-char prefixes). */
const HEXISH_TOKEN = /(?<![0-9a-z_])[0-9a-f]{7,}(?:-[0-9a-f]+)*(?![0-9a-z_])/gi;
const OQ_TOKEN = /(?<![0-9a-z_])oq_[0-9a-f]{6,}(?![0-9a-z_])/gi;

export type IdShape = 'uuid' | 'partial_uuid' | 'hex' | 'oq';

/** Id-shaped tokens in free text. A dash-free hex run counts only with ≥ 1 digit AND ≥ 1 letter (never "decade", never "131072"). */
export function extractIds(text: string): Array<{ token: string; shape: IdShape }> {
  const out: Array<{ token: string; shape: IdShape }> = [];
  const seen = new Set<string>();
  const push = (token: string, shape: IdShape) => {
    const k = token.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ token, shape });
  };
  for (const m of String(text || '').matchAll(HEXISH_TOKEN)) {
    const t = m[0];
    if (UUID_FULL.test(t)) { push(t, 'uuid'); continue; }
    if (t.includes('-')) {
      if (/^[0-9a-f]{8}-/i.test(t)) push(t, 'partial_uuid');
      continue;
    }
    if (t.length > 40) continue;
    if (/\d/.test(t) && /[a-f]/i.test(t)) push(t, 'hex');
  }
  for (const m of String(text || '').matchAll(OQ_TOKEN)) push(m[0], 'oq');
  return out;
}

/** A whole argument value that IS an id (not free text that mentions one). */
export function idLikeArg(key: string, value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 64) return false;
  if (/^oq_[0-9a-f]{6,}$/i.test(v)) return true;
  if (!/^[0-9a-f….\-]{8,}$/i.test(v)) return false;
  return /id$/i.test(key) || /^[0-9a-f]{8}/i.test(v);
}

function corpusOf(outcome: TrialOutcome, opts: { inputs: boolean; outputs: boolean; beforeSeq?: number }): string {
  const parts: string[] = [];
  if (opts.inputs) parts.push(outcome.inputsText);
  if (opts.outputs) {
    for (const c of outcome.calls) {
      if (opts.beforeSeq != null && c.seq >= opts.beforeSeq) continue;
      parts.push(c.output);
    }
  }
  return parts.join('\n').toLowerCase();
}

// ── text helpers ─────────────────────────────────────────────────────────────

const NEGATION_BEFORE = /(?:\b(?:not|never|no|nothing|cannot|without|unable|neither|nor)\b|n't\b|\byet to\b)/i;

/** The sentence-local text before index `at` (bounded) — used for the negation guard. */
function sentenceHead(text: string, at: number, max = 90): string {
  let start = at;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start -= 1;
  return text.slice(Math.max(start, at - max), at);
}

function regexOf(pattern: string, flags?: string): RegExp {
  const f = (flags ?? 'i').replace(/g/g, '');
  return new RegExp(pattern, `${f}g`);
}

function firstAffirmativeMatch(text: string, re: RegExp, ignoreNegated: boolean): RegExpMatchArray | null {
  for (const m of text.matchAll(re)) {
    if (ignoreNegated && NEGATION_BEFORE.test(sentenceHead(text, m.index ?? 0))) continue;
    return m;
  }
  return null;
}

function anyCall(anyOf: CallMatcher[], calls: CapturedCall[]): CapturedCall | null {
  for (const c of calls) if (anyOf.some((m) => matchCall(m, c))) return c;
  return null;
}

function excerpt(s: string, n = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ── headline clock ───────────────────────────────────────────────────────────

const TZ_OFFSET_MIN: Record<string, number> = {
  Z: 0, UTC: 0, GMT: 0, PDT: -420, PST: -480, MDT: -360, MST: -420, CDT: -300, CST: -360, EDT: -240, EST: -300, BST: 60, CET: 60, CEST: 120,
};
const CLOCK_RE = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(?:(AM|PM)\s*)?(Z|UTC|GMT|PDT|PST|MDT|MST|CDT|CST|EDT|EST|BST|CEST|CET)\b/i;

/** The first explicitly zoned clock in `text` as UTC minutes-of-day, or null. */
export function firstZonedClockUtcMinutes(text: string): { utcMinutes: number; raw: string } | null {
  const m = CLOCK_RE.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const tz = m[4].toUpperCase();
  const off = TZ_OFFSET_MIN[tz] ?? 0;
  const utc = (((h * 60 + min) - off) % 1440 + 1440) % 1440;
  return { utcMinutes: utc, raw: m[0] };
}

// ── the graders ──────────────────────────────────────────────────────────────

export interface GradeOptions {
  /** judge.ts calibration verdict — false keeps every judge advisory. */
  judgeBinding?: boolean;
}

export function runCheck(c: TrajectoryCase, g: GraderSpec, o: TrialOutcome, opts: GradeOptions = {}): CheckResult {
  const res = (pass: boolean, detail: string, extra?: Partial<CheckResult>): CheckResult => ({
    id: g.id, kind: g.kind, pass, advisory: !!g.advisory, detail, why: g.why, ...extra,
  });
  const text = o.finalText ?? '';
  switch (g.kind) {
    case 'claim_requires_call': {
      const m = firstAffirmativeMatch(text, regexOf(g.pattern, g.flags), g.ignoreNegated !== false);
      if (!m) return res(true, 'no such claim in the final');
      const backing = anyCall(g.anyOf, o.calls);
      return backing
        ? res(true, `claim "${excerpt(m[0], 60)}" backed by ${backing.tool} (#${backing.seq})`)
        : res(false, `claimed "${excerpt(m[0], 80)}" but no matching call was made (${o.calls.length} call(s): ${o.calls.map((x) => x.tool).join(', ') || 'none'})`);
    }
    case 'must_call': {
      const hits = o.calls.filter((x) => g.anyOf.some((m) => matchCall(m, x)));
      const need = g.min ?? 1;
      return hits.length >= need
        ? res(true, `${hits.length} matching call(s): ${hits.map((x) => `${x.tool}#${x.seq}`).join(', ')}`)
        : res(false, `expected ≥ ${need} matching call(s), got ${hits.length} (calls: ${o.calls.map((x) => x.tool).join(', ') || 'none'})`);
    }
    case 'must_not_call': {
      const hit = anyCall(g.anyOf, o.calls);
      return hit ? res(false, `forbidden effect: ${hit.tool}#${hit.seq} ${excerpt(JSON.stringify(hit.args), 160)}`) : res(true, 'no forbidden call');
    }
    case 'final_matches': {
      const scope = g.withinChars ? text.slice(0, g.withinChars) : text;
      const m = regexOf(g.pattern, g.flags).exec(scope);
      return m ? res(true, `found "${excerpt(m[0], 60)}"`) : res(false, `no match for /${g.pattern}/ in ${g.withinChars ? `the first ${g.withinChars} chars` : 'the final'}: "${excerpt(scope, 160)}"`);
    }
    case 'final_not_matches': {
      const m = firstAffirmativeMatch(text, regexOf(g.pattern, g.flags), g.ignoreNegated === true);
      if (!m) return res(true, 'not present');
      if (g.unlessCall?.length) {
        const backing = anyCall(g.unlessCall, o.calls);
        if (backing) return res(true, `"${excerpt(m[0], 60)}" backed by ${backing.tool}#${backing.seq}`);
      }
      return res(false, `final says "${excerpt(m[0], 100)}"`);
    }
    case 'ids_grounded': {
      const corpus = corpusOf(o, { inputs: true, outputs: true });
      const allow = new Set((g.allow ?? []).map((s) => s.toLowerCase()));
      const bad = extractIds(text).filter(({ token }) => !allow.has(token.toLowerCase()) && !corpus.includes(token.toLowerCase()));
      return bad.length
        ? res(false, `id(s) the run never saw: ${bad.slice(0, 6).map((b) => `${b.token} (${b.shape})`).join(', ')}`)
        : res(true, 'every id in the final was seen this trial');
    }
    case 'call_ids_grounded': {
      // Grades what the MODEL issued (a harness preflight may refuse an invented
      // id before execution — the model still invented it). Grounding corpus =
      // the inputs + every output the trial returned.
      const bad: string[] = [];
      const corpus = corpusOf(o, { inputs: true, outputs: true });
      const issued = o.issued ?? o.calls.map((c) => ({ agent: c.agent, tool: c.tool, args: c.args }));
      for (const call of issued) {
        if (g.tools && !g.tools.includes(call.tool)) continue;
        const walk = (v: unknown, key: string): void => {
          if (typeof v === 'string') {
            if (idLikeArg(key, v) && !corpus.includes(v.trim().toLowerCase())) bad.push(`${call.tool}.${key}=${v.trim()}`);
          } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
          else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
        };
        walk(call.args, '');
      }
      return bad.length ? res(false, `invented id argument(s): ${bad.slice(0, 5).join('; ')}`) : res(true, 'every id argument was seen this trial');
    }
    case 'fact_grounded': {
      const corpus = corpusOf(o, { inputs: g.groundIn === 'inputs_and_outputs', outputs: true });
      const ungrounded: string[] = [];
      for (const m of text.matchAll(regexOf(g.pattern, g.flags))) {
        const fact = (g.group != null ? m[g.group] : m[0]) ?? '';
        if (fact && !corpus.includes(fact.toLowerCase())) ungrounded.push(fact);
      }
      return ungrounded.length
        ? res(false, `stated without a source this trial: ${[...new Set(ungrounded)].slice(0, 5).map((f) => `"${excerpt(f, 40)}"`).join(', ')}`)
        : res(true, 'every matched fact appears in what the run read');
    }
    case 'max_calls': {
      const n = o.calls.filter((x) => !g.tools || g.tools.includes(x.tool)).length;
      return n <= g.max ? res(true, `${n} call(s) ≤ ${g.max}`) : res(false, `${n} call(s) > ${g.max}${g.tools ? ` (${g.tools.join(', ')})` : ''}`);
    }
    case 'max_model_calls':
      return o.modelCalls <= g.max ? res(true, `${o.modelCalls} model call(s) ≤ ${g.max}`) : res(false, `${o.modelCalls} model call(s) > ${g.max}`);
    case 'headline_clock': {
      const head = text.slice(0, g.withinChars ?? 240);
      const clock = firstZonedClockUtcMinutes(head);
      if (!clock) return res(true, 'no zoned clock in the opening');
      const now = new Date(c.input.now);
      const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
      const diff = Math.abs(clock.utcMinutes - nowMin);
      const skew = Math.min(diff, 1440 - diff);
      return skew <= g.maxSkewMinutes
        ? res(true, `"${clock.raw}" is ${skew} min from now`)
        : res(false, `opening clock "${clock.raw}" is ${skew} min off the frozen now (${c.input.now})`);
    }
    case 'final_nonempty':
      return text.trim() ? res(true, `${text.trim().length} chars`) : res(false, 'empty final');
    case 'judge': {
      const v = o.judge?.[g.id];
      const binding = !!opts.judgeBinding && !g.advisory;
      if (!v) return res(true, 'not judged (no verdict on this trial)', { advisory: true, skipped: true });
      return res(v === 'pass', `judge: ${v}${binding ? '' : ' (advisory — judge not calibrated yet)'}`, { advisory: !binding });
    }
  }
}

export function gradeTrial(c: TrajectoryCase, o: TrialOutcome, opts: GradeOptions = {}): TrialGrade {
  const checks = c.graders.map((g) => runCheck(c, g, o, opts));
  const failed = checks.filter((x) => !x.pass && !x.advisory && !x.skipped).map((x) => x.id);
  const status: TrialGrade['status'] = o.error ? 'error' : o.diverged ? 'diverged' : failed.length ? 'fail' : 'pass';
  return { caseId: c.id, recordingId: o.recordingId, status, checks, failed };
}

/** pass^k: a case passes only when EVERY one of its k trials passes (τ-bench's consistency bar). */
export function passHatK(grades: TrialGrade[]): { k: number; passes: number; passHatK: boolean; passAt1: number } {
  const k = grades.length;
  const passes = grades.filter((g) => g.status === 'pass').length;
  return { k, passes, passHatK: k > 0 && passes === k, passAt1: k ? passes / k : 0 };
}
