/**
 * REPLAY — emission-side remedy for the truncated tool-call argument class
 * (goal 4860aa67 / todo 98dd4b50, 2026-10-30).
 *
 * THE MEASURED SHAPE THIS PINS (live rows, serving build b772c31f67, 8 h):
 *
 *   goal_update  argLen=39  at 14:15:13.833Z / 14:15:51.038Z / 14:16:18.160Z
 *                           / 15:15:01.385Z   (recv=39 acc=39 drop=0 buf=0 sc=1)
 *   goal_update  argLen=67  at 15:34:42Z / 15:34:52Z / 15:35:12Z (re:1 sc:1)
 *   todo_update  argLen=41  at 12:12:49.609Z  (recv=41 acc=41 drop=0 sc=1)
 *
 * Two facts follow from the geometry and they are why the fix is a RESHAPE and
 * not a repair:
 *
 *   1. The shortest valid goal_update is 49 bytes —
 *      `{"goalId":"<36-char uuid>"}` — with the uuid starting at byte 11. A cut
 *      at 39 therefore leaves 28 of 36 uuid characters, i.e. the payload dies
 *      INSIDE the id string. A cut at 67 lands exactly at that string's closing
 *      quote (the id is intact; the text after it never arrived).
 *
 *   2. A cut at 39 CAN be made to parse by appending `"}` — and that must never
 *      be adopted. The recovered object names a 28-char id the model never
 *      finished emitting; if it happened to resolve, we would mutate a real row
 *      on a guess. `parseToolArguments`' own contract is "Never returns args the
 *      model did not send", and this file asserts that the closing-the-structure
 *      lane stays rejected.
 *
 * THE REMEDY. The id is the largest OPAQUE byte run in the payload and the only
 * part that can be shortened with ZERO information loss, because the write path
 * already accepts a unique 8-char prefix: `updateGoal` → `canonicalGoalId` →
 * `resolveUniqueGoalPrefix`, gated on `8 <= len < 36`, exactly one
 * caller-visible candidate, falling through unchanged on ambiguity
 * (goals.service.ts; pinned by goals.service.test.ts 'goal_update resolves a
 * unique 8-char prefix'). Emitting 8 chars instead of 36 removes 28 bytes and
 * moves the text the stream keeps severing out of the cut — a change of SHAPE,
 * which is the lever field-validated to work, versus shrinking the informative
 * values, which is not.
 *
 * The hint is ADVISORY ONLY: observed cut points span 10 → 3,983 chars, so
 * nothing here promises a re-send lands, and a tool with no prefix-resolved id
 * gets no hint at all.
 */

import {
  parseToolArguments,
  toolArgumentRejection,
  truncatedIdReshapeHint,
  PREFIX_RESOLVED_ID_TOOLS,
} from './tool-arguments';

/** A real goal id shape (36-char uuid v4-style). */
const GOAL_UUID = '5c3f302e-1111-4222-8333-444455556666';

/** Cut `full` at `n` bytes, exactly as a severing transport hands it to us. */
const cutAt = (full: string, n: number): string => full.slice(0, n);

describe('emission reshape — the real cut geometry (measured 2026-10-30)', () => {
  it('the shortest valid goal_update is 49 bytes and the uuid starts at byte 11', () => {
    const full = JSON.stringify({ goalId: GOAL_UUID });
    expect(full.length).toBe(49);
    // The 39-byte cuts sit INSIDE the uuid, not at the tail.
    const cut = cutAt(full, 39);
    expect(cut.length).toBe(39);
    expect(cut.endsWith('"')).toBe(false); // string literal still open
    expect(cut.slice(11)).toBe(GOAL_UUID.slice(0, 28)); // 28 of 36 uuid chars
  });

  it('a cut at 39 is classified truncated (bytes missing), never malformed', () => {
    const full = JSON.stringify({ goalId: GOAL_UUID });
    const parsed = parseToolArguments(cutAt(full, 39));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('truncated');
    expect(parsed.argLen).toBe(39);
    // The CLASS is what matters; the parser's own wording varies by cut
    // position and V8 version (tool-arguments.ts documents this): a cut inside a
    // string literal says "Unterminated string in JSON at position 39", while
    // the live rows cut at a brace boundary and said "Unexpected end of JSON
    // input". Asserting one exact string would pin the engine, not the defect.
    expect(parsed.reason).toMatch(/Unterminated string|Unexpected end of JSON input/);
  });

  it('a cut at 67 leaves the id INTACT and severs only what followed it', () => {
    // The 67-byte rows land at the id's closing quote: 11 + 36 + 2 = 49 … then
    // `,"progressNote":"` runs to 67 with the VALUE absent.
    const full = JSON.stringify({ goalId: GOAL_UUID, progressNote: 'a note' });
    const cut = cutAt(full, 67);
    expect(cut.slice(11, 47)).toBe(GOAL_UUID); // the whole uuid survived
    const parsed = parseToolArguments(cut);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('truncated');
  });
});

