/**
 * ONE id resolver for every id-taking platform tool (audit 2026-10-08 W3-3 —
 * SOTA quick win #2; supervisors F7, 10-06 fleet F7).
 *
 * Wake blocks rendered chat ids as SUFFIXES ("chat …ec52d820") while every tool
 * resolved PREFIXES, so models spliced the two: Schooltime called
 * get_chat_status with "0037460b-ec52d820", "0037460b-b60b-456e-977f-a3127ec52d820",
 * "0037460b-dc06-4a94-81e9-ec52d820", "0037460b-ec52-d820", "…ec52d820" — 13
 * failed lookups in 24 h; 73 failed calls in 52 h fleet-wide, every one holding
 * the correct 8-char prefix. Healing was per family (goal/todo near-match, a
 * project heal, a chat "Did you mean", a separate resolve_id tool) and nobody
 * accepted a suffix.
 *
 * This leaf is the shared HEAL tier the family resolvers call after their own
 * exact / unique-prefix tiers miss:
 *   - a PREFIX of ≥ 8 chars (a trailing "…" / "..." is stripped)  → unique match;
 *   - a SUFFIX of ≥ 8 chars (a leading "…" / "...", or a bare 8–12-hex token
 *     that matches no prefix)                                      → unique match;
 *   - a SPLICE — the right 8-char prefix plus the right tail with an invented or
 *     missing middle ("0037460b-ec52d820", a 37-char over-long id)  → the ONE row
 *     carrying both (never for a well-formed 36-char id — a full id that misses
 *     is a typo, the family's ≤2-character near-match tier owns it);
 *   - ambiguous → { ok:false, reason:'ambiguous', candidates } (never a guess);
 *   - nothing   → { ok:false, reason:'not_found', candidates: same-prefix rows }.
 * Scope is the CALLER's: the family passes lookups that already apply its own
 * visibility rule (owner-scoped chats / schedules / hooks, getProjectAccess for
 * goals / todos), so the heal can never widen what a caller sees.
 * Kill switch ID_RESOLVER_HEAL_DISABLED=1 (every family keeps its pre-heal
 * behaviour). Telemetry: loop_metrics `id_ref_heal` {family, via | reason}.
 */
import { recordLoopMetric } from './loop-metrics.service';

export const ID_REF_MIN_CHARS = 8;
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAKE = 6;

