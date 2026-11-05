/**
 * SAA-1.4 — Chain of Recall: recall surfaces append next-hop ids. PHASE 0: OBSERVE-ONLY.
 *
 * THE GAP (docs/FRAMEWORK_BACKLOG.md §SAA-1.4, essay §3.3). Recall returns real
 * ids but a hit does not inline the ids of its NEXT-HOP objects — the parent
 * goal, sibling todos, the run that produced a memory, the receipt behind a
 * claim — so walking from a memory hit to its authoring run is another SEARCH,
 * not a READ. The board reads are the exception that proves the shape is
 * buildable: `goal_get`/`todo_get` already return both dependency directions
 * plus the parent goal brief, i.e. the graph edges exist in the data model and
 * are simply not appended to the recall surfaces.
 *
 * WHAT PHASE 0 SHIPS: the next-hop RESOLVER plus the exact `next:` line format,
 * both measured in production, with the line NOT appended. Phase 1 flips
 * `applied` to true and appends. No new store, no embedding change.
 *
 * ── PHASE 1 (todo 2ef2b254): `applied` IS A REAL BOOLEAN, AND THE APPEND SHIPS ──
 * Phase 0 pinned `RecallChain.applied` to the literal `false`: no render branch
 * existed, so prompts were byte-identical by construction. Phase 1 widens the
 * field to `boolean` deliberately and adds `renderRecallChain`, which appends the
 * `next:` line. The Phase-0 safety property MOVES rather than disappears: the
 * DEFAULT mode is still `observe`, so a box with nothing set appends nothing, and
 * only an explicit opt-in value can change what a reader is shown.
 *
 * THREE STATES:
 *   unset / '' / '0' / junk → mode 'observe' — resolve the hops, LOG them, append nothing.
 *   'apply' / 'rewrite'     → mode 'apply'   — resolve the hops AND append the line.
 *   '1' / 'true' / 'on'     → mode 'off'     — today's behaviour, no row.
 *
 * Kill switch: CHAIN_OF_RECALL_DISABLED=1 (release; =1 stops appending `next:` lines).
 *
 * Pure leaf: no imports, no I/O, no clock. The caller owns the DB read and the
 * metric write — this module only decides WHAT would be appended.
 */

/** The recall surfaces that can carry a next hop today. Closed set, on purpose. */
export const RECALL_CHAIN_SURFACES = ['search_memory', 'get_run_receipts', 'goal_get', 'todo_get'] as const;
export type RecallChainSurface = (typeof RECALL_CHAIN_SURFACES)[number];

/** One graph edge, resolved by the caller from data the surface already read. */
export interface RecallHop {
  /** What the hop points at, in the words a reader would use: 'run', 'goal', 'todo', 'receipt'. */
  kind: 'run' | 'goal' | 'todo' | 'receipt' | 'chat' | 'schedule';
  /** The id itself — full, so the reader can paste it into a read tool. */
  id: string;
  /** Optional one-line gloss (a title, a status). Never invented: absent = omitted. */
  label?: string;
}

/** The three states — same shape as inline-spill, and the same fail-safe floor:
 *  `observe` is the DEFAULT, so deploying this module cannot change a prompt. */
export type RecallMode = 'observe' | 'apply' | 'off';

export interface RecallChain {
  /** WIDENED IN PHASE 1 (todo 2ef2b254) — `true` only when mode is `apply` AND
   *  there was at least one hop to append, i.e. only when a render actually
   *  happened. Truthful rather than constant. See the module header. */
  applied: boolean;
  mode: RecallMode;
  surface: RecallChainSurface | 'unknown';
  hops: RecallHop[];
  /** How many hops this chain appends (apply) or would append (observe). */
  wouldAppendHops: number;
}

/** The kill switch. '1'/'true'/'on' (trimmed, any case) = OFF; anything else = not-off. */
export function chainOfRecallDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = String(env?.CHAIN_OF_RECALL_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * Resolve the mode from the ONE registered switch. Pure.
 *   '1'/'true'/'on'   → 'off'     kill switch: no append, no row (unchanged).
 *   'apply'/'rewrite' → 'apply'   Phase 1: append the `next:` line / field.
 *   anything else     → 'observe' the floor — an unrecognised value can never
 *                                 silently start changing what a reader is shown.
 */
export function chainOfRecallMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): RecallMode {
  if (chainOfRecallDisabled(env)) return 'off';
  const raw = String(env?.CHAIN_OF_RECALL_DISABLED ?? '').trim().toLowerCase();
  return raw === 'apply' || raw === 'rewrite' ? 'apply' : 'observe';
}

/**
 * The `next:` line a Phase-1 apply would append. ONE line regardless of hop
 * count, because the wake block and the read envelopes are char-budgeted and a
 * multi-line chain would be the first thing a later cap cut. Pure.
 */