describe('emission reshape — closing the structure is REFUSED, not adopted', () => {
  it('a 39-byte cut plus `"} parses, which is exactly why we must not do it', () => {
    const full = JSON.stringify({ goalId: GOAL_UUID });
    const salvaged = cutAt(full, 39) + '"}';
    // It parses (this is the trap)…
    const obj = JSON.parse(salvaged);
    expect(typeof obj.goalId).toBe('string');
    // …and it names a 28-char id the model NEVER finished emitting.
    expect(obj.goalId.length).toBe(28);
    expect(obj.goalId).not.toBe(GOAL_UUID);
    // The real parser still rejects the severed payload: nothing salvaged runs.
    expect(parseToolArguments(cutAt(full, 39)).ok).toBe(false);
  });

  it('a cut id is never silently completed into a full-length id', () => {
    const full = JSON.stringify({ goalId: GOAL_UUID, status: 'done' });
    const parsed = parseToolArguments(cutAt(full, 39));
    expect(parsed.ok).toBe(false);
    // Nothing the model did not send may reach a handler.
    expect(JSON.stringify(parsed)).not.toContain(GOAL_UUID);
  });
});

describe('emission reshape — the hint names the one information-preserving edit', () => {
  it('goal_update gets the prefix-id reshape hint on a TRUNCATED payload', () => {
    const full = JSON.stringify({ goalId: GOAL_UUID });
    const parsed = parseToolArguments(cutAt(full, 39));
    if (parsed.ok) throw new Error('expected a rejection');
    const text = toolArgumentRejection('goal_update', parsed);
    expect(text).toContain('TRUNCATED IN TRANSIT');
    expect(text).toContain('unique 8-char PREFIX');
    // It must say WHY this is a reshape and not the shrink advice it warns against.
    expect(text).toMatch(/without losing information/i);
    // The standing warning against shrinking VALUES must survive the injection.
    expect(text).toMatch(/shrinking your values only loses information/i);
    // And it must not claim a re-send is guaranteed to land.
    expect(text).not.toMatch(/will (succeed|land)/i);
  });

  it('todo_update gets the same hint — the recurrence shape is covered by one remedy', () => {
    // The 41-byte todo_update cut (12:12:49.609Z) is the sibling signature.
    const parsed = parseToolArguments(JSON.stringify({ todoId: GOAL_UUID }).slice(0, 41));
    if (parsed.ok) throw new Error('expected a rejection');
    expect(parsed.shape).toBe('truncated');
    expect(toolArgumentRejection('todo_update', parsed)).toContain('unique 8-char PREFIX');
  });

  it('a tool with no prefix-resolved id gets NO hint (no invented advice)', () => {
    const parsed = parseToolArguments('{"chatId":"5c3f302e","text":"cut');
    if (parsed.ok) throw new Error('expected a rejection');
    const text = toolArgumentRejection('send_chat_message', parsed);
    expect(text).toContain('TRUNCATED IN TRANSIT');
    expect(text).not.toContain('8-char PREFIX');
    expect(truncatedIdReshapeHint('send_chat_message')).toBe('');
  });

  it('MALFORMED and NOT-OBJECT never carry the reshape hint', () => {
    // Every byte arrived for these, so a transport reshape is the wrong advice.
    for (const [payload, tool] of [['{"goalId": "a",}', 'goal_update'], ['[1,2]', 'goal_update']] as const) {
      const parsed = parseToolArguments(payload);
      if (parsed.ok) throw new Error('expected a rejection');
      expect(parsed.shape === 'malformed' || parsed.shape === 'not-object').toBe(true);
      expect(toolArgumentRejection(tool, parsed)).not.toContain('8-char PREFIX');
    }
  });
});

describe('emission reshape — the set is the resolver-backed tools only', () => {
  it('contains exactly the tools whose id the server resolves from a prefix', () => {
    expect([...PREFIX_RESOLVED_ID_TOOLS].sort()).toEqual(['goal_get', 'goal_update', 'todo_get', 'todo_update']);
  });

  it('a prefix id is genuinely shorter — the byte arithmetic the remedy rests on', () => {
    const full = JSON.stringify({ goalId: GOAL_UUID });
    const prefixed = JSON.stringify({ goalId: GOAL_UUID.slice(0, 8) });
    expect(full.length - prefixed.length).toBe(28);
    expect(prefixed.length).toBe(21);
  });
});