export function idResolverHealDisabled(): boolean {
  const v = String(process.env.ID_RESOLVER_HEAL_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface ParsedIdRef {
  /** lower-cased, quotes / ellipses stripped */
  cleaned: string;
  /** cleaned without dashes */
  hex: string;
  /** the input was written as a suffix ("…ec52d820") */
  suffixIntent: boolean;
  /** usable as an id reference at all (hex / dash only, ≥ 8 hex chars) */
  valid: boolean;
}

const LEADING_ELLIPSIS = /^(?:…|\.{2,})\s*/;
const TRAILING_ELLIPSIS = /\s*(?:…|\.{2,})$/;

/** Pure: normalize what a model typed into an id reference. */
export function parseIdRef(raw: unknown): ParsedIdRef {
  let s = String(raw ?? '').trim().replace(/^[`'"([{<]+|[`'")\]}>]+$/g, '').trim();
  const suffixIntent = LEADING_ELLIPSIS.test(s);
  s = s.replace(LEADING_ELLIPSIS, '').replace(TRAILING_ELLIPSIS, '').trim().toLowerCase();
  s = s.replace(/^-+|-+$/g, '');
  const hex = s.replace(/-/g, '');
  const valid = /^[0-9a-f-]+$/.test(s) && /^[0-9a-f]+$/.test(hex) && hex.length >= ID_REF_MIN_CHARS;
  return { cleaned: s, hex, suffixIntent, valid };
}

export interface IdRefLookup {
  /** Full ids IN THE CALLER'S SCOPE starting with `prefix` (lower-case), at most `take`. */
  byPrefix(prefix: string, take: number): Promise<string[]>;
  /** Full ids IN THE CALLER'S SCOPE ending with `suffix` (lower-case), at most `take`. */
  bySuffix(suffix: string, take: number): Promise<string[]>;
}

export type IdRefVia = 'prefix' | 'suffix' | 'splice';
export type IdRefResolution =
  | { ok: true; id: string; via: IdRefVia; input: string }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'not_an_id' | 'disabled'; candidates: string[]; input: string };

const uniq = (ids: string[]): string[] => [...new Set(ids.map((x) => String(x)))];

/**
 * The heal tier. Callers run their exact (and, if they have one, unique-prefix)
 * lookup FIRST and call this only on a miss. Never throws — a lookup error is
 * a not_found.
 */
export async function healIdRef(raw: unknown, lookup: IdRefLookup, family: string): Promise<IdRefResolution> {
  const input = String(raw ?? '');
  if (idResolverHealDisabled()) return { ok: false, reason: 'disabled', candidates: [], input };
  const p = parseIdRef(raw);
  if (!p.valid) return { ok: false, reason: 'not_an_id', candidates: [], input };
  const done = (r: IdRefResolution): IdRefResolution => {
    try {
      recordLoopMetric({
        kind: 'id_ref_heal',
        value: r.ok ? 1 : 0,
        meta: r.ok
          ? { family, via: r.via, typed: p.cleaned.slice(0, 40), resolved: r.id.slice(0, 8) }
          : { family, reason: r.reason, typed: p.cleaned.slice(0, 40), candidates: r.candidates.length },
      });
    } catch { /* telemetry never blocks a lookup */ }
    return r;
  };
  try {
    // ── prefix (unless the input was written as a suffix) ──
    if (!p.suffixIntent) {
      const byPrefix = uniq(await lookup.byPrefix(p.cleaned, TAKE));
      if (byPrefix.length === 1) return done({ ok: true, id: byPrefix[0], via: 'prefix', input });
      if (byPrefix.length > 1) return done({ ok: false, reason: 'ambiguous', candidates: byPrefix, input });
    }
    // ── suffix: an explicit "…tail", or a bare 8–12-hex token no prefix matched ──
    const bareHex = p.cleaned === p.hex && p.hex.length <= 12;
    if (p.suffixIntent || bareHex) {
      const bySuffix = uniq(await lookup.bySuffix(p.cleaned, TAKE));
      if (bySuffix.length === 1) return done({ ok: true, id: bySuffix[0], via: 'suffix', input });
      if (bySuffix.length > 1) return done({ ok: false, reason: 'ambiguous', candidates: bySuffix, input });
      if (p.suffixIntent) return done({ ok: false, reason: 'not_found', candidates: [], input });
    }
    // ── splice: the right 8-char prefix + the right tail, anything (or nothing) in between ──
    // A WELL-FORMED 36-char id is never spliced: a full id that misses is a typo, the family's
    // ≤2-character near-match tier owns it (a head+tail match there could be a different row).
    const head = p.hex.slice(0, ID_REF_MIN_CHARS);
    const tail = p.hex.slice(-ID_REF_MIN_CHARS);
    const samePrefix = uniq(await lookup.byPrefix(head, TAKE * 4));
    if (p.hex.length >= 2 * ID_REF_MIN_CHARS && !FULL_UUID.test(p.cleaned)) {
      const both = samePrefix.filter((id) => id.toLowerCase().replace(/-/g, '').endsWith(tail));
      if (both.length === 1) return done({ ok: true, id: both[0], via: 'splice', input });
      if (both.length > 1) return done({ ok: false, reason: 'ambiguous', candidates: both, input });
    }
    return done({ ok: false, reason: 'not_found', candidates: samePrefix.slice(0, TAKE), input });
  } catch {
    return { ok: false, reason: 'not_found', candidates: [], input };
  }
}

/** One line for a refusal: what was typed, why it did not resolve, the candidates (full ids). */
export function describeIdRefMiss(family: string, r: Extract<IdRefResolution, { ok: false }>): string {
  if (r.reason === 'ambiguous') {
    return `"${r.input}" matches ${r.candidates.length} ${family}s: ${r.candidates.join(', ')} — pass one of these full ids.`;
  }
  if (r.candidates.length) {
    return `No ${family} matches "${r.input}". ${family}s sharing its first 8 characters: ${r.candidates.join(', ')} — pass the full id.`;
  }
  return `No ${family} matches "${r.input}".`;
}
