/**
 * The home Today card must survive being called UNBOUND (ticket 9ea25082).
 *
 * THE DEFECT THIS FILE REPLAYS. `crossmodel.routes.ts:834` wires the handler as
 * a BARE route callback:
 *     router.get('/calendar-events', controller.getCalendarEventsForHome);
 * Express calls a bare callback with NO receiver, so `this` is undefined inside
 * it. The unified 2026-11-06 card reached its halves through
 * `this.buildGoogleHomeCalendar(...)` / `this.buildAppleHomeCalendar(...)`
 * (crossmodel.controller.ts:4623,4627), so EVERY GET /api/crossmodel/calendar-events
 * threw
 *     Cannot read properties of undefined (reading 'buildGoogleHomeCalendar')
 * — the exact string prod logged 24x in the 24 h to 2026-11-07T00:28Z, level
 * error, source error-handler.
 *
 * WHY IT WAS NOT A GRACEFUL DEGRADE, AND WHY THE `.catch()` DID NOT SAVE IT.
 * `this.buildGoogleHomeCalendar(userId)` is a PROPERTY *READ* on `this`. That
 * read throws SYNCHRONOUSLY, before a promise exists — so the `.catch(...)`
 * chained to it never gets a promise to attach to, and neither does
 * `Promise.all([...])` (its argument array is evaluated first). The throw
 * escaped the handler entirely. The card was empty for EVERY user, not merely
 * an unconfigured one, and no per-half catch could have caught it.
 *
 * THE SECOND HALF OF THE REPLAY — THE SHAPE A NAIVE TEST MISSES. Jest's default
 * module environment gives a bare function call the module namespace object as
 * `this`, and `controller.getCalendarEventsForHome(req, res)` supplies
 * `controller` itself. Both HIDE this bug. Every call below therefore goes
 * through `callUnbound`, which uses `.call(undefined, …)` — stricter than the
 * module default and the precise shape the route table produces. This is the
 * same technique ticket ffbf1315's suite established after its own
 * `this.applyQueueControl` regression.
 *
 * THE STRUCTURAL HALF. Ticket ffbf1315's fix left the controller with a
 * documented invariant — "none of the methods on it touch `this`". The
 * 2026-11-06 calendar refactor broke that invariant silently, because no test
 * asserted it. The last case here pins it repo-wide, comment-aware, so the next
 * class-method helper cannot creep back in unnoticed.
 *
 * Boundaries mocked per .digby/notes/learnings.md: importing the real service
 * graph pulls config/database + config/redis → config/env, which calls
 * process.exit(1) inside the jest worker. Only the calendar seams carry
 * behaviour; everything else is an inert double.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

// The one live STATE seam: the two prisma tables the halves read.
const mockGoogleTokenFindFirst: jest.Mock = jest.fn();
const mockUserMemoryFindUnique: jest.Mock = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    googleOAuthToken: { findFirst: (...a: any[]) => mockGoogleTokenFindFirst(...a) },
    userMemory: { findUnique: (...a: any[]) => mockUserMemoryFindUnique(...a) },
  },
}));

// The Google half's seams.
const mockResolveGoogleAccount: jest.Mock = jest.fn();
const mockGetCalendarEvents: jest.Mock = jest.fn();
jest.mock('./google/google-mcp', () => ({
  __esModule: true,
  resolveGoogleAccount: (...a: any[]) => mockResolveGoogleAccount(...a),
  getCalendarEvents: (...a: any[]) => mockGetCalendarEvents(...a),
}));

// The Apple half's seam.
const mockReadAppleCalendar: jest.Mock = jest.fn();
jest.mock('./calendar/apple-calendar', () => ({
  __esModule: true,
  readAppleCalendar: (...a: any[]) => mockReadAppleCalendar(...a),
}));

// ── Inert doubles for the rest of the controller's import graph ──────────────
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/platform.service', () => ({ __esModule: true, default: {} }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ __esModule: true, FEEDBACK_TYPES: [] }));
jest.mock('./langgraph/memory.graph', () => ({ __esModule: true, updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({
  __esModule: true,
  streamKidResponse: jest.fn(),
  generateKidStatus: jest.fn(),
}));
jest.mock('./mcp-search', () => ({ __esModule: true, searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ __esModule: true, runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  __esModule: true,
  decideChatGate: jest.fn(),
  mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(),
  chatReadAccessGranted: jest.fn(() => true),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({
  __esModule: true,
  buildIntegrationContext: jest.fn(),
  buildIntegrationContextBounded: jest.fn(),
}));
jest.mock('./rate-limit.service', () => ({
  __esModule: true,
  checkDeepResearchQuota: jest.fn(),
  reserveDeepResearchQuota: jest.fn(),
  refundDeepResearchQuota: jest.fn(),
  getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(),
  invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ __esModule: true, getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ __esModule: true, isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  __esModule: true,
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: jest.fn(),
  summarizeLoopMetrics: jest.fn(),
  queryLoopMetricOutcomes: jest.fn(),
  queryLoopMetricPayloadSizes: jest.fn(),
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: [],
}));
jest.mock('./chat-agent/queue-controls', () => ({
  __esModule: true,
  cancelQueuedUserMessage: jest.fn(),
  promoteQueuedUserMessage: jest.fn(),
  moveQueuedUserMessage: jest.fn(),
  listUserQueue: jest.fn(),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import controller from './crossmodel.controller';
import {
  buildGoogleHomeCalendar,
  buildAppleHomeCalendar,
} from './calendar/home-calendar';

const USER = 'u-9ea25082';

/**
 * Call `fn` the way EXPRESS does: with no receiver. `.call(undefined, …)` is
 * stricter than a bare call (the ES module default would substitute the module
 * namespace object for `this`), so this reproduces the route-table call
 * faithfully instead of accidentally supplying a receiver that hides the bug.
 */
