/**
 * TICKET efdb3d31 — the GATEWAY-OR-OURS verdict must survive the READ surface.
 *
 * WHY THIS FILE EXISTS (measured, 2026-10-29 — not stylistic).
 *
 * The discriminator asks one question: did the gateway never send the bytes, or
 * did WE drop them while accumulating? It answers with
 *
 *     receivedBytes     = bytes the SSE deltas actually handed us
 *     accumulatedBytes  = bytes we managed to put in the slot table
 *     undrainedBufferBytes = the un-drained SSE tail at finish()
 *     droppedBytes      = received - accumulated
 *
 * and every stored row is read through a surface that CUTS meta at
 * TELEMETRY_META_CHARS (240, fleet-telemetry.ts). So a verdict that arrives
 * after char 240 is a verdict nobody can check against its own arithmetic.
 *
 * PR #2087 tried to fix that by writing `culprit` FIRST in the meta object.
 * THAT CANNOT WORK, and the deploy proved it:
 *
 *   loop_metrics.meta is a Prisma `Json` over a Postgres JSONB column
 *   (migration 20260902000000_loop_metrics/migration.sql:17 — `"meta" JSONB`).
 *   jsonb does NOT preserve insertion order. It canonicalises object keys by
 *   LENGTH first, then bytewise, so a 7-char key is always emitted after every
 *   5-char key no matter how it was written.
 *
 * Live proof from the 70cb50de deploy, ONE event, two sinks:
 *   warn line : "GATEWAY-OR-OURS culprit=gateway receivedBytes=1810 …"  (new order — a text log, order survives)
 *   meta row  : {"label","model","named","slots","broken","claims","culprit",…  (canonical order — PR #2087's reorder discarded)
 *
 * So the writer's key order is not a lever here. The only reliable lever is key
 * LENGTH: a 2-char key sorts ahead of every longer key in the row, so it is
 * always inside the cut. This module composes that key, and carries the
 * arithmetic INSIDE its value so the verdict and its justification travel
 * together and cannot be split by a truncation.
 */

