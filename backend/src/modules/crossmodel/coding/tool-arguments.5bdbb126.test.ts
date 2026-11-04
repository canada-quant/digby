/**
 * REPLAY — ticket 5bdbb126.
 *
 * Reported: a project supervisor's `goal_update` was refused four times across
 * two wakes with "[tool call rejected] The arguments for goal_update arrived
 * truncated or malformed — NOTHING was executed", including on the final
 * attempt with a ~350-char payload that was COMPLETE at the sender. The same
 * call shape (goal_update progressNote) had worked on earlier wakes.
 *
 * Run receipts from the reporter's turn (chat 41bd202a, run
 * chat-2f4dd351-94ed-4d7f-9c88-13074bb5c677) pin the shape:
 *   - 20:09:10  FOUR parallel read calls in ONE turn, all ok
 *               (goal_list / todo_list / list_chats / list_owner_questions)
 *   - 20:12:58, 20:13:14, 20:14:51, 20:19:37  goal_update ok=false ×4
 *   - 20:15:22  update_supervisor_state ok, BETWEEN two of the failures
 * So parallel tool-call splitting was NOT the cause (it worked in the same
 * window) and the tool NAME was not the cause (a sibling write succeeded). The
 * malformation was INSIDE the payload.
 *
 * Three transport/serialization defect modes produce exactly that symptom on a
 * complete payload; each leg below replays one against the real seam:
 *   L1 a LITERAL control character inside a JSON string value (a raw newline in
 *      a multi-line progressNote) — JSON.parse: "Bad control character";
 *   L2 an index-less gateway collapsing two independent complete calls into one
 *      slot — the turn parses as `{…}{…}` and BOTH are rejected;
 *   L3 a gateway streaming arguments as an already-parsed object, concatenated
 *      into the literal text "[object Object]".
 *
 * The 2026-08-30 audit invariant is re-asserted: a genuinely TRUNCATED payload
 * must still be rejected (never executed with fabricated or empty args).
 */
import { parseToolArguments, escapeUnescapedControlChars, resolveToolCallSlot, appendArgumentsFragment, sanitizeJsonParseReason, UNRESOLVABLE_SLOT } from './tool-arguments';

const GOAL_ID = '53c7e5f6-1111-2222-3333-444455556666';

/** The reporter's real multi-line note content, unescaped (as a model may emit it). */
const MULTILINE_NOTE = 'ca-on N6 LANDED (PR #158/#129)\nin-ncert leg 2 LANDED — 488 rows\nnext: state-file trim';

