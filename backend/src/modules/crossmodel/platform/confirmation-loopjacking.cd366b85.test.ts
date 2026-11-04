/**
 * Replay pin — R&D stream-3 test-bench experiment #4 (goal b3f240e4, todo
 * cd366b85): Loopjacking (arXiv:2609.21081, "Loopjacking: Hijacking
 * Human-in-the-Loop Approval") vs Digby's staged-confirmation flow.
 *
 * MEASURED VERDICT (2026-09-21, lane b92ef13f) — the paper's two classes:
 *
 *  CORE CLASS (post-approval payload mutation / confirm-then-swap /
 *  confirmationId reuse) — REFUTED by construction:
 *    · args are deep-frozen into the DB row at registration
 *      (pending-confirmations.ts registerPendingConfirmation: structuredClone),
 *      and NO code path updates a pending row's args/tool/summary (the only
 *      writes are status/resolvedAt/result flips);
 *    · confirmationIds are cf_<randomUUID> minted per staging — no reuse;
 *    · the model re-call path executes the STAGED args and ignores the
 *      re-call's own — pinned in platform-tools.test.ts ("A later user turn
 *      re-calls with the confirmationId but SWAPPED content — the swapped
 *      args are ignored entirely; only the staged args execute");
 *    · the REST confirm path executes row.tool/row.args — the client supplies
 *      nothing but the id — pinned in confirmations.controller.test.ts
 *      ("owner + pending → one-shot consume → executes the STORED args (never
 *      client input)" with a hostile body carrying substituted args);
 *    · an injected turn can never confirm at all (user-turn anchor; machine
 *      runs carry no userTurnAt — fail-closed).
 *
 *  REPRESENTATION CLASS (what the owner approves ≠ what executes) — REAL,
 *  FIXED: summarizeConsequentialCall and stageAccountTool clipped
 *  user-authored payload fields at ~100 chars SILENTLY, so the pending-action
 *  card showed a benign-looking prefix while the full staged body executed on
 *  Confirm. Fix: every preview clip now carries the hidden count and an
 *  explicit "the FULL staged text executes on Confirm" marker
 *  (confirmation-summary.ts clipStagedPayloadPreview).
 *
 * These tests pin BOTH layers so a regression in either fails loudly.
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

/** In-memory pendingConfirmation table — the DB-backed confirmation registry. */
const mockConfirmations = createPendingConfirmationTable();
/** Owner-question testkit tables — reused here only for the crossModelMessage /
 *  crossModelChat shapes the moot checker reads (empty ⇒ never moot). */
const mockOwnerQuestions = createOwnerQuestionTable();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
    // (the stageAccountTool create_feed precondition read userFeed.count —
    //  retired with the feeds subsystem, 43c24152)
    chatCodingState: { findUnique: async () => null },
    projectMember: { findMany: async () => [] },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Static edges of the platform-tools graph — the real modules pull config/env
// (process.exit at import in jest workers). platform.service is auto-stubbed:
// the suites here never execute a tool, but module-scope references must not
// explode at import time.
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read',
    'chats:write',
    'folders:read',
    'folders:write',
    'schedules:write',
    'code:run',
  ] as const,
}));
jest.mock('./platform.service', () =>
  new Proxy({ __esModule: true } as any, {
    get: (t, k) => (k in (t as any) ? (t as any)[k] : jest.fn(async () => null)),
  }),
);
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  // Read at MODULE SCOPE by the tool schema — mirror the real constant.
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
}));
// Dynamic-import boundaries on some registry paths — mocked so the suite
// stays hermetic (never reached by these tests).
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: async () => {},
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

beforeEach(() => { mockConfirmations.reset(); mockOwnerQuestions.reset(); });

import { clipStagedPayloadPreview } from './confirmation-summary';
import { summarizeConsequentialCall } from './platform-tools';
import { consumePendingConfirmation, registerPendingConfirmation } from './pending-confirmations';
import { stageAccountTool } from './account-tools';

const EXECUTES_WARNING = 'the FULL staged text executes on Confirm';

