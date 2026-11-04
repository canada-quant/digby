/**
 * REPLAY — ticket efdb3d31 (post-close reproduction of ticket 3b75ba8e).
 *
 * Reported: after fix a2da5f49 (PR #2067) shipped and deploy run 40796106403
 * concluded success, the Schooltime project supervisor's (chat 41bd202a)
 * `goal_update` was STILL refused, twice in one run (2026-10-29 01:41:08Z and
 * 01:42:33Z), each time with
 *
 *   [tool call rejected] The arguments for goal_update did not parse as a JSON
 *   object … Parser said: Unexpected end of JSON input … NOTHING was executed.
 *
 * Attempt 1 carried a long progressNote and attempt 2 a deliberately SHORT one —
 * identical failure. The run's receipts hold exactly ONE goal_update row per
 * attempt and never an ok:true, so neither a duplicate call nor a second call
 * existed: the ONE dispatched call's arguments ended mid-value.
 *
 * ROOT CAUSE PINNED HERE (a gap a2da5f49 does not cover, not a regression of it).
 * The model emits ONE call as two deltas:
 *   delta 1  { index: 0, id: 'call_A', function: { name: 'goal_update', arguments: '{"goalId": "8f0dcd6f", "progressNote": ' } }
 *   delta 2  {              id: 'call_A', function: {                              arguments: '"…the whole note…"}' } }
 * `resolveToolCallSlot` rule 1 ("an explicit index wins") routes delta 2 into a
 * FRESH slot — at its own index, carrying NO `name`. The slot therefore exists
 * but is UNNAMED, and `runModelTurn`'s finalize builds its call list with
 * `.filter(tc => tc.name)`, which DISCARDS it. The call is dispatched holding
 * only its header:
 *
 *   slot 0  goal_update  {"goalId": "8f0dcd6f", "progressNote":   ← dispatched, REJECTED
 *   slot 1  (unnamed)    "…the whole note…"}'                      ← silently dropped
 *
 * The mechanism is POSITIONAL, not about payload size — which is exactly why the
 * reporter's short retry failed byte-identically, and why the fault is specific
 * to a tool whose first field is followed by a long free-form prose value.
 *
 * THE FIX: `mergeOrphanContinuations` folds an unnamed continuation slot back
 * into the ONE call it belongs to, BEFORE unnamed slots are filtered away. It
 * requires (1) no tool name on the orphan, (2) attribution to exactly one named
 * call — same gateway id when present, else only in a single-call turn, and
 * (3) an owner that has NOT already assembled a complete payload — a2da5f49's
 * rule that a finished call never absorbs foreign bytes.
 *
 * THE FOLD WORKS PER OWNER, in two legs, because the live failure was NOT a
 * head+tail split. Slot index is the GATEWAY's `index`, not arrival order, so the
 * orphan may sit on either side of its owner:
 *   1. APPEND — the ordinary continuation: the orphan fragment(s) carry the tail
 *      of this call's one payload, so concatenating the model's own bytes yields
 *      a complete JSON object. Handles a one- or multi-fragment tail.
 *   2. SELECT — the PAIR shape (live on the supervisor ensemble seat, 2026-10-29
 *      06:13Z/06:16Z, receipts a72f4f66 + the e1e7ab69 goal_update): the seat
 *      emits TWO payloads for ONE tool_call id — the NAMED slot holds a SEVERED
 *      HEAD and an UNNAMED slot holds the COMPLETE payload. The append leg
 *      correctly declines (head+complete is invalid JSON, "Expected ',' or '}'"),
 *      which used to leave the orphan dropped and dispatch the severed head alone
 *      ("Unexpected end of JSON input", exactly ONE ok:false row). When EXACTLY
 *      ONE orphan is already a complete JSON object, its bytes are taken under
 *      the owner's name — selection, not concatenation.
 *
 * THE 2026-08-30 AUDIT STILL GOVERNS: bytes only ever move between slots of the
 * SAME call id, and they are only ever bytes the model emitted. Nothing is
 * fabricated or auto-completed; a payload still truncated after the fold stays a
 * rejection (a truncated orphan can never be selected — it does not parse), and
 * an unattributable or ambiguous orphan stays dropped.
 */
