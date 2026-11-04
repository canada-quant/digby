/**
 * Chat share-link service (extracted 2026-09-08 from sharing.controller.ts).
 *
 * WHY a service: the "Digby operates Digby" account tools (platform/account-
 * tools.ts — create_share_link / revoke_share_link) need the exact create/
 * reactivate/revoke semantics the REST endpoints enforce (owner-only, coding
 * chats never shareable, re-activate instead of duplicating, expiry math)
 * without going through Express. The controller now delegates here and maps
 * the structured results back onto its ORIGINAL status codes and response
 * shapes byte-for-byte (404 'Chat not found', 400 'Coding chats cannot be
 * shared publicly', 404 'No share link exists for this chat') — no HTTP
 * behavior changed. The public read (getSharedChat) and the status read stay
 * in the controller: they have no second caller.
 *
 * Import discipline: this module imports prisma STATICALLY like every other
 * service in this folder. Agent-loop callers (account-tools.ts) reach it via
 * DYNAMIC import so platform-tools' jest-mockable static graph stays as is.
 */

import { randomBytes } from 'crypto';
import prisma from '../../config/database';

/** The public share page URL for a token — the same host rule the controller always used. */
export function shareUrlForToken(shareToken: string): string {
  const host = process.env.FRONTEND_URL?.split(',')[0] ?? 'http://crossmodel.cozz';
  return `${host}/shared/chat/${shareToken}`;
}

export type CreateShareLinkResult =
  | {
      ok: true;
      shareToken: string;
      shareUrl: string;
      isActive: boolean;
      expiresAt: Date | null;
      createdAt: Date;
      /** True when an existing (revoked or live) link was re-activated instead of minted. */
      reactivated: boolean;
    }
  /** Unknown chat OR not owned by this user — one reason, no existence leak. */
  | { ok: false; reason: 'not_found' }
  /** One-Digby merge (amendment D1): coding chats are never publicly shareable. */
  | { ok: false; reason: 'coding_chat' };

/**
 * Create a public read-only share link for a chat, or re-activate the chat's
 * existing one (one link row per chat — ChatShareLink.chatId is unique).
 * Owner-only. expiresInDays: a positive number sets expiry that many days
 * out; anything else (undefined/null/non-number) = never expires — the exact
 * `expiresInDays && typeof expiresInDays === 'number'` rule the controller had.
 */
export async function createOrReactivateChatShareLink(opts: {
  chatId: string;
  userId: string;
  expiresInDays?: unknown;
}): Promise<CreateShareLinkResult> {
  const { chatId, userId, expiresInDays } = opts;

  // Verify the chat belongs to this user
  const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId } });
  if (!chat || chat.userId !== userId) return { ok: false, reason: 'not_found' };

  // One-Digby merge (amendment D1): coding chats are not shareable — their
  // transcripts live in coding_messages (a public page would render empty)
  // and can contain tool output from the owner's environment.
  // P5-B: coding chats are known by their workspace satellite (mode='code'
  // is gone — legacy coding chats all carry the satellite).
  const codingState = await (prisma as any).chatCodingState
    .findUnique({ where: { id: chatId }, select: { id: true } })
    .catch(() => null);
  if (codingState) return { ok: false, reason: 'coding_chat' };

  // Calculate expiry
  let expiresAt: Date | null = null;
  if (expiresInDays && typeof expiresInDays === 'number') {
    expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  }

  // Create or re-activate existing share link
  const existing = await prisma.chatShareLink.findUnique({ where: { chatId } });

  let shareLink;
  if (existing) {
    // Re-activate and optionally update expiry
    shareLink = await prisma.chatShareLink.update({
      where: { chatId },
      data: { isActive: true, expiresAt },
    });
  } else {
    shareLink = await prisma.chatShareLink.create({
      data: {
        chatId,
        shareToken: randomBytes(20).toString('hex'),
        isActive: true,
        expiresAt,
      },
    });
  }

  return {
    ok: true,
    shareToken: shareLink.shareToken,
    shareUrl: shareUrlForToken(shareLink.shareToken),
    isActive: shareLink.isActive,
    expiresAt: shareLink.expiresAt,
    createdAt: shareLink.createdAt,
    reactivated: !!existing,
  };
}

export type RevokeShareLinkResult =
  | { ok: true; revoked: true }
  /** Unknown chat OR not owned by this user. */
  | { ok: false; reason: 'not_found' }
  /** The chat never had a share link (nothing to revoke). */
  | { ok: false; reason: 'no_link' };

/**
 * Revoke (deactivate) a chat's share link. Owner-only. The row is kept
 * (isActive=false) so a later create re-activates the SAME token — the
 * controller's long-standing behavior.
 */
export async function revokeChatShareLink(opts: { chatId: string; userId: string }): Promise<RevokeShareLinkResult> {
  const { chatId, userId } = opts;

  const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId } });
  if (!chat || chat.userId !== userId) return { ok: false, reason: 'not_found' };

  const existing = await prisma.chatShareLink.findUnique({ where: { chatId } });
  if (!existing) return { ok: false, reason: 'no_link' };

  await prisma.chatShareLink.update({
    where: { chatId },
    data: { isActive: false },
  });

  return { ok: true, revoked: true };
}
