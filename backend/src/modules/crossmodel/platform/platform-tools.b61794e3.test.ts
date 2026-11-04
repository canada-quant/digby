/**
 * Ticket b61794e3 — degenerate-stub message BODY guard on send_chat_message,
 * end-to-end through executePlatformTool (the 9a027713 scaffolding discipline:
 * service boundaries mocked at their dynamic-import seams, prisma at
 * config/database).
 *
 * THE INCIDENT (measured 2026-10-30, chat 41bd202a machine wake, run
 * chat-d43eb044): the wake emitted TWO send_chat_message calls in one turn — a
 * real gap-identifier re-plan steer, and a second whose entire body was the
 * single token `placeholder`. The second was DELIVERED into live coding lane
 * 19dd22bc as a steer (receipt 11c181e4, 04:59:34Z), landed as a genuine
 * user-turn message in that lane's transcript, and the supervisor had to spend
 * another send (9cae789a) telling the lane to ignore it.
 *
 * WHAT THIS TICKET IS *NOT* — corrected here from the live rows, because the
 * filed claim ("a stray DUPLICATE partial fragment executed") is not what the
 * telemetry shows, and a test built on the wrong shape would pin nothing:
 *   • The five rejected `todo_update` envelopes in the same window are all
 *     structurally CUT (argLen 17/39, shape 'truncated') and every one was
 *     REFUSED at the parse seam — nothing executed.
 *   • Every finalize row reads `slots:1 named:1 unnamed:0` — there is no twin
 *     slot, no orphan, no second fragment. `gw recv=39 acc=39 drop=0` means we
 *     appended every byte the gateway sent: the severing is upstream.
 *   • The call that DID execute is the opposite shape: a COMPLETE, valid
 *     11-char JSON object. `parseToolArguments` is right to pass it, and the
 *     c42e8099 non-streaming rejection cannot catch it by construction — that
 *     seam refuses MALFORMED args, and these args are well-formed.
 *
 * So the gap is its own class on its own seam: a body carrying no message
 * reached a side-effecting tool. Pinned behavior:
 *   (i)   the VERBATIM incident body ("placeholder") is REFUSED with
 *         NOT-executed prose — no send, no target resolution, nothing queued;
 *   (ii)  exact-normalized matching only: real messages that CONTAIN a stub
 *         token flow through untouched (the fleet/e2e fixtures must keep
 *         flowing — "SWEEP deltas: placeholder family 5/5 closed" is a real
 *         message and must never be refused);
 *   (iii) an EMPTY body is NOT this guard's business (the schema's
 *         `content is required` lane owns it) — the guard must not swallow it;
 *   (iv)  the refusal is recoverable: it names the discarded value and tells
 *         the model to re-call with the real body, so a silent drop can never
 *         happen (the fail-silent shape the 2026-08-30 audit outlaws);
 *   (v)   the truth table over the observed stub vocabulary and the
 *         punctuation/case/whitespace variants of each.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({
  __esModule: true,
  startCodingSession: jest.fn(),
  // The REAL delivery seam for send_chat_message (platform-tools.ts
  // `platform.sendChatMessage`) — mocked so the test can assert it never fires.
  sendChatMessage: jest.fn(async () => ({ queued: true, position: 1 })),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    isOperational = true;
    constructor(public statusCode: number, public message: string) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: {
    getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })),
    // The side-effecting send this guard must keep from ever firing.
    sendMessage: jest.fn(),
  },
}));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const laneSvc = { dispatchTaskToLane: jest.fn(async (): Promise<any> => ({ sent: true })) };
jest.mock('../feedback/ticket-dispatch.service', () => ({ __esModule: true, ...laneSvc }));

const { createPendingConfirmationTable } = require('./pending-confirmations.testkit');
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { pendingConfirmation: mockConfirmations.api } }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'dispatch_platform_task'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => ({ allowedTools: ['send_chat_message'], scheduleCap: 48 })),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(),
  resolveChatTarget: jest.fn(async () => ({ id: '19dd22bc-59ef-42db-845b-92f381a932ae' })),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

import { executePlatformTool, executeConfirmedPlatformTool, placeholderMessageBodyRefusal } from './platform-tools';
import * as platformService from './platform.service';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: '41bd202a-7152-437e-bf4b-a097981692b1', userId: 'u1',
    permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

/** The verbatim incident body — 11 chars, a COMPLETE valid JSON string value. */
const INCIDENT_BODY = 'placeholder';
/** The live coding lane the stub was actually delivered into. */
const TARGET_LANE = '19dd22bc-59ef-42db-845b-92f381a932ae';

