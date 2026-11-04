/**
 * Per-turn MODEL PICK — the decision model chooses the lead model for the task (owner 2026-10-04: "we shouldn't have
 * to switch digby seats or anything shouldn't the decision model decide any model it wants for the specific task").
 *
 * The turn plan (turn-plan.ts) already classifies every human turn — lane (quick / standard / checked / research),
 * stakes, live web, contested, breadth. This leaf turns that classification + MEASURED evidence per model into the
 * lead model for the turn:
 *
 *   candidates  every auto-eligible (model-catalog.ts autoEligible), servable, OPEN CHAT model in the catalog — a
 *               frontier-class model is NEVER a candidate (owner 2026-10-06 late: "pickers should never choose
 *               frontier anyway"; frontier models are consulted only by the reflection council after repeated
 *               failures — coding/frontier-council.ts; the env opt-in AUTO_PICK_FRONTIER_ENABLED=1 restores the C-1
 *               cost-weighted admission) — or the admin's Auto pool when one is
 *               configured (the pool narrows the field) — that fits the turn: vision when images ride, never an
 *               embedding / rerank endpoint, never a no-think model off the Quick lane;
 *   evidence    per model + lane: quality (1–5, the offline benchmark's judge score), time to first word (prod or
 *               bench p50), failure rate. NO live exploration (owner 2026-10-03): a model with no evidence is never
 *               picked — it is benchmarked offline first (scripts/e2e/model-bench.py → model-bench-ingest.js);
 *   utility     quality − λ(lane, stakes) · minutes-to-first-word − 2 · failRate − κ · USD-per-turn. λ is the price of
 *               waiting: steep on a quick question, near zero on research; a high-stakes turn halves it (wait for the
 *               better answer). κ (roster 2026-10-06 C-1, owner: "access to any and all models") is the price of a
 *               dollar — the estimated spend of one turn on that model (turnCostUsd: its registry / built-in price
 *               over PICK_TURN_TOKENS_IN / _OUT; an unknown price takes a conservative default) — so a frontier model
 *               wins only when its quality / speed justifies its price; high stakes halves it too. Applied only when
 *               the caller passes `cost` (the turn plan does — roster-policy.ts costPerUsd, MODEL_PICK_COST_DISABLED=1);
 *   switch      only when the best candidate beats the SEAT by ≥ SWITCH_MARGIN and keeps quality within
 *               QUALITY_SLACK of the seat's (never trade a materially worse answer for speed); else the seat. The seat
 *               is always the fallback (an unmeasured seat ⇒ no switch: nothing to compare against).
 *   kind        (2026-10-20, task-aware pick) the caller may name the turn's JOB TYPE (task-kind.ts). Quality is then
 *               compared on the bench's (model, kind) buckets — but ONLY when the SEAT has one (its evidence reads
 *               qualityKey 'kind'): the bench's quality is a within-question RANK, comparable only inside one bench
 *               field, so a kind-keyed seat is never weighed against a lane-keyed candidate — candidates without a
 *               kind bucket sit that turn out. A kind bucket is a small sample (8+ ranked answers, sd ≈ 1.6), so the
 *               switch margin widens to KIND_MARGIN_Z standard errors of the difference (kindSwitchMargin) and each
 *               ranked candidate carries the margin it must clear. A seat without a kind bucket ⇒ the lane
 *               comparison, unchanged. Latency, failures and cost stay (model, lane). ROLE picks (checker / council /
 *               call_in) stay lane-keyed: only the lead pick reads the kind.
 *
 * Pure: the caller loads the evidence (model-evidence.ts) and decides whether the pick ACTS (shadow / act mode).
 */

import { specIsFrontier } from '../model-endpoints/provider-class';
import { autoPickFrontierEnabled } from './roster-policy';
import type { TaskKind } from './task-kind';

export type PickLane = 'quick' | 'standard' | 'checked' | 'research';

