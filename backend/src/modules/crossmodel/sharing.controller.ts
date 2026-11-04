import { Request, Response } from 'express';
import prisma from '../../config/database';
// 2026-09-08: create/reactivate + revoke logic moved to sharing.service.ts so
// the account tools (platform/account-tools.ts create_share_link /
// revoke_share_link) share ONE implementation with these endpoints. The
// handlers below only map the service's structured results back onto the
// exact status codes / response shapes they always returned.
import * as sharingService from './sharing.service';
// Shared-chat generated images (generate_image tranche B, 2026-09-24): the
// public byte route reuses the owner routes' image-mime rule and byte sender.
import { isInlineImageMime, sendGeneratedFileBytes } from './generated-files.controller';
import { resolveViewModeForRequest } from './view/view-mode';
import { minimalMessages } from './view/minimal-view';

// ── Public share-link gate (shared by the page payload + the image bytes) ─────

export type ShareLinkAccess = 'ok' | 'not_found' | 'revoked' | 'expired' | 'coding';

/**
 * The public-read gate getSharedChat has always applied, factored so the
 * shared-chat image byte route applies the SAME checks: the link must exist,
 * be active, be unexpired, and never point at a coding chat (defense-in-depth,
 * amendment D1 / P5-B: the workspace satellite is the coding marker). Pure.
 */
export function shareLinkAccess(
  link: { isActive: boolean; expiresAt: Date | null; chat?: { codingState?: unknown } | null } | null | undefined,
  now: Date = new Date()
): ShareLinkAccess {
  if (!link) return 'not_found';
  if (!link.isActive) return 'revoked';
  if (link.expiresAt && link.expiresAt < now) return 'expired';
  if (link.chat?.codingState) return 'coding';
  return 'ok';
}

// ── Generated images on the public payload ────────────────────────────────────

/** One generated image on a public shared-chat message. */
export interface SharedChatImage {
  /** GeneratedFile id — the token-scoped route below is keyed on it. */
  fileId: string;
  /** Token-scoped PUBLIC byte route (API path) — never the authed /generated-files url. */
  url: string;
  name?: string;
  prompt?: string;
  mediaType?: string;
}

/** API path of a shared chat's generated-image bytes (public-share.routes.ts). */
export const sharedChatImagePath = (token: string, fileId: string): string =>
  `/api/crossmodel/shared/chat/${encodeURIComponent(token)}/image/${encodeURIComponent(fileId)}`;

/**
 * Project a message's persisted transcript `parts` onto the PUBLIC share
 * payload. ONLY generated images survive — `type:'image'` + `source:'generated'`
 * with a GeneratedFile id — and only as a field WHITELIST (fileId, the
 * token-scoped url, name, prompt, mediaType). Everything else a transcript
 * holds is the owner's business and never leaves: tool_call / tool_result /
 * reasoning / subagent parts, browser or computer screenshots (they picture
 * the owner's own screen), plain attachments, and base64 `data` on ANY part
 * (a live/echo image part can still carry bytes). The persisted url
 * (/api/crossmodel/generated-files/<id>/inline) is authed and useless to a
 * viewer, so it is rewritten to the public route. Pure; tolerant of a non-
 * array `parts` (legacy rows store null).
 */
export function sharedImagesFromParts(parts: unknown, token: string): SharedChatImage[] {
  if (!Array.isArray(parts)) return [];
  const out: SharedChatImage[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const part = p as Record<string, unknown>;
    if (part.type !== 'image' || part.source !== 'generated') continue;
    const fileId = typeof part.fileId === 'string' ? part.fileId.trim() : '';
    if (!fileId) continue; // unroutable without a row id — dropped, never guessed
    const img: SharedChatImage = { fileId, url: sharedChatImagePath(token, fileId) };
    if (typeof part.name === 'string' && part.name) img.name = part.name;
    if (typeof part.prompt === 'string' && part.prompt) img.prompt = part.prompt;
    if (typeof part.mediaType === 'string' && part.mediaType) img.mediaType = part.mediaType;
    out.push(img);
  }
  return out;
}

/**
 * The generated-image parts of every message in a chat, projected IN SQL —
 * keyed by message id, value = the jsonb array `sharedImagesFromParts` then
 * whitelists (so the field rule is enforced exactly once, in one place).
 *
 * Why not `select: { parts: true }` on the message read: `parts` persists
 * browser_task / computer_task screenshots WITH inline base64 (coding/agent.ts:
 * "Screenshots keep the inline shape"), and the public share page is an
 * unauthenticated route with no rate limiter. Selecting `parts` made every
 * anonymous hit pull and JSON-parse multi-MB rows the server then discarded —
 * a resource-amplification footgun for anyone holding a share URL. Here the
 * database does the filtering: `jsonb_path_exists` keeps only messages that
 * hold a generated image (picture-less messages transfer NOTHING), the
 * subselect keeps only `type:'image' && source:'generated'` elements, and
 * `- 'data'` drops any base64 a stray part might carry — so the wire carries
 * only the small URL-only objects generate_image persists. `jsonb_typeof =
 * 'array'` mirrors the projector's non-array tolerance (legacy rows: null).
 * Element order is preserved (WITH ORDINALITY) so figures keep transcript order.
 */
