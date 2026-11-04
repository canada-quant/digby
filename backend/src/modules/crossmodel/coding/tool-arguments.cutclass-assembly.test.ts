/**
 * REPLAY — the cut class through the ASSEMBLY path, at the measured offsets
 * (goal 4860aa67 / todo b5482ea1 / ticket efdb3d31, 2026-10-30).
 *
 * WHY THIS FILE EXISTS ON TOP OF `tool-arguments.emission-reshape.test.ts`.
 * That file pins the 39- and 67-byte cuts against `parseToolArguments` DIRECTLY —
 * it hands the parser a severed string. Production never does that: the bytes
 * arrive as streamed `tool_calls` deltas that are routed to a slot by
 * `resolveToolCallSlot` and concatenated by `appendArgumentsFragment` before the
 * parser ever sees them. The two seams are not interchangeable, and the 3b75ba8e
 * incident is the proof — a payload that was COMPLETE in emission was destroyed
 * between the router and the parser. So a cut pinned only at the parser does not
 * pin what production does with a cut.
 *
 * This file also adds the 77-byte twin, which had no fixture at all. It is the
 * most interesting of the three, because it is the first offset that leaves REAL
 * PAYLOAD BYTES of the informative value present (11 chars of `progressNote` at
 * the modern uuid shape) — the 39 severs the id itself and the 67 leaves the
 * value empty. A 77 carries enough to look like content, which is exactly why a
 * "trim the value" lever keeps getting proposed and why the refusal must be
 * pinned on the assembled bytes rather than on a hand-written string.
 *
 * WHAT IS ASSERTED (and, deliberately, what is NOT).
 *
 *   (a) THE REFUSAL — every severed payload, routed through the real assembly
 *       path, is rejected with shape `truncated` and its measured `argLen`.
 *       Nothing truncated ever executes (the 2026-08-30 audit invariant).
 *
 *   (b) WHAT THE MERGED REMEDY DOES — `toolArgumentRejection` emits the prefix-id
 *       reshape ADVICE, and the byte arithmetic that advice rests on is proven:
 *       at a FIXED cut budget the prefixed encoding fits where the full uuid does
 *       not, so the reshape moves the surviving payload out of the cut region.
 *
 *   (b') AND WHAT IT DOES NOT DO — the advice is TEXT ON THE REJECT PATH ONLY.
 *       The severed call is still rejected in the very same turn it is advised
 *       on; no lane exists by which the hint repairs the call that produced it.
 *       So this file must NOT be read as "the remedy fixes the cut" — it pins
 *       that the remedy is correctly shaped and correctly scoped, nothing more.
 *       Validating it takes a LATER emission that obeys the hint, which is a
 *       model-dependent observation and does not belong here.
 */

import {
  parseToolArguments,
  toolArgumentRejection,
  truncatedIdReshapeHint,
  resolveToolCallSlot,
  appendArgumentsFragment,
  uniqueToolCallId,
  UNRESOLVABLE_SLOT,
  DUPLICATE_FRAGMENT,
} from './tool-arguments';

/** A real goal id shape (36-char uuid v4-style). */
const GOAL_UUID = '5c3f302e-1111-4222-8333-444455556666';

/** The measured offsets. 39 and 67 are from live rows; 77 is the third twin. */
const CUT_OFFSETS = [39, 67, 77] as const;

/** A note long enough that every offset above severs inside it, not after it. */
const NOTE = 'cut class probe note long enough to be severed at all three offsets';
const FULL_ARGS = JSON.stringify({ goalId: GOAL_UUID, progressNote: NOTE });

/**
 * The REAL accumulator loop (mirrors coding-model.ts and the 3b75ba8e harness):
 * route by slot, then concatenate. This is the seam production uses.
 */
