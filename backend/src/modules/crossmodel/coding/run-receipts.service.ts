/**
 * Run tool receipts — the PRISMA side of coding/run-receipts.ts (the pure
 * extractor/matcher leaf stays dependency-free; this module owns persistence).
 * Design: docs/archive/RUN_TOOL_RECEIPTS_DESIGN.md.
 *
 * Write path: recordRunReceiptAsync — fire-and-forget from the agent loop's
 * tool_result seam; every failure is caught + logged, the run never waits on
 * it and never fails because of it (the guard reads the in-process collector
 * first, so the write race is never load-bearing).
 * Read path: getRunReceipts — all receipts for one runId (the run-executor
 * unions them with the in-process collector so RESUMED runs see prior
 * attempts' executions — same agent_runs row across attempts). Degrades to []
 * on any error.
 *
 * Import discipline mirrors run-journal.service.ts: static prisma + logger
 * imports (this module is only reached from the agent/executor graph, never
 * from the dependency-free leaves).
 */

import prisma from '../../../config/database';
import { Prisma } from '@prisma/client';
import logger from '../../../utils/logger';
import { trackBackground } from '../../../utils/background-tasks';
import type { ToolReceipt } from './run-receipts';

/**
 * RECEIPT_WRITE_RETRY_BUDGET (todo 1e356736 item 2, 2026-10-16): a transient
 * INSERT failure used to drop the receipt row PERMANENTLY — one warn, no
 * retry, no dead-letter (run-receipts.service.ts's own catch). Specimens (the
 * 08:09–08:32Z #1568 deploy window): two update_supervisor_state saves whose
 * supervisor_states rows ARE durable (goal_get 08:33:36Z → 08:59:07Z, goal_update
 * 6c0faf12 08:30:17Z → get_chat_status 08:39:29Z) but whose receipt rows never
 * landed. A bounded same-process retry (≤2 retries, ≤250 ms backoff) covers the
 * connection-blip class; the process-kill class needs the shutdown flush below.
 * (RSW-1 2026-10-30: the RECEIPT_WRITE_RETRY_DISABLED kill switch was deleted —
 * it was NF_INERT, never forwarded in docker-compose.app.yml, so prod only ever
 * ran the retry branch. The retry IS the behavior; there is nothing to restore.)
 */
export const RECEIPT_WRITE_RETRIES = 2;
export const RECEIPT_WRITE_RETRY_BACKOFF_MS = 250;

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Fire-and-forget: persist one extracted receipt. NEVER throws — a receipt
 * write failure must not touch the run. The row is written verbatim: ids are
 * already canonical (extractReceipt parsed them out of harness-authored
 * result formats), hashes included.
 *
 * The write is RETRIED on failure (bounded: RECEIPT_WRITE_RETRIES attempts
 * after the first, backoff RECEIPT_WRITE_RETRY_BACKOFF_MS) and REGISTERED in
 * the background-tasks registry (trackBackground), so a graceful shutdown can
 * flush it before prisma.$disconnect() (server.ts awaits awaitBackgroundTasks
 * after httpServer.close; the worker's finishWorkerShutdown already does) —
 * the 2026-10-16 audit-1e356736 drain-loss class: the old color's deploy
 * teardown could kill the web process between a tool's side-effect commit
 * (e.g. the supervisor_states upsert) and this INSERT, leaving the state row
 * durable and its receipt gone. Registration never changes behaviour — the
 * promise is returned unchanged, rejections stay ours to swallow.
 */
export function recordRunReceiptAsync(receipt: ToolReceipt): void {
  const write = (async () => {
    const attempts = 1 + RECEIPT_WRITE_RETRIES;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await prisma.runToolReceipt.create({
          data: {
            id: receipt.id, // generated in-process — the column has no DB default
            chatId: receipt.chatId,
            runId: receipt.runId ?? null,
            tool: receipt.tool,
            ok: receipt.ok,
            ids: (receipt.ids ?? {}) as Prisma.InputJsonValue,
            inputHash: receipt.inputHash ?? null,
            outputHash: receipt.outputHash ?? null,
            createdAt: receipt.createdAt,
          },
        });
        return;
      } catch (err: any) {
        if (attempt >= attempts) {
          logger.warn(`run-receipts: write for chat ${receipt.chatId} (${receipt.tool}) failed after ${attempt} attempt(s) (non-fatal): ${err.message}`);
          return;
        }
        await sleep(RECEIPT_WRITE_RETRY_BACKOFF_MS);
      }
    }
  })();
  // Registry membership: a draining web/worker process can await pending
  // receipt writes (server.ts / worker.ts shutdown) before Prisma disconnects.
  void trackBackground(write, `run-receipt:${receipt.tool}`);
}

/** Map a run_tool_receipts row into the ToolReceipt shape (ids guarded to an object). */
function toReceipt(r: {
  id: string; chatId: string; runId: string | null; tool: string; ok: boolean;
  ids: unknown; inputHash: string | null; outputHash: string | null; createdAt: Date;
}): ToolReceipt {
  return {
    id: r.id,
    chatId: r.chatId,
    runId: r.runId,
    tool: r.tool,
    ok: r.ok,
    ids: (r.ids && typeof r.ids === 'object' && !Array.isArray(r.ids) ? r.ids : {}) as Record<string, unknown>,
    inputHash: r.inputHash,
    outputHash: r.outputHash,
    createdAt: r.createdAt,
  };
}