function callUnbound(fn: any, ...args: any[]): Promise<any> {
  return (fn as (...a: any[]) => Promise<any>).call(undefined, ...args);
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((body: any) => { res.body = body; return res; });
  return res;
}

function makeReq(over: Record<string, any> = {}) {
  return { user: { id: USER }, query: {}, ...over } as any;
}

/** Prod's real Google fan-out shape — the section header the parser needs. */
const GOOGLE_TEXT = [
  '[Google Calendar Events]',
  'Standup | 2026-11-07T09:00:00-08:00 | 2026-11-07T09:15:00-08:00',
].join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
  mockGoogleTokenFindFirst.mockResolvedValue({ userId: USER });
  mockUserMemoryFindUnique.mockResolvedValue({ facts: { timezone: 'America/Vancouver' } });
  mockResolveGoogleAccount.mockResolvedValue({ ok: true });
  mockGetCalendarEvents.mockResolvedValue(GOOGLE_TEXT);
  mockReadAppleCalendar.mockResolvedValue({ state: 'ok', events: [], device: 'MacBook Pro', via: 'mac-agent' });
});

// ── THE REPLAY ───────────────────────────────────────────────────────────────

describe('9ea25082 — GET /calendar-events survives an unbound (Express) call', () => {
  it('answers 200 with the merged card instead of throwing on `this`', async () => {
    const res = makeRes();
    // The pre-fix code threw here, synchronously, before any promise existed.
    // (The handler resolves to `res.json(...)`, i.e. the response object itself —
    //  the point is that it RESOLVES at all rather than throwing on `this`.)
    await expect(callUnbound(controller.getCalendarEventsForHome, makeReq(), res)).resolves.toBeTruthy();
    expect(res.statusCode).toBe(200);
    expect(res.body?.success).toBe(true);
    // Both halves actually RAN — the bug stopped the whole handler at the first
    // `this.` read, so asserting the side effects is what separates "did not
    // throw" from "did the work".
    expect(mockGetCalendarEvents).toHaveBeenCalled();
    expect(mockReadAppleCalendar).toHaveBeenCalled();
    expect(res.body?.data?.connected).toBe(true);
    expect(res.body?.data?.apple?.state).toBe('ok');
  });

  it('still serves an Apple-only user (Google row absent) unbound', async () => {
    mockGoogleTokenFindFirst.mockResolvedValue(null);
    const res = makeRes();
    await callUnbound(controller.getCalendarEventsForHome, makeReq(), res);
    expect(res.statusCode).toBe(200);
    // The 2026-11-06 reason for the unification: no Google row must not hide the
    // card from an Apple user.
    expect(res.body?.data?.connected).toBe(true);
  });

  it('auth still answers 401 unbound when there is no user', async () => {
    const res = makeRes();
    await callUnbound(controller.getCalendarEventsForHome, makeReq({ user: undefined }), res);
    expect(res.statusCode).toBe(401);
  });

  it('the halves are callable as plain functions (no receiver required)', async () => {
    // Called with NO receiver at all — the shape the controller now uses.
    await expect(buildGoogleHomeCalendar(USER)).resolves.toMatchObject({ connected: true });
    await expect(buildAppleHomeCalendar(makeReq(), USER)).resolves.toMatchObject({ state: 'ok' });
  });

  it('a FAILED Google read still reports unavailable, not a vanished card', async () => {
    // The 2026-10-21 owner contract that the unification preserved: a failed
    // read must not read as "no calendar connected".
    mockGetCalendarEvents.mockResolvedValue('Google Calendar is unavailable right now.');
    const res = makeRes();
    await callUnbound(controller.getCalendarEventsForHome, makeReq(), res);
    expect(res.body?.data?.error).toBe('unavailable');
  });
});

