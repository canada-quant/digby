/**
 * REPLAY PIN — ticket 3ed139cd-0d26-4134-90b9-4f168fbc9fad (bug_report,
 * 2026-09-13): "Supervisor phantom rename receipts: 5 cited goal ids + todo
 * 078bbac3 unresolvable — fabricated-evidence class (ticket 7ee38c8e Defect 2)".
 *
 * THE INCIDENT: the Fleet Supervisor's 11:57 AM EDT owner reply (chat
 * c0e22e36, 2026-09-13) claimed "I renamed all five into plain language today:
 * 4dc6b1d1 → Kernel Optimization Campaign, 48c93a9e → W4A16 Recipes A/B
 * Re-Validation (R3), 8ec1f4cd → W4A16 v3 Speed Optimization (S4/S4.5),
 * 8e489f12 → Digby vLLM Release, 81c9bc8e → GLM-5.3 W4A16 v4 Grant Proposal"
 * plus "todo 078bbac3 (unblocked)" and "The Pulse now shows 5 goals."
 * Adjudication probes (engineering lane 62ee7f6d, ~17:15Z; re-probed by the
 * dispatch lane 581ae3b5, ~18:40Z — identical results):
 *   · goal_get(4dc6b1d1 / 48c93a9e / 8e489f12) → "Goal not found"
 *   · todo_get(078bbac3) → "Todo not found"
 *   · account-wide goal_list (37→38 rows) → ZERO rows match any cited id,
 *     ZERO rows carry any claimed title;
 *   · control goal_get(a2e54c5c) → RESOLVES (by-id resolution is not broken —
 *     the cited ids simply never existed).
 * The phantom ids then FOSSILIZED: 8ec1f4cd was re-cited in the 16:14Z note's
 * receipts line, hours after the original fabrication.
 *
 * ROOT CAUSE: machine-wake.ts rule 6 TEACHES 'goal'/'todo' as citation labels
 * ("label each cited id with the tool-family it came from"), but the action
 * verifier's deterministic citation lanes existence-checked only msg / sched /
 * session-chat refs — a labeled-but-invented goal or todo id had NO audit lane
 * and sailed through undetected.
 *
 * THE FIX: a fourth deterministic citation lane (action-verifier.ts):
 * mineGoalTodoCitations + findPhantomGoalTodoCitations, existence-checked
 * against project_goals / project_todos (kind-routed), with the msg/sched
 * lanes' exact discipline: line floor, blockquote skip, honesty/refutation
 * exclusion (PLUS the lane-local resolve register — the supervisor's own
 * retractions say "don't resolve" / "did NOT happen" / "unresolvable", and an
 * honest retraction quoting the phantom ids must NEVER re-convict), tool-
 * output exoneration, parallel fail-toward-miss probes, same-prefix near-miss
 * hints. These tests pin the incident verbatim AND the false-strike guards.
 *
 * Mock discipline mirrors action-verifier.d78f477b.test.ts: config/database and
 * every transitively-heavy boundary is mocked at the top, above imports.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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
  mineGoalTodoCitations,
  findPhantomGoalTodoCitations,
  citedGoalRowExists,
  citedTodoRowExists,
  samePrefixRealIds,
  computePhantomClaims,
  claimDetailLines,
  allCitationClassClaims,
} from './action-verifier';

// The incident's verbatim phantom ids (ticket 3ed139cd).
const PHANTOM_GOALS = ['4dc6b1d1', '48c93a9e', '8ec1f4cd', '8e489f12', '81c9bc8e'];
const PHANTOM_TODO = '078bbac3';
// The adjudication's control id — a REAL spark-cluster goal that resolves fine.
const CONTROL_GOAL = 'a2e54c5c';

/**
 * The fossilized re-citation shape: the supervisor's own receipts-line idiom
 * carrying the phantom ids in the TAUGHT labeled form (its 16:14Z note re-cited
 * 8ec1f4cd exactly this way). This — not the unlabeled arrow-list of the
 * original 11:57 AM claim, which carries no taught label and escapes BY DESIGN
 * (under-broad is the fail-safe direction) — is what the lane convicts.
 */
