/**
 * Ticket 913339d7 — polish backlog from the PR #1873 adversarial review
 * (verdict msg 88488df4: CLEAR TO MERGE, 7 non-blocking observations; this
 * lane applies the ones still live on main).
 *
 * Pinned here:
 *  - review obs 2 (looksLikePaste asymmetry): a PASTE-SHAPED reply on a
 *    choice/yes_no card (a PEM block with prose around it — not a single
 *    opaque token, not scanner-redactable: the N9 pass knows only PRIVATE
 *    KEY blocks) rode the mismatch record verbatim, while the credential
 *    twin withheld it. Now the choice branch computes answerLooksLikeCredential
 *    too: the record/note carry a withheld notice, the wake does NOT fire
 *    (a failed paste is not conversation), and the metric carries
 *    lookedLikePaste (parity with the credential twin's telemetry).
 *  - review obs 3 (Telegram DM / digest clipping): clipQuestionKeepingAnnotation
 *    keyed only on PRIOR_DECISION_MARK, so a folded card (REPLACED_REPLY_MARK,
 *    f3a69ed3 defect 2) whose question exceeded the clip got a plain head
 *    slice — the fold amputated on exactly the two surfaces (DM + digest)
 *    that don't render the priorReplyFold API field. Both call paths pass
 *    row.question (owner-questions.ts notify + owner-interrupt-economy
 *    digest), so the clip must keep BOTH appendices.
 *
 * The other five observations: #1 (sweeper-replay wake amplification) was
 * already fixed on main by c1714329 (!opts.replayed); #4 (exact-question
 * dedupe vs folded cards) is by-construction (supersedes skips the dedupe;
 * the decision-level layer strips the fold); #5/#6/#7 are pinned in
 * platform-tools.answer-owner-question.test.ts and the frontend card test.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// ── Stateful fake DB (the 356d21bb sweeper harness shape, mirrored from
// owner-questions.f3a69ed3.test.ts — do not modify that file) ────────────────
const mockQuestions = createOwnerQuestionTable();
const todoRows: any[] = [];
const goalRows: any[] = [];
const matchLoose = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const cond: any = v;
      if ('not' in cond) return row[k] !== cond.not;
      if ('in' in cond) return cond.in.includes(row[k]);
      return row[k] === v;
    }
    return row[k] === v;
  });
const gatedTable = (rows: any[]) => ({
  findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matchLoose(r, where))),
  findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matchLoose(r, where)) ?? null),
  updateMany: jest.fn(async ({ where, data }: any) => {
    const m = rows.filter((r) => matchLoose(r, where));
    m.forEach((r) => Object.assign(r, data));
    return { count: m.length };
  }),
});
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
    projectTodo: gatedTable(todoRows),
    projectGoal: gatedTable(goalRows),
    activity: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── In-memory Redis ──────────────────────────────────────────────────────────
const store = new Map<string, any>();
const mockRedis = {
  set: jest.fn(async (k: string, v: any, opts?: any) => {
    if (opts?.NX && store.has(k)) return null;
    store.set(k, String(v));
    return 'OK';
  }),
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  scan: jest.fn(async (_cursor: number, opts?: any) => {
    const prefix = String(opts?.MATCH ?? '*').replace(/\*.*$/, '');
    return { cursor: 0, keys: [...store.keys()].filter((k) => k.startsWith(prefix)) };
  }),
  rPush: jest.fn(async (k: string, v: any) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    arr.push(v); store.set(k, arr); return arr.length;
  }),
  lPop: jest.fn(async (k: string) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    const v = arr.length ? arr.shift() : null;
    store.set(k, arr); return v ?? null;
  }),
  expire: jest.fn(async () => 1),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

// ── Boundary mocks (env-exit-safe graph) ─────────────────────────────────────
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: jest.fn(async () => {}),
}));
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, isOperational = true) {
      super(message); Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  flagOwnerQuestion,
  answerOwnerQuestion,
  parseOwnerRecordedReply,
  clipQuestionKeepingAnnotation,
  PRIOR_DECISION_MARK,
  REPLACED_REPLY_MARK,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  todoRows.length = 0;
  goalRows.length = 0;
  store.clear();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
  mockRecordLoopMetric.mockReset();
  delete process.env.CREDENTIAL_REPLY_WAKE_DISABLED;
});

// ── Review obs 2 — paste-shaped reply on a CHOICE card ───────────────────────
describe('913339d7 obs 2 — a paste-shaped reply on a choice card is withheld like the credential twin', () => {
  /** A certificate PEM with prose around it: paste-shaped (the credential
   *  branch's answerLooksLikeCredential matches any BEGIN block), NOT an
   *  opaque single token (whitespace), NOT scanner-redactable (the N9 pass
   *  knows only PRIVATE KEY blocks) — the exact shape that rode the record
   *  verbatim before this ticket. */
  const PEM_WITH_PROSE = [
    'here is the cert you asked for',
    '-----BEGIN CERTIFICATE-----',
    'MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQEL',
    'BQAwTjELMAkGA1UEBhMCVVMxKjAoBgNVBAoTIWdlb2NyZW4taW50ZXJtZWRp',
    '-----END CERTIFICATE-----',
    'use that one please',
  ].join('\n');

  it('withholds the PEM from the record, never wakes, and carries the lookedLikePaste metric', async () => {
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-lane', userId: 'u1',
      question: 'Which device should the lane drive?',
      options: [{ label: 'mbp-1' }, { label: 'agx' }],
      expectedAnswerType: 'choice',
    } as any);
    const qid = (flagged as any).question.id;

    const res = await answerOwnerQuestion(qid, 'u1', PEM_WITH_PROSE, { answeredBy: 'owner' });
    expect(res).toBe('reply_recorded');

    const row = mockQuestions.rows.find((r: any) => r.id === qid);
    // The card stays open — no option matched, nothing resolved.
    expect(row.status).toBe('open');
    // The PEM NEVER rides the row: the record carries the withheld notice.
    expect(String(row.answer)).not.toContain('BEGIN CERTIFICATE');
    expect(String(row.answer)).not.toContain('MIIFazCCA1');
    const rec = parseOwnerRecordedReply(row.answer);
    expect(rec).not.toBeNull();
    expect(rec!.text).toContain('looked like a pasted key or certificate');
    expect(rec!.text).not.toContain('BEGIN CERTIFICATE');
    // A failed paste is not conversation — the wake must NOT fire.
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    // Metric parity with the credential twin: the paste shape is recorded.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'owner_gate_type_mismatch',
        meta: expect.objectContaining({ expectedType: 'choice', lookedLikePaste: true, conversational: false, woken: false }),
      }),
    );
  });

  it('plain English on the same card still records AND wakes (the guard does not over-suppress)', async () => {
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-lane', userId: 'u1',
      question: 'Which device should the lane drive?',
      options: [{ label: 'mbp-1' }, { label: 'agx' }],
      expectedAnswerType: 'choice',
    } as any);
    const qid = (flagged as any).question.id;

    const res = await answerOwnerQuestion(qid, 'u1', 'use my mbp-1 to fix the tailscale json', { answeredBy: 'owner' });
    expect(res).toBe('reply_recorded');
    // The conversational wake still fires for plain English (f3a69ed3 defect 3
    // is untouched — answerLooksLikeCredential is false on spaced prose).
    expect(mockFireScheduleTarget).toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'owner_gate_type_mismatch',
        meta: expect.objectContaining({ expectedType: 'choice', lookedLikePaste: false, conversational: true, woken: true }),
      }),
    );
  });
});

