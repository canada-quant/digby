/**
 * First-class confirmation UX — cross-surface PENDING-CONFIRMATION presence.
 *
 * ONE Redis key per chat — `confirm:pending:{chatId}` — written while ANY agent
 * surface is blocked on a human: an ask_user question (chat run or coding
 * session) or an ask-only approval (permission_request). The writer is whichever
 * process runs the agent (WEB for chat runs, WORKER for coding runs) — Redis
 * makes the key visible to the web process regardless of which tier wrote it.
 * Cleared on EVERY exit from the wait (answer/decision, registry timeout,
 * Stop-force-resolve) by the same wrapper that published it; the TTL is only
 * the backstop for a hard process death mid-wait. Read by
 * GET /api/crossmodel/confirmations/pending (the sidebar indicator poll).
 *
 * Keying: coding sessions live on crossModelChat rows, so the session id IS the
 * chat id (P5-B); chat-agent runs key on the chat id too (runSessionId).
 * Anonymous chat runs (anon-* sentinels) never publish — no authenticated poll
 * could ever see them.
 *
 * Best-effort like session-run-lock: a Redis hiccup degrades to "nothing
 * pending", never a thrown 500 into a list endpoint.
 */

import redisClient from '../../config/redis';

const KEY = (chatId: string) => `confirm:pending:${chatId}`;
/** Matches the question-registry window (60 min) + answer grace (2 min) + margin
 *  — a key must never expire while the run is still legitimately awaiting. */
const CONFIRM_PENDING_TTL_SEC = 3960;

export interface ConfirmPendingEntry {
  kind: 'question' | 'approval';
  /** questionId / approvalId — the id the matching resolve endpoint takes. */
  id: string;
  /** Human-displayable prompt (the ask_user question, or "Allow <tool>…?" for approvals). */
  question: string;
  /** Quick-pick answers (ask_user options) or the approval decisions. */
  options: string[];
  /** The gated tool name — approvals only. */
  tool?: string;
  /** When the wait started (ms epoch). */
  ts: number;
  /** Soft answer deadline (ms epoch) — questions only. The client renders a
   *  countdown from this and auto-expires the card; a server-side grace window
   *  beyond it still absorbs in-flight answers. */
  expiresAt?: number;
}

/** Mark a chat as blocked on a human decision (agent-side, on every wait start). */
export async function publishConfirmPending(chatId: string, entry: ConfirmPendingEntry): Promise<void> {
  await redisClient.set(KEY(chatId), JSON.stringify(entry), { EX: CONFIRM_PENDING_TTL_SEC }).catch(() => {});
}

/** Clear the pending marker (agent-side, on resolve AND on timeout). */
export async function clearConfirmPending(chatId: string): Promise<void> {
  await redisClient.del(KEY(chatId)).catch(() => {});
}

/**
 * Read the pending entries for a batch of chats (web-side aggregation endpoint).
 * ONE MGET for the whole fleet; malformed/missing entries are skipped.
 * Returns chatId → entry.
 */
export async function readConfirmPendingForChats(chatIds: string[]): Promise<Map<string, ConfirmPendingEntry>> {
  const out = new Map<string, ConfirmPendingEntry>();
  if (!chatIds.length) return out;
  const values = await (redisClient as any).mGet(chatIds.map(KEY)).catch(() => [] as unknown[]);
  if (!Array.isArray(values)) return out;
  chatIds.forEach((chatId, i) => {
    const raw = values[i];
    if (typeof raw !== 'string' || !raw) return;
    try {
      const p = JSON.parse(raw);
      if ((p?.kind === 'question' || p?.kind === 'approval') && typeof p.id === 'string' && typeof p.question === 'string') {
        out.set(chatId, {
          kind: p.kind,
          id: p.id,
          question: p.question,
          options: Array.isArray(p.options) ? p.options.map((o: any) => String(o)) : [],
          ...(typeof p.tool === 'string' ? { tool: p.tool } : {}),
          ts: Number(p.ts) || 0,
          ...(Number.isFinite(Number(p.expiresAt)) && Number(p.expiresAt) > 0 ? { expiresAt: Number(p.expiresAt) } : {}),
        });
      }
    } catch { /* skip a malformed entry rather than failing the whole poll */ }
  });
  return out;
}
