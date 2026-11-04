/** Ticket 24fe90cb (mishap, 2026-09-14) — 3× tool-failure streak: browser_task on
 * "Hardening Bench for Public Release" (session 3e1cae6f, run 6806d678). All three
 * failure texts were byte-identical:
 *
 *   Tool call failed: Request failed with status code 429. DO NOT retry this tool.
 *   Use the information you already have to answer the user's question directly.
 *
 * ADJUDICATION (investigated 2026-09-14, dispatch lane b6dfa609): NOT a
 * deterministic framework/schema/preflight/guard defect. The chain is:
 *
 *   1. browser_task → runBrowserAgentSession (tool-executor.ts:540) → the browser
 *      sub-session's ONLY outbound HTTP call is glmChat's axios POST to
 *      https://api.z.ai/api/paas/v4/chat/completions (browser-agent/glm-client.ts)
 *      — so "Request failed with status code 429" (axios's standard message) came
 *      from the ZAI upstream: a transient rate-limit window, not a framework
 *      request defect (a schema bug would be 400; a key bug 401).
 *   2. glmChat is wrapped in retryOnModelNotFound, which retries ONLY
 *      404/model-not-found shapes (pipeline-utils.ts:497-507) — a 429 rethrows
 *      IMMEDIATELY. No framework retry storm; each browser_task made one ZAI call.
 *   3. runBrowserAgentSession has try/finally with NO catch (glm-loop.ts:631-633)
 *      by design — the driver is closed and the error propagates.
 *   4. tool-executor's generic catch (:932-940) wraps it into the exact observed
 *      text — long-standing behavior, untouched by recent framework changes
 *      (git log: only UI-phase 6 commits fba0a57e7/8a8a80d4a/d656749b7).
 *   5. The STREAK itself was model behavior: the kimi-k3 session model re-invoked
 *      browser_task 3× in immediate succession against the explicit
 *      "DO NOT retry this tool" instruction, all three calls landing in the same
 *      upstream 429 window. The derail breaker then worked as designed
 *      (coding/agent.ts:2257-2278): trip at 3 → this ticket auto-filed → tool
 *      withheld one round → the run CONTINUED (still running post-trip).
 *
 * This file REPLAYS the mishap through the REAL code path (tool-executor → real
 * glm-loop, mocked glm-client/router) and pins every link of the adjudicated
 * chain so a future framework regression that CHANGES any of these behaviors
 * fails loudly here instead of re-filing as a phantom "framework or model?"
 * streak ticket.
 *
 * Pinned nuance (contributing amplifier, deliberately NOT "fixed"): ToolCache
 * caches failure texts, so same-args retries return the CACHED failure for the
 * rest of the run. That is consistent with the framework's own "DO NOT retry"
 * stance — the streak forms only when the model violates it.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  generatedFile: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async () => null),
}));

jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

// The browser sub-session's model client + driver router are the ONLY mocked
// seams — glm-loop itself runs REAL so the no-catch propagation is exercised
// exactly as in prod.
jest.mock('./browser-agent/glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  // Faithful mirror of the real stripThink (same shape as glm-loop.empty-content.test.ts).
  stripThink: (s: string | null | undefined) => {
    const text = s || '';
    const m = text.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
    if (m) return m[2].trim();
    if (/^\s*<think>/.test(text)) return '';
    return text;
  },
}));
jest.mock('./browser-agent/router', () => ({
  __esModule: true,
  selectBrowserDriver: jest.fn(),
  selectLocalFallbackDriver: jest.fn(),
}));

import { glmChat } from './browser-agent/glm-client';
import { selectBrowserDriver } from './browser-agent/router';
import { retryOnModelNotFound } from './langgraph/pipeline-utils';
import { ToolCache } from './tool-executor';

/** The prod failure text, verbatim from ticket 24fe90cb (all three streak texts identical). */
const PROD_TEXT =
  'Tool call failed: Request failed with status code 429. ' +
  'DO NOT retry this tool. Use the information you already have to answer the user\'s question directly.';