describe('loopjacking core class — the byte-binding (refuted; pinned)', () => {
  it('freezes staged args at registration: mutating the caller object afterwards never reaches the stored row', async () => {
    const args: any = { chatId: 'c1', content: 'original body', nested: { items: ['a'] } };
    const reg = await registerPendingConfirmation({
      sessionId: 's1', userId: 'u1', tool: 'send_chat_message', args, summary: 's',
    });
    // The registering turn's loop keeps holding (and could mutate) the same object.
    args.content = 'MUTATED';
    args.nested.items.push('INJECTED');
    const stored = mockConfirmations.rows.find((r) => r.id === reg.confirmationId);
    expect(stored).toBeTruthy();
    expect(stored.args).toEqual({ chatId: 'c1', content: 'original body', nested: { items: ['a'] } });
  });

  it('confirmationIds are unique per staging (no id reuse across identical payloads)', async () => {
    const mk = () => registerPendingConfirmation({
      sessionId: 's1', userId: 'u1', tool: 'send_chat_message', args: { chatId: 'c1', content: 'same' }, summary: 's',
    });
    const a = await mk();
    const b = await mk();
    expect(a.confirmationId).not.toBe(b.confirmationId);
    expect(mockConfirmations.rows).toHaveLength(2);
  });

  it('consume returns the STAGED args (WYSIWYG) and burns one-shot — a double confirm can never re-execute', async () => {
    const stagedArgs = { chatId: 'c1', content: 'approved body' };
    const reg = await registerPendingConfirmation({
      sessionId: 's1', userId: 'u1', tool: 'send_chat_message', args: stagedArgs, summary: 's',
    });
    // The confirming re-call comes from a LATER real user turn. consume's
    // signature has NO args channel at all — a hostile re-call cannot smuggle
    // substituted payload through it; the stored row's args come back.
    const ok = await consumePendingConfirmation({
      confirmationId: reg.confirmationId, sessionId: 's1', tool: 'send_chat_message',
      userTurnAt: new Date(Date.now() + 60_000),
    });
    expect(ok).toEqual({ ok: true, args: stagedArgs });
    const again = await consumePendingConfirmation({
      confirmationId: reg.confirmationId, sessionId: 's1', tool: 'send_chat_message',
      userTurnAt: new Date(Date.now() + 120_000),
    });
    expect(again.ok).toBe(false); // already consumed — one-shot flip held
  });

  it('a machine-triggered re-call (no userTurnAt) can NEVER confirm — fail-closed', async () => {
    const reg = await registerPendingConfirmation({
      sessionId: 's1', userId: 'u1', tool: 'send_chat_message', args: { chatId: 'c1', content: 'x' }, summary: 's',
    });
    const r = await consumePendingConfirmation({
      confirmationId: reg.confirmationId, sessionId: 's1', tool: 'send_chat_message',
      userTurnAt: undefined,
    });
    expect(r).toEqual({ ok: false, reason: 'no_user_turn' });
    // …and the pending is NOT burned by the failed attempt (the owner can still confirm).
    expect(mockConfirmations.rows.find((x) => x.id === reg.confirmationId)?.status).toBe('pending');
  });
});

describe('loopjacking representation class — honest truncation (the fix)', () => {
  it('clipStagedPayloadPreview: at/under the cap the text passes byte-exact, unmarked', () => {
    expect(clipStagedPayloadPreview('short text', 100)).toBe('short text');
    expect(clipStagedPayloadPreview('x'.repeat(100), 100)).toBe('x'.repeat(100));
    expect(clipStagedPayloadPreview(undefined, 100)).toBe('');
    // Whitespace normalization before clipping — the pre-existing semantics.
    expect(clipStagedPayloadPreview('a   b\n\nc', 100)).toBe('a b c');
  });

  it('clipStagedPayloadPreview: over the cap carries the hidden count + the executes warning', () => {
    expect(clipStagedPayloadPreview('x'.repeat(101), 100))
      .toBe(`${'x'.repeat(100)} …[+1 chars not shown — ${EXECUTES_WARNING}]`);
  });

  it('send_chat_message summary marks a clipped content payload; short content keeps the pre-fix byte shape', () => {
    const long = summarizeConsequentialCall('send_chat_message', { chatId: 'c1', content: 'x'.repeat(5000) });
    expect(long).toContain('[+4900 chars not shown');
    expect(long).toContain(EXECUTES_WARNING);
    expect(summarizeConsequentialCall('send_chat_message', { chatId: 'c1', content: 'hello owner' }))
      .toBe('Send this message to chat c1 as you: "hello owner"');
  });

  it('schedule_message summary marks a clipped prompt (the persistence primitive)', () => {
    const s = summarizeConsequentialCall('schedule_message', {
      chatId: 'c1', kind: 'recurring', intervalMinutes: 60, prompt: 'p'.repeat(300),
    });
    expect(s).toContain('every 60 minutes');
    expect(s).toContain('[+200 chars not shown');
    expect(s).toContain(EXECUTES_WARNING);
  });

  it('start_coding_session summary marks a clipped title (the 60-char field)', () => {
    const s = summarizeConsequentialCall('start_coding_session', { projectId: 'p1', title: 't'.repeat(80) });
    expect(s).toContain('[+20 chars not shown');
  });

  it('DISCRIMINATOR: payloads identical in the visible prefix but different in the hidden tail summarize DIFFERENTLY (pre-fix: identical — the seam)', () => {
    const head = 'Daily digest is ready for review. '.repeat(4).slice(0, 100); // exactly the 100 visible chars
    const sa = summarizeConsequentialCall('send_chat_message', { chatId: 'c1', content: head + 'A'.repeat(4000) });
    const sb = summarizeConsequentialCall('send_chat_message', { chatId: 'c1', content: head + 'B'.repeat(900) });
    expect(sa).not.toBe(sb);
    expect(sa).toContain('[+4000 chars not shown');
    expect(sb).toContain('[+900 chars not shown');
  });

  // (The stageAccountTool create_feed truncation case was retired with the
  // feeds subsystem, 43c24152. The byte-binding / honest-truncation contract
  // it covered is still pinned by the summaries tests above — the account
  // tools that remain (create_share_link) stage short, bounded args.)
});