import {
  parseToolArguments,
  resolveToolCallSlot,
  appendArgumentsFragment,
  mergeOrphanContinuations,
  uniqueToolCallId,
  UNRESOLVABLE_SLOT,
  DUPLICATE_FRAGMENT,
} from './tool-arguments';

const GOAL_ID = '8f0dcd6f';

/** The reporter's literal cut-off point, as it appeared in the emitted stream. */
const SEVERED_HEADER_ARGS = '{"goalId": "8f0dcd6f", "progressNote": ';

/** A long note and a deliberately SHORT one — both failed identically in prod. */
const LONG_NOTE = 'ca-on N6 landed: 18883 manifest rows, 7153 speaker turns';
const SHORT_NOTE = 'N6 landed';

/**
 * The REAL accumulator loop from coding-model.ts plus its finalize step, so this
 * replay exercises the shipped routing rather than a look-alike.
 */
function accumulate(deltas: Array<Array<any>>) {
  const acc: Record<number, { id: string; name: string; args: string; gwId?: string }> = {};
  let lastSlot = -1;
  let ambiguous = false;
  for (const batch of deltas) {
    for (const tc of batch) {
      const idx = resolveToolCallSlot(acc, tc, lastSlot);
      if (idx === UNRESOLVABLE_SLOT) { ambiguous = true; continue; }
      if (idx === DUPLICATE_FRAGMENT) continue;
      lastSlot = idx;
      if (!acc[idx]) acc[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
      if (tc.id) {
        acc[idx].gwId = tc.id;
        acc[idx].id = uniqueToolCallId(acc, idx, tc.id);
      }
      if (tc.function?.name) acc[idx].name = tc.function.name;
      if (tc.function?.arguments) acc[idx].args = appendArgumentsFragment(acc[idx].args, tc.function.arguments);
    }
  }
  return { acc, ambiguous };
}

/** coding-model.ts's finalize: named slots only, in slot order. */
function finalize(acc: Record<number, { id: string; name: string; args: string }>) {
  return Object.keys(acc)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => acc[Number(k)])
    .filter((tc) => tc.name);
}

/** The shipped fix, applied exactly where coding-model.ts applies it. */
function withFix(deltas: Array<Array<any>>) {
  const { acc, ambiguous } = accumulate(deltas);
  const folded = ambiguous ? [] : mergeOrphanContinuations(acc);
  return { calls: finalize(acc), folded, ambiguous };
}

/** A fragment with the tool name — how a call's FIRST delta arrives. */
const first = (args: string, opts: { index?: number; id?: string; name?: string } = {}) => ({
  ...(opts.index !== undefined ? { index: opts.index } : {}),
  ...(opts.id !== undefined ? { id: opts.id } : {}),
  function: { name: opts.name ?? 'goal_update', arguments: args },
});

/** A continuation fragment — NO name, which is what strands it in its own slot. */
const cont = (args: string, opts: { index?: number; id?: string } = {}) => ({
  ...(opts.index !== undefined ? { index: opts.index } : {}),
  ...(opts.id !== undefined ? { id: opts.id } : {}),
  function: { arguments: args },
});

