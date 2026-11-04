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
 * ── OBSERVE-ONLY IS A TYPE INVARIANT, NOT A COMMENT ──
 * `RecallChain.applied` is the literal `false`. There is no render branch in
 * this module, so "prompts are byte-identical with the feature on and off" is
 * true by construction rather than by inspection of every call site. The only
 * production effect is ONE loop-metric row per recall call that HAD a next hop
 * to offer.
 *
 * THE TWO STATES:
 *   unset / '' / '0'  → mode 'observe' — resolve the hops, LOG them, append nothing.
 *   '1' / 'true'/'on' → mode 'off'     — today's behaviour, no row.
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

export interface RecallChain {
  /** PHASE 0 INVARIANT — always the literal false. See the module header. */
  applied: false;
  mode: 'observe' | 'off';
  surface: RecallChainSurface | 'unknown';
  hops: RecallHop[];
  /** How many hops a Phase-1 apply WOULD append. Reported, never applied. */
  wouldAppendHops: number;
}

/** The kill switch. '1'/'true'/'on' (trimmed, any case) = OFF; anything else = observe. */
export function chainOfRecallDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = String(env?.CHAIN_OF_RECALL_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
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
 * Resolve the observe-only chain for ONE recall call. Pure; never throws; never
 * returns an applied plan. Hops with no id are dropped (an empty hop is not a
 * hop), duplicates are collapsed keeping FIRST occurrence order (a run that is
 * both the author and the sibling must not be listed twice).
 */
export function planRecallChain(
  input: { surface: RecallChainSurface | string; hops: ReadonlyArray<RecallHop | null | undefined> },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RecallChain {
  const surface = (RECALL_CHAIN_SURFACES as readonly string[]).includes(String(input?.surface))
    ? (input.surface as RecallChainSurface)
    : 'unknown';
  if (chainOfRecallDisabled(env)) {
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
  return { applied: false, mode: 'observe', surface, hops, wouldAppendHops: hops.length };
}

/**
 * The loop-metric meta for a chain — counts and ids only, never the glossed
 * labels (those can carry prose). Returns null when there is nothing to record
 * (kill switch on, or no hops), so an idle recall writes no row. Pure.
 */
export function recallChainMetricMeta(chain: RecallChain, extra: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (!chain || chain.mode !== 'observe' || !chain.hops.length) return null;
  const kinds: Record<string, number> = {};
  for (const h of chain.hops) kinds[h.kind] = (kinds[h.kind] ?? 0) + 1;
  return {
    surface: chain.surface,
    wouldAppend: chain.hops.length,
    kinds,
    ids: chain.hops.slice(0, 3).map((h) => safeId(h.id).slice(0, 8)),
    ...extra,
  };
}