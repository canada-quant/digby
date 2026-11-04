/**
 * Replay for ticket 11354cbe — "Follow-through auto-filer: comma-parenthetical
 * door still mines 'Nothing, per X status, waits on the owner.' (68a1c868
 * residual)".
 *
 * THE INCIDENT: the 68a1c868 fix (PR #1943, squash 4b655f10) made the negation
 * windows' GAP WORDS compositional (dot-free head + ".lower-or-digit"
 * identifier tails) so "Nothing in ctrl.example.com is waiting on the owner."
 * suppresses. But PARENTHETICAL_FRAME_RE's ASIDE BODY was still the raw
 * dot-EXCLUDING class [^.;:,\n]{1,60}? — an aside CARRYING a dotted
 * identifier ("per ctrl.example.com status") could not be consumed, the
 * parenthetical guard died, and the comma-parenthetical negative status
 * report "Nothing, per ctrl.example.com status, waits on the owner." MINED as an
 * affirmative owner-wait claim (scratch probe at tip 11311aff4 on 2026-10-24:
 * PARENTHETICAL_MINES=["Nothing, per ctrl.example.com status, waits on the
 * owner."]). The adversarial reviewer's 34-shape parent/tip differential
 * proved parent-parity at 6defebc9a — a PRE-EXISTING hole, not a 68a1c868
 * regression — flagged as the follow-up that became this ticket.
 *
 * ROOT CAUSE (same family as 68a1c868, different door): the dotted
 * identifier appears in the ASIDE BODY, not the gap words, and the aside
 * body's class excluded dots.
 *
 * THE FIX: the aside body is now a run of the SAME compositional gap words
 * the other two windows use (NEG_GAP_WORD_RE_SOURCE), comma-joined, with the
 * ≤60-char cap kept as a comma-within-60-chars lookahead (the aside body
 * holds no commas, so the comma the lookahead finds IS the closing one). So
 * "Nothing, per ctrl.example.com status, waits on the owner." suppresses like its
 * undotted sibling "Nothing, per the current status, waits on the owner.",
 * while every pinned contrast keeps mining.
 *
 * DETECTOR-RECALL REPLAY: these tests replay the detector's PRIOR true
 * positives (the affirmative owner-wait claims and contrast shapes the
 * auto-filer exists for — pinned in the bdd71948 / 68a1c868 / service suites)
 * and assert they STILL mine, alongside the incident replays asserting the
 * comma-parenthetical negative status reports file nothing.
 */

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { mineUnfiledDecisionClaims } from './follow-through.service';

/** The exact sentence the ticket's scratch probe demonstrated mining at tip. */
const INCIDENT = 'Nothing, per ctrl.example.com status, waits on the owner.';
/** The 68a1c868 incident sentence (dotted identifier in the GAP WORDS, no
 *  parenthetical) — re-pinned here so the two doors stay fixed together. */
const DOOR_68A1C868 = 'Nothing in ctrl.example.com is waiting on the owner.';

