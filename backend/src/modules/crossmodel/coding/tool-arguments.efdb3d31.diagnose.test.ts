/**
 * REPLAY — ticket efdb3d31, FIFTH post-deploy drop (2026-10-29).
 *
 * Live evidence this pins (seat 41bd202a on the DEPLOYED fix #6, 426bb127):
 *   receipts 266698a2 (13:11:06.044Z) and d8c81aee (13:12:51.875Z), both ok:false
 *   goal 53c7e5f6 updatedAt 10:48:01.811Z before AND after — unmoved
 *   verbatim: "… did not parse as a JSON object … Parser said: Unexpected end of
 *   JSON input. … NOTHING was executed."
 *   exactly ONE ok:false row per attempt, never an ok:true.
 *
 * WHY THIS IS TELEMETRY AND NOT ANOTHER ATTRIBUTION RULE.
 *
 * Six attribution repairs have now shipped into `mergeOrphanContinuations`. Before
 * writing a seventh, the SHIPPED functions were driven with fifteen candidate
 * emission shapes (head+complete at the same index / adjacent indexes / with and
 * without gateway ids / named and unnamed / one batch or two / with a sibling call
 * / with two complete payloads). Every shape that carries a complete payload is
 * either folded and dispatched intact, or produces TWO dispatches one of which
 * parses. Exactly one shape reproduces the live observables:
 *
 *     the turn holds the severed head and NOTHING ELSE.
 *
 * That is not a preference, it follows from the parse reason. Measured with this
 * repo's V8:
 *
 *     head + complete   → "Expected ',' or '}' after property value in JSON at position 90"
 *     complete + head   → "Unexpected non-whitespace character after JSON at position 51"
 *     head ALONE        → "Unexpected end of JSON input"
 *
 * So "Unexpected end of JSON input" PROVES a head dispatched alone, and therefore
 * that no complete payload was in the slot table for any of the six repairs to
 * claim. The bytes are lost BEFORE the accumulator and no attribution rule can
 * recover them.
 *
 * `diagnoseToolCallFinalize` records the facts that separate the remaining
 * mechanisms — above all an output-cap cut ('length'), which is invisible today
 * because `isEmptyTruncatedTurn` bails the moment any tool call exists.
 */
import { diagnoseToolCallFinalize, type ToolCallSlot } from './tool-arguments';

const HEAD = '{"goalId": "53c7e5f6", "progressNote": ';
const FULL = '{"goalId": "53c7e5f6", "progressNote": "N6 landed"}';
const FOREIGN = '{"todoId": "86911a13", "progressNote": "other"}';

const slot = (name: string, args: string, gwId?: string): ToolCallSlot =>
  ({ id: gwId ?? 'call_x', name, args, ...(gwId ? { gwId } : {}) });

describe('ticket efdb3d31 — finalize-seam diagnosis (observe-only)', () => {
  describe('separates the mechanisms the parse reason leaves standing', () => {
    it('S14: a severed head with NO complete payload anywhere → no_complete_payload', () => {
      // The live shape. finishReason is the datum that says whether the stream
      // was CUT (a 'length' cap) rather than the payload having gone somewhere.
      const acc = { 0: slot('goal_update', HEAD, 'call_A') };
      const d = diagnoseToolCallFinalize(acc, 'length');
      expect(d.verdict).toBe('no_complete_payload');
      expect(d.finishReason).toBe('length');
      expect(d.slots).toBe(1);
      expect(d.named).toBe(1);
      expect(d.unnamed).toBe(0);
      expect(d.broken).toHaveLength(1);
      expect(d.broken[0].name).toBe('goal_update');
      expect(d.broken[0].len).toBe(HEAD.length);
      expect(d.discardedComplete).toEqual([]);
    });

    it('records the structural parse reason, never the payload', () => {
      const acc = { 0: slot('goal_update', HEAD) };
      const d = diagnoseToolCallFinalize(acc, 'length');
      // The V8 reason for a head alone is end-of-input …
      expect(d.broken[0].reason).toMatch(/end of \w+ input/i);
      // … and points at no payload content (sanitize masks quoted spans, and the
      // note text is not even present in a severed head).
      expect(d.broken[0].reason).not.toContain('N6 landed');
    });

    it('a complete unnamed candidate that opens with no head → complete_not_prefixed', () => {
      const acc = {
        0: slot('goal_update', HEAD, 'call_A'),
        1: { id: 'call_B', name: '', args: FOREIGN, gwId: 'call_B' },
      };
      const d = diagnoseToolCallFinalize(acc, null);
      expect(d.verdict).toBe('complete_not_prefixed');
      expect(d.discardedComplete).toEqual([1]);
      // The foreign payload claims no owner — the F2/X1 guard is working, so the
      // loss is fail-closed by design rather than a missing repair.
      expect(d.claims).toEqual([{ k: 1, owners: [] }]);
    });

    it('a complete unnamed candidate that DOES open with the head is attributable (claims it)', () => {
      const acc = {
        0: slot('goal_update', HEAD, 'call_A'),
        1: { id: 'call_B', name: '', args: FULL, gwId: 'call_B' },
      };
      const d = diagnoseToolCallFinalize(acc, null);
      expect(d.verdict).toBe('complete_not_prefixed');
      expect(d.claims).toEqual([{ k: 1, owners: [0] }]);
    });

    it('TWO complete unnamed candidates → ambiguous_complete (declined by design)', () => {
      const acc = {
        0: slot('goal_update', HEAD, 'call_A'),
        1: { id: 'call_B', name: '', args: FULL, gwId: 'call_B' },
        2: { id: 'call_C', name: '', args: FULL, gwId: 'call_C' },
      };
      const d = diagnoseToolCallFinalize(acc, null);
      expect(d.verdict).toBe('ambiguous_complete');
      expect(d.discardedComplete).toEqual([1, 2]);
    });
  });

  describe('stays silent on healthy turns', () => {
    it('a parsing call yields verdict ok and no broken rows', () => {
      const acc = { 0: slot('goal_update', FULL, 'call_A') };
      const d = diagnoseToolCallFinalize(acc, 'tool_calls');
      expect(d.verdict).toBe('ok');
      expect(d.broken).toEqual([]);
      expect(d.discardedComplete).toEqual([]);
    });

    it('an empty table yields verdict ok', () => {
      const d = diagnoseToolCallFinalize({}, null);
      expect(d.verdict).toBe('ok');
      expect(d.slots).toBe(0);
    });

    it('a complete call PLUS a harmless unnamed tail is not reported as broken', () => {
      const acc = {
        0: slot('goal_update', FULL, 'call_A'),
        1: { id: 'call_A_2', name: '', args: 'junk', gwId: 'call_A' },
      };
      const d = diagnoseToolCallFinalize(acc, null);
      expect(d.verdict).toBe('ok');
      expect(d.unnamed).toBe(1);
    });
  });

  describe('the contract that makes it safe to ship on the hot path', () => {
    it('NEVER mutates the slot table', () => {
      const acc = {
        0: slot('goal_update', HEAD, 'call_A'),
        1: { id: 'call_B', name: '', args: FULL, gwId: 'call_B' },
      };
      const before = JSON.stringify(acc);
      diagnoseToolCallFinalize(acc, 'length');
      expect(JSON.stringify(acc)).toBe(before);
    });

    it('is deterministic — repeated calls agree', () => {
      const acc = { 0: slot('goal_update', HEAD, 'call_A') };
      expect(diagnoseToolCallFinalize(acc, 'length')).toEqual(diagnoseToolCallFinalize(acc, 'length'));
    });
  });
});