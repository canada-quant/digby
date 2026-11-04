/**
 * Pins for ticket 5c024656 — "Owner-card option label/id/consequence +
 * goalId/todoId carry raw credentials onto broadcast surfaces (no inbound
 * scan without an echo)".
 *
 * THE FINDING (round-9 adversarial review of 26786762, live-probed by
 * reviewer ce911d93 at e1752b04d): #1679's echoScrub covers only an ECHO
 * of a delivered/rescued value in the option slots and the goal/todo
 * linkage fields. A RAW scanner-known credential placed in one of those
 * slots with NO delivery rode onto the stored owner-question row verbatim
 * — and from there onto every broadcast surface (Inbox card, Telegram DM,
 * fleet board, wake echo).
 *
 * THE FIX (this suite's subject): the same wrap defaultOption already had
 * (owner-questions.ts, the redactInboundSecrets(echoScrub(...)) pattern) —
 * echo FIRST (a delivered-value echo still becomes its [SECRET n] reveal
 * handle, never destroyed), then the inbound scan destroys any remaining
 * raw credential material. The option id is scanned on the RAW text BEFORE
 * normalizeOwnerQuestionOptions' 40-char slice (H5 fragment rule).
 *
 * Fixture rule (same as the 26786762 suite's J1 block): the key is
 * ASSEMBLED from parts so this file's diff carries no credential-shaped
 * literal — the merge gate's secret scan refuses such diffs (sk- and xai-
 * literals both tripped it), and these pins must be mergeable.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// The delivered-secret store encrypts through the credentials vault, whose
// key derives from JWT_SECRET — set a test secret BEFORE any import that
// touches the module (same as the 26786762 suite).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => undefined);
const mockChatFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindMany: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
    activity: mockQuestions.activity,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
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
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
}));

const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));

// Real crypto for the vault (same as the 26786762 suite): the J1-echo pin
// below stores a rescued span through the real AES-256-GCM path.
const realCrypto = jest.requireActual('../coding/credentials.service');
jest.mock('../coding/credentials.service', () => ({
  __esModule: true,
  ...realCrypto,
}));

import { flagOwnerQuestion } from './owner-questions';
import { revealQuestionSecret } from './owner-question-secrets';

const prisma = {
  ownerQuestion: mockQuestions.api,
  ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
  activity: mockQuestions.activity,
};

const OWNER = 'user-owner-1';
const CHAT = 'chat-f2-lane';

// A scanner-KNOWN key shape at RUNTIME (the sk- class), assembled from
// parts — no credential-shaped literal in the diff (mergeable-suite rule).
const RAW = ['sk-', 'F2Raw', 'Leak', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');

beforeEach(() => {
  mockQuestions.reset();
  mockTelegramLinkFindUnique.mockReset().mockImplementation(async () => null);
  mockChatFindUnique.mockReset().mockImplementation(async () => undefined);
  mockChatFindFirst.mockReset().mockImplementation(async () => null);
  mockChatFindMany.mockReset().mockImplementation(async () => []);
  mockFireScheduleTarget.mockReset().mockImplementation(async () => ({ started: true }));
  mockTelegramSendMessage.mockReset().mockImplementation(async () => true);
});

describe('5c024656 — raw credentials in the option/goal slots are destroyed, not stored (no-delivery leg)', () => {
  test('raw scanner-known key in option label/consequence/id → destruction marker on the row, never the value', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the new gateway key in the console',
      options: [
        { id: `opt-${RAW}`, label: `Use ${RAW} now`, consequence: `the key ${RAW} goes live` },
        { label: 'Cancel' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    // THE F2 LEAK, pinned: the raw value is nowhere on the row.
    expect(dump).not.toContain(RAW);
    // The inbound scan destroyed it (not a handle — there was no delivery).
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toContain('[REDACTED: looked like a credential]');
    expect(String(opts[0].consequence)).toContain('[REDACTED: looked like a credential]');
    expect(String(opts[0].id)).toContain('[REDACTED: looked like a credential]');
    // No delivery ⇒ no vault row, no phantom handle.
    expect(mockQuestions.secretRows).toHaveLength(0);
    expect(dump).not.toContain('[SECRET');
  });

  test('raw scanner-known key in goalId/todoId → destroyed on the row (the linkage fields ride the wake echo)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Proceed with the rollout?',
      goalId: `goal-${RAW}`,
      todoId: `todo-${RAW}`,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(RAW);
    expect(String(stored.goalId)).toContain('[REDACTED: looked like a credential]');
    expect(String(stored.todoId)).toContain('[REDACTED: looked like a credential]');
  });

  test('the DM broadcast carries no raw key from any slot', async () => {
    mockTelegramLinkFindUnique.mockImplementation(async () => ({ userId: OWNER, chatId: 'tg-owner-1' }));
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Save the new gateway key in the console',
      options: [
        { id: `opt-${RAW}`, label: `Use ${RAW} now`, consequence: `the key ${RAW} goes live` },
        { label: 'Cancel' },
      ],
      goalId: `goal-${RAW}`,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    await new Promise((res) => setImmediate(res));
    const dmCalls = mockTelegramSendMessage.mock.calls.filter((c: any[]) => Array.isArray(c) && typeof c[1] === 'string');
    expect(dmCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of dmCalls) expect(c[1]).not.toContain(RAW);
  });

  test('a >40-char raw id fragment is caught BEFORE the slice (H5 fragment rule carries over)', async () => {
    // The id cap inside normalizeOwnerQuestionOptions is 40 chars — a longer
    // raw credential id would carry a leading fragment past an ordinary
    // post-slice check. The scan runs on the RAW text first.
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Pick an option',
      options: [{ id: `${RAW}-with-a-long-tail-beyond-the-cap`, label: 'Go' }],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(RAW);
    expect(dump).not.toContain(RAW.slice(0, 40));
  });

  // ── Round-1 review blockers ────────────────────────────────────────────────

  test('R1-1: non-string option slots (array/number form from JSON.parse tool args) are coerced BEFORE the wrap — raw key never reaches the row', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Choose a key rotation',
      options: [
        {
          id: ['opt-', RAW, '-arr'].flat().join(''),
          label: [`Use ${RAW} now`],
          consequence: [RAW, ' goes live'],
        } as any,
        { label: 'Cancel' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(RAW);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toContain('[REDACTED: looked like a credential]');
    expect(String(opts[0].id)).toContain('[REDACTED: looked like a credential]');
    expect(String(opts[0].consequence)).toContain('[REDACTED: looked like a credential]');
  });

  test('R1-1 echo leg: array-form slot echoing a delivered value still becomes the reveal handle', async () => {
    const KNOWN = ['xai-', 'R1one', 'Echo', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the key: ${KNOWN} — use it as the client key`,
      options: [{ id: ['opt-', KNOWN].join(''), label: [`Use ${KNOWN} now`] } as any],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(KNOWN);
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toContain('[SECRET 1]');
    expect(String(opts[0].id)).toContain('[SECRET 1]');
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: KNOWN });
  });

  test('R1-2: two DIFFERENT raw-credential ids both survive redaction as distinct options (no silent drop)', async () => {
    const A = ['sk-', 'Collide', 'First', '0123456789', 'AAAAAAAAAAAAAAAA'].join('');
    const B = ['sk-', 'Collide', 'Secnd', '0123456789', 'BBBBBBBBBBBBBBBB'].join('');
    mockTelegramLinkFindUnique.mockImplementation(async () => ({ userId: OWNER, chatId: 'tg-owner-1' }));
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Choose which key to rotate',
      options: [
        { id: `opt-${A}`, label: 'First', consequence: 'the first key applies' },
        { id: `opt-${B}`, label: 'Second', consequence: 'the second key applies' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(A);
    expect(dump).not.toContain(B);
    const opts = stored.options as any[];
    // THE R1-2 DROP, pinned: both choices survive with DISTINCT ids.
    expect(opts).toHaveLength(2);
    expect(opts[0].id).not.toBe(opts[1].id);
    expect(opts.map((o: any) => o.label)).toEqual(['First', 'Second']);
    // And the DM broadcast carries both labels.
    await new Promise((res) => setImmediate(res));
    const dmCalls = mockTelegramSendMessage.mock.calls.filter((c: any[]) => Array.isArray(c) && typeof c[1] === 'string');
    expect(dmCalls.length).toBeGreaterThanOrEqual(1);
    const dm = dmCalls[dmCalls.length - 1][1];
    expect(dm).toContain('First');
    expect(dm).toContain('Second');
  });

  test('R1-2 mixed control: one raw-credential id + one ordinary id — both survive', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Pick one',
      options: [
        { id: `opt-${RAW}`, label: 'Rotate' },
        { id: 'opt-keep', label: 'Keep' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const opts = stored.options as any[];
    expect(opts).toHaveLength(2);
    expect(opts.map((o: any) => o.label)).toEqual(['Rotate', 'Keep']);
    expect(opts[1].id).toBe('opt-keep');
  });

  test('R1-2 contract: IDENTICAL raw ids supplied twice still dedupe to one option (the long-standing behavior, pinned by the P2 suite)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Pick one',
      options: [
        { id: `opt-${RAW}`, label: 'First' },
        { id: `opt-${RAW}`, label: 'Second' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const opts = stored.options as any[];
    expect(opts).toHaveLength(1);
  });
});

describe('5c024656 — the J1 echo leg still resolves to reveal handles (the wrap never destroys an echo)', () => {
  // A scanner-KNOWN key in the question with NO deliverSecrets — implicit
  // rescue vaults it and puts [SECRET 1] in the card; the echoes in the
  // option/goal slots must still become the HANDLE (echoScrub runs FIRST),
  // not the destruction marker (the new scan must not break the J1 fix).
  const KNOWN = ['xai-', 'F2Echo', 'Leak', '0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].join('');

  test('echoes of an implicit-rescued span in option label/id/consequence + goalId stay handles', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: `Here is the key: ${KNOWN} — use it as the client key`,
      goalId: `goal-${KNOWN}`,
      todoId: `todo-${KNOWN}`,
      options: [
        { id: `opt-${KNOWN}`, label: `Use ${KNOWN} now`, consequence: `the key ${KNOWN} goes live` },
        { label: 'Cancel' },
      ],
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    const dump = JSON.stringify(stored);
    expect(dump).not.toContain(KNOWN);
    expect(stored.question).toContain('[SECRET 1]');
    expect(dump).not.toContain('[REDACTED: looked like a credential]');
    const opts = stored.options as any[];
    expect(String(opts[0].label)).toContain('[SECRET 1]');
    expect(String(opts[0].id)).toContain('[SECRET 1]');
    expect(String(opts[0].consequence)).toContain('[SECRET 1]');
    expect(String(stored.goalId)).toContain('[SECRET 1]');
    expect(String(stored.todoId)).toContain('[SECRET 1]');
    expect(mockQuestions.secretRows.filter((s: any) => s.questionId === stored.id)).toHaveLength(1);
    const rev = await revealQuestionSecret(prisma, OWNER, stored.id, 1);
    expect(rev).toMatchObject({ ok: true, value: KNOWN });
  });
});

describe('5c024656 — ordinary (non-credential) slots pass byte-identical (no over-redaction)', () => {
  test('a normal option set and goal/todo ids are unchanged', async () => {
    const options = [
      { id: 'opt-go', label: 'Go ahead', consequence: 'the rollout proceeds' },
      { id: 'opt-stop', label: 'Stop', consequence: 'nothing changes' },
    ];
    const goalId = 'fa54f4b9-db30-444e-8e70-1c9c4453e04e';
    const todoId = '55957f4f-27eb-4e13-8ff2-7182bd64fb91';
    const r = await flagOwnerQuestion({
      chatId: CHAT, userId: OWNER,
      question: 'Proceed with the rollout?',
      options: options.map((o) => ({ ...o })),
      goalId, todoId,
    });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const stored = mockQuestions.rows.at(-1)!;
    expect(stored.goalId).toBe(goalId);
    expect(stored.todoId).toBe(todoId);
    const opts = stored.options as any[];
    expect(opts).toHaveLength(2);
    expect(opts[0]).toEqual(options[0]);
    expect(opts[1]).toEqual(options[1]);
    expect(JSON.stringify(stored)).not.toContain('[REDACTED');
  });
});
