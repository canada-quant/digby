/**
 * Shared text sanitizers for DB write boundaries.
 *
 * Postgres TEXT/JSONB rejects the NUL byte (0x00) with error 22021
 * (`invalid byte sequence for encoding "UTF8": 0x00`). LLM output, scraped
 * pages, and extracted document text can all carry NULs; one bad row poisons
 * an entire multi-row INSERT batch (prod telemetry 2026-07: 18 lost memory
 * writes/7d — see PR #88, issue #90).
 */

/**
 * Remove NUL bytes (0x00) — Postgres TEXT/JSONB rejects them (error 22021).
 * All other C0 controls are legal in `text`, so they are left untouched.
 */
export function stripNulBytes(s: string): string {
  return s.includes('\u0000') ? s.replace(/\u0000/g, '') : s;
}

/**
 * Strip the two sequences Postgres JSONB/TEXT cannot store from one string:
 * LONE surrogates (U+D800–U+DFFF unpaired → error 22P05 `unsupported Unicode
 * escape sequence` once Prisma serializes them as `\udXXX` into a jsonb
 * parameter) and NUL bytes (0x00 → 22021 in text, 22P05 as `\u0000` in jsonb).
 * VALID surrogate pairs (astral code points, emoji) are preserved intact.
 *
 * Prod 2026-09-24 (FO firing 20): an LLM answer can carry a lone surrogate
 * (truncated thinking, raw byte splice) and then EVERY write of that text
 * fails — agentEvent.create, the final-transcript codingMessage.update, and
 * the mirror upsert all 22P05 (run e8975be5 lost its final transcript 5×,
 * 18 errors/24h). Sanitize at the write boundary instead of failing the run.
 */
export function stripPgUnsafe(s: string): string {
  // Fast path: no surrogate (paired or lone) and no NUL — untouched.
  if (!/[\uD800-\uDFFF\u0000]/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) { out += s[i] + s[i + 1]; i++; continue; } // valid pair
      continue; // lone high surrogate — drop
    }
    if (c >= 0xDC00 && c <= 0xDFFF) continue; // lone low surrogate — drop
    if (c === 0) continue; // NUL — drop
    out += s[i];
  }
  return out;
}

/**
 * Deep PG-safe pass over a JSON-bound value: every string (keys included) is
 * stripped of lone surrogates + NULs; arrays/objects are walked. Dates,
 * Buffers and other non-plain values pass through untouched. The optional
 * `report` object is flipped to `stripped: true` (and counts dropped units)
 * when anything changed — callers use it to emit telemetry only on real hits,
 * never on the clean fast path.
 */
export function pgSafeDeep<T>(v: T, report?: { stripped: boolean; dropped: number }): T {
  if (typeof v === 'string') {
    if (!/[\uD800-\uDFFF\u0000]/.test(v)) return v;
    const clean = stripPgUnsafe(v);
    if (clean !== v && report) { report.stripped = true; report.dropped += v.length - clean.length; }
    return clean as unknown as T;
  }
  if (Array.isArray(v)) {
    const out = v.map((x) => pgSafeDeep(x, report));
    return (report?.stripped ? out : v) as unknown as T;
  }
  if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const ck = pgSafeDeep(k, report);
      const cv = pgSafeDeep(val, report);
      if (ck !== k || cv !== val) changed = true;
      out[ck] = cv;
    }
    return (changed ? out : v) as unknown as T;
  }
  return v;
}

