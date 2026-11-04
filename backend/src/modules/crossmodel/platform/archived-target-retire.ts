/**
 * ARCHIVED-TARGET-RETIRE (2026-10-20) — machine work aimed at an ARCHIVED chat
 * is retired at its SOURCE instead of being refused at every firing.
 *
 * An archive is a stop (autonomy loop #13, 2026-09-20): fireScheduleTarget,
 * the dispatch heal, hook delivery and sendChatMessage all refuse a machine
 * wake into an archived chat. But nothing retired the WORK that kept aiming at
 * it — prod logged 821 `machine_dispatch_archived_refused` rows in 7 days
 * (~20/h): the sweeper treated reason 'archived' as a plain skip (only
 * 'obsolete' was terminal), so a recurring row stayed enabled and the claim
 * slid its nextRunAt forever; an owner answer whose asking lane was archived
 * armed a durable retry ONTO that lane (refused every ~3 min for 24 h);
 * createSchedule / resume_schedule armed rows on archived chats; the session
 * API's archive left schedules + hooks live; and archived lanes kept their
 * goal todos assigned, so the board read them as owned while nobody could run
 * them. Six seams now retire the work:
 *   (a) the sweeper PAUSES a row whose firing was refused 'archived'
 *       (enabled:false, lastStatus 'paused:archived', cancelledBy 'machine',
 *       ids remembered here; a restore re-enables exactly those rows);
 *   (b) createSchedule / resume_schedule / armOwnerAnswerRetrySchedule refuse
 *       an archived target with an actionable message;
 *   (c) an owner ANSWER to an archived lane (its asker or its linked
 *       forChatId) is RE-ROUTED to the project's supervisor (else the Fleet
 *       Supervisor) with the question, the answer and the archived lane id —
 *       never a retry onto the archived chat, never onto a chat the same
 *       answer already wakes or the actor that answered; a dismissal /
 *       superseded notice / duplicate close aimed at it is dropped;
 *   (d) the coding session API's archive pauses the lane's schedules + hooks
 *       (as archiveChat already does for hooks), and a satellite-archived
 *       target retires a hook like an archivedAt-stamped one;
 *   (e) archiving a chat UNASSIGNS its live todos (progressNote = the 'lane
 *       archived' marker + the lane's last note) and sends ONE todo_wake to
 *       the supervisor (none for a project opted out of fleet supervision;
 *       the archiving supervisor gets them on its tool result instead); the
 *       attention watchdog reports archived assignees as 'orphaned' (not deaf);
 *   (f) machine_dispatch_archived_refused carries meta.surface
 *       schedule | hook | owner_answer (the chat kind moves to chatSurface).
 * Kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1 restores every seam
 * byte-for-byte (the refusals themselves are autonomy loop #13 and stay).
 *
 * This file is the LEAF: pure text/predicate helpers plus the DB helpers the
 * seams share. Lazy prisma (the owner-questions discipline): a static import of
 * config/database would pull config/env into every jest graph that reaches the
 * platform tools. Every DB helper is best-effort and never throws.
 */

import { progressNoteMax } from './progress-note';

type Prisma = typeof import('../../../config/database').default;
let _db: Prisma | null = null;
async function db(): Promise<Prisma> {
  if (!_db) _db = (await import('../../../config/database')).default;
  return _db;
}

async function log(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* logging never breaks a retire */ }
}

async function metric(chatId: string | undefined, meta: Record<string, unknown>, value?: number): Promise<void> {
  try {
    const m = await import('./loop-metrics.service');
    m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.ARCHIVED_TARGET_RETIRE, sessionId: chatId, ...(typeof value === 'number' ? { value } : {}), meta });
  } catch { /* telemetry never blocks */ }
}

/** Kill switch — read per call. ON (unset) retires; '1' restores the refuse-every-firing behaviour. */
export function archivedTargetRetireDisabled(): boolean {
  return process.env.ARCHIVED_TARGET_RETIRE_DISABLED === '1';
}

/** lastStatus of a schedule the archive retired (paused, resumable; a restore re-enables it). */
export const ARCHIVED_SCHEDULE_LAST_STATUS = 'paused:archived';

/** Context-store slot holding the schedule ids an archive paused (so a restore re-arms exactly those). */
export const ARCHIVE_PAUSED_SCHEDULES_NS = (chatId: string): string[] => ['schedules', 'archive-paused', chatId];