/** Inputs the discriminator already computes at the finalize seam. */
export interface FinalizeVerdictInput {
  /** receivedBytes - accumulatedBytes; negative is impossible after the count fix. */
  droppedBytes: number;
  /** buffer.length — the un-drained SSE tail at finish(). */
  undrainedBufferBytes: number;
  receivedBytes: number;
  accumulatedBytes: number;
  fragments: number;
  /**
   * The provider's finish_reason (efdb3d31, 2026-10-29 — MEASURED, not tidy-up).
   *
   * WHY IT HAS TO TRAVEL INSIDE THE SHORT VALUE. `finish_reason` is the only
   * field that separates the two mechanisms still standing once the byte
   * arithmetic has named `gateway`:
   *
   *   finishReason='length' + only a severed head ⇒ the OUTPUT CAP cut the
   *     stream mid-call (and no retry fires: isEmptyTruncatedTurn bails the
   *     moment any tool call exists)
   *   finishReason='tool_calls' (or null) ⇒ the turn ENDED cleanly per the
   *     provider and the bytes were still short — a transport short-send.
   *
   * It used to be written as its own long key (`finishReason`) and in the
   * verbose warn tail. Both are unreadable at the live read surface:
   *
   *   meta : jsonb canonical order ends `broken` at ±238 chars, so `claims`,
   *          `culprit`, `verdict` and `finishReason` all fall past the 240 cut.
   *   warn : the reordered line measured EXACTLY 240 chars on the live row
   *          (22:05:59.211Z), cut at "…finalize diagnosis no_complete_payl" —
   *          `finishReason=` sat in the part that was discarded.
   *
   * So the field the discriminator needs was, in both sinks, the field the cut
   * removed. Carrying it inside the 2-char `gw` value fixes that by
   * construction: `gw` is emitted first, so everything it contains is inside
   * the cut regardless of how long the rest of the row grows.
   */
  finishReason?: string | null;
  /**
   * The transport's own verdict — did the SSE deliver its `data: [DONE]`
   * sentinel? (efdb3d31, 2026-10-30 — MEASURED, not tidy-up.)
   *
   * WHY THIS RIDES IN THE SHORT VALUE. The ORIGINAL (200d9d0b) re-emit guard
   * required `streamCompleted === false`, and it produced ZERO rows in 24h while
   * 44 tool_call_finalize rows piled up in 4h. The reason is visible in this
   * very field's absence from the old row: every one of those rows reads
   * `fr=tool_calls`, i.e. the provider DECLARED the turn complete. A provider
   * that reports `finish_reason: tool_calls` has sent its terminator too, so
   * `streamCompleted` was `true` and that guard's first condition rejected the
   * turn 100% of the time — dead by construction, not dead code, and
   * unfalsifiable from the stored rows because nothing recorded the flag. `sc=`
   * makes the flag observable on every finalize row.
   *
   * ⚠ CORRECTED 2026-10-30 (this paragraph previously said, in the PRESENT
   * tense, that the guard "IS gated on `streamCompleted === false`"). That is
   * the RETIRED form and it stayed here after the correction shipped, where it
   * mis-led a Fleet read into proposing a gate widening that was already
   * implemented. The SHIPPED gate (severed-stream.ts `shouldReemitSeveredStream`)
   * is STRUCTURAL: it rejects only `streamCompleted === undefined`, so a CLEAN
   * transport (`sc=1`) carrying a mid-structure cut DOES re-emit — pinned by
   * "DOES fire on a CLEAN transport whose payload still stops mid-structure".
   * `sc` is therefore a DISCRIMINATOR over which transport story to tell, not
   * the switch. Do not restate it as a precondition.
   */
  streamCompleted?: boolean;
  /**
   * The parse-fail blind spot (efdb3d31, 2026-10-30).
   *
   * `receivedBytes` is the sum of `function.arguments` lengths on deltas we
   * PARSED. A `data:` frame our JSON reader rejected never reaches that sum, so
   * a `recv == acc` row is only as trustworthy as "no frame failed to parse":
   * whole tool-call fragments can be discarded at the frame boundary and still
   * produce perfect-looking gateway-side arithmetic.
   *
   * `pf` = `data:` lines that failed JSON.parse, `pb` = their total chars, and
   * `pc` = how many of them CONTAINED a `tool_calls` marker (a content-only raw
   * -text token is the legitimate llm.cql path; a parse-failed frame carrying
   * tool-call bytes is the corruption). Lengths and counts only, never content.
   */
  parseFailLines?: number;
  parseFailBytes?: number;
  parseFailToolCalls?: number;
  /**
   * Bytes this turn carried in a tool_calls delta shape the accumulator cannot
   * READ (efdb3d31, 2026-10-30) — legacy `function_call.arguments`, or a
   * top-level `arguments`.
   *
   * WHY IT VOIDS THE VERDICT. The discriminator's whole rule is
   * `received > accumulated ⇒ ours`. Both sides count ONE path
   * (`function.arguments`). A payload shipped on another path contributes to
   * NEITHER side, so the row reads `recv=N acc=N drop=0` and the verdict says
   * **gateway** — a false vendor blame for a defect of ours, which is the one
   * mislabelling this instrument exists to prevent. So a non-zero `ur=` makes
   * `gatewayOrOurs` return 'ours' regardless of the byte arithmetic: the
   * arithmetic is not evidence when part of the stream was never counted.
   *
   * This is the same class as `parseFailLines` (a frame we dropped before it
   * reached the sum) and renders the same way — only when non-zero.
   */
  unreadArgBytes?: number;
  /**
   * Lines the SSE frame reader skipped BEFORE any counter could see them
   * (efdb3d31, 2026-10-30 firing 6).
   *
   * `receivedBytes` is a sum over `data:` frames we parsed. A line that does not
   * start with `data:` is dropped by the reader at the loop head, so payload
   * carried on such a line — a frame split across several lines, or one emitted
   * with the prefix lost — enters NEITHER side of the subtraction. The row then
   * reads `recv=N acc=N drop=0` and the verdict says **gateway**.
   *
   * Legitimate SSE (blank separators, `:` comments, `event:`/`id:`/`retry:`)
   * is not counted; anything else is unread payload. This is the same class as
   * `parseFailLines` and `unreadArgBytes`: bytes that never reached the sum
   * cannot be evidence about the sum.
   */
  skippedRawLines?: number;
  skippedRawBytes?: number;
  /**
   * SSE events that arrived split across several `data:` lines (efdb3d31,
   * firing 6). The SSE spec joins those with "\n" before the payload is
   * interpreted; this reader parses each `data:` line as its own JSON document,
   * so a spec-compliant split frame fails to parse by construction. Counting
   * the shape makes it observable instead of inferred.
   */
  multilineDataEvents?: number;
}

export type GatewayOrOurs = 'gateway' | 'ours';

/**
 * The discriminator's rule, in ONE place. received === accumulated AND nothing
 * is left in the buffer ⇒ the gateway sent the payload short. Anything else ⇒
 * we dropped bytes (the DUPLICATE_FRAGMENT / UNRESOLVABLE_SLOT branches, or an
 * undrained tail) and blaming the gateway would open a false vendor ticket.
 */