export async function loadSharedGeneratedImageParts(chatId: string): Promise<Map<string, unknown>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; gen: unknown }>>`
    SELECT m.id,
           (SELECT jsonb_agg(t.e - 'data' ORDER BY t.ord)
              FROM jsonb_array_elements(m.parts) WITH ORDINALITY AS t(e, ord)
             WHERE t.e->>'type' = 'image' AND t.e->>'source' = 'generated') AS gen
      FROM crossmodel_messages m
     WHERE m."chatId" = ${chatId}
       AND jsonb_typeof(m.parts) = 'array'
       AND jsonb_path_exists(m.parts, '$[*] ? (@.type == "image" && @.source == "generated")')
  `;
  return new Map(rows.map(r => [r.id, r.gen]));
}

// ── Create or get share link for a chat ───────────────────────────────────────
export async function createChatShareLink(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id: chatId } = req.params;
    const { expiresInDays } = req.body; // optional: 7 | 30 | null (never)

    // Owner check, coding-chat refusal, expiry math and the create-or-
    // reactivate write all live in sharing.service (shared with the
    // create_share_link account tool). Status codes preserved verbatim.
    const result = await sharingService.createOrReactivateChatShareLink({ chatId, userId, expiresInDays });
    if (!result.ok) {
      if (result.reason === 'coding_chat') {
        return res.status(400).json({ error: 'Coding chats cannot be shared publicly' });
      }
      return res.status(404).json({ error: 'Chat not found' });
    }

    res.json({
      shareToken: result.shareToken,
      shareUrl: result.shareUrl,
      isActive: result.isActive,
      expiresAt: result.expiresAt,
      createdAt: result.createdAt,
    });
  } catch (err) {
    console.error('createChatShareLink error:', err);
    res.status(500).json({ error: 'Failed to create share link' });
  }
}

// ── Revoke share link for a chat ──────────────────────────────────────────────
export async function revokeChatShareLink(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id: chatId } = req.params;

    const result = await sharingService.revokeChatShareLink({ chatId, userId });
    if (!result.ok) {
      if (result.reason === 'no_link') {
        return res.status(404).json({ error: 'No share link exists for this chat' });
      }
      return res.status(404).json({ error: 'Chat not found' });
    }

    res.json({ success: true, message: 'Share link revoked' });
  } catch (err) {
    console.error('revokeChatShareLink error:', err);
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
}

