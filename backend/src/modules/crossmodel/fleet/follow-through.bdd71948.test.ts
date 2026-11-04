/**
 * Replay for ticket bdd71948 — "Follow-through detector misparses 'zero open
 * owner questions' no-op notes as owner-gate claims (2nd occurrence)".
 *
 * THE BUG (two occurrences, both housekeeping-closed as false positives):
 *  - 2026-09-18T07:22Z: the detector auto-filed oq_06b64479 from a CanLaw
 *    Supervisor (chat f5c2c1f4) no-op sweep note at 05:38Z whose sentence
 *    "Zero open owner questions; nothing waits on the owner." stated the
 *    ABSENCE of any owner wait.
 *  - 2026-09-17T10:56Z: the detector auto-filed oq_9f5995bf from a note saying
 *    "Not re-filed from CanLaw — no duplicate card, and nothing else in this
 *    project waits on the owner (board: 0 open owner questions here)."
 *
 * ROOT CAUSE: both sentences matched GATING_RE's `\bwaits?\s+(?:on|for)\s+(?:paul|the\s+owner)`
 * alternative ("waits on the owner"), while GATING_RESOLVED_RE's nothing-class
 * negation only covered the `is (owner-gated|waiting|pending|blocked)` state-
 * verb frame — never the verb form "waits". ("Zero open owner questions" and
 * "no duplicate card" never match GATING_RE on their own; the mined claim in
 * each sentence was the negated "… waits on the owner" clause.)
 *
 * THE FIX (reconciled stack, after PR #851 f7e9df4c landed mid-review):
 * per-frame negation scope — main's generic NEGATED_FRAME_RE marks a gating
 * frame governed by a same-clause negation (≤3 gap words), and bdd71948
 * layers the nothing-class ABSENCE-subject window on top:
 * NOTHING_CLASS_FRAME_RE widens "nothing/nobody/none/no one" to ≤5 gap words
 * (comma/semicolon-excluding, guarded per gap word against BOTH contrastive
 * connectives and the exception-preposition class), PARENTHETICAL_FRAME_RE
 * keeps a comma aside directly after the marker negating, and
 * GATE_BUT_EXCEPTION_RE re-arms a negated frame when a post-verb exception
 * connector ("but", "except", "other than", …) follows — so the negated
 * clause is skipped while an affirmative claim in the same sentence still
 * mines (a sentence-level exclusion would have suppressed it).
 *
 * RESPIN (adversarial review 875216b0, verdict BLOCKED → findings B1/B2 fixed):
 * the first cut's 40-CHARACTER clause window let a nothing-class word bleed
 * across a comma contrast into an affirmative claim ("Nothing is queued, but
 * the publish gate waits on the owner" — mined on origin/main, suppressed on
 * the first cut), and a gratuitous 'pending' widening of GATING_RESOLVED_RE
 * added a sentence-level over-veto; both reverted/respun and pinned in
 * follow-through.service.test.ts ("REGRESSION pins (adversarial review
 * 875216b0, findings B1/B2)"). RESPIN-3 reconciled the stack with #851's
 * NEGATED_FRAME_RE merge; RESPIN-4 (finding G1) extended both guard lists
 * with the exception-preposition class (except/other/more/apart/aside/save/
 * besides/beyond/bar/excluding) and widened the post-verb re-arm beyond
 * "but" — the exception phrase names the thing that DOES wait, so mining is
 * always semantically correct for the idiom. RESPIN-5 (finding G2 +
 * supervisor daee2916 batch-enumeration steer) closed the class in ONE
 * pass: the guards now carry every grammaticalized exception preposition
 * (+ barring/excepting/saving/minus/plus/outside/past/exclusive/outwith)
 * and the emphatic-intensifier idioms (less than/short of/otherwise than),
 * swept tip-vs-main-replay over the standard closed preposition inventory;
 * the STANDING CLASS RULE — a connector joins the guard IFF "Nothing CONN X
 * VERBs" entails "X VERBs" — and the 51-probe boundary inventory (without/
 * including/after/… stays suppressed: main over-mines the 4–5 band, the tip
 * is semantically correct; round-5 reviewer nits folded in TEST-ONLY: 'vs'
 * pinned for versus-class completeness, 'rather than' adjudicated
 * OUT-OF-CLASS by the standing rule — modern parse is contrast/preference,
 * not exception) are pinned in the G2 block of
 * follow-through.service.test.ts.
 *
 * These tests replay BOTH incident sentences through the REAL miner and the
 * REAL sweep (prisma + redis + flagOwnerQuestion stubbed at the module seams,
 * mock discipline mirrors follow-through.service.test.ts) and pin that no
 * owner question is filed — and that the affirmative canlegal-bench claim the
 * detector exists for still files.
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

const NOW = new Date('2026-09-18T07:30:00Z');
const SUP = 'f5c2c1f4-0000-4000-8000-000000000000'; // the CanLaw Supervisor chat shape
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);

/** The exact sentence that auto-filed oq_06b64479 (note at 2026-09-18T05:38Z). */
const INCIDENT_1 = 'Zero open owner questions; nothing waits on the owner.';
/** The exact sentence that auto-filed oq_9f5995bf (note at 2026-09-17T10:56Z). */
const INCIDENT_2 = 'Not re-filed from CanLaw — no duplicate card, and nothing else in this project waits on the owner (board: 0 open owner questions here).';

