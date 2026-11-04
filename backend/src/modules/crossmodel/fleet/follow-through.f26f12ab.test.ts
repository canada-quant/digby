/**
 * Replay for ticket f26f12ab — "Auto-filer packaged a non-question status note
 * as an owner decision card".
 *
 * THE BUG: 2026-09-17T10:56:16Z — the follow-through unfiled-decision sweep
 * auto-created owner question oq_9f5995bf from a CanLaw Supervisor (chat
 * f5c2c1f4) STATUS NOTE whose entire text is an explicit DECLINE-to-re-file:
 * "Not re-filed from CanLaw — no duplicate card, and nothing else in this
 * project waits on the owner (board: 0 open owner questions here)." The note
 * is the supervisor saying it is NOT filing a card — and the auto-filer
 * packaged that decline AS a new "Decision needed" owner card (owner-rail
 * noise, polluted the open-question count, and cost a manual Fleet-Supervisor
 * housekeeping-close).
 *
 * ROOT CAUSE: mineUnfiledDecisionClaims had guards for RESOLUTION/history of
 * the wait (GATING_RESOLVED_RE) and for NEGATED waiting frames
 * (NEGATED/NOTHING_CLASS/PARENTHETICAL), but no guard for the note's own
 * FILING intent: a sentence that explicitly declines or defers the filing
 * while ALSO carrying an un-negated gating frame — "Not re-filing — the
 * publish gate still waits on the owner (no duplicate card)" — matched
 * GATING_RE, cleared every negation scope, and auto-filed. (The exact
 * incident string is already suppressed by bdd71948's widened nothing-class
 * window — "nothing else in this project" is 4 gap words — pinned below as
 * the regression anchor; the residual CLASS is what this ticket fixes.)
 *
 * THE FIX: DECLINE_RE (follow-through.service.ts) — a sentence-level veto in
 * mineUnfiledDecisionClaims covering the decline/defer arms: "not re-filed /
 * re-filing", "no duplicate card|question", "declining to file", "won't /
 * will not file", "not filing|raising", "deferring the card|filing", "no
 * (new) card|owner question needed", "no need to file", "nothing to file".
 * Sentence-level by design: the decline asserts the card exists (the
 * open-question ledger check then covers it) or is unwanted — auto-filing
 * contradicts the note's own statement either way; the acknowledged
 * false-negative direction (a decline scoped to one gate sharing a sentence
 * with a live claim about another) is safe for a heuristic net. The veto is
 * per SENTENCE, not per note: a live claim in a SEPARATE sentence of the same
 * note still files (pinned at sweep level below).
 *
 * Mock discipline mirrors follow-through.bdd71948.test.ts /
 * follow-through.be90502f.test.ts: prisma + redis + logger + loop-metrics
 * stubbed at the module seams; the REAL miner and the REAL sweep run.
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

import { mineUnfiledDecisionClaims, sweepFollowThrough } from './follow-through.service';

const NOW = new Date('2026-09-17T12:00:00Z');
const SUP = 'f5c2c1f4-0000-4000-8000-000000000000'; // the CanLaw Supervisor chat shape (f26f12ab)
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);

/** The exact note text from ticket f26f12ab that auto-filed oq_9f5995bf at
 *  2026-09-17T10:56:16Z. Already suppressed pre-fix by bdd71948's nothing-class
 *  window — pinned here as the regression anchor for the incident string. */
const INCIDENT = 'Not re-filed from CanLaw — no duplicate card, and nothing else in this project waits on the owner (board: 0 open owner questions here).';

/** The residual CLASS f26f12ab fixes: each of these sentences explicitly
 *  declines/defers the filing AND carries an un-negated gating frame — every
 *  one auto-filed before DECLINE_RE (verified by stashing the fix). */
const DECLINE_VARIANTS = [
  'Not re-filing — the publish gate still waits on the owner (no duplicate card).',
  'Declining to file — the seat swap remains blocked on the owner.',
  "Won't file a duplicate; the gate waits on Paul.",
  'Deferring the card; the alias gate waits on Paul.',
  'No owner question needed — the publish gate still waits on the owner.',
  'Nothing to file: the v0.8.2 publish still waits on Paul.',
];

const supRow = { id: SUP, userId: 'u1', title: 'CanLaw Supervisor', projectId: 'p-canlaw', isSupervisor: false, isProjectSupervisor: true };
const note = (content: string, createdAt: Date, id = 'note-f26f12ab') => ({
  id, content, createdAt, metadata: { origin: 'schedule' },
});
const flag = jest.fn(async (_args: any) => ({ kind: 'created', question: { id: 'oq_f26f12ab-0000-4000-8000-000000000000' } }));
const wake = jest.fn(async () => ({}));