// ── Public view of a shared chat (no auth required) ───────────────────────────
export async function getSharedChat(req: Request, res: Response) {
  try {
    const { token } = req.params;

    const shareLink = await prisma.chatShareLink.findUnique({
      where: { shareToken: token },
      include: {
        chat: {
          include: {
            user: { select: { name: true } }, // email intentionally NOT selected — public route
            project: { select: { id: true, name: true, emoji: true, color: true } },
            codingState: { select: { id: true } }, // P5-B: satellite = coding marker
            chatMessages: {
              orderBy: { createdAt: 'asc' },
              // `parts` is deliberately NOT selected: it persists browser /
              // computer screenshots with inline base64, and this is an
              // unauthenticated, unrate-limited route. Generated images are
              // projected in SQL instead (loadSharedGeneratedImageParts) —
              // `id` is selected only to join that projection back.
              select: { id: true, role: true, content: true, metadata: true, createdAt: true },
            },
          },
        },
      },
    });

    // Status codes / bodies are the ones this endpoint always returned; the
    // decision itself lives in shareLinkAccess (shared with the image route).
    const access = shareLinkAccess(shareLink);
    if (access === 'not_found' || !shareLink) {
      return res.status(404).json({ error: 'Share link not found' });
    }
    if (access === 'revoked') {
      return res.status(410).json({ error: 'This share link has been revoked' });
    }
    if (access === 'expired') {
      return res.status(410).json({ error: 'This share link has expired' });
    }
    // Defense-in-depth (amendment D1): never serve a coding chat publicly, even
    // if a link predates the creation-side gate. P5-B: the satellite is the
    // marker (mode='code' is gone).
    if (access === 'coding') {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const { chat } = shareLink;

    // Generated-image projection, fetched in SQL only once the gate has passed
    // (a revoked/expired link costs no second query). Empty map = no pictures.
    const generatedByMessage = chat.chatMessages.length
      ? await loadSharedGeneratedImageParts(chat.id)
      : new Map<string, unknown>();

    // Format messages from normalized table. `images` (generate_image tranche
    // B) is present only when the message holds generated images — chats
    // without any serialize exactly as before.
    const messages = chat.chatMessages.map(m => {
      const images = sharedImagesFromParts(generatedByMessage.get(m.id), token);
      return {
        role: m.role,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        ...(m.metadata ? { metadata: m.metadata } : {}),
        ...(images.length ? { images } : {}),
      };
    });

    // Minimal view (2026-10-16, view/minimal-view.ts): a public reader gets the conversation, not the machinery.
    const viewMessages = (await resolveViewModeForRequest(req as any)) === 'minimal'
      ? minimalMessages(messages).filter((m: any) => !m.minimal)
      : messages;

    res.json({
      id: chat.id,
      title: chat.title,
      mode: chat.mode,
      messages: viewMessages,
      ownerName: chat.user.name ?? 'Digby user', // never leak the owner's email on a public page
      project: chat.project
        ? {
            id: chat.project.id,
            name: chat.project.name,
            emoji: chat.project.emoji,
            color: chat.project.color,
          }
        : null,
      sharedAt: shareLink.createdAt,
      expiresAt: shareLink.expiresAt,
    });
  } catch (err) {
    console.error('getSharedChat error:', err);
    res.status(500).json({ error: 'Failed to load shared chat' });
  }
}

// ── Public generated-image bytes of a shared chat (no auth required) ──────────
// GET /shared/chat/:token/image/:fileId — what the public page's figures load.
// The share token is the ONLY credential: the link must pass the same gate as
// the page payload, and the GeneratedFile must belong to the chat's owner AND
// have been created in THIS chat (file.chatId) — a token never unlocks the
// owner's other pictures. Image-only (SVG refused like the owner route). Every
// refusal is the same 404: a public caller must not learn whether a link is
// revoked/expired (the page endpoint says so — but only for its own token)
// or whether a file id exists / is a non-image (no 415 leak).
export async function getSharedChatImage(req: Request, res: Response) {
  try {
    const { token, fileId } = req.params;
    const notFound = () => res.status(404).json({ error: 'Not found' });

    const shareLink = await prisma.chatShareLink.findUnique({
      where: { shareToken: token },
      include: { chat: { select: { id: true, userId: true, codingState: { select: { id: true } } } } },
    });
    if (shareLinkAccess(shareLink) !== 'ok') return notFound();
    const { chat } = shareLink!;

    const file = await prisma.generatedFile.findUnique({ where: { id: fileId } });
    if (!file || file.userId !== chat.userId || file.chatId !== chat.id || !isInlineImageMime(file.mimeType)) {
      return notFound();
    }

    // `public` (not the owner routes' `private`): the response is the same for
    // every viewer of the link, so a shared cache may keep it for the hour.
    sendGeneratedFileBytes(res, file, { disposition: 'inline', cacheControl: 'public, max-age=3600' });
  } catch (err) {
    console.error('getSharedChatImage error:', err);
    res.status(500).json({ error: 'Failed to load image' });
  }
}

// ── Get share link status for a chat ─────────────────────────────────────────
export async function getChatShareStatus(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id: chatId } = req.params;

    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId } });
    if (!chat || chat.userId !== userId) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const shareLink = await prisma.chatShareLink.findUnique({ where: { chatId } });

    if (!shareLink || !shareLink.isActive) {
      return res.json({ hasShareLink: false });
    }

    res.json({
      hasShareLink: true,
      shareToken: shareLink.shareToken,
      shareUrl: sharingService.shareUrlForToken(shareLink.shareToken),
      expiresAt: shareLink.expiresAt,
      createdAt: shareLink.createdAt,
    });
  } catch (err) {
    console.error('getChatShareStatus error:', err);
    res.status(500).json({ error: 'Failed to get share status' });
  }
}

// ── List all files across user's projects ─────────────────────────────────────
export async function listAllFiles(req: Request, res: Response) {
  try {
    const userId = req.user!.id;

    const documents = await prisma.projectDocument.findMany({
      where: { userId },
      include: {
        project: { select: { id: true, name: true, emoji: true, color: true } },
        _count: { select: { chunks: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      documents.map((d) => ({
        id: d.id,
        name: d.name,
        mimeType: d.mimeType,
        sourceUrl: d.sourceUrl,
        source: (d as any).source ?? 'knowledge',
        charCount: d.charCount,
        chunkCount: d.chunkCount,
        status: d.status,
        errorMsg: d.errorMsg,
        createdAt: d.createdAt,
        project: d.project,
      }))
    );
  } catch (err) {
    console.error('listAllFiles error:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
}

export default {
  createChatShareLink,
  revokeChatShareLink,
  getSharedChat,
  getSharedChatImage,
  getChatShareStatus,
  listAllFiles,
};
