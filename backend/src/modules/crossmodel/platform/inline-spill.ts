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
 * ── PHASE 1 (todo 2ef2b254): `applied` IS A REAL BOOLEAN, AND A RENDER BRANCH SHIPS ──
 * Phase 0 pinned `applied` to the literal `false` so no call site could read a
 * plan as a rewrite. Phase 1 WIDENS it to `boolean` deliberately (this is the
 * one change the pinning test was built to make loud) and adds the render
 * branch, `renderSpillPointers`. The Phase-0 safety property is not deleted —
 * it MOVES: the default entry point of this module is still `observe`, so a box
 * with nothing set renders byte-identical text exactly as before, and only an
 * explicit `apply` can rewrite. The test file pins BOTH halves.
 *
 * THREE STATES (the third is the one Phase 1 exists to add):
 *   unset / '' / '0' / junk → mode 'observe' — compute the plan, LOG it, text unchanged.
 *   'apply' / 'rewrite'     → mode 'apply'   — compute the plan AND render it.
 *   '1' / 'true' / 'on'     → mode 'off'     — the kill switch: today's caps, no row.
 *
 * `apply` is deliberately an OPT-IN VALUE rather than a new env var: it keeps the
 * registered+forwarded switch surface exactly as the Phase-0 registry row
 * records it (one switch, no new ledger row for a box to be unable to read), and
 * it means the kill switch keeps its documented meaning — `=1` still restores
 * today's per-surface caps verbatim and stops the observation. A caller that
 * was written for Phase 0 needs NO change to stay safe: it ignores `applied`,
 * so observe and off are indistinguishable from it.
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

/** The three states. `observe` is the DEFAULT (and is what every box gets with
 *  nothing set), so this module cannot change an agent's prompt by being
 *  deployed — only by being switched to `apply` on purpose. */
export type SpillMode = 'observe' | 'apply' | 'off';

