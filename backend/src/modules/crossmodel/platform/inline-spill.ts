/**
 * SAA-1.3 — Inline & Spill context injection. PHASE 0: OBSERVE-ONLY.
 *
 * THE GAP (docs/FRAMEWORK_BACKLOG.md §SAA-1.3, essay §3.3). Digby's injectors are
 * whole-object-or-capped and the caps TRUNCATE rather than spill behind a
 * followable pointer, so the model cannot tell a truncated object from a whole
 * one and each surface re-invents its own cap:
 *
 *   · get_chat_messages      platform-tools.ts  CONTENT_CAP 4000 / TAIL_KEEP 1500
 *   · drain_triage bodies    drain-triage.ts    DRAIN_TRIAGE_BODY_CAP 4000
 *   · decision-gate state    decision-gate.ts   DECISION_STATE_MAX_CHARS 24_000
 *   · supervisor wake block  supervisor-state.service.ts  WAKE_BLOCK_CAP 6000
 *
 * The pointer half already EXISTS in places (`get_chat_messages` returns
 * messageId + hasMore/nextBefore; `search_memory` returns excerpts with source
 * refs) — what is missing is ONE shared injector that emits `id + a summary +
 * "read <tool> <id>"` and spills the remainder behind the existing read tool.
 *
 * ── PHASE 0 IS OBSERVE-ONLY, AND THAT IS ENFORCED BY THE TYPE, NOT BY PROSE ──
 * `SpillPlan.applied` is the literal `false`. There is no branch in this module
 * that can return anything else, so no call site can mistake a plan for a
 * rewrite: the text an agent is shown is byte-identical with the feature on and
 * off, which is exactly what the Phase 0 exit gate asks for. Phase 1 widens
 * `applied` to `boolean` and adds the render branch; until then the only effect
 * of this module on production is ONE loop-metric row per surface call that had
 * something to spill.
 *
 * THE TWO STATES (and there are deliberately only two — Phase 0 does not add a
 * third "on" state, because nothing may be shown differently yet):
 *   unset / '' / '0'  → mode 'observe'  — compute the plan, LOG it, text unchanged.
 *   '1' / 'true'/'on' → mode 'off'      — the kill switch: today's behaviour, no row.
 *
 * Kill switch: INLINE_SPILL_INJECTION_DISABLED=1 (release; =1 restores today's
 * per-surface caps verbatim — i.e. stops even the observation).
 *
 * Pure leaf: no imports, no I/O, no clock. The caller owns the metric write.
 */

/** The surfaces that inject capped prose today. A closed set ON PURPOSE: a new
 *  surface must add its name here, so an unmeasured cap cannot appear silently. */
export const INLINE_SPILL_SURFACES = [
  'chat_messages',
  'drain_triage',
  'decision_gate',
  'supervisor_wake',
  'run_receipts',
  'search_memory',
] as const;
export type InlineSpillSurface = (typeof INLINE_SPILL_SURFACES)[number];

/** One object the current cap cut, described well enough for a Phase-1 apply
 *  to emit a followable pointer without re-reading the object. */
export interface SpillSegment {
  /** The id a reader would cite to get this object back whole. */
  id: string;
  /** How many chars the surface's own cap dropped for THIS object (0 = whole, and
   *  a segment with 0 is never reported — see planInlineSpill). */
  elidedChars: number;
  /** The call that returns the whole object, echoed to the model verbatim on a
   *  Phase-1 apply (e.g. `get_chat_messages({chatId:"…", messageId:"…"})`). */
  readCall: string;
}

export interface SpillPlan {
  /** PHASE 0 INVARIANT — always the literal false. See the module header. */
  applied: false;
  mode: 'observe' | 'off';
  surface: InlineSpillSurface | 'unknown';
  /** Segments that were actually cut (elidedChars > 0), in input order. */
  segments: SpillSegment[];
  /** Chars a Phase-1 apply WOULD add to the injected text. Reported, never applied. */
  wouldAddChars: number;
  /** Total chars the surface dropped across the reported segments — the number the
   *  readout charts ("how much was invisible"). */
  elidedChars: number;
  /**
   * Objects the surface dropped WHOLE — zero chars of them reached the model.
   * This is a SEPARATE class from `segments` and must not be folded into it: a
   * clipped object is one the model partially saw, a dropped object is one it
   * never saw at all, and the whole point of SAA-1.3 is that the second class
   * is currently INVISIBLE everywhere. Counting only segments would re-create
   * exactly that blindness inside the instrument built to expose it.
   */
  droppedRows: number;
  /** Objects a Phase-1 apply would give a pointer for = segments + droppedRows. */
  wouldInject: number;
}

