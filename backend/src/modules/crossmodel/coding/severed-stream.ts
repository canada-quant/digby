/**
 * TICKET efdb3d31 — SEVERED-STREAM RECOVERY (emission side).
 *
 * WHY THIS EXISTS (measured 2026-10-29, not stylistic).
 *
 * A stored `tool_call_finalize` row on the llm-cql custom-endpoint path reads
 *
 *     gw "gateway recv=39 acc=39 drop=0 frag=6 buf=0"
 *     finishReason=tool_calls  slots=1 named=1 unnamed=0
 *
 * Every byte the gateway sent we appended (recv == acc, nothing dropped, nothing
 * left in the buffer) and the payload simply STOPPED — at 17, 39, 41, 67 and 84
 * bytes across rows. Because `finish()` resolves on `end` and `close` alike, a
 * half-built call reached the executor looking exactly like a complete one, and
 * the model was told its arguments "did not parse as a JSON object".
 *
 * The transport tells us the truth and we were discarding it: an
 * OpenAI-compatible SSE stream ends with `data: [DONE]`, and the reader did
 * `if (data === '[DONE]') continue;` — literally dropping the sentinel. That is
 * now recorded as `TurnResult.streamCompleted`, and this module owns the single
 * decision derived from it.
 *
 * NARROWNESS IS THE SAFETY ARGUMENT. The gate is a STRUCTURAL one, and
 * `streamCompleted` is an INPUT to the diagnosis rather than the switch it was
 * originally shipped as.
 *
 * WHY THE SENTINEL-KEYED FORM IS GONE (measured 2026-10-30 — this is a
 * correction to the 200d9d0b guard, not a widening for its own sake). That
 * guard required `streamCompleted === false` AND a structurally truncated
 * payload, and it produced ZERO `severed_stream_recovery` rows in 24 hours
 * while `tool_call_finalize` piled up 44 rows in 4 hours.
 *
 * WHY it could never fire — proved BY ELIMINATION over its own five
 * conditions, not by reading `finish_reason` as if it were the sentinel
 * (independent review D1, 2026-10-30: `finish_reason` lives INSIDE the JSON
 * delta body while `[DONE]` is a SEPARATE SSE frame, so a proxy that forwards
 * the delta and drops the trailing frame produces the same rows with
 * `streamCompleted === false` — that reading is not excluded by `fr=`
 * alone, and an earlier draft of this comment wrongly labelled the inference
 * "measured"). Four of the five conditions are independently cleared on the
 * live rows:
 *
 *   - `SEVERED_STREAM_RECOVERY_DISABLED` unset (only the `${VAR:-}` compose
 *     references exist; the test is `=== '1'`);
 *   - `toolCalls.length > 0` — the rows carry named slots (`named=1`, `frags`
 *     5-186);
 *   - `!hasStructurallyTruncatedCall` — the shipped classifier returns
 *     `shape=truncated` ("Unexpected end of JSON input") for the 39-byte head;
 *   - `alreadyRecovered` — 5+ SEPARATE runs reproduce it, so this is not one
 *     run's later turns;
 *   - `cancelled` — these are dispatch rejects, not cancelled turns.
 *
 * Leaving ONE survivor: the first check, `streamCompleted !== false`. And
 * `undefined` is itself excluded on this reader — `sawDone` initialises to
 * `false` and the only non-cancelled resolve always sets the field — so
 * `streamCompleted` was `true`, i.e. the sentinel ARRIVED on a cut payload.
 * THAT is the elimination that makes the guard dead by construction: its
 * precondition cannot hold on this path, because the transport finishes
 * cleanly and the PAYLOAD is what stops early. Twelve stored cuts at
 * 17/39/41/67/84/666/1961/2078/2781/2943… chars span both shapes and two
 * models on the llm-cql label, so this is the defect's normal form.
 *
 * NOT CLAIMED HERE: why the payload stops. That is a separate fork (upstream
 * delta loss vs our fragment assembly) and this guard speaks only to whether
 * the harness could heal the turn. `sc=` now rides on every row, so the next
 * reproduction confirms the elimination DIRECTLY instead of by inference; and
 * `pf`/`pc`/`sl`/`ni` settle the cause fork.
 *
 * So the switch is now the STRUCTURAL fact (does the payload stop
 * mid-structure?) and `streamCompleted` is only used as a three-valued
 * discriminator over WHICH transport story to tell. The one case that stays
 * out of this lane is `undefined`: a caller-synthesized turn or a provider
 * with no transport information at all, where a short payload is genuinely
 * indistinguishable from a cut. That case keeps the C-2 dispatch-reject-repair
 * lane (agent.ts ~3980, `classifyMalformedToolHistory`) as SOLE owner, with
 * its deliberately tested 400-then-repair sequence — which is exactly why the
 * pinned fixtures in agent-context.c.test.ts (they carry no `streamCompleted`)
 * still never enter this lane.
 *
 * COST: bounded to ONE re-emit per run (`alreadyRecovered`), so a gateway that
 * severs every stream cannot loop us, and a model that persistently emits
 * unfinished JSON pays one extra round-trip and then falls through to the
 * rejection text it gets today.
 */

