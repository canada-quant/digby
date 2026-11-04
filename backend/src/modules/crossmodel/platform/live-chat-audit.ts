/**
 * LIVE-CHAT AUDIT — the nightly hardening pass over REAL human chats (2026-10-04).
 *
 * Owner ask (2026-10-04): "add hardening and decision code and framework tweaks hardening ran against real live
 * user chats as part of the nightly auto framework". The live query suite (scripts/e2e/query-suite.py) proved the
 * shape on synthetic questions — its first run found a double answer and a false verifier correction no unit test
 * had — and this job runs the same checks every night over the last 24 h of REAL human turns:
 *
 *   1. SIGNALS (deterministic, every human answer row): turn-plan lane / act, first-token + completion time by lane,
 *      lead errors, empty answers, hand-back closings (chat-agent/handback-detector.ts), Dig-deeper taps (and on
 *      Quick answers), thumbs down, check state; plus two transcript checks — a user row answered by more than one
 *      ordinary assistant row (the orphan-sweeper race fixed 2026-10-04) and action-verifier corrections posted on
 *      plain chats.
 *   2. DECISION REPLAY (a sample, default 30): the day's turns re-asked to the turn_plan decision (memo off, segment
 *      'replay' — a NON-HUMAN partition the readiness ruler never pools with human rows; no outcome rows) →
 *      agreement with the lane the live turn recorded (drift); and a reasoning JUDGE (the Utility seat with thinking
 *      on, default 20) → would-Quick precision and research turns routed too shallow.
 *   3. REGRESSIONS vs the previous 7 nights' rows → ONE deduplicated framework ticket per signal (stable title =
 *      the dedupe identity; feedback.service's drain hands it to the framework lane), never message text — only
 *      counts and chat ids. The summary rides loop_metrics `live_chat_audit` and the owner briefing line.
 *
 * Privacy: message text is read only inside the backend by the platform's own decision + utility seats (the same
 * models that answered it); tickets / rows / logs carry aggregates and ids, never content.
 * Kill switches: LIVE_CHAT_AUDIT_DISABLED=1 (the whole job), LIVE_CHAT_AUDIT_TICKETS_DISABLED=1 (report only),
 * LIVE_CHAT_AUDIT_REPLAY_SAMPLE / LIVE_CHAT_AUDIT_JUDGE_SAMPLE (0 = that leg off), and — ticket 3ff96116 —
 * LIVE_CHAT_AUDIT_QUALITY_REPEATS (default 3 = median-of-K scoring; 1 restores the pre-3ff96116 single shot).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric } from './loop-metrics.service';
import { MODEL_BENCH_ACCOUNT_EMAIL, MODEL_BENCH_TITLE_PREFIX } from './model-bench-scorecard';
import { backendSpecOfRow } from './decision-gate-fit';
import { turnPlanFromMetadata } from '../chat-agent/turn-plan-labels';
// Self-host setup hardening (2026-10-20): on an instance with no search backend the
// honest "I can't search the web on this instance" is correct, never a refusal signal.
import { webSearchMissingOnInstance } from './instance-setup';

export const LIVE_CHAT_AUDIT_JOB_ID = 'live-chat-audit';
export const LIVE_CHAT_AUDIT_INTERVAL_SEC = 86_400;
export const LIVE_CHAT_AUDIT_WINDOW_MS = 24 * 60 * 60_000;
export const LIVE_CHAT_AUDIT_MAX_ROWS = 2000;
export const LIVE_CHAT_AUDIT_KIND = 'live_chat_audit';
/** The decision segment replayed asks are stamped with — partitioned away from the human READY sample. */
export const REPLAY_SEGMENT = 'replay';
export const LIVE_CHAT_AUDIT_TICKET_PREFIX = '[live-chat audit]';
const SOURCE = 'live-chat-audit';
export const SIDE_KINDS = new Set(['deeper_findings', 'continuation_result', 'deliverable_handoff', 'control_note', 'check_addendum', 'council_addendum']);
const LANES = ['quick', 'standard', 'checked', 'research'] as const;
type Lane = typeof LANES[number];

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
const onFlag = (v: unknown) => ['1', 'true', 'on'].includes(String(v ?? '').trim().toLowerCase());

export function liveChatAuditDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return onFlag(env.LIVE_CHAT_AUDIT_DISABLED);
}
export function liveChatAuditTicketsDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return onFlag(env.LIVE_CHAT_AUDIT_TICKETS_DISABLED);
}
/** A sample-size env: blank / garbage = the default; clamped 0..max. Pure. */
export function sampleFromEnv(raw: string | undefined, fallback: number, max = 200): number {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : fallback;
}

/**
 * Ticket 3ff96116: how many times the quality judge scores each sampled answer (median-of-K). The judge's
 * run-to-run spread on the same (message, answer) measured 3 on the 1..5 scale (2,5,2,4 across four runs),
 * so a single sample counted answers "low" on noise. Default 3 (the median of three); 1 restores the
 * pre-3ff96116 single-shot; clamp 1..9. Kill switch = the same value at 1 (no extra cost when disabled).
 */
export const LIVE_CHAT_AUDIT_QUALITY_REPEATS_ENV = 'LIVE_CHAT_AUDIT_QUALITY_REPEATS';
export function qualityRepeatsFromEnv(raw: string | undefined, fallback = 3): number {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(1, Math.min(9, n)) : fallback;
}

// ── signals (pure) ───────────────────────────────────────────────────────────

export interface AuditAnswerRow {
  id: string;
  chatId: string;
  createdAt: Date;
  content: string;
  parts?: unknown;
  metadata: unknown;
  /** message_feedback types on this row ('thumbs_down' | 'thumbs_up' | 'report'). */
  feedback?: string[];
}

export interface TurnSignals {
  lane: Lane | null;
  acted: boolean;
  ranQuick: boolean;
  preset: string | null;
  ttftMs: number | null;
  completionMs: number | null;
  error: boolean;
  empty: boolean;
  handback: boolean;
  /** Internal text leaked into the delivered answer (a tool call / reasoning tag / harness marker). */
  leak: boolean;
  /** A refusal / "I can't browse" disclaimer on an answer (the chat has live web tools). */
  refusal: boolean;
  escalated: boolean;
  thumbsDown: boolean;
  check: string | null;
  /** The lead-effort A/B arm the turn ran in (metadata.ux.effortArm, 2026-10-04), null outside the A/B. */
  effortArm: 'high' | 'max' | null;
}

