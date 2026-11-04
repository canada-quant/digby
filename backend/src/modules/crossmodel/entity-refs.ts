/**
 * Clickable references in answers (owner 2026-10-08: "interlink more … always having session goals or ids linked so
 * user can just click session fbb5c9ca and it brings them there").
 *
 * Supervisor and lane answers cite things by an 8-char id prefix (the doctrine: evidence citations stay prefixes) —
 * "session fbb5c9ca", "goal 534c37aa", "todos 536d5d52, 23014278", "receipt b3649334". The web app renders those as
 * chips (frontend/lib/entity-refs.ts) and, on click, asks GET /api/crossmodel/refs/:kind/:id where to go:
 *   chat | session  → that chat;
 *   goal            → its project page (the Sessions tab lists the lanes per goal);
 *   todo            → the lane it is assigned to, else its project page;
 *   receipt         → the session the action started (ids.sessionId / ids.chatId — e.g. start_coding_session),
 *                     else the chat that ran it.
 * OWNER-SCOPED on purpose (the same rule as resolveOwnedChatIdPrefix): a prefix never widens to a shared or foreign
 * row, and an ambiguous prefix resolves to nothing (404) — the chip then says it could not find it.
 *
 * The ENTITY_REFS_DISABLED release switch was deleted 2026-10-30 (RSW-1 delete-with-ledger, two
 * release lifetimes baked, inert in prod — compose never forwarded it): the always-on behavior is
 * the only one.
 */
import { Response } from 'express';
import prisma from '../../config/database';
import { AuthRequest } from '../../middleware/auth';
import logger from '../../utils/logger';

export const ENTITY_REF_KINDS = ['chat', 'session', 'goal', 'todo', 'receipt'] as const;
export type EntityRefKind = typeof ENTITY_REF_KINDS[number];

export type EntityRefTarget =
  | { type: 'chat'; chatId: string }
  | { type: 'project'; projectId: string };

export interface ResolvedEntityRef {
  kind: EntityRefKind;
  id: string;
  title: string | null;
  open: EntityRefTarget;
}

/** An 8..36-char lower-case hex/uuid prefix, or null. */
export function normalizeRefId(raw: unknown): string | null {
  const id = String(raw ?? '').trim().toLowerCase();
  return /^[0-9a-f][0-9a-f-]{7,35}$/.test(id) ? id : null;
}

export function isEntityRefKind(k: unknown): k is EntityRefKind {
  return typeof k === 'string' && (ENTITY_REF_KINDS as readonly string[]).includes(k);
}

/** The one row whose id starts with `id`, or null when none / more than one. */
function unique<T>(rows: T[]): T | null {
  return rows.length === 1 ? rows[0] : null;
}

async function ownedChat(userId: string, chatId: string): Promise<{ id: string; title: string | null } | null> {
  if (!chatId) return null;
  return prisma.crossModelChat.findFirst({ where: { id: chatId, userId }, select: { id: true, title: true } });
}

export async function resolveEntityRef(userId: string, kind: EntityRefKind, rawId: string): Promise<ResolvedEntityRef | null> {
  const id = normalizeRefId(rawId);
  if (!id) return null;
  if (kind === 'chat' || kind === 'session') {
    const row = unique(await prisma.crossModelChat.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true, title: true }, take: 2 }));
    return row ? { kind, id: row.id, title: row.title ?? null, open: { type: 'chat', chatId: row.id } } : null;
  }
  if (kind === 'goal') {
    const row = unique(await prisma.projectGoal.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true, title: true, projectId: true }, take: 2 }));
    return row ? { kind, id: row.id, title: row.title, open: { type: 'project', projectId: row.projectId } } : null;
  }
  if (kind === 'todo') {
    const row = unique(await prisma.projectTodo.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true, title: true, projectId: true, assigneeChatId: true }, take: 2 }));
    if (!row) return null;
    const lane = row.assigneeChatId ? await ownedChat(userId, row.assigneeChatId) : null;
    return { kind, id: row.id, title: row.title, open: lane ? { type: 'chat', chatId: lane.id } : { type: 'project', projectId: row.projectId } };
  }
  // receipt
  const row = unique(await prisma.runToolReceipt.findMany({ where: { id: { startsWith: id }, chat: { userId } }, select: { id: true, tool: true, chatId: true, ids: true }, take: 2 }));
  if (!row) return null;
  const ids = (row.ids && typeof row.ids === 'object' ? row.ids : {}) as Record<string, unknown>;
  const started = typeof ids.sessionId === 'string' ? ids.sessionId : (typeof ids.chatId === 'string' ? ids.chatId : '');
  const target = (started && started !== row.chatId ? await ownedChat(userId, started) : null) ?? { id: row.chatId };
  return { kind, id: row.id, title: row.tool, open: { type: 'chat', chatId: target.id } };
}

/** GET /api/crossmodel/refs/:kind/:id */
export async function resolveEntityRefHandler(req: AuthRequest, res: Response): Promise<void> {
  const notFound = () => { res.status(404).json({ success: false, error: 'Not found' }); };
  const userId = req.user?.id;
  const { kind, id } = req.params as { kind?: string; id?: string };
  if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }
  if (!isEntityRefKind(kind) || !normalizeRefId(id)) return notFound();
  try {
    const ref = await resolveEntityRef(userId, kind, id as string);
    if (!ref) return notFound();
    res.json({ success: true, data: ref });
  } catch (err) {
    logger.warn(`entity ref resolve failed (${kind}): ${(err as Error)?.message || String(err)}`);
    notFound();
  }
}