/** The fields this decision needs — a structural subset of TurnResult, so the
 *  decision is unit-testable without constructing a whole turn. */
import { parseToolArguments } from './tool-arguments';

export interface SeveredStreamTurn {
  /** `false` = the SSE closed without its `[DONE]` sentinel. `true` = clean.
   *  `undefined` = no information (see the narrowness note above). */
  streamCompleted?: boolean;
  toolCalls: Array<{ name?: string; arguments?: string }>;
}

/** ONE re-emit per run. Kill switch restores the pre-fix behaviour exactly. */
export function severedStreamRecoveryDisabled(): boolean {
  return process.env.SEVERED_STREAM_RECOVERY_DISABLED === '1';
}

/**
 * Is at least one of these calls STRUCTURALLY incomplete — does its payload stop
 * mid-structure (inside a string literal, or before a closing brace/bracket)?
 *
 * THIS SECOND CONDITION IS NOT OPTIONAL, and it is the difference between a safe
 * fix and a platform-wide regression. `streamCompleted === false` alone only
 * says "no `[DONE]` sentinel arrived" — and this same reader documents that some
 * OpenAI-compatible gateways (a LiteLLM/vLLM proxy config, llm.cql.ca — see the
 * raw-text fallback at coding-model.ts) NEVER emit the sentinel and simply close
 * the socket. On such a path EVERY turn would read `false`, so a sentinel-only
 * gate would re-emit EVERY tool-calling turn: a doubled round-trip and doubled
 * spend, forever, on the exact endpoint this remedy is meant to heal.
 *
 * Requiring a structurally unfinished payload is the load-bearing condition.
 * On the llm-cql path this is now the ONLY condition that can fire — the
 * transport finishes cleanly and the payload still stops early — so it must
 * stand on its own rather than being an AND-term behind a sentinel that never
 * goes false here. A complete payload is never re-emitted no matter what the
 * transport did, so a sentinel-less provider still costs nothing.
 *
 * Reuses the SHIPPED classifier rather than inventing a second notion of
 * "incomplete": `parseToolArguments` already distinguishes a cut
 * (`shape: 'truncated'`, bytes missing) from a model formatting fault
 * (`shape: 'malformed'`, every byte arrived). Only the former is transport.
 */
export function hasStructurallyTruncatedCall(turn: SeveredStreamTurn): boolean {
  return turn.toolCalls.some(tc => {
    const parsed = parseToolArguments(tc.arguments);
    // An OK parse is complete by definition. A failure is transport-shaped only
    // when the classifier says the payload STOPS mid-structure — a 'malformed'
    // or 'not-object' payload arrived whole and belongs to the C-2 lane.
    return !parsed.ok && parsed.shape === 'truncated';
  });
}

/**
 * Does this turn hold at least one call that arrived WHOLE and USABLE — a
 * sibling worth dispatching even though another call in the same turn was cut?
 *
 * WHY THIS EXISTS (efdb3d31, 2026-10-30 — the mixed-turn arm). The gate above
 * asks "is ANY call truncated?" and then re-requests the ENTIRE turn. That is
 * right when the turn is nothing but a severed head (the 39-byte `goal_update`
 * is the defect's normal form, and there is nothing to execute). It is WRONG
 * for a MIXED turn, where the model emitted one complete call and one severed
 * twin: the complete call is FINISHED WORK that already arrived intact, and the
 * gate throws it away, spends the run's single re-emit and buys a whole extra
 * model round-trip to re-ask for something it could have executed immediately.
 *
 * MEASURED, NOT HYPOTHETICAL. Of the 24 `severed_stream_recovery` rows in the
 * 24 h to 2026-10-30T16:28Z, six carry MORE THAN ONE call and at least one
 * intact payload — `len:[2377,84]` (16:14:04Z, send_chat_message + todo_update),
 * `[31,67]` (14:59:34Z), `[1136,838,41]` (11:32:37Z), `[62,39]` (08:07:58Z),
 * `[1693,641]` (10:47:44Z), `[786,1052,1147,2172]` (06:05:31Z). In every one of
 * those the truncated call was a SMALL, opaque-id-headed tool (todo_update /
 * goal_update / update_schedule) riding beside a large call that parsed — i.e.
 * the exact shape where discarding the batch costs the real work.
 *
 * THE `arguments` GUARD IS LOAD-BEARING, NOT TIDINESS. A call whose payload is
 * absent or an empty string parses "successfully" as `{}`, so counting it as a
 * complete sibling would license a ZERO-ARG MUTATING dispatch off the back of a
 * severed turn — the exact 2026-08-30 audit hazard this module exists to keep
 * shut (a mutating tool fired with args={} while the narration described
 * arguments that never arrived). An empty payload therefore never qualifies.
 */