/** The reported emission shape: header at index 0 with the name, tail at index 1. */
const reportedShape = (note: string) => [
  [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
  [cont(`"${note}"}`, { index: 1, id: 'call_A' })],
];

describe('ticket efdb3d31 — an orphaned continuation slot must not truncate its call', () => {
  describe('the reported class reproduces WITHOUT the fix (why this is needed)', () => {
    it('discards the unnamed continuation and dispatches the call holding only its header', () => {
      const { acc } = accumulate(reportedShape(LONG_NOTE));
      const calls = finalize(acc);

      // Exactly ONE dispatched call — matching the single goal_update receipt the
      // live run produced (never two).
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('goal_update');
      // ... and its arguments are the header alone, which is the reported reason.
      expect(calls[0].args).toBe(SEVERED_HEADER_ARGS);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/Unexpected end of JSON input/);
    });

    it('fails identically for a deliberately SHORT note — the mechanism is positional, not size', () => {
      const shortened = accumulate(reportedShape(SHORT_NOTE)).acc;
      const long = accumulate(reportedShape(LONG_NOTE)).acc;
      expect(finalize(shortened)[0].args).toBe(finalize(long)[0].args);
      expect(parseToolArguments(finalize(shortened)[0].args).ok).toBe(false);
    });
  });

  describe('WITH the fix the complete call executes', () => {
    it('folds the orphan back in and the goal_update payload parses', () => {
      const { calls, folded } = withFix(reportedShape(LONG_NOTE));

      expect(folded).toEqual([1]); // the orphan slot was actually folded away
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('goal_update');

      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.args).toEqual({ goalId: GOAL_ID, progressNote: LONG_NOTE });
      }
    });

    it('recovers the SHORT retry too', () => {
      const { calls } = withFix(reportedShape(SHORT_NOTE));
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args.progressNote).toBe(SHORT_NOTE);
    });

    it('folds several continuation fragments, not just one', () => {
      const { calls } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont('"N6 landed, ', { index: 1, id: 'call_A' })],
        [cont('18883 rows"}', { index: 2, id: 'call_A' })],
      ]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args.progressNote).toBe('N6 landed, 18883 rows');
    });

    it('folds when the continuation carries no index at all (id-only routing)', () => {
      const { calls } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont(`"${SHORT_NOTE}"}`, { id: 'call_A' })],
      ]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args.progressNote).toBe(SHORT_NOTE);
    });

    it('folds in a single-call turn whose orphan carries no id either', () => {
      const { calls } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0 })],
        [cont(`"${SHORT_NOTE}"}`, { index: 1 })],
      ]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args.progressNote).toBe(SHORT_NOTE);
    });
  });

  describe('the guards: the fix must never invent or hijack bytes', () => {
    it('a genuinely truncated call with NO continuation still REJECTS (2026-08-30 audit)', () => {
      const { calls, folded } = withFix([[first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })]]);
      expect(folded).toEqual([]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/Unexpected end of JSON input/);
    });

    it('never folds into a call that already holds a COMPLETE payload (a2da5f49 protection)', () => {
      const complete = JSON.stringify({ goalId: GOAL_ID, progressNote: 'already complete' });
      const { calls, folded } = withFix([
        [first(complete, { index: 0, id: 'call_A' })],
        [cont('"stray tail"}', { index: 1, id: 'call_A' })],
      ]);
      expect(folded).toEqual([]);
      // The finished call keeps exactly its own payload.
      expect(calls[0].args).toBe(complete);
      expect(parseToolArguments(calls[0].args).ok).toBe(true);
    });

    it('folds a continuation that arrives at a LOWER slot index than its named head (live shape, 2026-10-29)', () => {
      // Slot index is the GATEWAY's `index`, not arrival order. The post-deploy
      // reproduction of this ticket (supervisor chats 41bd202a / daee2916,
      // 04:12–04:32Z) had the tail numbered BELOW the fragment carrying the
      // name, so a forward-only fold left the head dispatched alone:
      //   slot 0 (unnamed)   "…"}                        ← dropped by .filter(tc => tc.name)
      //   slot 1 goal_update {"goalId": …, "progressNote":  ← dispatched, REJECTED
      const { calls, folded } = withFix([
        [cont(`"${SHORT_NOTE}"}`, { index: 0, id: 'call_A' })],
        [first(SEVERED_HEADER_ARGS, { index: 1, id: 'call_A' })],
      ]);

      expect(folded).toEqual([0]); // the orphan really was folded away
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('goal_update');
      expect(parseToolArguments(calls[0].args).ok).toBe(true);
      expect(JSON.parse(calls[0].args)).toEqual({ goalId: GOAL_ID, progressNote: SHORT_NOTE });
    });

    it('a backward fold is CONTENT-VERIFIED — an unparseable join is never folded', () => {
      // Same call id, but the two halves cannot form one JSON object: the tail
      // is itself unterminated, so the join does not parse. Nothing may be
      // moved. This is what keeps the fold from ever completing a payload.
      const { calls, folded } = withFix([
        [cont('"a tail that never closes', { index: 0, id: 'call_A' })],
        [first('{"goalId": "8f0dcd6f", "progressNote": ', { index: 1, id: 'call_A' })],
      ]);

      expect(folded).toEqual([]);
      const goal = calls.find((c) => c.name === 'goal_update')!;
      expect(goal.args).toBe('{"goalId": "8f0dcd6f", "progressNote": ');
      expect(parseToolArguments(goal.args).ok).toBe(false); // still a rejection
    });

    it('never folds a backward orphan into a DIFFERENT call id, even when the join would parse', () => {
      const { folded } = withFix([
        [cont(`"${SHORT_NOTE}"}`, { index: 0, id: 'call_Z' })],
        [first(SEVERED_HEADER_ARGS, { index: 1, id: 'call_A' })],
      ]);
      expect(folded).toEqual([]);
    });

    it('still never folds into a call that already holds a COMPLETE payload, backward too', () => {
      const complete = JSON.stringify({ goalId: GOAL_ID, progressNote: 'already complete' });
      const { calls, folded } = withFix([
        [cont(`"${SHORT_NOTE}"}`, { index: 0, id: 'call_A' })],
        [first(complete, { index: 1, id: 'call_A' })],
      ]);
      expect(folded).toEqual([]);
      expect(calls[0].args).toBe(complete);
    });

    it('refuses a nameless orphan when TWO calls could own it (ambiguous attribution)', () => {
      const completeOther = JSON.stringify({ todoId: 't1', status: 'done' });
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [first(completeOther, { index: 1, id: 'call_B', name: 'todo_update' })],
        [cont(`"${SHORT_NOTE}"}`, { index: 2 })],
      ]);
      expect(folded).toEqual([]);
      // The genuinely-truncated goal_update still fails rather than borrowing bytes.
      const goal = calls.find((c) => c.name === 'goal_update')!;
      expect(parseToolArguments(goal.args).ok).toBe(false);
      const todo = calls.find((c) => c.name === 'todo_update')!;
      expect(parseToolArguments(todo.args).ok).toBe(true);
    });

    it('never merges an orphan into a DIFFERENT call id', () => {
      const completeOther = JSON.stringify({ todoId: 't1', status: 'done' });
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [first(completeOther, { index: 1, id: 'call_B', name: 'todo_update' })],
        [cont(`"${SHORT_NOTE}"}`, { index: 2, id: 'call_C' })],
      ]);
      expect(folded).toEqual([]);
      const todo = calls.find((c) => c.name === 'todo_update')!;
      expect(todo.args).toBe(completeOther);
    });

    it('refuses a nameless, id-less orphan when TWO calls could own it', () => {
      // Neither named call carries a gateway id, so the single-call fallback
      // cannot attribute the orphan to one of them — it must stay dropped.
      const completeOther = JSON.stringify({ todoId: 't1', status: 'done' });
      const { acc } = accumulate([
        [first(SEVERED_HEADER_ARGS, { index: 0 })],
        [first(completeOther, { index: 1, name: 'todo_update' })],
        [cont(`"${SHORT_NOTE}"}`, { index: 2 })],
      ]);
      expect(mergeOrphanContinuations(acc)).toEqual([]);
    });

    it('is idempotent — a second pass finds nothing left to fold', () => {
      const { acc } = accumulate(reportedShape(LONG_NOTE));
      const firstPass = mergeOrphanContinuations(acc);
      const secondPass = mergeOrphanContinuations(acc);
      expect(firstPass).toEqual([1]);
      expect(secondPass).toEqual([]);
    });
  });

  describe('sibling isolation — a malformed call never takes down a COMPLETE one', () => {
    // The reported impact claim was "NOTHING was executed". That is true of the
    // malformed call, but it must NOT extend to a well-formed SIBLING in the same
    // turn: runTool RETURNS the rejection as a tool message (agent.ts:1246) rather
    // than throwing, so the dispatch loop continues to the next call. This pins
    // that the finalize step hands BOTH calls to the loop, the complete one intact.
    it('dispatches a complete sibling even when another call is truncated with no continuation', () => {
      const completeTodo = JSON.stringify({ todoId: 't1', status: 'done', progressNote: 'real work landed' });
      const { calls, folded } = withFix([
        [first(completeTodo, { index: 0, id: 'call_B', name: 'todo_update' })],
        [first(SEVERED_HEADER_ARGS, { index: 1, id: 'call_A' })],
      ]);

      // Nothing to fold: call_A genuinely has no continuation bytes at all.
      expect(folded).toEqual([]);
      expect(calls).toHaveLength(2);

      const todo = calls.find((c) => c.name === 'todo_update')!;
      expect(parseToolArguments(todo.args).ok).toBe(true);
      expect(JSON.parse(todo.args)).toEqual({ todoId: 't1', status: 'done', progressNote: 'real work landed' });

      // The truncated sibling rejects on its OWN — its failure is not silent,
      // and it did not corrupt the complete call's payload.
      const goal = calls.find((c) => c.name === 'goal_update')!;
      const parsedGoal = parseToolArguments(goal.args);
      expect(parsedGoal.ok).toBe(false);
      expect(todo.args).toBe(completeTodo);
    });

    it('a complete sibling survives even when the orphan is folded into a DIFFERENT call', () => {
      // Two named calls, the orphan belongs to call_A by gateway id. call_B is
      // complete and must be left byte-for-byte untouched by the fold.
      const completeOther = JSON.stringify({ todoId: 't2', status: 'done' });
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [first(completeOther, { index: 1, id: 'call_B', name: 'todo_update' })],
        [cont(`"${SHORT_NOTE}"}`, { index: 2, id: 'call_A' })],
      ]);

      expect(folded).toEqual([2]);
      const todo = calls.find((c) => c.name === 'todo_update')!;
      expect(todo.args).toBe(completeOther);
      expect(parseToolArguments(todo.args).ok).toBe(true);

      const goal = calls.find((c) => c.name === 'goal_update')!;
      expect(parseToolArguments(goal.args).ok).toBe(true);
      expect(JSON.parse(goal.args)).toEqual({ goalId: GOAL_ID, progressNote: SHORT_NOTE });
    });
  });

  describe('the PAIR shape — TWO payloads for one id, not one payload in two halves', () => {
    // Live reproductions that re-opened this ticket AFTER the fold shipped
    // (supervisor ensemble seat, 2026-10-29, every serving process on the fix):
    //   todo_update 06:13:00.946Z  receipt a72f4f66  todoId 86911a13
    //   goal_update ~06:16:21Z     goal e1e7ab69
    // Each rejected with "Unexpected end of JSON input … NOTHING was executed"
    // and minted exactly ONE ok:false row — so ONE call was dispatched, holding
    // only a severed head.
    //
    // The mechanism this pins: the NAMED slot carries the severed HEAD and an
    // UNNAMED slot carries the COMPLETE payload. The two are NOT head+tail of one
    // payload — concatenating them yields invalid JSON ("Expected ',' or '}'"),
    // which is why the content-verified append declined and the orphan was
    // dropped, dispatching the head alone. The repair is SELECTION of the one
    // complete payload, never concatenation.
    const COMPLETE_NOTE = JSON.stringify({ todoId: '86911a13', progressNote: 'ca-on N6 landed: 18883 manifest rows' });

    it('executes the complete payload when it lands in an UNNAMED slot ABOVE the severed named head', () => {
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont(COMPLETE_NOTE, { index: 1, id: 'call_A' })],
      ]);

      expect(folded).toEqual([1]);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('goal_update'); // the name is kept from the head
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ todoId: '86911a13', progressNote: 'ca-on N6 landed: 18883 manifest rows' });
    });

    it('executes the complete payload when the unnamed slot carries NO gateway id at all', () => {
      // A gateway that sends the complete payload without an id still attributes
      // by the single-call-turn rule.
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont(COMPLETE_NOTE, { index: 1 })],
      ]);

      expect(folded).toEqual([1]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ todoId: '86911a13', progressNote: 'ca-on N6 landed: 18883 manifest rows' });
    });

    it('executes the complete payload when it lands BELOW the severed named head (backward pair)', () => {
      const { calls, folded } = withFix([
        [cont(COMPLETE_NOTE, { index: 0, id: 'call_A' })],
        [first(SEVERED_HEADER_ARGS, { index: 1, id: 'call_A' })],
      ]);

      expect(folded).toEqual([0]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ todoId: '86911a13', progressNote: 'ca-on N6 landed: 18883 manifest rows' });
    });

    it('executes the complete payload when neither fragment carries an id', () => {
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0 })],
        [cont(COMPLETE_NOTE, { index: 1 })],
      ]);

      expect(folded).toEqual([1]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ todoId: '86911a13', progressNote: 'ca-on N6 landed: 18883 manifest rows' });
    });

    it('NEVER selects when TWO orphans are complete — the payload is ambiguous, so nothing is folded', () => {
      // Two different complete payloads for one id: picking either would be a
      // guess about what the model meant. Refuse; the head still rejects.
      const other = JSON.stringify({ todoId: '86911a13', progressNote: 'a DIFFERENT note' });
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont(COMPLETE_NOTE, { index: 1, id: 'call_A' })],
        [cont(other, { index: 2, id: 'call_A' })],
      ]);

      expect(folded).toEqual([]);
      expect(parseToolArguments(calls[0].args).ok).toBe(false);
    });

    it('NEVER selects a truncated orphan — a genuinely severed payload still REJECTS', () => {
      // The audit invariant, restated for the pair shape: selection can only ever
      // choose bytes that ALREADY parse. A truncated orphan never qualifies.
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont('"a note that never closes', { index: 1, id: 'call_A' })],
      ]);

      expect(folded).toEqual([]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/Unexpected end of JSON input/);
    });

    it('never lets the selection leg touch a DIFFERENT call id', () => {
      const completeForOther = JSON.stringify({ todoId: 'zzz', progressNote: 'not yours' });
      const { folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_A' })],
        [cont(completeForOther, { index: 1, id: 'call_B' })],
      ]);
      expect(folded).toEqual([]);
    });
  });

  describe('the TWIN-INVOKE shape — the re-emit carries its OWN gateway id', () => {
    // Live reproduction that re-opened this ticket a THIRD time, AFTER PR #2076's
    // pair-shape selection shipped and every serving process was on it:
    //   goal_update 2026-10-29T08:44:33.979Z  receipt 9f9d5bf3  ok:false
    //   "Unexpected end of JSON input … NOTHING was executed"
    // Turn chat-01949ac7 minted exactly ONE goal_update row and never an ok:true,
    // so ONE call was dispatched holding a severed head.
    //
    // WHY the pair-shape repair missed it: `id` identifies the CALL, and a gateway
    // that re-emits one call as two invokes mints a SECOND id for the re-emit. The
    // fold's attribution tested `acc[owner].gwId === gw`, so the complete twin was
    // never attributed to its owner at all — it was dropped by finalize's
    // `.filter(tc => tc.name)` before selection could ever consider it.
    //
    // THE DISCRIMINATOR that proves the head was dispatched ALONE (not welded):
    // concatenating a complete payload onto a severed head yields "Unexpected
    // non-whitespace character after JSON" (V8 rejects the trailing bytes), so the
    // reported "Unexpected end of JSON input" can only come from a head by itself.
    //
    // The repair is still SELECTION, now content-VERIFIED: the twin's bytes must
    // reach back to the same call, which they do only if the severed head is a
    // literal PREFIX of the candidate payload. That keeps the F2/X1 guard intact —
    // a complete payload belonging to a genuinely different call never opens with
    // this head, so it stays dropped (asserted below).
    const liveComplete = JSON.stringify({
      goalId: GOAL_ID,
      progressNote: '08:44Z: LOCAL-capture-day stems re-file verified done (todo 8e432a5b, dir≠day 0, discriminating 7/7 local); 5560 Hue re-auth executing in lane 0037460b; backlog:clips_decrypted=905 (register of record f82 set).',
    });

    it('executes the complete twin even though its gateway id DIFFERS from the named head', () => {
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_X' })],
        [cont(liveComplete, { index: 1, id: 'call_Y' })],
      ]);

      expect(folded).toEqual([1]);
      // Exactly ONE dispatched call — the live turn held one goal_update row.
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('goal_update');
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ goalId: GOAL_ID, progressNote: JSON.parse(liveComplete).progressNote });
    });

    it('REJECTS still, when the foreign-id twin is not a continuation of this head', () => {
      // The F2/X1 boundary: a complete payload for a genuinely different call must
      // never execute under this call's name, even when it is the only named call
      // in the turn and the only complete candidate. Its bytes do not open with
      // this head, so attribution must decline and the severed head must reject.
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_X' })],
        [cont(JSON.stringify({ todoId: 'zzz', progressNote: 'not yours' }), { index: 1, id: 'call_Y' })],
      ]);

      expect(folded).toEqual([]);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/Unexpected end of JSON input/);
    });