describe('replay f26f12ab — miner level', () => {
  it('the exact incident note text never mines an unfiled-decision claim', () => {
    expect(mineUnfiledDecisionClaims(INCIDENT)).toEqual([]);
  });

  it.each(DECLINE_VARIANTS.map((s) => [s]))('a decline/defer sentence never mines: %s', (sentence) => {
    expect(mineUnfiledDecisionClaims(sentence as string)).toEqual([]);
  });

  it('the affirmative owner-wait claims the detector exists for still mine', () => {
    expect(mineUnfiledDecisionClaims('Publishing v0.8.2 is owner-gated on Gates 1–3.')).toEqual([
      'Publishing v0.8.2 is owner-gated on Gates 1–3.',
    ]);
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner.')).toEqual([
      'The seat swap remains blocked on the owner.',
    ]);
  });

  it('live-claim controls sharing decline VOCABULARY still mine (the veto needs the negated intent, not the words)', () => {
    // "duplicate card" without the "no" — asserts the wait, denies the duplication.
    expect(mineUnfiledDecisionClaims('A duplicate card is not the issue here — the publish gate waits on the owner.')).toEqual([
      'A duplicate card is not the issue here — the publish gate waits on the owner.',
    ]);
    // "No owner question is open" is a ledger report, not a decline-to-file (f7e9df4c pin).
    expect(mineUnfiledDecisionClaims('No owner question is open; the publish call waits on Paul.')).toEqual([
      'No owner question is open; the publish call waits on Paul.',
    ]);
    // comma-contrast re-arm (bdd71948 B1 pin) still mines past the new veto.
    expect(mineUnfiledDecisionClaims('Nothing is queued, but the publish gate waits on the owner.')).toEqual([
      'Nothing is queued, but the publish gate waits on the owner.',
    ]);
  });

  it('the veto is per SENTENCE, not per note: a live claim in a separate sentence of the same note still mines', () => {
    const mixed = 'Not re-filing — the publish gate still waits on the owner (no duplicate card). The seat swap remains blocked on the owner.';
    expect(mineUnfiledDecisionClaims(mixed)).toEqual(['The seat swap remains blocked on the owner.']);
  });
});

describe('replay f26f12ab — sweep level (no owner question is filed from a decline)', () => {
  const seedCursor = (msAgo: number, chatId = SUP) => store.set(`follow-through:cursor:${chatId}`, String(NOW.getTime() - msAgo));
  const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });

  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    mockPrisma.crossModelChat.findMany.mockImplementation(async () => [supRow]);
    mockPrisma.crossModelChat.findFirst.mockImplementation(async () => null);
    mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: 'p-canlaw', projectSupervisorEnabled: true, archivedAt: null }]);
    mockPrisma.crossModelMessage.findMany.mockImplementation(async () => []);
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async () => null);
    mockPrisma.runToolReceipt.findMany.mockImplementation(async () => []);
    mockPrisma.projectTodo.findFirst.mockImplementation(async () => null);
    mockPrisma.ownerQuestion.findFirst.mockImplementation(async () => null);
  });

  it('incident oq_9f5995bf: the exact decline note files NOTHING and posts no notice', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(INCIDENT, minutesAgo(120))]);
    const out = await run();
    expect(out.autofiled).toBe(0);
    expect(flag).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a decline-variant note files NOTHING even with a live gating frame inside the declining sentence', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(DECLINE_VARIANTS[0], minutesAgo(120))]);
    const out = await run();
    expect(out.autofiled).toBe(0);
    expect(flag).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('per-sentence veto: a live claim in a SEPARATE sentence of the same note still auto-files, and only that sentence', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('Not re-filing — the publish gate still waits on the owner (no duplicate card). The seat swap remains blocked on the owner.', minutesAgo(120)),
    ]);
    const out = await run();
    expect(out.autofiled).toBe(1);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({
      chatId: SUP, userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('The seat swap remains blocked on the owner.'),
    }));
    expect(flag.mock.calls[0][0].question).not.toContain('Not re-filing');
  });

  it('regression pin: an affirmative owner-gated claim in the same-shaped note STILL auto-files', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('Board swept. Publishing v0.8.2 is owner-gated on Gates 1–3.', minutesAgo(120)),
    ]);
    const out = await run();
    expect(out.autofiled).toBe(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({
      chatId: SUP, userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('Publishing v0.8.2 is owner-gated on Gates 1–3.'),
    }));
  });
});