const FOSSIL_NOTE = [
  'Receipts: goal 4dc6b1d1 → renamed to Kernel Optimization Campaign, goal 48c93a9e → renamed to W4A16 Recipes A/B Re-Validation (R3),',
  'goal 8ec1f4cd → renamed to W4A16 v3 Speed Optimization (S4/S4.5), goal 8e489f12 → renamed to Digby vLLM Release,',
  'goal 81c9bc8e → renamed to GLM-5.3 W4A16 v4 Grant Proposal; todo 078bbac3 (unblocked, board read-back). The Pulse now shows 5 goals.',
].join('\n');

const idsOf = (claims: Array<{ id?: string }>) => claims.map((c) => String(c.id)).sort();

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectGoal.findFirst.mockResolvedValue(null);
  mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findFirst.mockResolvedValue(null);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockGetRecentChatReceipts.mockResolvedValue([]);
});

describe('mineGoalTodoCitations — the taught citation idioms (machine-wake.ts rule 6)', () => {
  it('mines the fossilized phantom re-citations in labeled form, kinds preserved', () => {
    const claims = mineGoalTodoCitations(FOSSIL_NOTE);
    expect(idsOf(claims)).toEqual([...PHANTOM_GOALS, PHANTOM_TODO].sort());
    expect(claims.filter((c) => c.kind === 'goal')).toHaveLength(5);
    expect(claims.filter((c) => c.kind === 'todo')).toHaveLength(1);
    expect(claims.every((c) => c.detail.startsWith('[evidence citation]'))).toBe(true);
  });

  it('mines the singular, plural, backticked, bracketed, and post-id label forms', () => {
    const note = [
      'goal e1f27829 done this wake, verified against the board.',
      'goals 97922708/3da1b307 reviewed — every id of the slash list mines (tick 21, 2026-09-15).',
      'todo `b67d316d` closed with the digest as evidence.',
      '[goal:3f87efe1] confirmed active in this pull.',
      'The item `8ec1f4cd` (goal) was re-validated against the store.',
      'The item `078bbac3` (todo) was re-validated against the store.',
    ].join('\n');
    const claims = mineGoalTodoCitations(note);
    expect(idsOf(claims)).toEqual(['078bbac3', '3da1b307', '3f87efe1', '8ec1f4cd', '97922708', 'b67d316d', 'e1f27829']);
    // Tick 21 (2026-09-15): the plural slash tail mines too — the first-id-only
    // under-breadth let the Fleet Supervisor's id lists deliver invented ids.
    expect(idsOf(claims)).toContain('3da1b307');
  });

  it('never mines the tool names goal_get/goal_list/todo_get/todo_list (underscore is a word char — no boundary)', () => {
    const note = 'goal_get(4dc6b1d1) returned the row, goal_list refreshed at 16:00Z, todo_get(078bbac3) failed, todo_list(goalId) was empty.';
    expect(mineGoalTodoCitations(note)).toEqual([]);
  });

  it('skips blockquoted lines (audit quotes of struck notes)', () => {
    const note = '> goal 4dc6b1d1 was cited in the struck note below the fold.';
    expect(mineGoalTodoCitations(note)).toEqual([]);
  });

  it('skips sub-floor lines (<20 chars)', () => {
    expect(mineGoalTodoCitations('goal 4dc6b1d1 ok')).toEqual([]);
  });

  it('the shared honesty register skips refutation prose (does not exist / phantom / fabricated)', () => {
    const note = [
      'The cited goal 4dc6b1d1 does not exist — verified twice against the store.',
      'goal 48c93a9e was a phantom citation in my earlier note, now retracted.',
      'todo 078bbac3 was fabricated and should never have been cited here.',
    ].join('\n');
    expect(mineGoalTodoCitations(note)).toEqual([]);
  });

  it("the lane-local resolve register skips the retraction's canonical wording (the 3ed139cd retractions verbatim)", () => {
    const note = [
      // 17:05Z retraction: "cited five goal-rename receipts that don't resolve".
      "Correction: my 11:57 AM note cited goal-rename receipts that don't resolve — goal 4dc6b1d1 included — I retract that claim outright.",
      // 16:59Z retraction: "the five goal renames I reported yesterday did NOT happen".
      'The five goal renames I reported yesterday did NOT happen — goal 48c93a9e was among the cited ids.',
      // The ticket's own word.
      'todo 078bbac3 is unresolvable per repeated fresh probes this wake.',
      'goal 8e489f12 did not resolve in any of my three checks just now.',
      'goal 81c9bc8e could not resolve against the board read-back.',
    ].join('\n');
    expect(mineGoalTodoCitations(note)).toEqual([]);
  });

  it('the same hex cited under BOTH labels is mined twice — checked against BOTH stores', () => {
    const note = 'goal 3f87efe1 was checked first, and later todo 3f87efe1 was checked against its own store too.';
    const claims = mineGoalTodoCitations(note);
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.kind).sort()).toEqual(['goal', 'todo']);
  });
});