/** Internal text that must never reach a user — the suite's LEAK_RE twin (scripts/e2e/query-suite.py). */
export const ANSWER_LEAK_RE = /<think>|<\/think>|\[FOLLOWUPS|<\|tool|<function=|\bDSML\b|\[MACHINE-TRIGGERED|\[HARNESS |"name"\s*:\s*"(?:search_engine|scrape_as_markdown|web_pipe|create_document|generate_image)"/i;
/** A refusal / false capability disclaimer — the suite's REFUSAL_RE twin. */
export const ANSWER_REFUSAL_RE = /\b(?:I can(?:no|['’])t|I am unable to|I['’]m unable to|I (?:do not|don['’]t) have (?:the ability|access) to)\b[^.\n]{0,40}\b(?:browse|access the internet|search the web|real-time|look (?:that|this) up|help with that)|\bas an AI(?: language model)?\b/i;
/** The non-web half of ANSWER_REFUSAL_RE — still a refusal on an instance where "I can't search the web" is honest (self-host 2026-10-20). */
export const ANSWER_REFUSAL_GENERIC_RE = /\b(?:I can(?:no|['’])t|I am unable to|I['’]m unable to|I (?:do not|don['’]t) have (?:the ability|access) to)\b[^.\n]{0,40}\bhelp with that|\bas an AI(?: language model)?\b/i;

/** One human answer row → its signals. `handback` is injected (the detector is a separate leaf). Pure. */
export function turnSignals(
  row: AuditAnswerRow,
  isHandback: (text: string, parts: unknown) => boolean = () => false,
  opts: { /** false on an instance with no search backend — a web-search disclaimer is then honest, not a refusal. */ webSearchConfigured?: boolean } = {},
): TurnSignals {
  const md = asRecord(row.metadata);
  const depth = asRecord(md.depth);
  const tp = asRecord(depth.turnPlan);
  const plan = asRecord(depth.plan);
  const ux = asRecord(md.ux);
  const lead = asRecord(asRecord(md.models).digby);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const content = typeof row.content === 'string' ? row.content : '';
  return {
    lane: (LANES as readonly string[]).includes(String(tp.lane)) ? tp.lane as Lane : null,
    acted: tp.act === true,
    ranQuick: plan.lane === 'quick',
    preset: typeof plan.preset === 'string' ? plan.preset : null,
    ttftMs: num(ux.ttftMs),
    completionMs: num(ux.completionMs),
    error: typeof lead.error === 'string' && lead.error.length > 0,
    empty: !content.trim(),
    handback: content.trim() ? isHandback(content, row.parts) : false,
    leak: ANSWER_LEAK_RE.test(content),
    refusal: opts.webSearchConfigured === false ? ANSWER_REFUSAL_GENERIC_RE.test(content) : ANSWER_REFUSAL_RE.test(content),
    escalated: Array.isArray(depth.escalations) && depth.escalations.length > 0,
    thumbsDown: (row.feedback ?? []).includes('thumbs_down'),
    check: typeof asRecord(md.check).state === 'string' ? String(asRecord(md.check).state) : null,
    effortArm: ux.effortArm === 'high' || ux.effortArm === 'max' ? ux.effortArm : null,
  };
}

/**
 * Machine-authored CARD rows that are never a human turn's answer — the hourly
 * per-session status card (origin/kind 'session_status', session-status.service.ts),
 * the project card ('project_status') and the owner briefing ('owner_briefing').
 * Same class as fleet/supervisor-reply-row.ts MACHINE_NOTE_KINDS, restated here
 * because a card stamped `origin:'user'` by the dual-write path must not count
 * as an answer anywhere in the audit (ticket 0f208004).
 */
export const CARD_NOTE_KINDS = new Set(['session_status', 'project_status', 'owner_briefing']);

/** Whether an assistant row is a HUMAN answer the audit counts (pure): not a side row / card / machine origin / verifier note. */
export function isAuditableAnswer(metadata: unknown): boolean {
  const md = asRecord(metadata);
  if (md.verifier) return false;
  if (md.origin && md.origin !== 'user') return false;
  if (SIDE_KINDS.has(String(md.kind ?? ''))) return false;
  // Ticket 0f208004: a coding session's hourly status card stamps kind 'session_status' —
  // never a human answer (the KIND is the reliable stamp; origin was already checked above).
  if (CARD_NOTE_KINDS.has(String(md.kind ?? ''))) return false;
  return true;
}

export function percentile(xs: number[], q: number): number | null {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
}

export interface ReplayResult { recorded: Lane | null; replayed: Lane | null; judge: Lane | null; acted: boolean; preset: string | null;
  /** The shadow trait-adjusted lane the live turn recorded (turn-plan.ts ruleAdjustedLane, 2026-10-04), when present. */
  ruleLane?: Lane | null;
  /**
   * Ticket 4c3f2a5c (2026-10-24, turn_plan_drift decomposition): attribution fields so a
   * disagreement names its CAUSE instead of a bare "< 85 %". `liveBackend` = the backend spec the
   * LIVE ask answered through (the answer row's metadata.depth.turnPlan.backend, when the plan
   * recorded one); `replayBackend` = what the replay ask answered through. A disagreement where
   * these differ is BACKEND DRIFT (a swap / calibration change between the live turn and the
   * replay — the real signal); a disagreement where they match is a state or model behaviour gap.
   * `hadDecision` = the recorded lane came from an actual classifier answer (a decisionId on the
   * plan row); false ⇒ the live ask failed/timed out and the recorded lane is the PRESET FALLBACK
   * — not a classification, so the agreement ratio excludes it (counted as nFallback instead).
   */
  liveBackend?: string | null; replayBackend?: string | null; hadDecision?: boolean;
  /**
   * Ticket f2e34408 (2026-11-02): the turn plan's OWN calibration verdict, read off the answer row
   * (metadata.depth.turnPlan.stash.calibrated). `false` ⇒ usableTurnPlan() (lane-depth.ts) REFUSES the
   * classification, so the research router cannot dispatch Level 3 however confidently the lane
   * probabilities read. This is what separates "the routing rule is wrong" from "the router was never
   * allowed to answer" — the two causes the bare researchUnderRouted count smears together.
   */
  calibrated?: boolean | null }

/** One answer-quality judgement (2026-10-04): score 1..5 + an issue CATEGORY (never text — rows / tickets carry no content). */
export interface QualityResult { score: number | null; issue: QualityIssue }

/** Ticket 3ff96116 (2026-10-09): the context the judge needs to score the answer the USER actually received —
 *  the user message's ATTACHMENTS (image pixels the judge cannot see; persisted on the user row's metadata.attachments,
 *  chat-agent.service.ts attachmentMeta) and the turn's SIDE-ROW text (deeper_findings / continuation_result /
 *  deliverable_handoff … — the continuation the same turn delivered after the answer row). Without these the judge
 *  scored attachment turns 'incorrect' 4/4 blind (5/none informed) and never saw a turn's real deliverable. */
export interface JudgeContext { images?: number; documents?: number; sideRowText?: string; webToolCalls?: number }

/**
 * Ticket 3ff96116 (recurrence, 2026-10-14): the web tools whose calls count as a turn's GROUNDING —
 * the twin of chat-agent.service.ts's private WEB_GROUNDING_TOOLS (the audit cannot import the service
 * without pulling its whole side-effect graph, so the set is mirrored here; the twin test below pins
 * the two sets against drift). Counted from the answer row's OWN `parts`, the same source the
 * chat_search_usage metric counts — no extra read, nothing inferred from text.
 */
export const WEB_GROUNDING_TOOL_NAMES = new Set(['search_engine', 'scrape_as_markdown', 'browser_task', 'web_pipe']);
/** Count of web-grounding tool calls in an answer row's parts (pure; bad input → 0). */
export function countWebGroundingCalls(parts: unknown): number {
  return Array.isArray(parts)
    ? parts.filter((p: any) => p?.type === 'tool_call' && WEB_GROUNDING_TOOL_NAMES.has(String(p?.name))).length
    : 0;
}
export const QUALITY_ISSUES = ['none', 'incomplete', 'incorrect', 'ungrounded', 'unclear', 'refused', 'off_topic'] as const;
export type QualityIssue = typeof QUALITY_ISSUES[number];

export interface AuditSummary {
  windowHours: number;
  turns: number;
  laneMix: Record<string, number>;
  acted: number;
  ranQuick: number;
  quickTapped: number;
  ttft: Record<string, { n: number; p50: number | null; p90: number | null }>;
  completionP50: number | null;
  errors: number;
  empty: number;
  handbacks: number;
  leaks: number;
  refusals: number;
  /** Answer-quality judge over a sample: mean 1..5, low (≤ 2) count, issue histogram. */
  quality?: { n: number; mean: number | null; low: number; issues: Record<string, number> };
  escalations: number;
  thumbsDown: number;
  checks: Record<string, number>;
  duplicateAnswers: number;
  verifierCorrections: number;
  /**
   * audit 2026-10-08 W4-7: first-word time over EVERY human turn of the window — the ux_ttft rows, so guests and owner
   * turns on supervisor chats count too (the answer-row population above excludes both). The absolute latency gate
   * (detectRegressions `ttft_absolute`) reads it.
   */
  humanTtft?: HumanTtft;
  /** Lead-effort A/B readout (2026-10-04): first-token / completion p50, Dig-deeper taps and thumbs down per arm. */
  effortArms: Record<string, { n: number; ttftP50: number | null; doneP50: number | null; escalated: number; thumbsDown: number }>;
  /**
   * Ticket f2e34408: what the research ROUTER did with the asks it was obliged to answer — the defect this split
   * exists to surface (uncalibrated turn plans make it answer `no_answer` and discard its own classification).
   * Absent when no `lane_research` telemetry was read this pass.
   */
  router?: RouterHealth;
  replay: { n: number; agree: number; judged: number; judgeAgree: number; quickActedJudgedDeeper: number; researchUnderRouted: number;
    /** Judged turns that carried a ruleLane; of those, how often the judge agreed with the RULE vs with the argmax (recorded) lane. */
    ruleJudged?: number; ruleJudgeAgree?: number; argmaxJudgeAgreeOnRuled?: number; ruleChanged?: number;
    /** Ticket 4c3f2a5c: turns excluded from n/agree because the live ask failed and the recorded lane
     *  is the PRESET FALLBACK (no decisionId) — not a classification; and disagreements where the live
     *  ask's backend differs from the replay's (backend swap / calibration change — the real drift). */
    nFallback?: number; backendDrift?: number;
    /**
     * Ticket f2e34408: `researchUnderRouted` split by WHY the turn ran below Level 3 — the turn plan was stamped
     * uncalibrated (usableTurnPlan refuses it, so the router could never dispatch Level 3) vs it carried a usable
     * classification and still ran below Level 3. Only the second group is a routing question.
     */
    researchUnderRoutedWhy?: { uncalibrated: number; routerNotAsked: number };
    /** Ticket f2e34408: how many replayed turns carried an UNCALIBRATED turn plan (usableTurnPlan refuses those). */
    uncalibrated?: number };
}

export interface HumanTtft { n: number; p50: number | null; p90: number | null; noChunk: number; guests: number; supervisor: number; slowest: string[] }
/** One ux_ttft row as the audit reads it. */
export interface TtftRow { sessionId: string | null; value: number | null; guest?: boolean | null; supervisor?: boolean | null; noChunk?: boolean | null }

/** ux_ttft rows → the window's first-word distribution (pure). `slowest` = up to 5 chat ids over the p90 bar, slowest first. */
export function humanTtftFromRows(rows: readonly TtftRow[], p90BarMs: number = ttftBars().p90Ms): HumanTtft {
  const vals: number[] = [];
  let noChunk = 0;
  for (const r of rows) {
    const v = r.value === null || r.value === undefined ? NaN : Number(r.value);
    if (r.noChunk || !Number.isFinite(v)) { noChunk += 1; continue; }
    vals.push(v);
  }
  const slowest = rows
    .filter((r) => r.sessionId && !String(r.sessionId).startsWith('anon-') && Number.isFinite(Number(r.value)) && Number(r.value) > p90BarMs)
    .sort((a, b) => Number(b.value) - Number(a.value)).map((r) => String(r.sessionId)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 5);
  return {
    n: vals.length, p50: percentile(vals, 0.5), p90: percentile(vals, 0.9), noChunk,
    guests: rows.filter((r) => r.guest === true).length, supervisor: rows.filter((r) => r.supervisor === true).length, slowest,
  };
}

/**
 * The absolute first-word bars (audit 2026-10-08 W4-7). The relative per-lane check needs n ≥ 10 per lane and 3
 * baseline nights — on 10-08 (13 turns split 6/4/2) it could not fire while the real p50 was 88 s and a third of
 * turns took over 2 min. The bars are a chat-UX target (a first word within a minute for the median turn), set so the
 * measured 2026-10-08 state breaks them: 24 h read-only, 66 real human turns (30 guest, 19 supervisor-chat), first
 * word p50 86 s / p90 278 s. Env (blank = default): LIVE_CHAT_AUDIT_TTFT_P50_MS (60 000), LIVE_CHAT_AUDIT_TTFT_P90_MS
 * (240 000), LIVE_CHAT_AUDIT_TTFT_MIN_N (5). Kill switch LIVE_CHAT_AUDIT_TTFT_GATE_DISABLED=1.
 */
export const TTFT_GATE_DEFAULTS = Object.freeze({ p50Ms: 60_000, p90Ms: 240_000, minN: 5 });
export function ttftBars(env: Record<string, string | undefined> = process.env): { p50Ms: number; p90Ms: number; minN: number } {
  const num = (raw: string | undefined, d: number) => { const n = Number(raw); return raw !== undefined && String(raw).trim() !== '' && Number.isFinite(n) && n > 0 ? n : d; };
  return { p50Ms: num(env.LIVE_CHAT_AUDIT_TTFT_P50_MS, TTFT_GATE_DEFAULTS.p50Ms), p90Ms: num(env.LIVE_CHAT_AUDIT_TTFT_P90_MS, TTFT_GATE_DEFAULTS.p90Ms), minN: Math.floor(num(env.LIVE_CHAT_AUDIT_TTFT_MIN_N, TTFT_GATE_DEFAULTS.minN)) };
}
export function ttftGateDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.LIVE_CHAT_AUDIT_TTFT_GATE_DISABLED); }

// ── research-router health (ticket f2e34408, 2026-11-02) ─────────────────────

/**
 * What the research router did with the asks it was GIVEN (ticket f2e34408).
 *
 * WHY THIS EXISTS: the audit's `researchUnderRouted` counts "a judge said research, the turn ran below Level 3"
 * as ONE number. Reproducing it on production (2026-11-02, 24 h: researchUnderRouted 3) showed those 3 had two
 * completely different causes, and neither was the routing RULE:
 *
 *   · the router was ASKED and answered `no_answer` ("unusable turn plan — the router's level stands") because
 *     `usableTurnPlan()` (lane-depth.ts:317) refuses a turn plan stamped `stash.calibrated === false` — 25 of the
 *     29 turn plans that window were uncalibrated, so 24 of its 31 ALLOWED asks (77 %) were wasted: it paid for a
 *     classification and threw it away;
 *   · the router was never asked at all (`acts.research` false for the sender ⇒ no `lane_research` row).
 *
 * Neither is a rule defect — `ruleAdjustedLane` fired on 0 of 20 judged turns and `turn-plan.ts:279` says
 * verbatim that NOTHING routes on it yet. Counting them as "under-routed" therefore pointed the next session at
 * the wrong lever. This summarizer reads the router's OWN `lane_research` telemetry rows and splits its asks by
 * what it answered, so the audit reports a router-USABILITY defect as one and a mis-route as another.
 */
export interface RouterAskRow {
  route: 'research' | 'denied' | 'kept' | 'no_answer' | 'not_governed' | 'keyword_retired' | string;
  /** The sender's Level-3 allowance verdict for this send (false ⇒ correctly never asked). */
  allowance?: boolean | null;
  /** The route's own reason string (recorded verbatim by lane-depth.ts). */
  why?: string | null;
}

export interface RouterHealth {
  /** Every `lane_research` row in the window. */
  n: number;
  byRoute: Record<string, number>;
  /**
   * The asks that actually cost something: `allowance !== false` — a sender who may get Level 3, so the router
   * was obliged to answer. A `denied` row carries allowance false and is CORRECT work, not waste.
   */
  eligible: number;
  /** Of the eligible asks, how many came back `no_answer` (the router could not use its own classification). */
  noAnswer: number;
  /** noAnswer / eligible, 0 when nothing was eligible. The wasted-work rate. */
  noAnswerRate: number;
  /** Eligible asks split by the recorded `why` prefix — names the guard (`unusable turn plan`, `timed out`, …). */
  noAnswerWhy: Record<string, number>;
  /** Level-3 routes actually taken (research + keyword_retired). */
  routed: number;
}

/** `lane_research` rows → the router's health (pure). Rows carry only what lane-depth.ts records. */
export function routerHealthFromRows(rows: readonly RouterAskRow[]): RouterHealth {
  const byRoute: Record<string, number> = {};
  const noAnswerWhy: Record<string, number> = {};
  let eligible = 0; let noAnswer = 0; let routed = 0;
  for (const r of rows) {
    const route = String(r.route ?? 'unknown');
    byRoute[route] = (byRoute[route] ?? 0) + 1;
    if (r.allowance === false) continue; // correctly never asked — a guest / quota denial is not router waste
    eligible += 1;
    if (route === 'no_answer') {
      noAnswer += 1;
      // Keep only the leading clause: the recorded reasons are "unusable turn plan — the router's level stands",
      // "turn plan timed out — …", "no turn plan — …", "error". One bucket per guard, no ids, no free text.
      const why = String(r.why ?? 'unspecified').split('—')[0].trim().slice(0, 80) || 'unspecified';
      noAnswerWhy[why] = (noAnswerWhy[why] ?? 0) + 1;
    }
    if (route === 'research' || route === 'keyword_retired') routed += 1;
  }
  return { n: rows.length, byRoute, eligible, noAnswer, noAnswerRate: eligible ? noAnswer / eligible : 0, noAnswerWhy, routed };
}

/**
 * The router-usability bar: fires when a large share of the asks the router was OBLIGED to answer came back
 * unusable. Set so the measured 2026-11-02 state (24 of 31 eligible = 77 %) breaks it with room, while a healthy
 * night (a handful of timeouts) never does.
 *
 * DELIBERATELY NOT env-tunable: a gate that only PROPOSES a ticket is already governed end-to-end by the audit's
 * existing switches — LIVE_CHAT_AUDIT_DISABLED (no pass at all) and LIVE_CHAT_AUDIT_TICKETS_DISABLED (detect, file
 * nothing). Adding a third knob for one threshold would grow the switch registry (and the RSW-1 expiry wall) for
 * no operational gain. If a night ever needs a different bar, tune these constants here.
 */
export const ROUTER_GATE_BARS: Readonly<{ noAnswerRate: number; minEligible: number }> = Object.freeze({ noAnswerRate: 0.5, minEligible: 10 });

/** Signals + transcript counts + replay results → the night's summary (pure). */
export function summarizeAudit(signals: TurnSignals[], extra: { duplicateAnswers: number; verifierCorrections: number; replays: ReplayResult[]; windowHours?: number; quality?: QualityResult[]; humanTtft?: HumanTtft | null; router?: RouterHealth | null }): AuditSummary {
  const laneMix: Record<string, number> = {};
  const ttftByKey: Record<string, number[]> = {};
  const checks: Record<string, number> = {};
  for (const s of signals) {
    const key = s.ranQuick ? 'quick-ran' : (s.lane ?? 'none');
    laneMix[s.lane ?? 'none'] = (laneMix[s.lane ?? 'none'] ?? 0) + 1;
    if (s.ttftMs !== null) (ttftByKey[key] = ttftByKey[key] ?? []).push(s.ttftMs);
    if (s.check) checks[s.check] = (checks[s.check] ?? 0) + 1;
  }
  const ttft: AuditSummary['ttft'] = {};
  for (const [k, xs] of Object.entries(ttftByKey)) ttft[k] = { n: xs.length, p50: percentile(xs, 0.5), p90: percentile(xs, 0.9) };
  const r = extra.replays;
  const judged = r.filter((x) => x.judge);
  const deeper = (l: Lane | null) => l === 'checked' || l === 'research';
  // Ticket 4c3f2a5c: the agreement RATIO counts only turns whose recorded lane came from an actual
  // classifier answer (a decisionId on the plan row). A turn whose live ask failed/timed out
  // recorded the PRESET FALLBACK lane — replaying a fallback is not a comparison of decisions, and
  // counting it drags the ratio toward a false "drift" (prod probe 1ca1a5af: 1/30 rows). Such turns
  // are counted separately as replay.nFallback so the briefing can name the real rate. Legacy
  // replays rows (no hadDecision field) count as classified — the pre-4c3f2a5c behaviour.
  const comparable = r.filter((x) => x.recorded && x.replayed && x.hadDecision !== false);
  return {
    windowHours: extra.windowHours ?? 24,
    turns: signals.length,
    laneMix,
    acted: signals.filter((s) => s.acted).length,
    ranQuick: signals.filter((s) => s.ranQuick).length,
    quickTapped: signals.filter((s) => s.ranQuick && s.escalated).length,
    ttft,
    completionP50: percentile(signals.map((s) => s.completionMs ?? NaN), 0.5),
    errors: signals.filter((s) => s.error).length,
    empty: signals.filter((s) => s.empty).length,
    handbacks: signals.filter((s) => s.handback).length,
    leaks: signals.filter((s) => s.leak).length,
    refusals: signals.filter((s) => s.refusal).length,
    ...((): { quality?: AuditSummary['quality'] } => {
      const q = (extra.quality ?? []).filter((x) => typeof x.score === 'number');
      if (!q.length) return {};
      const issues: Record<string, number> = {};
      for (const x of q) if (x.issue !== 'none') issues[x.issue] = (issues[x.issue] ?? 0) + 1;
      const mean = q.reduce((a, x) => a + (x.score as number), 0) / q.length;
      return { quality: { n: q.length, mean: Math.round(mean * 100) / 100, low: q.filter((x) => (x.score as number) <= 2).length, issues } };
    })(),
    escalations: signals.filter((s) => s.escalated).length,
    thumbsDown: signals.filter((s) => s.thumbsDown).length,
    checks,
    duplicateAnswers: extra.duplicateAnswers,
    verifierCorrections: extra.verifierCorrections,
    ...(extra.humanTtft ? { humanTtft: extra.humanTtft } : {}),
    effortArms: Object.fromEntries((['high', 'max'] as const).map((arm) => {
      const xs = signals.filter((s) => s.effortArm === arm);
      return [arm, { n: xs.length, ttftP50: percentile(xs.map((s) => s.ttftMs ?? NaN), 0.5), doneP50: percentile(xs.map((s) => s.completionMs ?? NaN), 0.5), escalated: xs.filter((s) => s.escalated).length, thumbsDown: xs.filter((s) => s.thumbsDown).length }];
    }).filter(([, v]) => (v as { n: number }).n > 0)),
    replay: {
      n: comparable.length,
      agree: comparable.filter((x) => x.recorded === x.replayed).length,
      nFallback: r.filter((x) => x.recorded && x.replayed && x.hadDecision === false).length,
      backendDrift: r.filter((x) => x.recorded && x.replayed && x.recorded !== x.replayed
        && !!x.liveBackend && !!x.replayBackend && x.liveBackend !== x.replayBackend).length,
      judged: judged.length,
      judgeAgree: judged.filter((x) => x.recorded === x.judge).length,
      quickActedJudgedDeeper: judged.filter((x) => x.acted && deeper(x.judge)).length,
      researchUnderRouted: judged.filter((x) => x.judge === 'research' && x.preset !== 'deep_research').length,
      ...(() => {
        // Ticket f2e34408: split the under-routed count by CAUSE. An uncalibrated turn plan is REFUSED by
        // usableTurnPlan(), so the research router could never dispatch Level 3 on it however confident the lane
        // probabilities read — counting that as a routing miss pointed the next session at the (inert) rule.
        // `routerNotAsked` is the remainder: the plan was calibrated and still ran below Level 3, i.e. the one
        // shape that IS a genuine routing question.
        const ur = judged.filter((x) => x.judge === 'research' && x.preset !== 'deep_research');
        const uncal = ur.filter((x) => x.calibrated === false).length;
        return ur.length ? { researchUnderRoutedWhy: { uncalibrated: uncal, routerNotAsked: ur.length - uncal } } : {};
      })(),
      ...(() => {
        const uncal = judged.filter((x) => x.calibrated === false).length;
        return uncal ? { uncalibrated: uncal } : {};
      })(),
      ...(() => {
        const ruled = judged.filter((x) => x.ruleLane);
        return ruled.length ? {
          ruleJudged: ruled.length,
          ruleJudgeAgree: ruled.filter((x) => x.ruleLane === x.judge).length,
          argmaxJudgeAgreeOnRuled: ruled.filter((x) => x.recorded === x.judge).length,
          ruleChanged: ruled.filter((x) => x.ruleLane !== x.recorded).length,
        } : {};
      })(),
    },
    ...(extra.router ? { router: extra.router } : {}),
  };
}

/**
 * The ticket type of a regression (audit 2026-10-08 W4-3): it MUST be one of feedback.service FEEDBACK_TYPES — the
 * audit used to send `type:'bug'`, fileFeedbackTicket rejected it ("Invalid type \"bug\""), and no bug-class
 * regression was EVER filed while the briefing reported "⚠ 2 regression ticket(s)". Pinned by
 * live-chat-audit.test.ts against FEEDBACK_TYPES.
 */
export type RegressionTicketType = 'bug_report' | 'enhancement';
export interface Regression { signal: string; title: string; priority: number; type: RegressionTicketType; detail: string }

const median = (xs: number[]) => percentile(xs, 0.5);

/**
 * Tonight's summary vs the previous nights' → the regressions worth a framework ticket (pure).
 * Stable titles (the feedback dedupe identity): one open ticket per signal, re-sighted nightly while it persists.
 */
export function detectRegressions(cur: AuditSummary, baseline: AuditSummary[]): Regression[] {
  const out: Regression[] = [];
  const t = (s: string) => `${LIVE_CHAT_AUDIT_TICKET_PREFIX} ${s}`;
  if (cur.duplicateAnswers >= 1) {
    out.push({ signal: 'duplicate_answers', type: 'bug_report', priority: 2, title: t('a question was answered twice'),
      // 0f208004 (2026-10-09): the two sighted chats were ONE real answer + the hourly
      // session_status card; the sub-select is allow-listed since (origin 'user' OR a
      // depth stamp — machine notices never enter). A sighting from here on is a
      // genuine re-fire path, not a card or any other machine notice.
      detail: `${cur.duplicateAnswers} user message(s) in the last ${cur.windowHours} h got more than one ordinary assistant answer (only origin-'user'/depth-stamped answer rows counted — machine notices, side rows and status cards excluded). Known cause fixed 2026-10-04: the orphan sweeper's Rule-B snapshot race (chat-agent/orphan-recovery.ts rowStillLatest) — a recurrence means another re-fire path.` });
  }
  if (cur.verifierCorrections >= 3) {
    out.push({ signal: 'verifier_corrections', type: 'bug_report', priority: 2, title: t('action-verifier phantom convictions on plain chats'),
      detail: `${cur.verifierCorrections} plain chat(s) drew an action-verifier phantom conviction in ${cur.windowHours} h (a "Phantom action claim" / "Phantom evidence citation" mishap ticket touched, or — under ACTION_VERIFIER_ENFORCE=1 — a posted correction row). Read the tickets: an honest failure report or a mis-kinded claim is a verifier false positive (platform/action-verifier.ts); a real phantom is a doctrine / model problem.` });
  }
  const errRate = cur.turns ? cur.errors / cur.turns : 0;
  const baseErr = median(baseline.filter((b) => b.turns > 0).map((b) => b.errors / b.turns)) ?? 0;
  if (cur.errors >= 3 && errRate > Math.max(0.05, 2 * baseErr)) {
    out.push({ signal: 'lead_errors', type: 'bug_report', priority: 2, title: t('chat answers failing on the lead seat'),
      detail: `${cur.errors} of ${cur.turns} human answers carried a lead-seat error (${(errRate * 100).toFixed(1)} % vs a ${(baseErr * 100).toFixed(1)} % baseline). Check seat_fallback rows and the chat_orchestrator / chat_quick seats.` });
  }
  if (cur.empty >= 3) {
    out.push({ signal: 'empty_answers', type: 'bug_report', priority: 2, title: t('empty answers delivered'),
      detail: `${cur.empty} human answers were persisted with no text in ${cur.windowHours} h.` });
  }
  if (cur.leaks >= 1) {
    out.push({ signal: 'answer_leaks', type: 'bug_report', priority: 2, title: t('internal text leaked into answers'),
      detail: `${cur.leaks} delivered answer(s) in ${cur.windowHours} h carried internal text (a tool-call fragment, a reasoning tag or a harness marker — ANSWER_LEAK_RE). Read the chats: a model leaked its scaffolding, or a stripping step missed a shape.` });
  }
  if (cur.refusals >= 3) {
    out.push({ signal: 'answer_refusals', type: 'enhancement', priority: 3, title: t('benign asks refused or disclaimed'),
      detail: `${cur.refusals} answers in ${cur.windowHours} h refused or disclaimed ("I can't browse" — the chat has live web tools). Check the doctrine / the lead model's tool use.` });
  }
  if (cur.quality && cur.quality.n >= 10 && (cur.quality.low >= 3 || (cur.quality.mean !== null && cur.quality.mean < 3.5))) {
    out.push({ signal: 'answer_quality', type: 'bug_report', priority: 2, title: t('answer quality below the bar'),
      detail: `A reasoning judge scored ${cur.quality.n} sampled real answers: mean ${cur.quality.mean}/5, ${cur.quality.low} scored ≤ 2. Issues: ${Object.entries(cur.quality.issues).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'}. Read the low-scored chats.` });
  }
  if (cur.handbacks >= 3) {
    out.push({ signal: 'handbacks', type: 'enhancement', priority: 3, title: t('answers handing requested work back to the user'),
      detail: `${cur.handbacks} answers closed with a hand-back phrase (chat-agent/handback-detector.ts) — the task.lifecycle rule says DONE / RUNNING / STAGED-for-external only.` });
  }
  for (const [lane, cur50] of Object.entries(cur.ttft)) {
    const base = baseline.map((b) => b.ttft?.[lane]).filter((x): x is { n: number; p50: number | null; p90: number | null } => !!x && x.n >= 5 && x.p50 !== null);
    const b50 = median(base.map((x) => x.p50 as number));
    if (cur50.n >= 10 && cur50.p50 !== null && base.length >= 3 && b50 && cur50.p50 > 1.5 * b50) {
      out.push({ signal: `ttft_${lane}`, type: 'bug_report', priority: 3, title: t(`first-token time regressed (${lane})`),
        detail: `${lane}: first-token p50 ${(cur50.p50 / 1000).toFixed(1)} s over ${cur50.n} turns vs a ${(b50 / 1000).toFixed(1)} s baseline (${base.length} nights).` });
    }
  }
  // audit 2026-10-08 W4-7: the ABSOLUTE first-word gate over every human turn (guests + supervisor chats included).
  const h = cur.humanTtft;
  const bars = ttftBars();
  if (h && !ttftGateDisabled() && h.n >= bars.minN && ((h.p50 ?? 0) > bars.p50Ms || (h.p90 ?? 0) > bars.p90Ms)) {
    const sec = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(0)} s`);
    out.push({ signal: 'ttft_absolute', type: 'bug_report', priority: 2, title: t('first-word latency over the bar'),
      detail: `Time to the first answer word over ALL ${h.n} human turns in ${cur.windowHours} h (guests ${h.guests}, supervisor-chat turns ${h.supervisor}; ${h.noChunk} with no answer): p50 ${sec(h.p50)} (bar ${sec(bars.p50Ms)}), p90 ${sec(h.p90)} (bar ${sec(bars.p90Ms)}). Per-lane p50: ${Object.entries(cur.ttft).map(([k, v]) => `${k} ${sec(v.p50)} (n ${v.n})`).join(', ') || 'n/a'}. Read the slowest chats (ids below): lead seat / model pick (turn_plan modelPick), web-call count (ux_ttft webToolCalls), the lane budget, provider latency.` });
  }
  if (cur.ranQuick >= 10 && cur.quickTapped / cur.ranQuick > 0.2) {
    out.push({ signal: 'quick_tapped', type: 'enhancement', priority: 3, title: t('Quick-lane answers being dug deeper'),
      detail: `${cur.quickTapped} of ${cur.ranQuick} Quick-lane answers got a Dig-deeper tap (> 20 %). Tighten platform/quick-lane-guards.ts or the Quick seat.` });
  }
  // Ticket 4c3f2a5c: the gate fires below the 85 % bar, with TWO floors — the REPLAYED SAMPLE
  // (classified + fallback rows) must still be ≥ 10 (the old code compared every replayed row,
  // so a fallback-dominated window must not silently silence the gate: a window where ≥ 21 of 30
  // live asks failed is itself worth a ticket), and at least 3 CLASSIFIED rows (a 1–2-row ratio
  // is not evidence). The ratio itself is over classified rows only — a preset fallback lane is
  // not a classification.
  const replaySample = cur.replay.n + (cur.replay.nFallback || 0);
  if (replaySample >= 10 && cur.replay.n >= 3 && cur.replay.agree / cur.replay.n < 0.85) {
    const fallbackNote = cur.replay.nFallback ? ` ${cur.replay.nFallback} further turn(s) replayed a PRESET FALLBACK lane (the live ask failed — no decision row) and are excluded from the ratio.` : '';
    const backendNote = cur.replay.backendDrift ? ` ${cur.replay.backendDrift} of the disagreements are BACKEND DRIFT (the live ask's backend differs from today's — a swap or calibration change; read the decision-gate readiness readout).` : '';
    out.push({ signal: 'turn_plan_drift', type: 'enhancement', priority: 3, title: t('turn_plan replay disagrees with the live decisions'),
      detail: `Replayed ${cur.replay.n} of the day's turns: the lane matched the live decision on ${cur.replay.agree} (< 85 %).${backendNote}${fallbackNote} The replay re-asks with the live-faithful state (previous_answer_lane, true turn count, attachments); a remaining gap with matching backends is model behaviour drift — read the decision-gate readiness readout.` });
  }
  if (cur.replay.quickActedJudgedDeeper >= 2) {
    out.push({ signal: 'quick_judged_deeper', type: 'bug_report', priority: 2, title: t('Quick lane took turns a judge rates checked / research'),
      detail: `${cur.replay.quickActedJudgedDeeper} acted Quick turns were rated checked / research by the reasoning judge (of ${cur.replay.judged} judged).` });
  }
  if (cur.replay.researchUnderRouted >= 3) {
    // Ticket f2e34408: name the CAUSE, not just the count. The reproduced 2026-11-02 window had all 3 under-routed
    // turns explained by the router having no usable classification (uncalibrated plans), NOT by a routing miss —
    // the bare count alone sent the next session at the (inert) rule.
    const why = cur.replay.researchUnderRoutedWhy;
    const split = why
      ? ` Of those, ${why.uncalibrated} ran on an UNCALIBRATED turn plan (usableTurnPlan refuses it, so the router could never dispatch Level 3) and ${why.routerNotAsked} ran below Level 3 with a usable classification — only that second group is a routing question.`
      : '';
    out.push({ signal: 'research_under_routed', type: 'enhancement', priority: 3, title: t('research-worthy turns answered without the council'),
      detail: `${cur.replay.researchUnderRouted} judged turns read "research" but ran below Level 3.${split} Input for the research-routing phase (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md) — but check the router row first: an uncalibrated classifier is an INPUT defect, not a routing-rule defect (ruleAdjustedLane is shadow and routes nothing).` });
  }
  // Ticket f2e34408: the gate the bare under-routed count was standing in for. The research router is asked and
  // cannot use its own answer — the measured 2026-11-02 state was 24 of its 31 ALLOWED asks (77 %), every one of
  // them because the turn plan was uncalibrated. This is a router-INPUT defect and had no gate of its own.
  const rb = ROUTER_GATE_BARS;
  if (cur.router && cur.router.eligible >= rb.minEligible && cur.router.noAnswerRate >= rb.noAnswerRate) {
    out.push({ signal: 'research_router_unusable', type: 'enhancement', priority: 3, title: t('research router asked and unable to answer'),
      detail: `${cur.router.noAnswer} of the ${cur.router.eligible} asks the research router was OBLIGED to answer came back unusable (${Math.round(cur.router.noAnswerRate * 100)} %; ${cur.router.n} lane_research rows, route mix ${Object.entries(cur.router.byRoute).map(([k, v]) => `${k} ${v}`).join(', ')}; reasons ${Object.entries(cur.router.noAnswerWhy).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'}). The router pays for a turn-plan classification and then DISCARDS it — at this rate the research lane can effectively never be reached. Read the reason mix: "unusable turn plan" = the plan was stamped uncalibrated (usableTurnPlan, lane-depth.ts) and the fix is classifier calibration, NOT the routing rule; "timed out" / "no turn plan" = provider latency or an ask that never landed.` });
  }
  return out;
}

/**
 * What happened to the night's regression tickets (audit 2026-10-08 W4-3): the briefing counts only tickets that were
 * actually FILED — a detected signal whose filing failed is named as such, never as a ticket.
 */
export interface AuditFiling { filed: string[]; disabled?: boolean }
export function briefingFiledOnlyDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return onFlag(env.LIVE_CHAT_AUDIT_BRIEFING_FILED_ONLY_DISABLED);
}
/** The regression tail of the briefing line (pure). */
export function regressionBriefingTail(regressions: string[], filing?: AuditFiling | null): string {
  if (!regressions.length) return ' · no regressions';
  if (briefingFiledOnlyDisabled()) return ` · ⚠ ${regressions.length} regression ticket(s): ${regressions.join(', ')}`;
  const head = ` · ⚠ ${regressions.length} regression(s) detected: ${regressions.join(', ')}`;
  if (!filing) return head;
  if (filing.disabled) return `${head} (tickets off — LIVE_CHAT_AUDIT_TICKETS_DISABLED)`;
  const filed = regressions.filter((r) => filing.filed.includes(r));
  const failed = regressions.filter((r) => !filing.filed.includes(r));
  return `${head} — ${filed.length ? `${filed.length} ticket(s) filed: ${filed.join(', ')}` : 'no ticket filed'}${failed.length ? `; filing FAILED: ${failed.join(', ')}` : ''}`;
}

/** The owner-briefing line for a summary (pure). `filing` = what the pass actually filed (absent ⇒ detected only). */
export function auditBriefingLine(s: AuditSummary | null, regressions: string[] = [], filing?: AuditFiling | null): string | null {
  if (!s || !s.turns) return null;
  const quick = s.ttft['quick-ran'];
  const rest = Object.entries(s.ttft).filter(([k]) => k !== 'quick-ran').flatMap(([, v]) => (v.p50 !== null ? [v.p50] : []));
  const parts = [
    `${s.turns} human turns`,
    s.ranQuick ? `Quick lane ${s.ranQuick}${quick?.p50 ? ` (first token p50 ${(quick.p50 / 1000).toFixed(0)} s)` : ''}` : null,
    rest.length ? `other lanes p50 ${(Math.round((median(rest) ?? 0) / 1000))} s` : null,
    s.humanTtft?.n ? `first word (all ${s.humanTtft.n} human turns) p50 ${Math.round((s.humanTtft.p50 ?? 0) / 1000)} s / p90 ${Math.round((s.humanTtft.p90 ?? 0) / 1000)} s` : null,
    s.replay.n ? `replay agreement ${Math.round((100 * s.replay.agree) / s.replay.n)} %` : null,
    s.replay.backendDrift ? `backend drift ${s.replay.backendDrift}` : null,
    s.replay.nFallback ? `${s.replay.nFallback} fallback-lane turn(s) excluded` : null,
    s.replay.ruleJudged && s.replay.ruleChanged
      ? `lane rule vs judge ${s.replay.ruleJudgeAgree}/${s.replay.ruleJudged} (argmax ${s.replay.argmaxJudgeAgreeOnRuled}/${s.replay.ruleJudged}; rule moved ${s.replay.ruleChanged})`
      : null,
    s.effortArms?.high?.n && s.effortArms?.max?.n && s.effortArms.high.ttftP50 !== null && s.effortArms.max.ttftP50 !== null
      ? `effort A/B first token high ${Math.round(s.effortArms.high.ttftP50 / 1000)} s (n ${s.effortArms.high.n}) vs max ${Math.round(s.effortArms.max.ttftP50 / 1000)} s (n ${s.effortArms.max.n})`
      : null,
    s.quality?.n ? `answer quality ${s.quality.mean}/5 (n ${s.quality.n}, ${s.quality.low} low)` : null,
    s.leaks ? `${s.leaks} leaked answers` : null,
    s.refusals ? `${s.refusals} refusals` : null,
    s.errors ? `${s.errors} errors` : null,
    s.duplicateAnswers ? `${s.duplicateAnswers} double answers` : null,
    s.verifierCorrections ? `${s.verifierCorrections} chats with verifier convictions` : null,
  ].filter(Boolean);
  return `Live-chat audit (last ${s.windowHours} h): ${parts.join(' · ')}${regressionBriefingTail(regressions, filing)}`;
}

// ── judge (pure parts) ───────────────────────────────────────────────────────

export const JUDGE_RUBRIC = [
  'You decide how much compute a chat message deserves. Lanes, cheapest first:',
  'quick — one FAST model with one or two web searches answers it as well as a top model would: weather, time, a score, a price, a definition, a conversion, a simple factual or how-to question. Choose quick only when a stronger model would NOT meaningfully improve the answer.',
  'standard — one strong model answering alone: explanations, writing, summaries, brainstorming, simple code, conversation, follow-ups that need the context of the chat.',
  'checked — a second independent model should check the answer: contested / political / historically disputed points, health / legal / financial advice, tricky multi-step reasoning or numbers, facts that are easy to get wrong.',
  'research — depth across many sources: a report, a history or analysis of a broad topic with several perspectives, a comparison across many options, an explicit research request.',
  'Think briefly, then end your reply with exactly one line: LANE: quick | standard | checked | research',
].join('\n');

export const QUALITY_RUBRIC = [
  'You review ONE assistant answer to ONE user message. Score how well it serves the user, 1..5:',
  '5 = complete, correct, clear, grounded where it matters; 4 = good, minor gaps; 3 = acceptable but missing something the user needed;',
  '2 = significant gap, error or unclear; 1 = wrong, off-topic, refused a reasonable ask, or empty.',
  'Judge: did it answer EVERY part of the message; is it factually right as far as you can tell; for time-sensitive facts does it show it looked them up (cites a source / date) instead of guessing; is it clear and the right length; does it ask a needed clarifying question only when the message is genuinely ambiguous.',
  'End with exactly two lines:',
  'SCORE: <1-5>',
  `ISSUE: <one of ${QUALITY_ISSUES.join(' | ')}>`,
].join('\n');

/** Score + issue from the quality judge's reply (the LAST lines win; unknown issue → 'none' when the score ≥ 4 else 'unclear'). Pure. */
export function parseQuality(text: string): QualityResult {
  const t = String(text || '');
  const sm = t.match(/SCORE:\s*([1-5])/gi);
  const score = sm && sm.length ? Number(sm[sm.length - 1].replace(/\D/g, '')) : null;
  const im = t.toLowerCase().match(/issue:\s*([a-z_]+)/g);
  const raw = im && im.length ? im[im.length - 1].replace(/issue:\s*/, '') : '';
  const issue = (QUALITY_ISSUES as readonly string[]).includes(raw) ? raw as QualityIssue : (score !== null && score >= 4 ? 'none' : 'unclear');
  return { score, issue };
}

/** The judge's lane from its reply (the LAST "LANE: x" line wins). Pure. */
export function parseJudgeLane(text: string): Lane | null {
  const m = String(text || '').toLowerCase().match(/lane:\s*(quick|standard|checked|research)/g);
  if (!m || !m.length) return null;
  return m[m.length - 1].replace(/lane:\s*/, '') as Lane;
}

// ── the job ──────────────────────────────────────────────────────────────────

interface Deps {
  now?: Date;
  /** Injected for tests; default = the production decide() + utilityChat + fileFeedbackTicket.
   *  Ticket 4c3f2a5c: the third arg carries the live-faithful state (priorLane / true turnIndex /
   *  attachments / the live ask's backend) — a test double may ignore it (the legacy 2-arg shape).
   *  The return may be a plain lane (legacy) or { lane, backend } — the record form carries what
   *  the replay ask itself answered through, for backend-drift attribution. */
  replayLane?: (message: string, priorUserTurns: string[], state?: ReplayTurnState) => Promise<Lane | null | { lane: Lane | null; backend?: string | null }>;
  judgeLane?: (message: string, priorUserTurns: string[]) => Promise<Lane | null>;
  /** Ticket 3ff96116: the judge context (attachments + same-turn side rows) rides the 4th arg; the bench's
   *  3-arg shape still works (ctx defaults to {}). */
  qualityJudge?: (message: string, answer: string, priorUserTurns: string[], ctx?: JudgeContext) => Promise<QualityResult | null>;
  fileTicket?: (r: Regression, summary: AuditSummary, chatIds: string[]) => Promise<string | null>;
}

/** Ticket 4c3f2a5c: what a replayLane result actually says — a lane, or a lane + the backend the replay ask
 *  answered through. Legacy returns (a bare lane, null) keep their meaning. Pure. */
export function replayLaneResult(r: Lane | null | { lane: Lane | null; backend?: string | null }): { lane: Lane | null; backend: string | null } {
  if (r && typeof r === 'object') return { lane: (LANES as readonly string[]).includes(String((r as { lane: unknown }).lane)) ? (r as { lane: Lane }).lane : null, backend: typeof (r as { backend?: unknown }).backend === 'string' && (r as { backend: string }).backend ? (r as { backend: string }).backend : null };
  return { lane: (LANES as readonly string[]).includes(String(r)) ? r as Lane : null, backend: null };
}

/**
 * Ticket 4c3f2a5c (2026-10-24): the live-faithful state the replay must send — the fields
 * chat-agent.service.ts passed the LIVE ask that the old replay dropped. Measured on prod
 * (probe 4c3f2a5c, runId 1ca1a5af, 30 turns): replaying the live state lifted agreement
 * 23/30 → 26/30; the missing `previous_answer_lane` and the wrong `turn_in_chat` (true 21 vs
 * replayed 2) were the largest state-gap causes of FALSE drift. Absent (undefined) ⇒ the
 * legacy shape (images 0, documents 0, turnIndex = priorUserTurns.length, no priorLane) —
 * the 3-arg replayLane test shape keeps working.
 */
export interface ReplayTurnState {
  /** The lane the PREVIOUS answer's plan recorded — `previous_answer_lane` on the ask state. */
  priorLane?: Lane | null;
  /** The TRUE count of user messages before this turn's question (not the ≤2 prior window). */
  turnIndex?: number;
  /** Attachments on the question row, as the live site counted them. */
  images?: number;
  documents?: number;
  /** The backend spec the live ask answered through (metadata.depth.turnPlan.backend). */
  liveBackend?: string | null;
}

async function defaultReplayLane(message: string, priorUserTurns: string[], state?: ReplayTurnState): Promise<{ lane: Lane | null; backend: string | null }> {
  const [{ decide }, tp] = await Promise.all([import('./decision-gate'), import('./turn-plan')]);
  const res = await decide(
    tp.turnPlanState({
      message, priorUserTurns,
      images: state?.images ?? 0, documents: state?.documents ?? 0,
      ...(state?.priorLane ? { priorLane: state.priorLane } : {}),
      turnIndex: state?.turnIndex ?? priorUserTurns.length,
    }),
    tp.turnPlanQuestions(priorUserTurns.length > 0),
    { purpose: 'turn_plan', timeoutMs: 4000, sessionId: `replay:${SOURCE}`, memo: false, segment: REPLAY_SEGMENT, challengers: false },
  ).catch(() => null);
  const cls = res ? tp.classFromAnswers(res.answers) : null;
  return { lane: (cls?.lane as Lane | undefined) ?? null, backend: res?.backendSpec ?? res?.backend ?? null };
}

/**
 * The minimum-sufficient-lane judge (the Utility seat with thinking on, JUDGE_RUBRIC: "the CHEAPEST lane a stronger
 * lane would not meaningfully improve"). Exported (roster 2026-10-06 A-1) for scripts/framework-audit/replay-min-lane.js —
 * the offline Standard-vs-Checked / research calibration reads EXACTLY the nightly audit's judge. Message-only, so its
 * label does not depend on which lane actually ran (counterfactual-valid).
 */
export async function defaultJudgeLane(message: string, priorUserTurns: string[]): Promise<Lane | null> {
  const { utilityChat } = await import('../../../utils/utility-llm');
  const raw = await utilityChat([
    { role: 'system', content: JUDGE_RUBRIC },
    ...(priorUserTurns.length ? [{ role: 'user', content: `Earlier messages in this chat (context only):\n${priorUserTurns.map((x) => `- ${x.slice(0, 300)}`).join('\n')}` }] : []),
    { role: 'user', content: `Message to route:\n${message.slice(0, 4000)}` },
  ], { maxTokens: 4000, temperature: 0.1, timeout: 90_000, thinking: true }).catch(() => '');
  return parseJudgeLane(raw);
}

/**
 * The production answer-quality judge: the Utility seat with thinking on, QUALITY_RUBRIC, parsed by parseQuality.
 * Exported (2026-10-04) for the offline model bench (scripts/framework-audit/model-bench-ingest.js) so a benchmarked
 * answer is scored with EXACTLY the nightly audit's judge. An empty answer scores 1 without a call; a judge failure → null.
 *
 * Ticket 3ff96116 (2026-10-09): the optional `ctx` carries the facts the judge was BLIND to and mis-scored on
 * attachment turns — `images`/`documents` (the user message's attachments; the judge sees text only, so a preamble
 * says so instead of letting it call references to image content "incorrect": prod 16ad8c5a scored 1 'incorrect'
 * 4/4 blind, 5/none informed) and `sideRowText` (the continuation the SAME turn delivered after this answer row —
 * deeper_findings / deliverable_handoff / continuation_result … — part of what the user received; prod 7ff994b6's
 * real deliverable was an 896-char handoff row the judge never saw). Absent ctx = the pre-3ff96116 call shape,
 * unchanged for the bench.
 */
export async function defaultQualityJudge(message: string, answer: string, priorUserTurns: string[] = [], ctx: JudgeContext = {}): Promise<QualityResult | null> {
  if (!answer.trim()) return { score: 1, issue: 'off_topic' };
  const { utilityChat } = await import('../../../utils/utility-llm');
  const ctxNote = qualityJudgeContextNote(ctx);
  const sideRow = ctx.sideRowText?.trim() ? `\n\n[continuation of the same turn, delivered to the user as a side note]\n${ctx.sideRowText.trim().slice(0, 3000)}` : '';
  const raw = await utilityChat([
    { role: 'system', content: QUALITY_RUBRIC },
    ...(priorUserTurns.length ? [{ role: 'user', content: `Earlier messages in this chat (context only):\n${priorUserTurns.map((x) => `- ${x.slice(0, 300)}`).join('\n')}` }] : []),
    { role: 'user', content: ctxNote + `USER MESSAGE:\n${message.slice(0, 3000)}\n\nASSISTANT ANSWER:\n${answer.slice(0, 6000)}${sideRow}` },
  ], { maxTokens: 3000, temperature: 0.1, timeout: 90_000, thinking: true }).catch(() => '');
  return raw ? parseQuality(raw) : null;
}

/**
 * Ticket 3ff96116: the preamble line(s) the judge gets about what it CANNOT see. Pure.
 * images/documents ≥ 1 → one line; side-row text → one line introducing the appended continuation block.
 * Ticket 3ff96116 recurrence (2026-10-14): webToolCalls ≥ 1 → one line stating the turn's VERIFIED
 * grounding footprint. The recurrence sample's dominant issue was 'ungrounded' (10/39 judge attempts)
 * on answers that made 1–7 live web tool calls (verified in chat_search_usage) — the rubric's "does it
 * show it looked them up" leg punished verified-grounded answers the text-only judge cannot see.
 * The note says the lookups HAPPENED; the judge still judges how well the answer USES that evidence.
 */
export function qualityJudgeContextNote(ctx: JudgeContext): string {
  const images = Math.max(0, Math.floor(Number(ctx.images ?? 0)));
  const documents = Math.max(0, Math.floor(Number(ctx.documents ?? 0)));
  const webToolCalls = Math.max(0, Math.floor(Number(ctx.webToolCalls ?? 0)));
  if (!images && !documents && !ctx.sideRowText?.trim() && webToolCalls < 1) return '';
  const lines: string[] = [];
  if (images > 0) {
    const docNote = documents > 0 ? ` and ${documents} document attachment(s)` : '';
    lines.push(`NOTE: the user message arrived with ${images} image attachment(s)${docNote} whose contents you cannot see; the assistant could see them. Score the TEXT answer on its own merits; do not penalize references to attachment content you cannot verify.\n`);
  } else if (documents > 0) {
    lines.push(`NOTE: the user message arrived with ${documents} document attachment(s) whose contents you cannot see; the assistant could see them. Score the TEXT answer on its own merits; do not penalize references to attachment content you cannot verify.\n`);
  }
  if (webToolCalls > 0) lines.push(`NOTE: the assistant made ${webToolCalls} live web search/browse tool call(s) during this turn before answering (verified in the transcript; the raw results are not shown to you). It did look the facts up — judge how well the answer uses that evidence rather than whether lookups happened.\n`);
  if (ctx.sideRowText?.trim()) lines.push('NOTE: after this answer the SAME turn delivered a continuation note to the user, appended below — treat it as part of the answer the user received.\n');
  return lines.join('');
}

/**
 * Ticket 3ff96116: collapse K single judge calls on the SAME (message, answer) to ONE judgement. The judge's
 * run-to-run spread measured 3 on the 1..5 scale (the same answer scored 2,5,2,4 across four runs) — a single
 * sample of that noise counted 4 of 16 answers "low" and filed this ticket. The MEDIAN is the robust centre; the
 * issue is the issue of a median-scored call (ties → the lowest-index one, the conservative side). Null /
 * unparseable calls are skipped (K shrinks); all-null → null. Pure.
 */
export function collapseQuality(results: Array<QualityResult | null>): QualityResult | null {
  const scored = results.filter((x): x is QualityResult => !!x && typeof x.score === 'number');
  if (!scored.length) return null;
  const sorted = [...scored].sort((a, b) => (a.score as number) - (b.score as number));
  const medianRow = sorted[Math.floor((sorted.length - 1) / 2)] ?? sorted[0];
  const medianScore = medianRow.score as number;
  const chosen = sorted.find((x) => x.score === medianScore) ?? medianRow;
  return { score: medianScore, issue: chosen.issue };
}

export const COMPARATIVE_RUBRIC = [
  'You are given ONE user question and SEVERAL anonymized candidate answers to it, labeled A, B, C, … . Different assistants wrote them; which one wrote which is hidden on purpose — do not try to guess or mention it.',
  'Rank the answers BEST to WORST by how well they serve the user: did each answer every part of the question, is it factually right, is it clear and the right length, is it grounded (a source / date) where the question is time-sensitive.',
  'Judge only the answer text in front of you. End with exactly one line:',
  'RANKING: <labels best first, comma-separated — e.g. RANKING: C, A, B>',
].join('\n');

/**
 * Judge v2 (2026-10-20, "fix the model benchmarks"): the v1 rubric asked for "the right length" and the qwen judge
 * rewarded length — the scorecard put the longest-answering model first in every kind while a blind two-pass re-judge
 * ranked the field differently (docs/AUDIT_2026-10-20_REAL_USER.md). v2 is LENGTH-BLIND (length / structure is never
 * quality; equal service ⇒ the shorter wins; padding is a defect), says the order and labels are random, and asks for
 * EVERY label exactly once (the ingest refuses a partial ranking instead of filling it by position). The offline
 * bench ingest (scripts/framework-audit/model-bench-ingest.js) uses it by default with a family-excluding judge panel
 * and position-rotated ballots; the comparative judges below keep v1 unless the caller asks (opts.rubric).
 */
export const COMPARATIVE_RUBRIC_V2 = [
  'You are given ONE user question and SEVERAL anonymized candidate answers to it, labeled A, B, C, … . Different assistants wrote them; which one wrote which is hidden on purpose — do not try to guess or mention it.',
  'The order of the answers and their labels are RANDOM: neither the position of an answer nor its letter means anything, and neither may influence your ranking.',
  'Rank the answers BEST to WORST by how well each serves the user: is it factually correct; is it complete against what the user actually asked (every part of the question — not everything that could be said); is it useful — clear and actionable for this user; where the question is time-sensitive, is it grounded (a source / date).',
  'Length and formatting are NOT quality. Never prefer an answer for being longer, more detailed, more formatted (headings, bullets, tables, bold) or for adding extras the user did not ask for. When two answers serve the user equally well, prefer the SHORTER one. Padding, repetition and filler are defects.',
  'An answer that ends with a "shortened here for this review" marker was cut for this review only. Judge the part shown: do not read the cut as an unfinished answer, and give the unseen rest neither credit nor penalty.',
  'Judge only the answer text in front of you. Rank EVERY label exactly once — no ties, no omissions. End with exactly one line:',
  'RANKING: <every label, best first, comma-separated — e.g. RANKING: C, A, B>',
].join('\n');

/** Which comparative rubric a judge call uses: 'v1' = COMPARATIVE_RUBRIC (today's; the default), 'v2' = COMPARATIVE_RUBRIC_V2. */
export type ComparativeRubric = 'v1' | 'v2';
export interface ComparativeJudgeOpts { rubric?: ComparativeRubric }

/** The per-answer and question cuts of the comparative judge's user message (chars). */
export const COMPARATIVE_ANSWER_CHARS = 6000;
export const COMPARATIVE_QUESTION_CHARS = 3000;
/**
 * v2: appended to an answer cut at COMPARATIVE_ANSWER_CHARS — a cut answer must not read as an incomplete one. It names
 * no length (2026-10-20 review: "cut at 6000 chars" was itself a length cue beside a rubric that prefers the shorter
 * answer) and the rubric credits nothing unseen (the old "do not count the cut against it" read as "assume the rest is
 * fine" — credit for a tail nobody reviewed).
 */
export const COMPARATIVE_CUT_MARKER = '[… shortened here for this review]';

/** One anonymized candidate handed to the comparative judge: label + answer text — never the model identity. */
export interface RankedAnswer { label: string; answer: string }

/** The system prompt for a comparative rubric version. Pure. */
export function comparativeRubricText(rubric: ComparativeRubric = 'v1'): string {
  return rubric === 'v2' ? COMPARATIVE_RUBRIC_V2 : COMPARATIVE_RUBRIC;
}

/**
 * The ONE comparative judge user message (both judges below). v1 is byte-identical to the pre-v2 message (each answer
 * cut at 6000 chars with no marker); v2 marks a cut answer with COMPARATIVE_CUT_MARKER so the judge never scores the
 * review cut as an unfinished answer. Pure.
 */
export function comparativeUserMessage(question: string, answers: RankedAnswer[], rubric: ComparativeRubric = 'v1'): string {
  const body = (a: RankedAnswer): string => {
    const text = a.answer.slice(0, COMPARATIVE_ANSWER_CHARS);
    return rubric === 'v2' && a.answer.length > COMPARATIVE_ANSWER_CHARS ? `${text}\n${COMPARATIVE_CUT_MARKER}` : text;
  };
  return `USER QUESTION:\n${question.slice(0, COMPARATIVE_QUESTION_CHARS)}\n\nCANDIDATE ANSWERS:\n${answers.map((a) => `--- ${a.label} ---\n${body(a)}`).join('\n\n')}`;
}

/** The best-first label order from the comparative judge's reply (the LAST "RANKING:" line wins). Pure. */
export function parseRanking(text: string): string[] | null {
  // One match per RANKING: line: the label continuation stays on that line ([ \t] only — \s would
  // greedily absorb intervening prose into the labels once the reply is uppercased; only \s* after
  // the colon tolerates a wrapped first label). Without this, "RANKING: B, A\nMORE TEXT\nRANKING:
  // A, B" parses as B/A/MORE/TEXT/RANKING instead of the intended last-line A, B.
  // 2026-10-20 (judge v2): markdown emphasis / code ticks are stripped first ("**RANKING:** C, A, B" and
  // "RANKING: **C, A, B**" parsed to null) and '>' separates labels like ',' ("RANKING: B > A > C" parsed as
  // ['B'] — the ingest then filled A and C in by presentation position). ';' and '/' still END the line (review): as
  // separators they pulled trailing prose into the labels ("RANKING: C, A, B; A is weakest" → C, A, B, A, IS, …), which
  // the ingest's v2 completeness check turns from a clean ranking into a retried / failed ballot.
  const m = String(text || '').replace(/[*_`]/g, '').toUpperCase().match(/RANKING:\s*[A-Z](?:[ \t]*[,>]?[ \t]*[A-Z])*/g);
  if (!m || !m.length) return null;
  const labels = m[m.length - 1].replace(/^RANKING:\s*/, '').split(/[\s,>]+/).filter(Boolean);
  return labels.length ? labels : null;
}

/**
 * The production comparative judge for the offline model bench (2026-10-06, P1.3): the Utility seat with thinking
 * on, COMPARATIVE_RUBRIC. `answers` arrive already anonymized — label + text, presentation order shuffled by the
 * caller (scripts/framework-audit/model-bench-ingest.js) — so model identity never reaches this function. The
 * reply is parsed by parseRanking into a best-first label order the caller maps back to models. A judge failure →
 * null (the caller falls back to per-answer absolute scoring). `opts.rubric` 'v2' = COMPARATIVE_RUBRIC_V2 + the
 * cut marker (default 'v1' — the call is byte-identical to before).
 */
export async function defaultComparativeJudge(question: string, answers: RankedAnswer[], opts: ComparativeJudgeOpts = {}): Promise<string[] | null> {
  if (!answers.length) return null;
  const rubric = opts.rubric === 'v2' ? 'v2' : 'v1';
  const { utilityChat } = await import('../../../utils/utility-llm');
  const raw = await utilityChat([
    { role: 'system', content: comparativeRubricText(rubric) },
    { role: 'user', content: comparativeUserMessage(question, answers, rubric) },
  ], { maxTokens: 4000, temperature: 0.1, timeout: 120_000, thinking: true }).catch(() => '');
  return raw ? parseRanking(raw) : null;
}

/**
 * The spec-pinned comparative judge (P1.5, 2026-10-06): the SAME COMPARATIVE_RUBRIC + parseRanking as
 * defaultComparativeJudge, but the call runs on ONE named model spec — a built-in id or a '<label>:<modelId>'
 * registry spec — instead of the pinned Utility seat. This is the comparative judge's family-diversity lever:
 * mb1006a's Utility-seat judge is qwen3.8-flash while 3 of 8 bench candidates are qwen-family, so the ingest's
 * judge-family guard fell all 29 question groups back to absolute scoring (judgedComparative 0/230). Pinning a
 * conflict-free judge spec here lets the blind comparative path actually engage.
 *
 * The call shape is byte-equivalent to utilityChat's role-override leg (model-roles.service probeNonStreamingCompletion
 * uses the same recipe): resolveProviderForRun resolves the spec (colon-spec via the registry, else the built-in
 * switch), runHelperCompletion posts {…provider extras, model, messages, max_tokens, temperature} non-streaming
 * with the bounded-seat thinking-off treatment — exactly what the Utility-seat override judge receives today.
 * A spec that fails to resolve (fell back to a built-in — detected via the '(custom endpoint)' label idiom),
 * times out, returns empty text or an unparseable reply → null, so the caller falls back to absolute scoring and
 * never a wrong ranking. Exported for the offline bench (scripts/framework-audit/model-bench-ingest.js).
 * `opts.rubric` 'v2' (judge v2, 2026-10-20): COMPARATIVE_RUBRIC_V2 + the cut marker, and a BARE id must resolve to
 * itself — an unknown built-in id silently resolves to the default built-in (normalizeCodingModel → glm-5.3, which
 * cannot turn reasoning off), and a panel judge is vetted by family, so a typo must refuse, never judge as glm.
 * Default 'v1': the call is byte-identical to before.
 */
export async function comparativeJudgeOnModel(
  question: string,
  answers: RankedAnswer[],
  judgeSpec: string,
  opts: ComparativeJudgeOpts = {},
): Promise<string[] | null> {
  if (!answers.length) return null;
  const spec = String(judgeSpec ?? '').trim();
  if (!spec) return null;
  const rubric = opts.rubric === 'v2' ? 'v2' : 'v1';
  try {
    const { resolveProviderForRun } = await import('../coding/coding-model');
    const { runHelperCompletion } = await import('../coding/helper-completion');
    const p = await resolveProviderForRun(spec);
    // A colon-spec that missed the registry resolves to the built-in switch — that is NOT the judge the caller
    // asked for, so refuse rather than silently judging on a family the guard never vetted (probe idiom, model-roles).
    if (spec.includes(':') && !p.label.endsWith('(custom endpoint)')) return null;
    if (rubric === 'v2' && !spec.includes(':') && p.model !== spec) return null;
    const a = await runHelperCompletion(p, [
      { role: 'system', content: comparativeRubricText(rubric) },
      { role: 'user', content: comparativeUserMessage(question, answers, rubric) },
    ], { maxTokens: 4000, temperature: 0.1, timeoutMs: 120_000 });
    return parseRanking(a.text);
  } catch {
    return null; // unresolvable / timed out / empty answer — the caller falls back to absolute scoring
  }
}

async function defaultFileTicket(r: Regression, summary: AuditSummary, chatIds: string[]): Promise<string | null> {
  const { fileFeedbackTicket } = await import('../feedback/feedback.service');
  const res = await fileFeedbackTicket({
    userId: null, type: r.type, title: r.title, priority: r.priority, area: 'framework',
    description: `${r.detail}\n\nNightly live-chat audit (platform/live-chat-audit.ts) over the last ${summary.windowHours} h of real human turns: ${summary.turns} turns, ${summary.errors} errors, ${summary.duplicateAnswers} double answers, ${summary.verifierCorrections} verifier corrections, ${summary.handbacks} hand-backs, Quick lane ${summary.ranQuick} (${summary.quickTapped} tapped). Sample chat ids (internal): ${chatIds.slice(0, 5).join(', ') || 'n/a'}. No message text is recorded here — read the chats in prod with prodq probes if needed. Re-sighted nightly while the signal persists.`,
    context: { source: SOURCE, signal: r.signal, sessionId: `${SOURCE}:${r.signal}`, filedBy: SOURCE, chatIds: chatIds.slice(0, 5), summary: { turns: summary.turns, errors: summary.errors, duplicateAnswers: summary.duplicateAnswers, verifierCorrections: summary.verifierCorrections, replay: summary.replay } },
  });
  if ('error' in res) { logger.warn(`${SOURCE}: ticket not filed (${res.error}): ${res.message}`); return null; }
  return res.ticket?.id ? String(res.ticket.id) : null;
}

interface RawAnswer { id: string; chatId: string; createdAt: Date; content: string; parts: unknown; metadata: unknown }

/**
 * Ticket 3ff96116: the judge context for ONE sampled answer — what the user's message carried and what the
 * SAME turn delivered after the answer row. Reads the turn's user row (attachments persisted by
 * chat-agent.service.ts as metadata.attachments — image pixels the judge cannot see) and the side rows that
 * follow the answer before the next user row (deeper_findings / continuation_result / deliverable_handoff /
 * control_note / check_addendum / council_addendum — SIDE_KINDS), capped so a chatty continuation cannot
 * blow the judge call. Never throws. No text is persisted — it lives only inside the judge call.
 */
async function judgeContextFor(a: { chatId: string; createdAt: Date; parts?: unknown }, now: Date, prior: Array<{ content: string; metadata?: unknown }> = []): Promise<JudgeContext> {
  const out: JudgeContext = {};
  // Ticket 3ff96116 recurrence: the turn's VERIFIED web-grounding footprint, counted from the answer
  // row's own parts (same source as chat_search_usage) — before any DB read, so it survives read errors.
  const webToolCalls = countWebGroundingCalls(a.parts);
  if (webToolCalls > 0) out.webToolCalls = webToolCalls;
  try {
    const userRow = prior[0] && asRecord(prior[0].metadata).attachments
      ? prior[0]
      : (await prisma.crossModelMessage.findFirst({
          where: { chatId: a.chatId, role: 'user', createdAt: { lt: a.createdAt } },
          orderBy: { createdAt: 'desc' }, select: { metadata: true },
        }).catch(() => null));
    const atts = Array.isArray(asRecord(userRow?.metadata).attachments) ? asRecord(userRow?.metadata).attachments as unknown[] : [];
    const images = atts.filter((x) => String(asRecord(x).type || '').startsWith('image')).length;
    const documents = atts.length - images;
    if (images > 0) out.images = images;
    if (documents > 0) out.documents = documents;
  } catch { /* context is best-effort — a blind judge call is the fallback */ }
  try {
    const next = await prisma.crossModelMessage.findFirst({
      where: { chatId: a.chatId, role: 'user', createdAt: { gt: a.createdAt } },
      orderBy: { createdAt: 'asc' }, select: { createdAt: true },
    }).catch(() => null);
    const until = next && next.createdAt < now ? next.createdAt : now;
    const sides = await prisma.crossModelMessage.findMany({
      where: { chatId: a.chatId, role: 'assistant', createdAt: { gt: a.createdAt, lte: until } },
      orderBy: { createdAt: 'asc' }, select: { content: true, metadata: true },
    }).catch(() => [] as Array<{ content: string; metadata: unknown }>);
    const cont = sides.filter((s) => SIDE_KINDS.has(String(asRecord(s.metadata).kind ?? ''))).map((s) => String(s.content ?? '').trim()).filter(Boolean);
    if (cont.length) out.sideRowText = cont.join('\n\n');
  } catch { /* same */ }
  return out;
}

/** ONE nightly pass. Returns the ≤200-char cron status line. Never throws. */
export async function runLiveChatAuditOnce(deps: Deps = {}): Promise<string> {
  if (liveChatAuditDisabled()) return 'disabled (LIVE_CHAT_AUDIT_DISABLED)';
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - LIVE_CHAT_AUDIT_WINDOW_MS);
  try {
    const rows = await prisma.$queryRaw<RawAnswer[]>`
      SELECT m."id", m."chatId", m."createdAt", m."content", m."parts", m."metadata"
      FROM "crossmodel_messages" m
      JOIN "crossmodel_chats" c ON c."id" = m."chatId"
      LEFT JOIN "users" bu ON bu."id" = c."userId" AND bu."email" = ${MODEL_BENCH_ACCOUNT_EMAIL}
      WHERE m."role" = 'assistant'
        AND m."createdAt" > ${since} AND m."createdAt" <= ${now}
        AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
        AND bu."id" IS NULL
        AND coalesce(c."title", '') NOT LIKE ${MODEL_BENCH_TITLE_PREFIX + '%'}
        AND m."metadata" -> 'depth' IS NOT NULL
      ORDER BY m."createdAt" ASC
      LIMIT ${LIVE_CHAT_AUDIT_MAX_ROWS}`;
    const answers = rows.filter((r) => isAuditableAnswer(r.metadata));
    const ids = answers.map((a) => a.id);
    const fb = ids.length
      ? await prisma.messageFeedback.findMany({ where: { messageId: { in: ids } }, select: { messageId: true, type: true } }).catch(() => [])
      : [];
    const fbBy = new Map<string, string[]>();
    for (const f of fb) if (f.messageId) fbBy.set(f.messageId, [...(fbBy.get(f.messageId) ?? []), f.type]);
    const { findHandback } = await import('../chat-agent/handback-detector');
    const webSearchConfigured = !webSearchMissingOnInstance();
    const signals = answers.map((a) => turnSignals({ ...a, feedback: fbBy.get(a.id) ?? [] }, (text, parts) => !!findHandback({ finalText: text, parts }), { webSearchConfigured }));

    // Transcript checks: a user row answered by more than one ordinary assistant row; verifier corrections on plain chats.
    // 18bce3f9: bench-account chats are excluded here too — synthetic traffic is not "real human turns"
    // for ANY signal (the answers query and these transcript checks must agree on the population).
    const dup = await prisma.$queryRaw<Array<{ chatId: string }>>`
      SELECT u."chatId" FROM "crossmodel_messages" u
      JOIN "crossmodel_chats" c ON c."id" = u."chatId"
      LEFT JOIN "users" bu ON bu."id" = c."userId" AND bu."email" = ${MODEL_BENCH_ACCOUNT_EMAIL}
      WHERE u."role" = 'user' AND u."createdAt" > ${since} AND u."createdAt" <= ${now}
        AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
        AND bu."id" IS NULL
        AND coalesce(c."title", '') NOT LIKE ${MODEL_BENCH_TITLE_PREFIX + '%'}
        AND coalesce(u."metadata"->>'origin', 'user') = 'user'
        AND (SELECT count(*) FROM "crossmodel_messages" a
             WHERE a."chatId" = u."chatId" AND a."role" = 'assistant' AND a."createdAt" > u."createdAt"
               AND a."createdAt" < coalesce((SELECT min(n."createdAt") FROM "crossmodel_messages" n WHERE n."chatId" = u."chatId" AND n."role" = 'user' AND n."createdAt" > u."createdAt"), ${now})
               AND coalesce(a."metadata"->>'kind', '') NOT IN ('deeper_findings','continuation_result','deliverable_handoff','control_note','check_addendum','council_addendum','session_status','project_status','owner_briefing')
               AND (a."metadata"->>'origin' = 'user' OR a."metadata"->'depth' IS NOT NULL)
               AND a."metadata"->>'verifier' IS NULL) > 1
      LIMIT 200`.catch(() => [] as Array<{ chatId: string }>);
    const verifierCorrectionRows = await prisma.$queryRaw<Array<{ chatId: string }>>`
      SELECT m."chatId" FROM "crossmodel_messages" m
      JOIN "crossmodel_chats" c ON c."id" = m."chatId"
      LEFT JOIN "users" bu ON bu."id" = c."userId" AND bu."email" = ${MODEL_BENCH_ACCOUNT_EMAIL}
      WHERE m."role" = 'assistant' AND m."createdAt" > ${since} AND m."createdAt" <= ${now}
        AND m."metadata"->>'verifier' = 'action-verifier'
        AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
        AND bu."id" IS NULL
        AND coalesce(c."title", '') NOT LIKE ${MODEL_BENCH_TITLE_PREFIX + '%'}
      LIMIT 200`.catch(() => [] as Array<{ chatId: string }>);
    // Since 2026-10-04 the post-delivery verifier is OBSERVE-ONLY on human chats (no correction row unless
    // ACTION_VERIFIER_ENFORCE=1) — its convictions are the deduped mishap tickets (one per chat, re-sighted:
    // updatedAt moves). Counting only correction rows would read zero while phantoms keep happening.
    const verifierTicketRows = await prisma.$queryRaw<Array<{ chatId: string }>>`
      SELECT f."context"->>'sessionId' AS "chatId" FROM "user_feature_requests" f
      WHERE f."type" = 'mishap' AND f."context"->>'verifier' = 'action-verifier' AND f."context"->>'area' = 'fleet-integrity'
        AND f."updatedAt" > ${since} AND f."updatedAt" <= ${now}
      LIMIT 200`.catch(() => [] as Array<{ chatId: string }>);
    const verifierRows = [...new Map([...verifierCorrectionRows, ...verifierTicketRows].filter((r) => r.chatId).map((r) => [r.chatId, r])).values()];

    // audit 2026-10-08 W4-7: first-word time over EVERY human turn (ux_ttft — guests and supervisor chats included;
    // synthetic bench / suite rows excluded). loop_metrics is indexed on (kind, createdAt).
    const ttftRows = await prisma.$queryRaw<Array<{ sessionId: string | null; value: number | null; guest: string | null; no_chunk: string | null; supervisor: boolean | null }>>`
      SELECT u."sessionId", u."value", u."meta"->>'guest' AS guest, u."meta"->>'noChunk' AS no_chunk,
             (coalesce(c."isSupervisor", false) OR coalesce(c."isProjectSupervisor", false)) AS supervisor
      FROM "loop_metrics" u
      LEFT JOIN "crossmodel_chats" c ON c."id" = u."sessionId"
      WHERE u."kind" = 'ux_ttft' AND u."createdAt" > ${since} AND u."createdAt" <= ${now}
        AND coalesce((u."meta"->>'synthetic')::boolean, false) = false
      LIMIT 5000`.catch(() => [] as Array<{ sessionId: string | null; value: number | null; guest: string | null; no_chunk: string | null; supervisor: boolean | null }>);
    const humanTtft = ttftRows.length
      ? humanTtftFromRows(ttftRows.map((r) => ({ sessionId: r.sessionId, value: r.value === null ? null : Number(r.value), guest: r.guest === 'true', noChunk: r.no_chunk === 'true', supervisor: r.supervisor === true })))
      : null;

    // Decision replay + judge over a sample of turns that carried a turn plan.
    const replayN = sampleFromEnv(process.env.LIVE_CHAT_AUDIT_REPLAY_SAMPLE, 30);
    const judgeN = sampleFromEnv(process.env.LIVE_CHAT_AUDIT_JUDGE_SAMPLE, 20);
    const planned = answers.filter((a) => asRecord(asRecord(a.metadata).depth).turnPlan);
    const step = Math.max(1, Math.floor(planned.length / Math.max(1, replayN)));
    const sample = replayN ? planned.filter((_, i) => i % step === 0).slice(0, replayN) : [];
    const replayLane = deps.replayLane ?? defaultReplayLane;
    const judgeLane = deps.judgeLane ?? defaultJudgeLane;
    const qualityN = sampleFromEnv(process.env.LIVE_CHAT_AUDIT_QUALITY_SAMPLE, 20);
    const qualityJudge = deps.qualityJudge ?? defaultQualityJudge;
    const qualityRepeats = qualityRepeatsFromEnv(process.env[LIVE_CHAT_AUDIT_QUALITY_REPEATS_ENV]);
    const qualities: Array<QualityResult & { chatId: string }> = [];
    const replays: ReplayResult[] = [];
    for (let i = 0; i < sample.length; i += 1) {
      const a = sample[i];
      const prior = await prisma.crossModelMessage.findMany({
        where: { chatId: a.chatId, role: 'user', createdAt: { lt: a.createdAt } },
        orderBy: { createdAt: 'desc' }, take: 3, select: { content: true, metadata: true, createdAt: true },
      }).catch(() => [] as Array<{ content: string; metadata?: unknown; createdAt?: Date }>);
      const message = String(prior[0]?.content ?? '');
      if (!message.trim()) continue;
      const earlier = prior.slice(1).map((p) => String(p.content ?? '')).reverse();
      // Ticket 4c3f2a5c: reconstruct the state the LIVE ask carried (the replay was attachment-blind,
      // turn_in_chat = the ≤2 prior window instead of the true count, and never sent
      // previous_answer_lane — prod probe 1ca1a5af measured these as the FALSE-drift causes).
      // priorLane: the previous answer's own recorded plan lane, read through the LIVE reader's own
      // guard (turnPlanFromMetadata returns null unless the plan carries a stash — quiet/preset-
      // fallback plans carry none, so a fallback answer yields null here exactly as the live ask
      // read it). turnIndex: the count of user rows before the question row. Attachments: the
      // question row's metadata.attachments (chat-agent persists attachmentMeta there — its
      // items are { filename, type: 'image'|'pdf'|'document' }), images by the SAME type-prefix
      // filter judgeContextFor uses; a pasted documentText turn undercounts documents by 1 (the
      // paste is not reconstructable from rows — noted, bounded).
      const lastAnswer = await prisma.crossModelMessage.findFirst({
        where: { chatId: a.chatId, role: 'assistant', createdAt: { lt: a.createdAt } },
        orderBy: { createdAt: 'desc' }, select: { metadata: true },
      }).catch(() => null);
      const priorLane = turnPlanFromMetadata(lastAnswer?.metadata)?.lane ?? null;
      const questionRow = prior[0] ? await prisma.crossModelMessage.findFirst({
        where: { chatId: a.chatId, role: 'user', createdAt: { lt: a.createdAt }, content: message },
        orderBy: { createdAt: 'desc' }, select: { createdAt: true, metadata: true },
      }).catch(() => null) : null;
      const turnIndex = questionRow ? await prisma.crossModelMessage.count({
        where: { chatId: a.chatId, role: 'user', createdAt: { lt: questionRow.createdAt } },
      }).catch(() => 0) : earlier.length;
      const atts = Array.isArray(asRecord(questionRow?.metadata).attachments) ? asRecord(questionRow?.metadata).attachments as unknown[] : [];
      const images = atts.filter((x) => String(asRecord(x).type || '').startsWith('image')).length;
      const documents = atts.length - images;
      const tpMeta = asRecord(asRecord(asRecord(a.metadata).depth).turnPlan);
      const sig = turnSignals(a, undefined, { webSearchConfigured: !webSearchMissingOnInstance() });
      // B2 (review of bdf892138): tpMeta.backend is the LABEL turnPlanMetadata stamps
      // ('TypeSafe Jev', …) while the replay returns a SPEC ('jev', '<label>:<id>') — compare
      // them through backendSpecOfRow so the same physical backend never reads as drift.
      const liveBackend = backendSpecOfRow(tpMeta) !== 'unknown' ? backendSpecOfRow(tpMeta) : null;
      const hadDecision = typeof tpMeta.decisionId === 'string' && !!tpMeta.decisionId;
      const replayOut = await replayLane(message, earlier, {
        ...(priorLane ? { priorLane } : {}),
        turnIndex,
        images, documents,
        liveBackend,
      }).catch(() => null);
      const { lane: replayed, backend: replayBackend } = replayLaneResult(replayOut);
      const judge = i < judgeN ? await judgeLane(message, earlier).catch(() => null) : null;
      const ruleLaneRaw = tpMeta.ruleLane;
      const ruleLane = (LANES as readonly string[]).includes(String(ruleLaneRaw)) ? ruleLaneRaw as Lane : null;
      // Ticket f2e34408: the calibration verdict the router's own guard reads. `stash.calibrated === false` makes
      // usableTurnPlan() refuse the plan, so the research router answers `no_answer` whatever the probabilities say.
      const calibratedRaw = asRecord(tpMeta.stash).calibrated;
      const calibrated = typeof calibratedRaw === 'boolean' ? calibratedRaw : null;
      replays.push({
        recorded: sig.lane, replayed, judge, acted: sig.acted, preset: sig.preset, ruleLane,
        hadDecision, liveBackend, replayBackend, calibrated,
      });
      if (i < qualityN) {
        // Ticket 3ff96116: judge the answer the USER actually received, and collapse K repeats of a
        // noisy judge (measured spread 3/5 on the same answer) to the median instead of one sample.
        const ctx = await judgeContextFor(a, now, prior).catch(() => ({} as JudgeContext));
        const reps = Math.max(1, qualityRepeats);
        const attempts: QualityResult[] = [];
        for (let k = 0; k < reps; k += 1) {
          const q = await qualityJudge(message, String(a.content ?? ''), earlier, ctx).catch(() => null);
          if (q) attempts.push(q);
        }
        const collapsed = collapseQuality(attempts);
        if (collapsed) qualities.push({ ...collapsed, chatId: a.chatId });
      }
    }

    // Ticket f2e34408: the research router's OWN telemetry for the window — what it answered to the asks it was
    // obliged to answer. Previously never read, so a router-INPUT defect (uncalibrated turn plans) showed up only
    // as the opaque "researchUnderRouted" count and pointed the reader at the inert routing rule.
    const routerRows = await prisma.$queryRaw<Array<{ route: string | null; allowance: string | null; why: string | null }>>`
      SELECT u."meta"->>'route' AS route, u."meta"->>'allowance' AS allowance, u."meta"->>'why' AS why
      FROM "loop_metrics" u
      WHERE u."kind" = 'lane_research' AND u."createdAt" > ${since} AND u."createdAt" <= ${now}
      LIMIT 5000`.catch(() => [] as Array<{ route: string | null; allowance: string | null; why: string | null }>);
    const routerHealth = routerRows.length
      ? routerHealthFromRows(routerRows.map((r) => ({
        route: String(r.route ?? 'unknown'),
        allowance: r.allowance === null || r.allowance === undefined ? null : String(r.allowance) === 'true',
        why: r.why ?? null,
      })))
      : null;

    const summary = summarizeAudit(signals, { duplicateAnswers: dup.length, verifierCorrections: verifierRows.length, replays, quality: qualities, humanTtft, router: routerHealth });
    const baselineRows = await prisma.loopMetric.findMany({
      where: { kind: LIVE_CHAT_AUDIT_KIND, createdAt: { lt: since, gt: new Date(since.getTime() - 8 * LIVE_CHAT_AUDIT_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' }, take: 7, select: { meta: true },
    }).catch(() => [] as Array<{ meta: unknown }>);
    const baseline = baselineRows.map((b) => asRecord(asRecord(b.meta).summary) as unknown as AuditSummary).filter((b) => typeof b?.turns === 'number');
    const regressions = detectRegressions(summary, baseline);

    const chatIdsFor = (signal: string): string[] => {
      if (signal === 'duplicate_answers') return dup.map((d) => d.chatId);
      if (signal === 'verifier_corrections') return verifierRows.map((v) => v.chatId);
      if (signal === 'lead_errors') return answers.filter((_, i) => signals[i].error).map((a) => a.chatId);
      if (signal === 'empty_answers') return answers.filter((_, i) => signals[i].empty).map((a) => a.chatId);
      if (signal === 'handbacks') return answers.filter((_, i) => signals[i].handback).map((a) => a.chatId);
      if (signal === 'answer_leaks') return answers.filter((_, i) => signals[i].leak).map((a) => a.chatId);
      if (signal === 'answer_refusals') return answers.filter((_, i) => signals[i].refusal).map((a) => a.chatId);
      if (signal === 'answer_quality') return qualities.filter((q) => (q.score ?? 5) <= 2).map((q) => q.chatId);
      if (signal === 'quick_tapped') return answers.filter((_, i) => signals[i].ranQuick && signals[i].escalated).map((a) => a.chatId);
      if (signal === 'ttft_absolute') return humanTtft?.slowest ?? [];
      return [];
    };
    const filed: string[] = [];
    if (!liveChatAuditTicketsDisabled()) {
      const fileTicket = deps.fileTicket ?? defaultFileTicket;
      for (const r of regressions) {
        const id = await fileTicket(r, summary, [...new Set(chatIdsFor(r.signal))]).catch(() => null);
        if (id) filed.push(r.signal);
      }
    }
    recordLoopMetric({
      kind: LIVE_CHAT_AUDIT_KIND, sessionId: SOURCE, value: summary.turns, unit: 'turns',
      meta: { summary, regressions: regressions.map((r) => r.signal), ticketsFiled: filed, ticketsDisabled: liveChatAuditTicketsDisabled(), windowEnd: now.toISOString(), briefing: auditBriefingLine(summary, regressions.map((r) => r.signal), { filed, disabled: liveChatAuditTicketsDisabled() }) },
    });
    const line = `${summary.turns} turns, ${regressions.length} regression(s)${filed.length ? ` filed: ${filed.join(',')}` : ''}, replay ${summary.replay.agree}/${summary.replay.n}, judged ${summary.replay.judged}`;
    logger.info(`${LIVE_CHAT_AUDIT_JOB_ID}: ${line}`);
    return line.slice(0, 200);
  } catch (err: any) {
    logger.warn(`${LIVE_CHAT_AUDIT_JOB_ID}: pass failed — ${err?.message ?? err}`);
    return `failed: ${String(err?.message ?? err).slice(0, 150)}`;
  }
}

/**
 * The owner-briefing line from the newest audit row (≤ 36 h old, or ≤ `maxAgeMs` when given), or null. The audit
 * spans EVERY user's chats (aggregates only), so the line reaches ADMIN accounts only — a regular user's briefing
 * never carries fleet-wide numbers. Never throws. (audit 2026-10-06 T8-1: the owner briefing passes a 6 h window —
 * a 17-hour-old nightly row headed every briefing all day.)
 */
export async function liveChatAuditBriefingLine(userId: string | null | undefined, now: Date = new Date(), maxAgeMs: number = 36 * 60 * 60_000): Promise<string | null> {
  if (liveChatAuditDisabled() || !userId) return null;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (String(user?.role ?? '') !== 'ADMIN') return null;
    const row = await prisma.loopMetric.findFirst({
      where: { kind: LIVE_CHAT_AUDIT_KIND, createdAt: { gt: new Date(now.getTime() - maxAgeMs) } },
      orderBy: { createdAt: 'desc' }, select: { meta: true },
    });
    const line = asRecord(row?.meta).briefing;
    return typeof line === 'string' && line ? line : null;
  } catch {
    return null;
  }
}