export function hasStructurallyCompleteCall(turn: SeveredStreamTurn): boolean {
  return turn.toolCalls.some(tc => {
    const raw = tc.arguments as unknown;
    // Absent / blank payload: parses as {} but carries no work. Never a licence
    // to dispatch (see the audit note above).
    if (raw === undefined || raw === null) return false;
    if (typeof raw === 'string' && raw.trim() === '') return false;
    return parseToolArguments(raw).ok;
  });
}

/**
 * Should this turn be re-emitted instead of dispatched?
 *
 * Every condition is load-bearing:
 *  - not disabled           — the kill switch, checked first so it is total;
 *  - a truncated payload    — see hasStructurallyTruncatedCall. THIS is the
 *                             switch now (see the correction note at the top of
 *                             this file): a payload that stops mid-structure is
 *                             transport-shaped whether or not the sentinel
 *                             arrived, and on the llm-cql path the sentinel DOES
 *                             arrive, which is why the old form never fired;
 *  - `!== undefined`        — a synthesized turn / a caller with no transport
 *                             information stays C-2's (see above). `true` and
 *                             `false` both proceed; they differ only in the
 *                             story the telemetry tells;
 *  - `toolCalls.length > 0` — an answer-less turn is `isEmptyTruncatedTurn`'s
 *                             lane (turn-recovery.ts), not this one;
 *  - `!alreadyRecovered`    — bounded: one re-emit per run, so a gateway that
 *                             severs every stream (or a model that keeps
 *                             emitting unfinished JSON) cannot loop us;
 *  - `!cancelled`           — Stop pressed means stop.
 */
export function shouldReemitSeveredStream(
  turn: SeveredStreamTurn,
  alreadyRecovered: boolean,
  cancelled: boolean,
): boolean {
  // ONE RULE, ONE PLACE (efdb3d31, 2026-10-30). This used to re-implement the
  // ladder inline, so the branch and the telemetry were two copies of a rule and
  // the mixed-turn arm would have had to be added to both — precisely the drift
  // shape this module's own test forbids. The verdict function IS the rule.
  return severedStreamVerdict(turn, alreadyRecovered, cancelled) === 'reemit';
}

/**
 * WHY these three values (efdb3d31, 2026-10-30): the guard ran for a day
 * without ever firing and no stored field could say which condition rejected
 * the turn — the Fleet could not tell "unreachable code" from "precondition
 * never holds", and guessed wrong once already.
 *
 * Now every `dispatch_reject` row carries the same three values (`sc`/`fr`/
 * `re` in the meta), so the next reading is a lookup rather than an inference:
 * a rejection whose `sc=1` is a clean transport that still arrived short (this
 * lane's territory, and it should now have re-emitted instead), `sc=0` is a
 * genuinely severed stream, `sc=null` is the C-2 lane's ambiguous case.
 */
export type SeveredStreamVerdict = 'reemit' | 'no-tool-calls' | 'complete-payload' | 'already-recovered' | 'cancelled' | 'no-transport-signal' | 'complete-sibling' | 'disabled';

