/**
 * The two transcript reads behind a supervisor OWNER turn's context
 * (./owner-turn-history.ts holds the pure selection + rendering).
 *
 *  - history: the newest OWNER_HISTORY_FETCH_ROWS rows, full content plus the
 *    metadata fields the selector classifies by (origin, kind, the wake's
 *    pre-preamble machineMessage) — the legacy loader read role + content only,
 *    so it could not tell an owner row from a wake prompt or a relay.
 *  - thread: every row of the last 48 h with content cut to a head (the owner
 *    line is clipped to 600 chars and the reply head to 300 anyway), so the
 *    read stays small on a chat that takes ~150 rows a day of 13–22k-char wake
 *    prompts.
 *
 * Both run in parallel under one pathology ceiling (OWNER_TURN_READ_CEILING_MS
 * — the chat-agent seam's startOwnerTurnRead is the bound that decides:
 * max(1.5 s, the moment the turn asks); re-review 2026-10-23: a 1.5 s deadline
 * here cut reads the turn would still have waited for, behind a slow context
 * build); any error or timeout ⇒ null and the owner turn keeps the legacy history
 * (fail-open, never a throw). Each row carries a WHITELISTED metadata
 * projection (`meta`: engine / models / ownerAskReply / providerError /
 * preempted / ownerAnswerFirst / task.status) — what the reply predicate and
 * the turn pairing read; never the whole metadata (its `models` carry every
 * seat's full response).
 */

import prisma from '../../../config/database';
import { redactGuardChromeMessage } from '../guard-chrome-redact';
import { OWNER_HISTORY_FETCH_ROWS, OWNER_THREAD_FETCH_ROWS, OWNER_THREAD_WINDOW_MS, OWNER_TURN_READ_CEILING_MS, type OwnerTurnRow } from './owner-turn-history';

/** Both reads together; past it the read answers null (the seam has usually stopped waiting well before). */
export const OWNER_TURN_CONTEXT_TIMEOUT_MS = OWNER_TURN_READ_CEILING_MS;
/** The metadata fields the pairing reads (fleet/supervisor-reply-row isSupervisorReplyRow + the turn side). */
const META_SQL = `jsonb_build_object(
    'engine', metadata->'engine',
    'models', CASE WHEN jsonb_typeof(metadata->'models') = 'object' THEN '{}'::jsonb END,
    'ownerAskReply', metadata->'ownerAskReply',
    'providerError', metadata->'providerError',
    'preempted', metadata->'preempted',
    'ownerAnswerFirst', metadata->'ownerAnswerFirst',
    'task', CASE WHEN jsonb_typeof(metadata->'task') = 'object' THEN jsonb_build_object('status', metadata->'task'->'status') END
  ) AS meta`;
/** Thread rows carry a content head only — enough for the 600-char owner line and the machine-text sniff. */
const THREAD_CONTENT_HEAD = 1200;
const TRIGGER_HEAD = 1200;

type RawRow = { id: string; role: string; content: string | null; origin: string | null; kind: string | null; machineMessage?: string | null; meta?: unknown; createdAt: Date | string };

/** Plain object or null (a driver that hands jsonb back as text is parsed; anything else ⇒ null). */
function metaFrom(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } }
  return null;
}

function toRow(r: RawRow, headChars?: number): OwnerTurnRow {
  // Guard-chrome redaction (ticket ac835c00) — the same seam the legacy loader applies to assistant rows.
  const red = redactGuardChromeMessage({ role: r.role, content: String(r.content ?? '') });
  let content = String(red.content ?? '');
  // A content HEAD cut by LEFT() may end mid-credential, too short for the redactor to match — drop the
  // trailing partial token (review 2026-10-23 item 1); the owner line is clipped far shorter anyway.
  if (headChars && String(r.content ?? '').length >= headChars) content = content.replace(/\S+$/, '');
  const meta = metaFrom(r.meta);
  return {
    id: String(r.id),
    role: r.role,
    content,
    origin: r.origin ?? null,
    kind: r.kind ?? null,
    ...(r.machineMessage ? { machineMessage: r.machineMessage } : {}),
    ...(meta ? { meta } : {}),
    createdAt: r.createdAt,
  };
}

/**
 * Read the owner turn's rows (chronological). `excludeMessageId` drops the
 * turn's OWN row when it is already persisted (an orphan-recovery re-fire).
 * Null on any failure.
 */
export async function loadOwnerTurnRows(
  chatId: string,
  opts: { excludeMessageId?: string | null; now?: Date; timeoutMs?: number } = {},
): Promise<{ history: OwnerTurnRow[]; thread: OwnerTurnRow[] } | null> {
  if (!chatId) return null;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - OWNER_THREAD_WINDOW_MS);
  const ex = opts.excludeMessageId ? String(opts.excludeMessageId) : null;
  const read = async () => {
    const [hist, thread] = await Promise.all([
      prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT id, role, content, metadata->>'origin' AS origin, metadata->>'kind' AS kind,
                LEFT(metadata->>'machineMessage', ${TRIGGER_HEAD}) AS "machineMessage", ${META_SQL}, "createdAt"
           FROM crossmodel_messages
          WHERE "chatId" = $1${ex ? ' AND id <> $2' : ''}
          ORDER BY "createdAt" DESC, id DESC LIMIT ${OWNER_HISTORY_FETCH_ROWS}`,
        ...(ex ? [chatId, ex] : [chatId]),
      ),
      prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT id, role, LEFT(content, ${THREAD_CONTENT_HEAD}) AS content, metadata->>'origin' AS origin, metadata->>'kind' AS kind, ${META_SQL}, "createdAt"
           FROM crossmodel_messages
          WHERE "chatId" = $1 AND "createdAt" >= $2${ex ? ' AND id <> $3' : ''}
          ORDER BY "createdAt" DESC, id DESC LIMIT ${OWNER_THREAD_FETCH_ROWS}`,
        ...(ex ? [chatId, since, ex] : [chatId, since]),
      ),
    ]);
    if (!Array.isArray(hist) || !Array.isArray(thread)) return null;
    return { history: [...hist].reverse().map((r) => toRow(r)), thread: [...thread].reverse().map((r) => toRow(r, THREAD_CONTENT_HEAD)) };
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.timeoutMs ?? OWNER_TURN_CONTEXT_TIMEOUT_MS); (timer as any).unref?.(); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