/** Live todo states (mirrors hooks.service LIVE_TODO_STATUSES — kept local so this leaf stays import-light). */
export const ARCHIVED_LANE_LIVE_TODO_STATUSES = ['pending', 'in_progress', 'blocked'] as const;

/** The archive marker an unassigned todo's progressNote carries (≤200 chars, the column's display convention). Pure. */
export function archivedLaneProgressNote(chatId: string): string {
  return `lane archived (${String(chatId).slice(0, 8)}) — unassigned; re-dispatch to a live lane`;
}

/**
 * A note that LEADS with a hold marker — a verbatim copy of
 * fleet/project-digest.service HOLD_NOTE_RE (the digest's "held per note" ETA
 * gate). Copied, not imported: this leaf must stay import-light.
 */
export const ARCHIVED_LANE_HOLD_LEAD_RE = /^\W{0,3}(?:HOLD|HELD|BLOCKED|[Oo][Nn][\s_-][Hh][Oo][Ll][Dd])\b/;

/** A marker an earlier archive of the same todo wrote (the lead form, or the tail form a HOLD note carries). */
const STALE_ARCHIVE_MARKER_LEAD_RE = /^lane archived \([^)]*\) — unassigned; re-dispatch to a live lane(?: \| prev: )?/;
const STALE_ARCHIVE_MARKER_TAIL_RE = /\s*\| lane archived \([^)]*\) — unassigned; re-dispatch to a live lane$/;

/** The previous note with any marker an earlier archive wrote stripped (markers never nest). Pure. */
export function previousLaneNote(prev: unknown): string {
  if (typeof prev !== 'string') return '';
  return prev.trim().replace(STALE_ARCHIVE_MARKER_LEAD_RE, '').replace(STALE_ARCHIVE_MARKER_TAIL_RE, '').trim();
}

/**
 * The progressNote an archive-unassigned todo is written with: the marker
 * PLUS the lane's last note, so the inheriting supervisor sees where the work
 * stood (review 2026-10-20 — overwriting the note lost the lane's HOLD /
 * progress ledger). Shape `<marker> | prev: <old>`; an old note that LEADS
 * with a hold marker stays first (`<old> | <marker>`) so the digest's "held
 * per note" gate still reads it. Never longer than `max` (the storage cap,
 * goals.service progressNoteMax); the marker always survives the clip. Pure.
 */
export function composeArchivedLaneProgressNote(chatId: string, prev: unknown, max: number = 2000): string {
  const marker = archivedLaneProgressNote(chatId);
  const old = previousLaneNote(prev);
  if (!old) return marker.slice(0, max);
  if (ARCHIVED_LANE_HOLD_LEAD_RE.test(old)) {
    const room = max - marker.length - 3;
    return room > 0 ? `${Array.from(old).slice(0, room).join('')} | ${marker}` : marker.slice(0, max);
  }
  return Array.from(`${marker} | prev: ${old}`).slice(0, max).join('');
}

/** A chat row is an archived TARGET when its archivedAt is stamped or its coding satellite is parked 'archived'. Pure. */
export function isArchivedTargetRow(row: { archivedAt?: unknown; codingState?: { status?: unknown } | null } | null | undefined): boolean {
  if (!row) return false;
  if (row.archivedAt) return true;
  return row.codingState?.status === 'archived';
}

export type ArchivedTargetArmAction = 'create' | 'resume' | 'owner_answer_retry';

/** The actionable refusal for arming / resuming a schedule on an archived chat. Pure. */
export function archivedTargetRefusal(chatId: string, action: ArchivedTargetArmAction): string {
  const what = action === 'resume' ? 'resumed' : 'created';
  return `Refused: chat ${chatId} is ARCHIVED — an archive is a stop, so machine wakes never fire into it and this schedule would only be refused at every firing. Nothing was ${what}. `
    + 'Arm it on a live chat instead (the project supervisor, or a fresh lane via start_coding_session), '
    + 'or restore the chat first (a user message in it, or Restore in the sidebar) if the lane should come back — a restore re-arms the schedules its archive paused.';
}