export interface PickCandidate {
  spec: string;
  servable: boolean;
  autoEligible: boolean;
  vision: boolean;
  thinkingOff: boolean;
  /** USD per 1M input / output tokens (null / absent = no price on record). roster 2026-10-06 C-1. */
  priceIn?: number | null;
  priceOut?: number | null;
  /** Seat-governance class — an unknown frontier price takes the frontier default. */
  frontier?: boolean;
  /** Model family (model-catalog.ts modelFamily) — the role picks' family rule reads it. */
  family?: string;
  /** 'builtin' | 'registry' (the Quick role pick admits only models whose thinking the Quick lane can switch off). */
  source?: string;
}

export interface ModelEvidence {
  /** Turns behind the numbers (bench + prod). */
  n: number;
  ttftP50Ms: number | null;
  ttftP90Ms: number | null;
  /** 0..1 — no answer / error / empty. */
  failRate: number | null;
  /** 1..5 — the offline benchmark judge's mean; null when never benchmarked. */
  quality: number | null;
  qualityN: number;
  /** 2026-10-20: the bench bucket the quality came from — the turn's job type ('kind'), the lane, or the model's
   *  overall numbers ('all'). Absent on evidence built without model-evidence.ts. */
  qualityKey?: QualityKey;
  /** 2026-10-20: the bench run a 'kind' quality was ranked in (comparative ranks are field-relative). */
  qualityRunId?: string;
  /** Where the numbers came from (audit string). */
  source: string;
}

export type QualityKey = 'kind' | 'lane' | 'all';

export interface RankedModel {
  spec: string;
  utility: number;
  ttftP50Ms: number | null;
  quality: number | null;
  n: number;
  /** Estimated USD of one turn on this model (present only when the pick priced the field). */
  usd?: number;
  /** 2026-10-20: the quality key of this model's evidence (present when the evidence carried one). */
  qk?: QualityKey;
  /** 2026-10-20: on a kind-keyed pick, the utility gain this candidate must have over the seat (kindSwitchMargin);
   *  absent ⇒ SWITCH_MARGIN. */
  margin?: number;
}

export interface ModelPick {
  /** The model the turn should lead with (the seat when nothing beats it). */
  spec: string;
  /** spec !== the seat. */
  changed: boolean;
  seat: string;
  /** Code-composed audit string. */
  reason: string;
  expectedTtftMs: number | null;
  seatUtility: number | null;
  /** Top candidates by utility (≤ 5), for the answer row + readouts. */
  ranked: RankedModel[];
  /** 2026-10-20: present only when the comparison was keyed on this job type's bench buckets. */
  kind?: TaskKind;
}

/** Price of one minute of waiting, in quality points, per lane. */
export const WAIT_PRICE_PER_MIN: Readonly<Record<PickLane, number>> = { quick: 1.5, standard: 0.6, checked: 0.3, research: 0.1 };
export const HIGH_STAKES = 0.6;
export const SWITCH_MARGIN = 0.15;
export const QUALITY_SLACK = 0.25;
export const MIN_EVIDENCE_N = 5;
/** 2026-10-20: the per-answer sd of the bench's rank-based quality (K = 3 ranks map to 5 / 3 / 1 ⇒ sd ≈ 1.6). */
export const RANK_QUALITY_SD = 1.6;
/** 2026-10-20: standard errors of the quality difference a kind-keyed switch must clear. */
export const KIND_MARGIN_Z = 1.0;
const NON_CHAT_RE = /(^|[-_:\s])(embed|embedding|rerank|reranker)([-_\s]|$)/i;

/**
 * The utility gain a candidate needs over the seat when both are compared on KIND buckets (2026-10-20): at least
 * SWITCH_MARGIN, widened to KIND_MARGIN_Z · RANK_QUALITY_SD · √(1/n_seat + 1/n_cand) — one standard error of the
 * difference of two bucket means (n = each bucket's judged answers). 8 + 8 answers ⇒ 0.80; 30 + 30 ⇒ 0.41. Pure.
 */