/** axios's standard error shape for an HTTP 429 response. */
const zai429 = () => {
  const err: any = new Error('Request failed with status code 429');
  err.response = { status: 429, data: { error: { message: 'Too Many Requests' } } };
  return err;
};

const mkLocalDriver = () => ({
  kind: 'local' as const,
  isAvailable: jest.fn(async () => true),
  execute: jest.fn(async (action: any) => ({
    ok: true,
    driver: 'local',
    action: action.name,
    url: 'https://example.com',
    content: 'page content',
  })),
  close: jest.fn(async () => {}),
});

const localSelected = (driver: any) =>
  (selectBrowserDriver as jest.Mock).mockResolvedValue({
    driver,
    kind: 'local',
    reason: 'driving your paired Mac browser',
  });

beforeEach(() => jest.clearAllMocks());

describe('ticket 24fe90cb replay — upstream ZAI 429 → the exact prod failure text', () => {
  it('a 429-throwing glmChat propagates through the REAL glm-loop and tool-executor wraps it byte-identically to the prod streak text', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock).mockRejectedValue(zai429());

    const out = await new ToolCache('u1').getOrExecute('browser_task', {
      task: 'open the status page and report the current incidents',
    });

    // The byte-for-byte text the breaker counted 3× in run 6806d678.
    expect(out).toBe(PROD_TEXT);
    // The sub-session's model call was attempted exactly once — no framework
    // retry storm against the rate-limited upstream…
    expect(glmChat).toHaveBeenCalledTimes(1);
    // …and the driver was still closed (glm-loop's finally) — no leaked browser
    // session on the failure path.
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it('three same-args calls yield three byte-identical texts (the 3× streak signature) over ONE underlying execution — the result cache dedupes the retries', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock).mockRejectedValue(zai429());

    const cache = new ToolCache('u1');
    const args = { task: 'open the status page and report the current incidents' };
    const texts = [
      await cache.getOrExecute('browser_task', args),
      await cache.getOrExecute('browser_task', args),
      await cache.getOrExecute('browser_task', args),
    ];

    expect(texts).toEqual([PROD_TEXT, PROD_TEXT, PROD_TEXT]);
    // Cache amplification pin: the breaker saw three failure-shaped results, but
    // only the FIRST executed the sub-session — same-args retries read the cached
    // failure (coherent with the "DO NOT retry" stance the text itself carries).
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBe(2);
  });

  it('three different-args calls each execute once and STILL return byte-identical texts — the text depends only on the upstream status, not the task', async () => {
    (glmChat as jest.Mock).mockRejectedValue(zai429());
    for (const task of ['check the status page', 'read the pricing tiers', 'list current incidents']) {
      const driver = mkLocalDriver();
      localSelected(driver);
      const out = await new ToolCache('u1').getOrExecute('browser_task', { task });
      expect(out).toBe(PROD_TEXT);
    }
    expect(glmChat).toHaveBeenCalledTimes(3);
  });
});

describe('ticket 24fe90cb — retryOnModelNotFound asymmetry pins WHY a 429 surfaces instantly', () => {
  it('a 429-shaped failure is NOT retried (single attempt, immediate rethrow)', async () => {
    const fn = jest.fn(async () => Promise.reject(zai429()));
    await expect(retryOnModelNotFound(fn, 'GLM-5.3 browser-agent turn', 2, 1)).rejects.toThrow(
      'Request failed with status code 429',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 404/model-not-found failure IS retried (the maintenance-blip path the wrapper exists for)', async () => {
    const err: any = new Error('Request failed with status code 404');
    err.response = { status: 404, data: { error: { message: 'model not found' } } };
    const fn = jest.fn(async () => Promise.reject(err));
    await expect(retryOnModelNotFound(fn, 'GLM-5.3 browser-agent turn', 2, 1)).rejects.toThrow('404');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