/** The wake a supervisor gets in place of an owner resolution addressed to an archived lane. Pure. */
export function ownerAnswerRerouteWake(opts: {
  archivedChatId: string;
  archivedTitle?: string | null;
  questionId?: string | null;
  content: string;
  tier: 'project' | 'fleet';
  /** 'asking' (default) — the archived chat filed the question; 'linked' — it is the question's forChatId (the lane the card gates). */
  laneRole?: 'asking' | 'linked';
}): string {
  const title = String(opts.archivedTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const lane = `${title ? `"${title}" ` : ''}(${opts.archivedChatId})`;
  const q = opts.questionId ? ` for question ${opts.questionId}` : '';
  return `[Owner inbox — RE-ROUTED to the ${opts.tier === 'project' ? 'project supervisor' : 'Fleet Supervisor'}: the ${opts.laneRole === 'linked' ? 'linked' : 'asking'} lane ${lane} is ARCHIVED]\n`
    + `This owner resolution${q} was addressed to that lane. The archive is a stop — the lane was NOT woken or revived, and no retry was armed onto it. `
    + 'Decide what the answer needs: re-dispatch the work to a live lane (todo_update assigneeChatId, or start_coding_session), '
    + 'record it and close or drop the related todos, or restore the lane only if the owner wants it back.\n\n'
    + `--- original wake for lane ${opts.archivedChatId} ---\n${String(opts.content ?? '')}`;
}

/** The ONE todo_wake a supervisor gets when an archived lane's live todos are unassigned. Pure. */
export function orphanedTodosWake(opts: {
  chatId: string;
  chatTitle?: string | null;
  todos: Array<{ id: string; title: string; status: string; prevNote?: string | null }>;
}): string {
  const title = String(opts.chatTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const shown = opts.todos.slice(0, 12);
  const lines = shown.map((t) => {
    // The lane's last note rides the line (where the work stood) — clipped; the full note is on todo_get.
    const was = Array.from(previousLaneNote(t.prevNote).replace(/\s+/g, ' '));
    const wasText = was.length ? ` — last note: "${was.slice(0, 100).join('')}${was.length > 100 ? '…' : ''}"` : '';
    return `- "${String(t.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)}" (${String(t.id).slice(0, 8)}, ${t.status})${wasText}`;
  });
  if (opts.todos.length > shown.length) lines.push(`- …and ${opts.todos.length - shown.length} more`);
  return `[todo_wake — lane ARCHIVED, its todos are now UNASSIGNED] Lane ${title ? `"${title}" ` : ''}(${opts.chatId}) was archived — an archive is a stop, so it will never run these. `
    + `The harness unassigned its ${opts.todos.length} live todo${opts.todos.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n\n`
    + 'Re-read them (todo_get / todo_list), then re-dispatch each to a live lane (todo_update assigneeChatId, or start_coding_session with the todo), '
    + 'or close / drop the ones the archive retired. Do not wake or restore the archived lane unless the owner asks.';
}

/**
 * The line an archive_chat tool result carries when the archiving actor IS
 * the inheriting supervisor — the todo_wake it would otherwise get, folded
 * into the turn that is already running (no second supervisor turn). Pure.
 */
export function actorInheritedTodosNote(chatId: string, todos: ArchivedLaneTodo[]): string {
  if (!todos.length) return '';
  const shown = todos.slice(0, 12).map((t) => `"${String(t.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}" (${String(t.id).slice(0, 8)}, ${t.status})`);
  const more = todos.length > shown.length ? `, …and ${todos.length - shown.length} more` : '';
  return ` Its ${todos.length} live todo${todos.length === 1 ? ' was' : 's were'} UNASSIGNED (each keeps the lane's last note after the archive marker) and you inherit ${todos.length === 1 ? 'it' : 'them'} — no separate wake was sent: ${shown.join('; ')}${more}. `
    + `Re-dispatch each to a live lane (todo_update assigneeChatId, or start_coding_session with the todo) or close / drop the ones this archive retired; never wake lane ${chatId}.`;
}

/**
 * The archived-target read the arm seams share: ONE findFirst (not findUnique —
 * the seams sit next to other chat reads and must not disturb them). null on a
 * missing chat or ANY error (fail-open: an unreadable chat is never refused).
 */
export async function readArchivedTarget(chatId: string): Promise<{ archived: boolean; userId: string | null; projectId: string | null; title: string | null } | null> {
  if (!chatId) return null;
  try {
    const prisma = await db();
    const row: any = await (prisma as any).crossModelChat.findFirst({
      where: { id: chatId },
      select: { id: true, userId: true, projectId: true, title: true, archivedAt: true, codingState: { select: { status: true } } },
    });
    if (!row) return null;
    return { archived: isArchivedTargetRow(row), userId: row.userId ?? null, projectId: row.projectId ?? null, title: row.title ?? null };
  } catch {
    return null;
  }
}

/** True only when the target is PROVABLY archived (fail-open on any doubt). Honors the kill switch. */
export async function isArchivedScheduleTarget(chatId: string): Promise<boolean> {
  if (archivedTargetRetireDisabled()) return false;
  return (await readArchivedTarget(chatId))?.archived === true;
}

/**
 * The supervisor that inherits an archived lane's work: the project's
 * supervisor lane (project supervision ON, the lane itself not archived),
 * else the owner's Fleet Supervisor. Never the excluded (archived) chat.
 * null when neither exists or on any error.
 *
 * `automatic` (review 2026-10-20): the caller is AUTOMATIC supervision (the
 * archive-time todo_wake), so a project the owner opted out of fleet
 * supervision (`supervised: false` — the watchdog's own opt-out) gets NO
 * Fleet-Supervisor fallback; its own project supervisor (an owner-enabled
 * lane) still inherits. An owner ANSWER is a user action and is never
 * filtered (the schema's supervised contract), so the re-route leaves it
 * unset. An unreadable flag fails open (supervised).
 */
export async function resolveLaneSupervisor(opts: { userId: string; projectId?: string | null; excludeChatId?: string | null; automatic?: boolean }): Promise<{ id: string; tier: 'project' | 'fleet' } | null> {
  if (!opts.userId) return null;
  try {
    const prisma = await db();
    if (opts.projectId) {
      const ps: any = await (prisma as any).crossModelChat.findFirst({
        where: { userId: opts.userId, projectId: opts.projectId, isProjectSupervisor: true, archivedAt: null, project: { projectSupervisorEnabled: true } },
        select: { id: true },
      });
      if (ps?.id && ps.id !== opts.excludeChatId) return { id: String(ps.id), tier: 'project' };
      if (opts.automatic) {
        let supervised: unknown = true;
        try {
          const project: any = await (prisma as any).crossModelProject.findFirst({ where: { id: opts.projectId }, select: { supervised: true } });
          supervised = project?.supervised;
        } catch { supervised = true; /* fail-open: an unreadable flag reads supervised */ }
        if (supervised === false) return null; // unsupervised project — opted out of automatic fleet supervision
      }
    }
    const fs: any = await (prisma as any).crossModelChat.findFirst({
      where: { userId: opts.userId, isSupervisor: true },
      select: { id: true },
    });
    if (fs?.id && fs.id !== opts.excludeChatId) return { id: String(fs.id), tier: 'fleet' };
    return null;
  } catch {
    return null;
  }
}

/** One archive-unassigned todo, as the archiving actor's tool result lists it. */
export type ArchivedLaneTodo = { id: string; title: string; status: string; prevNote?: string | null };

/**
 * (e) Archiving a lane UNASSIGNS its live todos (assigneeChatId null,
 * progressNote = the 'lane archived …' marker + the lane's last note) so the
 * board stops reading them as owned by a chat that will never run, and sends
 * ONE todo_wake per inheriting supervisor (the project's supervisor, else the
 * Fleet Supervisor — never for a project opted out of fleet supervision)
 * naming them. Conditional writes (still assigned to this chat) so a racing
 * re-assignment wins. The supervisor is resolved ONCE per project. When the
 * inheritor IS the archiving actor (a supervisor's own archive_chat turn) no
 * wake is sent — its todos come back as `actorInherited` for the caller's
 * tool result (review 2026-10-20: a wake about its own action cost a second
 * supervisor turn). Never throws; returns what it did.
 */
export async function unassignTodosForArchivedLane(opts: {
  userId: string;
  chatId: string;
  source: 'archive_chat' | 'session_archive';
  /** The chat whose turn is archiving the lane (the archive_chat tool's session) — never woken about its own archive. */
  actorChatId?: string | null;
}): Promise<{ unassigned: number; wokeChatIds: string[]; actorInherited?: ArchivedLaneTodo[] }> {
  const out: { unassigned: number; wokeChatIds: string[]; actorInherited?: ArchivedLaneTodo[] } = { unassigned: 0, wokeChatIds: [] };
  if (!opts.userId || !opts.chatId || archivedTargetRetireDisabled()) return out;
  try {
    const prisma = await db();
    const todos: any[] = (await (prisma as any).projectTodo.findMany({
      where: { userId: opts.userId, assigneeChatId: opts.chatId, status: { in: [...ARCHIVED_LANE_LIVE_TODO_STATUSES] } },
      select: { id: true, title: true, status: true, projectId: true, progressNote: true },
      take: 200,
    })) ?? [];
    if (!todos.length) return out;
    // One conditional write per DISTINCT composed note (todos with no prior
    // note share one); a group that lost its race (0 written) is left out of
    // the wake — another surface re-assigned those todos first.
    const max = progressNoteMax();
    const byNote = new Map<string, any[]>();
    for (const t of todos) {
      const note = composeArchivedLaneProgressNote(opts.chatId, t.progressNote, max);
      if (!byNote.has(note)) byNote.set(note, []);
      byNote.get(note)!.push(t);
    }
    const written: any[] = [];
    for (const [note, rows] of byNote) {
      const write = await (prisma as any).projectTodo.updateMany({
        where: { id: { in: rows.map((t) => t.id) }, assigneeChatId: opts.chatId },
        data: { assigneeChatId: null, progressNote: note },
      });
      const count = Number(write?.count ?? 0);
      out.unassigned += count;
      if (count > 0) written.push(...rows);
    }
    if (out.unassigned === 0) return out;
    const chat: any = await (prisma as any).crossModelChat.findFirst({ where: { id: opts.chatId }, select: { title: true } }).catch(() => null);
    // ONE wake per inheriting supervisor (a lane's todos usually live on one
    // board); the supervisor is resolved once per project, not once per todo.
    const supByProject = new Map<string, { id: string; tier: 'project' | 'fleet' } | null>();
    const byTarget = new Map<string, any[]>();
    const actorRows: any[] = [];
    let optedOut = 0;
    for (const t of written) {
      const key = String(t.projectId ?? '');
      if (!supByProject.has(key)) {
        supByProject.set(key, await resolveLaneSupervisor({ userId: opts.userId, projectId: t.projectId ?? null, excludeChatId: opts.chatId, automatic: true }));
      }
      const sup = supByProject.get(key);
      if (!sup) { optedOut += 1; continue; }
      if (opts.actorChatId && sup.id === opts.actorChatId) { actorRows.push(t); continue; }
      if (!byTarget.has(sup.id)) byTarget.set(sup.id, []);
      byTarget.get(sup.id)!.push(t);
    }
    const lines = (rows: any[]): ArchivedLaneTodo[] => rows.map((r) => ({ id: r.id, title: r.title, status: r.status, prevNote: r.progressNote ?? null }));
    if (actorRows.length) out.actorInherited = lines(actorRows);
    const hooks = byTarget.size ? await import('./hooks.service') : null;
    for (const [targetChatId, rows] of byTarget) {
      const res = await hooks!.enqueueDirectWake({
        targetChatId,
        prompt: orphanedTodosWake({ chatId: opts.chatId, chatTitle: chat?.title ?? null, todos: lines(rows) }),
        meta: { reason: 'archived_lane_todos', archivedChatId: opts.chatId, todoIds: rows.map((r) => r.id) },
      }).catch(() => ({ ok: false }));
      if ((res as any)?.ok) out.wokeChatIds.push(targetChatId);
    }
    await log('info', `archived-target-retire: lane ${opts.chatId.slice(0, 8)} archived (${opts.source}) — unassigned ${out.unassigned} live todo(s), woke ${out.wokeChatIds.length} supervisor(s)${actorRows.length ? `, ${actorRows.length} handed back to the archiving actor` : ''}${optedOut ? `, ${optedOut} with no supervisor to wake` : ''}`);
    await metric(opts.chatId, {
      surface: 'todo', action: 'unassigned', source: opts.source, chatId: opts.chatId,
      todoIds: written.map((t) => t.id).slice(0, 20), wokeChatIds: out.wokeChatIds,
      ...(actorRows.length ? { actorChatId: opts.actorChatId, actorInherited: actorRows.length } : {}),
      ...(optedOut ? { noSupervisor: optedOut } : {}),
    }, out.unassigned);
    return out;
  } catch (err: any) {
    await log('warn', `archived-target-retire: todo unassign for lane ${String(opts.chatId).slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
    return out;
  }
}

/** Telemetry for the seams that live elsewhere (schedule pause / restore, arm refusal, owner-answer re-route). Never throws. */
export function recordArchivedTargetRetire(chatId: string | undefined, meta: Record<string, unknown>, value?: number): void {
  void metric(chatId, meta, value);
}