export function kindSwitchMargin(nSeat: number, nCand: number): number {
  const a = Number.isFinite(nSeat) && nSeat > 0 ? nSeat : 0;
  const b = Number.isFinite(nCand) && nCand > 0 ? nCand : 0;
  if (!a || !b) return Number.POSITIVE_INFINITY; // an unjudged bucket can never justify a switch
  return Math.max(SWITCH_MARGIN, KIND_MARGIN_Z * RANK_QUALITY_SD * Math.sqrt(1 / a + 1 / b));
}

export function waitPrice(lane: PickLane, stakes: number | null | undefined): number {
  const base = WAIT_PRICE_PER_MIN[lane] ?? WAIT_PRICE_PER_MIN.standard;
  // Never halved on the Quick lane (2026-10-20): a Quick turn is by construction one the guards judged benign — since
  // the lookup stakes ceiling a pure lookup reaches Quick at stakes 0.6–0.75, and its wait must stay priced in full.
  return lane !== 'quick' && (stakes ?? 0) >= HIGH_STAKES ? base / 2 : base;
}

// ── The price of a turn (roster 2026-10-06 C-1) ─────────────────────────────
// A NOMINAL chat turn: prod 7 d (run_tokens_in / _out on human chat sessions, read 2026-10-06) — plain leads p50 ≈
// 61–68k input tokens (the doctrine + history + tool results re-sent per step) and ≈ 2–4k output tokens (reasoning
// included). One fixed shape for every model keeps the comparison about PRICE, not about a model's verbosity.
export const PICK_TURN_TOKENS_IN = 65_000;
export const PICK_TURN_TOKENS_OUT = 3_500;
/** An OPEN model with no price on record: the spend meter's own default (coding/cost.ts DEFAULT_PRICE). */
export const UNKNOWN_OPEN_PRICE = { in: 0.6, out: 2.4 } as const;
/** A FRONTIER model with no price on record: CONSERVATIVE — the top of the closed lines' list prices (an Opus-class
 *  $15 / $75 per 1M). Such a model competes only once an admin types its real price on the endpoint entry
 *  (Account → Admin → Endpoints → the model's $/M in / out). */
export const UNKNOWN_FRONTIER_PRICE = { in: 15, out: 75 } as const;

export interface PricedModel { priceIn?: number | null; priceOut?: number | null; frontier?: boolean }

const priceNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Estimated USD of one nominal turn on a model + where the price came from. Pure. */
export function turnCostUsd(m: PricedModel | null | undefined): { usd: number; priced: boolean } {
  const pin = priceNum(m?.priceIn);
  const pout = priceNum(m?.priceOut);
  const dflt = m?.frontier ? UNKNOWN_FRONTIER_PRICE : UNKNOWN_OPEN_PRICE;
  const priced = pin !== null || pout !== null;
  const usd = ((pin ?? dflt.in) * PICK_TURN_TOKENS_IN + (pout ?? dflt.out) * PICK_TURN_TOKENS_OUT) / 1_000_000;
  return { usd: Number(usd.toFixed(4)), priced };
}

/** The price of one USD in quality points on this turn: κ, halved on a high-stakes turn (pay for the better answer). */
export function costPrice(perUsd: number, stakes: number | null | undefined): number {
  const k = Number.isFinite(perUsd) && perUsd > 0 ? perUsd : 0;
  return (stakes ?? 0) >= HIGH_STAKES ? k / 2 : k;
}

/** The cost side of a pick: κ and every model's price card (the seat included). */
export interface PickCost {
  perUsd: number;
  priceOf: (spec: string) => PricedModel | null;
}

