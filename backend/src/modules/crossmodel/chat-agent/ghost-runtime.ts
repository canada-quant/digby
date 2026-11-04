/**
 * Ghost-mode RUNTIME shared leaf (import-light on purpose — chat-agent.service
 * imports it; the designation service imports only the switch read from here).
 *
 * Keeps the kill switch + the per-chat/run ghost predicates in ONE place so
 * the schema flag, the run seam and the privacy gates can never disagree.
 */

/** Kill switch: CHAT_GHOST_MODE_DISABLED=1 turns ghost mode off instance-wide
 *  (the designation is kept but never honoured; chats run their normal lineup). */
export function ghostModeDisabled(): boolean {
  return process.env.CHAT_GHOST_MODE_DISABLED === '1';
}

/** A ghost RUN is a run whose chat row (or guest send) asked for ghost mode. */
export function isGhostChatRow(row: { ghostMode?: boolean | null } | null | undefined): boolean {
  return row?.ghostMode === true;
}
