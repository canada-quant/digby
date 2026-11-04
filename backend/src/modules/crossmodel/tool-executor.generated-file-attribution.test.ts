/**
 * Owner report 2026-09-22: "files from another project session are appearing in
 * a different project session's chat sidebar". The Files sidebar lists
 * generated files by chatId; create_document let the MODEL's optional `chatId`
 * arg override the run's own chat (ticket 8db4c18e read it as "traceability"),
 * so a lane/supervisor that copied another chat's id filed its document under
 * that chat. Pins the tightened rule: the run's chat always wins; a chat-less
 * run may name only one of the user's OWN chats; anything else → unattributed.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPrisma: any = {
  generatedFile: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
  crossModelChat: { findFirst: jest.fn() },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./mcp-search', () => ({ __esModule: true, callMcpTool: jest.fn(async () => null), webToolsDegraded: jest.fn(() => false) }));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));
jest.mock('./browser-agent/glm-client', () => ({ __esModule: true, glmChat: jest.fn(), glmConfigured: jest.fn(async () => true), stripThink: (s: string) => s }));
jest.mock('./browser-agent/router', () => ({ __esModule: true, selectBrowserDriver: jest.fn(), selectLocalFallbackDriver: jest.fn() }));

import { ToolCache } from './tool-executor';

const RUN_CHAT = '11111111-aaaa-4bbb-8ccc-000000000001';
const OTHER_CHAT = '22222222-aaaa-4bbb-8ccc-000000000002';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
});

describe('generated-file chat attribution', () => {
  it("the run's own chat always wins — a model-supplied different chatId is ignored (no lookup)", async () => {
    const exec = new ToolCache('user-1', RUN_CHAT);
    await expect(exec.generatedFileChatId(OTHER_CHAT)).resolves.toBe(RUN_CHAT);
    await expect(exec.generatedFileChatId(undefined)).resolves.toBe(RUN_CHAT);
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
  });

  it("a chat-less run may name one of the user's OWN chats (verified against the DB)", async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: OTHER_CHAT });
    const exec = new ToolCache('user-1', null);
    await expect(exec.generatedFileChatId(OTHER_CHAT)).resolves.toBe(OTHER_CHAT);
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({ where: { id: OTHER_CHAT, userId: 'user-1' }, select: { id: true } });
  });

  it("a chat-less run naming a chat that is not the user's (or does not exist) files the document unattributed", async () => {
    const exec = new ToolCache('user-1', null);
    await expect(exec.generatedFileChatId(OTHER_CHAT)).resolves.toBeNull();
    await expect(exec.generatedFileChatId('')).resolves.toBeNull();
    await expect(exec.generatedFileChatId(42)).resolves.toBeNull();
  });

  it('a DB hiccup during the ownership check fails closed (unattributed), never to the requested id', async () => {
    mockPrisma.crossModelChat.findFirst.mockRejectedValue(new Error('db down'));
    const exec = new ToolCache('user-1', null);
    await expect(exec.generatedFileChatId(OTHER_CHAT)).resolves.toBeNull();
  });
});
