/**
 * SAA-1.3 PHASE 1 — the WAKE-BLOCK reserve is scoped to the NOTES trim (todo 2ef2b254).
 *
 * THE DEFECT THIS PINS (found by the bounded apply-mode canary on prod box A,
 * 2026-11-04, then reproduced here). The first Phase-1 cut made the 240-char
 * spill reserve part of the GLOBAL cap:
 *
 *     const cap = () => WAKE_BLOCK_CAP + stamps - spillReserve;   // ← global
 *
 * The pointer block is appended only AFTER every trim, so that shrank the
 * budget for EVERY trim. Measured on real fleet docs:
 *
 *   chat c0e22e36  base 5946B → apply 5853B   (notes cut 240B early)
 *   chat 5c3f302e  base 5955B → apply 5730B   (a DISPATCH row popped, and the
 *                                              notes trim never fired at all ⇒
 *                                              NO pointer: arming cost content
 *                                              and delivered nothing)
 *   chat daee2916  base 5993B → apply 5929B   (the one doc where it behaved)
 *
 * THE INVARIANT, stated so it survives a refactor. The assembler trims in a
 * fixed order (dispatches → old refutations → notes → projects → directives →
 * asks) and appends the pointer last. Therefore arming may change ONE thing:
 * how much of the NOTES tail survives. It must never change any earlier trim
 * decision. Note `5c3f302e` sits in the narrow window that exposes this — a
 * block already under the cap but over cap−240, where observe trims nothing and
 * the old global reserve popped a dispatch instead.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { supervisorState: { findUnique: jest.fn(), upsert: jest.fn() }, crossModelChat: { findUnique: jest.fn() } },
}));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { formatStateForWake, WAKE_BLOCK_CAP, type SupervisorStateDoc } from './supervisor-state.service';

const NOW = new Date('2026-11-04T12:00:00Z');
const HOUR = 3_600_000;
const POINTER = 'get_supervisor_state({section:"notes"})';
const SWITCH = 'INLINE_SPILL_INJECTION_DISABLED';

/** Render with the switch forced to `spell` (undefined = unset), then restore exactly. */
function render(doc: SupervisorStateDoc, spell: string | undefined): string {
  const prev = process.env[SWITCH];
  try {
    if (spell === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = spell;
    return formatStateForWake(doc, NOW);
  } finally {
    if (prev === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = prev;
  }
}

const DISPATCHES = Array.from({ length: 6 }, (_, i) => ({
  at: `2026-11-0${(i % 4) + 1}T0${i}:00:00.000Z`, kind: 'session', id: `sess-${i}`, note: `dispatched lane ${i}`,
}));

/** Doc with a dispatch ledger and notes of the given length. */
function docWithDispatches(notes: string): SupervisorStateDoc {
  return {
    directives: [], archived: [], refutations: [], inflightPreemptAt: '', notes,
    dispatches: DISPATCHES as any,
    projects: [{ name: 'Digby', status: 'shipping', at: new Date(NOW.getTime() - HOUR).toISOString() }] as any,
  };
}

/** Which dispatch rows survived (arity + identity, not just a count). */
function survivingDispatches(block: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < DISPATCHES.length; i++) if (block.includes(`dispatched lane ${i}`)) out.push(String(i));
  return out;
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Notes sizes are measured AGAINST THE REAL OVERHEAD, not the raw cap. The
 * assembler's other sections (header, dispatch ledger, project lines) take a few
 * hundred chars, so "notes = WAKE_BLOCK_CAP" is already far over the cap and the
 * dispatch loop legitimately drains the ledger in BOTH modes — which would make
 * an equality assertion pass for the wrong reason. These sizes put the block in
 * the window that matters: comfortably under, inside the reserve band
 * (cap−240, cap), just over, and far over.
 */
function bandSizes(): number[] {
  const overhead = render(docWithDispatches(''), undefined).length;
  return [
    Math.max(50, WAKE_BLOCK_CAP - overhead - 900), // comfortably under: no trim, no pointer
    WAKE_BLOCK_CAP - overhead - 100,               // INSIDE the band: observe clean, armed trims notes
    WAKE_BLOCK_CAP - overhead + 200,               // just over: dispatches may go, notes also cut
    WAKE_BLOCK_CAP,                                // far over
    WAKE_BLOCK_CAP * 2,                            // far, far over
  ];
}

describe('SAA-1.3 Phase 1 — the wake reserve is scoped to the NOTES trim', () => {
  afterEach(() => { delete process.env[SWITCH]; });

  it('observe floor: unset, \'0\' and \'1\' render the block BYTE-IDENTICALLY', () => {
    for (const size of bandSizes()) {
      const doc = docWithDispatches(`NOTES_HEAD ${'n'.repeat(size)}`);
      const base = render(doc, undefined);
      expect(render(doc, '0')).toBe(base);
      expect(render(doc, '1')).toBe(base);
    }
  });

  it('ARMING NEVER CHANGES A NON-NOTES TRIM: the surviving dispatch rows are identical', () => {
    for (const size of bandSizes()) {
      const doc = docWithDispatches(`NOTES_HEAD ${'n'.repeat(size)}`);
      const base = render(doc, undefined);
      const armed = render(doc, 'apply');
      // THE REGRESSION: the global reserve popped a dispatch row here (chat 5c3f302e).
      expect({ size, kept: survivingDispatches(armed) }).toEqual({ size, kept: survivingDispatches(base) });
    }
  });

  it('the reserve band (block already under the cap but over cap−240) keeps every dispatch and still points', () => {
    // Sized by the REAL overhead so the block truly lands in the band: nothing is
    // trimmed in observe, so arming must not start dropping dispatches — and
    // because the notes are now over cap−240 the pointer MUST appear (that is the
    // whole point of the reserve, and the case chat 5c3f302e exposed).
    const overhead = render(docWithDispatches(''), undefined).length;
    const doc = docWithDispatches(`NOTES_HEAD ${'n'.repeat(WAKE_BLOCK_CAP - overhead - 100)}`);
    const base = render(doc, undefined);
    const armed = render(doc, 'apply');
    expect(survivingDispatches(base)).toHaveLength(DISPATCHES.length); // observe: nothing popped
    expect(survivingDispatches(armed)).toEqual(survivingDispatches(base)); // armed: still nothing popped
    expect(base).not.toContain(POINTER);   // band is under the cap ⇒ observe is clean
    expect(armed).toContain(POINTER);      // armed trades notes tail for the pointer
    expect(armed.length).toBeLessThanOrEqual(WAKE_BLOCK_CAP);
  });

  it('armed either appends the notes pointer or changes nothing at all — never a silent loss', () => {
    for (const size of bandSizes()) {
      const doc = docWithDispatches(`NOTES_HEAD ${'x'.repeat(size)}`);
      const base = render(doc, undefined);
      const armed = render(doc, 'apply');
      if (armed.includes(POINTER)) {
        expect(armed).not.toBe(base);                              // it did something…
        expect(armed.length).toBeLessThanOrEqual(WAKE_BLOCK_CAP);   // …within the cap
      } else {
        expect(armed).toBe(base);                                  // nothing to point at ⇒ identical
      }
    }
  });

  it('the armed divergence is CONFINED to the late notes tail', () => {
    const doc = docWithDispatches(`NOTES_HEAD ${'n'.repeat(WAKE_BLOCK_CAP - 240)}`);
    const base = render(doc, undefined);
    const armed = render(doc, 'apply');
    expect(armed).toContain(POINTER);
    const cp = commonPrefix(base, armed);
    expect(cp).toBeGreaterThanOrEqual(Math.floor(Math.min(base.length, armed.length) * 0.7));
    // Everything before the notes body is byte-identical (header, projects, dispatches).
    expect(armed.slice(0, cp)).toBe(base.slice(0, cp));
  });

  it('a doc whose notes are NOT trimmed injects no pointer and stays byte-identical', () => {
    const doc = docWithDispatches('short notes');
    const base = render(doc, undefined);
    expect(render(doc, 'apply')).toBe(base);
    expect(base).not.toContain(POINTER);
  });

  // ── THE DIRECTIVE-OVERFLOW CLASS (independent review 2026-11-04) ──────────
  // The cases above vary only NOTES length, so `notesCap()` alone governs them and
  // they could never reach this defect. When the over-cap excess comes from a
  // DIRECTIVE — which the notes trim cannot recover — the last-resort loops trim
  // to `cap()`, notes can be emptied outright, and the ~179-char append then lands
  // OVER the cap. Measured before the fix: 32 of 1124 synthetic shapes went
  // observe-compliant -> armed-over, deleting the whole NOTES section in 24 of
  // them (directive 5150..5225 at any notes length: observe 5993 -> armed 6016+).
  // These two cases are RED without the append postcondition.
  it('a DIRECTIVE-overflow doc never goes over the cap when armed (and never loses the NOTES section)', () => {
    // The measured band, plus the realistic fleet shape the review used.
    const shapes: Array<{ label: string; doc: () => SupervisorStateDoc }> = [
      { label: 'directive 5150 / notes 900', doc: () => ({ ...docWithDispatches(`NOTES_HEAD ${'n'.repeat(900)}`), directives: [{ id: 'd0', status: 'open', text: 'D0 ' + 'x'.repeat(5150) }] as any }) },
      { label: 'directive 5200 / notes 9000', doc: () => ({ ...docWithDispatches(`NOTES_HEAD ${'n'.repeat(9000)}`), directives: [{ id: 'd0', status: 'open', text: 'D0 ' + 'x'.repeat(5200) }] as any }) },
      { label: '60x250 directives / notes 1200', doc: () => ({ ...docWithDispatches(`NOTES_HEAD ${'n'.repeat(1200)}`), directives: Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, status: 'open', text: `D${i} ` + 'x'.repeat(250) })) as any }) },
    ];
    for (const { label, doc } of shapes) {
      const base = render(doc(), undefined);
      const armed = render(doc(), 'apply');
      expect({ label, over: armed.length > WAKE_BLOCK_CAP }).toEqual({ label, over: false });
      // Arming must not silently delete the section it exists to make followable.
      if (base.includes('NOTES')) expect({ label, keptNotes: armed.includes('NOTES') }).toEqual({ label, keptNotes: true });
    }
  });

  it('arming either points or changes NOTHING — never costs content for a cap violation', () => {
    let injected = 0;
    for (let d = 5000; d <= 5400; d += 25) {
      for (const nlen of [900, 3000, 9000]) {
        const doc = { ...docWithDispatches(`NOTES_HEAD ${'n'.repeat(nlen)}`), directives: [{ id: 'd0', status: 'open', text: 'D0 ' + 'x'.repeat(d) }] as any };
        const base = render(doc, undefined);
        const armed = render(doc, 'apply');
        // The postcondition: never over the cap, whatever else happens.
        expect(armed.length).toBeLessThanOrEqual(WAKE_BLOCK_CAP);
        if (armed !== base) injected++;
        // If it changed, the change must be the pointer — and it must fit.
        if (armed !== base) expect(armed).toContain(POINTER);
        // When observe was already compliant and arming declines to point, the
        // block must be the OBSERVE block exactly (the fallback restores notes).
        if (base.length <= WAKE_BLOCK_CAP && !armed.includes(POINTER)) expect(armed).toBe(base);
      }
    }
    // The band must exercise the armed path at least somewhere, or the sweep is vacuous.
    expect(injected).toBeGreaterThan(0);
  });
});