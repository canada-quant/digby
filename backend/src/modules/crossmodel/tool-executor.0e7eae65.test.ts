/** Ticket 0e7eae65 (mishap, 2026-10-03) — 3× tool-failure streak: browser_task on
 * "Gap-fill: bijural · Explore repo state, " (session 7656e599, run 03e89632).
 * Chronological failure texts (the ticket lists them newest-first):
 *
 *   14:37:56Z  Tool call failed: timeout of 150000ms exceeded. DO NOT retry
 *              this tool. Use the information you already have to answer the
 *              user's question directly.
 *   14:38:21Z  Tool call failed: Request failed with status code 502. DO NOT
 *              retry this tool. Use the information you already have to answer
 *              the user's question directly.
 *   14:59:53Z  Tool call failed: timeout of 150000ms exceeded. DO NOT retry
 *              this tool. Use the information you already have to answer the
 *              user's question directly.
 *
 * ADJUDICATION (investigated 2026-10-03, dispatched lane b92ef13f): NOT a
 * deterministic framework/schema/preflight/guard defect. The chain:
 *
 *   1. Same call chain as ticket 24fe90cb: browser_task →
 *      runBrowserAgentSession (tool-executor.ts:540) → glm-loop's only
 *      outbound HTTP is glmChat's axios POST (browser-agent/glm-client.ts) —
 *      both failure shapes are AXIOS messages from that upstream leg:
 *      'timeout of 150000ms exceeded' = axios's ECONNABORTED message against
 *      the 150000ms default timeout (glm-client.ts:119, untouched since
 *      464ffde76), and 'Request failed with status code 502' = axios's
 *      standard HTTP-error message. Upstream classes (slow/bad gateway), not
 *      framework request defects — a schema bug would 400; a key bug 401.
 *   2. The two shapes DIFFER within one streak — and the breaker counts the
 *      TOOL, not the text (coding/agent.ts:4551 keys the ladder on tc.name;
 *      only same-tool failure texts are collected). Mixed texts are therefore
 *      a legitimate single 3× streak, and this file pins that.
 *   3. The streak spanned 22 minutes (14:37:56→14:59:53) with other tools
 *      succeeding in between — legitimate because ONLY a same-tool success
 *      resets the ladder (coding/agent.ts:4668-4671); other-tool successes
 *      leave it intact. That discriminator is already replayed at the agent
 *      level by agent-derail-break.8579d419.test.ts (todo_get 3× with
 *      interleaved get_chat_messages/list_chats successes → still trips).
 *   4. glmChat is wrapped in retryOnModelNotFound, which retries ONLY
 *      404/model-not-found shapes (pipeline-utils.ts:497-507) — a timeout
 *      AND a 502 each rethrow IMMEDIATELY (pinned below). No framework retry
 *      storm: every browser_task made one upstream call.
 *   5. glm-loop is try/finally with NO catch (glm-loop.ts:432/668) by design —
 *      the driver is closed and the error propagates; tool-executor's generic
 *      catch (:1720) wraps it into the exact observed text.
 *   6. The STREAK itself was model behavior: the session model re-invoked
 *      browser_task 3× across 22 minutes against the explicit "DO NOT retry
 *      this tool" instruction, during a window when telemetry showed the same
 *      upstream degradation on 4+ other surfaces. The breaker then worked as
 *      designed: trip at 3 → this ticket auto-filed → tool withheld → the
 *      run CONTINUED (its receipts carry post-trip tool calls).
 *
 * This file REPLAYS the mishap through the REAL code path (tool-executor →
 * real glm-loop, mocked glm-client/router) and pins every link so a future
 * regression that changes any of these behaviors fails here instead of
 * re-filing as a phantom "framework or model?" streak ticket.
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

/** The two prod failure texts, verbatim from ticket 0e7eae65 (timeout, 502). */
const PROD_TIMEOUT_TEXT =
  'Tool call failed: timeout of 150000ms exceeded. ' +
  'DO NOT retry this tool. Use the information you already have to answer the user\'s question directly.';
const PROD_502_TEXT =
  'Tool call failed: Request failed with status code 502. ' +
  'DO NOT retry this tool. Use the information you already have to answer the user\'s question directly.';

/** axios's standard error shape for a 150000ms timeout (ECONNABORTED, no response). */
const zaiTimeout = () => {
  const err: any = new Error('timeout of 150000ms exceeded');
  err.code = 'ECONNABORTED';
  return err;
};

