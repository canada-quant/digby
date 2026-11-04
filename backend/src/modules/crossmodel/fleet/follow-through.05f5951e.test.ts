/**
 * Ticket 05f5951e (enhancement, 2026-09-27) — replay of the oq_6969b9d7
 * auto-file: the tt-rd Supervisor's 02:00Z sweep note reported todo 1705b24a
 * as correctly held — "Todo 1705b24a stays blocked on the owner's standing
 * no-benchmarks ruling; 50327115 dep-blocked by design." — and the follow-
 * through miner auto-filed it as a "Decision needed" owner question anyway
 * (routed to Fleet Supervisor triage at 03:45Z, cleared the same wake citing
 * the standing 2026-09-18 directive — the ruling the note itself quoted).
 *
 * A status line saying "held by the owner's standing ruling" is the OPPOSITE
 * of a decision request: the sentence's own text asserts a decision that
 * already exists. Fix: a STANDING-RULING arm joins GATING_RESOLVED_RE —
 * \bstanding (owner )?(ruling|directive|decision|decree|order|policy|
 * instruction|precedent)\b — sentence-level, exactly like "ruled"/"decided".
 *
 * BOUNDS pinned here (the phrase-anchored shape, per the bdd71948 review
 * doctrine — sentence-level arms are cheap but phrase-level anchors are
 * safer):
 *   - "standing on the owner" (STANCE noun, not a ruling) still MINES — the
 *     arm is anchored on the ruling-family noun, never on "standing" alone;
 *   - a GENUINE pending decision still mines (no "standing" qualifier, no
 *     resolved register);
 *   - "the owner's standing ruling" with the possessive still suppresses
 *     (the incident's exact shape).
 */
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
const mockRedis: any = {
  get: jest.fn(async () => null),
  set: jest.fn(async () => 'OK'),
  del: jest.fn(async () => 1),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { mineUnfiledDecisionClaims } from './follow-through.service';

describe('standing-ruling holds are not unfiled decisions (ticket 05f5951e, 2026-09-27)', () => {
  it('REPLAY oq_6969b9d7: the tt-rd Supervisor\'s held-todo sentence suppresses (no owner question filed)', () => {
    expect(mineUnfiledDecisionClaims(
      "Todo 1705b24a stays blocked on the owner's standing no-benchmarks ruling; 50327115 dep-blocked by design.",
    )).toEqual([]);
  });

  it('the possessive form "the owner\'s standing <ruling-family noun>" suppresses across the noun family', () => {
    expect(mineUnfiledDecisionClaims("The lane stays blocked on the owner's standing ruling on benchmarks.")).toEqual([]);
    expect(mineUnfiledDecisionClaims("Publishing stays blocked on the owner's standing directive from 09-18.")).toEqual([]);
    expect(mineUnfiledDecisionClaims("The seat swap stays blocked on the owner's standing decision.")).toEqual([]);
    expect(mineUnfiledDecisionClaims("Lane 3f1c2a9b stays blocked on the owner's standing policy of no benchmarks.")).toEqual([]);
  });

  it('the bare "standing <noun>" form (no possessive) suppresses too ("standing ruling", "standing directive")', () => {
    expect(mineUnfiledDecisionClaims('Todo a1b2c3d4 stays blocked on the standing ruling; no new decision needed.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('The gate stays blocked on the standing directive.')).toEqual([]);
  });

  it('BOUND: the STANCE noun "standing on the owner" still MINES (the arm is anchored on the ruling-family noun, not "standing" alone)', () => {
    // "standing" as a noun meaning stance/reputation — no ruling-family noun follows
    expect(mineUnfiledDecisionClaims('The lane is blocked on the owner, standing on the owner being an escalation path.'))
      .toEqual(['The lane is blocked on the owner, standing on the owner being an escalation path.']);
  });

  it('BOUND: a GENUINE pending decision still mines (no standing qualifier, no resolved register)', () => {
    expect(mineUnfiledDecisionClaims('Publishing v0.8.2 is owner-gated on Gates 1–3 (sol leg still at +1/hr).'))
      .toEqual(['Publishing v0.8.2 is owner-gated on Gates 1–3 (sol leg still at +1/hr).']);
    expect(mineUnfiledDecisionClaims('Step 6 waits on Paul.')).toEqual(['Step 6 waits on Paul.']);
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner.')).toEqual(['The seat swap remains blocked on the owner.']);
  });

  it('BOUND: "standing" with a NON-ruling noun does not suppress ("standing question", "standing item" still mine)', () => {
    // the noun family is closed: ruling|directive|decision|decree|order|policy|instruction|precedent
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner — a standing question since 09-14.'))
      .toEqual(['The seat swap remains blocked on the owner — a standing question since 09-14.']);
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner (a standing item on the board).'))
      .toEqual(['The seat swap remains blocked on the owner (a standing item on the board).']);
  });

  it('BOUND (review F1): DEMAND phrasings keep mining — a demanded standing-X does not exist yet ("pending a standing policy", "awaiting a standing directive")', () => {
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner pending a standing policy on seat changes.'))
      .toEqual(['The seat swap remains blocked on the owner pending a standing policy on seat changes.']);
    expect(mineUnfiledDecisionClaims('The gate stays blocked on the owner awaiting a standing directive.'))
      .toEqual(['The gate stays blocked on the owner awaiting a standing directive.']);
    expect(mineUnfiledDecisionClaims('The lane is blocked on the owner — he must issue a standing decision on benchmarks.'))
      .toEqual(['The lane is blocked on the owner — he must issue a standing decision on benchmarks.']);
  });

  it('BOUND (review F1): PASSIVE demand after the noun keeps mining ("a standing order is needed", "a standing ruling is required")', () => {
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner — a standing order is needed from him.'))
      .toEqual(['The seat swap remains blocked on the owner — a standing order is needed from him.']);
    expect(mineUnfiledDecisionClaims('A standing ruling from the owner is required to proceed; the gate stays blocked on the owner.'))
      .toEqual(['A standing ruling from the owner is required to proceed; the gate stays blocked on the owner.']);
  });

  it('BOUND (review F1): "requires" as the ruling\'s own ACTIVE verb does NOT re-arm — "the standing ruling requires us to hold" is the EXISTS reading', () => {
    expect(mineUnfiledDecisionClaims("The gate stays blocked on the owner; the standing ruling requires us to hold.")).toEqual([]);
  });

  it('ANTI-SMUGGLE: a supervisor cannot launder a genuine ask by appending "standing ruling" in a DIFFERENT clause', () => {
    // the arm is sentence-level like the other resolution arms — but a
    // sentence that both asks AND cites a standing ruling is the SAFE
    // direction: the sweep's heuristic net re-arms on the next non-citing
    // note, and a real open card blocks the sweep regardless.
    expect(mineUnfiledDecisionClaims('Publishing is blocked on the owner; per the standing ruling we proceed.')).toEqual([]);
  });
});
