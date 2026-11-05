/**
 * quotaClientIp (patience plan 1a §3.4, 2026-09-25) — the guest deep-research
 * QUOTA KEY's client derivation behind ALB → nginx → Express:
 *   - QUOTA_TRUSTED_PROXY_HOPS unset → byte-identical to getClientIp (first hop);
 *   - =2 → the entry two from the right of X-Forwarded-For (what the ALB
 *     wrote as the client), so a forged prepended hop cannot move the key;
 *   - fewer entries than hops → falls back to getClientIp;
 *   - getClientIp itself is UNTOUCHED (registration slots / token binding).
 * The controller's import graph is mocked like crossmodel.controller.loop-metrics.test.ts.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(), combineAttachments: jest.fn(() => null) }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(), generateKidStatus: jest.fn() }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), reserveAnonDeepResearchQuota: jest.fn(),
  getDeepResearchDailyLimit: jest.fn(), getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: jest.fn(async () => false), invalidatePatienceAutoOnlyCache: jest.fn(), deepResearchAllowance: jest.fn(),
  PATIENCE_AUTO_ONLY_KEY: 'patience_auto_only',
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn() } }));
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: jest.fn(), queryLoopMetrics: jest.fn(), summarizeLoopMetrics: jest.fn(),
}));

import { quotaClientIp, getClientIp } from './crossmodel.controller';

const req = (xff: string | string[] | undefined, ip = '10.0.0.11'): any => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip });

beforeEach(() => { delete process.env.QUOTA_TRUSTED_PROXY_HOPS; });

describe('quotaClientIp', () => {
  it('unset hops: identical to getClientIp (first XFF entry, else req.ip)', () => {
    const r = req('203.0.113.9, 10.0.0.14');
    expect(quotaClientIp(r)).toBe(getClientIp(r));
    expect(quotaClientIp(r)).toBe('203.0.113.9');
    expect(quotaClientIp(req(undefined, '::ffff:198.51.100.7'))).toBe('198.51.100.7');
  });

  it('hops=2 (ALB + nginx): the client is the entry two from the right, and a forged prepended hop cannot move it', () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    // honest chain written by the ALB then nginx: client, ALB-node
    expect(quotaClientIp(req('203.0.113.9, 10.0.0.14'))).toBe('203.0.113.9');
    // forged: the client sent X-Forwarded-For: 1.2.3.4 — the ALB appended the real client, nginx the ALB node
    expect(quotaClientIp(req('1.2.3.4, 203.0.113.9, 10.0.0.14'))).toBe('203.0.113.9');
    // getClientIp is untouched — it still takes the FIRST hop
    expect(getClientIp(req('1.2.3.4, 203.0.113.9, 10.0.0.14'))).toBe('1.2.3.4');
  });

  it('fewer entries than hops falls back to getClientIp; IPv4-mapped IPv6 is normalized; array headers join', () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '3';
    expect(quotaClientIp(req('203.0.113.9, 10.0.0.14'))).toBe('203.0.113.9');
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    expect(quotaClientIp(req('::ffff:203.0.113.9, 10.0.0.14'))).toBe('203.0.113.9');
    expect(quotaClientIp(req(['203.0.113.9', '10.0.0.14']))).toBe('203.0.113.9');
  });

  it('a non-integer / zero hop count behaves as unset', () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '0';
    expect(quotaClientIp(req('1.2.3.4, 203.0.113.9'))).toBe('1.2.3.4');
    process.env.QUOTA_TRUSTED_PROXY_HOPS = 'two';
    expect(quotaClientIp(req('1.2.3.4, 203.0.113.9'))).toBe('1.2.3.4');
  });
});
