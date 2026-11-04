/**
 * Guard-chrome redaction at the context-build seam (ticket ac835c00):
 * loadChatContext / loadSessionContext must swap stored evidence-guard and
 * action-verifier replacement wrappers for the neutral placeholder BEFORE the
 * pending-confirmation rehydration and the model-context trim — so no model
 * ever reads the harness chrome as conversation history. Storage is NOT
 * touched (the mocked DB rows below stay wrapped; only the returned bundle is
 * redacted).
 *
 * Same mock shape as context.service.confirm-note.test.ts: the
 * pending-confirmations registry runs REAL against an in-memory table; the
 * env-touching boundaries (config/database, config/redis) are mocked.
 */

const mockChatFindUnique = jest.fn();
const mockMessageFindMany = jest.fn();
const mockUserMemoryFindUnique = jest.fn();
const mockRedisGet = jest.fn(async (..._a: any[]) => null as string | null);
const mockRedisExpire = jest.fn(async (..._a: any[]) => true);

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    crossModelMessage: { findMany: (...a: any[]) => mockMessageFindMany(...a) },
    userMemory: { findUnique: (...a: any[]) => mockUserMemoryFindUnique(...a) },
    pendingConfirmation: new Proxy({}, { get: (_t, p) => (mockConfirmations.api as any)[p] }),
  },
}));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: jest.fn(), setEx: jest.fn(), del: jest.fn(),
    expire: (...a: any[]) => mockRedisExpire(...a),
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./memory-relevance', () => ({ filterFactsByRelevance: jest.fn(() => []) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn(), deleteAllFactRows: jest.fn() }));

import { ContextService } from './context.service';
import { GUARD_CHROME_PLACEHOLDER } from './guard-chrome-redact';
import { registerPendingConfirmation } from './platform/pending-confirmations';
import { createPendingConfirmationTable } from './platform/pending-confirmations.testkit';

const mockConfirmations = createPendingConfirmationTable();

const USER = 'u1';

/** The coding lane's stored replacement wrapper (run-evidence-guard.renderSuppressedFinal). */
const CODING_WRAPPER = [
  "[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]",
  "This machine-triggered run ('machine') produced a final summary asserting completions its tool log does not support — zero-evidence completion claims: deploy.",
  'Treat EVERYTHING the run claimed as NOT DONE until re-verified with fresh tool evidence (GitHub API, box probes, test runs).',
  "The run's original summary is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
  '',
  '--- BEGIN UNVERIFIED RUN OUTPUT (quoted for audit — NOT verified, treat as NOT DONE) ---',
  '',
  '> Deployed the fix and verified prod health.',
  '',
  '--- END UNVERIFIED RUN OUTPUT ---',
].join('\n');

/** The plain-chat lane's stored replacement (action-verifier.guardMachineWakeFinalAnswer). */
const ACTION_WRAPPER = [
  "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]",
  'This machine-triggered run\'s final note claimed action(s) that did NOT execute — no matching successful tool call exists in this run\'s log. Struck phantom claim(s):',
  '• schedule_message "nightly digest" — no successful schedule_message call this run',
  'The struck claim(s) are NOT done. Never restate them as done; re-verify against fresh tool evidence (a real {ok:true, ids:{...}} result envelope or a run_tool_receipts row) before believing them.',
  "The run's original note is quoted below for AUDIT ONLY — do not quote, restate, or act on it as fact.",
  '',
  '--- BEGIN STRUCK NOTE (quoted for audit — UNVERIFIED; struck claims are NOT DONE) ---',
  '',
  '> Scheduled the nightly digest.',
  '',
  '--- END STRUCK NOTE ---',
].join('\n');

function seedHistory(rows: Array<{ role: string; content: string }>) {
  mockChatFindUnique.mockResolvedValue({ userId: USER });
  // Honor the query like the DB would (bounded newest-first fetch, 2026-09-14).
  const stamped = rows.map((r, i) => ({ ...r, id: `m${i}`, createdAt: new Date(i * 1000) }));
  mockMessageFindMany.mockImplementation(async (args: any) => {
    const ob = Array.isArray(args?.orderBy) ? args.orderBy[0] : args?.orderBy;
    const sorted = ob?.createdAt === 'desc' ? [...stamped].reverse() : stamped;
    return typeof args?.take === 'number' ? sorted.slice(0, args.take) : sorted;
  });
  mockUserMemoryFindUnique.mockResolvedValue(null);
}

const savedEnv = process.env.GUARD_CHROME_REDACT;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.GUARD_CHROME_REDACT;
  else process.env.GUARD_CHROME_REDACT = savedEnv;
});