/** The decision WITH its reason, for logging — `shouldReemitSeveredStream` as a pure tuple. */
export function severedStreamVerdict(
  turn: SeveredStreamTurn,
  alreadyRecovered: boolean,
  cancelled: boolean,
): SeveredStreamVerdict {
  if (severedStreamRecoveryDisabled()) return 'disabled';
  if (turn.toolCalls.length === 0) return 'no-tool-calls';
  if (!hasStructurallyTruncatedCall(turn)) return 'complete-payload';
  if (alreadyRecovered) return 'already-recovered';
  if (cancelled) return 'cancelled';
  if (turn.streamCompleted === undefined) return 'no-transport-signal';
  // ── efdb3d31 (2026-10-30, the mixed-turn arm) ──────────────────────────────
  // Reaching here means the turn holds a cut call and the re-emit budget is
  // UNSPENT — the only state in which this decision still costs something.
  // Re-requesting is right when the turn is nothing BUT a severed head; it is
  // wrong when a sibling call in the same turn arrived whole, because dispatching
  // executes that finished work immediately while a re-emit discards it AND (on
  // the measured population) does not heal: every `re:1` row shows the
  // re-request re-cutting at the same byte. So a mixed turn DISPATCHES — the
  // intact sibling runs, the twin falls through to runTool's per-call rejection
  // text. Deliberately LAST so it can only divert turns that would have
  // returned 'reemit'; every arm above is untouched.
  if (hasStructurallyCompleteCall(turn)) return 'complete-sibling';
  return 'reemit';
}

/**
 * TICKET 192d9087 F2 (2026-10-30) — the PER-TURN half of the re-emit telemetry.
 *
 * WHAT WAS WRONG (measured on live rows, confirmed in code): the two fields that
 * describe a re-emit rode per-RUN state. `ctx.severedReemitLens` was assigned
 * only inside the re-emit branch and never cleared, and `ctx.severedRecovered`
 * was copied from the loop's per-run `severedStreamRecovered` on EVERY turn. So
 * a reject row's `re:1` meant "a re-emit happened at some point in this RUN",
 * and `rl` meant "the lens of some earlier turn" — on every row for the rest of
 * the run. Any reader comparing `rl` against `argLen` was therefore comparing
 * attempt 1's cut against an UNRELATED turn's cut, which is why the family's
 * handoff had to carry a reading rule ("scope the comparison to the FIRST
 * post-recovery row of a run") that no stored field enforced.
 *
 * The fix is the carry below: the re-emit branch hands the lens forward for
 * EXACTLY ONE turn — the retry it just bought — and the turn-start read consumes
 * and clears it. After that the turn's own row has `re:0` and no `rl`.
 *
 * WHY THE BOUNDED GATE STAYS PER-RUN: `severedStreamRecovered` (the ONE re-emit
 * per run) is a COST bound, not telemetry, and it is untouched. Only what a row
 * REPORTS about it became per-turn. Widening the gate was refuted separately
 * (PR #2161 closed unmerged) — this changes no behaviour of the gate itself.
 */
export interface ReemitTurnTelemetry {
  /** `re` — 1 iff THIS turn is the retry a re-emit bought, else 0. */
  re: 0 | 1;
  /** `rl` — the argLens of the attempt that re-emit replaced; ONLY on that retry. */
  rl?: string;
}

/** The per-RUN carry: at most one pending lens, for at most one turn. */
export interface ReemitTurnCarry {
  pending?: string;
}

/** Record that this turn's cut was re-requested — `lens` rides the NEXT turn only. */
export function noteReemit(carry: ReemitTurnCarry, lens: string): void {
  carry.pending = lens;
}

/**
 * Read (and consume) the carry at TURN START. The second turn after a re-emit —
 * and every turn that never followed one — gets `{ re: 0 }` with no `rl`, which
 * is the whole point: a row must not describe an earlier turn's re-emit.
 */
export function beginTurn(carry: ReemitTurnCarry): ReemitTurnTelemetry {
  const pending = carry.pending;
  carry.pending = undefined;
  if (pending === undefined) return { re: 0 };
  return { re: 1, rl: pending };
}

/**
 * The loop-metric meta for one re-emit.
 *
 * `rz` and `len` are SHORT on purpose and they are the point of the row: no
 * stored finalize or dispatch_reject row has ever carried reasoningChars, so the
 * Fleet's "reasoningChars vs argLen" probe was unanswerable from data. This row
 * computes BOTH for the SAME turn. Short keys because the reader cuts meta at
 * TELEMETRY_META_CHARS (240) and jsonb orders keys by length — a 2-char key
 * always survives.
 *
 * Byte-free: lengths and names only, never payload content.
 */
export function severedStreamMeta(
  turn: SeveredStreamTurn,
  reasoningChars: number,
  model: string,
  label: string | undefined,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    rz: reasoningChars,
    len: turn.toolCalls.map(tc => (tc.arguments || '').length),
    calls: turn.toolCalls.length,
    caps: turn.toolCalls.map(tc => tc.name ?? '?').join(','),
    finishReason,
    model,
    ...(label ? { label } : {}),
  };
}