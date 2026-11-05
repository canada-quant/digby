/**
 * REPLAY PIN — mishap ticket 1c2eb455 (2026-09-16T06:03:46.513Z, verifier:
 * action-verifier): "Phantom observation clock: machine note cites future
 * timestamp(s) (chat 9e6e1712)".
 *
 * THE INCIDENT BEING REPLAYED: the crossmodel project supervisor's SWEEP-46
 * machine wake (chat 9e6e1712-8dc3-4e02-b70c-557bb5b41d2d, run clock
 * 2026-09-16T06:03:46.513Z) published a ledger note whose g2b line cited
 * "done at 06:05:31Z" and "msg 235b827e @06:06:02Z" — 104s and 136s AHEAD of
 * the run's real clock, past the detector's 90s skew tolerance. An
 * observation of the future is impossible: the deterministic
 * future-observation-clock lane (ticket 375c8618 class —
 * deploy/restart-interrupted runs inventing clock evidence) convicted both
 * stamps PRE-DELIVERY, REPLACED the note (ticket cdd3fbfe: every future-clock
 * conviction is a full pre-delivery replacement, the original quoted as an
 * audit block), and auto-filed the ticket (context containedPreDelivery:true).
 * The phantom lines never reached the thread as fact.
 *
 * ADJUDICATION (2026-09-16 engineering lane b92ef13f): CONTAINED-SIGNAL class
 * — same family as 080365bf / 16469005 / 3892de13. The guard did EXACTLY what
 * it is designed to do; the filing is its own telemetry. No runtime code
 * change — this file pins the containment so a regression that stops catching
 * (or starts over-catching) the incident shape fails CI.
 *
 * What makes THIS pin load-bearing (the shapes sibling pins do not cover):
 *  1. SMALL-AHEAD convictions: +104s/+136s — barely past the 90s tolerance
 *     (ticket 80dd882d's rejected ±15min bar would have made both invisible).
 *  2. TOLERANCE co-existence on the SAME convicted line: "listed 06:03:52Z"
 *     is +5.5s at the incident clock and "FIRED 06:05Z" on the next line is
 *     +73.5s — both inside 90s, both honest, neither struck. A tolerance
 *     regression (0s or widened) flips this pin.
 *  3. FUTURE-LABEL co-existence: the same note cites FAR-ahead clocks
 *     (ETA ~07:55Z, catcher/next 06:15Z, next fire 06:21Z) that stay legal
 *     ONLY because their lines carry explicit future-intent wording — the
 *     detector's line-level exemption, exercised on the incident's own prose.
 *  4. The strike costs NO LLM call (the clock lane runs before the keyword
 *     gate and early-returns) and the reject-back pre-pass
 *     (deferConsequences) convicts without filing.
 *
 * Boundary-mocked like the sibling pins (action-verifier.080365bf.test.ts):
 * prisma, logger, the utility LLM, the feedback service, supervisor-state and
 * the receipts service are stubs; the REAL guard executes.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import {
  guardMachineWakeFinalAnswer,
  findFutureObservedTimestamps,
  ACTION_GUARD_BANNER,
} from './action-verifier';

/** The incident seat + owner (ticket context sessionId / userId). */
const CHAT = '9e6e1712-8dc3-4e02-b70c-557bb5b41d2d';
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
/** The run's real clock (ticket context filedAt) — the comparison point. */
const INCIDENT_NOW = new Date('2026-09-16T06:03:46.513Z');

/** The CONVICTED line — verbatim from the ticket's struck-timestamp listing. */
const G2B_LINE = '- **g2b ADJUDICATED + BANKED** (todo d17821d0 done at 06:05:31Z; spark lane msg 235b827e @06:06:02Z): Amendment-1 within-boot repro CID 6cd1d875 — c16 Δ−0.2762 **reproduced** ⇒ tok/s FROZEN; c6 +0.0173, c8 +0.0212. Banked sha `9cb27e6e…49` (listed 06:03:52Z), DF2 release/ untouched sha `a10e9a1c…4a`.';
/** The incident's future-LABELED line (every far-ahead clock exempt by wording). */
const G3_LINE = '- **g3 FIRED 06:05Z** (todo 365cbe7d in_progress): 110-min leg, ETA ~07:55Z future; catcher 06:15Z future; DF2 watcher 23/30 NEG.';
const WINDOW_LINE = '**Window**: g1a/g1b/g2a/g2b done+banked+adjudicated; g3 in flight; g4 + restore queued (catcher 947f12dc, next 06:15Z future). Kernel-opt idle, next fire 06:21Z future.';

/** The incident note — reconstructed from the ticket's excerpt, convicted lines verbatim. */
const INCIDENT_NOTE = [
  '**06:02Z SWEEP 46 — ADOPT-3b: g2b FROZEN, g3 in flight, restore armed**',
  '',
  '**Ledger (pulled fresh this run)**',
  '',
  G2B_LINE,
  G3_LINE,
  '- **R8 with owner** (todo 29390cde blocked \'owner\', oq_a4ce6b61 — open/surfaced per prior fresh probe): evidence base now g1a KEEP, g1b KILLED, g2a FROZEN, g2b FROZEN.',
  '- Repo-writer sibling 421938f3 idle/deaf — its repo steer stays HELD (spark steer 05:03Z, id not captured this run).',
  '',
  WINDOW_LINE,
  '',
  'SWEEP: no-op — lanes are executing on their own armed cadence; no steer or dispatch needed this sweep.',
].join('\n');

