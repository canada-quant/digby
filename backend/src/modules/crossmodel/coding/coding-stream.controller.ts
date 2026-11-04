/**
 * Digby Code — SSE run endpoint + approval/question endpoints (Phase 2: WORKER TIER).
 *
 * THE CUTOVER: the web process owns NO coding execution. POST /run only flips
 * the session busy + queues an agent_runs row; a worker (worker.ts →
 * run-claim.ts → run-executor.ts) claims + executes it. GET /stream TAILS the
 * run's durable agent_events log from Postgres — there is never a local run to
 * subscribe to. Stop + steer + approval/question resolutions ride the
 * cross-process Redis channels in session-run-lock.ts that the worker
 * polls/drains.
 *
 * GET  /coding/sessions/:id/stream?token=<jwt>
 *      ATTACH mode (empty message): tail the session's ACTIVE run
 *      (queued|running) from agent_events — or, with no active run, replay the
 *      LATEST run's durable log (replaces the 30s in-memory ring retention:
 *      the log IS the retention). A message in the query still queues a run
 *      (back-compat for older clients); the current frontend POSTs /run then
 *      attaches here empty. Query-token auth (EventSource can't set headers).
 * POST /coding/sessions/:id/run  { message, images? }  (header-auth)
 *      Queue a run for a worker. Returns immediately; the client attaches to
 *      the SSE stream to watch it.
 * POST /coding/approvals/:approvalId  { decision: 'allow'|'always'|'deny' }
 *      Resolves an ask-mode permission request.
 * POST /coding/questions/:questionId  { answer }
 *      Resolves an ask_user question the orchestrator is blocked on.
 */

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import {
  queueAgentRun, getActiveRunForSession, getLatestRunForSession, getAgentEventsAfter, RunInput,
  SessionBusyError,
} from './run-state';
import {
  getSessionForUser, updateSessionState, ensureChatWorkspaceState, appendCodingMessage,
  CLAIMABLE_ROW_FRESH_MS,
} from './coding-data.service';
import {
  isSessionRunLocked, requestRunCancel, pushSteerMessage,
  getApprovalPendingSession, publishApprovalResolution,
  getQuestionPendingSession, publishQuestionResolution,
} from './session-run-lock';
import { currentIdForFingerprint, loadDurablePending, markDurableResolved } from './pending-durable';
import { validateImages, describeImagesForTextOnlyModel, ChatImage } from './chat-images';
import { validateFiles, SessionFilePayload, MAX_FILES } from './chat-files';
import type { DecisionStash } from '../platform/decision-gate';
import { modelSupportsVisionForRun } from './coding-model';
import { consumeCapSkipNotice, restoreCapSkipNotice } from './schedule.service';
import { machineFiringHeader } from '../chat-agent/machine-wake';
import { getWorktreeTree, getWorktreeFile, getWorktreeRaw } from './worktree-files';
import { withholdFromClient } from './reasoning-wire';
import { resolveViewModeForRequest, type ViewMode } from '../view/view-mode';
import { minimalEvent } from '../view/minimal-view';

/** The one busy message every start path rejects with (the 409 contract). */
const BUSY_MESSAGE = 'A run is already in progress for this session. Wait for it to finish (or Stop it) before sending another message.';

/**
 * Decision-card coherence (ticket 992c8374): an owner answer on a session's
 * ask_user decision card must ALSO close the matching flagged owner-question
 * (flag_owner_question) for the same decision — otherwise the fleet-attention
 * block keeps reporting it unanswered and every supervisor wake re-asks it
 * (the 2026-09-05 "card won't dismiss" incident: the owner typed custom
 * answers 3× and the card kept re-rendering). The asked-question text comes
 * from the confirm-pending presence key (populated while the wait is live);
 * when it is already gone there is nothing trustworthy to match on, so we
 * skip. Best-effort: never throws, never fails the owner's answer.
 */
async function autoResolveFlaggedOwnerDecision(sessionId: string, userId: string, questionId: string | null, answer: string): Promise<void> {
  try {
    const { readConfirmPendingForChats } = await import('../confirm-pending');
    const entry = (await readConfirmPendingForChats([sessionId])).get(sessionId);
    if (!entry || entry.kind !== 'question') return;
    if (questionId && entry.id !== questionId) return; // a different live wait — not this decision
    const { resolveOwnerQuestionsForChatAnswer } = await import('../platform/owner-questions');
    await resolveOwnerQuestionsForChatAnswer({ chatId: sessionId, userId, askedQuestion: entry.question, answer });
  } catch { /* the answer is already recorded — the inbox sync must never fail it */ }
}
/** Postgres-tail cadence for the SSE stream (design doc: 750 ms). */
const TAIL_POLL_MS = 750;
/** Replay page size — must match getAgentEventsAfter's per-call row cap usage below. */
const REPLAY_PAGE_SIZE = 5000;
/** Cap on one merged delta frame — far above any real turn, guards pathology. */
const MERGED_FRAME_CHAR_CAP = 128_000;

/**
 * Batch frame writer (2026-08-27, owner "laggy and sluggish"): the run-executor
 * coalesces deltas at EMIT time (0c158104), but a long agentic run still
 * accumulates tens of thousands of persisted rows, and replay/tail re-framed
 * every row individually — a 35k-row backlog hit the browser as 35k SSE frames
 * and froze the tab. This merges CONSECUTIVE 'text'/'reasoning' delta rows
 * ({delta} payloads only) within each fetched batch into one frame carrying
 * the LAST seq of the group (cursor resume stays exact: rows ≤ cursor are
 * skipped upstream, and a client re-attaching mid-group simply re-receives the
 * group's tail). Non-delta rows flush pending merges first — ordering is
 * byte-identical to the unmerged stream.
 */
export function createFrameWriter(write: (chunk: string) => void, runId: string, viewMode: ViewMode = 'full') {
  let kind: 'text' | 'reasoning' | null = null;
  let delta = '';
  let seq = -1;
  let ts: string | undefined; // the merged block's FIRST row time (when the text started)
  // Event wall-clock for the frame (2026-09-08): agent_events.createdAt — so a
  // client attaching mid-run or replaying a finished run stamps the parts
  // with when they happened, not with its own ingest time. Absent on rows
  // from callers that don't select it.
  const rowTs = (row: { createdAt?: unknown }): string | undefined => {
    const c = row.createdAt;
    if (c instanceof Date) return isNaN(c.getTime()) ? undefined : c.toISOString();
    return typeof c === 'string' && c ? c : undefined;
  };
  const flush = () => {
    if (kind === null) return;
    write(`id: ${runId}:${seq}\ndata: ${JSON.stringify({ type: kind, data: { delta }, ...(ts ? { ts } : {}) })}\n\n`);
    kind = null; delta = ''; seq = -1; ts = undefined;
  };
  return {
    writeRow(row: { seq: number; type: string; payload: any; createdAt?: Date | string }) {
      // Rows stored before thinking stayed on the server (2026-10-04, reasoning-wire.ts) never replay to a client.
      if (withholdFromClient(row.type, row.payload)) return;
      const isDelta = (row.type === 'text' || row.type === 'reasoning')
        && row.payload && typeof row.payload.delta === 'string'
        && Object.keys(row.payload).length === 1;
      if (isDelta) {
        if (kind !== row.type || delta.length >= MERGED_FRAME_CHAR_CAP) {
          flush();
          kind = row.type as 'text' | 'reasoning';
          ts = rowTs(row);
        }
        delta += row.payload.delta;
        seq = row.seq;
        return;
      }
      flush();
      // Minimal view (2026-10-16, view/minimal-view.ts): a minimal viewer never receives the machinery.
      let type = row.type;
      let payload = row.payload;
      if (viewMode === 'minimal') {
        const kept = minimalEvent(row.type, row.payload);
        if (!kept) return;
        type = kept.type; payload = kept.data;
      }
      const t = rowTs(row);
      write(`id: ${runId}:${row.seq}\ndata: ${JSON.stringify({ type, data: payload, ...(t ? { ts: t } : {}) })}\n\n`);
    },
    flush,
  };
}

/**
 * SSE resume cursor: Last-Event-ID header (native EventSource auto-reconnect)
 * or explicit ?after_seq=. The frame id is the COMPOSITE `<runId>:<seq>`
 * (agent_events seqs are PER-RUN — a bare seq says nothing about provenance):
 * a composite whose runId matches the tailed run is TRUSTED (the client really
 * saw that prefix of THIS run); a composite for another run means a new run
 * started since the client last listened → replay from the start; a bare
 * numeric (legacy clients, pre-composite frames) is accepted but UNTRUSTED —
 * it keeps the old reset-on-init behavior below. { runId: null, seq: -1 } =
 * no cursor.
 */
function lastEventId(req: Request): { runId: string | null; seq: number } {
  const raw = (req.headers['last-event-id'] as string | undefined) ?? (typeof req.query?.after_seq === 'string' ? req.query.after_seq : undefined);
  if (raw == null) return { runId: null, seq: -1 };
  // Composite `<runId>:<seq>` — the runId shape is deliberately LIBERAL: trust
  // comes from the equality check against the tailed run's id at the call site
  // (a cursor naming any other run is simply untrusted → full replay), not
  // from format validation. A hex/UUID-only regex here would silently reject
  // real cursors (run ids are not UUID-shaped everywhere — mocks, cuid()).
  const m = /^([^:\s]{1,80}):(\d{1,12})$/.exec(raw.trim());
  if (m) return { runId: m[1], seq: parseInt(m[2], 10) };
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? { runId: null, seq: n } : { runId: null, seq: -1 };
}

