/**
 * af4ef7c7 — the sighting-fit block, extracted from feedback.service.ts into an
 * IMPORT-FREE-OF-ENV leaf.
 *
 * WHY IT MOVED. The raw-write filer (coding/reflection.ts) must attach a
 * same-class sighting without importing feedback.service.ts: that module's
 * graph reaches `config/env`, whose parseEnv() calls `process.exit(1)` on a
 * bare Jest worker — an UNCATCHABLE failure that killed 5 reflection.* suites
 * when the helper first lived there (measured this run). The description
 * fitting is the only pure part both sides need, so it lives here and both
 * import it. One implementation, no divergence.
 *
 * Behaviour is unchanged from feedback.service.ts (ticket 300802aa) — only the
 * module boundary moved; its tests import `fitBumpedDescription` through the
 * old path, which still re-exports it.
 */

/** The stored-description cap for a feedback ticket. */
export const DESCRIPTION_MAX = 8000;

/**
 * (ticket 300802aa, sighting 5 — 2026-11-02) The sighting-block separator every
 * bump path writes into a ticket description.
 */
export const SIGHTING_SEPARATOR = '\n\n--- sighting ';

/**
 * A separator is only a REAL block boundary when it is followed by a sighting
 * number and the line still closes with "---" — the shape every writer emits
 * (`--- sighting 5 ---`, `--- sighting 5 (reason) ---`). Prose that merely
 * quotes the words ("quoted verbatim: --- sighting "), e.g. a note excerpt
 * carried into a re-filed ticket, must not be mistaken for a boundary: splitting
 * on it would delete or re-header honest text (review 2026-11-02, defect 2).
 */
const SIGHTING_BOUNDARY_RE = /\n\n--- sighting \d[^\n]*---(?=\n|$)/g;

/** Shown when the newest block itself cannot fit the cap whole. */
const TRUNCATION_MARK = ' …[truncated]';

/** Slice without splitting a surrogate pair (an emoji in a note excerpt). */
function safeSlice(s: string, n: number): string {
  if (n >= s.length) return s;
  if (n <= 0) return '';
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** Split a description into its original report + real sighting blocks. */
export function splitSightingBlocks(base: string): { head: string; blocks: string[] } {
  const starts: number[] = [];
  const re = new RegExp(SIGHTING_BOUNDARY_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(base)) !== null) {
    starts.push(m.index);
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (!starts.length) return { head: base, blocks: [] };
  return {
    head: base.slice(0, starts[0]),
    blocks: starts.map((s, i) => base.slice(s + SIGHTING_SEPARATOR.length, starts[i + 1] ?? base.length)),
  };
}

/**
 * (ticket 300802aa) FIT AN APPENDED SIGHTING BLOCK — evicting OLDEST evidence,
 * never the evidence being added.
 *
 * THE DEFECT THIS REPLACES: every bump path used
 *   `appended.length <= DESCRIPTION_MAX ? appended : <the OLD description>`
 * so once a long-lived auto-filed ticket reached the 8000-char cap, EVERY later
 * sighting was silently discarded from the description. Ticket 300802aa is the
 * measured specimen: `context.occurrences` reached 5 and `context.lastSeen`
 * 2026-11-02T03:32:28.580Z, while its description still ended at
 * "--- sighting 4 ---" — the newest sighting's evidence (the ONLY thing a fix
 * lane can adjudicate) was thrown away, on a row that kept counting and kept
 * re-dispatching.
 *
 * The direction matters: the OLDEST evidence is the least actionable and the
 * NEWEST is the whole point of a repeated sighting. Fail toward keeping what
 * the lane must act on.
 *
 * ORDER OF SACRIFICE: 1. drop oldest sighting blocks; 2. shrink the ORIGINAL
 * REPORT by exactly the overflow (never a fixed fraction); 3. only when the
 * new block ALONE exceeds the cap is the block itself cut, and an explicit
 * TRUNCATION_MARK says so. The result is never longer than `max`, for any
 * inputs (property-pinned).
 *
 * Behaviour when the append fits is BYTE-IDENTICAL to the old path; eviction
 * only engages at the cap. Pure + exported for tests.
 */
export function fitBumpedDescription(
  existing: string,
  newBlock: string,
  max: number = DESCRIPTION_MAX,
): string {
  const base = String(existing ?? '');
  const block = String(newBlock ?? '');
  const full = `${base}${SIGHTING_SEPARATOR}${block}`;
  if (full.length <= max) return full; // unchanged path — the append fits

  const { head, blocks } = splitSightingBlocks(base);

  // 1. Evict OLDEST evidence first; the block being added is always kept.
  for (let drop = 1; drop <= blocks.length; drop++) {
    const candidate = [head, ...blocks.slice(drop)].join(SIGHTING_SEPARATOR)
      + SIGHTING_SEPARATOR + block;
    if (candidate.length <= max) return candidate;
  }

  // 2. Every prior block is gone and it still overflows: shrink the original
  // report by EXACTLY the overflow so the new sighting lands whole.
  const roomForHead = max - SIGHTING_SEPARATOR.length - block.length;
  if (roomForHead >= 0) {
    return `${safeSlice(head, roomForHead)}${SIGHTING_SEPARATOR}${block}`;
  }

  // 3. The new block alone is larger than the cap. Keep the report's opening
  // (the ticket's identity) plus as much of the new block as fits, and MARK the
  // cut so a lane can see the evidence was shortened.
  const budget = Math.max(0, max - SIGHTING_SEPARATOR.length - TRUNCATION_MARK.length);
  const headKeep = Math.min(head.length, Math.floor(budget / 4));
  const blockKeep = Math.max(0, budget - headKeep);
  const out = `${safeSlice(head, headKeep)}${SIGHTING_SEPARATOR}${safeSlice(block, blockKeep)}${TRUNCATION_MARK}`;
  // Hard bound: a `max` smaller than the separator+mark still cannot overflow.
  return out.length <= max ? out : safeSlice(out, Math.max(0, max));
}