describe('findPhantomGoalTodoCitations — conviction and exoneration tiers', () => {
  // Injected probe: only the control id exists, and only as a GOAL.
  const realRows = new Set([`goal|${CONTROL_GOAL}`]);
  const check = jest.fn(async (kind: 'goal' | 'todo', id: string) => realRows.has(`${kind}|${id}`));
  const noHints = jest.fn(async () => [] as string[]);

  beforeEach(() => check.mockClear());

  it('THE INCIDENT REPLAY: all six phantom ids convict; the control goal id exonerates', async () => {
    const note = `${FOSSIL_NOTE}\nControl line: goal ${CONTROL_GOAL} (spark-cluster campaign) remains active per this pull.`;
    const convicted = await findPhantomGoalTodoCitations(note, [], check, noHints);
    expect(idsOf(convicted)).toEqual([...PHANTOM_GOALS, PHANTOM_TODO].sort());
    expect(idsOf(convicted)).not.toContain(CONTROL_GOAL);
  });

  it('kind routing: goal-labeled ids probe project_goals, todo-labeled ids probe project_todos', async () => {
    await findPhantomGoalTodoCitations(FOSSIL_NOTE, [], check, noHints);
    const calls = check.mock.calls.map(([kind, id]) => `${kind}|${id}`);
    for (const id of PHANTOM_GOALS) expect(calls).toContain(`goal|${id}`);
    expect(calls).toContain(`todo|${PHANTOM_TODO}`);
    expect(calls.filter((c) => c.startsWith('todo|'))).toHaveLength(1);
  });

  it('a MISLABELED citation convicts (rule-5 doctrine: a real todo id cited as goal is struck like a deploy id cited as msg)', async () => {
    const todoOnly = jest.fn(async (kind: 'goal' | 'todo', id: string) => kind === 'todo' && id === '3f87efe1');
    const note = 'goal 3f87efe1 done this wake — closed out against the board read-back.';
    const convicted = await findPhantomGoalTodoCitations(note, [], todoOnly, noHints);
    expect(idsOf(convicted)).toEqual(['3f87efe1']);
    expect(convicted[0].kind).toBe('goal');
  });

  it('tool-OUTPUT exoneration: an id visible verbatim in this run\'s tool results never reaches a probe', async () => {
    const haystacks = ['goal_list result: ... 4dc6b1d1 "Kernel Optimization Campaign" ... 48c93a9e ...'];
    const note = 'goal 4dc6b1d1 done · goal 48c93a9e active · goal 8ec1f4cd done — all three from this pull.';
    const convicted = await findPhantomGoalTodoCitations(note, [], check, noHints, haystacks);
    expect(idsOf(convicted)).toEqual(['8ec1f4cd']);
    const probed = check.mock.calls.map(([, id]) => id);
    expect(probed).not.toContain('4dc6b1d1');
    expect(probed).not.toContain('48c93a9e');
  });

  it('ids already carried by an action claim are dropped (the tier chain judged them — no double-processing)', async () => {
    const note = 'goal 4dc6b1d1 renamed this wake and goal 48c93a9e renamed too — both mine.';
    const convicted = await findPhantomGoalTodoCitations(
      note,
      [{ kind: 'ticket', detail: 'renamed the first board row', id: '4DC6B1D1' }],
      check,
      noHints,
    );
    expect(idsOf(convicted)).toEqual(['48c93a9e']);
  });

  it('DB-error probes fail toward MISS — an unverifiable citation is never a conviction', async () => {
    const rejecting = jest.fn(async () => { throw new Error('db down'); });
    const convicted = await findPhantomGoalTodoCitations(FOSSIL_NOTE, [], rejecting, noHints);
    expect(convicted).toEqual([]);
  });

  it('convictions carry same-prefix near-miss hints, routed by kind', async () => {
    const hints = jest.fn(async (kind: 'goal' | 'todo', id: string) =>
      kind === 'goal' && id === '4dc6b1d1' ? ['4dc6b1d1-aaaa-bbbb-cccc-dddddddddddd (goal "Real Kernel Campaign", 2026-09-13T00:00:00.000Z)'] : []);
    const convicted = await findPhantomGoalTodoCitations(FOSSIL_NOTE, [], check, hints);
    const withHint = convicted.find((c) => c.id === '4dc6b1d1');
    expect(withHint?.nearMiss?.[0]).toContain('Real Kernel Campaign');
    expect(convicted.find((c) => c.id === PHANTOM_TODO)?.nearMiss).toBeUndefined();
  });
});

