/**
 * Tool-argument parsing — the ONE seam every streamed tool call's raw
 * `arguments` string passes through before a tool executes (agent.ts `runTool`).
 *
 * WHY (ticket 5bdbb126): a project supervisor's `goal_update` was rejected four
 * times across two wakes with "arrived truncated or malformed — NOTHING was
 * executed", including on a ~350-char payload that was complete at the sender.
 * The same call shape had worked on earlier wakes. Two transport/serialization
 * defects produce exactly that symptom on a COMPLETE payload:
 *
 *   1. A LITERAL CONTROL CHARACTER inside a JSON string literal. `JSON.parse`
 *      reports "Bad control character in string literal" even though every byte
 *      of the value arrived — the payload is complete, just not escaped. The
 *      free-form prose arguments (progressNote / blockedReason / description)
 *      are precisely where multi-line text lands, so a model that emits a raw
 *      newline instead of `\n` fails the parse on its best-behaved call.
 *   2. A gateway that streams `arguments` as an already-parsed OBJECT (not a
 *      fragment string) — the accumulator in coding-model.ts concatenated it
 *      into the literal text "[object Object]".
 *
 * THE 2026-08-30 AUDIT STILL GOVERNS: a TRUNCATED payload must never execute
 * with fabricated/empty args (a zero-parameter mutating tool fired with args={}
 * while the narration described arguments that never arrived). So the repair
 * here is deliberately LOSSLESS and NARROW — escape only unescaped control
 * characters inside string literals, then require a complete JSON OBJECT.
 * Anything else stays a rejection; it now carries the real parse reason so the
 * next occurrence is diagnosable instead of a mystery, and it never echoes the
 * payload (JSON.parse messages carry an offset, not content).
 */

/** JSON's only legal short escapes for the C0 control range. */
const SHORT_CONTROL_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/**
 * Escape every UNESCAPED control character that sits inside a JSON string
 * literal. A lossless, structural rewrite: quotes and existing escapes are
 * tracked so an escaped `\"` never flips the in-string state, and bytes outside
 * string literals are untouched. An unterminated string stays unterminated —
 * a genuinely truncated payload is still rejected downstream.
 */