describe('ticket b61794e3 — degenerate-stub message-body guard on send_chat_message', () => {
  beforeEach(() => {
    mockConfirmations.reset?.();
    autonomySvc.resolveChatTarget.mockReset().mockResolvedValue({ id: TARGET_LANE });
    autonomySvc.getChatAutonomy.mockReset().mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    autonomySvc.auditAutonomousExecution.mockReset();
  });

  it('(i) the VERBATIM incident replay: a body of "placeholder" is refused — nothing sent, nothing staged, no autonomy lookup', async () => {
    const out = await executePlatformTool(makeCtx(), 'send_chat_message', {
      chatId: TARGET_LANE,
      content: INCIDENT_BODY,
    });
    // NOT-executed prose the claim-evidence extractor can read.
    expect(out).toContain('[tool call rejected]');
    expect(out).toContain('Nothing was sent');
    expect(out).toContain('placeholder');
    // The incident's harm was a DELIVERY — assert no delivery language survives.
    expect(out).not.toMatch(/Delivered|Queued|Sent to|position \d/);
    // The guard sits upstream of the gate: no card was staged and the
    // consequential-tool path (autonomy lookup) was never consulted.
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
    // …and the REAL delivery seam never fired (review finding 7).
    expect((platformService as any).sendChatMessage).not.toHaveBeenCalled();
  });

  it('(i-b) the guard fires for every observed stub shape, naming the discarded body', async () => {
    for (const body of ['placeholder', 'test', 'TODO', 'tbd', 'lorem ipsum', '  placeholder  ']) {
      const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: TARGET_LANE, content: body });
      expect(out).toContain('Nothing was sent');
    }
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
  });

  it('(ii) exact-match only: a real message CONTAINING a stub token flows through untouched (the fleet fixtures must keep flowing)', async () => {
    // Verbatim from the shipped agent-derail-break.4af20b7a fixture — a REAL
    // message that happens to contain the word "placeholder".
    for (const body of [
      'SWEEP deltas: placeholder family 5/5 closed; queue drained.',
      'Regression: the placeholder text in the transcription card renders raw',
      'placeholder handling is now exact-match, see the guard',
    ]) {
      expect(placeholderMessageBodyRefusal(body)).toBeNull();
    }
  });

  it('(iii) an EMPTY body is not this guard\'s business — the schema\'s content-is-required lane owns it', () => {
    expect(placeholderMessageBodyRefusal('')).toBeNull();
    expect(placeholderMessageBodyRefusal('   ')).toBeNull();
    expect(placeholderMessageBodyRefusal(undefined)).toBeNull();
    expect(placeholderMessageBodyRefusal(null)).toBeNull();
    expect(placeholderMessageBodyRefusal(42 as unknown as string)).toBeNull();
  });

  it('(iv) the refusal is RECOVERABLE — it names the value and tells the model how to re-call (never a silent drop)', async () => {
    const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: TARGET_LANE, content: 'placeholder' });
    expect(out).toContain('Re-call send_chat_message with the real body');
    // and it never echoes a body it did not receive
    expect(placeholderMessageBodyRefusal('placeholder')).toContain('placeholder');
  });

  it('(v) truth table: bare stub tokens refuse; punctuation/case/whitespace variants refuse; substantive bodies pass', () => {
    const refuses = [
      'test', 'TEST', 'Test!', 'placeholder', 'PLACEHOLDER.', ' todo ', 'tbd', 'tbc', 'wip',
      'junk', 'dummy', 'sample', 'example', 'demo', 'asdf', 'qwerty', 'lorem ipsum', 'none',
      'n/a', 'noop', 'no-op', 'fixme', 'fix me', 'fix this', 'xxx', 'yyy', 'zzz', 'aaa',
      'bbb', '111', '123', '1234', 'placeholder message', 'message placeholder',
      'placeholder text', 'test message', 'stub', 'stub message', 'test test',
      // punctuation-only variants that normalize INTO a token (review finding 2)
      '#123', '(123)', '123.', 'TODO:',
    ];
    for (const body of refuses) {
      expect(placeholderMessageBodyRefusal(body)).not.toBeNull();
    }
    const passes = [
      'Re-plan: todo e7bebd4a needs the note carried in a steer instead.',
      'Delivered.', 'ok', 'Done — deploy 41002696540 concluded success.',
      'placeholder family 5/5 closed', 'Use a placeholder only when the id is unknown.',
    ];
    for (const body of passes) {
      expect(placeholderMessageBodyRefusal(body)).toBeNull();
    }
  });

  it('(vi) judges what is DELIVERED, not the raw arg: a numeric/array stub is refused too (review finding 2)', () => {
    // The executors deliver String(args?.content || ''), so the guard must
    // coerce identically — otherwise 123 (number) and ['test'] slip past a
    // guard that refuses the STRING '123' / 'test'.
    for (const raw of [123, ['test'], 'test', 123 as unknown]) {
      expect(placeholderMessageBodyRefusal(raw)).not.toBeNull();
    }
    // …while a genuinely empty/non-informative-to-normalize value stays exempt.
    expect(placeholderMessageBodyRefusal('')).toBeNull();
    expect(placeholderMessageBodyRefusal([])).toBeNull();
    expect(placeholderMessageBodyRefusal(null)).toBeNull();
  });

  it('(vii) the CONFIRMED seam refuses too — a pre-shipped card cannot deliver a stub on the owner\'s click (review finding 3)', async () => {
    const out = await executeConfirmedPlatformTool(makeCtx(), 'send_chat_message', {
      chatId: TARGET_LANE,
      content: INCIDENT_BODY,
    });
    expect(out).toContain('[tool call rejected]');
    expect(out).toContain('Nothing was sent');
  });

  it('(viii) the PEER channel is covered by the same predicate: send_to_instance refuses a stub message (review finding 1)', async () => {
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', {
      instanceId: 'inst-1',
      chatId: 'edge-chat-1',
      message: 'placeholder',
    });
    expect(out).toContain('[tool call rejected]');
    expect(out).toContain('Nothing was sent');
    // a real message on the peer channel still flows (the guard is exact-match)
    expect(placeholderMessageBodyRefusal('Sync complete: 3 docs filed.', 'message')).toBeNull();
  });
});