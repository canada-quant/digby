/**
 * compute-policy-label-hooks.ts (cp/labels, 2026-09-26): the two DB-backed
 * label hooks — reask_5m (the harness, before the new user row) and thumbs
 * (POST /feedback) — against a mocked prisma, with the REAL adapters + Module
 * A writer underneath and recordDecisionOutcome captured, so every row's
 * purpose / question / label / source is the one prod would write.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', COMPUTE_POLICY: 'compute_policy', UX_TTFT: 'ux_ttft' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('../platform/supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/decision-gate'),
  recordDecisionOutcome: (...a: any[]) => mockRecord(...a),
}));
const mockFindMany: jest.Mock = jest.fn(async () => []);
const mockFindUnique: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { crossModelMessage: { findMany: (...a: any[]) => mockFindMany(...a), findUnique: (...a: any[]) => mockFindUnique(...a) } },
}));

import { isHarnessRow, labelReaskForChat, labelThumbsForMessage, reaskVerdict, sameHumanAuthor } from './compute-policy-label-hooks';
import { REASK_LABEL_WINDOW_MS } from './compute-policy-labels';

const depthAnswers = { depth: { type: 'choice', choice: 'simple_lookup', confidence: 0.9, probabilities: { simple_lookup: 0.9 } }, research_request: { type: 'noul', noul: 0.1 } };
const decision = { id: 'cp-prev', answers: depthAnswers, mode: 'shadow' };
const facts = { leadToolCalls: 0, webToolCalls: 0, finalChars: 250, checkerSpawned: false, checkerMerged: false };
const SENT = new Date('2026-09-26T12:00:00Z');
const assistantRow = (ageMs: number, metadata: any = { depth: { decision, facts } }) => ({ role: 'assistant', createdAt: new Date(SENT.getTime() - ageMs), metadata });
const userRow = (metadata: any = { authorId: 'u1' }) => ({ role: 'user', createdAt: new Date(SENT.getTime() - 120_000), metadata });
// Harness rows that can sit between the answer and the re-ask (audit h4-reask-5m): the late-check addendum
// (late-crosscheck.ts — kind check_addendum, NO depth), the deploy shutdown note (chat-agent.service.ts —
// origin shutdown_requeue), the status cards (session_status / project_status).
const addendumRow = (ageMs: number) => assistantRow(ageMs, { kind: 'check_addendum', addendumFor: 'm-prev', engine: 'agent', mode: 'thinking', check: { state: 'updated', changed: ['number: 3'] } });
const shutdownRow = (ageMs: number) => assistantRow(ageMs, { origin: 'shutdown_requeue', requeuedAt: 'x' });
const statusRow = (ageMs: number, origin: 'session_status' | 'project_status') => assistantRow(ageMs, { origin, kind: origin });
const LABELLED = { label: true, ageMs: 60_000, index: 0, afterAddendum: false };

beforeEach(() => { mockRecord.mockReset(); mockFindMany.mockReset(); mockFindUnique.mockReset(); });

describe('reaskVerdict / sameHumanAuthor (pure)', () => {
  it('labels only: last row assistant + ≤ 5 min + a decision + the same human (or unstamped) user row before it', () => {
    expect(reaskVerdict([assistantRow(60_000), userRow()], SENT, 'u1')).toEqual(LABELLED);
    expect(reaskVerdict([assistantRow(REASK_LABEL_WINDOW_MS), userRow()], SENT, 'u1')).toEqual({ ...LABELLED, ageMs: REASK_LABEL_WINDOW_MS });
    expect(reaskVerdict([assistantRow(REASK_LABEL_WINDOW_MS + 1), userRow()], SENT, 'u1')).toEqual({ label: false, reason: 'outside_window' });
    expect(reaskVerdict([], SENT, 'u1')).toEqual({ label: false, reason: 'no_prior_rows' });
    expect(reaskVerdict([userRow(), assistantRow(60_000)], SENT, 'u1')).toEqual({ label: false, reason: 'last_row_not_assistant' }); // the previous send is still running
    expect(reaskVerdict([assistantRow(60_000, { depth: { plan: {} } })], SENT, 'u1')).toEqual({ label: false, reason: 'no_decision' });
    expect(reaskVerdict([assistantRow(60_000, { kind: 'deeper_findings', depth: { decision } })], SENT, 'u1')).toEqual({ label: false, reason: 'deeper_findings_row' });
    expect(reaskVerdict([assistantRow(60_000), userRow({ authorId: 'other' })], SENT, 'u1')).toEqual({ label: false, reason: 'different_author' });
    expect(reaskVerdict([assistantRow(60_000), userRow({ origin: 'schedule' })], SENT, 'u1')).toEqual({ label: false, reason: 'different_author' }); // a machine wake's answer
    expect(reaskVerdict([assistantRow(-1000), userRow()], SENT, 'u1')).toEqual({ label: false, reason: 'bad_clock' });
    expect(reaskVerdict([assistantRow(60_000)], SENT, 'u1')).toEqual(LABELLED); // no user row in the window at all — the owner's chat
    expect(sameHumanAuthor(userRow({}), 'u1')).toBe(true); // pre-attribution rows belong to the owner
    expect(sameHumanAuthor(userRow({ authorId: 'u1' }), undefined)).toBe(true);
    expect(sameHumanAuthor(null, 'u1')).toBe(true);
  });
  it('steps over HARNESS rows between the answer and the re-ask (addendum / shutdown note / status card) and labels the ANSWER — window measured from the answer, index points at it, afterAddendum only for an addendum', () => {
    // a late-check addendum posted 30 s ago, the answer 2 min ago: the answer's decision is the one labelled
    expect(reaskVerdict([addendumRow(30_000), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: true, ageMs: 120_000, index: 1, afterAddendum: true });
    // the deploy shutdown note ⇒ same, without the addendum stamp
    expect(reaskVerdict([shutdownRow(30_000), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: true, ageMs: 120_000, index: 1, afterAddendum: false });
    expect(reaskVerdict([statusRow(30_000, 'session_status'), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: true, ageMs: 120_000, index: 1, afterAddendum: false });
    expect(reaskVerdict([statusRow(30_000, 'project_status'), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: true, ageMs: 120_000, index: 1, afterAddendum: false });
    // two harness rows in the way still fit the read (take 4: answer + user row + two harness rows)
    expect(reaskVerdict([addendumRow(20_000), shutdownRow(40_000), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: true, ageMs: 120_000, index: 2, afterAddendum: true });
    // the same-human check reads the user row BEFORE the answer, not the row before the harness row
    expect(reaskVerdict([addendumRow(30_000), assistantRow(120_000), userRow({ authorId: 'other' })], SENT, 'u1')).toEqual({ label: false, reason: 'different_author' });
    // the window is the ANSWER's age: an addendum 1 min ago on an answer 6 min ago labels nothing
    expect(reaskVerdict([addendumRow(60_000), assistantRow(REASK_LABEL_WINDOW_MS + 1), userRow()], SENT, 'u1')).toEqual({ label: false, reason: 'outside_window' });
    // only harness rows ⇒ nothing to label
    expect(reaskVerdict([addendumRow(30_000)], SENT, 'u1')).toEqual({ label: false, reason: 'only_harness_rows' });
    // a harness row over a still-running send (user row next) ⇒ as before, no label
    expect(reaskVerdict([shutdownRow(30_000), userRow(), assistantRow(120_000)], SENT, 'u1')).toEqual({ label: false, reason: 'last_row_not_assistant' });
  });
  it('never skips ahead past a NON-harness assistant row without a decision (a pre-cp / guest / failed-finalize answer must not hand its re-ask to the older turn)', () => {
    expect(reaskVerdict([assistantRow(30_000, { engine: 'agent', mode: 'thinking' }), userRow(), assistantRow(120_000)], SENT, 'u1')).toEqual({ label: false, reason: 'no_decision' });
    expect(reaskVerdict([assistantRow(30_000, { depth: { plan: {} } }), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: false, reason: 'no_decision' });
    // a Deeper-findings row is not a harness row either — it is the council's own answer
    expect(reaskVerdict([assistantRow(30_000, { kind: 'deeper_findings', depth: { decision } }), assistantRow(120_000), userRow()], SENT, 'u1')).toEqual({ label: false, reason: 'deeper_findings_row' });
    expect(isHarnessRow(assistantRow(30_000))).toBe(false);
    expect(isHarnessRow(assistantRow(30_000, { engine: 'agent' }))).toBe(false);
    expect(isHarnessRow({ role: 'user', createdAt: SENT, metadata: { origin: 'shutdown_requeue' } })).toBe(false); // role-gated
    expect(isHarnessRow(addendumRow(1))).toBe(true);
    expect(isHarnessRow(shutdownRow(1))).toBe(true);
  });
});

describe('labelReaskForChat', () => {
  it('reads the four rows before sentAt (newest first) and writes the PREVIOUS answer\'s reask_5m row (label reask_5m, source reask, the persisted facts)', async () => {
    mockFindMany.mockResolvedValue([assistantRow(90_000), userRow()]);
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT, sessionId: 'chat-1' })).resolves.toBe('labelled');
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ where: { chatId: 'chat-1', createdAt: { lt: SENT } }, orderBy: { createdAt: 'desc' }, take: 4 });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [d, purpose, outcome] = mockRecord.mock.calls[0];
    expect(d).toMatchObject({ id: 'cp-prev', purpose: 'compute_policy' });
    expect(purpose).toBe('compute_policy');
    expect(outcome).toMatchObject({ question: 'depth', actual: 'ordinary', label: 'reask_5m', sessionId: 'chat-1', extra: { source: 'reask', finalChars: 250, checkerSpawned: false } });
    expect(outcome.extra).not.toHaveProperty('afterAddendum');
  });
  it('an addendum between the answer and the re-ask ⇒ the ANSWER\'s decision is labelled once, stamped extra.afterAddendum:true (+ the note)', async () => {
    mockFindMany.mockResolvedValue([addendumRow(30_000), assistantRow(120_000), userRow()]);
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT, sessionId: 'chat-1' })).resolves.toBe('labelled');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [d, , outcome] = mockRecord.mock.calls[0];
    expect(d).toMatchObject({ id: 'cp-prev' });
    expect(outcome).toMatchObject({ label: 'reask_5m', actual: 'ordinary', extra: { source: 'reask', afterAddendum: true, finalChars: 250 } });
    expect(String(outcome.note)).toContain('after addendum');
  });
  it('a deploy shutdown note between the answer and the re-ask ⇒ the answer\'s decision is labelled once, no afterAddendum stamp', async () => {
    mockFindMany.mockResolvedValue([shutdownRow(30_000), assistantRow(120_000), userRow()]);
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT })).resolves.toBe('labelled');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: 'cp-prev' });
    expect(mockRecord.mock.calls[0][2].extra).not.toHaveProperty('afterAddendum');
  });
  it('a non-harness assistant row WITHOUT a decision on top ⇒ no_decision, nothing written (no skip-ahead to the older turn)', async () => {
    mockFindMany.mockResolvedValue([assistantRow(30_000, { engine: 'agent', mode: 'thinking' }), userRow(), assistantRow(120_000), userRow()]);
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT })).resolves.toBe('no_decision');
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it('outside the window / no decision / a running previous send ⇒ nothing; a prisma failure ⇒ "error", never a throw', async () => {
    mockFindMany.mockResolvedValue([assistantRow(10 * 60_000), userRow()]);
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT })).resolves.toBe('outside_window');
    mockFindMany.mockResolvedValue([userRow(), assistantRow(60_000)]);
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT })).resolves.toBe('last_row_not_assistant');
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(labelReaskForChat({ chatId: 'chat-1', authorId: 'u1', sentAt: SENT })).resolves.toBe('error');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('labelThumbsForMessage', () => {
  const revisionDecision = { id: 'rm-1', purpose: 'revision_material', mode: 'shadow', backend: 'jev', answers: { material: { type: 'noul', noul: 0.25 } }, decidedAt: 'x' };
  it('thumbs_down + reason on an assistant row with a decision ⇒ the compute_policy thumbs row; an UPDATED pill with a persisted gate decision ⇒ the revision_material row too', async () => {
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'assistant', metadata: { depth: { decision, facts }, check: { state: 'updated', changed: ['number: 3'], verdict: { material: true, source: 'gate', decisionId: 'rm-1', decision: revisionDecision } } } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_down', reason: 'wrong' })).resolves.toBe('labelled:compute_policy+revision_material');
    expect(mockFindUnique.mock.calls[0][0]).toMatchObject({ where: { id: 'm1' } });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][1]).toBe('compute_policy');
    // checkerMerged is upgraded by the completed check ('updated') ⇒ the base is ordinary-class; a thumbs-down "wrong" bumps to contestable? no checker ran ⇒ ordinary
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'depth', actual: 'ordinary', label: 'thumbs', sessionId: 'chat-1', extra: { source: 'feedback', checkerMerged: true } });
    expect(String(mockRecord.mock.calls[0][2].note)).toContain('thumbs:down/wrong');
    expect(mockRecord.mock.calls[1][1]).toBe('revision_material');
    expect(mockRecord.mock.calls[1][0]).toMatchObject({ id: 'rm-1', purpose: 'revision_material' });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'material', actual: true, sessionId: 'chat-1', extra: { thumbsDown: true } });
  });
  it('thumbs_up on an updated row ⇒ compute_policy (base depth) + revision_material false; a "checked" pill whose GATE withheld the rewrite ⇒ revision_material with acted:true (audit 2026-09-26)', async () => {
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'assistant', metadata: { depth: { decision, facts }, check: { state: 'updated', verdict: { material: true, source: 'gate', decision: revisionDecision } } } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_up' })).resolves.toBe('labelled:compute_policy+revision_material');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'simple_lookup', label: 'thumbs' });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'material', actual: false, acted: false });
    mockRecord.mockReset();
    // In act a confident wording-only verdict withholds the rewrite ('checked') — exactly the in-band decisions; the user judged the
    // UNREVISED text, so a thumbs-down = the withheld rewrite may have mattered (material true, acted:true → the act-band window sees it).
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'assistant', metadata: { depth: { decision, facts }, check: { state: 'checked', verdict: { material: false, source: 'gate', decision: revisionDecision } } } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_down', reason: 'slow' })).resolves.toBe('labelled:compute_policy+revision_material');
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'simple_lookup', label: 'thumbs' }); // "slow" never bumps
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'material', actual: true, acted: true, extra: { thumbsDown: true } });
    expect(String(mockRecord.mock.calls[1][2].note)).toContain('pill:checked (rewrite withheld)');
  });
  it('drafts_agree (2026-09-26): thumbs on a "Checked ✓" row whose drafts_agree decision ACTED (metadata.check.draftsAgree) writes the acted:true drafts_agree row — thumbs_down ⇒ actual false, thumbs_up ⇒ actual true; a shadow (non-acted) row writes none', async () => {
    const draftsAgree = { decisionId: 'da-act', p: 0.92, mode: 'act', acted: true, decision: { id: 'da-act', purpose: 'drafts_agree', mode: 'act', backend: 'TypeSafe Jev', answers: { agree: { type: 'noul', noul: 0.92 } }, decidedAt: 'x', calibrated: true } };
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'assistant', metadata: { depth: { decision, facts }, check: { state: 'checked', draftsAgree } } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_down', reason: 'wrong' })).resolves.toBe('labelled:compute_policy+drafts_agree');
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[1][1]).toBe('drafts_agree');
    expect(mockRecord.mock.calls[1][0]).toMatchObject({ id: 'da-act', purpose: 'drafts_agree', mode: 'act' });
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'agree', actual: false, acted: true, sessionId: 'chat-1', label: 'thumbs_down', extra: { source: 'feedback', material: true } });
    mockRecord.mockReset();
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_up' })).resolves.toBe('labelled:compute_policy+drafts_agree');
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'agree', actual: true, acted: true, label: 'thumbs_up' });
    mockRecord.mockReset();
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'assistant', metadata: { depth: { decision, facts }, check: { state: 'checked', draftsAgree: { ...draftsAgree, acted: false } } } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_down' })).resolves.toBe('labelled:compute_policy');
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
  it('refusals: report type, no messageId, a row in another chat, a user row, no decision, a prisma failure', async () => {
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'report' })).resolves.toBe('not_thumbs');
    await expect(labelThumbsForMessage({ messageId: null, chatId: 'chat-1', type: 'thumbs_up' })).resolves.toBe('no_message');
    mockFindUnique.mockResolvedValue({ chatId: 'other', role: 'assistant', metadata: { depth: { decision } } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_up' })).resolves.toBe('not_found');
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'user', metadata: {} });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_up' })).resolves.toBe('not_assistant');
    mockFindUnique.mockResolvedValue({ chatId: 'chat-1', role: 'assistant', metadata: { mode: 'thinking' } });
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_down' })).resolves.toBe('no_decision');
    mockFindUnique.mockRejectedValue(new Error('db down'));
    await expect(labelThumbsForMessage({ messageId: 'm1', chatId: 'chat-1', type: 'thumbs_down' })).resolves.toBe('error');
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