export function escapeUnescapedControlChars(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) { escaped = false; out += ch; continue; }
    if (ch === '\\') { escaped = true; out += ch; continue; }
    if (ch === '"') { inString = false; out += ch; continue; }
    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      out += SHORT_CONTROL_ESCAPES[ch] ?? `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Reduce a `JSON.parse` failure message to a SAFE, structural one-liner.
 *
 * WHY: V8 echoes a payload PREVIEW on its token-error shapes, e.g.
 *
 *   Unexpected token 's', ...""apiKey": sk-SECRETV"... is not valid JSON
 *
 * Putting that raw into a tool result writes whatever credential the model put
 * in the payload into the transcript, the SSE stream and the logs. So: on the
 * preview-carrying shapes keep only the structural head (before the first
 * comma), and mask any quoted span that survives. Positional messages
 * ("… at position 69 (line 1 column 70)") carry no content and pass through.
 */
export function sanitizeJsonParseReason(message: unknown): string {
  let s = String(message ?? '').trim();
  if (!s) return 'unparseable JSON';
  if (/is not valid JSON/i.test(s)) {
    const comma = s.indexOf(',');
    s = comma > 0 ? s.slice(0, comma) : 'unparseable JSON';
  }
  s = s.replace(/"[^"]*"/g, '"[…]"');
  return s.trim() || 'unparseable JSON';
}

export interface ToolArgumentsOk {
  ok: true;
  args: Record<string, any>;
  /** Set when the payload needed a lossless repair before it parsed. */
  repaired?: 'control-chars' | 'object';
}

/**
 * WHY a rejected payload was rejected — the distinction the recovery advice
 * depends on (ticket aa59535b).
 *
 *   'truncated'  the bytes stop in the MIDDLE of the JSON structure (inside a
 *                string literal, or with a container still open). Nothing the
 *                model can re-type fixes this: the argument arrived incomplete.
 *   'malformed'  the payload arrived in FULL but is not valid JSON (a trailing
 *                comma, single quotes, an unquoted key, a literal newline that
 *                the lossless repair could not rescue).
 *   'not-object' it parsed as valid JSON but as an array/null/scalar; a tool's
 *                arguments must be an object.
 *
 * The two live classes need OPPOSITE advice, which is why the flat "arrived
 * truncated or malformed" text (pre-5bdbb126) and even 5bdbb126's single
 * "CUT SHORT" text are wrong for one of them. Measured on the reporting
 * supervisor transport: a ~2,100-char schedule_message prompt was dispatched at
 * 1743 chars and a 17-char todo_update at 17 — same failure class, wildly
 * different lengths, so no length threshold can stand in for this test.
 */
export type ToolArgumentsFailureShape = 'truncated' | 'malformed' | 'not-object';

export interface ToolArgumentsFailure {
  ok: false;
  /** One line naming the real parse failure — sanitized; never payload content. */
  reason: string;
  shape: ToolArgumentsFailureShape;
  /**
   * Length of the payload as DISPATCHED (chars). A cut this short means almost
   * the whole argument is missing — the size that separates the two halves of
   * the ticket, NOT a claim about where the bytes went. Where they went is
   * deliberately not asserted here (see `toolArgumentRejection`: this seam
   * cannot see `ur`/`pf`/`sk`/`pc`, and `recv == acc` alone does not prove the
   * wire was clean).
   */
  argLen: number;
}

export type ToolArgumentsParse = ToolArgumentsOk | ToolArgumentsFailure;

/**
 * True when `raw` stops in the MIDDLE of its JSON structure: inside a string
 * literal, or with a `{`/`[` still open.
 *
 * Deliberately STRUCTURAL and length-independent. The alternative — parsing
 * V8's message for "Unexpected end of JSON input" / "at position N" — was
 * measured over the same shape matrix and is fragile in two ways this scan is
 * not: the wording is engine-versioned, and `sanitizeJsonParseReason` (which
 * must run first, so no payload ever reaches a transcript) already rewrites the
 * message. A balance scan reads only the payload the model actually sent.
 *
 * This is a CLASSIFIER for the rejection message and telemetry — never an
 * acceptance test. A payload it calls truncated is still rejected; a genuinely
 * truncated payload must never execute with fabricated args (the 2026-08-30
 * audit). It also cannot "complete" anything: it only ever answers whether the
 * bytes as delivered are structurally finished.
 *
 * Verified against 30 shapes (17 truncation, 13 malformed) including the live
 * dispatch lengths from the reporting transport. Deliberately NOT fooled by:
 * a balanced prefix followed by garbage (`{"a":1} xyz` — depth returns to 0 and
 * the closing quote state is clean ⇒ malformed), a literal newline inside a
 * string, or trailing whitespace after a cut.
 */
export function endsMidJsonStructure(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      // A closer with nothing open, or closing the WRONG container type, means
      // every byte arrived and the payload is merely invalid — never a cut. A
      // plain depth COUNTER gets this wrong (`{"a":[1,2}` closes to depth 0 but
      // mismatches), which would tell the model bytes were lost when they
      // were not: the exact misdiagnosis this ticket exists to remove.
      if (open === undefined) return false;
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return false;
    }
  }
  // An EXIT from inside a string literal means the closing quote never arrived.
  // An open container means a closer never arrived. Either is a cut.
  //
  // Converse (documented so nobody over-trusts this): a payload that arrived
  // COMPLETE can only fail this scan if it is missing a closer or a quote —
  // which is indistinguishable from a cut on the bytes alone. That residual
  // case gets the cut advice, which is still the only useful thing to say about
  // a structurally unfinished payload.
  return inString || stack.length > 0;
}

/** A `JSON.parse` outcome that keeps WHY it failed. */
type ObjectParse =
  | { ok: true; value: Record<string, any> }
  | { ok: false; kind: 'syntax'; reason: string }
  | { ok: false; kind: 'not-object'; reason: string };

/** JSON.parse that only accepts a JSON OBJECT (what a tool's args must be). */
function parseObject(text: string): ObjectParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err: any) {
    return { ok: false, kind: 'syntax', reason: sanitizeJsonParseReason(err?.message) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const what = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
    return { ok: false, kind: 'not-object', reason: `arguments parsed as ${what}, not a JSON object` };
  }
  return { ok: true, value: value as Record<string, any> };
}

/**
 * The rejection text the model reads, chosen by failure CLASS (ticket
 * aa59535b). Pure and exported so the wording is testable without spinning a
 * whole agent run. (Sits above the reshape helpers that #2168 inserted below;
 * it documents `toolArgumentRejection`.)
 *
 * The two classes get opposite advice:
 *   • TRUNCATED — the payload stopped mid-structure. What is MEASURED is that
 *     every byte the gateway emitted reached us (`recv == acc, drop=0, buf=0,
 *     sc=1` on every stored row of the class), so the argument was already this
 *     short when it left the gateway and a harness-side decoder/buffer fix
 *     cannot mend it — tickets 9b2b3798 / 192d9087 commissioned exactly those
 *     fixes off this text's old wording and two sibling lanes refuted them. The
 *     cause ABOVE the gateway is not observable from here, so the text says so
 *     and prescribes a RESHAPE (which is field-validated) rather than a
 *     transport theory or a shrink (both refuted). No claim is made either way
 *     about the cut point being stable: it is stable on some gateways (one seat
 *     re-cut at the same byte 5/5) and variable on others (the reporting
 *     supervisor transport landed the same tool on a later attempt after cuts
 *     at 17/39/64/92), so the text tells the model what to DO rather than
 *     asserting a law.
 *   • MALFORMED / NOT-OBJECT — every byte arrived, so the same call may be
 *     retried once the syntax is fixed. Telling the model its payload was "cut
 *     short" here sends it hunting a transport fault that does not exist.
 *
 * `argLen` is quoted because it is the fact that separates the two halves of
 * the ticket: a cut on a ~2,100-char prompt is unremarkable, a cut on a 17-char
 * argument means almost the whole payload is missing.
 */
/**
 * Tools whose id argument is resolved through a UNIQUE PREFIX resolver, so the
 * caller may send 8–35 chars instead of the full 36-char uuid.
 *
 * Verified in code, not assumed (goals.service.ts): `updateGoal` /
 * `getGoal` ⇒ `canonicalGoalId` ⇒ `resolveUniqueGoalPrefix`; `updateTodo` /
 * `getTodo` ⇒ `canonicalTodoId` ⇒ `resolveUniqueTodoPrefix`. Both resolvers
 * gate on `id.length >= 8 && id.length < 36`, take exactly ONE caller-visible
 * candidate, and fall through unchanged on ambiguity — so an 8-char prefix is
 * a first-class input, not a shortcut with different semantics. Pinned by
 * `goals.service.test.ts` ('goal_update resolves a unique 8-char prefix',
 * 'todo_update resolves a unique 8-char prefix').
 *
 * WHY THIS SET EXISTS (emission-side remedy, 2026-10-30): the measured cut
 * geometry is that the payload dies INSIDE the id string — the shortest valid
 * goal_update is 49 bytes with the uuid starting at byte 11, so the dominant
 * 39-byte cut leaves 28 of 36 uuid chars and the 67-byte cuts land exactly at
 * the id's closing quote. The id is therefore the single largest OPAQUE run of
 * bytes in the payload, and it is the one part the model can legitimately make
 * 28 bytes shorter without losing any information: the row it addresses is
 * identical. That is a RESHAPE (same call, same target, different encoding of
 * the id), which is the lever field-validated to work, as opposed to shrinking
 * the informative values, which is the lever field-validated to fail.
 */
export const PREFIX_RESOLVED_ID_TOOLS: ReadonlySet<string> = new Set([
  'goal_update',
  'todo_update',
  'goal_get',
  'todo_get',
]);

/**
 * The concrete reshape for a truncated (not malformed) payload, or '' when the
 * tool has no id the server will resolve from a prefix.
 *
 * Deliberately a HINT about one argument, never a guarantee: the transport can
 * cut anywhere and observed cut points span 10 → 3,983 chars, so this cannot
 * promise a re-send lands. It tells the model the ONE edit that both preserves
 * meaning and removes the bytes the cut keeps landing in.
 */
export function truncatedIdReshapeHint(toolName: string): string {
  if (!PREFIX_RESOLVED_ID_TOOLS.has(toolName)) return '';
  return ` CONCRETE RESHAPE for this tool (measured, not a guess): the id argument accepts a unique 8-char PREFIX — the server resolves it to the one row it names, with identical behaviour — so emitting 8 characters instead of the full 36-char uuid removes 28 bytes from the payload and moves the longest OPAQUE run out of the region these cuts keep landing in. The id is the largest opaque run in this payload and the only part that can be shortened WITHOUT losing information, which is why this is a reshape and not the "shrink your values" advice this text warns against above.`;
}

/**
 * TICKET 8b62e61e (2026-11-01) — THE TURN EVIDENCE THE REJECTION SEAM NEVER SAW.
 *
 * `toolArgumentRejection` used to be handed ONLY `(toolName, failure)`. That made
 * the model-facing text — and the `dispatch_reject` row a reader follows — blind
 * to the one measurement that separates a GATEWAY-severed payload from a model
 * formatting fault. The turn already measures it: `TurnResult.streamTrace` (the
 * GATEWAY-OR-OURS arithmetic) and `finishReason` ride the ctx and are written
 * onto the very same metric row, but the text the MODEL receives could not use
 * them, so it hedged ("may have been emitted short, or its bytes may have been
 * lost above this harness") on rows where the arithmetic had already settled it.
 *
 * MEASURED WHY THAT MATTERED (live rows, 2026-11-01, hours 48): 45
 * `GATEWAY-OR-OURS` rows read `recv == acc, drop=0, buf=0, fr=tool_calls` — every
 * byte the gateway sent we appended, nothing was dropped or left buffered, and
 * the provider declared the turn COMPLETE while the payload still stopped
 * mid-structure (17/39/78/89/92/1303/1591/1791/1956/6246 bytes across
 * xiaomi-mimo AND deepseek-v4.1-flash). Three consecutive cuts in one chat
 * (21:19:35Z / 21:20:37Z / 21:21:57Z, all `goal_update`) carried
 * `sv:"already-recovered" rr:1 re:0`: the per-RUN re-emit budget was already
 * spent, so attempts 2 and 3 fell through to a rejection that reads exactly
 * like a model formatting fault.
 *
 * WHAT THIS DOES NOT DO: it does not retry (measured and refuted — the re-request
 * re-cuts at the same byte, and the brief for this ticket forbids another retry
 * bandage) and it does not re-widen the completeness gate (PR #2125, refuted and
 * reverted). It makes the class NAMEABLE and LOUD: a distinct error class, a
 * distinct model-facing text, and a distinct 2-char `ec` on the durable row, so
 * "discardedComplete=[]" can never again read as "nothing was lost".
 *
 * LENGTHS AND COUNT/MODE facts only — never payload bytes (same discipline as
 * every other seam in this module).
 */
export interface ToolCallTurnEvidence {
  /** The provider's `finish_reason` for the turn (`tool_calls` when it declared
   *  the turn complete). `null`/absent = no evidence to settle the question. */
  finishReason?: string | null;
  /** Bytes the gateway handed us in SSE deltas (the reject row's `rb`). */
  receivedBytes?: number;
  /** Bytes that landed in the accumulator slots (the reject row's `ab`). */
  accumulatedBytes?: number;
  /** `receivedBytes - accumulatedBytes` (`db`). 0 ⇒ we dropped none of what arrived. */
  droppedBytes?: number;
  /** Un-drained SSE tail at finish() (`ub`). >0 ⇒ bytes we never parsed. */
  undrainedBufferBytes?: number;
  /** Bytes on a shape the accumulator cannot read (`ur`). >0 voids the verdict. */
  unreadArgBytes?: number;
  /** Frames the SSE reader skipped before any counter ran (`sk`/`ml`). */
  skippedRawLines?: number;
  multilineDataEvents?: number;
  /** `data:` frames that failed JSON.parse (`pf`/`pc`). */
  parseFailLines?: number;
  parseFailToolCalls?: number;
}

/**
 * The class of a rejected tool call, as the ACCEPTANCE seam can settle it.
 *
 *  - `severed-in-transit`   the payload stops mid-structure AND the provider
 *                           declared the turn finished (`fr=tool_calls`) AND our
 *                           own arithmetic is clean (nothing dropped, nothing
 *                           buffered, nothing unread/skipped/parse-failed). This
 *                           is the 8b62e61e row exactly: the argument was
 *                           complete in the provider's accounting and stopped
 *                           before it reached us. NOT a model formatting fault.
 *  - `cut-shape-unclassified` structurally unfinished, but the turn carries no
 *                           evidence tight enough to name the half (no
 *                           finish_reason, or a counter that voids the reading).
 *                           Stays the honest hedge it is today.
 *  - `malformed`            every byte arrived and it is not valid JSON.
 *  - `not-object`           every byte arrived; valid JSON, wrong shape.
 */
export type ToolCallLossClass =
  | 'severed-in-transit'
  | 'cut-shape-unclassified'
  | 'malformed'
  | 'not-object';

/**
 * Settle the class of a rejected call from the failure shape + the turn evidence.
 *
 * PURE and conservative. Every arm of `severed-in-transit` is a fact the turn
 * already measured; when ANY of them is missing or voids the reading, the call
 * degrades to `cut-shape-unclassified` and keeps today's hedge. That asymmetry
 * is deliberate: naming a gateway cut wrongly is the misdiagnosis that already
 * manufactured two escalation tickets (aa59535b / 9b2b3798), so the classifier
 * asserts the strong claim only where the arithmetic proves it.
 */
export function classifyToolCallLoss(
  failure: Pick<ToolArgumentsFailure, 'shape'>,
  evidence?: ToolCallTurnEvidence,
): ToolCallLossClass {
  if (failure.shape === 'not-object') return 'not-object';
  if (failure.shape !== 'truncated') return 'malformed';
  const e = evidence;
  if (!e) return 'cut-shape-unclassified';
  // The provider must have DECLARED the turn finished. `length` is an output-cap
  // cut (a different, already-handled class) and null/anything else is no
  // evidence at all.
  if (e.finishReason !== 'tool_calls') return 'cut-shape-unclassified';
  // OURS-side counters that VOID any "the gateway sent it short" reading — the
  // same list `gatewayOrOurs` treats as ours (tool-call-finalize-meta.ts), kept
  // here as an explicit AND so this seam cannot drift from that one.
  const ours =
    (e.droppedBytes ?? 0) !== 0 ||
    (e.undrainedBufferBytes ?? 0) !== 0 ||
    (e.unreadArgBytes ?? 0) !== 0 ||
    (e.skippedRawLines ?? 0) !== 0 ||
    (e.multilineDataEvents ?? 0) !== 0 ||
    (e.parseFailLines ?? 0) !== 0 ||
    (e.parseFailToolCalls ?? 0) !== 0;
  if (ours) return 'cut-shape-unclassified';
  // Both sides must have been MEASURED (not defaulted) for the arithmetic to
  // mean anything: recv == acc with nothing dropped is the whole claim.
  if (typeof e.receivedBytes !== 'number' || typeof e.accumulatedBytes !== 'number') {
    return 'cut-shape-unclassified';
  }
  if (e.receivedBytes !== e.accumulatedBytes) return 'cut-shape-unclassified';
  return 'severed-in-transit';
}

/**
 * TICKET 1425001e (2026-11-01) — is this rejected call a SEVERANCE the harness
 * owes someone? The predicate behind the `tool_call_unrecovered_severance`
 * loop-metric row, kept pure and next to the classifier so the two can never
 * disagree about the class.
 *
 * WHY "UNRECOVERED" NEEDS NO `sv` FILTER, and why the ticket's proposed
 * `sv != 'already-recovered'` would have been WRONG. The `reemit` arm of the
 * severed-stream ladder does `continue` BEFORE the turn is dispatched
 * (agent.ts, `if (severedVerdict === 'reemit') { … continue; }`), so a cut the
 * harness re-requested never reaches `runTool` at all. Every cut that DOES
 * reach this seam is therefore already unrecovered by construction: the
 * per-run re-emit was already spent (`already-recovered`), a complete sibling
 * made a re-emit the wrong trade (`complete-sibling`), there was no transport
 * signal (`no-transport-signal`), or the ladder was disabled. Requiring
 * `sv != 'already-recovered'` would have EXCLUDED the very population the
 * ticket cites by name — `already-recovered` is the arm where the budget is
 * spent, i.e. precisely the unrecovered case.
 *
 * `cancelled` is the ONE arm excluded: Stop was pressed, so the loss is the
 * user's decision and not a defect anyone owes a fix for. Pure.
 */
export function isUnrecoveredSeverance(lossClass: ToolCallLossClass, severedVerdict?: string | null): boolean {
  if (lossClass !== 'severed-in-transit') return false;
  return severedVerdict !== 'cancelled';
}

/**
 * TICKET cffd0d0a (2026-11-03) — WAS THIS CALL REJECTED AT DISPATCH?
 *
 * True iff the call's raw arguments FAIL to parse AND this turn's own
 * arithmetic settles the loss as `severed-in-transit` — the harness rejected
 * it at dispatch, so the tool never ran and NOTHING was written. Pure (the same
 * two functions that produce the model-facing text and the durable `ec` key, so
 * the three can never disagree about the class).
 *
 * WHAT THE CALLER MAY CONCLUDE — AND WHAT IT MAY NOT. It may conclude that this
 * turn produced no result the model could have looped on. It may NOT conclude
 * that the wire is at fault: a model that simply stops mid-object is
 * byte-for-byte indistinguishable from a gateway that cut a longer payload at
 * the same point, and `classifyToolCallLoss` only proves the gateway forwarded
 * faithfully, never that it forwarded EVERYTHING the model emitted. So the
 * repeat breaker CAPS its escalation for this turn (the permanent rung is
 * unreachable) but does not dissolve the streak — for both readings of the
 * class, "keep the tool offered, keep interrupting the loop" is the right
 * response, and a model emitting unfinished JSON every turn stays bounded.
 *
 * WHY CAPPING IS THE FIX (measured, chat 99e63f86, 2026-11-03 20:23:09Z and
 * 20:28:07Z — both `tool_repeat_break`, tool `goal_update`): a cut re-cuts a
 * re-sent payload at the SAME byte (5/5 measured on the reporting seat), so the
 * arguments are byte-identical across turns BY CONSTRUCTION. The exact leg
 * therefore escalated 1 round → 3 rounds → `permaWithheld`, REMOVING
 * `goal_update` from the schema for the rest of the run. A transient dispatch
 * fault became a permanent capability loss, and a write that never executed —
 * the supervisor's owner-halt marker — could then never land: the ticket's
 * "then tool loop-broken".
 */
export function isTransportSeveredRejection(
  raw: unknown,
  evidence?: ToolCallTurnEvidence,
): boolean {
  const parsed = parseToolArguments(raw);
  if (parsed.ok) return false;
  return classifyToolCallLoss(parsed, evidence) === 'severed-in-transit';
}

export function toolArgumentRejection(
  toolName: string,
  failure: ToolArgumentsFailure,
  evidence?: ToolCallTurnEvidence,
): string {
  const head = `[tool call rejected] The arguments for ${toolName} did not parse as a JSON object — NOTHING was executed. Parser said: ${failure.reason}.`;
  const lossClass = classifyToolCallLoss(failure, evidence);
  if (lossClass === 'severed-in-transit') {
    // THE LOUD ARM (ticket 8b62e61e, 2026-11-01). Reached only when the turn
    // PROVED it: the provider declared the turn complete (`fr=tool_calls`) and
    // every byte it sent was appended here (`recv == acc`, nothing dropped,
    // buffered, unread, skipped or parse-failed). So this text may state the
    // half decisively where the hedged arm below may not — and it must, because
    // the hedged text is what let three consecutive cuts in one chat (all
    // `goal_update`, all `sv=already-recovered`) read as model formatting
    // faults once the per-run re-emit was spent.
    //
    // The instruction stays the field-validated one — RESHAPE, never shrink,
    // and never the identical call (a re-send re-cuts at the same byte, 5/5
    // measured) — because settling the CAUSE does not change the repair.
    return `${head} Classification: SEVERED IN TRANSIT — the argument was cut off mid-structure (after ${failure.argLen} chars) by the transport between the model gateway and this harness, NOT by a formatting mistake on your side. This turn's own measurements settle it: the provider declared the turn COMPLETE (finish_reason=tool_calls) and every byte it sent was appended here (received=${evidence?.receivedBytes ?? '?'} = accumulated, nothing dropped, nothing left buffered). So the payload stopped before it reached this process, and re-sending the IDENTICAL call will very likely be cut at the same position — this is not a claim about you and not a signal that your payload was too long. Do this instead: change the SHAPE of this one call, not the SIZE of its values. A call whose opaque fields are shorter (ids accept a unique 8-char PREFIX), or the same step split across two calls, or a different tool for this step — all keep the information and move the cut point.${truncatedIdReshapeHint(toolName)} This is a HARNESS-CLASSIFIED transport cut, recorded as such against this turn (class=severed-in-transit) — you do not need to file it, diagnose it, or mention a transport theory in your note. Just re-issue the reshaped call and continue.`;
  }
  if (failure.shape === 'truncated') {
    // efdb3d31 (2026-10-29) — CORRECTED LEVER. The old text led with "make it
    // shorter", and the rows show a seat obeying that literally: one run walked
    // 89 → 39 → 17 bytes and failed every time. Shrinking a payload cannot fix
    // this class, and it actively misleads: it makes the model keep retrying
    // the same step with less and less information. The lever that changed is
    // the one that still stands — RESHAPE, never SHRINK.
    //
    // 9b2b3798 (2026-10-30) — CORRECTED CAUSE. The text below used to read "so
    // bytes were lost between the gateway and this harness" / "the transport is
    // severing the stream mid-payload". That was an assertion this seam cannot
    // support: `toolArgumentRejection` sees only reason/shape/argLen, and the
    // counters that WOULD settle it (`ur` unread bytes, `pf`/`pb`/`pc` parse-fail
    // frames, `sk`/`ml` skipped lines) are not passed to it. `recv == acc` alone
    // is NOT a clean-wire proof either — `coding-model.ts:1912-1952` documents
    // three shapes that discard real fragments while the subtraction still reads
    // a perfect `drop=0` (its own words: such bytes "would render a clean drop=0
    // and hand the verdict to the gateway for a defect of ours"). So the seam
    // may not claim the wire was clean, and it may not claim it was not.
    //
    // Why this mattered more than a wording nit: agents READ the old text,
    // concluded "stream-level severance in the tool-call transport, not payload
    // size", and escalation tickets were filed commissioning transport fixes —
    // which sibling lanes then spent whole runs refuting. A rejection message
    // that asserts a cause it cannot observe manufactures its own next ticket.
    // So the text now names the ambiguity, points at the per-turn diagnostics
    // that can decide it, prescribes the RESHAPE (the one field-validated
    // lever), scopes the re-emit claim to the paths where it is true, and still
    // asserts NOTHING about a deterministic re-cut point (cut points span
    // 10 → 3,983 chars across seats).
    return `${head} Classification: TRUNCATED IN TRANSIT — the payload stops mid-structure after ${failure.argLen} chars (inside a string literal or before a closing brace/bracket). What this seam KNOWS is that the argument arrived incomplete; what it CANNOT see is why, and it will not guess: the argument may have been emitted short, or its bytes may have been lost above this harness. Both produce exactly this shape, and the decision between them lives in the turn's stream diagnostics (a nonzero unread / parse-fail / skipped-line counter voids any "the transport did it" reading), NOT in this message. So do not spend a turn on a transport theory and do not file one from this rejection alone — the counters that would settle it are already recorded against this turn. This is NOT a formatting fault on your side and NOT a signal that your payload was too long: measured cuts span 19 → 499 chars on this ticket alone and 10 → 3,983 across the class, so a shorter payload is not a reliable repair and shrinking your values only loses information.${truncatedIdReshapeHint(toolName)} The harness re-requests a structurally unfinished turn once by itself where that path is available; if this rejection reached you, that remedy has either already been spent or does not apply here, so treat this call as rejected rather than as retried. Then: do NOT keep retrying the identical call — a re-send CAN re-cut at the same byte, so if it is rejected again, change the SHAPE of the work rather than the SIZE of the values (a call with fewer opaque fields, or the step split in two, or a different tool for this step). Preserve the information you needed to send. Say so plainly in your note if a cut repeats — the next reader needs to know the write did not land. (Newlines inside string values must be written \\n.)`;
  }
  if (failure.shape === 'not-object') {
    return `${head} Classification: NOT AN OBJECT — the whole payload arrived and is valid JSON, but a tool's arguments must be a JSON OBJECT such as {"key": "value"}, not an array or a bare value. Re-issue the same call with object-shaped arguments; nothing was lost in transit.`;
  }
  return `${head} Classification: MALFORMED (complete, but not valid JSON) — every byte arrived, so this is a formatting fault, not a truncation, and retrying is safe once the syntax is fixed. Usual causes: a trailing comma, single quotes instead of double, an unquoted key, or an unescaped newline OUTSIDE a string value. (A newline inside a string value is repaired automatically and never reaches this class; to be safe, write newlines inside values as \\n.)`;
}

/**
 * Parse a streamed tool call's raw `arguments` into a JSON object.
 *
 * Order: an already-parsed object passes through; a truly EMPTY payload means no
 * arguments (`{}` — the long-standing `tc.arguments || '{}'` contract, and the
 * only empty shape that may execute); otherwise a direct parse; otherwise ONE
 * lossless control-character repair; otherwise a failure carrying a sanitized
 * structural reason. Never returns args the model did not send.
 *
 * NOTE a whitespace-only payload is NOT empty: it is malformed text and stays a
 * rejection (it used to reach the tool as `{}` only when the string was truly
 * empty). Executing a zero-argument MUTATING tool on garbage is precisely the
 * 2026-08-30 hazard.
 */
export function parseToolArguments(raw: unknown): ToolArgumentsParse {
  // A gateway may hand us an already-parsed object instead of a fragment string.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ok: true, args: raw as Record<string, any>, repaired: 'object' };
  }
  if (raw === undefined || raw === null || raw === '') return { ok: true, args: {} };
  // A non-string, non-object payload (a bare array used to slip through as
  // `args`); treat its JSON text so it reaches the object check below.
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const direct = parseObject(text);
  if (direct.ok) return { ok: true, args: direct.value };
  const escaped = escapeUnescapedControlChars(text);
  if (escaped !== text) {
    const repaired = parseObject(escaped);
    if (repaired.ok) return { ok: true, args: repaired.value, repaired: 'control-chars' };
  }
  return {
    ok: false,
    reason: direct.reason,
    // Ticket aa59535b: classify BEFORE the model reads the rejection. A
    // 'not-object' payload arrived in full and is valid JSON; a syntax failure
    // is a TRANSPORT cut only when the bytes stop mid-structure — otherwise
    // every byte arrived and the fault is formatting.
    shape: direct.kind === 'not-object'
      ? 'not-object'
      : (endsMidJsonStructure(text) ? 'truncated' : 'malformed'),
    argLen: text.length,
  };
}