const supRow = { id: SUP, userId: 'u1', title: 'CanLaw Supervisor', projectId: 'p-canlaw', isSupervisor: false, isProjectSupervisor: true };
const note = (content: string, createdAt: Date, id = 'note-bdd71948') => ({
  id, content, createdAt, metadata: { origin: 'schedule' },
});
const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_bdd71948-0000-4000-8000-000000000000' } }));
const wake = jest.fn(async () => ({}));

describe('replay bdd71948 — miner level', () => {
  it('neither incident sentence mines an unfiled-decision claim anymore', () => {
    expect(mineUnfiledDecisionClaims(INCIDENT_1)).toEqual([]);
    expect(mineUnfiledDecisionClaims(INCIDENT_2)).toEqual([]);
  });

  it('the detector still mines the affirmative owner-wait claims it exists for', () => {
    expect(mineUnfiledDecisionClaims('Publishing v0.8.2 is owner-gated on Gates 1–3.')).toEqual([
      'Publishing v0.8.2 is owner-gated on Gates 1–3.',
    ]);
    expect(mineUnfiledDecisionClaims('The seat swap remains blocked on the owner.')).toEqual([
      'The seat swap remains blocked on the owner.',
    ]);
  });

  it('respin pin (review 875216b0 B1): a comma contrast does not suppress the affirmative claim', () => {
    expect(mineUnfiledDecisionClaims('Nothing is queued, but the publish gate waits on the owner.')).toEqual([
      'Nothing is queued, but the publish gate waits on the owner.',
    ]);
  });
});

describe('replay bdd71948 — sweep level (no owner question is filed)', () => {
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

  it.each([
    ['oq_06b64479', INCIDENT_1],
    ['oq_9f5995bf', INCIDENT_2],
  ])('incident %s: the no-op note files NOTHING and posts no notice', async (_oq, sentence) => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(sentence, minutesAgo(120))]);
    const out = await run();
    expect(out.autofiled).toBe(0);
    expect(flag).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('regression pin: an affirmative owner-gated claim in the same-shaped note STILL auto-files', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('Zero open owner questions on the board. Publishing v0.8.2 is owner-gated on Gates 1–3.', minutesAgo(120)),
    ]);
    const out = await run();
    expect(out.autofiled).toBe(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({
      chatId: SUP, userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('Publishing v0.8.2 is owner-gated on Gates 1–3.'),
    }));
  });
});