/** Utility of a model's evidence on a lane, or null when it cannot be scored (no quality or no latency). Pure. */
/**
 * The wait a user should EXPECT from a model (2026-10-05): the mean of the p50 and the p90 first-word times when the
 * p90 is known, else the p50. A median-only price let an ERRATIC route keep the seat — the gateway's glm-5.3-flash had
 * a 60 s p50 on checked turns but answered a health question in 120 s while a steady 11–14 s model sat one margin
 * short. Pure.
 */
export function expectedWaitMs(ev: Pick<ModelEvidence, 'ttftP50Ms' | 'ttftP90Ms'>): number | null {
  if (ev.ttftP50Ms === null) return null;
  const p50 = Math.max(0, ev.ttftP50Ms);
  return ev.ttftP90Ms !== null && ev.ttftP90Ms > p50 ? (p50 + ev.ttftP90Ms) / 2 : p50;
}

export function utilityOf(ev: ModelEvidence | null | undefined, lane: PickLane, stakes: number | null | undefined, usdPerTurn?: number | null, perUsd?: number | null): number | null {
  if (!ev || ev.quality === null || ev.ttftP50Ms === null) return null;
  const minutes = (expectedWaitMs(ev) ?? 0) / 60_000;
  const cost = typeof usdPerTurn === 'number' && Number.isFinite(usdPerTurn) && usdPerTurn > 0 ? costPrice(perUsd ?? 0, stakes) * usdPerTurn : 0;
  return ev.quality - waitPrice(lane, stakes) * minutes - 2 * Math.max(0, Math.min(1, ev.failRate ?? 0)) - cost;
}

/**
 * Is this candidate frontier-class? The card's own flag (it also knows a frontier vendor HOST), else the spec's model
 * id (provider-class.ts — a candidate list built without cards). Pure.
 */
export function isFrontierCandidate(c: { spec: string; frontier?: boolean }): boolean {
  return c.frontier === true || specIsFrontier(c.spec);
}

/**
 * The hard rule (owner 2026-10-06 late): an automatic pick NEVER chooses a frontier-class model, whatever the store's
 * autoPickPolicy says — AUTO_PICK_FRONTIER_ENABLED=1 (env only) is the one way back to the C-1 admission. Pure over env.
 */