/**
 * The slot a streamed `tool_calls` delta fragment belongs to.
 *
 * OpenAI-compatible SSE carries an `index` per delta. A gateway that omits it
 * (observed on proxied/hosted OpenAI-compatible endpoints) used to fall into
 * slot 0 for every call, so two INDEPENDENT complete calls in one model turn
 * were concatenated into `{…}{…}` and every call in the turn was rejected as
 * "truncated or malformed". Rules, in order:
 *
 *   1. an explicit `index` wins (number, or a numeric string — main tolerated
 *      both via object-key coercion) — unchanged behaviour;
 *   2. an `id` that matches an accumulated slot continues it;
 *   3. an `id` that matches nothing opens a NEW slot;
 *   4. no index, no id — the fragment continues the slot that was LAST TOUCHED
 *      (the call actually being streamed), never `Math.max`: with two calls open
 *      the highest index is not necessarily the one still arriving, and routing
 *      there let a ZERO-ARG MUTATING tool execute with another call's bytes
 *      (adversarial review of this PR, F2/X1).
 *   5. if the target slot already holds a COMPLETE JSON object and this fragment
 *      opens a new one, the previous call finished — open the next slot.
 *
 * TICKET 3b75ba8e — RULE 5 APPLIES TO EVERY ROUTING PATH. It used to guard only
 * the anonymous path (4): rules 1 and 2 returned EARLY, so a gateway that
 * reused the same `index` or the same `id` for a severed twin appended it
 * straight onto the complete payload —
 *
 *   {"goalId":"8f0dcd6f","progressNote":"N6 landed"}{"goalId": "8f0dcd6f", "progressNote":
 *
 * — and the COMPLETE call was destroyed by its twin, so a supervisor's every
 * `goal_update` read as "truncated or malformed" even though the model had
 * emitted a valid call (the post-deploy reproduction of 5bdbb126). A finished
 * slot is now closed to further fragments on ALL three paths.
 *
 * AN EXACT RE-SEND IS A DUPLICATE, NOT A SECOND CALL: reopening the slot would
 * make a retransmitted zero-argument MUTATING payload (`git_push`) execute
 * twice, so a fragment whose canonical value equals the finished payload is
 * reported as DUPLICATE_FRAGMENT and dropped by the accumulator.
 *
 * AMBIGUITY IS REFUSED, NEVER GUESSED: an anonymous fragment while MORE THAN
 * ONE slot is open and the last-touched slot is not complete cannot be routed
 * safely, so it is marked unresolvable and the whole turn fails closed rather
 * than executing one tool with another tool's arguments.
 */
