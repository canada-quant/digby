/**
 * REPLAY PIN — ticket 300802aa-6133-4b27-b124-b35f616753e3 (mishap, agent-filed
 * by the action-verifier; av-mishap family, 5 occurrences, 1 reopen).
 *
 * THE DEFECT THIS PINS (measured 2026-11-02 from the ticket row itself, not
 * inferred): the ticket's `context` read `occurrences: 5` and
 * `lastSeen: 2026-11-02T03:32:28.580Z`, while its DESCRIPTION still ended at
 * "--- sighting 4 ---". Sighting 5 — filed that morning with THIRTEEN phantom
 * claims, and the very sighting the dispatcher routed to this lane — had its
 * evidence silently thrown away.
 *
 * The cause is the shape every bump path shared:
 *
 *     description: appended.length <= DESCRIPTION_MAX ? appended : <the OLD description>
 *
 * Once a long-lived auto-filed row crosses the 8000-char cap, EVERY later
 * sighting is discarded: `occurrences` keeps incrementing, `lastSeen` keeps
 * moving, the priority keeps escalating, the dispatcher keeps sending lanes —
 * but the "Phantom claims:" list a lane needs to adjudicate never arrives. Each
 * new lane re-litigates whatever stale sighting still fits in the description,
 * so a recurring class can never actually be closed on current evidence. That
 * is precisely this ticket's history: closed 2026-10-26 as "model behavior,
 * framework correct", reopened, and re-dispatched twice more against the same
 * 10-26 claim text.
 *
 * THE FIX: evict OLDEST evidence to make room, never the block being added. The
 * oldest block is the least actionable (already triaged, often superseded); the
 * newest is the whole reason a sighting exists. When the append fits, output is
 * BYTE-IDENTICAL to the old path, so no downstream consumer or assertion moves.
 */
import { fitBumpedDescription } from './feedback.service';

// feedback.service imports config/database → config/env (process.exit without
// env vars) and the ticket-dispatch boundary — mock both, same as
// feedback.service.test.ts.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userFeatureRequest: {}, user: {} },
}));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'sent', batched: 1 })),
  dispatchTicketToLane: jest.fn(async () => 'sent'),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, message: string, public isOperational = true) {
      super(message);
    }
  },
}));

const withSightings = (n: number, each: number, head = 'Original agent report.'): string => {
  let out = head;
  for (let i = 1; i <= n; i++) {
    out += `\n\n--- sighting ${i} ---\n${`s${i}-`.padEnd(each, 'x')}`;
  }
  return out;
};

const BLOCK = (n: number) => `${n} ---\nThe newest sighting: Phantom claims: [dispatch] "sent it".`;