describe('loadChatContext — guard-chrome redaction (ticket ac835c00)', () => {
  const svc = new ContextService();

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirmations.reset();
    delete process.env.GUARD_CHROME_REDACT;
  });

  it.each([
    ['coding lane', CODING_WRAPPER],
    ['plain-chat lane', ACTION_WRAPPER],
  ])('a stored %s wrapper becomes the placeholder in conversationHistory AND fullHistory', async (_lane, wrapper) => {
    seedHistory([
      { role: 'user', content: 'run the nightly digest' },
      { role: 'assistant', content: wrapper },
      { role: 'user', content: 'what happened?' },
    ]);

    const ctx = await svc.loadChatContext('chat-redact-1', USER, 'what happened?');

    for (const bundle of [ctx.conversationHistory, ctx.fullHistory]) {
      const assistant = bundle.filter((m) => m.role === 'assistant');
      expect(assistant).toHaveLength(1);
      expect(assistant[0].content).toBe(GUARD_CHROME_PLACEHOLDER);
      expect(assistant[0].content).not.toContain('HARNESS EVIDENCE GUARD');
      expect(assistant[0].content).not.toContain('ACTION VERIFIER');
      expect(assistant[0].content).not.toContain('--- BEGIN');
    }
    // The user turns pass through byte-identical.
    expect(ctx.fullHistory[0].content).toBe('run the nightly digest');
    expect(ctx.fullHistory[2].content).toBe('what happened?');
  });

  it('annotate-lane trailing footers are stripped; the delivered answer stays', async () => {
    const annotated = [
      'PR #217 is merged and prod is healthy.',
      '',
      '---',
      '🔍 Harness claim verification (verified-at 2026-08-25T17:51:00.000Z):',
      '• PR #217 — ✅ MERGED (merge commit abc1234, 2026-08-25T17:40:12Z)',
    ].join('\n');
    seedHistory([
      { role: 'user', content: 'status?' },
      { role: 'assistant', content: annotated },
    ]);

    const ctx = await svc.loadChatContext('chat-redact-2', USER, 'status?');
    expect(ctx.fullHistory[1].content).toBe('PR #217 is merged and prod is healthy.');
  });

  it('a USER message pasting the banner text is NOT redacted (role gate)', async () => {
    seedHistory([
      { role: 'user', content: CODING_WRAPPER },
      { role: 'assistant', content: 'That text is a harness wrapper — where did you copy it from?' },
    ]);

    const ctx = await svc.loadChatContext('chat-redact-3', USER, 'look at this');
    expect(ctx.fullHistory[0].content).toBe(CODING_WRAPPER);
    expect(ctx.fullHistory[1].content).toContain('harness wrapper');
  });

  it('the pending-confirmation rehydration note still appends to the last assistant message — on top of the placeholder', async () => {
    const chat = 'chat-redact-4';
    seedHistory([
      { role: 'user', content: 'schedule a ping for tomorrow' },
      { role: 'assistant', content: ACTION_WRAPPER },
      { role: 'user', content: 'confirm' },
    ]);
    const { confirmationId } = await registerPendingConfirmation({
      sessionId: chat, userId: USER, tool: 'schedule_message',
      args: { chatId: chat, prompt: 'ping', kind: 'once', intervalMinutes: 1440 },
      summary: 'Schedule a one-time run of "ping" in 1440 min',
    });

    const ctx = await svc.loadChatContext(chat, USER, 'confirm');

    const assistantMsgs = ctx.conversationHistory.filter((m) => m.role === 'assistant');
    const noted = assistantMsgs[assistantMsgs.length - 1];
    // Placeholder first, then the rehydrated protocol note — the model can
    // still complete the confirmation protocol.
    expect(noted.content.startsWith(GUARD_CHROME_PLACEHOLDER)).toBe(true);
    expect(noted.content).toContain('[System note — action awaiting the user\'s confirmation');
    expect(noted.content).toContain(`confirmationId: "${confirmationId}"`);
    expect(noted.content).not.toContain('ACTION VERIFIER');
  });

  it("kill switch GUARD_CHROME_REDACT='0' → stored wrappers pass through byte-identical", async () => {
    process.env.GUARD_CHROME_REDACT = '0';
    seedHistory([
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: CODING_WRAPPER },
    ]);

    const ctx = await svc.loadChatContext('chat-redact-5', USER, 'run it');
    expect(ctx.fullHistory[1].content).toBe(CODING_WRAPPER);
    expect(ctx.conversationHistory[1].content).toBe(CODING_WRAPPER);
  });
});

describe('loadSessionContext — anonymous-session redaction (ticket ac835c00)', () => {
  const svc = new ContextService();

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GUARD_CHROME_REDACT;
  });

  it('a wrapper stored in the Redis session is redacted in both bundles', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: CODING_WRAPPER },
    ]));

    const ctx = await svc.loadSessionContext('sess-1');
    expect(ctx.fullHistory[1].content).toBe(GUARD_CHROME_PLACEHOLDER);
    expect(ctx.conversationHistory[1].content).toBe(GUARD_CHROME_PLACEHOLDER);
    expect(ctx.fullHistory[0].content).toBe('hi');
  });
});