export const UNRESOLVABLE_SLOT = -1;

/** The fragment is an exact re-send of a payload this slot already holds. */
export const DUPLICATE_FRAGMENT = -2;

/** The accumulator's slot shape (coding-model.ts owns the live instance). */
export interface ToolCallSlot {
  id: string;
  name: string;
  /** The assembled raw JSON text; '' while the call has not sent a fragment. */
  args: string;
  /**
   * The id EXACTLY as the gateway sent it, kept apart from `id` (ticket
   * 3b75ba8e). When a gateway reuses one id for a second call, `id` is
   * rewritten to stay unique across the turn while `gwId` keeps the routing
   * key intact — otherwise a rewritten slot would stop matching its own id and
   * later fragments of that call would route into the FIRST slot holding it.
   */
  gwId?: string;
}

/** The routing key of a slot: the gateway's own id when known. */
function slotGatewayId(slot: ToolCallSlot | undefined): string {
  return slot?.gwId ?? slot?.id ?? '';
}

/**
 * OBSERVE-ONLY diagnosis for ticket efdb3d31 (no behaviour change, never called
 * by the routing/fold paths).
 *
 * WHY THIS EXISTS — the probe that motivated it. Driving the SHIPPED functions
 * with fifteen candidate emission shapes (severed head + complete payload at the
 * same index, at different indexes, with/without gateway ids, named/unnamed,
 * one batch or two, with a sibling call, with a second complete payload) showed
 * that EVERY shape carrying a complete payload is either folded and dispatched
 * intact or produces TWO dispatches, one of which parses. Exactly one shape
 * reproduces the live observables — ONE ok:false row, goal unmoved, and V8
 * "Unexpected end of JSON input":
 *
 *   the turn holds the severed head and NOTHING ELSE.
 *
 * That immediately follows from the parse reason, which is a hard
 * discriminator rather than a guess: welding a complete payload onto a severed
 * head yields "Expected ',' or '}' after property value in JSON at position N"
 * (head first) or "Unexpected non-whitespace character after JSON" (payload
 * first). "Unexpected end of JSON input" can only come from a head dispatched
 * ALONE. So on the live drops there was no complete payload in the slot table
 * for any of the six shipped repairs to claim — the bytes were already gone
 * before the accumulator, and no further attribution rule can recover them.
 *
 * Three mechanisms remain, and they are distinguishable only by the slot table
 * at finalize time plus the provider's finish_reason:
 *
 *   'length' + only a severed head        ⇒ the OUTPUT CAP cut the stream
 *                                            mid-call (no retry fires today:
 *                                            isEmptyTruncatedTurn bails the
 *                                            moment any tool call exists).
 *   a complete unnamed slot that does not
 *   open with the head                    ⇒ content-claimant declines, so the
 *                                            candidate is dropped as foreign.
 *   two or more complete unnamed slots    ⇒ genuine ambiguity, dropped
 *                                            fail-closed by design.
 *
 * So this returns a compact, BYTE-FREE summary (counts, lengths, booleans, slot
 * indexes) that separates those three. No payload content ever leaves this
 * function and no parse reason text beyond its structural head — `parseToolArguments`
 * already sanitizes reasons for the transcript, and the same discipline applies
 * to telemetry.
 */
