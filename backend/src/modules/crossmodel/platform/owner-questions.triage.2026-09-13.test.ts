/**
 * Review 2026-09-13 issue 11: supervisor-first triage of machine-lane owner
 * questions (owner-questions.ts).
 *
 * Pins:
 *   - classifyOwnerQuestionRouting: every owner-only class (physically-human,
 *     irreversible, money beyond approval, external send, credentials) routes
 *     'owner'; everything else routes 'supervisor'; context is scanned too;
 *   - flagOwnerQuestion: a MACHINE flag from a NON-supervisor chat is triaged
 *     (triage='supervisor', triageUntil = now + SLA), the owner DM is skipped,
 *     the supervisor is woken with an attention_needed '[OWNER-QUESTION
 *     TRIAGE …] … — question id <id>' event, and the routing reason is
 *     logged; supervisor-filed / user-present / owner-only / kill-switch /
 *     unknown-chat flags are NOT triaged (legacy routing, DM sent);
 *   - listings: the default views HIDE open rows still in triage; includeTriaged
 *     shows them with triaged:true; surfaced / SLA-elapsed / answered rows are
 *     never hidden;
 *   - surfaceTriagedOwnerQuestions: SLA-elapsed open rows flip to 'surfaced'
 *     exactly once, DM the owner once (held line);
 *   - answerOwnerQuestion({answeredBy:'supervisor'}) stamps the provenance and
 *     names the supervisor in the note + wake; a supervisor-answered row never
 *     surfaces.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';
import logger from '../../../utils/logger';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => ({ isSupervisor: false, projectId: null }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      // The supervisor-ledger probe (appendAnswerToSupervisorLedger) looks the
      // owner's supervisor chat up with findFirst.
      findFirst: jest.fn(async () => ({ id: 'sup-chat' })),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockArmRetry: jest.Mock = jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  armOwnerAnswerRetrySchedule: (...a: any[]) => mockArmRetry(...a),
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

const mockAppendAnswered: jest.Mock = jest.fn(async () => {});
// Merged 2026-09-13 with e9459ff1 (owner answers resolve every derived gate):
// answerOwnerQuestion now imports goals.service, which pulls env.ts — mock it
// exactly as owner-questions.test.ts does so the suite never parses prod env.
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: jest.fn(async () => ({ unblockedTodos: 0, unblockedGoals: 0 })),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
}));

// The supervisor wake (dynamic import of ./hooks.service — the real module
// pulls prisma/redis/crossmodel.service) and the loop-metric receipts.
const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    OWNER_QUESTION_TRIAGED: 'owner_question_triaged',
    OWNER_QUESTION_SURFACED: 'owner_question_surfaced',
    OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
  },
}));

import {
  OWNER_ONLY_QUESTION_CLASSES,
  OWNER_QUESTION_TRIAGE_SLA_MIN_DEFAULT,
  answerOwnerQuestion,
  classifyOwnerQuestionRouting,
  flagOwnerQuestion,
  isOwnerQuestionInTriage,
  listOpenOwnerQuestionsForUser,
  listOwnerQuestionsForUser,
  ownerQuestionTriageSlaMinutes,
  surfaceTriagedOwnerQuestions,
} from './owner-questions';

const flush = () => new Promise((r) => setTimeout(r, 10)); // fire-and-forget DM / wake / metric

beforeEach(() => {
  mockQuestions.reset();
  mockChatFindUnique.mockReset().mockResolvedValue({ isSupervisor: false, projectId: null });
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue({ chatId: 'tg-owner' }); // a DM WOULD fire if sent
  mockTelegramSendMessage.mockReset().mockResolvedValue(true);
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockArmRetry.mockReset().mockResolvedValue({ ok: true, scheduleId: 'sched-retry-1' });
  mockAppendAnswered.mockReset().mockResolvedValue(undefined);
  mockEmitHookEventSafe.mockReset().mockResolvedValue(undefined);
  mockRecordLoopMetric.mockReset();
  delete process.env.OWNER_QUESTION_TRIAGE_SLA_MIN;
});

const machineFlag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({
    chatId: 'lane-1', userId: 'u1', machineTriggered: true,
    question: 'Approve the L2 cudagraph staging window for the kernel lane?',
    ...over,
  });

// ── Classifier ───────────────────────────────────────────────────────────────

describe('classifyOwnerQuestionRouting — the owner-only allowlist vs supervisor-first default', () => {
  it('physically-human asks route to the owner', () => {
    expect(classifyOwnerQuestionRouting('Please sign the identity attestation for the vendor.')).toEqual({ route: 'owner', reason: 'physically_human' });
    expect(classifyOwnerQuestionRouting('Tap approve in the Duo prompt on your phone.').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('Someone must physically plug the drive into the Mac mini.').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('Click the OAuth consent button when you are back.').route).toBe('owner');
  });

  it('irreversible / destructive asks route to the owner', () => {
    expect(classifyOwnerQuestionRouting('This step is irreversible — proceed with the schema rewrite?')).toEqual({ route: 'owner', reason: 'irreversible' });
    expect(classifyOwnerQuestionRouting('Terminate the reservation for the H100 node today?').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('OK to delete the database and re-seed?').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('Shall we wipe the checkpoint bucket?').route).toBe('owner');
  });

  it('money is NOT owner-only (preflight 2026-09-14: budgets pre-approved, cost cards forbidden) — cost-shaped asks route to supervisor triage', () => {
    expect(classifyOwnerQuestionRouting('Approve $2500 of additional GPU spend for the re-judge?')).toEqual({ route: 'supervisor', reason: 'machine_lane_approval' });
    expect(classifyOwnerQuestionRouting('Approve $ 150 for the extra run?').route).toBe('supervisor');
    expect(classifyOwnerQuestionRouting('This would take us over the approved budget — continue?').route).toBe('supervisor');
    expect(classifyOwnerQuestionRouting('Spend outside the pre-approved cap for a second replica?').route).toBe('supervisor');
    // Small figures inside the envelope are NOT owner-only (the $9/mo HF PRO card from the review).
    expect(classifyOwnerQuestionRouting('Approve the $9/mo HF PRO subscription for the bench lane?').route).toBe('supervisor');
  });

  it('external sends route to the owner', () => {
    expect(classifyOwnerQuestionRouting('Post it on LinkedIn tonight?')).toEqual({ route: 'owner', reason: 'external_send' });
    expect(classifyOwnerQuestionRouting('Email this to investors before the call?').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('Send it to the client as-is?').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('Publish them on X?').route).toBe('owner');
  });

  it('credential operations route to the owner', () => {
    expect(classifyOwnerQuestionRouting('Rotate the key for the DeepSeek account now?')).toEqual({ route: 'owner', reason: 'credentials' });
    expect(classifyOwnerQuestionRouting('Share the password with the contractor lane?').route).toBe('owner');
    expect(classifyOwnerQuestionRouting('Revoke the token that leaked into chat 3e1cae6f?').route).toBe('owner');
  });

  it("everything else — a machine lane's approval-type ask — routes to the supervisor", () => {
    expect(classifyOwnerQuestionRouting('Approve the L2 cudagraph staging window for the kernel lane?')).toEqual({ route: 'supervisor', reason: 'machine_lane_approval' });
    expect(classifyOwnerQuestionRouting('GO or HOLD on Post-CPT SFT-2?').route).toBe('supervisor');
    expect(classifyOwnerQuestionRouting('Which gold policy should the bench use: cross-checkers or single judge?').route).toBe('supervisor');
    expect(classifyOwnerQuestionRouting('Start the third checkpoint replica?').route).toBe('supervisor');
  });

  it('scans the CONTEXT too — the dollar figure or the verb often lives there', () => {
    expect(classifyOwnerQuestionRouting('Approve the re-judge run?', 'Estimated cost: $1200 across 40 GPU-hours.').route).toBe('supervisor');
    expect(classifyOwnerQuestionRouting('Approve the re-judge run?', 'Cost ~$40; reuses the reserved nodes.').route).toBe('supervisor');
    expect(classifyOwnerQuestionRouting('Proceed?', 'This will destroy the old index.').reason).toBe('irreversible');
  });

  it('pins the owner-only classes in precedence order (money dropped 2026-09-14; cross_project_scope added LAST by ticket 661fb494 2026-09-18; another_account_security added before it by audit 96fb2f25 2026-10-16)', () => {
    expect(OWNER_ONLY_QUESTION_CLASSES.map((c) => c.reason)).toEqual([
      'physically_human', 'irreversible', 'external_send', 'credentials', 'another_account_security', 'cross_project_scope',
    ]);
  });

  it('SLA env: default 120 min, env override clamped to [1, 1440], garbage → default', () => {
    expect(OWNER_QUESTION_TRIAGE_SLA_MIN_DEFAULT).toBe(120);
    expect(ownerQuestionTriageSlaMinutes()).toBe(120);
    process.env.OWNER_QUESTION_TRIAGE_SLA_MIN = '30';
    expect(ownerQuestionTriageSlaMinutes()).toBe(30);
    process.env.OWNER_QUESTION_TRIAGE_SLA_MIN = '99999';
    expect(ownerQuestionTriageSlaMinutes()).toBe(1440);
    process.env.OWNER_QUESTION_TRIAGE_SLA_MIN = 'soon';
    expect(ownerQuestionTriageSlaMinutes()).toBe(120);
    process.env.OWNER_QUESTION_TRIAGE_SLA_MIN = '0';
    expect(ownerQuestionTriageSlaMinutes()).toBe(120);
  });
});

// ── Create path ──────────────────────────────────────────────────────────────

describe('flagOwnerQuestion — supervisor-first triage on machine flags from non-supervisor chats', () => {
  it('triages: triage=supervisor, triageUntil=now+SLA, NO owner DM, supervisor woken with the question id, routing reason logged', async () => {
    const before = Date.now();
    const r = await machineFlag();
    await flush();
    expect(r.kind).toBe('created');
    const row: any = mockQuestions.rows[0];
    expect(row.triage).toBe('supervisor');
    expect(row.triageUntil).toBeInstanceOf(Date);
    const slaMs = row.triageUntil.getTime() - before;
    expect(slaMs).toBeGreaterThanOrEqual(120 * 60_000 - 50);
    expect(slaMs).toBeLessThanOrEqual(120 * 60_000 + 5_000);
    expect((r as any).question.triage).toBe('supervisor');
    // The chat probe asked exactly for isSupervisor.
    expect(mockChatFindUnique).toHaveBeenCalledWith({ where: { id: 'lane-1' }, select: { isSupervisor: true } });
    // Owner DM deferred (a Telegram link exists, so a legacy flag WOULD have DM'd).
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    // Supervisor wake: attention_needed from the FILING chat, alarm-lane shape.
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
    const [srcChat, eventType, summary, extra] = mockEmitHookEventSafe.mock.calls[0];
    expect(srcChat).toBe('lane-1');
    expect(eventType).toBe('attention_needed');
    expect(summary.startsWith('[OWNER-QUESTION TRIAGE — answer under standing directives or leave for the owner] ')).toBe(true);
    expect(summary).toContain('Approve the L2 cudagraph staging window for the kernel lane?');
    expect(summary.endsWith(` — question id ${row.id}`)).toBe(true);
    expect(extra).toEqual({ ownerQuestionId: row.id, triage: 'supervisor' });
    // The routing class is auditable on the flag's info line.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(`${row.id} flagged on chat lane-1`));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('(machine_lane_approval)'));
  });

  it('renders typed options numbered inside the supervisor wake summary (before the question id)', async () => {
    await machineFlag({ options: [{ id: 'go', label: 'GO', consequence: 'staging runs tonight' }, { id: 'hold', label: 'Hold' }] });
    await flush();
    const summary: string = mockEmitHookEventSafe.mock.calls[0][2];
    expect(summary).toContain('1. GO — staging runs tonight');
    expect(summary).toContain('2. Hold');
    expect(summary.indexOf('2. Hold')).toBeLessThan(summary.indexOf(' — question id oq_'));
  });

  it('honours OWNER_QUESTION_TRIAGE_SLA_MIN', async () => {
    process.env.OWNER_QUESTION_TRIAGE_SLA_MIN = '30';
    const before = Date.now();
    await machineFlag();
    const row: any = mockQuestions.rows[0];
    const slaMs = row.triageUntil.getTime() - before;
    expect(slaMs).toBeGreaterThanOrEqual(30 * 60_000 - 50);
    expect(slaMs).toBeLessThanOrEqual(30 * 60_000 + 5_000);
  });

  it('a SUPERVISOR-filed question is never triaged — legacy routing, owner DM sent, no self-wake', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: true, projectId: null });
    const r = await machineFlag({ chatId: 'supervisor-chat' });
    await flush();
    expect(r.kind).toBe('created');
    const row: any = mockQuestions.rows[0];
    expect(row.triage).toBeUndefined();
    expect(row.triageUntil).toBeUndefined();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(String(mockTelegramSendMessage.mock.calls[0][1])).toContain('Digby needs your decision');
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('a USER-PRESENT flag (machineTriggered not true) is never triaged', async () => {
    const r = await flagOwnerQuestion({ chatId: 'lane-1', userId: 'u1', question: 'Approve the staging window?' });
    await flush();
    expect(r.kind).toBe('created');
    expect((mockQuestions.rows[0] as any).triage).toBeUndefined();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    // The supervisor probe is not even consulted for a user-present flag.
    expect(mockChatFindUnique.mock.calls.some((c: any[]) => c[0]?.select?.isSupervisor)).toBe(false);
  });

  it('an OWNER-ONLY question from a machine lane goes straight to the owner (DM now, no triage)', async () => {
    // 2026-09-14: money is NOT owner-only any more (budgets are pre-approved) — the fixture is an irreversible action.
    const r = await machineFlag({ question: 'Permanently delete the bucket holding old checkpoints and wipe the archived tables?' });
    await flush();
    expect(r.kind).toBe('created');
    expect((mockQuestions.rows[0] as any).triage).toBeUndefined();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('fails toward the owner: an unknown chat (null) or an unavailable probe (undefined) keeps legacy routing', async () => {
    mockChatFindUnique.mockResolvedValue(null);
    await machineFlag({ chatId: 'ghost-chat' });
    await flush();
    expect((mockQuestions.rows[0] as any).triage).toBeUndefined();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    mockQuestions.reset();
    mockTelegramSendMessage.mockClear();
    mockChatFindUnique.mockResolvedValue(undefined);
    await machineFlag({ chatId: 'mocked-chat' });
    await flush();
    expect((mockQuestions.rows[0] as any).triage).toBeUndefined();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('a failed supervisor wake never fails the flag (the SLA surfaces the row instead)', async () => {
    mockEmitHookEventSafe.mockRejectedValue(new Error('outbox down'));
    const r = await machineFlag();
    await flush();
    expect(r.kind).toBe('created');
    expect((mockQuestions.rows[0] as any).triage).toBe('supervisor');
  });
});

// ── Listings ─────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
function seedRow(over: Record<string, unknown>): any {
  const row = {
    id: `oq_${String(over.id ?? Math.random().toString(16).slice(2))}`, chatId: 'lane-1', userId: 'u1',
    question: `Q ${String(over.id ?? '')}`, context: null, status: 'open', answer: null,
    createdAt: new Date(Date.now() - HOUR), resolvedAt: null,
    ...over,
  };
  row.id = String(over.id ?? row.id).startsWith('oq_') ? String(over.id ?? row.id) : `oq_${String(over.id)}`;
  mockQuestions.rows.push(row);
  return row;
}

describe('listings — the owner-facing default hides rows in triage; includeTriaged shows them with the marker', () => {
  let A: any; let B: any; let C: any; let D: any; let E: any;
  beforeEach(() => {
    A = seedRow({ id: 'A', triage: 'supervisor', triageUntil: new Date(Date.now() + HOUR) }); // in triage
    B = seedRow({ id: 'B', triage: 'surfaced', triageUntil: new Date(Date.now() - HOUR) }); // surfaced
    C = seedRow({ id: 'C' }); // never triaged (no columns at all)
    D = seedRow({ id: 'D', triage: 'supervisor', triageUntil: new Date(Date.now() - HOUR) }); // SLA elapsed, sweep not run yet
    E = seedRow({ id: 'E', status: 'answered', answer: 'go', triage: 'supervisor', triageUntil: new Date(Date.now() + HOUR) }); // answered inside the SLA
  });

  it('isOwnerQuestionInTriage: only OPEN + supervisor + future SLA', () => {
    expect(isOwnerQuestionInTriage(A)).toBe(true);
    expect(isOwnerQuestionInTriage(B)).toBe(false);
    expect(isOwnerQuestionInTriage(C)).toBe(false);
    expect(isOwnerQuestionInTriage(D)).toBe(false);
    expect(isOwnerQuestionInTriage(E)).toBe(false);
  });

  it('listOpenOwnerQuestionsForUser (the Decisions rail + Telegram view) hides A only', async () => {
    const ids = (await listOpenOwnerQuestionsForUser('u1')).map((q) => q.id).sort();
    expect(ids).toEqual([B.id, C.id, D.id].sort());
    // No marker on the default view (byte-identical rows for legacy consumers).
    expect((await listOpenOwnerQuestionsForUser('u1')).every((q) => q.triaged === undefined)).toBe(true);
  });

  it('listOpenOwnerQuestionsForUser({includeTriaged:true}) shows A with triaged:true, the rest triaged:false', async () => {
    const rows = await listOpenOwnerQuestionsForUser('u1', { includeTriaged: true });
    expect(rows.map((q) => q.id).sort()).toEqual([A.id, B.id, C.id, D.id].sort());
    const byId = new Map(rows.map((q) => [q.id, q]));
    expect(byId.get(A.id)?.triaged).toBe(true);
    expect(byId.get(B.id)?.triaged).toBe(false);
    expect(byId.get(C.id)?.triaged).toBe(false);
    expect(byId.get(D.id)?.triaged).toBe(false);
  });

  it('listOwnerQuestionsForUser (all statuses) hides A by default but shows the answered-in-SLA row E; includeTriaged shows A marked', async () => {
    const def = (await listOwnerQuestionsForUser('u1')).rows.map((q) => q.id).sort();
    expect(def).toEqual([B.id, C.id, D.id, E.id].sort());
    const all = await listOwnerQuestionsForUser('u1', { includeTriaged: true });
    expect(all.rows.map((q) => q.id).sort()).toEqual([A.id, B.id, C.id, D.id, E.id].sort());
    expect(all.rows.find((q) => q.id === A.id)?.triaged).toBe(true);
    expect(all.rows.find((q) => q.id === E.id)?.triaged).toBe(false);
    // id probe on a triaged row: hidden by default, visible with the flag. The
    // id RESOLVES either way (ticket 8bae9959 — resolution is not filter-
    // intersected), so unmatchedIds stays empty; only the row view hides it.
    // (973d7f80: the return type grew sharedRows — the cross-member second
    // chance bucket; empty here, the triage behavior itself is unchanged.)
    expect(await listOwnerQuestionsForUser('u1', { ids: [A.id] })).toEqual({ rows: [], unmatchedIds: [], sharedRows: [] });
    expect((await listOwnerQuestionsForUser('u1', { ids: [A.id], includeTriaged: true })).rows.map((q) => q.id)).toEqual([A.id]);
  });
});

// ── Surfacing sweep ──────────────────────────────────────────────────────────

describe('surfaceTriagedOwnerQuestions — SLA-elapsed rows surface to the owner exactly once', () => {
  it('flips due rows to surfaced, DMs once with the held line; untouched: in-SLA, answered, already-surfaced', async () => {
    const A = seedRow({ id: 'A', triage: 'supervisor', triageUntil: new Date(Date.now() + HOUR) });
    const D = seedRow({ id: 'D', question: 'Approve the staging window?', triage: 'supervisor', triageUntil: new Date(Date.now() - HOUR), options: [{ id: 'go', label: 'GO' }] });
    const F = seedRow({ id: 'F', status: 'answered', answer: 'go', triage: 'supervisor', triageUntil: new Date(Date.now() - HOUR) });
    const G = seedRow({ id: 'G', triage: 'surfaced', triageUntil: new Date(Date.now() - 2 * HOUR) });

    expect(await surfaceTriagedOwnerQuestions()).toBe(1);
    expect(D.triage).toBe('surfaced');
    expect(D.status).toBe('open'); // surfacing never answers
    expect(A.triage).toBe('supervisor');
    expect(F.triage).toBe('supervisor'); // answered rows are left alone (status != open)
    expect(G.triage).toBe('surfaced');
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    const dm = String(mockTelegramSendMessage.mock.calls[0][1]);
    expect(dm).toContain('Digby needs your decision'); // the Telegram bare-reply marker survives
    expect(dm).toContain('Held for the Fleet Supervisor first');
    expect(dm).toContain('Approve the staging window?');
    expect(dm).toContain('1. GO');
    expect(dm).toContain(`answer ${D.id.slice(3, 11)}`);
    // Idempotent: a second sweep (peer instance) finds nothing due.
    expect(await surfaceTriagedOwnerQuestions()).toBe(0);
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    // …and the surfaced row is now on the owner's default rail.
    expect((await listOpenOwnerQuestionsForUser('u1')).map((q) => q.id)).toContain(D.id);
  });

  it('still flips (and never throws) when the owner has no Telegram link', async () => {
    const D = seedRow({ id: 'D', triage: 'supervisor', triageUntil: new Date(Date.now() - HOUR) });
    mockTelegramLinkFindUnique.mockResolvedValue(null);
    expect(await surfaceTriagedOwnerQuestions({ now: new Date() })).toBe(1);
    expect(D.triage).toBe('surfaced');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
  });

  it('a row the supervisor answered inside the SLA never surfaces — no DM, no flip', async () => {
    await machineFlag(); // triaged
    const row: any = mockQuestions.rows[0];
    expect(await answerOwnerQuestion(row.id, 'u1', 'Approved under the CanLaw budget grant — proceed', { answeredBy: 'supervisor' })).toBe('ok');
    row.triageUntil = new Date(Date.now() - HOUR); // the SLA passes later
    mockTelegramSendMessage.mockClear();
    expect(await surfaceTriagedOwnerQuestions()).toBe(0);
    expect(row.triage).toBe('supervisor');
    expect(row.status).toBe('answered');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect((await listOpenOwnerQuestionsForUser('u1')).length).toBe(0);
  });
});

// ── answeredBy provenance ────────────────────────────────────────────────────

describe('answerOwnerQuestion — answeredBy provenance (owner default, supervisor via the tool)', () => {
  it("{answeredBy:'supervisor'} stamps the row and names the Fleet Supervisor in the transcript note, the wake, and the ledger", async () => {
    await machineFlag({ context: 'Window: 02:00-04:00Z on the kernel lane.' });
    const row: any = mockQuestions.rows[0];
    expect(await answerOwnerQuestion(row.id, 'u1', 'Approved under the owner\'s "clear gates on my behalf" directive — proceed.', { answeredBy: 'supervisor' })).toBe('ok');
    expect(row.status).toBe('answered');
    expect(row.answeredBy).toBe('supervisor');
    const note = String(mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content);
    expect(note).toContain('The Fleet Supervisor answered your flagged question');
    expect(note).toContain('standing directives');
    expect(note).not.toContain('The owner answered');
    const wake = String(mockFireScheduleTarget.mock.calls[0][0].prompt);
    expect(wake).toContain('FLEET SUPERVISOR answered your flagged question');
    expect(wake).toContain('treat it exactly like an owner answer');
    expect(wake).toContain('Window: 02:00-04:00Z'); // context echo survives
    expect(mockAppendAnswered).toHaveBeenCalledTimes(1); // the decision lands in the supervisor ledger
  });

  it("default answeredBy is 'owner' (REST / Telegram unchanged)", async () => {
    await flagOwnerQuestion({ chatId: 'lane-2', userId: 'u1', question: 'Which region?' });
    const row: any = mockQuestions.rows[0];
    expect(await answerOwnerQuestion(row.id, 'u1', 'ca-central-1')).toBe('ok');
    expect(row.answeredBy).toBe('owner');
    const note = String(mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content);
    expect(note).toContain('The owner answered your flagged question');
    const wake = String(mockFireScheduleTarget.mock.calls[0][0].prompt);
    expect(wake).toContain('the OWNER just answered');
  });

  it('typed-option matching applies to supervisor answers too (chosenOption stamped)', async () => {
    await machineFlag({ options: [{ id: 'go', label: 'GO' }, { id: 'hold', label: 'Hold' }] });
    const row: any = mockQuestions.rows[0];
    expect(await answerOwnerQuestion(row.id, 'u1', '1', { answeredBy: 'supervisor' })).toBe('ok');
    expect(row.chosenOption).toBe('go');
    expect(row.answeredBy).toBe('supervisor');
  });
});