it('FOURTH SHAPE (live 10:06:48Z, receipt 0ac84b0c): an unrelated named SIBLING no longer disables the repair', () => {
      // The reporter's live turn carried a second, wholly unrelated named call.
      // The old `named.length === 1` gate refused the moment that sibling existed,
      // so the complete goal_update payload was dropped before dispatch and the
      // call went out holding its severed head alone — "Unexpected end of JSON
      // input" with the target goal never touched. Uniqueness must be decided by
      // the BYTES: this payload opens with the goal_update head and with no other
      // incomplete head, so it can only be that call's own finished payload.
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_X' })],
        [first('{"view":"deploy"}', { index: 1, id: 'call_Z', name: 'get_fleet_telemetry' })],
        [cont(liveComplete, { index: 2, id: 'call_Y' })],
      ]);
      expect(folded).toEqual([2]);
      const goal = calls.find((c) => c.name === 'goal_update')!;
      const parsed = parseToolArguments(goal.args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ goalId: GOAL_ID, progressNote: JSON.parse(liveComplete).progressNote });
      // The sibling is untouched and still dispatches with its OWN bytes.
      const sibling = calls.find((c) => c.name === 'get_fleet_telemetry')!;
      expect(sibling.args).toBe('{"view":"deploy"}');
    });

    it('FIFTH SHAPE (live 11:49:00.884Z post-fix, receipt 52a2712b): an ID-LESS complete payload is claimed by CONTENT', () => {
      // The post-fix live failure. The complete payload arrives in an unnamed slot
      // that carries NO gateway id, and the named head is id-less too. The old leg
      // attributed an id-less orphan ONLY when the turn held exactly one named
      // call (`named.length === 1`), so the ordinary sibling this supervisor turn
      // also emitted disabled the repair: the head dispatched alone and rejected
      // "Unexpected end of JSON input" while the goal never moved.
      //
      // The id cannot decide attribution when there is no id — the BYTES must. The
      // payload is complete and opens with exactly one incomplete head's bytes, so
      // it can only be that call's own finished payload.
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0 })],
        [first('{"goalId": "8f0dcd6f"}', { index: 1, id: 'call_Z', name: 'goal_get' })],
        [cont(liveComplete, { index: 2 })],
      ]);
      expect(folded).toEqual([2]);
      const goal = calls.find((c) => c.name === 'goal_update')!;
      const parsed = parseToolArguments(goal.args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ goalId: GOAL_ID, progressNote: JSON.parse(liveComplete).progressNote });
      // The id-less sibling keeps its OWN bytes — selection never leaks across calls.
      const sibling = calls.find((c) => c.name === 'goal_get')!;
      expect(sibling.args).toBe('{"goalId": "8f0dcd6f"}');
    });

    it('FIFTH SHAPE: an id-less payload whose bytes belong to NO head stays dropped', () => {
      // Content-claiming must not become "any complete id-less slot belongs to the
      // severed call". A payload that does not open with the head's bytes is a
      // DIFFERENT call's payload and must never be selected as ours.
      const foreign = JSON.stringify({ todoId: 'zzz', status: 'done' });
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0 })],
        [first('{"view":"deploy"}', { index: 1, id: 'call_Z', name: 'get_fleet_telemetry' })],
        [cont(foreign, { index: 2 })],
      ]);
      expect(folded).toEqual([]);
      const goal = calls.find((c) => c.name === 'goal_update')!;
      expect(parseToolArguments(goal.args).ok).toBe(false);
    });

    it('still refuses when TWO incomplete heads could claim the payload (a real coin flip)', () => {
      // Both named calls are severed and both open identically, so the complete
      // payload is genuinely ambiguous. Fail-closed: it stays dropped and each
      // head rejects rather than one of them executing borrowed bytes.
      const { acc } = accumulate([
        [first('{"goalId": ', { index: 0, id: 'call_X' })],
        [first('{"goalId": ', { index: 1, id: 'call_Z', name: 'todo_update' })],
        [cont(liveComplete, { index: 2, id: 'call_Y' })],
      ]);
      expect(mergeOrphanContinuations(acc)).toEqual([]);
    });

    it('never selects a truncated foreign-id twin — it does not parse, so it can never qualify', () => {
      const { calls, folded } = withFix([
        [first(SEVERED_HEADER_ARGS, { index: 0, id: 'call_X' })],
        [cont('"a note that never closes', { index: 1, id: 'call_Y' })],
      ]);
      expect(folded).toEqual([]);
      expect(parseToolArguments(calls[0].args).ok).toBe(false);
    });
  });
});