// ── Review obs 3 — the DM/digest clip keeps the fold ─────────────────────────
describe('913339d7 obs 3 — clipQuestionKeepingAnnotation keeps the replaced-reply fold', () => {
  it('a folded card with NO prior-decision mark keeps the FOLD on clip (previously a plain head slice amputated it)', () => {
    const head = 'x'.repeat(1200);
    const fold = `${REPLACED_REPLY_MARK} (card oq_510a512a1234567890abcdef): "use my mbp-1 to fix the tailscale json"`;
    const out = clipQuestionKeepingAnnotation(`${head}${fold}`, 900);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out).toContain('FROM YOUR EARLIER REPLY');
    expect(out).toContain('use my mbp-1 to fix the tailscale json');
  });

  it('BOTH appendices present: the EARLIER one is kept (a fold can precede the prior-decision note)', () => {
    const head = 'x'.repeat(1200);
    const fold = `${REPLACED_REPLY_MARK} (card oq_510a512a1234567890abcdef): "use mbp-1"`;
    const prior = `${PRIOR_DECISION_MARK} you decided this on 2026-10-01 (oq_12345678): «go». Reply "Same as before" to repeat it.`;
    const out = clipQuestionKeepingAnnotation(`${head}${fold}${prior}`, 900);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out).toContain('FROM YOUR EARLIER REPLY');
  });

  it('NEITHER mark present: byte-identical head slice (the pre-existing behavior is unchanged)', () => {
    const head = 'y'.repeat(1200);
    expect(clipQuestionKeepingAnnotation(head, 900)).toBe(head.slice(0, 900));
    expect(clipQuestionKeepingAnnotation('short', 900)).toBe('short');
  });
});