/** The kill switch. '1'/'true'/'on' (trimmed, any case) = OFF; anything else = observe. */
export function inlineSpillInjectionDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = String(env?.INLINE_SPILL_INJECTION_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * The pointer line a Phase-1 apply would inject for one segment. Exported in
 * Phase 0 because BOTH the test and the readout need the exact bytes a future
 * apply would add — and because a summary the model can actually act on is the
 * part of this feature that is worth designing before it ships. Pure.
 */
export function spillPointerLine(s: SpillSegment): string {
  const n = Math.max(0, Math.floor(Number(s.elidedChars) || 0));
  return `… [${n} chars not inlined — read them: ${s.readCall}]`;
}

/**
 * Build the observe-only plan for ONE surface call. Pure; never throws.
 *
 * A caller passes every object it just capped (or whole) and gets back the
 * segments that were really cut. `mode:'off'` returns an EMPTY plan with
 * `mode:'off'` — the caller uses that to skip the metric write entirely, which
 * is what makes the kill switch restore today's behaviour including its cost.
 */
export function planInlineSpill(
  input: { surface: InlineSpillSurface | string; segments: ReadonlyArray<SpillSegment>; droppedRows?: number },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SpillPlan {
  const surface = (INLINE_SPILL_SURFACES as readonly string[]).includes(String(input?.surface))
    ? (input.surface as InlineSpillSurface)
    : 'unknown';
  if (inlineSpillInjectionDisabled(env)) {
    return { applied: false, mode: 'off', surface, segments: [], wouldAddChars: 0, elidedChars: 0, droppedRows: 0, wouldInject: 0 };
  }
  const segments = (Array.isArray(input?.segments) ? input.segments : [])
    .filter((s) => s && typeof s.id === 'string' && s.id && Number(s.elidedChars) > 0)
    .map((s) => ({ id: s.id, elidedChars: Math.floor(Number(s.elidedChars)), readCall: String(s.readCall ?? '') }));
  const wouldAddChars = segments.reduce((n, s) => n + spillPointerLine(s).length + 1, 0);
  const elidedChars = segments.reduce((n, s) => n + s.elidedChars, 0);
  const droppedRows = Math.max(0, Math.floor(Number(input?.droppedRows) || 0));
  return { applied: false, mode: 'observe', surface, segments, wouldAddChars, elidedChars, droppedRows, wouldInject: segments.length + droppedRows };
}

/**
 * The loop-metric meta for a plan — counts only, NEVER injected text (house rule:
 * a telemetry row must not carry the prose it is measuring). Returns null when
 * nothing is worth recording (kill switch on, or nothing was lost), so the caller
 * writes no row for an idle call. Pure.
 *
 * WHOLE-ROW DROPS COUNT AS A LOSS. An earlier version bailed on
 * `!plan.segments.length`, which meant the drain-triage case this feature exists
 * to expose — a batch so large that whole rows are skipped at `budget <= 0` —
 * wrote NO row at all, because those rows produce no per-row segment. That is
 * the instrument reproducing the blindness it was built to measure (independent
 * review, 2026-11-02). `droppedRows` is therefore part of the emptiness test,
 * not just an extra field.
 */
export function inlineSpillMetricMeta(plan: SpillPlan, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (!plan || plan.mode !== 'observe') return null;
  const dropped = Math.max(0, Math.floor(Number(plan.droppedRows) || 0));
  if (!plan.segments.length && !dropped) return null;
  return {
    surface: plan.surface,
    wouldInject: plan.segments.length + dropped,
    clipped: plan.segments.length,
    droppedRows: dropped,
    elidedChars: plan.elidedChars,
    wouldAddChars: plan.wouldAddChars,
    ids: plan.segments.slice(0, 3).map((s) => String(s.id).slice(0, 8)),
    ...extra,
  };
}