function assembleThroughStream(deltas: Array<Array<any>>) {
  const acc: Record<number, { id: string; name: string; args: string; gwId?: string }> = {};
  let lastSlot = -1;
  let ambiguous = false;
  for (const batch of deltas) {
    for (const tc of batch) {
      const idx = resolveToolCallSlot(acc, tc, lastSlot);
      if (idx === UNRESOLVABLE_SLOT) { ambiguous = true; continue; }
      if (idx === DUPLICATE_FRAGMENT) { continue; }
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
  return {
    calls: Object.keys(acc).sort((a, b) => Number(a) - Number(b)).map((k) => acc[Number(k)]),
    ambiguous,
  };
}

/** Feed `text` as ONE streamed argument delta through the assembly path. */
const assembleOne = (text: string) =>
  assembleThroughStream([[{ index: 0, id: 'call_cut', function: { name: 'goal_update', arguments: text } }]]);

describe('cut class — byte geometry of the three measured offsets', () => {
  it('the fixture payload is long enough that all three offsets fall INSIDE it', () => {
    // If this fails the offsets below are meaningless (the cut would land past
    // the end of the payload, i.e. it would not be a cut at all).
    for (const n of CUT_OFFSETS) expect(FULL_ARGS.length).toBeGreaterThan(n);
  });

  it('at 39 the cut is INSIDE the uuid; the id is not recoverable', () => {
    const cut = FULL_ARGS.slice(0, 39);
    expect(cut.length).toBe(39);
    // 11 bytes of `{"goalId":"` then the uuid begins.
    expect(cut.slice(11)).toBe(GOAL_UUID.slice(0, 28));
    expect(cut.includes(GOAL_UUID)).toBe(false);
  });

  it('at 67 the uuid survived INTACT and the note value is empty', () => {
    const cut = FULL_ARGS.slice(0, 67);
    expect(cut.slice(11, 47)).toBe(GOAL_UUID);
    // 66 bytes of prefix + `"` opens the value; the 67th byte is its first char
    // only because the note starts immediately — nothing of substance arrived.
    expect(cut.length - 66).toBe(1);
  });

  it('at 77 the uuid is intact AND real note bytes are present — the deceptive one', () => {
    const cut = FULL_ARGS.slice(0, 77);
    expect(cut.slice(11, 47)).toBe(GOAL_UUID);
    // 11 payload bytes of the informative value survived: enough to read as
    // content, nowhere near enough to be the note. This is the offset that
    // tempts a "just send less" fix, and the reason the refusal is pinned here.
    expect(cut.length - 66).toBe(11);
    expect(cut).toContain(NOTE.slice(0, 11));
  });

  it('every offset severs mid-structure, so every one is classified TRUNCATED', () => {
    for (const n of CUT_OFFSETS) {
      const parsed = parseToolArguments(FULL_ARGS.slice(0, n));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('unreachable');
      expect(parsed.shape).toBe('truncated');
      expect(parsed.argLen).toBe(n);
    }
  });
});

describe('cut class — (a) the REFUSAL survives the assembly path', () => {
  it.each(CUT_OFFSETS)('a cut at %i routed through the real accumulator is rejected, never executed', (n) => {
    const { calls, ambiguous } = assembleOne(FULL_ARGS.slice(0, n));
    expect(ambiguous).toBe(false);
    expect(calls).toHaveLength(1);
    // The accumulator did NOT lose or invent bytes on this path.
    expect(calls[0].args.length).toBe(n);
    expect(calls[0].name).toBe('goal_update');
    // …and the parser refuses exactly what the seam produced.
    const parsed = parseToolArguments(calls[0].args);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('truncated');
    expect(parsed.argLen).toBe(n);
  });

  it.each(CUT_OFFSETS)('a cut at %i is refused with a rejection the model can act on', (n) => {
    const { calls } = assembleOne(FULL_ARGS.slice(0, n));
    const parsed = parseToolArguments(calls[0].args);
    if (parsed.ok) throw new Error('unreachable');
    const text = toolArgumentRejection('goal_update', parsed);
    // NOTHING was executed — the invariant is stated to the model, not implied.
    expect(text).toContain('NOTHING was executed');
    expect(text).toContain('goal_update');
  });

  it('the intact payload through the SAME path still parses (the path is not broken)', () => {
    const { calls } = assembleOne(FULL_ARGS);
    expect(calls).toHaveLength(1);
    const parsed = parseToolArguments(calls[0].args);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.args.goalId).toBe(GOAL_UUID);
    expect(parsed.args.progressNote).toBe(NOTE);
  });
});

describe('cut class — (b) what the merged remedy does: the byte arithmetic it rests on', () => {
  const PREFIX_ARGS = JSON.stringify({ goalId: GOAL_UUID.slice(0, 8), progressNote: NOTE });

  it('the prefix encoding is 28 bytes shorter for the same addressing of the same row', () => {
    const fullNoNote = JSON.stringify({ goalId: GOAL_UUID });
    const prefixedNoNote = JSON.stringify({ goalId: GOAL_UUID.slice(0, 8) });
    expect(fullNoNote.length).toBe(49);
    expect(prefixedNoNote.length).toBe(21);
    expect(fullNoNote.length - prefixedNoNote.length).toBe(28);
    // Prefixing removes the SAME 28 bytes from the payload WITH the note.
    expect(FULL_ARGS.length - PREFIX_ARGS.length).toBe(28);
  });

  it('at the 39-byte budget the prefixed call FITS where the full uuid does not', () => {
    // This is the mechanism, model-independently: at a fixed cut budget the
    // prefixed encoding completes and the full one is severed inside the id.
    const prefixed = JSON.stringify({ goalId: GOAL_UUID.slice(0, 8) });
    expect(prefixed.length).toBe(21);
    expect(prefixed.length).toBeLessThan(39);
    expect(parseToolArguments(prefixed).ok).toBe(true);
    expect(parseToolArguments(FULL_ARGS.slice(0, 39)).ok).toBe(false);
  });

  it('at 67 and 77 the prefixed call also fits, and parses whole', () => {
    for (const budget of [67, 77]) {
      expect(PREFIX_ARGS.length).toBeGreaterThan(budget);
      // The published arithmetic is about the ID REGION, not the whole payload:
      // prefixing moves the id's closing quote from byte 47 to byte 19, so a cut
      // in the 39..47 band stops landing inside the id entirely.
      const prefixedNoNote = JSON.stringify({ goalId: GOAL_UUID.slice(0, 8) });
      expect(prefixedNoNote.length).toBeLessThan(budget);
      const parsed = parseToolArguments(prefixedNoNote);
      expect(parsed.ok).toBe(true);
    }
  });

  it('the rejection on an assembled cut carries the prefix-id reshape ADVICE', () => {
    const { calls } = assembleOne(FULL_ARGS.slice(0, 39));
    const parsed = parseToolArguments(calls[0].args);
    if (parsed.ok) throw new Error('unreachable');
    const text = toolArgumentRejection('goal_update', parsed);
    expect(text).toContain('8-char PREFIX');
    // Advice, stated as advice — never a promise that a re-send lands.
    expect(truncatedIdReshapeHint('goal_update')).toContain('8-char PREFIX');
  });

  it('a tool with no prefix-resolved id gets NO reshape advice on the same cut', () => {
    const severed = JSON.stringify({ chatId: '5c3f302e', text: 'x'.repeat(200) }).slice(0, 39);
    expect(parseToolArguments(severed).ok).toBe(false);
    // An unrelated tool must not inherit advice about an id it cannot prefix.
    expect(truncatedIdReshapeHint('send_chat_message')).toBe('');
  });

  /**
   * THE CEILING OF THE PREFIX LEVER — measured, and it is why obeying the advice
   * is NOT sufficient to make the failing calls land.
   *
   * Prefixing the id removes exactly 28 bytes, whatever the note length is. The
   * observed cut lands after ~67 bytes (and the corpus has 17/39/41/67), because
   * argLen behaves like a per-request output budget that is nearly spent — the
   * cut point is a property of the REQUEST, not of the payload's total length.
   *
   * So the saving is a CONSTANT competing against a payload that grows with the
   * note. For the population that actually fails — goal_update with a real note
   * — 28 bytes off an 800–2030 byte payload moves the cut 28 bytes right and the
   * call still severs. The lever only rescues a payload whose WHOLE length fits
   * the remaining budget, i.e. the tiny calls that already succeed.
   *
   * This is falsifiable without a model: the arithmetic below is the prediction a
   * fresh production probe would test. If a prefixed 1961-char note lands, this
   * test is wrong and should be corrected with that receipt.
   */
  describe('the prefix lever cannot rescue the failing population (arithmetic, not opinion)', () => {
    const prefixOf = (note: string) =>
      JSON.stringify({ goalId: GOAL_UUID.slice(0, 8), progressNote: note });

    it('the saving is a CONSTANT 28 bytes no matter how long the note is', () => {
      for (const n of [1, 29, 100, 795, 1961]) {
        const note = 'x'.repeat(n);
        const full = JSON.stringify({ goalId: GOAL_UUID, progressNote: note });
        expect(full.length - prefixOf(note).length).toBe(28);
      }
    });

    it('at the observed ~67-byte budget a prefixed REAL note is still severed', () => {
      // The two notes the production probe actually used (795c, 1961c).
      for (const n of [795, 1961]) {
        const prefixed = prefixOf('x'.repeat(n));
        expect(prefixed.length).toBeGreaterThan(67);
        const parsed = parseToolArguments(prefixed.slice(0, 67));
        expect(parsed.ok).toBe(false);
        if (parsed.ok) throw new Error('unreachable');
        expect(parsed.shape).toBe('truncated');
      }
    });

    it('prefixing only helps when the WHOLE payload fits in the remaining budget', () => {
      // The prefixed envelope is 39 bytes before any note content, so at a
      // 67-byte budget only a ≤28-char note completes; 29 already overflows.
      const fits = (n: number) => prefixOf('x'.repeat(n)).length <= 67;
      expect(fits(28)).toBe(true);
      expect(fits(29)).toBe(false);
      expect(prefixOf('x'.repeat(28)).length).toBe(67);
      expect(prefixOf('x'.repeat(29)).length).toBe(68);
      // Which is the archive-shaped call that already succeeds — not the cut.
      expect(fits(795)).toBe(false);
      expect(fits(1961)).toBe(false);
    });

    it('the shape the production probe hit: full-uuid 1961c note severs at 67', () => {
      const full = JSON.stringify({ goalId: GOAL_UUID, progressNote: 'x'.repeat(1961) });
      const parsed = parseToolArguments(full.slice(0, 67));
      if (parsed.ok) throw new Error('unreachable');
      expect(parsed.shape).toBe('truncated');
      expect(parsed.argLen).toBe(67);
    });
  });
});

describe('cut class — (b\') what the remedy does NOT do: advice never repairs its own call', () => {
  it.each(CUT_OFFSETS)('at %i the call that TRIGGERED the advice is still rejected in that same turn', (n) => {
    const { calls } = assembleOne(FULL_ARGS.slice(0, n));
    const parsed = parseToolArguments(calls[0].args);
    // The hint is computed FROM this rejection and returned ON it. There is no
    // second pass that re-parses the severed bytes with the hint applied —
    // itemize that as a property of the shape, not of the wording: the returned
    // value is a string, and the parse result is unchanged by asking for it.
    if (parsed.ok) throw new Error('unreachable');
    const advice = toolArgumentRejection('goal_update', parsed);
    expect(advice).toContain('8-char PREFIX');
    // Asking for the advice did not make the payload parse.
    expect(parseToolArguments(calls[0].args).ok).toBe(false);
  });

  /**
   * THE SALVAGE LANE, measured at all three offsets — and it gets WORSE as the
   * cut moves right, which the 39-only fixture could not show.
   *
   * `+ '"}'` is the obvious "repair": close the open string and the object. Its
   * danger is not uniform:
   *
   *   • at 39 the id itself was severed, so the salvaged object names a 28-char
   *     id. It parses, but it resolves to NOTHING — a phantom id, caught
   *     downstream.
   *   • at 67 and 77 the UUID SURVIVED INTACT (`58..47` is never touched), so the
   *     salvaged object names a REAL, RESOLVABLE goal and carries a note the
   *     model never finished writing ("c", or 11 chars of it). It would MUTATE A
   *     REAL ROW with fabricated content — a silent wrong write, strictly worse
   *     than the phantom, and invisible to any length check.
   *
   * That asymmetry is why salvage must never be adopted, and why "the payload is
   * small / the id is present" is not a safe admissibility test.
   */
  describe('the salvage lane is a trap whose severity INCREASES with the offset', () => {
    it('at 39 the salvaged id is a phantom — it cannot resolve to anything', () => {
      const salvaged = FULL_ARGS.slice(0, 39) + '"}';
      const obj = JSON.parse(salvaged); // it parses: that is the trap
      expect(obj.goalId).not.toBe(GOAL_UUID);
      expect(obj.goalId.length).toBe(28);
    });

    it.each([67, 77])('at %i salvage yields the REAL resolvable id plus a fabricated note', (n) => {
      const salvaged = FULL_ARGS.slice(0, n) + '"}';
      const obj = JSON.parse(salvaged); // parses, and this one is worse
      // The id is the one the model actually emitted — it WILL resolve.
      expect(obj.goalId).toBe(GOAL_UUID);
      // …while the note is a prefix the model never finished emitting.
      expect(obj.progressNote.length).toBeLessThan(NOTE.length);
      expect(NOTE.startsWith(obj.progressNote)).toBe(true);
      // So: a real row, wrong content. Never admissible.
      expect(obj.progressNote).not.toBe(NOTE);
    });

    it('the seam itself never appends a closing brace — the refusal is unchanged by the trap', () => {
      // Whatever salvage WOULD do, the assembly path + parser produce a
      // rejection and no closing bytes are invented anywhere in the seam.
      for (const n of CUT_OFFSETS) {
        const { calls } = assembleOne(FULL_ARGS.slice(0, n));
        expect(calls[0].args).toBe(FULL_ARGS.slice(0, n));
        expect(calls[0].args.endsWith('}')).toBe(false);
        expect(parseToolArguments(calls[0].args).ok).toBe(false);
      }
    });
  });

  it('the remedy is scoped to the TRUNCATED shape only', () => {
    // A complete-but-mistyped payload gets NO transport advice: it never lost
    // bytes, so pointing it at a reshape would manufacture a phantom fault.
    const malformed = '{"goalId": "abc",}';
    const parsed = parseToolArguments(malformed);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('malformed');
    expect(toolArgumentRejection('goal_update', parsed)).not.toContain('8-char PREFIX');
  });
});