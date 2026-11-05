/**
 * sharing.service (extracted 2026-09-08 from sharing.controller.ts) — the
 * create/reactivate + revoke share-link semantics shared by the REST endpoints
 * and the create_share_link / revoke_share_link account tools, with prisma
 * mocked at the boundary.
 *
 * Pins: owner-only (foreign/unknown chat → not_found, one reason), coding chats
 * refused (satellite marker), expiry math (positive number → N days, anything
 * else → never), create vs re-activate (unique chatId), revoke keeps the row
 * (isActive=false) and reports no_link when none exists, and the share URL
 * host rule.
 */

const prismaMock = {
  crossModelChat: { findUnique: jest.fn() },
  chatCodingState: { findUnique: jest.fn() },
  chatShareLink: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: prismaMock }));

import { createOrReactivateChatShareLink, revokeChatShareLink, shareUrlForToken } from './sharing.service';

const OWNER = 'u1';
const NOW = Date.now();

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.crossModelChat.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === 'chat-1' ? { id: 'chat-1', userId: OWNER } : null);
  prismaMock.chatCodingState.findUnique.mockImplementation(async () => null);
  prismaMock.chatShareLink.findUnique.mockImplementation(async () => null);
  prismaMock.chatShareLink.create.mockImplementation(async ({ data }: any) => ({ ...data, id: 'sl1', createdAt: new Date(NOW) }));
  prismaMock.chatShareLink.update.mockImplementation(async ({ where, data }: any) => ({
    id: 'sl1', chatId: where.chatId, shareToken: 'existingtoken', isActive: data.isActive, expiresAt: data.expiresAt ?? null, createdAt: new Date(NOW - 1000),
  }));
});

describe('shareUrlForToken', () => {
  it('uses the FIRST FRONTEND_URL entry (comma list) and the legacy fallback host', () => {
    const prev = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://digby.ai,http://localhost:8247';
    expect(shareUrlForToken('abc')).toBe('https://digby.ai/shared/chat/abc');
    delete process.env.FRONTEND_URL;
    expect(shareUrlForToken('abc')).toBe('http://example-local.test/shared/chat/abc');
    if (prev !== undefined) process.env.FRONTEND_URL = prev;
  });
});

describe('createOrReactivateChatShareLink', () => {
  it('creates a fresh 40-hex token link that never expires when expiresInDays is omitted', async () => {
    const r = await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: OWNER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shareToken).toMatch(/^[0-9a-f]{40}$/);
    expect(r.expiresAt).toBeNull();
    expect(r.isActive).toBe(true);
    expect(r.reactivated).toBe(false);
    expect(r.shareUrl).toContain(`/shared/chat/${r.shareToken}`);
    expect(prismaMock.chatShareLink.create).toHaveBeenCalledWith({ data: { chatId: 'chat-1', shareToken: r.shareToken, isActive: true, expiresAt: null } });
    expect(prismaMock.chatShareLink.update).not.toHaveBeenCalled();
  });

  it('computes expiresAt from a positive numeric expiresInDays; non-numbers/0/null mean never', async () => {
    const r7 = await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: OWNER, expiresInDays: 7 });
    expect(r7.ok && r7.expiresAt).toBeTruthy();
    if (r7.ok && r7.expiresAt) {
      const delta = r7.expiresAt.getTime() - Date.now();
      expect(delta).toBeGreaterThan(7 * 86_400_000 - 5_000);
      expect(delta).toBeLessThanOrEqual(7 * 86_400_000);
    }
    for (const bad of ['7', 0, null, undefined, {}]) {
      const r = await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: OWNER, expiresInDays: bad });
      expect(r.ok && r.expiresAt).toBeNull();
    }
  });

  it('re-activates an existing link (same token) instead of creating a second row', async () => {
    prismaMock.chatShareLink.findUnique.mockImplementation(async () => ({ id: 'sl1', chatId: 'chat-1', shareToken: 'existingtoken', isActive: false, expiresAt: null }));
    const r = await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: OWNER, expiresInDays: 30 });
    expect(r).toMatchObject({ ok: true, shareToken: 'existingtoken', isActive: true, reactivated: true });
    expect(prismaMock.chatShareLink.update).toHaveBeenCalledWith({ where: { chatId: 'chat-1' }, data: { isActive: true, expiresAt: expect.any(Date) } });
    expect(prismaMock.chatShareLink.create).not.toHaveBeenCalled();
  });

  it('refuses a foreign or unknown chat with ONE reason (not_found) and never touches the link table', async () => {
    expect(await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: 'someone-else' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await createOrReactivateChatShareLink({ chatId: 'nope', userId: OWNER })).toEqual({ ok: false, reason: 'not_found' });
    expect(prismaMock.chatShareLink.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.chatShareLink.create).not.toHaveBeenCalled();
  });

  it('refuses a coding chat (workspace satellite present) — coding_chat', async () => {
    prismaMock.chatCodingState.findUnique.mockImplementation(async () => ({ id: 'chat-1' }));
    expect(await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: OWNER })).toEqual({ ok: false, reason: 'coding_chat' });
    expect(prismaMock.chatShareLink.create).not.toHaveBeenCalled();
    // a satellite lookup failure is treated as "not coding" (the controller's .catch(() => null))
    prismaMock.chatCodingState.findUnique.mockRejectedValueOnce(new Error('boom'));
    expect((await createOrReactivateChatShareLink({ chatId: 'chat-1', userId: OWNER })).ok).toBe(true);
  });
});

describe('revokeChatShareLink', () => {
  it('deactivates (keeps the row) and reports revoked', async () => {
    prismaMock.chatShareLink.findUnique.mockImplementation(async () => ({ id: 'sl1', chatId: 'chat-1', shareToken: 't', isActive: true }));
    expect(await revokeChatShareLink({ chatId: 'chat-1', userId: OWNER })).toEqual({ ok: true, revoked: true });
    expect(prismaMock.chatShareLink.update).toHaveBeenCalledWith({ where: { chatId: 'chat-1' }, data: { isActive: false } });
  });

  it('no_link when the chat never had a link; not_found for foreign/unknown chats', async () => {
    expect(await revokeChatShareLink({ chatId: 'chat-1', userId: OWNER })).toEqual({ ok: false, reason: 'no_link' });
    expect(await revokeChatShareLink({ chatId: 'chat-1', userId: 'someone-else' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await revokeChatShareLink({ chatId: 'nope', userId: OWNER })).toEqual({ ok: false, reason: 'not_found' });
    expect(prismaMock.chatShareLink.update).not.toHaveBeenCalled();
  });
});
