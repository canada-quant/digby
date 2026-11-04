/**
 * cloud-link.service receiveCloudMessage — Digby Edge (Phase 5) cloud→edge
 * messaging. Pins: the linked-state guard (409), the depth loop bound (400
 * 'hook depth exceeded' past MAX_CLOUD_MESSAGE_DEPTH), chat lookup (404),
 * the message posted AS THE CHAT'S OWNER via sendChatMessage with origin
 * { kind: 'webhook' } and NO userTurnAt (machine traffic can never anchor a
 * confirmation), the payload wrapped EXACTLY ONCE in the UNTRUSTED webhook
 * frame with the source label + relay depth in the header text, and the
 * started/queued/steered delivery mapping (mirrors webhook.controller).
 * Also pins the app.ts limiter helpers (path RE + per-chat/IP key) and the
 * receive zod schema bounds. Prisma + the platform service are mocked; the
 * REAL frameWebhookPayload runs (webhook.service is crypto+prisma only).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({ env: { NODE_ENV: 'test' } }));

const mockTunnel = {
  restart: jest.fn(async () => {}),
  stop: jest.fn(),
  start: jest.fn(async () => {}),
  isConnected: jest.fn(() => false),
};
jest.mock('../../../cloud-link/tunnel-client', () => ({
  cloudLinkTunnel: mockTunnel,
  startCloudLinkTunnelIfLinked: jest.fn(),
}));

const linkRows: any[] = [];
const chats: any[] = [];
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    cloudLink: {
      findFirst: jest.fn(async () => linkRows[linkRows.length - 1] || null),
    },
    crossModelChat: {
      findUnique: jest.fn(async ({ where }: any) => chats.find((c) => c.id === where.id) || null),
    },
  },
}));

// sendChatMessage is a DYNAMIC import inside receiveCloudMessage — mocking the
// module here intercepts it and keeps the platform service's heavy graph out.
const mockSendChatMessage = jest.fn();
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  sendChatMessage: mockSendChatMessage,
}));

import {
  receiveCloudMessage, MAX_CLOUD_MESSAGE_DEPTH,
  CLOUD_LINK_RECEIVE_PATH_RE, cloudLinkReceiveLimiterKey,
} from './cloud-link.service';
import { receiveCloudMessageSchema } from './cloud-link.validation';
import { WEBHOOK_PAYLOAD_OPEN } from '../webhook.service';

const CHAT = { id: 'chat-1', userId: 'owner-1' };
const LINKED = { id: 'l1', state: 'linked', cloudUrl: 'https://digby.example.com', instanceName: 'edge-1' };

beforeEach(() => {
  linkRows.length = 0;
  chats.length = 0;
  jest.clearAllMocks();
  linkRows.push({ ...LINKED });
  chats.push({ ...CHAT });
  mockSendChatMessage.mockResolvedValue({ queued: true, chatId: CHAT.id, mode: 'single_thinking' });
});

describe('receiveCloudMessage guards', () => {
  it('409 when no cloud_link row exists at all', async () => {
    linkRows.length = 0;
    await expect(receiveCloudMessage({ chatId: CHAT.id, message: 'hi' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it('409 when the link is not in state linked (e.g. error)', async () => {
    linkRows[0].state = 'error';
    await expect(receiveCloudMessage({ chatId: CHAT.id, message: 'hi' }))
      .rejects.toMatchObject({ statusCode: 409, message: 'This instance is not linked to a cloud' });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });

  it(`400 'hook depth exceeded' when depth > ${MAX_CLOUD_MESSAGE_DEPTH} (the loop bound)`, async () => {
    await expect(receiveCloudMessage({ chatId: CHAT.id, message: 'hi', depth: MAX_CLOUD_MESSAGE_DEPTH + 1 }))
      .rejects.toMatchObject({ statusCode: 400, message: 'hook depth exceeded' });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
    // The boundary itself delivers.
    await receiveCloudMessage({ chatId: CHAT.id, message: 'hi', depth: MAX_CLOUD_MESSAGE_DEPTH });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('404 for an unknown chat', async () => {
    chats.length = 0;
    await expect(receiveCloudMessage({ chatId: 'nope', message: 'hi' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Chat not found' });
    expect(mockSendChatMessage).not.toHaveBeenCalled();
  });
});

describe('receiveCloudMessage framing + origin', () => {
  it("posts as the chat's OWNER with origin 'webhook' and NO userTurnAt", async () => {
    await receiveCloudMessage({ chatId: CHAT.id, message: 'deploy finished', depth: 2 });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    const args = mockSendChatMessage.mock.calls[0][0];
    expect(args.userId).toBe('owner-1');
    expect(args.chatId).toBe(CHAT.id);
    expect(args.origin).toEqual({ kind: 'webhook' });
    expect('userTurnAt' in args).toBe(false);
  });

  it('wraps the message EXACTLY ONCE in the UNTRUSTED frame with source + depth in the header', async () => {
    await receiveCloudMessage({
      chatId: CHAT.id, message: 'build #42 failed', sourceLabel: 'cloud instance "home-lab"', depth: 1,
    });
    const content: string = mockSendChatMessage.mock.calls[0][0].content;
    expect(content.split(WEBHOOK_PAYLOAD_OPEN)).toHaveLength(2); // one frame, not nested
    expect(content).toContain('build #42 failed'); // raw payload intact inside the frame
    expect(content).toContain('cloud instance "home-lab"');
    expect(content).toContain('cloud→edge relay depth 1');
  });

  it('defaults the source label when none is supplied', async () => {
    await receiveCloudMessage({ chatId: CHAT.id, message: 'ping' });
    const content: string = mockSendChatMessage.mock.calls[0][0].content;
    expect(content).toContain('the paired cloud instance');
    expect(content).toContain('cloud→edge relay depth 0');
  });
});

describe('receiveCloudMessage delivery mapping (webhook fire convention)', () => {
  it('idle chat → started', async () => {
    await expect(receiveCloudMessage({ chatId: CHAT.id, message: 'hi' }))
      .resolves.toEqual({ delivery: 'started' });
  });

  it('busy plain chat → queued with position', async () => {
    mockSendChatMessage.mockResolvedValueOnce({ queued: true, chatId: CHAT.id, position: 3 });
    await expect(receiveCloudMessage({ chatId: CHAT.id, message: 'hi' }))
      .resolves.toEqual({ delivery: 'queued', position: 3 });
  });

  it('busy coding chat → steered', async () => {
    mockSendChatMessage.mockResolvedValueOnce({ queued: true, chatId: CHAT.id, delivery: 'steer' });
    await expect(receiveCloudMessage({ chatId: CHAT.id, message: 'hi' }))
      .resolves.toEqual({ delivery: 'steered' });
  });
});

describe('receiveCloudMessageSchema (zod bounds)', () => {
  const ok = { chatId: '3f6f1c2e-0000-4000-8000-000000000000', message: 'hi' };
  it('accepts the minimal body and defaults depth to 0', () => {
    const r = receiveCloudMessageSchema.parse({ body: ok });
    expect(r.body.depth).toBe(0);
  });
  it('accepts depth up to 10 (the service rejects > MAX_CLOUD_MESSAGE_DEPTH)', () => {
    expect(receiveCloudMessageSchema.safeParse({ body: { ...ok, depth: 10 } }).success).toBe(true);
  });
  it.each([
    ['bad chatId', { ...ok, chatId: 'not-a-uuid' }],
    ['empty message', { ...ok, message: '' }],
    ['oversized message', { ...ok, message: 'x'.repeat(20_001) }],
    ['negative depth', { ...ok, depth: -1 }],
    ['depth above the schema cap', { ...ok, depth: 11 }],
    ['non-integer depth', { ...ok, depth: 1.5 }],
    ['oversized sourceLabel', { ...ok, sourceLabel: 'x'.repeat(121) }],
  ])('rejects %s', (_label, body) => {
    expect(receiveCloudMessageSchema.safeParse({ body }).success).toBe(false);
  });
});

describe('app.ts limiter helpers', () => {
  it('the path RE matches exactly the receive route (case/trailing-slash tolerant)', () => {
    expect(CLOUD_LINK_RECEIVE_PATH_RE.test('/cloud-link/receive')).toBe(true);
    expect(CLOUD_LINK_RECEIVE_PATH_RE.test('/cloud-link/receive/')).toBe(true);
    expect(CLOUD_LINK_RECEIVE_PATH_RE.test('/CLOUD-LINK/RECEIVE')).toBe(true);
    expect(CLOUD_LINK_RECEIVE_PATH_RE.test('/cloud-link/pair')).toBe(false);
    expect(CLOUD_LINK_RECEIVE_PATH_RE.test('/cloud-link/receive/extra')).toBe(false);
  });
  it('the key is per chat + IP with an unknown-chat fallback', () => {
    expect(cloudLinkReceiveLimiterKey('c1', '1.2.3.4')).toBe('chat:c1:1.2.3.4');
    expect(cloudLinkReceiveLimiterKey(undefined, undefined)).toBe('chat:unknown:noip');
    expect(cloudLinkReceiveLimiterKey(42 as any, '1.2.3.4')).toBe('chat:unknown:1.2.3.4');
  });
});