export function gatewayOrOurs(i: Pick<FinalizeVerdictInput, 'droppedBytes' | 'undrainedBufferBytes' | 'unreadArgBytes' | 'skippedRawLines' | 'parseFailToolCalls' | 'parseFailLines' | 'multilineDataEvents'>): GatewayOrOurs {
  // efdb3d31 (2026-10-30): an unread argument shape VOIDS the arithmetic. If
  // part of the stream never entered `receivedBytes`, "received === accumulated"
  // proves only that we counted the same subset twice — not that the gateway
  // sent the payload short. Blaming the vendor off a measurement that never saw
  // the whole stream is the exact false ticket this rule exists to prevent.
  if ((i.unreadArgBytes ?? 0) > 0) return 'ours';
  // efdb3d31 (2026-10-30, firing 6): the SAME rule for a line the frame reader
  // skipped before any counter ran. `receivedBytes` is a sum over `data:` frames
  // we parsed, so payload on a line without that prefix — a spec-compliant
  // multi-line event, or a frame emitted with its prefix lost — contributes to
  // neither side and would read as a clean `drop=0` handed to the gateway.
  if ((i.skippedRawLines ?? 0) > 0) return 'ours';
// efdb3d31 (2026-10-30, firing 6 CORRECTION): `pc` — a `data:` frame we could
  // not JSON.parse that CARRIED tool-call bytes. Firing 6's first cut documented
  // this input as closed while still ignoring it (the doc said "pf/pb/pc did NOT
  // void a gateway verdict ... Both closed" — the code only ever added
  // `ur=`/`skippedRawLines`). An independent review caught the false claim.
  // The arithmetic cannot speak for a frame the parser rejected: those bytes
  // never reached `receivedBytes`, so `recv == acc` again proves only that we
  // counted the same subset twice. A bare raw-text token (the legitimate
  // llm.cql fallback, `pc = 0`) does NOT void — only tool-call bytes do.
  if ((i.parseFailToolCalls ?? 0) > 0) return 'ours';
  // The one remaining silent-loss shape: a payload SPLIT across several `data:`
  // lines that also failed to parse. Void only on the CONJUNCTION — a
  // spec-compliant multi-line event whose lines each parse loses nothing, so
  // voiding on `ml` alone would manufacture false 'ours' verdicts, the
  // mirror-image of the false 'gateway' verdict this rule exists to prevent.
  if ((i.parseFailLines ?? 0) > 0 && (i.multilineDataEvents ?? 0) > 0) return 'ours';
  return i.droppedBytes === 0 && i.undrainedBufferBytes === 0 ? 'gateway' : 'ours';
}

/**
 * The short key the verdict rides. Two characters is deliberate: jsonb orders
 * by key length first, so every 2-char key is emitted before the 4-char
 * (`mode`), 5-char (`label`/`model`/`named`/`slots`) and longer keys the stamp
 * merge adds. A longer, prettier name (`gatewayOrOurs`, `culprit`) provably
 * lands AFTER them and gets cut.
 */
export const FINALIZE_VERDICT_KEY = 'gw';

/**
 * A compact, self-justifying one-line verdict — e.g.
 *   "gateway recv=39 acc=39 drop=0 frag=6 buf=0 fr=tool_calls"
 * Short enough that the verdict AND its arithmetic both sit inside the read
 * cut, which is the whole point (a bare verdict invites a re-litigation every
 * time it is read).
 *
 * `fr=` rides HERE, not in a long key (efdb3d31, 2026-10-29). Once the byte
 * arithmetic names `gateway`, finish_reason is what separates an output-cap cut
 * ('length') from a clean per-provider end that still arrived short
 * ('tool_calls'/null) — the two mechanisms left standing. Measured on the live
 * 22:05:59.211Z row, the verbose `finishReason=` sat past the 240-char read cut
 * in BOTH sinks, i.e. the field the discriminator needs was exactly the field
 * the cut removed. `gw` is emitted first, so anything inside it is unlosable.
 *
 * An ABSENT reason renders 'fr=null' rather than being omitted: "the provider
 * told us nothing" is itself a discriminator value, and a missing token would
 * be ambiguous with an older row that predates this field.
 */