export interface ToolCallFinalizeDiagnosis {
  /** How the turn's emitted stream ended ('length' is the truncation signal). */
  finishReason: string | null;
  slots: number;
  named: number;
  unnamed: number;
  /** Which of the three candidate mechanisms the slot table fits. */
  verdict:
    | 'ok'                     // every dispatched call parses — nothing to report
    | 'no_complete_payload'    // a named call is unparseable and NO complete payload exists anywhere
    | 'complete_not_prefixed'  // a complete unnamed candidate exists but opens with no named head
    | 'ambiguous_complete';    // two or more complete unnamed candidates — declined by design
  /** Named slots that would dispatch unparseable: index, tool name, structural reason head. */
  broken: Array<{ k: number; name: string; len: number; reason: string }>;
  /** Complete unnamed slots that finalize's `.filter(tc => tc.name)` would DISCARD. */
  discardedComplete: number[];
  /** For each complete unnamed slot: the named slots whose heads it opens with. */
  claims: Array<{ k: number; owners: number[] }>;
}

/**
 * Diagnose a finalize-time slot table for ticket efdb3d31. PURE and
 * OBSERVE-ONLY: it reads the table, never mutates it, and is never consulted by
 * `resolveToolCallSlot`, `routeIntoSlot` or `mergeOrphanContinuations`.
 */
export function diagnoseToolCallFinalize(
  acc: Record<number, ToolCallSlot>,
  finishReason: string | null,
): ToolCallFinalizeDiagnosis {
  const slots = Object.keys(acc).map(Number).sort((a, b) => a - b);
  const namedSlots = slots.filter(k => acc[k]?.name);
  const unnamedSlots = slots.filter(k => !acc[k]?.name);

  const broken: ToolCallFinalizeDiagnosis['broken'] = [];
  for (const k of namedSlots) {
    const raw = acc[k]?.args ?? '';
    if (isCompleteJsonObject(raw)) continue;
    // Structural head of the reason only — sanitizeJsonParseReason masks every
    // quoted span, so no payload text can reach the metric.
    let reason = 'unparseable JSON';
    try { JSON.parse(raw); } catch (e) { reason = sanitizeJsonParseReason((e as Error)?.message).slice(0, 60); }
    broken.push({ k, name: acc[k].name, len: raw.length, reason });
  }

  const claims: ToolCallFinalizeDiagnosis['claims'] = [];
  const discardedComplete: number[] = [];
  for (const k of unnamedSlots) {
    const raw = acc[k]?.args ?? '';
    if (!isCompleteJsonObject(raw)) continue;
    discardedComplete.push(k);
    const owners = namedSlots.filter(
      (o) => (acc[o]?.args ?? '').length > 0 && opensWithHead(raw, acc[o].args),
    );
    claims.push({ k, owners });
  }

  let verdict: ToolCallFinalizeDiagnosis['verdict'] = 'ok';
  if (broken.length) {
    if (discardedComplete.length >= 2) verdict = 'ambiguous_complete';
    else if (discardedComplete.length === 1) verdict = 'complete_not_prefixed';
    else verdict = 'no_complete_payload';
  }

  return {
    finishReason,
    slots: slots.length,
    named: namedSlots.length,
    unnamed: unnamedSlots.length,
    verdict,
    broken,
    discardedComplete,
    claims,
  };
}

/**
 * A stable comparison key for a tool payload: whitespace/format-insensitive
 * when both sides are JSON, with a raw fallback for anything unparseable.
 * Never throws, never rewrites what will be sent.
 */
function canonicalPayload(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}

/** True when `fragment` re-sends exactly what the slot already holds. */
function isDuplicatePayload(existing: unknown, fragment: string): boolean {
  const a = canonicalPayload(existing);
  return !!a && a === canonicalPayload(fragment);
}

/**
 * True when `delta` is a RE-SEND of the call already complete in `target`.
 *
 * Three signals must agree: the gateway says it is the same call (a non-empty
 * `id` equal to the slot's gateway id), the tool name matches (where known),
 * and the payload is identical. Requiring all three is deliberate — comparing
 * payloads alone silently swallowed a SECOND legitimate call (independent
 * review, finding B2: `todo_list {}` then `goal_list {}` are different calls;
 * two parallel `todo_list {}` are two calls, which is what pre-fix produced).
 * Too narrow a test is the safe failure: a missed duplicate opens a fresh slot
 * and the finished call still survives, which is the point of this ticket.
 */
function isDuplicateFragment(
  acc: Record<number, ToolCallSlot>,
  target: number,
  delta: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } },
): boolean {
  const fragment = delta?.function?.arguments;
  if (typeof fragment !== 'string' || !fragment.length) return false;
  const id = typeof delta?.id === 'string' ? delta.id : '';
  if (!id || slotGatewayId(acc[target]) !== id) return false;
  const slotName = acc[target]?.name ?? '';
  const deltaName = typeof delta?.function?.name === 'string' ? delta.function.name : '';
  if (slotName && deltaName && slotName !== deltaName) return false;
  return isDuplicatePayload(acc[target]?.args, fragment);
}

/** True when this fragment starts a NEW call rather than continuing one. */
function opensNewCall(fragment: unknown): boolean {
  // A string fragment that leads with '{' begins a fresh JSON object…
  if (typeof fragment === 'string') return fragment.trimStart().startsWith('{');
  // …and an object-valued `function.arguments` (the 5bdbb126 "L3" class) is a
  // whole payload by itself.
  return !!fragment && typeof fragment === 'object';
}

/** The highest slot index in use, or -1 when none. */
function highestSlot(acc: Record<number, ToolCallSlot>): number {
  const keys = Object.keys(acc).map(Number);
  return keys.length ? Math.max(...keys) : -1;
}

/** True when a fragment carries no argument BYTES at all. */
function isInertFragment(fragment: unknown): boolean {
  if (fragment === undefined || fragment === null) return true;
  if (typeof fragment === 'string') return fragment.trim().length === 0;
  return false; // an object/array always carries bytes
}

/**
 * Route a fragment into an ALREADY-CHOSEN slot, applying rule 5: a call that
 * already holds COMPLETE JSON is FINISHED and must never absorb the next
 * call's bytes (ticket 3b75ba8e).
 *
 * The closure is TOTAL and it never fails SILENTLY in either direction
 * (independent review round 2):
 *   • an INERT fragment (absent / empty / whitespace-only) carries no bytes, so
 *     it can neither corrupt a call nor be allowed to poison the whole turn —
 *     it is a no-op, or a spec-shaped new-call header when it names a
 *     different tool (B1′: an `arguments:""` chunk used to kill every call in
 *     the turn, re-creating the ticket's symptom in fail-closed clothing);
 *   • a continuation is routed ONLY to an open slot belonging to the SAME call
 *     — same gateway id AND same tool name. Anything else would execute a tool
 *     with another call's bytes, which is precisely what the F2/X1 refusal
 *     exists to prevent (B2′: a stray tail once finished `git_push` with
 *     another call's bytes and did not even flag the turn).
 */