export function frontierBlockedFromPick(c: { spec: string; frontier?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return isFrontierCandidate(c) && !autoPickFrontierEnabled(env);
}

/** May this model lead this turn at all? Pure. */
export function candidateFits(c: PickCandidate, lane: PickLane, opts: { images: boolean }): boolean {
  if (!c.servable || !c.autoEligible) return false;
  if (frontierBlockedFromPick(c)) return false;
  if (NON_CHAT_RE.test(c.spec)) return false;
  if (opts.images && !c.vision) return false;
  if (lane !== 'quick' && c.thinkingOff) return false;
  return true;
}

export interface PickInput {
  lane: PickLane;
  stakes: number | null;
  images: boolean;
  /** The model the turn runs without a pick (the seat / the pool's first). */
  seat: string;
  candidates: readonly PickCandidate[];
  /** (spec, lane) evidence; the optional third argument is the turn's job type (model-evidence.ts evidenceFrom). */
  evidence: (spec: string, lane: PickLane, kind?: TaskKind | null) => ModelEvidence | null;
  minEvidenceN?: number;
  /** Price every model (roster 2026-10-06 C-1). Absent = the pre-cost utility (quality − wait − failures). */
  cost?: PickCost | null;
  /** 2026-10-20: the turn's job type (the usable task_kind answer). Absent / null = today's (model, lane) pick. */
  kind?: TaskKind | null;
}

const fmtS = (ms: number | null) => (ms === null ? '?' : `${Math.round(ms / 1000)}s`);
const fmtUsd = (usd: number | null | undefined) => (typeof usd === 'number' ? `, $${usd.toFixed(3)}/turn` : '');

/** MODEL_PICK_CHECKER_FAMILY_GUARD_DISABLED=1 lets the pick share the Double Checker's family. */
export function checkerFamilyGuardDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.MODEL_PICK_CHECKER_FAMILY_GUARD_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Keep the second opinion INDEPENDENT (2026-10-05, after the owner flipped the pick to act: the pick chose
 * deepseek-flash to lead while the Double Checker seat is also a DeepSeek model — the "second opinion" came from the
 * same family). When the turn runs a checker of family `avoidFamily` and the pick shares it, take the best-ranked
 * candidate of ANOTHER family that still beats the seat by SWITCH_MARGIN; none ⇒ the seat leads. Pure.
 */
export function pickAvoidingFamily(pick: ModelPick, avoidFamily: string | null | undefined, familyOf: (spec: string) => string): ModelPick {
  if (!avoidFamily || !pick.changed || familyOf(pick.spec) !== avoidFamily) return pick;
  // 2026-10-20: a kind-keyed pick's candidates carry their own (wider) margin.
  const alt = pick.ranked.find((r) => r.spec !== pick.seat && familyOf(r.spec) !== avoidFamily
    && pick.seatUtility !== null && r.utility - pick.seatUtility >= (r.margin ?? SWITCH_MARGIN));
  if (alt) {
    return { ...pick, spec: alt.spec, expectedTtftMs: alt.ttftP50Ms,
      reason: `${alt.spec} (q ${alt.quality?.toFixed(2) ?? '?'}, ~${fmtS(alt.ttftP50Ms)}) — ${pick.spec} shares the Double Checker's ${avoidFamily} family; ${pick.reason}`.slice(0, 400) };
  }
  return { ...pick, spec: pick.seat, changed: false, expectedTtftMs: null,
    reason: `seat stands — ${pick.spec} shares the Double Checker's ${avoidFamily} family and no other-family candidate beats the seat` };
}

/** Choose the lead model for one turn. Pure; never throws. */
export function pickModel(input: PickInput): ModelPick {
  const { lane, stakes, images, seat } = input;
  const minN = input.minEvidenceN ?? MIN_EVIDENCE_N;
  // 2026-10-20 (task-aware pick): quality is compared on the turn's KIND buckets only when the SEAT has one — otherwise
  // every model is read exactly as before (no kind argument at all), so a kind-less turn is byte-identical to today's.
  const askedKind = input.kind ?? null;
  const seatKindEv = askedKind ? input.evidence(seat, lane, askedKind) : null;
  const kind: TaskKind | null = askedKind && seatKindEv?.qualityKey === 'kind' ? askedKind : null;
  const evidenceOf = (spec: string): ModelEvidence | null => (kind ? input.evidence(spec, lane, kind) : input.evidence(spec, lane));
  const seatEv = kind ? seatKindEv : input.evidence(seat, lane);
  const cost = input.cost && input.cost.perUsd > 0 ? input.cost : null;
  // The caller's price card (the live catalog — registry / built-in / twin prices) wins over the candidate's own fields.
  const usdOf = (spec: string, card?: PricedModel | null): number | null => (cost ? turnCostUsd(cost.priceOf(spec) ?? card ?? null).usd : null);
  const seatUsd = usdOf(seat, input.candidates.find((c) => c.spec === seat) ?? null);
  const seatUtility = seatEv && seatEv.n >= minN ? utilityOf(seatEv, lane, stakes, seatUsd, cost?.perUsd) : null;
  const ranked: RankedModel[] = [];
  let noKindBucket = 0;
  for (const c of input.candidates) {
    if (!candidateFits(c, lane, { images })) continue;
    const ev = evidenceOf(c.spec);
    if (!ev || ev.n < minN) continue;
    // A kind-keyed turn compares kind buckets only (ranks from different fields are not one scale).
    if (kind && ev.qualityKey !== 'kind') { noKindBucket++; continue; }
    // …and ranks from ONE run's field: a kind bucket ranked in another bench run than the seat's is not on its scale.
    if (kind && seatEv?.qualityRunId && ev.qualityRunId && ev.qualityRunId !== seatEv.qualityRunId) { noKindBucket++; continue; }
    const usd = usdOf(c.spec, c);
    const u = utilityOf(ev, lane, stakes, usd, cost?.perUsd);
    if (u === null) continue;
    const margin = kind && c.spec !== seat ? kindSwitchMargin(seatEv!.qualityN, ev.qualityN) : null;
    // An unjudged kind bucket (infinite margin) can never justify a switch — it sits the turn out rather than be ranked
    // without a margin (which every reader would take as the narrow lane SWITCH_MARGIN).
    if (margin !== null && !Number.isFinite(margin)) { noKindBucket++; continue; }
    ranked.push({
      spec: c.spec, utility: Number(u.toFixed(3)), ttftP50Ms: ev.ttftP50Ms, quality: ev.quality, n: ev.n, ...(usd !== null ? { usd } : {}),
      ...(ev.qualityKey ? { qk: ev.qualityKey } : {}), ...(margin !== null && Number.isFinite(margin) ? { margin: Number(margin.toFixed(3)) } : {}),
    });
  }
  ranked.sort((a, b) => b.utility - a.utility || a.spec.localeCompare(b.spec));
  const top = ranked.slice(0, 5);
  // The reason names the kind whenever one was asked: keyed on its buckets, or why not (the seat has none).
  const kindNote = kind ? `; kind ${kind}` : askedKind ? `; kind ${askedKind}: seat has no ${askedKind} bench bucket — lane evidence` : '';
  const stay = (why: string): ModelPick => ({
    spec: seat, changed: false, seat, reason: `${why}${kindNote}`, expectedTtftMs: seatEv?.ttftP50Ms ?? null, seatUtility, ranked: top,
    ...(kind ? { kind } : {}),
  });
  if (seatUtility === null) return stay(`seat ${seat} unmeasured on ${lane} — no comparison, seat stands`);
  const best = ranked.find((r) => r.spec !== seat);
  if (!best) return stay(kind ? `no measured alternative with a ${kind} bucket on ${lane}${noKindBucket ? ` (${noKindBucket} measured without one)` : ''}` : `no measured alternative on ${lane}`);
  // The best-ranked candidate that clears ITS margin (a fixed SWITCH_MARGIN on a lane pick ⇒ exactly "the best, if it
  // clears"; a kind pick's margin shrinks with deeper buckets, so a slightly lower-ranked but better-measured
  // candidate may clear where the top one does not).
  const marginOf = (r: RankedModel) => r.margin ?? SWITCH_MARGIN;
  const chosen = ranked.find((r) => r.spec !== seat && r.utility - seatUtility >= marginOf(r));
  if (!chosen) {
    return stay(`seat ${seat} (u ${seatUtility.toFixed(2)}) ≥ best ${best.spec} (u ${best.utility.toFixed(2)}) − margin${kind ? ` ${marginOf(best).toFixed(2)}` : ''}`);
  }
  if (lane !== 'quick' && seatEv!.quality !== null && chosen.quality !== null && chosen.quality < seatEv!.quality - QUALITY_SLACK) {
    return stay(`best ${chosen.spec} is faster but quality ${chosen.quality.toFixed(2)} < seat ${seatEv!.quality.toFixed(2)} − ${QUALITY_SLACK}`);
  }
  // The chosen candidate is always in the returned ranking (a kind pick may choose below the top 5 — the sticky lead
  // and the readouts look it up there).
  const rankedOut = top.some((r) => r.spec === chosen.spec) ? top : [...top.slice(0, 4), chosen];
  return {
    spec: chosen.spec, changed: true, seat, seatUtility, ranked: rankedOut, expectedTtftMs: chosen.ttftP50Ms,
    reason: `${chosen.spec} (q ${chosen.quality?.toFixed(2)}, ~${fmtS(chosen.ttftP50Ms)}${fmtUsd(chosen.usd)}, u ${chosen.utility.toFixed(2)}) over seat ${seat} (q ${seatEv!.quality?.toFixed(2) ?? '?'}, ~${fmtS(seatEv!.ttftP50Ms)}${fmtUsd(seatUsd)}, u ${seatUtility.toFixed(2)}) on ${lane}${(stakes ?? 0) >= HIGH_STAKES ? ', high stakes' : ''}${kind ? `${kindNote} (margin ${marginOf(chosen).toFixed(2)})` : kindNote}`,
    ...(kind ? { kind } : {}),
  };
}

// ── ROLE picks: the Quick model, the checker, the council colleagues (roster 2026-10-06 C-3) ─────────────────────
// Today those three are fixed seats (chat_quick → Helper, double_checker, double + triple checker). The same utility
// as the lead pick (quality − wait − failures − cost) chooses each from its Auto pool (or, when the admin configured
// none, every catalog model — exactly like the lead), with two role rules:
//   FAMILY  a checker / colleague is never of the lead's family (nor of an earlier colleague's) — an independent
//           second opinion. When the SEAT itself shares the lead's family (or is already on the turn), the best
//           measured other-family candidate takes the slot without the switch margin (independence is the point),
//           never one materially worse than the seat (QUALITY_SLACK); none measured ⇒ the seat stands (the caller's
//           lead-side family guard still applies).
//   QUICK   the Quick lane runs thinking OFF (coding-model.ts fastSeatProvider): only a model whose thinking the lane
//           can switch off may take it — a registry model flagged "no-think", a DeepSeek built-in (thinking
//           disabled) — or the seat itself (today's model, unchanged).
// Pure; the caller (role-pick.ts) loads the evidence / pools and decides whether the pick ACTS (canary / act).
// 2026-10-20: role picks are NOT kind-aware (no `kind` reaches pickModel from here) — only the lead pick reads the
// turn's job type; a kind-strong checker / colleague is a later readout's call, not this wave's.

export type PickRole = 'quick' | 'checker' | 'colleague';
/** The lane whose evidence + waiting price a role is judged on: the checker runs beside a checked-shaped answer,
 *  colleagues are research. */
export const ROLE_LANE: Readonly<Record<PickRole, PickLane>> = { quick: 'quick', checker: 'checked', colleague: 'research' };

export interface RolePickInput {
  role: PickRole;
  stakes: number | null;
  /** Images ride the turn (only the Quick lead sees them — peers get a text description). */
  images: boolean;
  /** The model this slot runs without a pick (its seat). */
  seat: string;
  candidates: readonly PickCandidate[];
  evidence: (spec: string, lane: PickLane) => ModelEvidence | null;
  familyOf: (spec: string) => string;
  /** Families this slot may not share (the lead's; an earlier colleague's). */
  avoidFamilies?: ReadonlyArray<string | null | undefined>;
  /** Specs this slot may not take (the lead; an earlier colleague). */
  exclude?: readonly string[];
  cost?: PickCost | null;
  minEvidenceN?: number;
}

export interface RolePick extends ModelPick {
  role: PickRole;
  /** The seat shared the lead's family (or was already on the turn): the slot switched for INDEPENDENCE, not margin. */
  familyForced: boolean;
}

/** May this model run the Quick lane with thinking off? Pure. */
export function quickThinkingOffCapable(c: PickCandidate, seat: string, familyOf: (spec: string) => string): boolean {
  if (c.spec === seat) return true;
  if (c.thinkingOff) return true;
  return c.source === 'builtin' && (c.family ?? familyOf(c.spec)) === 'deepseek';
}

/** Choose the model for one Quick / checker / colleague slot. Pure; never throws. */
export function pickForRole(i: RolePickInput): RolePick {
  const lane = ROLE_LANE[i.role];
  const avoid = new Set((i.avoidFamilies ?? []).filter((f): f is string => !!f && f !== 'other'));
  const exclude = new Set(i.exclude ?? []);
  const eligible = i.candidates.filter((c) => !exclude.has(c.spec) && !avoid.has(c.family ?? i.familyOf(c.spec))
    && (i.role !== 'quick' || quickThinkingOffCapable(c, i.seat, i.familyOf)));
  const base = pickModel({
    lane, stakes: i.stakes, images: i.role === 'quick' ? i.images : false, seat: i.seat, candidates: eligible,
    evidence: i.evidence, minEvidenceN: i.minEvidenceN, cost: i.cost ?? null,
  });
  const seatFamily = i.familyOf(i.seat);
  const seatConflict = exclude.has(i.seat) || avoid.has(seatFamily);
  if (!seatConflict) return { ...base, role: i.role, familyForced: false };
  const seatEv = i.evidence(i.seat, lane);
  const floor = lane !== 'quick' && seatEv && seatEv.quality !== null ? seatEv.quality - QUALITY_SLACK : null;
  const alt = base.ranked.find((r) => r.spec !== i.seat && (floor === null || (r.quality ?? 0) >= floor));
  const why = exclude.has(i.seat) ? `seat ${i.seat} is already on this turn` : `seat ${i.seat} shares the lead's ${seatFamily} family`;
  if (!alt) {
    return { ...base, spec: i.seat, changed: false, expectedTtftMs: seatEv?.ttftP50Ms ?? null, role: i.role, familyForced: false,
      reason: `${why}; no measured other-family candidate — seat stands` };
  }
  return {
    ...base, spec: alt.spec, changed: true, expectedTtftMs: alt.ttftP50Ms, role: i.role, familyForced: true,
    reason: `${alt.spec} (q ${alt.quality?.toFixed(2) ?? '?'}, ~${fmtS(alt.ttftP50Ms)}${fmtUsd(alt.usd)}) — ${why} (independent ${i.role})`.slice(0, 400),
  };
}

/**
 * Order an already-filtered candidate list (e.g. Team D's call_in pickCallInModels: pool order, other family than the
 * lead, servable) by the role utility — roster 2026-10-06 C-3 for call_in. Candidates with bench evidence (n ≥
 * MIN_EVIDENCE_N and a quality score) come first, best utility first (quality − wait − failures − cost); the rest keep
 * their given order after them (no live exploration: an unmeasured model is never promoted over a measured one, and
 * never dropped — the caller's own order stands among them). Pure.
 */
export function rankForRole<T extends { spec: string }>(role: PickRole, items: readonly T[], i: {
  stakes: number | null;
  evidence: (spec: string, lane: PickLane) => ModelEvidence | null;
  cost?: PickCost | null;
  minEvidenceN?: number;
}): Array<T & { utility: number | null; usd?: number }> {
  const lane = ROLE_LANE[role];
  const minN = i.minEvidenceN ?? MIN_EVIDENCE_N;
  const cost = i.cost && i.cost.perUsd > 0 ? i.cost : null;
  const scored = items.map((it, idx) => {
    const ev = i.evidence(it.spec, lane);
    const usd = cost ? turnCostUsd(cost.priceOf(it.spec)).usd : null;
    const u = ev && ev.n >= minN ? utilityOf(ev, lane, i.stakes, usd, cost?.perUsd) : null;
    return { item: it, idx, utility: u === null ? null : Number(u.toFixed(3)), usd };
  });
  scored.sort((a, b) => {
    if (a.utility !== null && b.utility !== null) return b.utility - a.utility || a.idx - b.idx;
    if (a.utility !== null) return -1;
    if (b.utility !== null) return 1;
    return a.idx - b.idx;
  });
  return scored.map((s) => ({ ...s.item, utility: s.utility, ...(s.usd !== null ? { usd: s.usd } : {}) }));
}