const guard = (extra: Record<string, unknown>) =>
  guardMachineWakeFinalAnswer({
    chatId: CHAT,
    userId: OWNER,
    finalText: INCIDENT_NOTE,
    parts: [],
    receipts: [],
    runStartedAt: new Date('2026-09-16T06:02:00.000Z'),
    supervisor: true,
    supervisorScope: 'project',
    now: INCIDENT_NOW,
    machineTriggered: true,
    ...extra,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
});

describe('ticket 1c2eb455 — REPLAY: the SWEEP-46 phantom observation clocks', () => {
  // build 2026-10-08 Q-3: pins the LEGACY replace lane (FUTURE_CLOCK_REPLACE_ENABLED=1 restore path);
  // the default clock policy is pinned in action-verifier.future-clock-policy.q3.test.ts.
  beforeAll(() => { process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1'; });
  afterAll(() => { delete process.env.FUTURE_CLOCK_REPLACE_ENABLED; });
  it('convicts both small-ahead stamps PRE-DELIVERY and REPLACES the note; the ticket carries the incident attribution', async () => {
    const res = await guard({});
    expect(res.struck).toBe(true);
    expect(res.audited).toBe(true);
    // Full pre-delivery replacement (ticket cdd3fbfe): the original survives
    // only as a quoted audit block inside the harness notice.
    expect(res.finalText).toContain(ACTION_GUARD_BANNER);
    expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
    expect(res.finalText).toContain('--- END STRUCK NOTE ---');
    expect(res.finalText).toContain('"06:05:31Z"');
    expect(res.finalText).toContain('"06:06:02Z"');
    expect(res.finalText).toContain(INCIDENT_NOW.toISOString());
    expect(res.correction).toContain('Clock discipline');
    // Deterministic: the clock lane runs before the keyword gate and never
    // spends an LLM call (the early-return shape).
    expect(mockUtilityChat).not.toHaveBeenCalled();
    // The auto-filed mishap ticket — the incident's own filing shape.
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const ticket = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(ticket.type).toBe('mishap');
    expect(ticket.title).toBe('Phantom observation clock: machine note cites future timestamp(s) (chat 9e6e1712)');
    expect(ticket.description).toContain('"06:05:31Z"');
    expect(ticket.description).toContain('"06:06:02Z"');
    expect(ticket.description).toContain(INCIDENT_NOW.toISOString());
  });

  it('reject-back pre-pass (deferConsequences): the same strike convicts and names the stamps WITHOUT filing', async () => {
    const res = await guard({ deferConsequences: true });
    expect(res.struck).toBe(true);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain('06:05:31Z');
    expect(res.rejectBackNotice).toContain('06:06:02Z');
  });

  it('CONTROL: the same ledger with within-tolerance clocks stays CLEAN (existence mocks vouch the citations)', async () => {
    const cleanNote = INCIDENT_NOTE
      .replace('done at 06:05:31Z', 'done at 06:03:31Z')
      .replace('@06:06:02Z', '@06:03:40Z');
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'msg-235b827e-full' });
    mockPrisma.chatSchedule.findFirst.mockResolvedValue({ id: 'sched-947f12dc-full' });
    const res = await guard({ finalText: cleanNote });
    expect(res.struck ?? false).toBe(false);
    expect(res.finalText).toBe(cleanNote);
    expect(res.finalText).not.toContain('--- BEGIN STRUCK NOTE');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('ticket 1c2eb455 — deterministic unit pins on the incident shapes', () => {
  it('the convicted line yields EXACTLY the two phantom stamps (+104s/+136s → 2 min ahead each)', () => {
    const hits = findFutureObservedTimestamps(G2B_LINE, INCIDENT_NOW);
    expect(hits.map((h) => h.token).sort()).toEqual(['06:05:31Z', '06:06:02Z']);
    expect(hits.every((h) => h.minutesAhead === 2)).toBe(true);
    // The within-tolerance "listed 06:03:52Z" (+5.5s) on the SAME line is not a hit.
    expect(hits.map((h) => h.token)).not.toContain('06:03:52Z');
  });

  it('the 90s tolerance pin: "FIRED 06:05Z" (+73.5s) never convicts at the incident clock', () => {
    expect(findFutureObservedTimestamps('- **g3 FIRED 06:05Z** (todo 365cbe7d in_progress): leg started.', INCIDENT_NOW)).toEqual([]);
  });

  it('the future-label exemption pin: far-ahead clocks with explicit future wording never convict', () => {
    expect(findFutureObservedTimestamps(G3_LINE, INCIDENT_NOW)).toEqual([]);
    expect(findFutureObservedTimestamps(WINDOW_LINE, INCIDENT_NOW)).toEqual([]);
  });
});