function routeIntoSlot(
  acc: Record<number, ToolCallSlot>,
  target: number,
  delta: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } },
  lastSlot?: number,
): number {
  const fragment = delta?.function?.arguments;
  const name = typeof delta?.function?.name === 'string' ? delta.function.name : '';
  const finished = isCompleteJsonObject(acc[target]?.args);

  if (isInertFragment(fragment)) {
    if (!finished) return target;
    // A named, byte-less chunk against a FINISHED slot is the OpenAI-spec
    // header of a NEW call (`{index, id, name, arguments: ''}`) when it names
    // another tool; otherwise it is this call's own finalisation chunk.
    if (name && name !== (acc[target]?.name ?? '')) return Math.max(target, highestSlot(acc)) + 1;
    return target;
  }
  // The slot is still open: appending its own continuation is normal streaming.
  if (!finished) return target;
  // The slot is FINISHED from here on.
  if (isDuplicateFragment(acc, target, delta)) return DUPLICATE_FRAGMENT;
  if (opensNewCall(fragment)) return Math.max(target, highestSlot(acc)) + 1;

  // A continuation for a call whose own slot is already full. The only safe
  // home is an OPEN slot that is provably the SAME call.
  const id = typeof delta?.id === 'string' ? delta.id : '';
  const candidates = Object.keys(acc).map(Number).filter(k => {
    if (isCompleteJsonObject(acc[k]?.args)) return false;
    if (id && slotGatewayId(acc[k]) !== id) return false;
    const slotName = acc[k]?.name ?? '';
    if (name && slotName && name !== slotName) return false;
    return true;
  });
  if (!candidates.length) return UNRESOLVABLE_SLOT;
  // Prefer the call actually being streamed, never a lower index by accident
  // (round-2 B3′: `Math.min` injected `goalId` into a `todo_update` payload).
  if (typeof lastSlot === 'number' && candidates.includes(lastSlot)) return lastSlot;
  return Math.max(...candidates);
}

export function resolveToolCallSlot(
  acc: Record<number, ToolCallSlot>,
  delta: { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } },
  lastSlot?: number,
): number {
  const fragment = delta?.function?.arguments;
  // Main tolerated an index sent as a numeric STRING (`tc.index ?? 0` used it
  // as an object key, which coerces). Keep that: a string "1" is slot 1, not a
  // signal to fall through to the id rules.
  const explicit = typeof delta?.index === 'number'
    ? delta.index
    : typeof delta?.index === 'string' && /^\d+$/.test(delta.index.trim()) ? Number(delta.index.trim()) : NaN;
  // Rule 1 — an explicit index wins… but a FINISHED slot is closed (ticket
  // 3b75ba8e: this early return is what let a reused index concatenate a
  // severed twin onto a complete payload).
  if (Number.isFinite(explicit) && explicit >= 0) return routeIntoSlot(acc, explicit, delta, lastSlot);
  const id = typeof delta?.id === 'string' ? delta.id : '';
  if (id) {
    const matches = Object.keys(acc).map(Number).filter(k => slotGatewayId(acc[k]) === id);
    if (matches.length) {
      // Rule 2 — a matching id continues its slot, subject to the same closure.
      // Matched on the GATEWAY id so a slot whose emitted id was de-duplicated
      // still receives its own later fragments. An INCOMPLETE match is preferred
      // (round-1 B3: after a split both slots share the id, and returning the
      // first, finished one routed the newcomer's continuation into the OLD
      // call, corrupting it), and among open matches the TOOL NAME decides
      // (round-2 B3′: `Math.min` put a `goalId` key into a `todo_update`
      // payload — a call that then parsed cleanly and EXECUTED wrongly).
      const open = matches.filter(k => !isCompleteJsonObject(acc[k]?.args));
      const pool = open.length ? open : matches;
      const deltaName = typeof delta?.function?.name === 'string' ? delta.function.name : '';
      const named = deltaName ? pool.filter(k => (acc[k]?.name ?? '') === deltaName) : [];
      const ordered = named.length ? named : pool;
      // Prefer the call actually being streamed among the survivors.
      const target = typeof lastSlot === 'number' && ordered.includes(lastSlot) ? lastSlot : Math.min(...ordered);
      return routeIntoSlot(acc, target, delta, lastSlot);
    }
    // Rule 3: an unknown id opens a new slot.
    return highestSlot(acc) + 1;
  }
  const keys = Object.keys(acc).map(Number);
  if (!keys.length) return 0;
  // Rule 4: continue the call ACTUALLY being streamed — never the highest slot.
  const target = typeof lastSlot === 'number' && keys.includes(lastSlot) ? lastSlot : Math.max(...keys);
  // …and the same closure/duplicate guard as every other path (rule 5).
  const routed = routeIntoSlot(acc, target, delta, lastSlot);
  if (routed !== target) return routed;
  // Ambiguity: more than one call is open and the one we would append to is not
  // finished — routing is a guess. Refuse the turn instead of mis-executing.
  if (keys.length > 1 && !isCompleteJsonObject(acc[target]?.args)) return UNRESOLVABLE_SLOT;
  return target;
}

/**
 * An id that is unique across the turn's slots.
 *
 * WHY (ticket 3b75ba8e): a gateway that reuses one id for two calls (the
 * observed twin) would otherwise emit two tool calls with the SAME `id`, and
 * the assistant `tool_calls` record plus its `role:'tool'` results would carry
 * duplicate ids — a shape provider APIs reject on replay, killing the run's
 * next turn. The first holder keeps the id; the newcomer gets a derived one.
 */
export function uniqueToolCallId(
  acc: Record<number, ToolCallSlot>,
  slot: number,
  id: string,
): string {
  const taken = Object.keys(acc)
    .map(Number)
    .filter(k => k !== slot && acc[k]?.id === id);
  if (!taken.length) return id;
  let n = 2;
  while (Object.keys(acc).some(k => Number(k) !== slot && acc[Number(k)]?.id === `${id}_${n}`)) n += 1;
  return `${id}_${n}`;
}

/** True when `raw` is already a complete, parseable JSON object string. */
function isCompleteJsonObject(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * True when `head` opens `candidate`, ignoring INSIGNIFICANT whitespace.
 *
 * WHY (ticket efdb3d31, third shape): the twin-invoke repair must prove the
 * complete payload is the SAME call's re-emit before adopting its bytes. The
 * strongest available proof is that the severed head's own bytes open the
 * candidate — but a byte-exact `startsWith` is too brittle to be the test: two
 * invokes of one call are separately serialized, so insignificant whitespace
 * between tokens (`{"goalId":"x"` vs `{"goalId": "x"`) can differ while the CALL
 * is identical. Byte-exactness there would decline a genuine twin and leave the
 * defect live, which is precisely how this ticket re-opened three times.
 *
 * So whitespace is normalized OUTSIDE string literals only. Inside a string a
 * space is data and is preserved; escaped quotes are tracked so `\"` never flips
 * the in-string state. This stays CONTENT-VERIFIED, never a guess: the head's
 * keys and the opening of its values must still genuinely match the candidate
 * token-for-token, so a payload belonging to a different call can never satisfy
 * it (that is the F2/X1 boundary — see `routeIntoSlot`).
 */
function opensWithHead(candidate: string, head: string): boolean {
  if (!candidate || !head) return false;
  return stripInsignificantWhitespace(candidate).startsWith(stripInsignificantWhitespace(head));
}

/** Drop whitespace that sits OUTSIDE a JSON string literal; keep it inside. */
function stripInsignificantWhitespace(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    out += ch;
  }
  return out;
}

/**
 * Append one arguments fragment to a slot's buffer.
 *
 * A gateway may hand us the arguments already parsed (review L3). String
 * concatenation of an object produced the literal text "[object Object]"; the
 * JSON text is appended instead so it stays parseable.
 *
 * Review F4: a number/boolean fragment used to be DROPPED silently (`return
 * buffered`), leaving an empty buffer that then parsed as `{}` — the same
 * fabricated-empty-args shape the 2026-08-30 audit exists to stop. It now
 * appends its JSON text, which fails the object check downstream and is
 * REJECTED, rather than vanishing into a legitimate-looking `{}`.
 */
export function appendArgumentsFragment(buffered: string, fragment: unknown): string {
  if (typeof fragment === 'string') return buffered + fragment;
  if (fragment === null || fragment === undefined) return buffered;
  try {
    return buffered + JSON.stringify(fragment);
  } catch {
    // Unserializable (cyclic) — surface something unparseable rather than
    // silently dropping the fragment.
    return buffered + '<unserializable fragment>';
  }
}