/**
 * Every receipt recorded under one runId (oldest-first). Read failures degrade
 * to [] — the guard falls back to the in-process collector.
 */
export async function getRunReceipts(runId: string): Promise<ToolReceipt[]> {
  try {
    const rows = await prisma.runToolReceipt.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toReceipt);
  } catch { return []; }
}

/**
 * fb64368a review round 2 (NEW MAJOR): the NON-SWALLOWING twin of
 * getRunReceipts — a read failure REJECTS instead of resolving []. The
 * executor's zero-receipt gate must distinguish "the run executed nothing"
 * from "the receipts read failed" (round-1 aggravator 4): against the
 * swallowing variant a DB hiccup at finalize was indistinguishable from an
 * empty run, so an honest uuid citation could be convicted and REPLACEd on a
 * transient read error. Every other caller keeps the swallowing contract.
 */
export async function getRunReceiptsStrict(runId: string): Promise<ToolReceipt[]> {
  const rows = await prisma.runToolReceipt.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toReceipt);
}

/** One receipt by its id (build 2026-10-11 DL-2: the tool-intent act's skip answer cites it), or null. Never throws. */
export async function getRunReceiptById(id: string): Promise<ToolReceipt | null> {
  try {
    if (!id) return null;
    const row = await prisma.runToolReceipt.findUnique({ where: { id } });
    return row ? toReceipt(row) : null;
  } catch { return null; }
}

/** Default cross-wake window for the verifier's exoneration reads (24h). */
const CHAT_RECEIPTS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard cap bounding the verifier's cross-wake pool. */
const CHAT_RECEIPTS_CAP = 500;

/**
 * Cross-wake ground truth (design follow-up — verifier cross-wake exoneration):
 * the OK receipts for ONE chat within the recency window, oldest-first, capped
 * at CHAT_RECEIPTS_CAP. The action verifier consults these BEFORE convicting a
 * claim with no in-run evidence — a prior wake's real execution exonerates its
 * truthful restatement ("the schedule I set up earlier fired"). ok-only: a
 * failed/staged execution exonerates nothing. Degrades to [] on any error.
 *
 * Cap semantics (P4 spark B28): the cap keeps the NEWEST rows — the old
 * ascending take-500 kept the OLDEST 500 of a busy 24h window, silently
 * dropping exactly the fresh executions the verifier needs to exonerate a
 * truthful restatement. Query newest-first, then reverse so the returned
 * order stays the documented oldest-first contract.
 *
 * `opts.tools` (tt-rd audit fixer 2026-09-27, finding docs-churn-log HIGH):
 * restrict the read to those tools AT THE DB so the cap bounds only matching
 * rows. A busy lane mints a run_command receipt every step, so the unfiltered
 * 500-row cap reached back only 13–17 h on the audited lanes — a caller with a
 * 7-day (duplicate PR) or 24-h (docs-only) window over ONE tool saw a fraction
 * of it (prod: 125 of chat ddd26be0's 135 PR receipts in 7 d sat beyond the
 * cap). No filter = the verifier's cross-tool pool, unchanged.
 */
export interface RecentChatReceiptsOpts {
  /** Only these tools (exact names). Empty / absent = every tool. */
  tools?: string[];
}

export async function getRecentChatReceipts(chatId: string, sinceMs = CHAT_RECEIPTS_WINDOW_MS, opts: RecentChatReceiptsOpts = {}): Promise<ToolReceipt[]> {
  try {
    const tools = Array.isArray(opts.tools) ? opts.tools.filter((t) => typeof t === 'string' && t.length > 0) : [];
    const rows = await prisma.runToolReceipt.findMany({
      where: {
        chatId,
        ok: true,
        createdAt: { gte: new Date(Date.now() - sinceMs) },
        ...(tools.length ? { tool: { in: tools } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: CHAT_RECEIPTS_CAP,
    });
    return rows.map(toReceipt).reverse();
  } catch { return []; }
}

/**
 * fb64368a review round 2 (NEW MAJOR): the NON-SWALLOWING twin of
 * getRecentChatReceipts — a read failure REJECTS instead of resolving [].
 * The executor's zero-receipt gate must distinguish a genuinely empty
 * carried pool (an invented uuid citation convicts) from an unread one (the
 * citation may be an honest earlier-run id — fail open), which the
 * swallowing variant made impossible (its internal catch returned [] on a
 * DB hiccup, so the executor's read-ok flag never fired). Same query, cap
 * and order semantics as the swallowing twin.
 */
export async function getRecentChatReceiptsStrict(chatId: string, sinceMs = CHAT_RECEIPTS_WINDOW_MS, opts: RecentChatReceiptsOpts = {}): Promise<ToolReceipt[]> {
  const tools = Array.isArray(opts.tools) ? opts.tools.filter((t) => typeof t === 'string' && t.length > 0) : [];
  const rows = await prisma.runToolReceipt.findMany({
    where: {
      chatId,
      ok: true,
      createdAt: { gte: new Date(Date.now() - sinceMs) },
      ...(tools.length ? { tool: { in: tools } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: CHAT_RECEIPTS_CAP,
  });
  return rows.map(toReceipt).reverse();
}