describe('fitBumpedDescription — newest sighting evidence is never discarded (ticket 300802aa)', () => {
  it('FITS: byte-identical to the pre-fix append (no behaviour change under the cap)', () => {
    const existing = withSightings(2, 40);
    const expected = `${existing}\n\n--- sighting 3 ---\nThe newest sighting: Phantom claims: [dispatch] "sent it".`;
    expect(fitBumpedDescription(existing, BLOCK(3), 8000)).toBe(expected);
  });

  it('FITS: an empty existing description still produces a well-formed block', () => {
    const out = fitBumpedDescription('', BLOCK(1), 8000);
    expect(out).toBe(`\n\n--- sighting 1 ---\nThe newest sighting: Phantom claims: [dispatch] "sent it".`);
  });

  it('AT THE CAP: evicts OLDEST evidence and always lands the NEWEST block (the 300802aa defect)', () => {
    // 9 prior blocks at ~900 chars ≈ over the cap once a 10th is appended.
    const existing = withSightings(9, 900);
    expect(existing.length).toBeGreaterThan(7000);
    const max = 8000;
    // Pre-fix behaviour, for the record: the append does not fit, so the OLD
    // text is kept and the newest sighting vanishes entirely.
    const preFix = `${existing}\n\n--- sighting 10 ---\nThe newest sighting: Phantom claims: [dispatch] "sent it".`;
    expect(preFix.length).toBeGreaterThan(max);

    const out = fitBumpedDescription(existing, BLOCK(10), max);

    // The invariant that was violated: the NEWEST evidence is present, and it
    // is the sighting we just filed — not a stale one.
    expect(out).toContain('The newest sighting: Phantom claims: [dispatch] "sent it".');
    expect(out).toContain('--- sighting 10 ---');
    // Bounded, and the original report (the ticket's identity) survives.
    expect(out.length).toBeLessThanOrEqual(max);
    expect(out.startsWith('Original agent report.')).toBe(true);
    // Oldest evidence is what got dropped, and it is the EARLIEST one.
    expect(out).not.toContain('s1-');
    expect(out).toContain('s9-');
    // Ordering is preserved — newest still last.
    expect(out.lastIndexOf('--- sighting 10 ---')).toBeGreaterThan(out.lastIndexOf('--- sighting 9 ---'));
  });

  it('AT THE CAP: evicts only as much as it must (keeps every block that still fits)', () => {
    const existing = withSightings(9, 900);
    const out = fitBumpedDescription(existing, BLOCK(10), 8000);
    // Count surviving PRIOR blocks: the fix must not be gratuitously lossy.
    const keptPrior = (out.match(/--- sighting [1-9] ---/g) ?? []).length;
    expect(keptPrior).toBeGreaterThan(0);
    expect(keptPrior).toBeLessThan(9); // it did have to evict *something*
  });

  it('PATHOLOGICAL: a single block larger than the whole cap still lands its head', () => {
    const existing = withSightings(2, 100);
    const huge = `${7} ---\n${'y'.repeat(20000)}`;
    const out = fitBumpedDescription(existing, huge, 8000);
    expect(out.length).toBeLessThanOrEqual(8000);
    // The newest sighting is still represented (its leading "claims:" lines are
    // what a lane reads), and the ticket identity is intact.
    expect(out).toContain('--- sighting 7 ---');
    expect(out.startsWith('Original agent report.')).toBe(true);
    // Review 2026-11-02 defect 3: the cut must be VISIBLE, so a lane is never
    // told a truncated sighting is the whole sighting.
    expect(out).toContain('…[truncated]');
  });

  // ── Defects found by the independent adversarial review (2026-11-02) ──────
  describe('review defects (2026-11-02)', () => {
    it('defect 1: a small overflow must NOT destroy the original report — shrink by the overflow, not by a fraction', () => {
      // The shipped fixture from feedback.service.test.ts: over the cap by 171.
      const head = 'x'.repeat(7950);
      const block = `2 ---\n${'y'.repeat(200)}`;
      expect((head + '\n\n--- sighting ' + block).length).toBe(8171);

      const out = fitBumpedDescription(head, block, 8000);
      // The first cut of this fix returned 4221 chars (4000 of 7950 head kept,
      // ~3950 report chars destroyed, ~3779 budget unused) — the defect.
      expect(out.length).toBeGreaterThan(7900);
      expect(out).toContain('x'.repeat(7700)); // report survives essentially whole
      expect(out).toContain(block); // and the newest sighting lands WHOLE
      expect(8000 - out.length).toBeLessThan(200);
      expect(out.length).toBeLessThanOrEqual(8000);
    });

    it('defect 1: no prior blocks to evict — the report is only trimmed by the exact overflow', () => {
      const head = 'R'.repeat(7950);
      const block = `2 ---\n${'a'.repeat(300)}`; // 321 chars + sep 15 => over by 286
      const out = fitBumpedDescription(head, block, 8000);
      expect(out.length).toBeLessThanOrEqual(8000);
      expect(out.endsWith(block)).toBe(true);
      expect(out.startsWith('R'.repeat(7600))).toBe(true);
    });

    it('defect 2: a QUOTED "--- sighting " in the report is not a block boundary (report tail survives)', () => {
      const report = `${'A'.repeat(2000)}\n\nQuoted verbatim from ticket abcdef12:\n\n--- sighting 9 ---\n\n${'Z'.repeat(2000)}REPORT-END`;
      const block = `3 ---\n${'P'.repeat(1000)}`;
      const out = fitBumpedDescription(report, block, 8000);
      // Pre-fix (separator-blind split) this deleted "REPORT-END" as though the
      // quoted text were real, evictable evidence.
      expect(out).toContain('REPORT-END');
      expect(out).toContain('Quoted verbatim from ticket abcdef12:');
      expect(out).toContain(block);
      expect(out.length).toBeLessThanOrEqual(8000);
    });

    it('defect 2: a real block whose BODY quotes a separator is not torn in half', () => {
      const existing = `Report.\n\n--- sighting 2 ---\nSIGHTING-2-PART-A\n\nQuoted from ticket abcdef12 verbatim:\n\n--- sighting 7 ---\n\nSIGHTING-2-PART-B`;
      const out = fitBumpedDescription(existing, `3 ---\nNEW`, 8000);
      // Not over the cap, so this is the byte-identical fits path — which is
      // exactly what keeps the round-trip safe.
      expect(out).toBe(`${existing}\n\n--- sighting 3 ---\nNEW`);
    });

    it('defect 2: eviction renumbers nothing and keeps block order newest-last', () => {
      const existing = withSightings(9, 900);
      const out = fitBumpedDescription(existing, `${10} ---\nNEWEST`, 8000);
      const order = [...out.matchAll(/--- sighting (\d+)/g)].map((m) => Number(m[1]));
      expect(order).toEqual([...order].sort((a, b) => a - b)); // monotonic
      expect(order[order.length - 1]).toBe(10); // newest is last
    });

    it('defect 5/4: NEVER exceeds max — including tiny max values', () => {
      const shapes: Array<[string, string]> = [
        ['', ''],
        ['x', 'y'],
        ['x'.repeat(7950), `2 ---\n${'y'.repeat(200)}`],
        ['x'.repeat(9000), `2 ---\n${'y'.repeat(9000)}`],
        ['R'.repeat(6000) + '\n\n--- sighting 2 ---\nold', `3 ---\n${'P'.repeat(2000)}`],
        ['Head.\n\n--- sighting 2 ---\n' + 'q'.repeat(5000), `3 ---\n${'z'.repeat(5000)}`],
      ];
      for (const max of [1, 16, 20, 24, 32, 64, 100, 1000, 8000]) {
        for (const [head, block] of shapes) {
          const out = fitBumpedDescription(head, block, max);
          expect(out.length).toBeLessThanOrEqual(max);
        }
      }
    });

    it('defect 4: slicing never splits a surrogate pair', () => {
      const head = '🎯'.repeat(3000); // 2 UTF-16 units each
      const block = `2 ---\n${'😀'.repeat(3000)}`;
      const out = fitBumpedDescription(head, block, 8000);
      expect(out.length).toBeLessThanOrEqual(8000);
      // A lone surrogate would leave an unpaired code unit at the cut.
      expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    });
  });

  it('never exceeds the cap across a sweep of shapes (property)', () => {
    for (const n of [0, 1, 3, 9, 20]) {
      for (const each of [10, 300, 900, 4000, 9000]) {
        for (const blockChars of [50, 900, 9000]) {
          const existing = withSightings(n, each);
          const block = `${n + 1} ---\n${'z'.repeat(blockChars)}`;
          const out = fitBumpedDescription(existing, block, 8000);
          expect(out.length).toBeLessThanOrEqual(8000);
          // The newest block is ALWAYS present in some form — never the old
          // text unchanged (the pre-fix failure mode).
          expect(out).toContain(`--- sighting ${n + 1} ---`);
        }
      }
    }
  });

  it('the 300802aa regression, replayed from the real row shape', () => {
    // Shape of the actual ticket: a long first report + four prior sightings,
    // already at/over the cap, then today's sighting 5 with 13 phantom claims.
    const head = `A project supervisor's machine-wake note claimed actions its tool log never executed.\n\n${'Note excerpt:\n' + 'context line\n'.repeat(240)}`.trim();
    const existing = `${head}\n\n--- sighting 2 ---\n${'b'.repeat(1600)}\n\n--- sighting 3 ---\n${'c'.repeat(1600)}\n\n--- sighting 4 ---\n${'d'.repeat(1600)}`;
    const block = `5 ---\nA project supervisor's machine-wake note claimed actions its tool log never executed.\n\nPhantom claims:\n${Array.from({ length: 13 }, (_, i) => `- [dispatch] "phantom ${i + 1}"`).join('\n')}`;
    // Pre-fix: the append overflows, so the description is left UNCHANGED and
    // all 13 claims are lost while occurrences becomes 5.
    const preFix = `${existing}\n\n--- sighting 5 ---\n${block}`;
    expect(preFix.length).toBeGreaterThan(8000);
    expect(existing).not.toContain('phantom 1');

    const out = fitBumpedDescription(existing, block, 8000);
    // The evidence a lane must adjudicate is now present.
    expect(out).toContain('--- sighting 5 ---');
    expect(out).toContain('phantom 1');
    expect(out).toContain('phantom 13');
    expect(out.length).toBeLessThanOrEqual(8000);
  });
});