/**
 * How many bytes `appendArgumentsFragment` CONTRIBUTES for one fragment (ticket
 * efdb3d31, the GATEWAY-OR-OURS discriminator).
 *
 * The discriminator compares "bytes the gateway handed us" against "bytes we
 * accumulated", so the received-side counter MUST be measured with exactly the
 * same rule as the accumulator or the comparison is meaningless. Two shapes
 * break a naive `fragment.length`:
 *
 *   • an OBJECT fragment (a gateway may stream arguments pre-parsed, review L3)
 *     contributes its JSON text, not `undefined` — counting it as 0 would make
 *     received < accumulated and drive `droppedBytes` NEGATIVE, i.e. report
 *     data loss that never happened;
 *   • an unserializable (cyclic) fragment contributes a placeholder string.
 *
 * null/undefined contribute nothing (the accumulator appends nothing), so they
 * return 0 and the caller must not count them as a fragment.
 */
export function argumentFragmentLength(fragment: unknown): number {
  if (typeof fragment === 'string') return fragment.length;
  if (fragment === null || fragment === undefined) return 0;
  try {
    return JSON.stringify(fragment).length;
  } catch {
    return '<unserializable fragment>'.length;
  }
}

/**
 * Bytes in a tool_calls delta that we NEVER READ — the last way `recv` can
 * undercount while `drop` still reads a clean 0 (efdb3d31, 2026-10-30).
 *
 * WHY THIS EXISTS. The finalize row's discriminator is
 *
 *     receivedBytes > accumulatedBytes  ⇒ OURS (we dropped bytes we were given)
 *     receivedBytes === accumulatedBytes ⇒ gateway (it sent the payload short)
 *
 * and `receivedBytes` is the sum of `argumentFragmentLength(tc.function.arguments)`
 * — ONE field path. A gateway that ships the same payload under a different
 * path (`tc.arguments`, or the legacy OpenAI `function_call.arguments`) makes
 * BOTH sides of that subtraction zero: those bytes are never counted as
 * received, and they are never accumulated, so the row reads
 * `recv=N acc=N drop=0` and the verdict says **gateway** — a false vendor
 * blame for a defect entirely on our side of the frame boundary.
 *
 * That is the one mislabelling this instrument exists to prevent, so the
 * condition is measured rather than argued: when a delta carries argument bytes
 * in a shape `appendArgumentsFragment` cannot reach, its length is returned and
 * the finalize row renders `ur=` — which VOIDS the gateway verdict for that
 * turn.
 *
 * Returns 0 for every shape we do read (and for a name-only delta), so the
 * overwhelmingly common row is unchanged and pays nothing.
 */
export function unreadArgumentFragmentLength(delta: unknown): number {
  if (!delta || typeof delta !== 'object') return 0;
  const d = delta as {
    function?: { arguments?: unknown };
    function_call?: { arguments?: unknown };
    arguments?: unknown;
  };
  // The path the accumulator reads. If it carried bytes, nothing is unread.
  if (argumentFragmentLength(d.function?.arguments) > 0) return 0;
  // Shapes this accumulator cannot reach — count them so they cannot hide.
  const legacy = argumentFragmentLength(d.function_call?.arguments);
  if (legacy > 0) return legacy;
  return argumentFragmentLength(d.arguments);
}

/**
 * Fold an ORPHANED CONTINUATION slot back into the call it belongs to (ticket
 * efdb3d31).
 *
 * THE DEFECT THIS REPAIRS — proven against the shipped functions, and the only
 * shape that fits the reported evidence. A supervisor's `goal_update` was
 * rejected with "Unexpected end of JSON input" while the assembled buffer held
 * ONLY the call's header (`{"goalId": "8f0dcd6f", "progressNote": `) — the whole
 * value was missing. Why: the header arrives as one delta carrying
 * `{index:0, id, name}` and the CONTINUATION arrives as another delta carrying a
 * DIFFERENT index and NO `name`. Rule 1 (an explicit index wins) routes that
 * continuation into a fresh slot, which is left UNNAMED. `runModelTurn`'s
 * finalize then builds its call list with `.filter(tc => tc.name)`, so the
 * unnamed continuation slot is DISCARDED — the call's own remaining bytes are
 * thrown away and the named slot is dispatched holding a truncated payload:
 *
 *   slot 0  goal_update  {"goalId": "8f0dcd6f", "progressNote":   ← dispatched, REJECTED
 *   slot 1  (unnamed)    "short note"}                             ← silently dropped
 *
 * Both reported attempts (a long note and a deliberately SHORT retry) fail
 * identically because the mechanism is positional, not about length — which is
 * exactly why "retry with a shorter note" never helped, and why the fault is
 * specific to the tool whose FIRST field is a long free-form prose value.
 *
 * THE RULE — deliberately narrow, conditions all required:
 *   1. the orphan carries NO tool name (a named slot is a real call);
 *   2. it is attributable to exactly ONE named call — by the gateway id when it
 *      has one, else only when the whole turn holds exactly one named call;
 *   3. that owner is NOT already a complete JSON object (a2da5f49's protection:
 *      a finished call must never absorb foreign bytes — if the owner already
 *      parses it is done, and the orphan stays dropped as it is today).
 * Then the orphan's bytes are appended to the owner and the slot is removed.
 *
 * SLOT INDEX IS NOT ARRIVAL ORDER (the post-deploy reproduction of this ticket,
 * 2026-10-29 04:30–04:32Z). The first cut of this fold only merged FORWARD — an
 * orphan whose slot index was LOWER than its owner's was left alone, on the
 * argument that "a call's first fragment carries its name, so its owner precedes
 * its continuations". That argument is wrong, because `k` is the GATEWAY's
 * `index`, not the position of the delta in the stream: a gateway may number the
 * continuation BELOW the fragment that carried the name (or re-use a number),
 * and then the payload's tail sits in slot 0 while its head sits in slot 1.
 * Forward-only left that turn dispatching the head alone — the live symptom, on
 * a supervisor seat, AFTER the forward-only fix had shipped.
 *
 * THE PAIR SHAPE (the RE-OPENED reproduction, 2026-10-29 06:13Z todo_update on
 * 86911a13 and ~06:16Z goal_update on e1e7ab69, every serving process already on
 * the fix). This is NOT one payload split into head+tail — it is TWO payloads for
 * ONE tool_call id: the NAMED slot holds a SEVERED HEAD and an UNNAMED slot holds
 * the COMPLETE payload. A content-verified APPEND correctly declines (joining
 * them yields invalid JSON, "Expected ',' or '}'"), so the orphan was dropped and
 * the severed head dispatched alone: "Unexpected end of JSON input", exactly ONE
 * ok:false row because only that call was ever dispatched.
 *
 * So the fold works PER OWNER in two legs:
 *   1. APPEND — ordinary continuation: the orphan fragment(s) carry the tail of
 *      this call's one payload, so concatenating the model's own bytes (in index
 *      order) yields a complete JSON object. Handles multi-fragment tails.
 *   2. SELECT — the pair shape: when EXACTLY ONE orphan is already a complete
 *      JSON object, that IS the call the model finished, so its bytes are taken
 *      under the owner's name. Selection, never concatenation.
 * Neither leg can fabricate or complete a payload: every chosen byte was emitted
 * by the model for this same tool_call id, selection requires the payload to
 * ALREADY parse, and two competing complete payloads are refused as ambiguous —
 * so a genuinely truncated call still dies at the parser.
 *
 * THE 2026-08-30 AUDIT HOLDS: only bytes the model emitted are ever moved, and
 * they are moved between slots of the SAME tool_call id — nothing is fabricated,
 * completed or invented. A payload still truncated after the fold stays a
 * rejection, exactly as before.
 *
 * Returns the slot indexes folded away (for the caller's visibility logging).
 */