export function finalizeVerdictSummary(i: FinalizeVerdictInput): string {
  const culprit = gatewayOrOurs(i);
  // efdb3d31 (2026-10-30): `sc=` is ALWAYS rendered — including `sc=?` for a
  // caller that did not supply it. The re-emit guard keys on this exact value,
  // so "we never recorded it" must be visibly distinct from "it was false";
  // a silently omitted token is how the guard stayed dead and unreadable.
  const sc = i.streamCompleted === undefined ? '?' : i.streamCompleted ? '1' : '0';
  // `pf=`/`pb=`/`pc=` render ONLY when a frame actually failed to parse: a zero
  // on every row would pad the short value and push `fr=`/`sc=` toward the read
  // cut on the overwhelmingly common clean turn. Absence means clean.
  const pf = (i.parseFailLines ?? 0) > 0
    ? ` pf=${i.parseFailLines} pb=${i.parseFailBytes ?? 0} pc=${i.parseFailToolCalls ?? 0}`
    : '';
  // `ur=` renders on the same render-only-when-nonzero rule (efdb3d31,
  // 2026-10-30): a zero on every clean row would be pure padding, and the whole
  // point of this value is to stay inside the read cut. When it IS present the
  // verdict already reads 'ours' — the two travel together by construction, so
  // no reader can see `culprit=gateway` next to unread bytes.
  const ur = (i.unreadArgBytes ?? 0) > 0 ? ` ur=${i.unreadArgBytes}` : '';
  // `sk=`/`ml=` render on the same render-only-when-nonzero rule (efdb3d31,
  // 2026-10-30 firing 6). `sk` = lines the frame reader skipped unread (their
  // bytes entered neither side of recv-vs-acc, so the verdict already reads
  // 'ours'); `ml` = events that arrived split across several `data:` lines.
  const sk = (i.skippedRawLines ?? 0) > 0 ? ` sk=${i.skippedRawLines} sb=${i.skippedRawBytes ?? 0}` : '';
  const ml = (i.multilineDataEvents ?? 0) > 0 ? ` ml=${i.multilineDataEvents}` : '';
  return `${culprit} recv=${i.receivedBytes} acc=${i.accumulatedBytes} drop=${i.droppedBytes} frag=${i.fragments} buf=${i.undrainedBufferBytes} fr=${i.finishReason ?? 'null'} sc=${sc}${pf}${ur}${sk}${ml}`;
}

/**
 * The meta fields the finalize seam writes. The short `gw` key is the
 * durable-read surface; the long keys stay for programmatic readers that fetch
 * the row directly (JSON path extraction is not truncated).
 */
export function finalizeVerdictFields(i: FinalizeVerdictInput): Record<string, unknown> {
  return {
    [FINALIZE_VERDICT_KEY]: finalizeVerdictSummary(i),
    culprit: gatewayOrOurs(i),
    receivedBytes: i.receivedBytes,
    accumulatedBytes: i.accumulatedBytes,
    droppedBytes: i.droppedBytes,
    fragments: i.fragments,
    undrainedBufferBytes: i.undrainedBufferBytes,
    finishReason: i.finishReason ?? null,
    // efdb3d31 (2026-10-30): kept on BOTH surfaces — the short `gw` value is
    // what survives the read cut, these long keys are what a direct JSON-path
    // reader gets. They must never disagree; both come from one input object.
    streamCompleted: i.streamCompleted ?? null,
    ...((i.unreadArgBytes ?? 0) > 0 ? { unreadArgBytes: i.unreadArgBytes } : {}),
    ...((i.parseFailLines ?? 0) > 0
      ? { parseFailLines: i.parseFailLines, parseFailBytes: i.parseFailBytes ?? 0, parseFailToolCalls: i.parseFailToolCalls ?? 0 }
      : {}),
    // efdb3d31 (2026-10-30, firing 6): the frame-reader blind spot, same
    // render-only-when-nonzero rule as `ur=`/`pf=`.
    ...((i.skippedRawLines ?? 0) > 0
      ? { skippedRawLines: i.skippedRawLines, skippedRawBytes: i.skippedRawBytes ?? 0 }
      : {}),
    ...((i.multilineDataEvents ?? 0) > 0 ? { multilineDataEvents: i.multilineDataEvents } : {}),
  };
}

/**
 * Emulate Postgres jsonb key canonicalisation: shortest key first, then
 * bytewise. JS `<` on ASCII keys is code-unit order, which matches the memcmp
 * jsonb uses.
 *
 * Kept in production code (not just the test) because it IS the contract this
 * module is written against — the reason a 2-char key exists at all. Tests use
 * it to assert what the DATABASE will hand a reader, rather than what the
 * writer happened to build.
 */
export function jsonbCanonicalKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** The JSON a reader actually receives, in the order jsonb will return it. */
export function canonicalMetaJson(obj: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const k of jsonbCanonicalKeys(obj)) ordered[k] = obj[k];
  return JSON.stringify(ordered);
}