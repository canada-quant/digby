/**
 * Owner authority (2026-10-20) — the owner-questions half of three fixes.
 *
 * OWNER-PROVENANCE-STRICT: every flagged-question answer reached the
 * supervisor ledger as "Owner ANSWERED" (the default path and the supervisor
 * triage answer never passed answeredBy), a cross-chat duplicate was stamped
 * answeredBy:'owner' whoever answered the source, and a replayed default
 * through the in-chat card path was narrated as the owner. Pins: answeredBy
 * rides to the ledger (supervisor / default), duplicates inherit it with an
 * actor-true note, the card path keeps a replay's provenance, the kill switch
 * OWNER_PROVENANCE_STRICT_DISABLED=1 restores 'owner'.
 *
 * OWNER-DIRECTIVE-FANOUT (ledger half): the banked answer / ruling is
 * MIRRORED onto the ASKING project's supervisor ledger (mirror:true, the
 * project scope); never when the asking chat has no project / no project
 * supervisor; a NON-standing ruling is never mirrored (review fix — the
 * Fleet Supervisor's project-scoped row already reaches the project through
 * the fan-out block, and a mirror was a second open row the directive-age
 * alarm chased on both ledgers); OWNER_DIRECTIVE_FANOUT_DISABLED=1 writes the
 * Fleet Supervisor's row only.
 *
 * OWNER-DISMISS-RAILS: checkSupervisorDismissRails refuses an owner-only class
 * card, an owner-engaged card, and (project seat) another project's card,
 * recording owner_question_dismiss_refused; a supervisor's dismissal of an
 * owner-only class card does not arm the 24 h cooldown, while its dismissal
 * of a TRIAGED (supervisor-route) card DOES (review fix — exempting those let
 * a lane re-file a moot question every firing), and the lane's wake claims
 * the cooldown only when it was armed; a project supervisor's dismissal is
 * narrated as the PROJECT supervisor's.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const chats: Record<string, any> = {
  'lane-a': { id: 'lane-a', projectId: 'p-apollo', project: { name: 'Apollo' } },
  'lane-b': { id: 'lane-b', projectId: 'p-apollo', project: { name: 'Apollo' } },
  'lane-z': { id: 'lane-z', projectId: 'p-zeus', project: { name: 'Zeus' } },
  'loose': { id: 'loose', projectId: null, project: null },
};
const mockChatFindFirst: jest.Mock = jest.fn(async ({ where }: any = {}) => {
  if (where?.isSupervisor) return { id: 'fleet-sup' };
  if (where?.isProjectSupervisor && where?.projectId === 'p-apollo') return { id: 'apollo-sup' };
  return null;
});
const mockChatFindUnique: jest.Mock = jest.fn(async ({ where }: any = {}) => chats[where?.id] ?? null);
const mockChatFindMany: jest.Mock = jest.fn(async ({ where }: any = {}) => Object.values(chats).filter((c: any) =>
  (where?.id?.in ? where.id.in.includes(c.id) : true) && (where?.projectId ? c.projectId === where.projectId : true)));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    crossModelProject: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    telegramLink: { findUnique: jest.fn(async () => null) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
jest.mock('../telegram/telegram.service', () => ({ __esModule: true, isConfigured: () => false, sendMessage: jest.fn(async () => {}) }));
const mockUnblock: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({ __esModule: true, unblockOwnerGatedItems: (...a: any[]) => mockUnblock(...a) }));

// classifyOwnerRuling stub: 'ever' / 'always' read as a STANDING ruling; 'must' as a
// one-off (non-standing) ruling.
const RULING_RE = /\b(ever|always|must)\b/i;
const STANDING_RE = /\b(ever|always)\b/i;
const mockAppendAnswered: jest.Mock = jest.fn(async () => {});
const mockAppendRuling: jest.Mock = jest.fn(async () => 'appended');
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
  appendOwnerRulingDirective: (...a: any[]) => mockAppendRuling(...a),
  ownerRulingCaptureDisabled: () => false,
  classifyOwnerRuling: (t: string) => ({ ruling: RULING_RE.test(t), standing: STANDING_RE.test(t) }),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  answerOwnerQuestion,
  applyDefaultAnswerIfDue,
  checkSupervisorDismissRails,
  dismissOwnerQuestion,
  flagOwnerQuestion,
  resolveOwnerQuestionsForChatAnswer,
  supervisorDismissalArmsCooldown,
} from './owner-questions';

const ENV = ['OWNER_PROVENANCE_STRICT_DISABLED', 'OWNER_DIRECTIVE_FANOUT_DISABLED', 'OWNER_DISMISS_RAILS_DISABLED'];
beforeEach(() => {
  mockQuestions.reset();
  mockAppendAnswered.mockClear();
  mockAppendRuling.mockClear();
  mockUnblock.mockClear();
  mockRecordLoopMetric.mockClear();
  mockFireScheduleTarget.mockClear();
  for (const k of ENV) delete process.env[k];
});
afterAll(() => { for (const k of ENV) delete process.env[k]; });

const flush = () => new Promise((r) => setImmediate(r));
let seq = 0;
const row = async (over: Record<string, unknown> = {}) => {
  seq += 1;
  return mockQuestions.api.create({ data: { id: `oq_${String(seq).padStart(8, '0')}-0000-4000-8000-000000000000`, chatId: 'lane-a', userId: 'u1', question: 'Ship the v2 eval pack this week?', ...over } });
};
const notes = () => mockQuestions.crossModelMessage.create.mock.calls.map((c: any[]) => String(c[0]?.data?.content ?? ''));
const wakes = () => mockFireScheduleTarget.mock.calls.map((c: any[]) => String(c[0]?.prompt ?? ''));

describe('OWNER-PROVENANCE-STRICT — answeredBy reaches the ledger', () => {
  it('a SUPERVISOR answer is banked with answeredBy supervisor (never the owner shape)', async () => {
    const q = await row();
    expect(await answerOwnerQuestion(q.id, 'u1', 'yes ship it', { answeredBy: 'supervisor' })).toBe('ok');
    expect(mockAppendAnswered).toHaveBeenCalledWith('fleet-sup', 'u1', expect.objectContaining({ questionId: q.id, answeredBy: 'supervisor', scope: 'Apollo' }));
    // the source chat id is lookup input, never a ledger field
    expect(mockAppendAnswered.mock.calls[0][2].sourceChatId).toBeUndefined();
  });

  it('a preset DEFAULT applied after the deadline is banked with answeredBy default', async () => {
    const q = await row({ defaultAfterDays: 2, defaultOption: 'hold', createdAt: new Date(Date.now() - 3 * 86_400_000) });
    expect(await applyDefaultAnswerIfDue(q as any)).toBe(true);
    expect(mockAppendAnswered).toHaveBeenCalledWith('fleet-sup', 'u1', expect.objectContaining({ questionId: q.id, answeredBy: 'default' }));
  });

  it('a cross-chat DUPLICATE inherits the source answeredBy and its note names the real actor; the kill switch restores owner', async () => {
    const src = await row();
    const dupe = await row({ chatId: 'lane-z' });
    expect(await answerOwnerQuestion(src.id, 'u1', 'yes ship it', { answeredBy: 'supervisor' })).toBe('ok');
    const d = mockQuestions.rows.find((r) => r.id === dupe.id)!;
    expect(d.status).toBe('answered');
    expect(d.answeredBy).toBe('supervisor');
    const dupeNote = notes().find((n) => n.includes('another surface'))!;
    expect(dupeNote).toContain('The Fleet Supervisor answered this flagged question on another surface');
    expect(dupeNote).not.toContain('The owner answered');

    mockQuestions.reset();
    process.env.OWNER_PROVENANCE_STRICT_DISABLED = '1';
    const src2 = await row();
    const dupe2 = await row({ chatId: 'lane-z' });
    expect(await answerOwnerQuestion(src2.id, 'u1', 'yes ship it', { answeredBy: 'supervisor' })).toBe('ok');
    expect(mockQuestions.rows.find((r) => r.id === dupe2.id)!.answeredBy).toBe('owner');
    expect(notes().some((n) => n.includes('The owner answered this flagged question from another surface'))).toBe(true);
  });

  it('the in-chat card path keeps a REPLAYED default\'s provenance (row, note, gate unblock); an owner card answer stamps nothing', async () => {
    const q = await row({ question: 'Proceed with the store wave?' });
    const r = await resolveOwnerQuestionsForChatAnswer({ chatId: 'lane-a', userId: 'u1', askedQuestion: 'Proceed with the store wave?', answer: 'hold', answeredBy: 'default' });
    expect(r.resolved).toBe(1);
    expect(mockQuestions.rows.find((x) => x.id === q.id)!.answeredBy).toBe('default');
    expect(notes().some((n) => n.includes('resolved by its preset DEFAULT'))).toBe(true);
    expect(mockUnblock).toHaveBeenCalledWith(expect.objectContaining({ questionId: q.id, answeredBy: 'default' }));

    mockQuestions.reset();
    mockUnblock.mockClear();
    const q2 = await row({ question: 'Proceed with the store wave?' });
    await resolveOwnerQuestionsForChatAnswer({ chatId: 'lane-a', userId: 'u1', askedQuestion: 'Proceed with the store wave?', answer: 'yes go' });
    expect(mockQuestions.rows.find((x) => x.id === q2.id)!.answeredBy).toBeUndefined();
    expect(notes().some((n) => n.includes('The owner answered your flagged question from the in-chat decision card'))).toBe(true);
    expect(mockUnblock).toHaveBeenCalledWith(expect.objectContaining({ answeredBy: 'owner' }));
  });

  it('#1805 ruling capture fires only for the OWNER — a supervisor answer that reads like a ruling is never captured', async () => {
    const q = await row();
    expect(await answerOwnerQuestion(q.id, 'u1', 'no new boxes, ever — use the lab always', { answeredBy: 'supervisor' })).toBe('ok');
    expect(mockAppendRuling).not.toHaveBeenCalled();
  });
});

describe('OWNER-DIRECTIVE-FANOUT — the asking project\'s supervisor ledger gets a mirror', () => {
  it('an owner answer + ruling land on the Fleet Supervisor AND (mirror:true, project scope) on the asking project\'s supervisor', async () => {
    const q = await row();
    expect(await answerOwnerQuestion(q.id, 'u1', 'no new boxes, ever — the lab hosts it always')).toBe('ok');
    expect(mockAppendAnswered.mock.calls.map((c) => c[0])).toEqual(['fleet-sup', 'apollo-sup']);
    expect(mockAppendAnswered.mock.calls[1][2]).toMatchObject({ questionId: q.id, mirror: true, scope: 'Apollo', answeredBy: 'owner' });
    expect(mockAppendRuling.mock.calls.map((c) => c[0])).toEqual(['fleet-sup', 'apollo-sup']);
    expect(mockAppendRuling.mock.calls[1][2]).toMatchObject({ questionId: q.id, mirror: true, scope: 'Apollo', source: 'answer' });
  });

  it('no mirror for a projectless chat or a project without a supervisor; the kill switch writes the Fleet Supervisor row only', async () => {
    const loose = await row({ chatId: 'loose' });
    expect(await answerOwnerQuestion(loose.id, 'u1', 'yes')).toBe('ok');
    const zeus = await row({ chatId: 'lane-z', question: 'Rebuild the Zeus index now?' });
    expect(await answerOwnerQuestion(zeus.id, 'u1', 'yes')).toBe('ok');
    expect(mockAppendAnswered.mock.calls.map((c) => c[0])).toEqual(['fleet-sup', 'fleet-sup']);
    mockAppendAnswered.mockClear();
    process.env.OWNER_DIRECTIVE_FANOUT_DISABLED = '1';
    const q = await row({ question: 'Move the eval to the lab?' });
    expect(await answerOwnerQuestion(q.id, 'u1', 'yes')).toBe('ok');
    expect(mockAppendAnswered.mock.calls.map((c) => c[0])).toEqual(['fleet-sup']);
  });

  it('a NON-standing owner ruling lands on the Fleet Supervisor only — never mirrored (the fan-out block carries its project-scoped row)', async () => {
    const q = await row();
    expect(await answerOwnerQuestion(q.id, 'u1', 'the eval pack must ship behind the flag this week')).toBe('ok');
    expect(mockAppendRuling.mock.calls.map((c) => c[0])).toEqual(['fleet-sup']);
    expect(mockAppendRuling.mock.calls[0][2]).toMatchObject({ questionId: q.id, scope: 'Apollo' });
    expect(mockAppendRuling.mock.calls[0][2].mirror).toBeUndefined();
    // the DONE answered-question row is still mirrored (it never age-alarms)
    expect(mockAppendAnswered.mock.calls.map((c) => c[0])).toEqual(['fleet-sup', 'apollo-sup']);
  });

  it('a dismissal ruling by the owner is mirrored too', async () => {
    const q = await row();
    expect(await dismissOwnerQuestion(q.id, 'u1', { dismissedBy: 'owner', reason: 'no new Hyperstack IP, ever' })).toBe('ok');
    expect(mockAppendRuling.mock.calls.map((c) => [c[0], c[2].mirror === true])).toEqual([['fleet-sup', false], ['apollo-sup', true]]);
  });
});

describe('OWNER-DISMISS-RAILS — checkSupervisorDismissRails', () => {
  const fleetSeat = { role: 'fleet' as const };
  it('refuses an OWNER-ONLY class card (and records owner_question_dismiss_refused)', async () => {
    const q = await row({ question: 'Should we rotate the key for the gateway?' });
    expect(await checkSupervisorDismissRails(q, fleetSeat)).toEqual({ ok: false, reason: 'owner_only_class', detail: 'credentials' });
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_question_dismiss_refused', meta: expect.objectContaining({ reason: 'owner_only_class', role: 'fleet' }) }));
  });

  it('refuses when the owner posted in the filing chat since the card was filed (machine origins never count)', async () => {
    const q = await row({ createdAt: new Date(Date.now() - 60_000) });
    mockQuestions.messageRows.push({ chatId: 'lane-a', role: 'user', createdAt: new Date(Date.now() - 30_000), metadata: { origin: 'schedule' } });
    expect(await checkSupervisorDismissRails(q, fleetSeat)).toEqual({ ok: true });
    mockQuestions.messageRows.push({ chatId: 'lane-a', role: 'user', createdAt: new Date(Date.now() - 20_000), metadata: null });
    expect(await checkSupervisorDismissRails(q, fleetSeat)).toEqual({ ok: false, reason: 'owner_engaged' });
  });

  it('a PROJECT supervisor may dismiss only cards whose chatId / forChatId is in its project', async () => {
    const own = await row({ chatId: 'lane-a' });
    const linked = await row({ chatId: 'lane-z', forChatId: 'lane-b' });
    const foreign = await row({ chatId: 'lane-z' });
    const seat = { role: 'project' as const, projectId: 'p-apollo' };
    expect(await checkSupervisorDismissRails(own, seat)).toEqual({ ok: true });
    expect(await checkSupervisorDismissRails(linked, seat)).toEqual({ ok: true });
    expect(await checkSupervisorDismissRails(foreign, seat)).toEqual({ ok: false, reason: 'out_of_project' });
    // the Fleet Supervisor is not project-scoped
    expect(await checkSupervisorDismissRails(foreign, fleetSeat)).toEqual({ ok: true });
  });

  it('kill switch OWNER_DISMISS_RAILS_DISABLED=1 → always ok, no metric', async () => {
    process.env.OWNER_DISMISS_RAILS_DISABLED = '1';
    const q = await row({ question: 'Should we rotate the key for the gateway?', chatId: 'lane-z' });
    expect(await checkSupervisorDismissRails(q, { role: 'project', projectId: 'p-apollo' })).toEqual({ ok: true });
    await flush();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_question_dismiss_refused' }));
  });

  it('a project supervisor\'s dismissal is narrated as the PROJECT supervisor\'s (note + wake)', async () => {
    const q = await row();
    expect(await dismissOwnerQuestion(q.id, 'u1', { dismissedBy: 'supervisor', supervisorRole: 'project', reason: 'moot' })).toBe('ok');
    expect(notes().some((n) => n.includes('The PROJECT supervisor (on the owner\'s behalf, under standing directives) dismissed this flagged question'))).toBe(true);
    expect(mockQuestions.rows[0].dismissedBy).toBe('supervisor');
  });
});

describe('OWNER-DISMISS-RAILS — the 24 h re-flag cooldown', () => {
  it('supervisorDismissalArmsCooldown: owner / agent always; a supervisor for every card except an owner-only class one (triaged cards included)', () => {
    expect(supervisorDismissalArmsCooldown({ dismissedBy: 'owner', question: 'x' })).toBe(true);
    expect(supervisorDismissalArmsCooldown({ dismissedBy: 'agent', question: 'x' })).toBe(true);
    expect(supervisorDismissalArmsCooldown({ dismissedBy: 'supervisor', question: 'Ship the pack?' })).toBe(true);
    // review fix: a supervisor's dismissal of a card still in triage arms it too (the triage column is not consulted)
    expect(supervisorDismissalArmsCooldown({ dismissedBy: 'supervisor', triage: 'supervisor', question: 'Ship the pack?' } as any)).toBe(true);
    expect(supervisorDismissalArmsCooldown({ dismissedBy: 'supervisor', question: 'Wipe the old bench volume?' })).toBe(false);
    process.env.OWNER_DISMISS_RAILS_DISABLED = '1';
    expect(supervisorDismissalArmsCooldown({ dismissedBy: 'supervisor', question: 'Wipe the old bench volume?' })).toBe(true);
  });

  it('flagOwnerQuestion: a supervisor dismissal of a TRIAGED card blocks the re-flag (no triage re-wake loop); of an owner-only class card it does not', async () => {
    const question = 'Ship the v2 eval pack this week?';
    await row({ chatId: 'loose', question, status: 'dismissed', dismissedBy: 'supervisor', triage: 'supervisor', triageUntil: new Date(Date.now() + 3_600_000), resolvedAt: new Date(), supersededBy: null });
    const refused = await flagOwnerQuestion({ chatId: 'loose', userId: 'u1', question } as any);
    expect(refused).toMatchObject({ kind: 'refused', refused: 'dismissed_recently' });
    expect((refused as any).message).toContain('a supervisor (on the owner\'s behalf) dismissed this topic recently');

    mockQuestions.reset();
    const ownerOnly = 'Wipe the old bench volume?';
    await row({ chatId: 'loose', question: ownerOnly, status: 'dismissed', dismissedBy: 'supervisor', triage: 'surfaced', resolvedAt: new Date(), supersededBy: null });
    const again = await flagOwnerQuestion({ chatId: 'loose', userId: 'u1', question: ownerOnly } as any);
    expect(again.kind).toBe('created');
  });

  it('the lane\'s wake claims the cooldown only when this dismissal armed it', async () => {
    const triaged = await row({ triage: 'supervisor', triageUntil: new Date(Date.now() + 3_600_000) });
    expect(await dismissOwnerQuestion(triaged.id, 'u1', { dismissedBy: 'supervisor', reason: 'moot under the standing directives' })).toBe('ok');
    expect(wakes().pop()).toContain('Do not raise this question again (the 24h re-flag cooldown enforces it');

    const ownerOnly = await row({ question: 'Wipe the old bench volume?' });
    expect(await dismissOwnerQuestion(ownerOnly.id, 'u1', { dismissedBy: 'supervisor', reason: 'moot' })).toBe('ok');
    const w = wakes().pop()!;
    expect(w).toContain('no re-flag cooldown was armed');
    expect(w).not.toContain('the 24h re-flag cooldown enforces it');

    const byOwner = await row({ question: 'Wipe the old bench volume?' });
    expect(await dismissOwnerQuestion(byOwner.id, 'u1', { dismissedBy: 'owner' })).toBe('ok');
    expect(wakes().pop()).toContain('the 24h re-flag cooldown enforces it');
  });
});