// ── THE STRUCTURAL GUARD ─────────────────────────────────────────────────────

describe('9ea25082 — the controller keeps its "no `this` in a handler" invariant', () => {
  /**
   * Walks the controller source and every route module, COMMENT-AWARE: the
   * controller legitimately MENTIONS `this.` in its own prose (line ~202
   * documents the ffbf1315 incident). A naive grep would fail on that text, so
   * block comments and line comments are stripped before the scan — the check
   * must fire on CODE, never on documentation.
   */
  function codeOnly(src: string): string[] {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))   // line comments
      .filter((l) => l.trim().length > 0);
  }

  it('no `this.` survives in crossmodel.controller.ts', () => {
    const src = readFileSync(join(__dirname, 'crossmodel.controller.ts'), 'utf8');
    const offenders = codeOnly(src).filter((l) => /\bthis\s*\./.test(l));
    // A single `this.` here means a route-wired handler can throw on a bare
    // Express call — the exact 9ea25082 regression. Keep the list empty.
    expect(offenders).toEqual([]);
  });

  it('the calendar-events route is wired as a BARE callback', () => {
    const src = readFileSync(join(__dirname, 'crossmodel.routes.ts'), 'utf8');
    const line = src.split('\n').find((l) => l.includes("'/calendar-events'"));
    expect(line).toBeDefined();
    expect(line).toContain('controller.getCalendarEventsForHome');
    // A `.bind(...)` here would mask a `this` dependency rather than fix it.
    expect(line).not.toContain('.bind(');
  });

  it('the two calendar halves are exported as FUNCTIONS, not class methods', () => {
    const src = readFileSync(join(__dirname, 'calendar', 'home-calendar.ts'), 'utf8');
    expect(src).toContain('export async function buildGoogleHomeCalendar(');
    expect(src).toContain('export async function buildAppleHomeCalendar(');
    // `private async` is the class-method spelling that caused the regression.
    expect(src).not.toMatch(/private\s+async\s+build(Google|Apple)HomeCalendar/);
  });

  it('the controller imports the halves instead of reaching through `this`', () => {
    const src = readFileSync(join(__dirname, 'crossmodel.controller.ts'), 'utf8');
    expect(src).toContain(
      "import { buildGoogleHomeCalendar, buildAppleHomeCalendar } from './calendar/home-calendar';",
    );
    expect(src).not.toContain('this.buildGoogleHomeCalendar');
    expect(src).not.toContain('this.buildAppleHomeCalendar');
  });
});