export function recallChainLine(hops: ReadonlyArray<RecallHop>): string {
  const parts = (Array.isArray(hops) ? hops : [])
    .filter((h) => h && typeof h.id === 'string' && h.id)
    .map((h) => `${h.kind} ${h.id}${h.label ? ` (${h.label})` : ''}`);
  return parts.length ? `next: ${parts.join(' · ')}` : '';
}

/**
 * Redact ids that look like credentials before they ride a metric row. The hop
 * ids are uuids / hex by construction, so this is belt-and-braces against a
 * caller passing something it scraped — a telemetry row must never carry a
 * secret. Pure.
 */
function safeId(id: string): string {
  const s = String(id ?? '').slice(0, 64);
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : '[redacted]';
}

/**
 * Resolve the chain for ONE recall call. Pure; never throws. Hops with no id are
 * dropped (an empty hop is not a hop), duplicates are collapsed keeping FIRST
 * occurrence order (a run that is both the author and the sibling must not be
 * listed twice).
 *
 * `applied` is true only in `apply` mode with at least one hop — see the module
 * header. In `observe` (the default) nothing about a caller's output changes.
 */
export function planRecallChain(
  input: { surface: RecallChainSurface | string; hops: ReadonlyArray<RecallHop | null | undefined> },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RecallChain {
  const surface = (RECALL_CHAIN_SURFACES as readonly string[]).includes(String(input?.surface))
    ? (input.surface as RecallChainSurface)
    : 'unknown';
  const mode = chainOfRecallMode(env);
  if (mode === 'off') {
    return { applied: false, mode: 'off', surface, hops: [], wouldAppendHops: 0 };
  }
  const seen = new Set<string>();
  const hops: RecallHop[] = [];
  for (const h of Array.isArray(input?.hops) ? input.hops : []) {
    if (!h || typeof h.id !== 'string' || !h.id) continue;
    const key = `${h.kind}:${h.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hops.push({
      kind: h.kind,
      id: h.id,
      ...(h.label ? { label: String(h.label).slice(0, 80) } : {}),
    });
  }
  return { applied: mode === 'apply' && hops.length > 0, mode, surface, hops, wouldAppendHops: hops.length };
}

/**
 * THE PHASE-1 RENDER BRANCH — append form, for surfaces whose output is PROSE
 * (a wake block, a memory answer). Returns `text` unchanged unless the chain
 * actually applied, so observe/off are byte-identical by construction.
 *
 * Pure.
 */
export function renderRecallChain(text: string, chain: RecallChain): string {
  if (!chain || !chain.applied || chain.mode !== 'apply') return text;
  const line = recallChainLine(chain.hops);
  if (!line) return text;
  return `${text}\n${line}`;
}

/**
 * THE PHASE-1 RENDER BRANCH — JSON form, for surfaces whose output is an ENVELOPE
 * a caller parses. Adds ONE additive key and touches nothing else, so an existing
 * consumer that ignores unknown keys is unaffected.
 *
 * WHY THIS EXISTS AT ALL (rather than reusing the append form): this repo has a
 * recorded rule that callers parse these envelopes from the FIRST BRACE, so a
 * trailing prose line after the JSON breaks every one of them — goal_create's
 * fidelity note already rides a PROSE PREFIX for exactly this reason. An additive
 * field is the only shape that widens the envelope without moving a byte an
 * existing parser relies on. The key is `next` (not `nextHops`) because it
 * matches the prose form's own label, so a reader sees one vocabulary.
 *
 * Pure: returns the SAME object reference when nothing applied, so a caller can
 * pass its envelope in unconditionally.
 */
export function withRecallChainField<T extends Record<string, unknown>>(envelope: T, chain: RecallChain): T & { next?: string } {
  if (!chain || !chain.applied || chain.mode !== 'apply') return envelope;
  const line = recallChainLine(chain.hops);
  if (!line) return envelope;
  return { ...envelope, next: line };
}

/**
 * The loop-metric meta for a chain — counts and ids only, never the glossed
 * labels (those can carry prose). Returns null when there is nothing to record
 * (kill switch on, or no hops), so an idle recall writes no row. Pure.
 */
export function recallChainMetricMeta(chain: RecallChain, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  // PHASE 1 (todo 2ef2b254): the gate is `mode === 'off'`, NOT `mode === 'observe'`.
  // Phase 0 could bail on anything that was not observe because observe was the
  // ONLY live mode. Keeping that test after the widen would switch the readout off
  // at exactly the moment the feature begins appending `next:` lines — the
  // instrument going blind when its reading finally matters. The spill twin had the
  // identical gate and the identical fix; a case in the Phase-0 pin suite fails on
  // either one left behind.
  if (!chain || chain.mode === 'off' || !chain.hops.length) return null;
  const kinds: Record<string, number> = {};
  for (const h of chain.hops) kinds[h.kind] = (kinds[h.kind] ?? 0) + 1;
  return {
    surface: chain.surface,
    applied: chain.applied === true,
    wouldAppend: chain.hops.length,
    kinds,
    ids: chain.hops.slice(0, 3).map((h) => safeId(h.id).slice(0, 8)),
    ...extra,
  };
}