/** axios's standard error shape for an HTTP 502 response. */
const zai502 = () => {
  const err: any = new Error('Request failed with status code 502');
  err.response = { status: 502, data: { error: { message: 'Bad Gateway' } } };
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

describe('ticket 0e7eae65 replay — upstream timeout / 502 → the exact prod failure texts', () => {
  it('a timeout-throwing glmChat propagates through the REAL glm-loop and tool-executor wraps it byte-identically to the prod streak text', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock).mockRejectedValue(zaiTimeout());

    const out = await new ToolCache('u1').getOrExecute('browser_task', {
      task: 'explore the repo state and report the module layout',
    });

    // The byte-for-byte text the breaker counted at 14:37:56Z and 14:59:53Z.
    expect(out).toBe(PROD_TIMEOUT_TEXT);
    // The sub-session's model call was attempted exactly once — no framework
    // retry storm against the degraded upstream…
    expect(glmChat).toHaveBeenCalledTimes(1);
    // …and the driver was still closed (glm-loop's finally) — no leaked browser
    // session on the failure path.
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it('a 502-throwing glmChat produces the OTHER prod streak text byte-identically (same propagation, different upstream class)', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock).mockRejectedValue(zai502());

    const out = await new ToolCache('u1').getOrExecute('browser_task', {
      task: 'explore the repo state and report the module layout',
    });

    expect(out).toBe(PROD_502_TEXT);
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(driver.close).toHaveBeenCalledTimes(1);
  });

  it('the MIXED streak signature: three different-args calls alternating timeout/502/timeout yield the ticket\'s exact chronological text sequence — the breaker counts the TOOL, not the text', async () => {
    const shapes = [zaiTimeout, zai502, zaiTimeout];
    const expected = [PROD_TIMEOUT_TEXT, PROD_502_TEXT, PROD_TIMEOUT_TEXT];
    const cache = new ToolCache('u1');
    const texts: string[] = [];

    for (let i = 0; i < shapes.length; i += 1) {
      const driver = mkLocalDriver();
      localSelected(driver);
      (glmChat as jest.Mock).mockRejectedValueOnce(shapes[i]());
      texts.push(await cache.getOrExecute('browser_task', {
        task: `explore the repo state (pass ${i + 1})`, // distinct args → distinct cache keys, each executes
      }));
    }

    // Chronological order of run 03e89632: timeout (14:37:56Z), 502 (14:38:21Z),
    // timeout (14:59:53Z) — a single 3× streak of ONE tool with TWO texts.
    expect(texts).toEqual(expected);
    // Every call executed against the upstream (distinct args): one attempt
    // each, no retry storm across the whole mixed streak.
    expect(glmChat).toHaveBeenCalledTimes(3);
  });

  it('same-args retries read the CACHED failure (the framework-side "DO NOT retry" amplifier already pinned for 24fe90cb — unchanged here)', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock).mockRejectedValue(zaiTimeout());

    const cache = new ToolCache('u1');
    const args = { task: 'explore the repo state and report the module layout' };
    const texts = [
      await cache.getOrExecute('browser_task', args),
      await cache.getOrExecute('browser_task', args),
      await cache.getOrExecute('browser_task', args),
    ];

    expect(texts).toEqual([PROD_TIMEOUT_TEXT, PROD_TIMEOUT_TEXT, PROD_TIMEOUT_TEXT]);
    expect(glmChat).toHaveBeenCalledTimes(1);
    expect(cache.getStats().hits).toBe(2);
  });
});

describe('ticket 0e7eae65 — retryOnModelNotFound asymmetry pins WHY timeout/502 surface instantly', () => {
  it('a timeout-shaped failure is NOT retried (single attempt, immediate rethrow)', async () => {
    const fn = jest.fn(async () => Promise.reject(zaiTimeout()));
    await expect(retryOnModelNotFound(fn, 'GLM-5.3 browser-agent turn', 2, 1)).rejects.toThrow(
      'timeout of 150000ms exceeded',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 502-shaped failure is NOT retried (single attempt, immediate rethrow)', async () => {
    const fn = jest.fn(async () => Promise.reject(zai502()));
    await expect(retryOnModelNotFound(fn, 'GLM-5.3 browser-agent turn', 2, 1)).rejects.toThrow(
      'Request failed with status code 502',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a 404/model-not-found failure IS retried (the maintenance-blip path the wrapper exists for — control, mirrors 24fe90cb)', async () => {
    const err: any = new Error('Request failed with status code 404');
    err.response = { status: 404, data: { error: { message: 'model not found' } } };
    const fn = jest.fn(async () => Promise.reject(err));
    await expect(retryOnModelNotFound(fn, 'GLM-5.3 browser-agent turn', 2, 1)).rejects.toThrow('404');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