export interface SpillPlan {
  /** WIDENED IN PHASE 1 (todo 2ef2b254) — `true` only when `mode === 'apply'`,
   *  i.e. when THIS plan's render branch actually rewrote text. Every other mode
   *  reports false, so `applied` is a truthful statement about what happened
   *  rather than a constant. See the module header for why the widen is safe:
   *  the default mode is still `observe`, so an untouched box renders the same
   *  bytes it did in Phase 0. */
  applied: boolean;
  mode: SpillMode;
  surface: InlineSpillSurface | 'unknown';
  /** Segments that were actually cut (elidedChars > 0), in input order. */
  segments: SpillSegment[];
  /** Chars this plan's pointers cost — added to the injected text when `applied`,
   *  reported only (and still charted) when observing. */
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

/** The kill switch. '1'/'true'/'on' (trimmed, any case) = OFF; anything else = not-off. */
export function inlineSpillInjectionDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = String(env?.INLINE_SPILL_INJECTION_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * Resolve the mode from the ONE registered switch. Pure.
 *
 *   '1'/'true'/'on'      → 'off'      kill switch: today's caps, no row (unchanged from Phase 0)
 *   'apply'/'rewrite'    → 'apply'    Phase 1: render the pointers
 *   anything else (incl. unset, '', '0', junk) → 'observe'
 *
 * `observe` is the floor, not an accident: an unrecognised value must never
 * silently START rewriting prompts. That is the same fail-safe direction the
 * Phase-0 module used, kept after the widen.
 */
export function inlineSpillMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): SpillMode {
  if (inlineSpillInjectionDisabled(env)) return 'off';
  const raw = String(env?.INLINE_SPILL_INJECTION_DISABLED ?? '').trim().toLowerCase();
  return raw === 'apply' || raw === 'rewrite' ? 'apply' : 'observe';
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
 * Build the plan for ONE surface call. Pure; never throws.
 *
 * A caller passes every object it just capped (or whole) and gets back the
 * segments that were really cut. `mode:'off'` returns an EMPTY plan with
 * `mode:'off'` — the caller uses that to skip the metric write entirely, which
 * is what makes the kill switch restore today's behaviour including its cost.
 *
 * `applied` is true ONLY in `mode:'apply'`. That is the widen Phase 1 exists to
 * make: in Phase 0 this field was the literal `false` and the type itself was the
 * safety property. Now the property is that `applied` TELLS THE TRUTH — a plan
 * only claims to have rewritten text when it is in the mode that does (and even
 * then only if it had something to render; see renderSpillPointers).
 */
export function planInlineSpill(
  input: { surface: InlineSpillSurface | string; segments: ReadonlyArray<SpillSegment>; droppedRows?: number },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SpillPlan {
  const surface = (INLINE_SPILL_SURFACES as readonly string[]).includes(String(input?.surface))
    ? (input.surface as InlineSpillSurface)
    : 'unknown';
  const mode = inlineSpillMode(env);
  if (mode === 'off') {
    return { applied: false, mode: 'off', surface, segments: [], wouldAddChars: 0, elidedChars: 0, droppedRows: 0, wouldInject: 0 };
  }
  const segments = (Array.isArray(input?.segments) ? input.segments : [])
    .filter((s) => s && typeof s.id === 'string' && s.id && Number(s.elidedChars) > 0)
    .map((s) => ({ id: s.id, elidedChars: Math.floor(Number(s.elidedChars)), readCall: String(s.readCall ?? '') }));
  const wouldAddChars = segments.reduce((n, s) => n + spillPointerLine(s).length + 1, 0);
  const elidedChars = segments.reduce((n, s) => n + s.elidedChars, 0);
  const droppedRows = Math.max(0, Math.floor(Number(input?.droppedRows) || 0));
  // TRUTHFUL `applied` (see the field doc): apply mode is necessary but not
  // sufficient — a segment is only actionable if it carries a read call. The
  // decision-gate state has NO read-back tool, so its losses are observed and
  // charted but nothing can be followed; claiming `applied` there would be the
  // "instrument that reports a fix it did not make" failure this ledger records.
  // renderSpillPointers applies the identical test, so the two agree by rule.
  const followable = segments.some((s) => String(s.readCall ?? '').trim().length > 0);
  return {
    applied: mode === 'apply' && followable,
    mode,
    surface,
    segments,
    wouldAddChars,
    elidedChars,
    droppedRows,
    wouldInject: segments.length + droppedRows,
  };
}

/**
 * THE PHASE-1 RENDER BRANCH. Returns `text` unchanged unless the plan actually
 * applied — so `observe` and `off` are byte-identical by construction, and a
 * caller can wire this in one line without a mode check of its own:
 *
 *   const plan = planInlineSpill({ surface, segments });
 *   const shown = renderSpillPointers(text, plan);
 *   // …record the metric from `plan` as before…
 *
 * The pointers are appended (not woven in) and deduped by read call, because the
 * body's own truncation marker already sits where the cut happened: what the
 * model lacked was not a marker but a FOLLOWABLE CALL. Each unique read call
 * appears once no matter how many segments share it, so a surface that cut ten
 * messages produces ten summary lines and, at most, ten pointers — never a
 * quadratic block that a later cap has to cut again.
 *
 * Pure.
 */
export function renderSpillPointers(text: string, plan: SpillPlan): string {
  if (!plan || !plan.applied || plan.mode !== 'apply' || !plan.segments.length) return text;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of plan.segments) {
    const call = String(s.readCall ?? '').trim();
    if (!call || seen.has(call)) continue;
    seen.add(call);
    lines.push(spillPointerLine(s));
  }
  if (!lines.length) return text;
  return `${text}\n\nFULL CONTENT AVAILABLE — these were cut by a cap, and each call below returns the whole object:\n${lines.join('\n')}`;
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
 *
 * PHASE 1 (todo 2ef2b254): the row is written in `apply` mode TOO — the gate is
 * `mode === 'off'`, not `mode === 'observe'`. Phase 0 could bail on anything
 * that was not observe because observe was the only live mode; keeping that test
 * after the widen would have made the instrumentation go BLIND exactly when the
 * feature started changing prompts, i.e. precisely when someone needs to see how
 * much it is costing. `applied` rides the row so a reader can split "would have"
 * from "did".
 */
export function inlineSpillMetricMeta(plan: SpillPlan, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (!plan || plan.mode === 'off') return null;
  const dropped = Math.max(0, Math.floor(Number(plan.droppedRows) || 0));
  if (!plan.segments.length && !dropped) return null;
  return {
    surface: plan.surface,
    applied: plan.applied === true,
    wouldInject: plan.segments.length + dropped,
    clipped: plan.segments.length,
    droppedRows: dropped,
    elidedChars: plan.elidedChars,
    wouldAddChars: plan.wouldAddChars,
    ids: plan.segments.slice(0, 3).map((s) => String(s.id).slice(0, 8)),
    ...extra,
  };
}