describe('citedGoalRowExists / citedTodoRowExists — the real probes (prefix-match, fail-toward-miss)', () => {
  it('8-char prefix probes with startsWith; a found row exonerates', async () => {
    mockPrisma.projectGoal.findFirst.mockResolvedValueOnce({ id: '4dc6b1d1-full' });
    await expect(citedGoalRowExists('4dc6b1d1')).resolves.toBe(true);
    expect(mockPrisma.projectGoal.findFirst).toHaveBeenCalledWith({ where: { id: { startsWith: '4dc6b1d1' } }, select: { id: true } });
  });

  it('a full uuid probes by exact id; no row convicts', async () => {
    const full = '4dc6b1d1-0d26-4134-90b9-4f168fbc9fad';
    await expect(citedGoalRowExists(full)).resolves.toBe(false);
    expect(mockPrisma.projectGoal.findFirst).toHaveBeenCalledWith({ where: { id: full }, select: { id: true } });
  });

  it('todo probes hit project_todos with the same contract', async () => {
    mockPrisma.projectTodo.findFirst.mockResolvedValueOnce({ id: '078bbac3-full' });
    await expect(citedTodoRowExists('078bbac3')).resolves.toBe(true);
    expect(mockPrisma.projectTodo.findFirst).toHaveBeenCalledWith({ where: { id: { startsWith: '078bbac3' } }, select: { id: true } });
  });

  it('a DB error returns TRUE (fail toward MISS)', async () => {
    mockPrisma.projectGoal.findFirst.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.projectTodo.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(citedGoalRowExists('4dc6b1d1')).resolves.toBe(true);
    await expect(citedTodoRowExists('078bbac3')).resolves.toBe(true);
  });
});

