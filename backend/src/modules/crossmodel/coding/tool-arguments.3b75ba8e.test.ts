/**
 * REPLAY — ticket 3b75ba8e (post-deploy reproduction of ticket 5bdbb126).
 *
 * Reported: after fix 742d9350 (transfer #2062) shipped and its deploy run
 * 40774840994 concluded success, a project supervisor's EVERY `goal_update`
 * was still refused with
 *
 *   [tool call rejected] The arguments for goal_update did not parse as a JSON
 *   object … Parser said: Unexpected end of JSON input.
 *
 * — three attempts in one run (23:13Z, chat 41bd202a), and no successful
 * goal_update receipt since the deploy. The reporter's diagnostic: "each
 * COMPLETE goal_update is accompanied by a TWIN truncated call with the same
 * goalId and a cut-off progressNote … sharing slot with the complete call."
 *
 * THE DEFECT THIS FILE PINS (a gap in 742d9350, not a regression of it):
 * `resolveToolCallSlot` returned EARLY on an explicit `index` (rule 1) or on a
 * matching `id` (rule 2) — before rule 5's "this slot already holds a COMPLETE
 * JSON object, so a fragment that opens a new one starts the NEXT call" check.
 * A gateway that reuses the same index/id for the severed twin therefore
 * appended it straight onto the complete payload:
 *
 *   {"goalId":"8f0dcd6f","progressNote":"N6 landed"}{"goalId": "8f0dcd6f", "progressNote":
 *
 * → the COMPLETE call was destroyed by its twin and the turn read as
 * "truncated or malformed" even though the model had emitted a valid call. The
 * fix applies the completion check on EVERY routing path (index, id, and the
 * anonymous rule-4 path), so a finished call can never absorb the next call's
 * bytes, and recognises an EXACT re-send of an already-complete payload as a
 * duplicate fragment so a retransmitting gateway cannot fire the same mutating
 * call twice.
 *
 * THE 2026-08-30 AUDIT STILL GOVERNS: the severed twin is still REJECTED and
 * never executed — the split rescues the complete call, it never makes a
 * truncated payload executable.
 */
import {
  parseToolArguments,
  resolveToolCallSlot,
  appendArgumentsFragment,
  UNRESOLVABLE_SLOT,
  DUPLICATE_FRAGMENT,
  uniqueToolCallId,
} from './tool-arguments';

const GOAL_ID = '8f0dcd6f';
const OTHER_GOAL_ID = '53c7e5f6';

/** The complete call the model meant to make. */
const COMPLETE_ARGS = JSON.stringify({ goalId: GOAL_ID, progressNote: 'ca-on N6 landed' });

/**
 * The reporter's literal twin: the SAME call cut off mid-value, exactly as it
 * appeared in the emitted call stream (`{"goalId": "8f0dcd6f", "progressNote": `).
 */
const SEVERED_TWIN_ARGS = '{"goalId": "8f0dcd6f", "progressNote": ';

