/**
 * streamQuery × the workspace attach gate (2026-10-20, real-user audit — platform/workspace-attach-gate.ts). A send into a
 * code-capable, satellite-less chat whose text trips the CODE_INTENT keyword list asks the gate before a workspace is
 * attached (which converts the chat into a coding session for good). Pinned here: the gate's verdict decides the
 * attach and the coding route; a Dig-deeper escalation and a project-supervisor chat never reach the gate or attach;
 * a send with no keyword never asks; uploads reach the gate as hasUploads. Harness: crossmodel.controller.dig-deeper.test.ts.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockFindUser = jest.fn();
const mockFindChat = jest.fn();
const mockFindMessage: jest.Mock = jest.fn(async () => null);
const mockFindFirstMessage: jest.Mock = jest.fn(async () => null);
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...a: any[]) => mockFindUser(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockFindChat(...a) },
    crossModelMessage: { findMany: jest.fn(), findUnique: (...a: any[]) => mockFindMessage(...a), findFirst: (...a: any[]) => mockFindFirstMessage(...a) },
  },
}));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) } }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(), combineAttachments: jest.fn(() => null), persistChatUploads: jest.fn(async () => {}) }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(async () => {}), generateKidStatus: jest.fn(async () => '') }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn(async () => []) }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
const mockDecideChatGate = jest.fn();
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: (...a: any[]) => mockDecideChatGate(...a),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(() => true),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
const mockAutoOnly: jest.Mock = jest.fn(async () => false);
const mockAllowance: jest.Mock = jest.fn();
const mockReserve: jest.Mock = jest.fn();
const mockReserveAnon: jest.Mock = jest.fn();
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(),
  reserveDeepResearchQuota: (...a: any[]) => mockReserve(...a),
  reserveAnonDeepResearchQuota: (...a: any[]) => mockReserveAnon(...a),
  getDeepResearchDailyLimit: jest.fn(), getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
  getPatienceAutoOnly: (...a: any[]) => mockAutoOnly(...a),
  invalidatePatienceAutoOnlyCache: jest.fn(),
  deepResearchAllowance: (...a: any[]) => mockAllowance(...a),
  PATIENCE_AUTO_ONLY_KEY: 'patience_auto_only',
}));
const mockCapability: jest.Mock = jest.fn(async () => ({ hasWorkspaceState: false, codeCapable: true }));
const mockEnsure: jest.Mock = jest.fn(async () => ({ id: 'ws' }));
jest.mock('./coding/coding-data.service', () => ({
  getChatCapability: (...a: any[]) => mockCapability(...a),
  ensureChatWorkspaceState: (...a: any[]) => mockEnsure(...a),
}));
const mockGate: jest.Mock = jest.fn();
jest.mock('./platform/workspace-attach-gate', () => ({ shouldAttachWorkspace: (...a: any[]) => mockGate(...a) }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({ attachRemoteChatRun: jest.fn(), replayFinishedRemoteRun: jest.fn(async () => false) }));
const mockCapRun: jest.Mock = jest.fn(async () => {});
jest.mock('./coding/coding-stream.controller', () => ({ __esModule: true, default: { streamRun: jest.fn(), streamCapabilityRun: (...a: any[]) => mockCapRun(...a) } }));
const mockRecordMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  ...jest.requireActual('./platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordMetric(...a),
}));
const mockShadow: jest.Mock = jest.fn(async () => {});
const mockRoute: jest.Mock = jest.fn();
jest.mock('./platform/auto-router-gate', () => ({
  ...jest.requireActual('./platform/auto-router-gate'),
  shadowAutoRouteAgainst: (...a: any[]) => mockShadow(...a),
  routeMessageAuto: (...a: any[]) => mockRoute(...a),
}));
const mockStartDetachedChatRun: jest.Mock = jest.fn();
jest.mock('./chat-agent/chat-agent.service', () => ({
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatAgentRunKey: jest.fn(() => 'agent-key'),
  // the busy branch: a user turn never preempts a user run; nothing to nudge
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(),
}));
jest.mock('./message-as-answer', () => ({ resolveParkedQuestionWithOwnerText: jest.fn(async () => ({ resolved: false })) }));
jest.mock('./coding/live-runs', () => ({ isRunActive: jest.fn(() => false), subscribeRun: jest.fn(() => null) }));
const mockLabelEscalated: jest.Mock = jest.fn(() => 'escalated');
const mockLabelRevisionFromMeta: jest.Mock = jest.fn(() => false);
jest.mock('./chat-agent/compute-policy-labels', () => ({
  __esModule: true,
  labelComputePolicyEscalated: (...a: any[]) => mockLabelEscalated(...a),
  // cp/labels: a tap on an 'updated' row also labels revision_material; the facts ride from metadata.depth.facts.
  labelRevisionMaterialFromMetadata: (...a: any[]) => mockLabelRevisionFromMeta(...a),
  // audit drafts-agree-label-semantics: a tap on an acted (skipped-reconcile) row labels drafts_agree too.
  labelDraftsAgreeFromMetadata: jest.fn(() => false),
  factsFromDepthMetadata: (meta: any) => (meta?.depth?.facts ?? null),
}));

import controller from './crossmodel.controller';
import * as chatGateMock from './chat-agent/chat-gate';
import { streamQuerySchema, uxBeaconSchema } from './crossmodel.validation';

const CHAT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const MSG = '9b2e7c1a-2d3f-4e5a-8b6c-1d2e3f4a5b6c';
const mkReq = (over: any = {}): any => ({ query: { message: 'What is the capital of France?', mode: 'thinking' }, headers: {}, on: jest.fn(), ...over });
const mkRes = (): any => {
  const res: any = {
    frames: [] as string[], writableEnded: false, calls: [] as string[],
    status: jest.fn(() => res), json: jest.fn(() => res), setHeader: jest.fn(), cookie: jest.fn(),
    flushHeaders: jest.fn(() => { res.calls.push('flushHeaders'); }),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const events = (res: any) => res.frames.filter((f: string) => f.startsWith('data: ')).map((f: string) => JSON.parse(f.replace(/^data: /, '')));
const flush = () => new Promise(r => setImmediate(r));
const heuristicRoute = (level: string) => ({ level, reason: 'default ensemble', reasonKey: 'default_ensemble', suggestCode: false, needsWorkspace: false, source: 'heuristic', heuristicLevel: level });
const ORIGINAL_Q = 'How much does the plan cost per month?';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DIG_DEEPER_DISABLED;
  delete process.env.UX_BEACON_DISABLED;
  mockDecideChatGate.mockImplementation(({ mode }: any) => ({ action: 'agent', councilMode: mode === 'deep_research' }));
  mockFindUser.mockResolvedValue({ isChild: false });
  mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: false });
  mockStartDetachedChatRun.mockResolvedValue('run-key-1');
  mockAutoOnly.mockResolvedValue(false);
  mockAllowance.mockResolvedValue({ allowed: true });
  mockReserve.mockResolvedValue({ allowed: true, used: 1, limit: 5, remaining: 4 });
  mockReserveAnon.mockResolvedValue({ allowed: true, used: 1, limit: 2, remaining: 1 });
  mockRoute.mockImplementation(async () => { return heuristicRoute('thinking'); });
  mockFindMessage.mockResolvedValue(null);
  mockFindFirstMessage.mockResolvedValue({ content: ORIGINAL_Q });
  mockCapability.mockResolvedValue({ hasWorkspaceState: false, codeCapable: true });
  mockEnsure.mockResolvedValue({ id: 'ws' });
  mockGate.mockResolvedValue({ attach: false, wouldAttach: false, mode: 'act', reason: 'kind_not_code', label: 'code intent', kind: 'writing', p: 0.97 });
});


const GRAMMAR = 'fix the grammar: their going to there house later';

describe('workspace attach gate at the web send seam', () => {
  it('a keyword send the gate keeps a chat: no attach, no coding route — the chat pipeline runs; the gate gets origin/segment user', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: GRAMMAR, mode: 'auto', chatId: CHAT } }), res, jest.fn());
    await flush();
    expect(mockGate).toHaveBeenCalledWith(GRAMMAR, { chatId: CHAT, origin: 'user', segment: 'user', hasUploads: false });
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockCapRun).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
  });

  it('a keyword send the gate attaches: the workspace is attached and THIS message runs coding (uploads ride along)', async () => {
    mockGate.mockResolvedValueOnce({ attach: true, wouldAttach: true, mode: 'act', reason: 'kind_code', label: 'code intent', kind: 'code', p: 0.9 });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'fix the failing build', mode: 'auto', chatId: CHAT, uploadId: 'up-1' } }), res, jest.fn());
    await flush();
    expect(mockGate).toHaveBeenCalledWith('fix the failing build', expect.objectContaining({ hasUploads: true }));
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockCapRun).toHaveBeenCalledTimes(1);
    expect(mockCapRun.mock.calls[0][3]).toBe('fix the failing build');
    expect(mockCapRun.mock.calls[0][4]).toEqual(['up-1']);
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
  });

  it('no keyword: the gate is never asked and nothing is attached', async () => {
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'write a poem for my mom', mode: 'auto', chatId: CHAT } }), res, jest.fn());
    await flush();
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
  });

  it('a Dig-deeper escalation on a keyword answer never asks the gate and never attaches (it deepens a chat answer)', async () => {
    mockFindMessage.mockResolvedValue({ id: MSG, chatId: CHAT, role: 'assistant', metadata: { mode: 'single_thinking' }, createdAt: new Date() });
    mockFindFirstMessage.mockResolvedValue({ content: 'fix the failing test in auth.spec.ts' });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'fix the failing test in auth.spec.ts', mode: 'auto', chatId: CHAT, escalationOf: MSG } }), res, jest.fn());
    await flush();
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockCapRun).not.toHaveBeenCalled();
  });

  it('a project-supervisor chat never asks the gate and never attaches', async () => {
    mockFindChat.mockResolvedValue({ id: CHAT, userId: 'u1', projectId: null, title: 't', isSupervisor: false, isProjectSupervisor: true });
    const res = mkRes();
    await controller.streamQuery(mkReq({ user: { id: 'u1' }, query: { message: 'fix the failing build', mode: 'auto', chatId: CHAT } }), res, jest.fn());
    await flush();
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