describe('ticket 5bdbb126 — a complete tool payload must not be rejected as truncated', () => {
  describe('L1: a literal control character inside a JSON string value', () => {
    // Exactly what a model emits when it writes a raw newline instead of \n.
    const literalPayload = `{"goalId":"${GOAL_ID}","progressNote":"${MULTILINE_NOTE}"}`;

    it('the raw payload really does fail a plain JSON.parse (the reported class)', () => {
      expect(() => JSON.parse(literalPayload)).toThrow(/control character/i);
    });

    it('replays the incident: the SAME complete payload now parses and executes with every byte of the note', () => {
      const parsed = parseToolArguments(literalPayload);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.repaired).toBe('control-chars');
      expect(parsed.args.goalId).toBe(GOAL_ID);
      // Lossless: the note round-trips to the exact original text, newlines intact.
      expect(parsed.args.progressNote).toBe(MULTILINE_NOTE);
    });

    it('repairs every C0 control character, including a tab and a bare CR', () => {
      const payload = '{"progressNote":"a\tb\rc\nd"}';
      const parsed = parseToolArguments(payload);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.args.progressNote).toBe('a\tb\rc\nd');
    });

    it('leaves an already-correctly-escaped payload byte-identical (no repair, no drift)', () => {
      const escaped = JSON.stringify({ goalId: GOAL_ID, progressNote: MULTILINE_NOTE });
      const parsed = parseToolArguments(escaped);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.repaired).toBeUndefined();
      expect(parsed.args.progressNote).toBe(MULTILINE_NOTE);
    });

    it('an escaped quote cannot flip the in-string tracking (structural, not regex)', () => {
      // The `\"` must not end the string, so the inner quote survives and the
      // newline after it is still escaped by the repair.
      const payload = '{"progressNote":"he said \\"stop\\"\nthen left"}';
      const parsed = parseToolArguments(payload);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.args.progressNote).toBe('he said "stop"\nthen left');
    });

    it('an already-valid payload with escaped newlines is untouched by the escaper', () => {
      const escaped = '{"a":"line1\\nline2"}';
      expect(escapeUnescapedControlChars(escaped)).toBe(escaped);
    });
  });

  describe('L2: an index-less gateway must not collapse two complete calls into one slot', () => {
    /** The REAL accumulator loop from coding-model.ts, using the fixed slotting. */
    const accumulate = (deltas: Array<Array<any>>) => {
      const acc: Record<number, { id: string; name: string; args: string }> = {};
      for (const batch of deltas) {
        for (const tc of batch) {
          const idx = resolveToolCallSlot(acc, tc);
          if (!acc[idx]) acc[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' };
          if (tc.id) acc[idx].id = tc.id;
          if (tc.function?.name) acc[idx].name = tc.function.name;
          if (tc.function?.arguments) acc[idx].args = appendArgumentsFragment(acc[idx].args, tc.function.arguments);
        }
      }
      return Object.keys(acc).sort((a, b) => Number(a) - Number(b)).map(k => acc[Number(k)]);
    };

    const GOAL_UPDATE = { id: 'c1', function: { name: 'goal_update', arguments: JSON.stringify({ goalId: GOAL_ID, progressNote: 'N6 landed' }) } };
    const TODO_UPDATE = { id: 'c2', function: { name: 'todo_update', arguments: JSON.stringify({ todoId: 'ac6624f3', status: 'done' }) } };

    it('replays the incident: two independent complete calls, NO index → two parsable calls', () => {
      const calls = accumulate([[GOAL_UPDATE], [TODO_UPDATE]]);
      expect(calls).toHaveLength(2);
      expect(calls[0].name).toBe('goal_update');
      expect(calls[1].name).toBe('todo_update');
      for (const c of calls) expect(JSON.parse(c.args)).toBeTruthy();
    });

    it('the OLD index-less accumulator really did concatenate them (the reported class)', () => {
      // Prior behaviour: `const idx = tc.index ?? 0` for every fragment.
      const poisoned = JSON.stringify({ goalId: GOAL_ID, progressNote: 'N6 landed' })
        + JSON.stringify({ todoId: 'ac6624f3', status: 'done' });
      expect(() => JSON.parse(poisoned)).toThrow(/Unexpected non-whitespace character/);
    });

    it('an explicit index still wins, and fragments of one call still merge', () => {
      const calls = accumulate([
        [
          { index: 0, id: 'c1', function: { name: 'goal_update', arguments: '{"goalId":' } },
          { index: 1, id: 'c2', function: { name: 'todo_update', arguments: '{"todoId":' } },
        ],
        [
          { index: 0, function: { arguments: `"${GOAL_ID}"}` } },
          { index: 1, function: { arguments: '"ac6624f3"}' } },
        ],
      ]);
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0].args).goalId).toBe(GOAL_ID);
      expect(JSON.parse(calls[1].args).todoId).toBe('ac6624f3');
    });

    it('a repeated id keeps appending to its own slot instead of opening a new one', () => {
      const calls = accumulate([
        [{ id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }],
        [{ id: 'c1', function: { arguments: 'th":"a.ts"}' } }],
      ]);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0].args)).toEqual({ path: 'a.ts' });
    });

    it('replays the incident: two complete calls with NEITHER index NOR id still split (rule 4)', () => {
      // The parallel tool-call split the ticket named, in its worst shape: the
      // gateway sends no index and no id. A complete object in the open slot
      // plus a fragment that opens a new one means the first call finished.
      const calls = accumulate([
        [{ function: { name: 'goal_update', arguments: '{"goalId":"g1"}' } }],
        [{ function: { name: 'todo_update', arguments: '{"todoId":"t1"}' } }],
      ]);
      expect(calls).toHaveLength(2);
      expect(JSON.parse(calls[0].args)).toEqual({ goalId: 'g1' });
      expect(JSON.parse(calls[1].args)).toEqual({ todoId: 't1' });
    });

    it('rule 4 does NOT split a single call that arrives as several fragments', () => {
      // No index, no id, one call across three deltas — the note even carries a
      // raw newline. Must stay ONE call, byte-preserved.
      const calls = accumulate([
        [{ id: 'x', function: { name: 'goal_update', arguments: '{"goalId":' } }],
        [{ function: { arguments: '"g1",' } }],
        [{ function: { arguments: '"progressNote":"a\nb"}' } }],
      ]);
      expect(calls).toHaveLength(1);
      const parsed = parseToolArguments(calls[0].args);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.args).toEqual({ goalId: 'g1', progressNote: 'a\nb' });
    });

    it('a two-call mid-fragment split with neither index nor id is REJECTED, never merged into a wrong call', () => {
      // Documented limit (tool-arguments.ts rule 4): with no index and no
      // repeated id, fragments of two calls that both break after `{` are
      // indistinguishable. The honest outcome is a rejection — never a silent
      // merge that would execute one tool with another tool's arguments.
      const calls = accumulate([
        [{ id: 'c1', function: { name: 'goal_update', arguments: '{"goal' } }],
        [{ id: 'c2', function: { name: 'todo_update', arguments: '{"todo' } }],
        [{ function: { arguments: 'Id":"g1"}' } }],
        [{ function: { arguments: 'Id":"t1"}' } }],
      ]);
      for (const c of calls) expect(parseToolArguments(c.args).ok).toBe(false);
    });

    it('review F2/X1: an anonymous fragment with TWO calls open must NOT reach the highest slot', () => {
      // The reviewed hazard: routing an anonymous tail to Math.max let a
      // ZERO-ARG MUTATING tool (git_push takes no required args) execute with
      // bytes written for a different call. Verified against the real seam:
      //   before the fix -> git_push EXECUTES {"allowBase":true}
      //   after          -> every call in the turn is refused
      const acc: Record<number, { id: string; name: string; args: string }> = {
        0: { id: 'c1', name: 'read_file', args: '{"path":' },
        1: { id: 'c2', name: 'git_push', args: '{"allowBase":' },
      };
      // Last-touched slot is 1 (git_push, still streaming) but it is NOT complete.
      const verdict = resolveToolCallSlot(acc, { function: { arguments: 'true}' } }, 1);
      expect(verdict).toBe(UNRESOLVABLE_SLOT);
    });

    it('review F2: an anonymous fragment continues the call being STREAMED, not the highest slot', () => {
      // Two calls open; the LAST TOUCHED one is complete, so a fragment that
      // opens a new object starts the next call — it must not land on slot 0.
      const acc: Record<number, { id: string; name: string; args: string }> = {
        0: { id: 'a', name: 'read_file', args: '{"path":' },
        1: { id: 'b', name: 'goal_update', args: '{"goalId":"g1"}' },
      };
      expect(resolveToolCallSlot(acc, { function: { arguments: '{"todoId":"t1"}' } }, 1)).toBe(2);
    });

    it('review F2: the single-call index-less fragmented shape still merges (no false refusal)', () => {
      const acc: Record<number, { id: string; name: string; args: string }> = {
        0: { id: 'c1', name: 'goal_update', args: '{"goalId":' },
      };
      expect(resolveToolCallSlot(acc, { function: { arguments: '"g1"}' } }, 0)).toBe(0);
    });
  });

  describe('L3: arguments already parsed into an object', () => {
    it('replays the incident: an object payload is accepted, not "[object Object]"', () => {
      const parsed = parseToolArguments({ goalId: GOAL_ID, progressNote: 'N6 landed' });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.repaired).toBe('object');
      expect(parsed.args.goalId).toBe(GOAL_ID);
    });

    it('an object fragment appends as JSON text, never as [object Object]', () => {
      const out = appendArgumentsFragment('', { goalId: GOAL_ID });
      expect(out).not.toContain('[object Object]');
      expect(JSON.parse(out).goalId).toBe(GOAL_ID);
    });

    it('review F4: a number/boolean fragment is NOT silently dropped into an empty buffer', () => {
      // Dropping it left '' which then parsed as {} — the fabricated-empty-args
      // shape the 2026-08-30 audit exists to stop. It must surface as
      // unparseable instead.
      for (const frag of [42, true, false]) {
        const out = appendArgumentsFragment('', frag);
        expect(out).not.toBe('');
        expect(parseToolArguments(out).ok).toBe(false);
      }
    });

    it('review F4: a dropped-fragment buffer can never execute as {}', () => {
      // The exact hazard path: an empty buffer used to reach the tool as {}.
      const out = appendArgumentsFragment('', 42);
      const parsed = parseToolArguments(out);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
    });

    it('null/undefined fragments continue the buffer untouched (no drift)', () => {
      expect(appendArgumentsFragment('{"a":', null)).toBe('{"a":');
      expect(appendArgumentsFragment('{"a":', undefined)).toBe('{"a":');
    });
  });

  describe('the 2026-08-30 audit invariant holds — truncation is STILL rejected', () => {
    const truncated = [
      ['cut mid-string', '{"goalId":"53c7e5f6-1111'],
      ['cut before the closing brace', '{"goalId":"g1","progressNote":"note"'],
      ['empty', ''],
      ['an array, not an object', '[1,2,3]'],
      ['a bare scalar', '42'],
    ] as const;

    it.each(truncated)('%s is rejected, never executed', (_label, payload) => {
      // An EMPTY payload is the one legitimate "no arguments" shape.
      if (!payload.trim()) {
        const parsed = parseToolArguments(payload);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.args).toEqual({});
        return;
      }
      const parsed = parseToolArguments(payload);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      // The rejection names the REAL reason — the old message claimed
      // "truncated" even for a complete-but-unescaped payload.
      expect(parsed.reason.length).toBeGreaterThan(0);
    });

    it('a truncated payload is NOT rescued by the control-character repair', () => {
      const truncatedWithNewline = '{"goalId":"g1","progressNote":"line1\nline2';
      const parsed = parseToolArguments(truncatedWithNewline);
      expect(parsed.ok).toBe(false);
    });

    it('a WHITESPACE-ONLY payload is rejected — it is malformed text, not "no arguments"', () => {
      // Main's `tc.arguments || '{}'` fell through to '{}' only for a truly
      // empty string; whitespace reached JSON.parse and threw. Executing a
      // zero-argument MUTATING tool on garbage is the 2026-08-30 hazard.
      for (const raw of ['   ', '\n\t ', ' \r\n ']) {
        expect(parseToolArguments(raw).ok).toBe(false);
      }
    });

    it('only a TRULY empty payload means "no arguments"', () => {
      for (const raw of ['', undefined, null]) {
        const parsed = parseToolArguments(raw);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.args).toEqual({});
      }
    });
  });

  describe('review finding: the rejection must never echo payload content', () => {
    it('a credential in the payload does NOT reach the reason (V8 echoes a preview)', () => {
      // V8's token-error shape is:
      //   Unexpected token 's', ...""apiKey": sk-SECRETV"... is not valid JSON
      // Putting that raw into a tool result writes the secret into the
      // transcript, the SSE stream and the logs.
      const parsed = parseToolArguments('{"apiKey": sk-SUPERSECRET-abc123}');
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.reason).not.toContain('SUPERSECRET');
      expect(parsed.reason).not.toContain('abc123');
    });

    it('sanitizeJsonParseReason keeps the structural head and masks quoted spans', () => {
      expect(sanitizeJsonParseReason('Unexpected token \'s\', ...""apiKey": sk-SECRETV"... is not valid JSON'))
        .toBe("Unexpected token 's'");
      // Positional messages carry no content — passed through intact.
      const positional = 'Expected double-quoted property name in JSON at position 69 (line 1 column 70)';
      expect(sanitizeJsonParseReason(positional)).toBe(positional);
      expect(sanitizeJsonParseReason(undefined)).toBe('unparseable JSON');
    });

    it('a quoted span surviving sanitization is masked', () => {
      const out = sanitizeJsonParseReason('Unexpected token "sk-SECRET" in JSON');
      expect(out).not.toContain('sk-SECRET');
    });
  });
});