/** The REAL accumulator loop from coding-model.ts, using the fixed slotting. */
function accumulate(deltas: Array<Array<any>>) {
  const acc: Record<number, { id: string; name: string; args: string; gwId?: string }> = {};
  let lastSlot = -1;
  let skippedDuplicates = 0;
  let ambiguous = false;
  for (const batch of deltas) {
    for (const tc of batch) {
      const idx = resolveToolCallSlot(acc, tc, lastSlot);
      if (idx === UNRESOLVABLE_SLOT) { ambiguous = true; continue; }
      if (idx === DUPLICATE_FRAGMENT) { skippedDuplicates += 1; continue; }
      lastSlot = idx;
      if (!acc[idx]) acc[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
      // Production keeps the gateway id as the routing key and de-duplicates
      // only the EMITTED id (coding-model.ts). The harness must mirror that or
      // its routing differs from the shipped loop (independent review round 2).
      if (tc.id) {
        acc[idx].gwId = tc.id;
        acc[idx].id = uniqueToolCallId(acc, idx, tc.id);
      }
      if (tc.function?.name) acc[idx].name = tc.function.name;
      if (tc.function?.arguments) acc[idx].args = appendArgumentsFragment(acc[idx].args, tc.function.arguments);
    }
  }
  return {
    calls: Object.keys(acc).sort((a, b) => Number(a) - Number(b)).map(k => acc[Number(k)]),
    skippedDuplicates,
    ambiguous,
  };
}

const delta = (args: string, opts: { index?: number; id?: string; name?: string } = {}) => ({
  ...(opts.index !== undefined ? { index: opts.index } : {}),
  ...(opts.id !== undefined ? { id: opts.id } : {}),
  function: { name: opts.name ?? 'goal_update', arguments: args },
});

describe('ticket 3b75ba8e — a completed call must never absorb its severed twin', () => {
  describe('the reported class reproduces on the pre-fix router', () => {
    it('appending the twin to a COMPLETE payload really does destroy it (why the fix is needed)', () => {
      const poisoned = COMPLETE_ARGS + SEVERED_TWIN_ARGS;
      const parsed = parseToolArguments(poisoned);
      expect(parsed.ok).toBe(false);
      // The reporter's exact reason for a twin-alone slot, and the
      // concatenation reason for a shared slot — both are "the block is dead".
      if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
      // …while the complete call on its own is perfectly executable.
      expect(parseToolArguments(COMPLETE_ARGS).ok).toBe(true);
    });
  });

  describe('rule 5 now applies to an EXPLICIT index (not just the anonymous path)', () => {
    it('a fragment opening a new object does NOT land on a completed indexed slot', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      // Pre-fix: returned 0 (rule 1 early return) -> "{…}{…}" -> both dead.
      expect(resolveToolCallSlot(acc, delta(SEVERED_TWIN_ARGS, { index: 0 }), 0)).toBe(1);
    });

    it('a fragment opening a new object does NOT land on a completed slot matched by id', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      // Pre-fix: returned 0 (rule 2 early return).
      expect(resolveToolCallSlot(acc, delta(SEVERED_TWIN_ARGS, { id: 'call_A' }), 0)).toBe(1);
    });

    it('the new slot goes past every open slot, never onto one of them', () => {
      const acc = {
        0: { id: 'a', name: 'goal_update', args: COMPLETE_ARGS },
        1: { id: 'b', name: 'todo_list', args: '' },
      };
      expect(resolveToolCallSlot(acc, delta(SEVERED_TWIN_ARGS, { index: 0 }), 0)).toBe(2);
    });
  });

  describe('a proven re-send never turns into a second execution', () => {
    it('a re-send with the SAME gateway id is a DUPLICATE fragment, not a new call', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      expect(resolveToolCallSlot(acc, delta(COMPLETE_ARGS, { index: 0, id: 'call_A' }), 0)).toBe(DUPLICATE_FRAGMENT);
      expect(resolveToolCallSlot(acc, delta(COMPLETE_ARGS, { id: 'call_A' }), 0)).toBe(DUPLICATE_FRAGMENT);
    });

    it('a whitespace-reformatted re-send with the same id is still one call (no double-fire)', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      const reformatted = JSON.stringify({ goalId: GOAL_ID, progressNote: 'ca-on N6 landed' }, null, 0)
        .replace(/,/g, ' , ');
      expect(resolveToolCallSlot(acc, delta(reformatted, { index: 0, id: 'call_A' }), 0)).toBe(DUPLICATE_FRAGMENT);
    });

    it('WITHOUT an id a re-send is NOT guessed a duplicate — it opens its own slot', () => {
      // Nothing distinguishes a retransmission from two genuine identical calls
      // (`todo_list` twice), and dropping the wrong one is SILENT (review B2).
      // The narrow guard is the safe failure: the finished call still survives,
      // and a real second call is never swallowed.
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      expect(resolveToolCallSlot(acc, delta(COMPLETE_ARGS, { index: 0 }), 0)).toBe(1);
    });

    it('a DIFFERENT tool name is never a duplicate even on the same id and payload', () => {
      const acc = { 0: { id: 'call_A', name: 'todo_list', args: '{}' } };
      expect(resolveToolCallSlot(acc, delta('{}', { index: 0, id: 'call_A', name: 'goal_list' }), 0)).toBe(1);
    });
  });

  describe('end to end — the reporter\'s turn now executes the call it meant', () => {
    it('replays 23:13Z: complete goal_update + severed twin sharing slot 0 → the complete call RUNS', () => {
      const { calls } = accumulate([
        [delta(COMPLETE_ARGS, { index: 0, id: 'call_A' })],
        [delta(SEVERED_TWIN_ARGS, { index: 0, id: 'call_A' })],
      ]);
      expect(calls).toHaveLength(2);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.args).toEqual({ goalId: GOAL_ID, progressNote: 'ca-on N6 landed' });
    });

    it('the severed twin is still REJECTED — the split never makes truncation executable', () => {
      const { calls } = accumulate([
        [delta(COMPLETE_ARGS, { index: 0, id: 'call_A' })],
        [delta(SEVERED_TWIN_ARGS, { index: 0, id: 'call_A' })],
      ]);
      const twin = calls[1];
      expect(twin.name).toBe('goal_update');
      const parsed = parseToolArguments(twin.args);
      expect(parsed.ok).toBe(false);
    });

    it('two calls that shared ONE gateway id end up with DISTINCT ids (a replayed turn must stay legal)', () => {
      const { calls } = accumulate([
        [delta(COMPLETE_ARGS, { index: 0, id: 'call_A' })],
        [delta(SEVERED_TWIN_ARGS, { index: 0, id: 'call_A' })],
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[0].id).not.toBe(calls[1].id);
      expect(new Set(calls.map(c => c.id)).size).toBe(2);
    });

    it('an exact re-send in the same slot yields ONE call, not two executions of a mutating tool', () => {
      const { calls, skippedDuplicates } = accumulate([
        [delta(COMPLETE_ARGS, { index: 0, id: 'call_A' })],
        [delta(COMPLETE_ARGS, { index: 0, id: 'call_A' })],
      ]);
      expect(calls).toHaveLength(1);
      expect(skippedDuplicates).toBe(1);
      expect(parseToolArguments(calls[0].args).ok).toBe(true);
    });

    it('a BATCHED pair (the reported "one batched pair" attempt) keeps both real calls', () => {
      const second = JSON.stringify({ goalId: OTHER_GOAL_ID, progressNote: 'other note' });
      const { calls } = accumulate([
        [delta(COMPLETE_ARGS, { index: 0, id: 'call_A' }), delta(second, { index: 1, id: 'call_B' })],
        [delta(SEVERED_TWIN_ARGS, { index: 0, id: 'call_A' })],
      ]);
      expect(calls).toHaveLength(3);
      expect(parseToolArguments(calls[0].args).ok).toBe(true);
      expect(parseToolArguments(calls[1].args).ok).toBe(true);
      expect(parseToolArguments(calls[2].args).ok).toBe(false);
    });
  });

  describe('regressions — normal streaming is untouched', () => {
    it('fragments of ONE still-open call keep appending to its indexed slot', () => {
      const acc = { 0: { id: 'c1', name: 'goal_update', args: '{"goalId":' } };
      expect(resolveToolCallSlot(acc, delta(`"${GOAL_ID}"}`, { index: 0 }), 0)).toBe(0);
    });

    it('a repeated id keeps continuing its own slot while that slot is INCOMPLETE', () => {
      const acc = { 0: { id: 'c1', name: 'goal_update', args: '{"go' } };
      expect(resolveToolCallSlot(acc, delta('alId":"g1"', { id: 'c1' }), 0)).toBe(0);
      const { calls } = accumulate([
        [{ id: 'c1', function: { name: 'goal_update', arguments: '{"go' } }],
        [{ id: 'c1', function: { name: 'goal_update', arguments: 'alId":"g1"}' } }],
      ]);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].args)).toEqual({ goalId: 'g1' });
    });

    it('two independent complete calls on their own indices are unchanged', () => {
      const second = JSON.stringify({ goalId: OTHER_GOAL_ID });
      const { calls } = accumulate([[
        delta(COMPLETE_ARGS, { index: 0, id: 'call_A' }),
        delta(second, { index: 1, id: 'call_B' }),
      ]]);
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0].args).goalId).toBe(GOAL_ID);
      expect(JSON.parse(calls[1].args).goalId).toBe(OTHER_GOAL_ID);
    });

    it('the anonymous rule-4 path still continues the call being streamed (review F2/X1 holds)', () => {
      const acc = {
        0: { id: 'c1', name: 'read_file', args: '{"path":' },
        1: { id: 'c2', name: 'git_push', args: '{"allowBase":' },
      };
      expect(resolveToolCallSlot(acc, { function: { arguments: 'true}' } }, 1)).toBe(UNRESOLVABLE_SLOT);
    });

    it('an EMPTY payload still means "no arguments" (the long-standing contract)', () => {
      const parsed = parseToolArguments('');
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({});
    });
  });

  describe('uniqueToolCallId', () => {
    it('keeps a free id unchanged', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      expect(uniqueToolCallId(acc, 1, 'call_B')).toBe('call_B');
    });

    it('derives a distinct id when another slot already holds it', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: COMPLETE_ARGS } };
      const id = uniqueToolCallId(acc, 1, 'call_A');
      expect(id).not.toBe('call_A');
      expect(id.startsWith('call_A')).toBe(true);
    });

    it('a slot may keep its OWN id (no self-collision)', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: '' } };
      expect(uniqueToolCallId(acc, 0, 'call_A')).toBe('call_A');
    });
  });

  describe('a de-duplicated emitted id must not break routing (self-review finding)', () => {
    it('a split slot\'s later fragments reach ITS slot, not the finished one (review B3)', () => {
      // The hazard: slot 0 finishes, the twin reuses id 'call_A' and takes
      // slot 1, so slot 1's EMITTED id becomes 'call_A_2'. Both slots now share
      // the gateway id. If rule 2 returned the FIRST match, slot 1's own
      // continuation would be appended to the already-finished slot 0,
      // corrupting BOTH calls. Rule 2 must prefer the slot still open.
      const acc: Record<number, any> = {
        0: { id: 'call_A', gwId: 'call_A', name: 'goal_update', args: COMPLETE_ARGS },
        1: { id: 'call_A_2', gwId: 'call_A', name: 'goal_update', args: '{"goalId":' },
      };
      expect(resolveToolCallSlot(acc, delta(`"${OTHER_GOAL_ID}"}`, { id: 'call_A' }), 1)).toBe(1);
    });

    it('a slot with no gwId falls back to its id (old shapes still route)', () => {
      const acc = { 0: { id: 'call_A', name: 'goal_update', args: '{"goalId":' } };
      expect(resolveToolCallSlot(acc, delta(`"${GOAL_ID}"}`, { id: 'call_A' }), 0)).toBe(0);
    });
  });

  describe('independent review findings — each pinned here', () => {
    it('B1: a MULTI-FRAGMENT twin never lands on the finished call', () => {
      // Only the twin's FIRST fragment leads with '{'; its later fragments are
      // continuations. Gating the closure on '{' let those fall through onto
      // the finished call and reintroduced the reported corruption.
      const { calls } = accumulate([
        [delta('{"goalId":"8f0dcd6f",', { index: 0, id: 'cA' })],
        [delta('"progressNote":"N6 landed"}', { index: 0, id: 'cA' })],
        [delta('{"goalId":"8f0dcd6f",', { index: 0, id: 'cA' })],
        [delta('"progressNote":"WRONG"', { index: 0, id: 'cA' })],
        [delta('}', { index: 0, id: 'cA' })],
      ]);
      // The COMPLETE first call must survive intact.
      const first = parseToolArguments(calls[0].args);
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.args).toEqual({ goalId: GOAL_ID, progressNote: 'N6 landed' });
      // The twin's continuation never contaminated it.
      expect(calls[0].args).not.toContain('WRONG');
    });

    it('B1b: an OBJECT-valued twin payload never lands on the finished call', () => {
      const acc: Record<number, any> = { 0: { id: 'cA', name: 'goal_update', args: COMPLETE_ARGS } };
      // Object-valued `function.arguments` (the 5bdbb126 "L3" class).
      expect(resolveToolCallSlot(acc, { id: 'cA', function: { name: 'goal_update', arguments: { goalId: GOAL_ID } } }, 0)).toBe(1);
    });

    it('B2: two DIFFERENT zero-arg tools are two calls, never a dropped duplicate', () => {
      const { calls, skippedDuplicates } = accumulate([
        [{ function: { name: 'todo_list', arguments: '{}' } }],
        [{ function: { name: 'goal_list', arguments: '{}' } }],
      ]);
      expect(calls).toHaveLength(2);
      expect(calls.map(c => c.name)).toEqual(['todo_list', 'goal_list']);
      expect(skippedDuplicates).toBe(0);
    });

    it('B2: two identical zero-arg calls of the SAME tool both survive', () => {
      const { calls } = accumulate([
        [{ function: { name: 'todo_list', arguments: '{}' } }],
        [{ function: { name: 'todo_list', arguments: '{}' } }],
      ]);
      expect(calls).toHaveLength(2);
      expect(calls.every(c => c.name === 'todo_list')).toBe(true);
    });

    it('B2: a same-name, same-payload re-send on an EXPLICIT index is still a duplicate', () => {
      const acc = { 0: { id: 'cA', name: 'git_push', args: '{"allowBase":true}' } };
      expect(resolveToolCallSlot(acc, delta('{"allowBase":true}', { index: 0, id: 'cA', name: 'git_push' }), 0)).toBe(DUPLICATE_FRAGMENT);
    });

    it('B1+B3: a continuation with no open slot fails closed, never onto a finished call', () => {
      const acc: Record<number, any> = {
        0: { id: 'cA', name: 'goal_update', args: COMPLETE_ARGS },
        1: { id: 'cB', name: 'goal_update', args: '{"goalId":"x"}' },
      };
      // Every slot finished: a stray continuation must be refused, not merged.
      expect(resolveToolCallSlot(acc, { index: 0, id: 'cA', function: { name: 'goal_update', arguments: ',"x":1}' } }, 0)).toBe(UNRESOLVABLE_SLOT);
    });

    it('a genuinely complete second call still opens its own slot (no over-splitting)', () => {
      const acc: Record<number, any> = { 0: { id: 'cA', name: 'goal_update', args: COMPLETE_ARGS } };
      const second = JSON.stringify({ goalId: OTHER_GOAL_ID });
      expect(resolveToolCallSlot(acc, delta(second, { index: 0, id: 'cA' }), 0)).toBe(1);
    });

    it('a "{" inside a STRING value does not split a call mid-stream', () => {
      const { calls } = accumulate([
        [{ index: 0, id: 'cN', function: { name: 'update_plan', arguments: '{"goal":"a ' } }],
        [{ index: 0, id: 'cN', function: { name: 'update_plan', arguments: '{ b"}' } }],
      ]);
      expect(calls).toHaveLength(1);
      expect(parseToolArguments(calls[0].args).ok).toBe(true);
    });
  });

  describe('independent review ROUND 2 — each finding pinned', () => {
    it('B1′: an empty-string arguments chunk never poisons the whole turn', () => {
      // `arguments: ""` is the OpenAI-spec FIRST chunk of a tool_call, so it is
      // ordinary conformant traffic. Treating it as an unroutable fragment used
      // to mark the entire turn ambiguous and destroy EVERY call — the ticket's
      // symptom in fail-closed clothing.
      const { calls, ambiguous } = accumulate([
        [{ index: 0, id: 'cA', function: { name: 'goal_update', arguments: COMPLETE_ARGS } }],
        [{ index: 0, id: 'cB', function: { name: 'goal_list', arguments: '' } }],
        [{ index: 0, id: 'cB', function: { arguments: '{"filter":"open"}' } }],
      ]);
      expect(ambiguous).toBe(false);
      const first = parseToolArguments(calls[0].args);
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.args).toEqual({ goalId: GOAL_ID, progressNote: 'ca-on N6 landed' });
    });

    it('B1′: a finalisation chunk with NO arguments never poisons the turn', () => {
      const { ambiguous } = accumulate([
        [{ index: 0, id: 'cA', function: { name: 'goal_update', arguments: COMPLETE_ARGS } }],
        [{ index: 0, id: 'cA', function: { name: 'goal_update' } }],
      ]);
      expect(ambiguous).toBe(false);
    });

    it('B1′: a whitespace-only chunk is inert, not a call-corrupting fragment', () => {
      const { calls, ambiguous } = accumulate([
        [{ index: 0, id: 'cA', function: { name: 'goal_update', arguments: COMPLETE_ARGS } }],
        [{ index: 0, id: 'cA', function: { name: 'goal_update', arguments: '\n' } }],
      ]);
      expect(ambiguous).toBe(false);
      // Trailing whitespace on a complete payload is inert — it still parses to
      // exactly the args the model sent, so the call survives intact.
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.args).toEqual({ goalId: GOAL_ID, progressNote: 'ca-on N6 landed' });
    });

    it('B2′: a stray tail NEVER finishes a different MUTATING tool', () => {
      // The worst possible outcome: `git_push` firing with bytes another call
      // wrote, without the turn even flagging ambiguity.
      const { calls, ambiguous } = accumulate([
        [{ index: 0, id: 'cA', function: { name: 'goal_update', arguments: '{"goalId":"g1"}' } }],
        [{ index: 1, id: 'cB', function: { name: 'git_push', arguments: '{"allowBase":' } }],
        [{ id: 'cA', function: { arguments: 'true}' } }],
      ]);
      const push = calls.find(c => c.name === 'git_push');
      expect(push).toBeDefined();
      // git_push must NOT have silently acquired `true` from another call.
      expect(push!.args).not.toContain('true');
      expect(ambiguous).toBe(true); // fail closed, loudly
    });

    it('B3′: a continuation never injects a key into a DIFFERENT tool\'s payload', () => {
      const { calls } = accumulate([
        [{ index: 0, id: 'cA', function: { name: 'goal_update', arguments: '{"goalId":"g1"}' } }],
        [{ index: 1, id: 'cA', function: { name: 'goal_update', arguments: '{"goalId":' } }],
        [{ index: 2, id: 'cA', function: { name: 'todo_update', arguments: '{"todoId":' } }],
        [{ id: 'cA', function: { name: 'todo_update', arguments: '"t9"}' } }],
      ]);
      const todo = calls.filter(c => c.name === 'todo_update');
      // The todo_update call must only ever carry todoId — never goalId.
      for (const c of todo) expect(c.args).not.toContain('goalId');
      expect(todo.some(c => c.args.includes('"todoId":"t9"'))).toBe(true);
    });
  });
});