/**
 * The run message for an attachment-only send (blank user text + files): a
 * FACTUAL marker, never fabricated user words. ONE helper used by every entry
 * (POST /run, streamCapabilityRun) so the persisted user row reads identically
 * no matter which surface the upload rode in on (adversarial review F1).
 */
function attachmentOnlyRunMessage(files: SessionFilePayload[]): string {
  if (!files.length) return '';
  return `Attached ${files.length} file(s): ${files.map(f => f.name || 'file').join(', ')}`;
}

class CodingStreamController {
  /** Open the SSE response + a keepalive heartbeat. */
  private openSSE(res: Response): ReturnType<typeof setInterval> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    return setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 20_000);
  }

  /**
   * The ONE run-start path (Phase 2; Phase-3 review H1): queueAgentRun flips
   * the session ready→running (the busy-gate) AND queues the agent_runs row in
   * ONE interactive transaction — supersede + checkpoint adoption included —
   * so there is never a window where the session is 'running' with no row for
   * the orphan sweep to mistake for a corpse. A busy session (gate matched 0
   * rows) throws SessionBusyError, rolling the whole txn back; the worker
   * flips the session back to 'ready' at finalize. Non-busy queue failures
   * propagate (the txn already rolled back — no manual un-flip needed).
   */
  private async queueRun(sessionId: string, input: RunInput): Promise<{ started: boolean; reason?: string }> {
    try {
      await queueAgentRun(sessionId, input);
    } catch (err: any) {
      if (err instanceof SessionBusyError || err?.code === 'BUSY') return { started: false, reason: 'busy' };
      throw err;
    }
    return { started: true };
  }

  /**
   * Error-state self-heal (2026-08-30 fleet audit): a session stuck in 'error'
   * — or a never-provisioned lazy satellite stuck at 'provisioning' — fails
   * queueAgentRun's ready-gate FOREVER, so every supervisor nudge / schedule
   * firing / hook wake into it 409'd or skipped with a misleading 'busy'
   * reason, and stopRun only repairs 'running'. Bricked lanes looked exactly
   * like busy ones. Mirror stopRun's orphan guard (no FRESH claimable row, no
   * live run lock) before flipping to 'ready' so a live worker is never
   * double-started; queueAgentRun's txn then adopts any stale interrupted
   * row's checkpoint as designed. streamCapabilityRun already does the
   * never-provisioned flip for the interactive path — this extends both heals
   * to the machine-dispatch path.
   *
   * dae56e70 (2026-09-10): an ARCHIVED satellite is the same bricked-lane
   * class — the ready-gate can never match it, so every machine dispatch read
   * 'busy' forever (8+h on session 0afa0737) while isChatBusy (registry +
   * Redis liverun + agent_runs) truthfully reported idle: a phantom claim no
   * agent tool could clear. 'archived' is a REVERSIBLE state by design —
   * updateSession's unarchive always lands on 'ready' (coding.controller) and
   * the executor's ensureRunnable re-provisions a reaped worktree on demand —
   * so healing an archived session IS the unarchive semantic, applied to the
   * machine-dispatch path with the same fail-closed orphan guard.
   */
  private async healUnrunnableSession(
    sessionId: string,
    session: { status?: string; worktreePath?: string | null },
    opts: { machine?: boolean; origin?: string; dispatchSurface?: 'owner_answer' } = {},
  ): Promise<boolean | 'archived'> {
    const stuckError = session.status === 'error';
    const neverProvisioned = session.status === 'provisioning' && !session.worktreePath;
    const archivedIdle = session.status === 'archived'; // dae56e70
    if (!stuckError && !neverProvisioned && !archivedIdle) return false;
    const claimable = await prisma.agentRun.findFirst({
      where: {
        sessionId,
        status: { in: ['queued', 'interrupted', 'running'] },
        updatedAt: { gte: new Date(Date.now() - CLAIMABLE_ROW_FRESH_MS) },
      },
      select: { id: true },
    }).catch(() => null);
    if (claimable || (await isSessionRunLocked(sessionId).catch(() => true))) return false; // fail-closed: unknown ownership ⇒ don't flip
    // Archived + MACHINE dispatch (autonomy loop #13, 2026-09-20): an archive
    // is a STOP — the owner's stand-down or the lane-scoped ending. A schedule
    // firing, hook wake or agent send must not silently revive it: lane
    // b95e9df6 (archived under the owner's 09-17 "stop all glm5.3 work") was
    // woken by a leftover peer hook at 17:57Z, un-archived by this very heal
    // with no audit row, and burned a derail-killed run. The dispatch is
    // refused with the DISTINCT reason 'archived' (never 'busy' — the
    // dae56e70 phantom-busy class stays fixed: no busy-skip, no 3-min re-arm).
    // Only a real user turn heals an archived session (the restore semantic).
    if (archivedIdle && opts.machine) {
      logger.info(`coding: machine dispatch into ARCHIVED session ${sessionId.slice(0, 8)} refused — the archive is a stop; a user turn restores it`);
      void import('../platform/loop-metrics.service')
        // ARCHIVED-TARGET-RETIRE (f, 2026-10-20): name the dispatch surface
        // (schedule | hook | owner_answer; agent / webhook sends keep their
        // origin) — the seam moves to meta.seam. Kill switch
        // ARCHIVED_TARGET_RETIRE_DISABLED=1 restores {surface:'coding_heal'}.
        .then(async (m) => {
          const retire = await import('../platform/archived-target-retire');
          const meta = retire.archivedTargetRetireDisabled()
            ? { surface: 'coding_heal' }
            : { surface: opts.dispatchSurface ?? opts.origin ?? 'machine', seam: 'coding_heal', chatSurface: 'coding' };
          m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.MACHINE_DISPATCH_ARCHIVED_REFUSED, sessionId, meta });
        })
        .catch(() => {});
      return 'archived';
    }
    await updateSessionState(sessionId, { status: 'ready' }).catch(() => {});
    // 90d71ae7 (2026-09-10): the unarchive semantic must be COMPLETE — the
    // satellite flip alone left crossModelChat.archivedAt stamped, so a healed
    // chat stayed invisible to list_chats (the default view excludes archived
    // rows) while get_chat_status read it and its runs resumed: a running chat
    // no fleet tool could enumerate (session 0afa0737, same incident family).
    // Clear the chat stamp when (and ONLY when) we healed the ARCHIVED branch —
    // error/provisioning heals never parked the chat. Best-effort like the
    // satellite flip: a hiccup must not fail the dispatch that triggered it.
    if (archivedIdle) {
      // ARCHIVE CASCADE review fixer (2026-10-21): a user turn that heals an
      // archived chat whose ROW is stamped restores it through archiveChat — the
      // cascade restore brings back the children its archive took (a direct
      // clear left them hidden, the cascade marker lingering), the lane-retire
      // restore marker, audit row and sidebar push ride along, plus the same
      // hook / schedule re-arm. A refusal, an unstamped row or
      // ARCHIVE_CASCADE_DISABLED=1 keeps the direct clear below.
      let viaArchiveChat = false;
      const family = await import('../platform/lane-family-facts').catch(() => null);
      if (family && !family.archiveCascadeDisabled()) {
        const row = await Promise.resolve().then(() => prisma.crossModelChat.findUnique({ where: { id: sessionId }, select: { archivedAt: true, userId: true } })).catch(() => null);
        if (row?.archivedAt && row.userId) {
          try {
            const { archiveChat } = await import('../platform/platform.service');
            await archiveChat({ userId: row.userId, chatId: sessionId, archived: false, source: 'dispatch_heal' });
            viaArchiveChat = true;
          } catch (err: any) {
            logger.info(`coding: heal of ${sessionId.slice(0, 8)} restored the chat directly (archiveChat ${err?.statusCode ?? '-'}: ${err?.message ?? err})`);
          }
        }
      }
      if (!viaArchiveChat) {
        await prisma.crossModelChat.updateMany({ where: { id: sessionId }, data: { archivedAt: null } }).catch(() => {});
        // audit 2026-10-08 W3-5: a user-turn restore re-arms the hooks the archive paused.
        void import('../platform/hooks.service').then((m) => m.resumeHooksForRestoredChat(sessionId)).catch(() => {});
        // ARCHIVED-TARGET-RETIRE (2026-10-20): …and the schedules it paused.
        void import('./schedule.service').then((m) => m.resumeSchedulesForRestoredChat(sessionId)).catch(() => {});
        // Lane lifecycle second review fixer (2026-10-21): a direct-clear heal is a
        // restore — remember it for lane-retire / the ticket drain / a machine
        // cascade (all switches set = nothing written).
        if (family) void family.rememberLaneRestore(sessionId, { source: 'dispatch_heal' }).catch(() => {});
        else void import('../platform/lane-family-facts').then((m) => m.rememberLaneRestore(sessionId, { source: 'dispatch_heal' })).catch(() => {});
      }
    }
    logger.info(`coding: healed unrunnable session ${sessionId.slice(0, 8)} ('${session.status}' → 'ready') so a machine dispatch could queue`);
    return true;
  }

  /**
   * Resolve staged /crossmodel/upload ids into file payloads (feedback
   * 7f546b03 — chat-uploaded files reach the coding run as REAL files staged
   * into the worktree by the executor). Loud 400s: an expired, foreign-owned,
   * or legacy (text-preview-only) upload is NEVER silently dropped.
   * upload.controller loads via dynamic import — its chain reaches config/redis
   * → config/env (process.exit at import in a keyless env, the same boundary
   * as ./schedule.service above).
   */
  private async resolveUploadIdsToFiles(uploadIds: string[], userId: string): Promise<SessionFilePayload[]> {
    const { loadAttachment } = await import('../upload.controller');
    const files: SessionFilePayload[] = [];
    for (const id of uploadIds) {
      const a = await loadAttachment(id);
      if (!a) throw new AppError(400, 'An attachment expired before the run started — re-send the file.');
      if (a.ownerUserId && a.ownerUserId !== userId) {
        throw new AppError(400, 'This upload belongs to a different user.');
      }
      if (!a.base64) {
        throw new AppError(400, `Re-send ${a.filename} — it was uploaded before file support and only its text preview survived.`);
      }
      const payload: SessionFilePayload = { name: a.filename, mediaType: a.mimeType || 'application/octet-stream', data: a.base64 };
      // 7b5ee09b: carry the upload-time text extract (pdf/docx/xlsx/txt…) —
      // the run stages it as a readable sibling next to the raw bytes, so the
      // agent can read a PDF's text without a pdftotext in the container.
      if (typeof a.extractedText === 'string' && a.extractedText) payload.extractedText = a.extractedText;
      files.push(payload);
    }
    const check = validateFiles(files);
    if (!check.ok) throw new AppError(400, check.error);
    return check.files;
  }

  /**
   * Body shape check for `uploadIds`: absent → []; otherwise an array of at
   * most MAX_FILES strings. Throws AppError(400) on anything else (reject
   * loudly — never silently strip an id).
   */
  private parseUploadIdsBody(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((x: unknown) => typeof x !== 'string') || raw.length > MAX_FILES) {
      throw new AppError(400, `uploadIds must be an array of at most ${MAX_FILES} upload id strings.`);
    }
    return raw as string[];
  }

  /**
   * POST /coding/sessions/:id/run  { message }  (header-auth).
   * Queue a run with the prompt in the request BODY — so long prompts / pasted
   * logs don't overflow the EventSource query-string URL limit (414/431). Returns
   * immediately; the client then opens the SSE stream in ATTACH mode to watch it.
   */
  async startRun(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if ((req.user as any)?.isChild) return res.status(403).json({ error: 'Coding is not available for child accounts' });

    const { id } = req.params;
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const imgCheck = validateImages(req.body?.images);
    if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
    const images = imgCheck.images;
    // Staged chat-upload ids (7f546b03) resolve into file payloads that ride
    // the run input — an attachment-only send is a legal run start.
    let files: SessionFilePayload[] = [];
    try {
      const uploadIds = this.parseUploadIdsBody(req.body?.uploadIds);
      if (uploadIds.length) files = await this.resolveUploadIdsToFiles(uploadIds, userId);
    } catch (err: any) {
      return res.status(err instanceof AppError ? err.statusCode : 500).json({ error: err.message });
    }
    if (!message.trim() && !images.length && !files.length) return res.status(400).json({ error: 'message is required' });

    // Ticket 7acaa7ba: a project member opening a shared CODING session used to
    // get 404 "Session not found" here — indistinguishable from a bad link.
    // Members legitimately have READ access (getSession/read + the SSE attach
    // are member-aware), so distinguish: member → 403 with an honest, actionable
    // message; stranger → unchanged 404 (no existence leak).
    const session = await getSessionForUser(id, userId, 'read', { includeProject: true });
    if (!session || !session.project) return res.status(404).json({ error: 'Session not found' });
    if (session.userId !== userId) {
      return res.status(403).json({
        error: 'This coding session belongs to the project owner. You have read access (open it to watch runs and read the transcript), but only the owner can start runs in it — ask them to run your request, or start a new chat in the folder.',
        code: 'CODING_OWNER_ONLY',
      });
    }
    let runImages = images;
    let describedBlock = '';
    if (images.length && !(await modelSupportsVisionForRun(session.model, userId))) {
      try {
        describedBlock = await describeImagesForTextOnlyModel(images, session.model);
        runImages = [];
      } catch {
        return res.status(400).json({ error: `The ${session.model} model can't see images and the vision description failed — switch the session model or remove the attachment.` });
      }
    }
    let r: { started: boolean; reason?: string };
    try {
      r = await this.queueRun(id, {
        // Attachment-only send: a FACTUAL marker stands in for the blank
        // message (never fabricated user words) — same rule as
        // streamCapabilityRun, so both entries persist an identical row.
        message: [describedBlock, message.trim() ? message : attachmentOnlyRunMessage(files)].filter(Boolean).join('\n\n'),
        images: runImages, userId, userTurnAt: new Date().toISOString(),
        ...(files.length ? { files } : {}),
      });
    } catch (err: any) {
      logger.error(`coding startRun: queue failed for session ${id}: ${err.message}`);
      return res.status(500).json({ error: 'Could not start the run — try again.' });
    }
    if (!r.started) return res.status(409).json({ error: BUSY_MESSAGE });
    return res.json({ success: true, data: { started: true } });
  }

  /**
   * GET /coding/sessions/:id/stream?token=[&message=]  (query-token, EventSource).
   * ATTACH to the session's run. Empty message: tail the ACTIVE run's durable
   * event log (or replay the latest finished run's). A message in the query
   * still queues a run (back-compat for older clients); the current frontend
   * uses POST /run then attaches here empty.
   */
  async streamRun(req: Request, res: Response) {
    // Guard the WHOLE handler: an unguarded rejection here bubbles to the
    // process-level unhandledRejection handler, which exits in production —
    // one bad attach must never restart the backend.
    try {
      return await this.streamRunInner(req, res);
    } catch (err: any) {
      logger.error(`coding streamRun failed for ${this.resolveStreamSessionId(req) || '?'}: ${err.message}`);
      if (!res.headersSent) return res.status(500).json({ error: err.message });
      try { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', data: { message: err.message } })}\n\n`); } catch { /* gone */ }
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * The session id for a stream request. The mounted route
   * (`/coding/sessions/:id/stream`) carries it as `:id`; the unified chat
   * stream (`GET /api/crossmodel/stream?chatId=…`, no `:id` param) carries it
   * as `?chatId=`; a caller that already resolved the session (streamCapabilityRun)
   * passes it explicitly. Empty when none of those is present — the caller
   * answers 400, never a Prisma `findUnique({ where: { id: undefined } })` 500
   * (PE-01 / 7acaa7ba: every send on a workspace-attached chat over /stream
   * 500'd AFTER the run was queued, so the user saw an error and the resend 409'd).
   */
  private resolveStreamSessionId(req: Request, sessionIdOverride?: string): string {
    if (typeof sessionIdOverride === 'string' && sessionIdOverride.trim()) return sessionIdOverride;
    const fromParams = (req.params as Record<string, unknown> | undefined)?.id;
    if (typeof fromParams === 'string' && fromParams.trim()) return fromParams;
    const fromQuery = (req.query as Record<string, unknown> | undefined)?.chatId;
    if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery;
    return '';
  }

  private async streamRunInner(req: Request, res: Response, messageOverride?: string, sessionIdOverride?: string) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if ((req.user as any)?.isChild) return res.status(403).json({ error: 'Coding is not available for child accounts' });

    const id = this.resolveStreamSessionId(req, sessionIdOverride);
    if (!id) return res.status(400).json({ error: 'Session id is required (route :id or ?chatId=)' });
    // Express 5: req.query is a re-parsing getter — callers that already
    // consumed/queued the query message pass an explicit override instead of
    // mutating req.query (a write/delete there is silently lost under v5).
    const message = messageOverride !== undefined
      ? messageOverride
      : typeof req.query.message === 'string' ? req.query.message : '';

    // Members (read) may ATTACH to watch; starting a run stays owner-only below.
    const session = await getSessionForUser(id, userId, 'read', { includeProject: true });
    if (!session || !session.project) return res.status(404).json({ error: 'Session not found' });
    const isOwner = session.userId === userId;

    // ── Back-compat: a message in the query STARTS (queues) a run. ──
    if (message.trim()) {
      // Ticket 7acaa7ba: honest member 403 (was 403 'Only the owner can start
      // runs' only AFTER the read gate passed — keep that, but the read gate
      // above now distinguishes member from stranger; this message is only
      // reached by owners).
      if (!isOwner) return res.status(403).json({ error: 'Only the owner can start runs', code: 'CODING_OWNER_ONLY' });
      // A message-bearing attach while a run is active would otherwise be
      // SILENTLY DROPPED (never persisted, never answered) — the busy-gate
      // rejects it so the client keeps the message and can retry.
      const r = await this.queueRun(id, { message, images: [], userId, userTurnAt: new Date().toISOString() });
      if (!r.started) return res.status(409).json({ error: BUSY_MESSAGE });
    }

    // ── Tail the ACTIVE run (queued | running) from the durable event log. ──
    const viewMode = await resolveViewModeForRequest(req as any);
    const active = await getActiveRunForSession(id).catch(() => null);
    if (active) return this.tailActiveRun(req, res, active, viewMode);

    // ── No active run: an INTERRUPTED latest run is about to be re-claimed
    // (deploy bounce) — TAIL it so this connection rides through the resume.
    // The old replay-and-close here caused a REPLAY LOOP (2026-08-28, attach
    // logs): each attach during the bounce window streamed the WHOLE log and
    // closed, the client re-attached immediately, six full replays in 37s —
    // the owner's "plays back and autoscrolls over and over". ──
    const latest = await getLatestRunForSession(id).catch(() => null);
    if (latest?.status === 'interrupted') return this.tailActiveRun(req, res, latest, viewMode);

    // ── No active run: replay the LATEST run's durable log in order
    // (attach-after-finish, cross-color deploy replay — the log IS the retention). ──
    if (latest) return this.replayRun(req, res, latest.id, viewMode);

    // ── No run has ever executed for this session. ──
    if (session.status === 'running') {
      // 'running' with NO run row is either orphaned (a process died between the
      // busy-gate flip and the queue write) or its row hasn't become visible yet
      // (a live instance holds the run lock in that sub-second start window —
      // never false-orphan THAT).
      if (await isSessionRunLocked(id)) {
        // Honest close WITHOUT resetting: the EventSource auto-reconnects and
        // lands on the tail path once the row is visible.
        const heartbeat = this.openSSE(res);
        res.write(`data: ${JSON.stringify({ type: 'progress', data: { message: 'Reconnecting to your run…', stage: 'cross_instance' } })}\n\n`);
        clearInterval(heartbeat);
        return res.end();
      }
      await updateSessionState(id, { status: 'ready' }).catch(() => {});
      const heartbeat = this.openSSE(res);
      res.write(`data: ${JSON.stringify({ type: 'complete', data: { finalText: '', parts: [], interrupted: true } })}\n\n`);
      clearInterval(heartbeat);
      return res.end();
    }
    return res.status(400).json({ error: 'message is required' });
  }

  /**
   * P5-B: run (or attach to) the coding harness for a CHAT-pipeline message
   * whose chat carries the workspace SATELLITE (User Space §4 — THE ROUTING
   * RULE: the satellite, never folder capability alone, routes a send here;
   * the chat row never carries a mode marker). Entry point: the unified
   * GET /chats/:id/stream endpoint (crossmodel.controller).
   *
   * The workspace satellite attaches LAZILY on the owner's message
   * (ensureChatWorkspaceState) — members get a read-only lookup and can only
   * attach, mirroring streamRunInner's owner-only start rule. User Space §4:
   * this lazy attach is now a BACKSTOP for callers that already chose the
   * coding entry (the back-compat ?message= start) — the send seams attach via
   * the §4a router gate instead. `chat` must
   * already be authorized by the caller. After the run is queued the SAME
   * response attaches to the durable event log (the message is stripped from
   * the query first so streamRunInner's back-compat start can't double-queue).
   */
  async streamCapabilityRun(
    req: Request,
    res: Response,
    chat: { id: string; userId: string; projectId: string | null; title: string },
    message: string,
    uploadIds?: string[],
  ) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if ((req.user as any)?.isChild) return res.status(403).json({ error: 'Coding is not available for child accounts' });

    const isOwner = chat.userId === userId;
    const session = isOwner
      ? await ensureChatWorkspaceState(chat).catch(() => null) // lazy attach (P5-B)
      : await getSessionForUser(chat.id, userId, 'read', { includeProject: true }).catch(() => null);
    if (!session || !session.project) return res.status(404).json({ error: 'Session not found' });

    // Staged chat-upload ids (7f546b03): resolve into file payloads BEFORE the
    // busy/active checks — an expired/foreign/legacy upload 400s here, while
    // the response is still plain JSON (the SSE stream has not opened).
    let files: SessionFilePayload[] = [];
    if (uploadIds?.length) {
      try {
        files = await this.resolveUploadIdsToFiles(uploadIds, userId);
      } catch (err: any) {
        return res.status(err instanceof AppError ? err.statusCode : 500).json({ error: err.message });
      }
    }

    // Busy rule = worker-tier truth: a queued/in-flight ROW (never the in-process
    // registry). A message (or attachment) during a live run is rejected (never
    // silently dropped).
    const active = await getActiveRunForSession(session.id).catch(() => null);
    if (active && (message.trim() || files.length)) return res.status(409).json({ error: BUSY_MESSAGE });
    if (!active && (message.trim() || files.length)) {
      if (!isOwner) return res.status(403).json({ error: 'Only the owner can start runs' });
      // Never-provisioned lazy satellite (status 'provisioning', worktreePath
      // null): flip to 'ready' so queueAgentRun's transactional ready→running
      // gate matches; the worker's ensureRunnable provisions the worktree on
      // this first run (reattachWorktree falls back to a fresh ensureWorktree).
      if (session.status === 'provisioning' && !session.worktreePath) {
        await updateSessionState(session.id, { status: 'ready' }).catch(() => {});
      }
      // An attachment-only send carries a FACTUAL marker as the run message
      // (not fabricated user words); the files themselves stage into the
      // worktree and the [ATTACHED FILES] note names them for the agent.
      const runMessage = message.trim()
        ? message
        : attachmentOnlyRunMessage(files);
      const r = await this.queueRun(session.id, {
        message: runMessage, images: [], userId, userTurnAt: new Date().toISOString(),
        ...(files.length ? { files } : {}),
      });
      if (!r.started) return res.status(409).json({ error: BUSY_MESSAGE });
    }
    // Attach this response to the run's durable log. The query message was
    // ALREADY queued above (or 409-rejected) — pass an explicit empty override
    // so streamRunInner's back-compat query-start can't double-queue. (Express
    // 5's req.query is a re-parsing getter: the old `delete req.query.message`
    // silently no-ops and the attach re-queued the message → busy 409.)
    // The session id is passed EXPLICITLY: this entry is reached from the
    // unified GET /api/crossmodel/stream (chatId in the query, no `:id` route
    // param) as well as from /chats/:id/stream — re-reading req.params.id here
    // was undefined on the former and 500'd after the run was queued (PE-01).
    return this.streamRunInner(req, res, (message.trim() || files.length) ? '' : undefined, session.id);
  }

  /**
   * Phase-2 SSE: TAIL a run's durable agent_events log from Postgres (the web
   * process owns no execution — a worker does). Polls from the client's cursor
   * every TAIL_POLL_MS; ends when a terminal event (complete|error) is written,
   * or when the run ROW has gone terminal with no new events (honest end —
   * NEVER fabricate 'complete' for a live run). A still-queued run has no
   * events yet: emit ONE synthetic, unsequenced, never-persisted 'progress'
   * event so the UI shows life while a worker picks it up.
   */
  private tailActiveRun(req: Request, res: Response, run: { id: string; status: string }, viewMode: ViewMode = 'full'): void {
    const heartbeat = this.openSSE(res);
    // Attach visibility (2026-08-28): repeated owner "waiting/reconnecting"
    // reports were undiagnosable because attaches left no log at all — we
    // could not even tell whether the browser's request reached this backend.
    // One line per attach (page-view frequency, not chatty).
    logger.info(`coding stream: tail attach run=${run.id.slice(0, 8)} status=${run.status} lastEventId=${String((req.headers['last-event-id'] as string | undefined) ?? '-').slice(0, 60)}`);
    // Cursor semantics: events with seq <= cursor are already seen and dropped.
    // agent_events seqs are PER-RUN, so the cursor is a COMPOSITE <runId>:<seq>
    // (lastEventId): a cursor proven against THIS run's id is TRUSTED — the
    // first poll filters in SQL from it (0c158104: re-attaching to a running
    // session no longer replays the whole log) and it NEVER resets on an
    // 'init' (ba6fa991): seqs are monotonic ACROSS generations of the same
    // run (the resumed worker's registry continues from getMaxAgentEventSeq),
    // so the client already holds everything at/below its cursor — a
    // new-generation init is just another newer row and is delivered like one.
    // A composite cursor for a DIFFERENT run, or a bare-numeric legacy cursor
    // (untrusted provenance), keeps the old behavior: fetch from -1 and reset
    // on the first init seen.
    const requested = lastEventId(req);
    const cursorTrusted = requested.runId !== null && requested.runId === run.id;
    let cursor = requested.runId !== null && !cursorTrusted ? -1 : requested.seq;
    let firstPoll = true;
    let polling = false;
    let ended = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      if (timer) clearInterval(timer);
      if (!res.writableEnded) res.end();
    };
    req.on('close', end);

    if (run.status === 'queued') {
      res.write(`data: ${JSON.stringify({ type: 'progress', data: { message: 'Queued — a worker will pick this up shortly…', stage: 'queued' } })}\n\n`);
    }

    const poll = async () => {
      if (ended || res.writableEnded || polling) return;
      polling = true;
      try {
        const isFirst = firstPoll;
        firstPoll = false;
        const rows = await getAgentEventsAfter(run.id, isFirst && !cursorTrusted ? -1 : cursor)
          .catch(() => [] as Array<{ seq: number; type: string; payload: any }>);
        let arrived = 0;
        let sawTerminal = false;
        const writer = createFrameWriter((chunk) => res.write(chunk), run.id, viewMode);
        for (const row of rows) {
          if (ended || res.writableEnded) break;
          // ba6fa991: only an UNTRUSTED cursor resets on init (a foreign seq
          // space must not filter this run's rows). A TRUSTED cursor never
          // resets — seqs are monotonic across generations of this run, so a
          // new-generation init is delivered like any other newer row.
          if (row.type === 'init' && !cursorTrusted) cursor = -1;
          if (cursor >= 0 && row.seq <= cursor) continue; // already seen by this client
          writer.writeRow(row);
          cursor = row.seq;
          arrived++;
          if (row.type === 'complete' || row.type === 'error') sawTerminal = true;
        }
        writer.flush();
        if (sawTerminal) { end(); return; }
        // Replay boundary: the backlog window has drained — from here every row
        // is LIVE. The client gates its per-frame autoscroll until this marker
        // (0c158104: a long replay no longer drags the view through already-read
        // history; unknown event types fall through older clients harmlessly).
        if (isFirst && !ended && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'replay_end', data: { throughSeq: cursor } })}\n\n`);
        }
        // The worker appends the terminal event BEFORE finalizeAgentRun flips
        // the row, so a terminal row with nothing new means the log's terminal
        // event was already streamed above (or lost with its writer) — end
        // honestly either way. A reconnecting client's replay serves the rest.
        if (!arrived) {
          const row = await prisma.agentRun.findUnique({ where: { id: run.id }, select: { status: true } }).catch(() => null);
          // 'interrupted' stays OPEN: a deploy-bounced run is re-claimed within
          // seconds-to-minutes and events continue under the SAME run id — the
          // tail poller picks them up on this connection (2026-08-28 replay-loop
          // fix). A run the reaper eventually fails flips to 'failed' and ends
          // the stream honestly here.
          if (row && row.status !== 'queued' && row.status !== 'running' && row.status !== 'interrupted') end();
        }
      } finally {
        polling = false;
      }
    };
    timer = setInterval(() => { void poll(); }, TAIL_POLL_MS);
    void poll(); // don't sit out the first interval
  }

  /**
   * Replay a FINISHED run's durable event log in order (attach-after-finish —
   * e.g. a very fast run started via POST /run, or a cross-color deploy replay),
   * honoring the same cursor + init-reset semantics as the live tail. Ends on
   * the log's terminal event, or honestly after the replay when the log has
   * none (its writer died before persisting one — never fabricate one here;
   * the session-idle path's interrupted-complete covers the orphaned case).
   */
  private replayRun(req: Request, res: Response, runId: string, viewMode: ViewMode = 'full'): void {
    const heartbeat = this.openSSE(res);
    logger.info(`coding stream: replay attach run=${runId.slice(0, 8)} lastEventId=${String((req.headers['last-event-id'] as string | undefined) ?? '-').slice(0, 60)}`);
    const end = () => {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };
    req.on('close', end);
    void (async () => {
      // Fetch the log IN PAGES (a long run's per-token text events can exceed
      // one page). Cursor semantics match tailActiveRun (0c158104 + ba6fa991):
      // a TRUSTED composite cursor for THIS run filters in SQL from the first
      // page (no whole-log replay on re-attach) and NEVER resets on an 'init'
      // (seqs are monotonic across generations of this run — a new-generation
      // init is just another newer row); a foreign-run composite or
      // bare-numeric legacy cursor fetches from -1 and resets on the first
      // init. Later pages use the highest seq ACTUALLY SEEN, which is known to
      // be in this run's space, so SQL filtering is safe.
      const requested = lastEventId(req);
      const cursorTrusted = requested.runId !== null && requested.runId === runId;
      let cursor = requested.runId !== null && !cursorTrusted ? -1 : requested.seq;
      let seen = cursorTrusted ? cursor : -1;
      for (;;) {
        const rows = await getAgentEventsAfter(runId, seen < 0 ? -1 : seen, REPLAY_PAGE_SIZE)
          .catch(() => [] as Array<{ seq: number; type: string; payload: any }>);
        let terminal = false;
        const writer = createFrameWriter((chunk) => res.write(chunk), runId, viewMode);
        for (const row of rows) {
          if (res.writableEnded) return;
          // ba6fa991: a TRUSTED cursor never resets on init (same semantics as
          // tailActiveRun) — the new-generation init is written like any newer row.
          if (row.type === 'init' && !cursorTrusted) cursor = -1;
          if (cursor < 0 || row.seq > cursor) {
            writer.writeRow(row);
            cursor = row.seq;
            if (row.type === 'complete' || row.type === 'error') { terminal = true; }
          }
          seen = Math.max(seen, row.seq); // skipped-or-written, the page position advances
          if (terminal) break;
        }
        writer.flush();
        if (terminal || rows.length < REPLAY_PAGE_SIZE) break;
      }
      end();
    })();
  }

  /**
   * Service-level steer (no HTTP request): deliver a text message INTO the
   * session's active run — the same Redis mailbox + user-row persistence the
   * POST /steer handler uses. Used by platform.service sendChatMessage for a
   * BUSY coding chat (a busy coding session's right semantics is steer, not a
   * 409 that loses the message). Returns steered:false when no run is active
   * (the caller then falls through to starting a fresh run).
   *
   * opts.origin / opts.originSourceChatId: fleet origin marking for the
   * persisted user row (hardening round 2, 2026-08-23) — mirrors the fresh-run
   * path's metadata.origin stamp (run-executor.ts): without it a webhook/agent
   * steer persisted unmarked and fleet.service counted it as a HUMAN turn.
   * The HTTP steer handler passes nothing (a real user turn stays unmarked,
   * exactly like a REST send).
   */
  async steerActiveRun(sessionId: string, text: string, images: ChatImage[] = [], opts?: {
    origin?: 'user' | 'schedule' | 'hook' | 'agent' | 'webhook';
    originSourceChatId?: string;
    /** Resolved chat-upload files (7f546b03) — staged into the worktree by the
     *  worker when it drains this steer; metadata-only on the persisted row. */
    files?: SessionFilePayload[];
    /** Owner-subscribed schedule firing (ticket 4565991a, coding leg): the
     *  busy-steer delivery of an owner-subscribed firing — stamps
     *  metadata.scheduleOwnerArmed on the persisted steer user row so the
     *  frontend renders the turn EXPANDED (same shape as the fresh-run path). */
    scheduleOwnerArmed?: boolean;
  }): Promise<{ steered: boolean; reason?: string }> {
    // The worker owns the run now — "active" = a queued/in-flight ROW, not an
    // in-process registry entry.
    const active = await getActiveRunForSession(sessionId).catch(() => null);
    if (!active) return { steered: false, reason: 'no_active_run' };
    // Message-as-answer (ticket 356d21bb, Gap C): a run PARKED in awaitAnswer
    // never reaches the steer drain's step boundary — an inbound message while
    // a question card is live IS the answer. Publish it on the RESOLUTION
    // mailbox instead (the parked run's cancelPoll drains that every ~2s),
    // stamp the durable record 'answered' BEFORE anything can write 'expired',
    // and close the flagged owner-question rows for the same decision. No
    // content heuristics: any text while a card is live answers it; the parked
    // agent gets the full text and can re-ask if it was off-topic.
    if (text.trim()) {
      const { resolveParkedQuestionWithOwnerText } = await import('../message-as-answer');
      // The helper scopes owner-question resolution by owner — the session's
      // chat row carries it (coding sessions live on crossModelChat rows, P5-B).
      const chatUserId = await prisma.crossModelChat
        .findUnique({ where: { id: sessionId }, select: { userId: true } })
        .then((c) => c?.userId ?? '')
        .catch(() => '');
      const answered = await resolveParkedQuestionWithOwnerText({
        chatId: sessionId,
        userId: chatUserId,
        text,
      }).catch(() => ({ resolved: false }));
      if (answered.resolved) {
        // Persist the owner's text as a user row (transcript honesty — same
        // shape as the steer persistence below) and report DELIVERED: the
        // message reached the run as the card's answer, so no steer push.
        await appendCodingMessage({
          chatId: sessionId,
          role: 'user',
          content: text.trim(),
          parts: [{ type: 'text', text: text.trim() }] as unknown as object[],
          ...(opts?.origin ? {
            metadata: {
              origin: opts.origin,
              ...(opts.originSourceChatId ? { sourceChatId: opts.originSourceChatId } : {}),
            },
          } : {}),
        }).catch(() => {});
        return { steered: true, reason: 'answered_question' };
      }
    }
    // Attachment-only steer (blank text + files): the FACTUAL marker stands in
    // for the blank text — a persisted blank user row re-enters future model
    // history as phantom/empty context (confirmation review B1). ONE helper,
    // same rule as the run-start entries.
    const steerText = text.trim() ? text : attachmentOnlyRunMessage(opts?.files ?? []);
    // Persist the steer as a user row so steered images (and text) survive a
    // reload and appear — downgraded — in future run history. The live 'steer'
    // echo is deliberately NOT appended to agent_events here: event seqs are
    // owned by the WORKER's in-process counter, so a web-side insert could
    // collide on (runId, seq). The worker's drain emits progress + steer_ack
    // when it folds the steer in — that is the visible landing signal.
    // P5-A: dual-writes the crossmodel_messages mirror in the same transaction.
    // Files ride metadata.attachments (filename+type only) — NEVER `parts`:
    // the base64 must not persist into transcript rows.
    //
    // fc7b2ca7 ordering: the row id is PRE-GENERATED and rides the mailbox
    // payload (messageIds). A steer pushed in the run's finalize window is
    // never drained by that run — the stranded-steer recovery (steer-recovery.ts)
    // re-queues the text as a follow-up run, whose input persist would insert a
    // SECOND, byte-identical user row (2026-09-15: triage note landed twice,
    // msg 133f6923 + msg 4e9a91e8). The id lets the run-start adopt THIS row
    // instead. Push-first ordering is kept (at-least-once: a persist failure
    // still steers; the reverse could lose the message). A persist failure
    // leaves the id DANGLING in the mailbox — harmless: the run-start adopt
    // gate counts the listed rows and treats a missing one as a partial miss,
    // inserting as before (duplicate-over-loss, never loss).
    const steerMessageId = randomUUID();
    // audit 2026-10-08 W2-9: the sender's origin rides the mailbox so the worker
    // frames a peer / schedule / hook / webhook steer as NOT the owner's words.
    await pushSteerMessage(sessionId, {
      text: steerText, images, ...(opts?.files?.length ? { files: opts.files } : {}), messageIds: [steerMessageId],
      ...(opts?.origin ? { origin: opts.origin } : {}), ...(opts?.originSourceChatId ? { sourceChatId: opts.originSourceChatId } : {}),
    });
    await appendCodingMessage({
      chatId: sessionId,
      role: 'user',
      content: steerText,
      parts: [{ type: 'text', text: steerText }, ...images.map(i => ({ type: 'image', mediaType: i.mediaType, data: i.data, name: i.name }))] as unknown as object[],
      // Fleet origin marking (mirror-only, same shape as run-executor's
      // fresh-run stamp): present only when the caller marks the send.
      ...((opts?.origin || opts?.files?.length || opts?.scheduleOwnerArmed) ? {
        metadata: {
          ...(opts?.origin ? {
            origin: opts.origin,
            ...(opts.originSourceChatId ? { sourceChatId: opts.originSourceChatId } : {}),
          } : {}),
          ...(opts?.files?.length
            ? { attachments: opts.files.map(f => ({ filename: f.name || 'file', type: f.mediaType })) }
            : {}),
          // Owner-subscribed schedule firing (ticket 4565991a, coding leg):
          // the busy-steer delivery of an owner-subscribed firing stamps the
          // SAME anchor marker the fresh-run path does — the frontend mounts
          // the machine turn EXPANDED with a "requested" marker.
          ...(opts?.scheduleOwnerArmed && opts?.origin === 'schedule' ? { scheduleOwnerArmed: true } : {}),
        },
      } : {}),
    }, steerMessageId).catch(() => {});
    return { steered: true };
  }

  /**
   * POST /coding/sessions/:id/steer — queue a message INTO the active run.
   * Cross-process (Phase 2): the message rides a Redis list the WORKER drains
   * once per top-level step and injects as a high-priority instruction (no
   * wait, no second run). If no run is active, tell the client to send it as a
   * normal /run instead.
   */
  async steerRun(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { id } = req.params;
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const imgCheck = validateImages(req.body?.images);
    if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
    const images = imgCheck.images;
    // Staged chat-upload ids (7f546b03) resolve into file payloads — an
    // attachment-only steer is legal and stages into the worktree at drain.
    let files: SessionFilePayload[] = [];
    try {
      const uploadIds = this.parseUploadIdsBody(req.body?.uploadIds);
      if (uploadIds.length) files = await this.resolveUploadIdsToFiles(uploadIds, userId);
    } catch (err: any) {
      return res.status(err instanceof AppError ? err.statusCode : 500).json({ error: err.message });
    }
    if (!message.trim() && !images.length && !files.length) return res.status(400).json({ error: 'message is required' });
    // Ticket 7acaa7ba: read-gate first, then an honest owner check — a member
    // steering an active shared run got 404 "Session not found" (indistinguishable
    // from a bad link). Member → 403 actionable; stranger → unchanged 404.
    const session = await getSessionForUser(id, userId, 'read');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.userId !== userId) {
      return res.status(403).json({
        error: 'This coding session belongs to the project owner — only the owner can steer its runs. Ask the owner to send your request, or watch the run from this view.',
        code: 'CODING_OWNER_ONLY',
      });
    }
    // Text-only session model + images: describe-and-inject (owner wave
    // 2026-09-03) — same contract as startRun above.
    let steerImages = images;
    let steerMessage = message.trim();
    if (images.length && !(await modelSupportsVisionForRun(session.model, userId))) {
      try {
        const described = await describeImagesForTextOnlyModel(images, session.model);
        steerMessage = [described, steerMessage].filter(Boolean).join('\n\n');
        steerImages = [];
      } catch {
        return res.status(400).json({ error: `The ${session.model} model can't see images and the vision description failed — switch the session model or remove the attachment.` });
      }
    }
    const result = await this.steerActiveRun(id, steerMessage, steerImages, files.length ? { files } : undefined);
    if (!result.steered) return res.status(409).json({ error: 'No active run to steer — send it as a normal message.' });
    return res.json({ success: true, data: { steered: true } });
  }

  /**
   * Stop a running session (Stop button). Cross-process cancel via Redis (the
   * worker polls the key every 2 s and bails at its next step boundary); else
   * unstick a genuinely orphaned row.
   */
  async stopRun(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { id } = req.params;
    const session = await getSessionForUser(id, userId, 'owner');
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // STOP MEANS STOP (2026-09-29, continuation-guard.ts): a Stop also cancels
    // the session's QUEUED harness-continuation rows FIRST, so the follow-up a
    // finished run already queued cannot restart the lane ~45 s later. Done
    // before the active-run read: when the only "active" row was such a
    // continuation, no cancel key is left behind to kill the user's NEXT run.
    const { cancelQueuedContinuations } = await import('./continuation-guard');
    const cancelledContinuations = (await cancelQueuedContinuations(id, 'continuation cancelled: the session was stopped')).length;
    if (cancelledContinuations) {
      void import('../platform/loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.CONTINUATION_SUPPRESSED, sessionId: id, meta: { reason: 'stopped', seam: 'stop', cancelled: cancelledContinuations } }))
        .catch(() => {});
    }
    const active = await getActiveRunForSession(id).catch(() => null);
    if (active) {
      // The worker's 2 s cancel poll takes the key and flips its local
      // cooperative flag; the run finalizes 'cancelled'. A still-queued run is
      // cancelled right after its claim — the key outlives the wait (EX 600).
      await requestRunCancel(id);
      return res.json({ success: true, data: { stopping: true, ...(cancelledContinuations ? { cancelledContinuations } : {}) } });
    }
    // No active run. Unstick a stuck row ONLY if it's genuinely orphaned — no
    // FRESH claimable agent_runs row (a live worker owns/will own those — see
    // the orphan sweeper guard; stale rows prove no worker owns them) and no
    // live instance holding the run lock.
    if (session.status === 'running') {
      const claimable = await prisma.agentRun.findFirst({
        where: {
          sessionId: id,
          status: { in: ['queued', 'interrupted', 'running'] },
          updatedAt: { gte: new Date(Date.now() - CLAIMABLE_ROW_FRESH_MS) },
        },
        select: { id: true },
      }).catch(() => null);
      if (!claimable && !(await isSessionRunLocked(id))) {
        await updateSessionState(id, { status: 'ready' }).catch(() => {});
      }
    }
    res.json({ success: true, data: { stopping: false, ...(cancelledContinuations ? { cancelledContinuations } : {}) } });
  }

  /**
   * GET /chats/:chatId/worktree/tree — Phase-1 sidebar Files tab (feedback
   * 999e3dbe): ONE lazy READ-ONLY directory level of the chat's coding
   * worktree, with git-status badges. The ownership gate, symlink-aware
   * path-escape guard, and git listing logic live in worktree-files.ts —
   * these are thin delegations so all coding HTTP handlers stay on this one
   * controller (mounted via the codingRun lazy wrapper in
   * crossmodel.routes.ts).
   */
  async worktreeTree(req: Request, res: Response) {
    return getWorktreeTree(req, res);
  }

  /**
   * GET /chats/:chatId/worktree/file — the inline file viewer companion
   * (feedback 999e3dbe): UTF-8 text only, 400 dir / 413 >256KB / 415 binary.
   */
  async worktreeFile(req: Request, res: Response) {
    return getWorktreeFile(req, res);
  }

  /**
   * GET /chats/:chatId/worktree/raw — the DOWNLOAD companion (ticket
   * 19fbd876): the file's real bytes (binary included), octet-stream +
   * Content-Disposition attachment, 16 MB cap. Without it the Files tab's
   * download blobroute handed the 415 notice text out as a mislabeled .txt.
   */
  async worktreeRaw(req: Request, res: Response) {
    return getWorktreeRaw(req, res);
  }

  /**
   * Start a run on an existing session from OUTSIDE any HTTP request (the
   * self-scheduler sweeper). The SAME Phase-2 queue path as POST /run: atomic
   * busy-gate + queueAgentRun. 'busy' when the session isn't 'ready' (a run is
   * queued/executing) — the sweeper re-arms shortly WITHOUT consuming the run
   * budget. Resolves the owning user from the chat row since the caller has no
   * req.user. Returns whether it started (+ a skip reason).
   *
   * opts.userTurnAt: set ONLY when the trigger is a REAL user turn (the
   * platform.service sendChatMessage path — REST send or a user-confirmed
   * send_chat_message tool call). The schedule sweeper calls WITHOUT it: a
   * machine-fired run carries no confirmation anchor and can never confirm
   * consequential platform tools (platform/pending-confirmations.ts).
   *
   * opts.origin / opts.originSourceChatId: fleet origin marking — an explicit
   * origin for the queued message (platform.service passes the sender's kind;
   * 'agent' sends also carry the sending chat's id). Omitted → the executor's
   * userTurnAt heuristic stamps 'user' (real turn) or 'schedule' (machine).
   */
  async startScheduledRun(sessionId: string, prompt: string, opts?: {
    userTurnAt?: Date;
    origin?: 'user' | 'schedule' | 'hook' | 'agent' | 'webhook';
    originSourceChatId?: string;
    /**
     * cff523e7: the coding_schedules row that fired this run — passed ONLY by
     * fireScheduleTarget for a REAL schedule firing (never a hook wake). Stamped
     * onto the queued RunInput so the executor can count consecutive
     * provider-killed runs per schedule.
     */
    scheduleId?: string;
    /**
     * 3405e332: passed ONLY by fireScheduleTarget for a kind:'once' firing —
     * when the session is genuinely busy (both queue attempts refused), insert
     * the run as a queued agent_runs row BEHIND the active run instead of
     * returning 'busy', so a one-shot can never drift for hours on the
     * sweeper's 3-min re-arm while runs stays 0/1.
     */
    queueBehindBusy?: boolean;
    /** Resolved chat-upload files (7f546b03) — ride RunInput.files; the
     *  executor stages them into the worktree at input consumption. */
    files?: SessionFilePayload[];
    /** WI-C (2026-09-25): the shadow decision-gate stash this run's finalize
     *  labels — passed ONLY by fireScheduleTarget; rides RunInput.decision. */
    decision?: DecisionStash;
    /** Child→parent result-hook wake (ticket 56d6b204): passed ONLY by
     *  fireScheduleTarget for a child-result hook delivery; rides
     *  RunInput.childResult so the executor stamps the wake user row's
     *  metadata.childResult (frontend renders the turn EXPANDED). */
    childResult?: boolean;
    /** Owner-subscribed schedule firing (ticket 4565991a, coding-session leg):
     *  passed ONLY by fireScheduleTarget when the firing row carries
     *  promptSetBy 'user' or ownerSubscribed true; rides
     *  RunInput.scheduleOwnerArmed so the executor stamps the wake user row's
     *  metadata.scheduleOwnerArmed + the final answer row's metadata.kind
     *  'owner_digest' and threads the subscription into the agent loop's own
     *  re-arms (the dormant-gate one-shot ladder — see RunInput docs). */
    scheduleOwnerArmed?: boolean;
    /** Owner-dispatch (2026-10-01): passed ONLY by platform sendChatMessage for
     *  an owner-dispatch-eligible agent send; stamped on RunInput only beside
     *  origin 'agent' + a userTurnAt anchor (the executor classifies it 'user'). */
    ownerDispatch?: boolean;
    /** ARCHIVED-TARGET-RETIRE (f, 2026-10-20): fireScheduleTarget's dispatch
     *  surface ('owner_answer') — names the archived-refusal row's surface only. */
    dispatchSurface?: 'owner_answer';
  }): Promise<{ started: boolean; reason?: string; queued?: boolean; runId?: string }> {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: sessionId }, select: { userId: true } });
    if (!chat) return { started: false, reason: 'not_found' };
    const session = await getSessionForUser(sessionId, chat.userId, 'owner', { includeProject: true });
    if (!session || !session.project) return { started: false, reason: 'not_found' };
    // Cap-skip self-healing: if earlier firings were skipped at the daily cap,
    // the session LEARNS it here (previously only lastStatus + a log line knew)
    // and can re-space its cadence instead of running blind. The count rides
    // RunInput.capSkippedNotice — the executor injects it as SYSTEM context and
    // stamps it into the user row's metadata, never into the message content
    // (this path also carries real HUMAN turns via platform sendChatMessage; the
    // old prompt-prepend persisted the ops banner as the user's own words). If
    // the run does NOT start (busy gate / queue error), the consumed count is
    // restored so a congested chat can't silently swallow it.
    const skipped = await consumeCapSkipNotice(sessionId).catch(() => 0);
    // Spend-skip parity (P7 N7/S1a): the spend-cap channel rides the same
    // consume-or-restore contract as the daily-cap notice above.
    const spendSkipped = await import('./spend-cap.service')
      .then((m) => m.consumeSpendCapSkipNotice(sessionId))
      .catch(() => 0);
    // Machine-provenance header (fbe65673): schedule firings + hook wakes used
    // to queue as BARE user rows, indistinguishable from an owner-typed
    // instruction — a stale firing overrode an explicit owner "pause work"
    // (2026-08-27). Prepend at queue time so the marker rides the persisted
    // row, the run goal, and every future history render. schedule/hook ONLY:
    // this path also carries real HUMAN turns (platform sendChatMessage) and
    // prepending to THOSE was the cap-skip banner bug above. The
    // '[MACHINE-TRIGGERED RUN' prefix matches the UI wake classifier
    // (frontend/lib/machine-wake.ts) so these render collapsed like any wake.
    const provenance = opts?.origin === 'schedule' || opts?.origin === 'hook'
      ? machineFiringHeader(opts.origin) : '';
    const input: RunInput = {
      // Blank prompt + files (an attachment-only platform send): the FACTUAL
      // marker stands in — a blank persisted user row poisons future model
      // history and the title seed (confirmation review B1).
      message: prompt.trim() ? provenance + prompt : attachmentOnlyRunMessage(opts?.files ?? []),
      images: [], userId: chat.userId,
      ...(skipped > 0 ? { capSkippedNotice: skipped } : {}),
      ...(spendSkipped > 0 ? { spendCapSkippedNotice: spendSkipped } : {}),
      ...(opts?.files?.length ? { files: opts.files } : {}),
      ...(opts?.userTurnAt ? { userTurnAt: opts.userTurnAt.toISOString() } : {}),
      ...(opts?.scheduleId ? { scheduleId: opts.scheduleId } : {}),
      ...(opts?.decision ? { decision: opts.decision } : {}),
      // Child→parent result-hook wake (ticket 56d6b204): the executor stamps
      // the wake user row's metadata.childResult so the sub-session's
      // delivered verdict renders EXPANDED, never behind the accordion.
      ...(opts?.childResult ? { childResult: true } : {}),
      // Owner-subscribed schedule firing (ticket 4565991a, coding-session
      // leg): the executor stamps the wake user row's
      // metadata.scheduleOwnerArmed + the final answer row's kind
      // 'owner_digest', and threads the subscription into the agent loop's
      // own-chat re-arms — the one-shot ladder keeps the mark (see RunInput).
      ...(opts?.scheduleOwnerArmed ? { scheduleOwnerArmed: true } : {}),
      ...(opts?.origin ? {
        origin: opts.origin,
        ...(opts.originSourceChatId ? { originSourceChatId: opts.originSourceChatId } : {}),
      } : {}),
      // Owner-dispatch (2026-10-01): only beside origin 'agent' + an owner
      // anchor — anything else never carries the flag (fail-closed → machine).
      ...(opts?.ownerDispatch === true && opts.origin === 'agent' && opts.userTurnAt ? { ownerDispatch: true } : {}),
    };
    try {
      let r: { started: boolean; reason?: string; queued?: boolean; runId?: string } = await this.queueRun(sessionId, input);
      if (!r.started && r.reason === 'busy') {
        // Self-heal an unrunnable (errored / never-provisioned) session and
        // retry ONCE — a genuinely busy session stays busy (heal returns false).
        // A MACHINE dispatch (no user turn; origin schedule/hook/agent/webhook
        // or the heuristic default) never revives an ARCHIVED session — the
        // heal answers 'archived' and the caller learns the true reason.
        const machine = !opts?.userTurnAt && opts?.origin !== 'user';
        const healed = await this.healUnrunnableSession(sessionId, session, { machine, origin: opts?.origin, dispatchSurface: opts?.dispatchSurface });
        if (healed === 'archived') {
          r = { started: false, reason: 'archived' };
        } else if (healed) {
          r = await this.queueRun(sessionId, input);
        }
      }
      if (!r.started && r.reason === 'busy' && opts?.queueBehindBusy) {
        // Queue-behind-busy (ticket 3405e332): a ONE-SHOT schedule firing on a
        // genuinely busy session rides the agent_runs queue BEHIND the active
        // run instead of the sweeper's skip+3-min re-arm (which can drift a
        // "check back in 90 minutes" for HOURS on a continuously-busy lane —
        // the Fleet Supervisor one-shots sat runs 0/1 for 7h/3h). The gate
        // mirrors queueContinuationRun: BUSY = any OTHER 'queued' row already
        // waiting (a continuation / colliding firing) — then we stay busy and
        // the sweeper re-arms. The queued row carries the SAME built input
        // (provenance header + scheduleId), becomes claimable after a short
        // NOT-BEFORE (leaseExpiresAt — the channel requeueRun and
        // queueContinuationRun already use), and the executor's claim-time
        // stale-firing guard still enforces cancel-wins: a post-queue cancel
        // drops it, while the once-row's consumed 'started' state keeps it
        // (run-executor.test.ts:743).
        try {
          const waiting = await prisma.agentRun.findFirst({
            where: { sessionId, status: 'queued' },
            select: { id: true },
          });
          if (!waiting) {
            const row = await prisma.agentRun.create({
              data: {
                sessionId,
                status: 'queued',
                input: input as unknown as object,
                leaseExpiresAt: new Date(Date.now() + QUEUE_BEHIND_BUSY_DELAY_MS),
              },
              select: { id: true },
            });
            logger.info(`coding schedule: queued once-firing run ${row.id} behind the busy session ${sessionId.slice(0, 8)} (schedule ${opts.scheduleId ?? 'n/a'})`);
            r = { started: true, queued: true, runId: row.id };
          }
        } catch (queueErr: any) {
          logger.warn(`coding schedule: queue-behind-busy insert failed for ${sessionId.slice(0, 8)} (${queueErr?.message ?? queueErr}) — falling back to busy re-arm`);
        }
      }
      if (!r.started && skipped > 0) await restoreCapSkipNotice(sessionId, skipped).catch(() => {});
      if (!r.started && spendSkipped > 0) {
        await import('./spend-cap.service').then((m) => m.restoreSpendCapSkipNotice(sessionId, spendSkipped)).catch(() => {});
      }
      return r;
    } catch (err) {
      if (skipped > 0) await restoreCapSkipNotice(sessionId, skipped).catch(() => {});
      if (spendSkipped > 0) {
        await import('./spend-cap.service').then((m) => m.restoreSpendCapSkipNotice(sessionId, spendSkipped)).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * POST /coding/questions/:questionId  { answer }  (header-auth).
   * Resolves an ask_user question the orchestrator is blocked on. Cross-process
   * (Phase 2 LEG 2c): the awaiting promise lives in a WORKER, so this endpoint
   * never touches the in-memory registry — the pending-presence key gives the
   * owning session (unknown/expired → success:false, same shape as the old
   * in-memory miss), the ownership check is unchanged, and the answer rides
   * the session's Redis mailbox for the worker's poll to apply.
   */
  async postQuestion(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { questionId } = req.params;
    const answer = typeof req.body?.answer === 'string' ? req.body.answer : '';
    if (!answer.trim()) return res.status(400).json({ error: 'answer is required' });
    const sessionId = await getQuestionPendingSession(questionId);
    if (!sessionId) {
      // Phase 4 durable fallback: the pending key is gone (worker restart,
      // deploy, or an expired wait) — consult the durable record before
      // declaring the id unknown.
      const rec = await loadDurablePending('question', questionId);
      if (!rec) return res.json({ success: false });
      const ownedRec = await getSessionForUser(rec.sessionId, userId, 'owner');
      if (!ownedRec) return res.status(403).json({ error: 'Not your question to answer' });
      // Already answered (an earlier click, possibly pre-restart): idempotent.
      if (rec.status === 'answered') return res.json({ success: true });
      if (rec.status !== 'pending') return res.json({ success: false }); // expired — same as unknown
      await markDurableResolved('question', questionId, 'answered', answer.slice(0, 8000));
      // If a restarted run re-asked this exact question, the fingerprint points
      // at the NEW live wait — deliver there; else the mailbox entry no-ops
      // (and the recorded answer replays on the next re-ask).
      const currentId = rec.fingerprint ? await currentIdForFingerprint('question', rec.sessionId, rec.fingerprint) : null;
      await publishQuestionResolution(rec.sessionId, currentId ?? questionId, answer.slice(0, 8000));
      await autoResolveFlaggedOwnerDecision(rec.sessionId, userId, currentId ?? questionId, answer.slice(0, 8000));
      return res.json({ success: true });
    }
    // Ownership: only the user who owns the question's session may answer it
    // (question ids are semi-guessable; every other endpoint scopes by userId).
    const owned = await getSessionForUser(sessionId, userId, 'owner');
    if (!owned) return res.status(403).json({ error: 'Not your question to answer' });
    await publishQuestionResolution(sessionId, questionId, answer.slice(0, 8000));
    await autoResolveFlaggedOwnerDecision(sessionId, userId, questionId, answer.slice(0, 8000));
    res.json({ success: true });
  }

  /**
   * POST /coding/approvals/:approvalId  { decision }  (header-auth).
   * Same cross-process shape as postQuestion: pending key → ownership → mailbox.
   */
  async postApproval(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const { approvalId } = req.params;
    const decision = req.body?.decision;
    if (!['allow', 'always', 'deny'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be allow|always|deny' });
    }
    const sessionId = await getApprovalPendingSession(approvalId);
    if (!sessionId) {
      // Phase 4 durable fallback: the pending key is gone (worker restart,
      // deploy, or an expired wait) — consult the durable record before
      // declaring the id unknown.
      const rec = await loadDurablePending('approval', approvalId);
      if (!rec) return res.json({ success: false });
      const ownedRec = await getSessionForUser(rec.sessionId, userId, 'owner');
      if (!ownedRec) return res.status(403).json({ error: 'Not your approval to resolve' });
      // Already decided (an earlier click, possibly pre-restart): idempotent.
      if (rec.status === 'answered' || rec.status === 'denied') return res.json({ success: true });
      if (rec.status !== 'pending') return res.json({ success: false }); // expired — same as unknown
      await markDurableResolved('approval', approvalId, decision === 'deny' ? 'denied' : 'answered', decision);
      // If a restarted run re-asked this exact call, the fingerprint points at
      // the NEW live wait — deliver there; else the mailbox entry no-ops (and
      // the recorded decision replays on the next re-ask).
      const currentId = rec.fingerprint ? await currentIdForFingerprint('approval', rec.sessionId, rec.fingerprint) : null;
      await publishApprovalResolution(rec.sessionId, currentId ?? approvalId, decision);
      return res.json({ success: true });
    }
    // Ownership: only the user who owns the approval's session may resolve it.
    const owned = await getSessionForUser(sessionId, userId, 'owner');
    if (!owned) return res.status(403).json({ error: 'Not your approval to resolve' });
    await publishApprovalResolution(sessionId, approvalId, decision);
    res.json({ success: true });
  }
}

/**
 * 3405e332: NOT-BEFORE for a once-schedule firing queued behind a busy session
 * (startScheduledRun queueBehindBusy) — mirrors queueContinuationRun's ~45s so
 * the caller's bookkeeping (the sweeper's consume bump) lands before the worker
 * can claim the row, riding the same leaseExpiresAt channel.
 */
export const QUEUE_BEHIND_BUSY_DELAY_MS = 45_000;

const codingStreamController = new CodingStreamController();
export default codingStreamController;

/** Module-level entry for the schedule sweeper (no HTTP request). */
export function startScheduledRun(sessionId: string, prompt: string, opts?: {
  userTurnAt?: Date;
  origin?: 'user' | 'schedule' | 'hook' | 'agent' | 'webhook';
  originSourceChatId?: string;
  /** cff523e7: the firing coding_schedules row id (REAL schedule firings only). */
  scheduleId?: string;
  /** 3405e332: kind:'once' firings only — queue behind a busy session instead of returning 'busy'. */
  queueBehindBusy?: boolean;
  /** Resolved chat-upload files (7f546b03) — ride RunInput.files. */
  files?: SessionFilePayload[];
  /** WI-C: the shadow decision-gate stash the run's finalize labels (fireScheduleTarget only). */
  decision?: DecisionStash;
  /** Child→parent result-hook wake (ticket 56d6b204): fireScheduleTarget only
   *  — stamps metadata.childResult on the wake user row (frontend renders the
   *  sub-session's delivered result EXPANDED). */
  childResult?: boolean;
  /** Owner-subscribed schedule firing (ticket 4565991a, coding-session leg):
   *  fireScheduleTarget only — stamps metadata.scheduleOwnerArmed on the wake
   *  user row + kind 'owner_digest' on the final answer row, and threads the
   *  subscription into the agent loop's own-chat re-arms (the one-shot ladder). */
  scheduleOwnerArmed?: boolean;
  /** Owner-dispatch (2026-10-01): platform sendChatMessage only — see the method. */
  ownerDispatch?: boolean;
  /** ARCHIVED-TARGET-RETIRE (f): fireScheduleTarget only — see the method. */
  dispatchSurface?: 'owner_answer';
  }): Promise<{ started: boolean; reason?: string; queued?: boolean; runId?: string }> {
    return codingStreamController.startScheduledRun(sessionId, prompt, opts);
  }

/**
 * Module-level entry for steering a message INTO the active run from outside
 * any HTTP request (platform.service sendChatMessage — the busy-coding-chat
 * path of the busy-chat message queue). `opts` carries the sender's fleet
 * origin so the persisted steer row is stamped like the fresh-run path.
 */
export function steerActiveRun(sessionId: string, text: string, opts?: {
  origin?: 'user' | 'schedule' | 'hook' | 'agent' | 'webhook';
  originSourceChatId?: string;
  /** Resolved chat-upload files (7f546b03) — staged into the worktree at drain. */
  files?: SessionFilePayload[];
  /** Owner-subscribed schedule firing (ticket 4565991a, coding leg): stamps
   *  metadata.scheduleOwnerArmed on the persisted steer row (expanded render). */
  scheduleOwnerArmed?: boolean;
}): Promise<{ steered: boolean; reason?: string }> {
  return codingStreamController.steerActiveRun(sessionId, text, [], opts);
}
