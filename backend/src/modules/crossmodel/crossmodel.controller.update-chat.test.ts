/**
 * PUT /chats/:id — every field in the body is applied (2026-10-04: a {title, leadModel} body took the rename path and
 * silently dropped the lead pick; a move dropped standing instructions the same way). Mock graph mirrors
 * crossmodel.controller.api-costs.test.ts.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

const mockMsgFindMany = jest.fn();
const mockUserFindMany = jest.fn();
const mockQueryRaw = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelMessage: { findMany: (...a: any[]) => mockMsgFindMany(...a) },
    user: { findMany: (...a: any[]) => mockUserFindMany(...a) },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
  },
}));

const mockUpdateChat = jest.fn(async (_id: string, _u: string, data: any) => ({ id: 'c1', ...data }));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: { updateChat: (...a: any[]) => (mockUpdateChat as any)(...a) } }));
const mockRename = jest.fn(async (o: any) => ({ id: o.chatId, title: o.title }));
const mockMove = jest.fn(async (o: any) => ({ id: o.chatId, projectId: o.projectId }));
jest.mock('./platform/platform.service', () => ({ __esModule: true, renameChat: (...a: any[]) => (mockRename as any)(...a), moveChat: (...a: any[]) => (mockMove as any)(...a), default: { renameChat: (...a: any[]) => (mockRename as any)(...a), moveChat: (...a: any[]) => (mockMove as any)(...a) } }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(),
  combineAttachments: jest.fn(() => null),
}));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({
  streamKidResponse: jest.fn(),
  generateKidStatus: jest.fn(),
}));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn() }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(), mapAttachmentForAgent: jest.fn(),
  chatWriteAccessGranted: jest.fn(), chatReadAccessGranted: jest.fn(), streamAccessDeniedError: jest.fn(),
}));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: undefined, imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build) => build()) }));
jest.mock('./rate-limit.service', () => ({
  checkDeepResearchQuota: jest.fn(), reserveDeepResearchQuota: jest.fn(), getDeepResearchDailyLimit: jest.fn(),
  getAllDeepResearchUsageToday: jest.fn(), invalidateLimitCache: jest.fn(),
}));
jest.mock('./coding/coding-data.service', () => ({ getChatCapability: jest.fn() }));
jest.mock('./chat-agent/chat-busy', () => ({ isChatBusy: jest.fn(async () => false) }));
jest.mock('./chat-agent/run-event-mirror', () => ({
  attachRemoteChatRun: jest.fn(),
  replayFinishedRemoteRun: jest.fn(async () => false),
}));
jest.mock('./coding/coding-stream.controller', () => ({
  __esModule: true,
  default: { streamRun: jest.fn() },
}));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  queryLoopMetrics: jest.fn(),
  summarizeLoopMetrics: jest.fn(),
}));

import controller from './crossmodel.controller';

const res = () => { const r: any = { json: jest.fn() }; return r; };
const req = (body: any) => ({ user: { id: 'u1' }, params: { id: 'c1' }, body }) as any;

describe('updateChat applies every field', () => {
  beforeEach(() => { mockUpdateChat.mockClear(); mockRename.mockClear(); mockMove.mockClear(); });

  it('title + leadModel: renames AND sets the lead pick', async () => {
    const next = jest.fn();
    await (controller as any).updateChat(req({ title: 'bench', leadModel: 'glm-5.3' }), res(), next);
    expect(next).not.toHaveBeenCalled();
    expect(mockRename).toHaveBeenCalledWith({ userId: 'u1', chatId: 'c1', title: 'bench' });
    expect(mockUpdateChat).toHaveBeenCalledWith('c1', 'u1', { leadModel: 'glm-5.3' });
  });

  it('a bare rename still takes only the rename path', async () => {
    await (controller as any).updateChat(req({ title: 'x' }), res(), jest.fn());
    expect(mockRename).toHaveBeenCalled();
    expect(mockUpdateChat).not.toHaveBeenCalled();
  });

  it('a move keeps the standing instructions and the lead pick that rode along', async () => {
    await (controller as any).updateChat(req({ projectId: 'p1', systemPrompt: 'be brief', leadModel: 'kimi-k3' }), res(), jest.fn());
    expect(mockMove).toHaveBeenCalledWith({ userId: 'u1', chatId: 'c1', projectId: 'p1' });
    expect(mockUpdateChat).toHaveBeenCalledWith('c1', 'u1', { leadModel: 'kimi-k3', systemPrompt: 'be brief' });
  });
});
