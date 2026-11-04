/**
 * integration-context — X fetch failures are never silently dropped (ticket
 * fa956f09, 2026-09-24).
 *
 * The 2026-09-22 outage, in this file's terms: the digest lane's message
 * triggered the X intents; every x-mcp read leg returned null (platform-side
 * gateway failure); the allSettled filter dropped them ALL; the model saw
 * "Loading X data..." stream and then NOTHING — no error, no data, and the
 * answer was built as if X simply had nothing to say. The fix: failed legs
 * (null or rejected) become an explicit ⚠ context part telling the model the
 * X read failed and what to tell the user.
 *
 * Suite strategy: the X injection block is inside buildIntegrationContext's
 * ~470-line orchestration (Google→GitHub→X→Slack→Asana→Xero→Plaid→iMessage),
 * which needs every env var + prisma model + SSE stubbed. We mock the leaf
 * seams (prisma, logger, intent-detector, x-mcp) and drive the real
 * orchestration with ONLY X-relevant intents so the other blocks no-op.
 *
 * Boundaries mocked per .digby/notes/learnings.md (config/database pulls
 * config/env, which exits the process at import).
 */

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    googleOAuthToken: { findFirst: jest.fn(async () => null) },
    gitHubOAuthToken: { findFirst: jest.fn(async () => null) },
    xOAuthToken: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    xeroOAuthToken: { findFirst: jest.fn(async () => null) },
    plaidAccessToken: { findFirst: jest.fn(async () => null) },
    slackOAuthToken: { findFirst: jest.fn(async () => null) },
    asanaOAuthToken: { findFirst: jest.fn(async () => null) },
    telegramLink: { findFirst: jest.fn(async () => null) },
    integrationHealth: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => null) },
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// intent-detector: recognize ONLY X search + trends so the other integrations'
// injection blocks (each gated on their own env var / detection) stay off.
jest.mock('./x/intent-detector', () => ({
  __esModule: true,
  detectXIntent: () => ({ search: true, trends: true, profile: false, tweet: false, post: false, reply: false, like: false, retweet: false, follow: false }),
  hasReadIntent: () => true,
  hasAnyXIntent: () => true,
  extractXContext: () => ({ searchQuery: 'AI' }),
}));
jest.mock('./x/x-mcp', () => ({
  __esModule: true,
  getUserProfile: jest.fn(),
  getTweet: jest.fn(),
  search: jest.fn(),
  getTrends: jest.fn(),
}));
// The iMessage block runs for every signed-in user and dynamically imports
// imessage.service → config/redis → config/env (which process.exit()s at
// import in tests). Mock the leaf so the orchestration stays importable.
jest.mock('./imessage/imessage.service', () => ({
  __esModule: true,
  getPrimaryAgent: jest.fn(async () => null),
  isOnline: jest.fn(() => false),
}));

import { buildIntegrationContext } from './integration-context';
import * as xMcp from './x/x-mcp';

const events: Array<{ type: string; data: any }> = [];
const sendEvent = (type: string, data: any) => events.push({ type, data });

beforeAll(() => {
  // X block gated on X_MCP_API_KEY; Google on GOOGLE_OAUTH_CLIENT_ID; etc.
  // Keep every OTHER integration's env var unset so their blocks no-op.
  process.env.X_MCP_API_KEY = 'test-key';
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.XERO_CLIENT_ID;
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.ASANA_CLIENT_ID;
});
beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
});

describe('X fetch failures surface to the model (fa956f09)', () => {
  it('ALL legs failing → the context carries an explicit ⚠ X DATA UNAVAILABLE part, not silence', async () => {
    // The 2026-09-22 shape: every read leg returns null (gateway outage).
    (xMcp.search as jest.Mock).mockResolvedValue(null);
    (xMcp.getTrends as jest.Mock).mockResolvedValue(null);

    const out = await buildIntegrationContext({
      userId: 'u1',
      message: 'search X for AI and show me X trends',
      sendEvent,
    });

    // Old behavior: parts.length === 0 → xAdditionalContext undefined → NO X
    // block at all, model left blind. Now the failure notice IS the part.
    expect(out.additionalContext).toBeDefined();
    expect(out.additionalContext).toContain('X DATA UNAVAILABLE');
    expect(out.additionalContext).toContain('2 of 2');
    // The model must be told to NOT present this as "no results found".
    expect(out.additionalContext).toContain('do NOT present this as "no results found"');
    // The failure also surfaces as an SSE progress event (visible in the UI).
    const progressMsg = events.find(e => e.type === 'progress' && String(e.data?.message || '').includes('X isn’t responding'));
    expect(progressMsg).toBeDefined();
  });

  it('a REJECTED leg (exception) also becomes a failure part — rejections were dropped silently too', async () => {
    (xMcp.search as jest.Mock).mockResolvedValue('# X search — "AI"\n\n real posts');
    (xMcp.getTrends as jest.Mock).mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:8000'));

    const out = await buildIntegrationContext({
      userId: 'u1',
      message: 'search X for AI and show me X trends',
      sendEvent,
    });

    expect(out.additionalContext).toContain('# X search'); // the good leg survives
    expect(out.additionalContext).toContain('X DATA UNAVAILABLE');
    expect(out.additionalContext).toContain('1 of 2');
    expect(out.additionalContext).toContain('ECONNREFUSED');
  });

  it('all legs succeeding → no failure notice, X data flows as before', async () => {
    (xMcp.search as jest.Mock).mockResolvedValue('# X search — "AI"\n\n 1. real post');
    (xMcp.getTrends as jest.Mock).mockResolvedValue('# X trends\n\n 1. real trend');

    const out = await buildIntegrationContext({
      userId: 'u1',
      message: 'search X for AI and show me X trends',
      sendEvent,
    });

    expect(out.additionalContext).toContain('# X search');
    expect(out.additionalContext).toContain('# X trends');
    expect(out.additionalContext).not.toContain('X DATA UNAVAILABLE');
    expect(events.find(e => String(e.data?.message || '').includes('X data unavailable'))).toBeUndefined();
  });
});