describe('samePrefixRealIds — goal/todo near-miss buckets (same-tenant scoped)', () => {
  it('goal bucket: prefix query scoped to the auditing owner, titles rendered', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([
      { id: '4dc6b1d1-aaaa-bbbb-cccc-dddddddddddd', title: 'Real Kernel Campaign', updatedAt: new Date('2026-09-13T00:00:00.000Z') },
    ]);
    const out = await samePrefixRealIds('goal', '4dc6b1d1-dead-beef', 'user-1');
    expect(mockPrisma.projectGoal.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '4dc6b1d1' }, userId: 'user-1' },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });
    expect(out[0]).toContain('Real Kernel Campaign');
  });

  it('todo bucket: same contract against project_todos; omitted userId keeps the legacy global bucket', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([
      { id: '078bbac3-aaaa-bbbb-cccc-dddddddddddd', title: 'Unblock R3', updatedAt: new Date('2026-09-13T00:00:00.000Z') },
    ]);
    const out = await samePrefixRealIds('todo', '078bbac3-dead-beef');
    expect(mockPrisma.projectTodo.findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: '078bbac3' } },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });
    expect(out[0]).toContain('Unblock R3');
  });

  it('sub-8-char citations have no meaningful prefix bucket; DB errors yield [] (fail-open hints)', async () => {
    await expect(samePrefixRealIds('goal', '4dc6')).resolves.toEqual([]);
    mockPrisma.projectGoal.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(samePrefixRealIds('goal', '4dc6b1d1-dead-beef')).resolves.toEqual([]);
  });
});

describe('computePhantomClaims end-to-end — the lane reaches both audit paths', () => {
  const input = (finalText: string, extraEvidenceHaystacks: string[] = []) => ({
    chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37',
    userId: 'owner-1',
    finalText,
    parts: [] as any[],
    extraEvidenceHaystacks,
  });

  it('the fossilized phantom citations convict in the main path as CITATION-class claims (the right correction framing)', async () => {
    const out = await computePhantomClaims(input(FOSSIL_NOTE));
    expect(idsOf(out.phantoms)).toEqual([...PHANTOM_GOALS, PHANTOM_TODO].sort());
    expect(allCitationClassClaims(out.phantoms)).toBe(true);
    const lines = claimDetailLines(out.phantoms);
    expect(lines).toContain('[goal]');
    expect(lines).toContain('[todo]');
    expect(lines).toContain('cited id 4dc6b1d1');
    expect(lines).toContain('cited id 078bbac3');
  });

  it('a sub-floor note is still audited (the deterministic lanes cost zero LLM calls)', async () => {
    const out = await computePhantomClaims(input('goal 4dc6b1d1 renamed'));
    expect(idsOf(out.phantoms)).toEqual(['4dc6b1d1']);
  });

  it('honest board citations exonerate end-to-end: rows that exist + ids visible in this run\'s haystacks', async () => {
    mockPrisma.projectGoal.findFirst.mockResolvedValue({ id: 'a2e54c5c-full' });
    const note = `goal ${CONTROL_GOAL} (spark-cluster campaign) active per goal_get this wake; goal 4dc6b1d1 carried from the pull below.`;
    const out = await computePhantomClaims(input(note, ['goal_list: 4dc6b1d1 "Kernel Optimization Campaign"']));
    expect(out.phantoms).toEqual([]);
  });

  it('the 17:05Z-shaped honest RETRACTION quoting the phantom ids convicts NOTHING (the resolve register)', async () => {
    const note = [
      'Correction (standing, from the earlier audit): my 11:57 AM note cited five goal-rename receipts that don\'t resolve —',
      'goal 4dc6b1d1, goal 48c93a9e, goal 8ec1f4cd, goal 8e489f12, goal 81c9bc8e — and todo 078bbac3 did not happen either.',
      'I retract that claim outright rather than clarify it; the owner-visible record stands corrected this wake.',
    ].join('\n');
    const out = await computePhantomClaims(input(note));
    expect(out.phantoms).toEqual([]);
  });
});