describe('replay 11354cbe — comma-parenthetical door (miner level)', () => {
  it('the incident sentence (dotted identifier in the ASIDE) mines NO claim anymore', () => {
    expect(mineUnfiledDecisionClaims(INCIDENT)).toEqual([]);
    expect(mineUnfiledDecisionClaims(DOOR_68A1C868)).toEqual([]);
  });

  it('dotted-identifier asides suppress (the 11354cbe class)', () => {
    expect(mineUnfiledDecisionClaims('Nothing, per i-020850b4.prod.aws status, waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing, per digby.example.com v0.8.2 status, waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing, per project.paul-2.config.json, waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No-one, per ctrl.example.com status, waits on the owner.')).toEqual([]);
    // dot-free asides keep their 68a1c868-era suppression (the preserved win)
    expect(mineUnfiledDecisionClaims('Nothing, as of this sweep, waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing, per the current status, waits on the owner.')).toEqual([]);
  });

  it('DETECTOR-RECALL REPLAY — the affirmative owner-wait claims the detector exists for STILL mine', () => {
    expect(mineUnfiledDecisionClaims('Publishing v0.8.2 is owner-gated on Gates 1–3.')).toEqual([
      'Publishing v0.8.2 is owner-gated on Gates 1–3.',
    ]);
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner.')).toEqual([
      'The seat swap remains blocked on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('The deploy of digby.example.com waits on the owner.')).toEqual([
      'The deploy of digby.example.com waits on the owner.',
    ]);
  });

  it('DETECTOR-RECALL REPLAY — contrast/exception/parenthetical-guard shapes keep their pinned behavior', () => {
    // comma contrast (bdd71948 B1): the live claim still mines
    expect(mineUnfiledDecisionClaims('Nothing is queued, but the publish gate waits on the owner.')).toEqual([
      'Nothing is queued, but the publish gate waits on the owner.',
    ]);
    // pre-existing parenthesized-connective FP class: keeps mining (pinned)
    expect(mineUnfiledDecisionClaims('Nothing, however, waits on the owner.')).toEqual([
      'Nothing, however, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, though, waits on the owner.')).toEqual([
      'Nothing, though, waits on the owner.',
    ]);
    // comma-wrapped exception idioms (875216b0 G1/G2): the named exception is
    // the thing that DOES wait — keep mining
    expect(mineUnfiledDecisionClaims('Nothing, except the publish gate, waits on the owner.')).toEqual([
      'Nothing, except the publish gate, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, Except the publish gate, waits on the owner.')).toEqual([
      'Nothing, Except the publish gate, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, barring the publish gate, waits on the owner.')).toEqual([
      'Nothing, barring the publish gate, waits on the owner.',
    ]);
    // MID-ASIDE exception prepositions (review of this fix, finding F1): the
    // aside guard must vet EVERY gap word, not only the opening one — the
    // exception names the thing that DOES wait, an affirmative claim
    expect(mineUnfiledDecisionClaims('Nothing, per ctrl.example.com except the publish gate, waits on the owner.')).toEqual([
      'Nothing, per ctrl.example.com except the publish gate, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, per digby.example.com other than the publish gate, waits on the owner.')).toEqual([
      'Nothing, per digby.example.com other than the publish gate, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, per ctrl.example.com status except the DMG build ask, waits on the owner.')).toEqual([
      'Nothing, per ctrl.example.com status except the DMG build ask, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, in the ctrl.example.com run apart from the publish gate, waits on the owner.')).toEqual([
      'Nothing, in the ctrl.example.com run apart from the publish gate, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, per the sweep except the publish gate, waits on the owner.')).toEqual([
      'Nothing, per the sweep except the publish gate, waits on the owner.',
    ]);
    // mid-aside trailing connective: the claim after it is live
    expect(mineUnfiledDecisionClaims('Nothing, per ctrl.example.com however, waits on the owner.')).toEqual([
      'Nothing, per ctrl.example.com however, waits on the owner.',
    ]);
    // post-verb exception re-arm over a parenthetical-negated frame
    expect(mineUnfiledDecisionClaims('Nothing, as of this sweep, waits on the owner but the publish gate.')).toEqual([
      'Nothing, as of this sweep, waits on the owner but the publish gate.',
    ]);
    // sentence boundary INSIDE the aside's would-be span (68a1c868 doctrine):
    // dot+Capital is a terminator, not an identifier dot. The SPACED form
    // SPLITS into two sentences (SENTENCE_SPLIT_RE), so the live claim is the
    // second sentence — same pin as follow-through.68a1c868.test.ts; the
    // aside guard never spans the terminator either way.
    expect(mineUnfiledDecisionClaims('Nothing, per the last sweep. The gate waits on the owner.')).toEqual([
      'The gate waits on the owner.',
    ]);
    // aside opening with a dot-token: an identifier tail can never START a
    // word — main-parity mining (mirrors the 68a1c868 dot boundary)
    expect(mineUnfiledDecisionClaims('Nothing, .cql status, waits on the owner.')).toEqual([
      'Nothing, .cql status, waits on the owner.',
    ]);
  });

  it('the ≤60-char aside cap keeps its exact boundary (60 suppresses, 61 mines) — review finding F5/F3 pin', () => {
    // 60 chars between the opening and closing comma → suppresses
    const aside60 = 'x'.repeat(60);
    expect(mineUnfiledDecisionClaims(`Nothing, ${aside60}, waits on the owner.`)).toEqual([]);
    // 61 chars → the parenthetical reading is gone; the live claim mines
    const aside61 = 'x'.repeat(61);
    expect(mineUnfiledDecisionClaims(`Nothing, ${aside61}, waits on the owner.`)).toEqual([
      `Nothing, ${aside61}, waits on the owner.`,
    ]);
    // a line separator (CR / U+2028 / U+2029) inside a dot-free aside does
    // not dodge the cap — the lookahead's class is [\s\S], not `.` (F3)
    expect(mineUnfiledDecisionClaims(`Nothing, per the current\rstatus, waits on the owner.`)).toEqual([]);
    expect(mineUnfiledDecisionClaims(`Nothing, per the current\u2028status, waits on the owner.`)).toEqual([]);
    expect(mineUnfiledDecisionClaims(`Nothing, per the current\u2029status, waits on the owner.`)).toEqual([]);
  });

  it('whitespace-only asides: two-space parent parity, one-space divergence (review finding F4, declared in doctrine)', () => {
    // two-space form: parent-parity suppression
    expect(mineUnfiledDecisionClaims('Nothing,  ,  waits on the owner.')).toEqual([]);
    // one-space form: MINED at the parent (its body demanded ≥1 non-comma
    // char, so ", ," defeated every window) and now suppresses — a benign,
    // semantically-correct divergence (the parenthetical reading is still
    // the only one the sentence has), declared in the doctrine comment.
    expect(mineUnfiledDecisionClaims('Nothing, , waits on the owner.')).toEqual([]);
  });

  it('main-parity negative reports keep suppressing (68a1c868 / bdd71948 regression pins)', () => {
    expect(mineUnfiledDecisionClaims('Nothing is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing in this project waits on the owner right now.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Zero open owner questions; nothing waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Not re-filed from CanLaw — no duplicate card, and nothing else in this project waits on the owner (board: 0 open owner questions here).')).toEqual([]);
  });

  it('mixed note: a dotted-aside no-op status line next to an affirmative claim still auto-files only the claim', () => {
    const claims = mineUnfiledDecisionClaims(
      'Nothing, per ctrl.example.com status, waits on the owner. Publishing v0.8.2 is owner-gated on Gates 1–3.',
    );
    expect(claims).toEqual(['Publishing v0.8.2 is owner-gated on Gates 1–3.']);
  });
});
