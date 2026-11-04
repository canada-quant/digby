/**
 * The ONE owner-scoped chat-id resolver (ticket 4057952b, 2026-10-09).
 *
 * History: `resolveOwnedChatIdPrefix` was born inside platform.service.ts
 * (owner pending-card incident 2026-09-14) and grew the near-match +
 * shared-heal tiers there (audit 2026-10-08 W3-3). goals.service needed the
 * SAME resolution for todo assignee ids — the live 3× breaker streak on
 * "assigneeChatId: chat not found" was a supervisor passing the
 * fleet-standard 8-char prefix its own board prints, while goalId / todoId /
 * projectId / dependsOnTodoIds all resolve that idiom in the SAME call —
 * but platform.service pulls crossmodel.service + the coding data graph,
 * and goals.service must not pay that import at module scope. So the
 * resolver moved here (leaf: prisma + chat-id-near-match + id-ref only)
 * and platform.service re-exports it verbatim — one implementation, two
 * import sites, zero behavior change for its existing callers.
 *
 * Contract (unchanged from platform.service.ts):
 *   - Exact id → returned unchanged (any access mode — getChatById still
 *     decides).
 *   - UNIQUE ≥8-char prefix among the owner's OWN chats → the full id.
 *   - Full-shape miss → the ONE same-owner chat within NEAR_MATCH_MAX_DISTANCE
 *     characters.
 *   - Anything else (short, ambiguous, unknown, a reconstructed id) → the
 *     input unchanged, so the caller's exact-lookup 404 + did-you-mean path
 *     speaks.
 * Owner-scoped on purpose: a prefix can never widen to a member-shared or
 * foreign chat; those need the full id.
 */
import prisma from '../../../config/database';
import { isFullChatIdShape, nearMatchChatId, NEAR_MATCH_PREFIX_CHARS } from './chat-id-near-match';
import { healIdRef, type IdRefLookup } from './id-ref';

export const CHAT_ID_PREFIX_MIN = 8;

export async function resolveOwnedChatIdPrefix(userId: string, idOrPrefix: string): Promise<string> {
  const raw = String(idOrPrefix || '').trim();
  if (!raw || raw.length < CHAT_ID_PREFIX_MIN) return raw;
  // Full-shape id (owner 2026-09-18): an exact miss resolves to the ONE
  // same-owner chat within NEAR_MATCH_MAX_DISTANCE characters of it — the
  // same rule autonomy.service resolveChatTarget applies at the gate, so the
  // executor sends where the scope check looked. Ambiguity keeps the raw id
  // (the 404 did-you-mean path speaks).
  if (isFullChatIdShape(raw)) {
    const exactFull = await prisma.crossModelChat.findUnique({ where: { id: raw }, select: { id: true } });
    if (exactFull) return raw;
    const candidates = (await prisma.crossModelChat.findMany({
      where: { userId, id: { startsWith: raw.slice(0, NEAR_MATCH_PREFIX_CHARS).toLowerCase() } },
      select: { id: true },
      take: 8,
    })) as Array<{ id: string }>;
    // A well-formed full id is never spliced (platform/id-ref.ts) — the near-match tier is its heal.
    return nearMatchChatId(candidates, raw)?.id ?? raw;
  }
  if (raw.length < 36) {
    const exact = await prisma.crossModelChat.findUnique({ where: { id: raw }, select: { id: true } });
    if (exact) return raw;
    const matches = await prisma.crossModelChat.findMany({
      where: { userId, id: { startsWith: raw } },
      select: { id: true },
      take: 2,
    });
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) return raw; // ambiguous prefix — the 404 did-you-mean path speaks
  }
  return healOwnedChatId(userId, raw);
}

/** audit 2026-10-08 W3-3: the shared heal tier (platform/id-ref.ts) for chat ids —
 * a "…ec52d820" suffix, a "0037460b-ec52d820" prefix+suffix splice, an over-long
 * id with an invented middle. OWNER-scoped like the prefix tier above. Unresolved
 * → the raw id (the 404 recovery names candidates). ID_RESOLVER_HEAL_DISABLED=1. */
export function ownedChatIdLookup(userId: string): IdRefLookup {
  return {
    byPrefix: async (prefix, take) => ((await prisma.crossModelChat.findMany({ where: { userId, id: { startsWith: prefix } }, select: { id: true }, take })) as Array<{ id: string }>).map((r) => r.id),
    bySuffix: async (suffix, take) => ((await prisma.crossModelChat.findMany({ where: { userId, id: { endsWith: suffix } }, select: { id: true }, take })) as Array<{ id: string }>).map((r) => r.id),
  };
}
async function healOwnedChatId(userId: string, raw: string): Promise<string> {
  const r = await healIdRef(raw, ownedChatIdLookup(userId), 'chat');
  return r.ok ? r.id : raw;
}
