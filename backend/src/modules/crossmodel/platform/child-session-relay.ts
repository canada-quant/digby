/**
 * Child-session relay detection (ticket 739e8191, owner report 2026-11-02).
 *
 * WHY: the owner's complaint in chat 99e63f86 was "you don't seem to communicate
 * with the user/human after you get a message from a sub session … you should
 * then relay to me whatever message was sent back from the subsession if it is
 * relevant to our context//ie/... the agent has finished the work and everything
 * is done". The parent DID relay (msgs 1eb953b3 → 3e29ea9b and 67071bba →
 * 992dd445 in that transcript) — but the relay row arrives as an
 * `[AGENT-SENT MESSAGE — …]` user row with metadata.origin 'agent', which every
 * consumer classifies as internal machine noise: the frontend machine-turn
 * grouping folds it (and its answering reply) into a collapsed accordion, and
 * the minimal/fleet views hide the reply outright. So the delivered sub-session
 * result was ON the page and never SEEN.
 *
 * The existing child→parent RESULT HOOK already solved this class for its own
 * delivery shape: `metadata.childResult` on the wake anchor makes the frontend
 * mount the turn EXPANDED (ticket 56d6b204, chat 6e36c834) and the backend
 * flatten it for the client probe. That marker was only ever stamped by
 * hooks.service for the auto-wired result hook — never for a child session
 * talking to its parent through `send_chat_message`, which is the far more
 * common path (a lane that finishes and REPORTS BACK).
 *
 * WHAT: `metadata.childResult` is the ONE signal the whole seam already
 * understands (frontend grouping + fleet flatten + the view layers). This leaf
 * decides when an agent-origin send is really a CHILD SESSION reporting to its
 * PARENT, so the persist seam can stamp that same signal — and the read-side
 * predicates can honour it for rows written before the stamp existed.
 *
 * Lineage authority is `crossmodel_chats.parentChatId` alone (schema pinned:
 * "parentChatId stays the one lineage authority"). A relay from a NON-child
 * chat (a sibling lane, the Fleet Supervisor, a teammate's chat) stays ordinary
 * machine traffic — supervisor fan-out must not start rendering as delivered
 * owner content. Pure predicate + one indexed lookup; no other imports.
 */

/** The minimum a chat row must expose for the lineage check. */
export interface ChildLineageRow {
  parentChatId?: string | null;
}

/**
 * PURE: is a message sent BY `sourceChatId` INTO `targetChatId` a child session
 * reporting to its parent? Both ids are required and must differ — a chat is
 * never its own child. Absent/unresolvable lineage ⇒ false (conservative: an
 * unknown sender is ordinary machine traffic, never invented owner content).
 */
export function isChildSessionRelay(
  targetChatId: string | null | undefined,
  sourceChatId: string | null | undefined,
  sourceRow: ChildLineageRow | null | undefined,
): boolean {
  if (!targetChatId || !sourceChatId) return false;
  if (targetChatId === sourceChatId) return false;
  return sourceRow?.parentChatId === targetChatId;
}

/**
 * The transcript-row predicate both read-side layers share: a row is a
 * child-session relay when it is an AGENT-origin send whose metadata names the
 * sending chat (metadata.sourceChatId / originSourceChatId — both spellings are
 * persisted today) and that sender is a child of the chat being read.
 *
 * `childIds` is the caller's pre-fetched set of THIS chat's child chat ids
 * (one indexed query per request, never per row).
 */
export function isChildRelayRow(
  row: { metadata?: unknown },
  childIds: ReadonlySet<string> | null | undefined,
): boolean {
  if (!childIds || childIds.size === 0) return false;
  const meta = row?.metadata;
  if (!meta || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  const sender = typeof m.sourceChatId === 'string' && m.sourceChatId
    ? m.sourceChatId
    : typeof m.originSourceChatId === 'string' && m.originSourceChatId
      ? m.originSourceChatId
      : null;
  return !!sender && childIds.has(sender);
}

/** metadata.childResult — the delivered-sub-session-result marker both the
 *  result hook and (now) a child relay stamp on the anchor row. */
export function rowHasChildResult(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).childResult === true;
}

/**
 * The PERSIST-side twin of `isChildRelayRow` (ticket 327ff5e3 — residual of
 * 739e8191/1757b07d): decide at SEND time whether an agent-origin send is a
 * child session reporting to its parent, so the row can be stamped with
 * `metadata.childResult` and every downstream consumer (frontend grouping,
 * minimal view, fleet flatten) sees the delivered result without having to
 * re-derive lineage.
 *
 * WHY a persist stamp at all: `isChildRelayRow` is a READ-side filter, and the
 * only reader wired to it was the fleet/Management thread (fleet.service
 * `childChatIdsFor`). A relay landing in a PLAIN chat carried no marker, so the
 * frontend's grouping probe (`probe.childResult === true`) could never fire
 * there and the sub-session's result stayed folded inside the collapsed
 * machine-turn accordion — the very symptom 1757b07d was filed for.
 *
 * The lookup is INJECTED (the leaf stays import-free) and is ONE indexed
 * parentChatId PK read, issued only for an agent-origin send that names a
 * sender (never per row on a read path). Anything unresolved fails CLOSED —
 * no stamp, never a throw: a lineage hiccup must degrade to today's rendering,
 * never break a send.
 */
export async function isChildSessionRelaySend(input: {
  targetChatId: string | null | undefined;
  sourceChatId: string | null | undefined;
  /** One PK read of the SENDER chat row (id → parentChatId). May throw. */
  lookupSender?: (chatId: string) => Promise<ChildLineageRow | null | undefined>;
}): Promise<boolean> {
  const { targetChatId, sourceChatId, lookupSender } = input;
  if (!targetChatId || !sourceChatId || !lookupSender) return false;
  // Cheapest refusal first — a chat is never its own child, and both ids must exist.
  if (targetChatId === sourceChatId) return false;
  let senderRow: ChildLineageRow | null | undefined;
  try {
    senderRow = await lookupSender(sourceChatId);
  } catch {
    // Fail closed: unknown lineage ⇒ ordinary machine traffic (no stamp).
    return false;
  }
  return isChildSessionRelay(targetChatId, sourceChatId, senderRow);
}
