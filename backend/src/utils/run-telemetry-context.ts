/**
 * Ambient TELEMETRY run id for chat-agent turns (audit 2026-10-06 T6-4,
 * crosscutting X7). A chat / supervisor turn has no agent_runs row, so every
 * row its agent loop wrote carried runId NULL (context_compaction: 222 rows in
 * 12 h on the Fleet Supervisor, one bucket) and every coding-tool failure log
 * runId "undefined" — per-wake cost / compaction attribution was impossible.
 *
 * runChatAgentTurn mints ONE id per turn (the turn's run_spend ledger uses the
 * same id) and runs the turn inside this AsyncLocalStorage context; the two
 * telemetry sinks fill a MISSING runId from it — loop_metrics rows
 * (loop-metrics.service toRow) and logger records (utils/logger
 * stampTelemetryRun) — only when the row's sessionId is the turn's own
 * session, so work the turn starts for ANOTHER chat (a send_chat_message that
 * wakes a lane in-process) is never attributed to it. An explicit runId always
 * wins; durable semantics (receipts, ToolContext.runId, checkpoints) are
 * untouched. Kill switch CHAT_RUN_TELEMETRY_ID_DISABLED=1 (read per call).
 *
 * LEAF — imports only node:async_hooks (the logger imports it).
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface TelemetryRun {
  /** The turn's minted id (== its run_spend runId). */
  runId: string;
  /** The session the turn runs as (chat id, or the anon-/chatless- sentinel once bound); null until bound. */
  sessionId: string | null;
}

const store = new AsyncLocalStorage<TelemetryRun>();

export function chatRunTelemetryIdDisabled(): boolean {
  const v = String(process.env.CHAT_RUN_TELEMETRY_ID_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Run `fn` with `run` as the ambient telemetry run (nested calls shadow the outer one). */
export function runWithTelemetryRun<T>(run: TelemetryRun, fn: () => T): T {
  return store.run(run, fn);
}

/** Bind the session id once the turn knows it (a chatless / guest turn mints its sentinel inside the turn). First bind wins. */
export function bindTelemetryRunSession(sessionId: string | null | undefined): void {
  const s = store.getStore();
  if (s && !s.sessionId && typeof sessionId === 'string' && sessionId) s.sessionId = sessionId;
}

/** The ambient run id (any session) — for the turn's own bookkeeping (its run_spend ledger). */
export function currentTelemetryRunId(): string | undefined {
  if (chatRunTelemetryIdDisabled()) return undefined;
  return store.getStore()?.runId || undefined;
}

/**
 * The ambient run id for a row of `sessionId` — undefined when disabled, outside
 * a turn, or when the row belongs to another session (or names none).
 */
export function ambientTelemetryRunId(sessionId: unknown): string | undefined {
  if (chatRunTelemetryIdDisabled()) return undefined;
  const s = store.getStore();
  if (!s || !s.runId || !s.sessionId) return undefined;
  return typeof sessionId === 'string' && sessionId === s.sessionId ? s.runId : undefined;
}

/**
 * Ticket e225aad8 — the runId a run_tool_receipt persists under. A CHAT /
 * supervisor turn has no agent_runs row, so the agent loop's `input.runId`
 * is undefined there and every turn's receipts used to land runId NULL —
 * fusing all turns into ONE runId-less bucket in get_run_receipts (runs:[]
 * on supervisor chats; the chatTurns lane collapsed to a single '_' group).
 * The turn already mints an ambient telemetry id (chat-<uuid>, T6-4 — its
 * run_spend row keys on it); a receipt minted inside the turn takes that id
 * so each turn's rows group under their own id and a runId query for the
 * turn id resolves.
 *
 * A durable coding run's runId ALWAYS wins, and the ambient id is only taken
 * for the turn's OWN session — never another chat's. This promotes the
 * ambient id from observe-only telemetry to a RECEIPT column (receipts are
 * durable evidence, not telemetry); CHAT_RUN_TELEMETRY_ID_DISABLED=1 still
 * reverts receipts to the pre-fix null shape alongside the other sinks.
 */
export function resolveReceiptRunId(durableRunId: string | null | undefined, sessionId: string): string | null {
  if (durableRunId) return durableRunId;
  return ambientTelemetryRunId(sessionId) ?? null;
}