export function mergeOrphanContinuations(acc: Record<number, ToolCallSlot>): number[] {
  const folded: number[] = [];
  const slots = Object.keys(acc).map(Number).sort((a, b) => a - b);
  const named = slots.filter(k => acc[k]?.name);
  // Ticket efdb3d31 (FOURTH shape, live 2026-10-29 10:06:48Z, receipt 0ac84b0c).
  // The third-shape repair below was gated on `named.length === 1`, so ANY turn
  // that also emitted a second, unrelated named call disabled it and the
  // complete payload was dropped before dispatch — the call then went out
  // holding its severed head alone and rejected with "Unexpected end of JSON
  // input" while the target never moved. A supervisor turn routinely emits
  // several calls at once, so the gate made the repair unreachable exactly
  // where the bug lives. Counting calls was always the wrong test: what
  // actually decides attribution is whether the orphan's BYTES name exactly one
  // owner. Compute that first; an orphan claimed by two incomplete heads is
  // still a genuine coin flip and stays dropped (fail-closed).
  const claimants = new Map<number, number[]>(); // complete orphan -> incomplete named owners it opens under
  for (const k of slots) {
    const orphan = acc[k];
    if (!orphan || orphan.name || !orphan.args) continue;
    if (!isCompleteJsonObject(orphan.args)) continue;
    for (const owner of named) {
      if (isCompleteJsonObject(acc[owner].args)) continue;
      if (!acc[owner].args || !acc[owner].args.length) continue;
      // FIFTH shape: skip only a genuine same-id tail (the ordinary path). An
      // ID-LESS orphan and an ID-LESS head both carry `gwId === undefined`, and
      // the old unconditional equality test read that as "same id" — so a
      // complete id-less payload never entered this map and could not be
      // content-claimed (live receipt 52a2712b, 11:49:00.884Z).
      if (orphan.gwId && acc[owner].gwId === orphan.gwId) continue;
      if (opensWithHead(orphan.args, acc[owner].args)) {
        const list = claimants.get(k) ?? [];
        list.push(owner);
        claimants.set(k, list);
      }
    }
  }
  // An id-less slot has no bytes of its own to verify against, so it is
  // attributable only when a single named call is still INCOMPLETE (a finished
  // call never absorbs foreign bytes — a2da5f49).
  const incompleteNamed = named.filter(k => !isCompleteJsonObject(acc[k].args));
  // Work PER OWNER, not per orphan: a call's continuation may arrive as one
  // fragment or as several, and the right repair depends on the whole set.
  for (const owner of named) {
    if (isCompleteJsonObject(acc[owner].args)) continue; // a2da5f49 protection
    // Attribute every unnamed slot to this owner. Match on the GATEWAY id only:
    // `slotGatewayId` falls back to the synthetic `call_<index>` this accumulator
    // mints for an id-less delta, so two id-less slots would each look like a
    // distinct call and attribution would fail even though there is only one real
    // call in the turn.
    const orphans: number[] = [];
    // Ticket efdb3d31 (THIRD shape, live 2026-10-29 08:44:33Z): a twin invoke
    // that carries its OWN gateway id. `id` identifies the CALL, and a gateway
    // that re-emits one call as two invokes mints a SECOND id for the re-emit, so
    // strict id equality (`acc[owner].gwId === gw`) refused to attribute it and
    // the payload was dropped. Kept in a SEPARATE list on purpose: APPEND
    // (attempt 1) must never concatenate across two different ids — that is the
    // 2026-08-30 audit boundary. A foreign-id slot may only ever be SELECTED
    // (attempt 2), and only when it already parses on its own.
    const foreignComplete: number[] = [];
    for (const k of slots) {
      const orphan = acc[k];
      if (!orphan || orphan.name || !orphan.args) continue;
      const gw = orphan.gwId;
      if (gw) {
        if (acc[owner].gwId === gw) {
          orphans.push(k);
        } else if (
          acc[owner].args
          && acc[owner].args.length > 0
          // CONTENT-VERIFIED, not just "another id said something complete": the
          // severed head must be a literal PREFIX of the candidate payload. That
          // is precisely the twin signature — the gateway re-emitted the SAME call
          // under a second id and the re-emit was cut short at the head, so the
          // complete bytes open with the head's own bytes. It is also what keeps
          // the F2/X1 guard intact: a payload belonging to a genuinely different
          // call (test: head '{todoId:86911a13…}' vs '{todoId:zzz…}') never opens
          // with this head, so it stays dropped and can never execute as ours.
          && isCompleteJsonObject(orphan.args)
          && opensWithHead(orphan.args, acc[owner].args)
          // FOURTH shape: uniqueness is decided by the BYTES, not by how many
          // calls the turn happened to emit. This payload may be selected only
          // when its opening bytes are THIS head's and no other incomplete
          // named call can claim it — that is the real coin-flip test, and it
          // keeps two genuinely different severed heads shielded. The earlier
          // `named.length === 1` gate refused the moment any unrelated sibling
          // existed, which is exactly the live failure (receipt 0ac84b0c).
          && (claimants.get(k) ?? []).length === 1
          && claimants.get(k)![0] === owner
        ) {
          foreignComplete.push(k);
        }
      } else {
        // No id at all: nothing in the slot identifies its call, so attribution
        // must be decided by CONTENT or by the single-call fallback.
        //
        // FIFTH shape (live 2026-10-29 11:49:00.884Z, receipt 52a2712b — the
        // POST-fix failure): the complete payload arrives in an ID-LESS unnamed
        // slot while the named head is also id-less, so `named.length === 1`
        // was the only route left and ANY sibling call in the same turn
        // disabled it — the head dispatched alone and rejected with "Unexpected
        // end of JSON input" with its goal unmoved. The id carries no
        // attribution information here, so the bytes must decide: a COMPLETE
        // id-less orphan whose bytes open with exactly ONE incomplete head's
        // bytes is that head's payload. A truncated orphan can never qualify
        // (it does not parse), a two-claimant orphan is a genuine coin flip and
        // still declines (shape D/`M` welding stays impossible: selection never
        // concatenates), so the 2026-08-30 audit and the F2/X1 guard hold.
        if (isCompleteJsonObject(orphan.args)) {
          if ((claimants.get(k) ?? []).length === 1 && claimants.get(k)![0] === owner) {
            foreignComplete.push(k);
          } else if ((claimants.get(k) ?? []).length === 0 && named.length === 1) {
            // No byte-level proof either way, but this is the only named call in
            // the turn, so the pre-existing single-call fallback still applies
            // (pinned by the PAIR-shape suite: a payload whose head bytes do NOT
            // prefix-match is still that lone call's — attempt 2 selects it).
            orphans.push(k);
          }
        } else if (named.length === 1) {
          // A non-complete id-less fragment: only attributable when the turn
          // holds exactly ONE named call (unchanged — no bytes to verify with).
          orphans.push(k);
        }
      }
    }
    if (!orphans.length && !foreignComplete.length) continue;
    // ATTEMPT 1 — the ORDINARY continuation: the orphan fragment(s) carry the
    // tail of this call's one payload, so concatenating the model's own bytes
    // yields a complete JSON object. Slot index is the gateway's `index`, not
    // arrival order, but the owner always holds the head, so the fragments are
    // appended in index order after it. This leg keeps the pre-existing forward
    // behaviour for a multi-fragment tail.
    const joined = orphans.reduce((s, k) => appendArgumentsFragment(s, acc[k].args), acc[owner].args);
    if (isCompleteJsonObject(joined)) {
      acc[owner].args = joined;
      for (const k of orphans) { delete acc[k]; folded.push(k); }
      continue;
    }
    // ATTEMPT 2 — the PAIR shape (ticket efdb3d31, live on the ensemble
    // supervisor seat at 06:13Z/06:16Z on 2026-10-29). The seat emits TWO
    // payloads for one tool_call id: the NAMED slot holds a SEVERED HEAD
    // (`{"todoId": "86911a13", "progressNote": `) and an UNNAMED slot holds the
    // COMPLETE payload. Concatenating them yields invalid JSON ("Expected ',' or
    // '}'"), and dropping the orphan dispatches the severed head alone
    // ("Unexpected end of JSON input") — the reported rejection, with exactly ONE
    // ok:false row because only that call was ever dispatched.
    //
    // The repair is SELECTION, not concatenation: when EXACTLY ONE orphan is
    // already a complete JSON object, that IS the call the model finished, so its
    // bytes are taken under the owner's name. Nothing is completed or invented —
    // the chosen payload is byte-for-byte what the model emitted for this id, and
    // a truncated payload can never qualify (it does not parse), so a genuinely
    // severed call still rejects at the parser.
    //
    // THIRD SHAPE (ticket efdb3d31, live 2026-10-29 08:44:33Z on the Schooltime
    // ensemble seat, receipt 9f9d5bf3): the twin invoke is emitted under its OWN
    // gateway id, so it never reached `orphans` at all — the strict same-id
    // attribution above refused it and it was dropped before this leg ran. The
    // observable is identical (ONE ok:false, "Unexpected end of JSON input"), but
    // the discriminator is the parse reason: welding a complete payload to a
    // severed head yields "Unexpected non-whitespace character after JSON", so
    // that reason provably came from a head dispatched ALONE. `foreignComplete`
    // carries exactly those candidates and is only ever SELECTED, never appended.
    const completeOrphans = [...orphans, ...foreignComplete].filter(k => isCompleteJsonObject(acc[k].args));
    if (completeOrphans.length === 1) {
      const winner = completeOrphans[0];
      acc[owner].args = acc[winner].args;
      delete acc[winner];
      folded.push(winner);
      continue;
    }
    // Neither an assembled tail nor a single complete payload: leave the orphan
    // dropped and the owner exactly as it was. A truncated call still dies at the
    // parser (the 2026-08-30 audit invariant).
  }
  return folded;
}
