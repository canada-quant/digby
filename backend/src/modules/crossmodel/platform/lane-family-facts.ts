/**
 * lane-family-facts — the reads lane-retire (lane lifecycle C1), the archive
 * cascade (C2) and the ticket drain's own lane retirements (area B) share
 * (review fixer 2026-10-21; second review fixer the same day). A leaf: prisma +
 * the context store only, so platform.service, lane-retire, the ticket drain
 * and the coding dispatch heal can all load it without a cycle and without the
 * heavy session-topology chain.
 *
 * 1. RESTORE MARKER — ['lane-lifecycle','restored'] / <chatId>. archiveChat's
 *    restore leg writes it whenever it brings back a chat that WAS archived:
 *    the owner's Restore, archive_chat archived:false, the session API's
 *    unarchive, a user turn's dispatch heal, a cascade restore — and (second
 *    review fixer) the session API / dispatch-heal DIRECT clears too.
 *    lane-retire, the ticket drain (every lane it retires — third review
 *    2026-10-22: a closed ticket's own lane and the superseded lane at
 *    re-dispatch too), a machine cascade and the run-reaper's rules (e) / (h)
 *    (readRestoredChats) never archive a chat carrying it, nor (lane-retire) a
 *    chat whose descendant carries it. The marker is permanent:
 *    a restored lane is the owner's from then on; the owner archives it by hand.
 *    Written while ANY of its readers is on — nothing is written only when
 *    LANE_IDLE_RETIRE_DISABLED=1, ARCHIVE_CASCADE_DISABLED=1 and
 *    TICKET_LANE_ARCHIVE_GAPS_DISABLED=1 are all set (no reader runs then).
 *    RESTORE AUDIT (second review fixer): the marker only exists for restores
 *    made after it shipped; `readRestoreAuditChats` reads the `chat.restore`
 *    Activity rows archiveChat has always written (in every switch state), so a
 *    restore made before the deploy — or while every reader was off — still
 *    counts. lane-retire reads it for the lanes it is about to archive, and the
 *    ticket drain's house-rule reads include it (third review 2026-10-22). The
 *    read is restricted in SQL to the asked chats (one read per chunk); a full
 *    page keeps only its own chunk.
 * 2. LIVE DESCENDANTS — archiving a chat pauses every hook TARGETING it, the
 *    child_hook a sub-session reports its result through included. A chat whose
 *    unarchived descendant (≤ LANE_FAMILY_DEPTH levels) has a queued / running /
 *    interrupted run, an enabled schedule or a running / provisioning satellite
 *    is never archived by lane-retire nor taken by the cascade: its result would
 *    land in a hidden chat that nothing wakes.
 * 3. INBOUND INTEGRATIONS — an active ChatWebhook on the chat, or an enabled
 *    non-system event hook TARGETING it. Archiving pauses every hook targeting
 *    the chat and a webhook send to an archived chat answers 409 (the payload is
 *    dropped, not queued), so an owner-armed integration is the same kind of
 *    owner arming as an owner-armed schedule.
 * 4. HOUSE RULES (`readLaneKeepReasons`) — the batched per-lane read of every
 *    rule an automatic archive must honour (live run incl. interrupted, live
 *    descendant, restore marker, open todo in ANY project, an open owner
 *    question / pending confirmation, a human message in the window, an active
 *    share link, a pinned title, an inbound integration, the current lane of an
 *    owning ticket, the standing lane). The ticket drain and a machine cascade
 *    read it; lane-retire keeps its own per-leg read (gatherLaneRetireFacts).
 * 5. MACHINE-SPAWN PROOF (`proveMachineSpawned`, p1–p4; moved here from
 *    lane-retire so the cascade can read it without the session-topology chain).
 *
 * Batched. A read that fails (or a level that hits LANE_FAMILY_ROWS_CAP) makes
 * the whole answer null, which every caller reads as BLOCKING. Never throws.
 */

import prisma from '../../../config/database';
import { storeGetMany, storePut } from '../memory/context-store';
import { killSwitchOn } from '../../../utils/kill-switch';

/** Levels below a chat the family read walks (= platform.service ARCHIVE_CASCADE_MAX_DEPTH). */
export const LANE_FAMILY_DEPTH = 3;
/** Rows per level; a level that reaches it answers null (blocking) rather than a truncated "no". */
export const LANE_FAMILY_ROWS_CAP = 2000;
export const LANE_RESTORE_MARKER_NS: readonly string[] = ['lane-lifecycle', 'restored'];
/** How far back the restore audit looks for a `chat.restore` Activity row (= lane-retire's project lookback). */
export const LANE_RESTORE_AUDIT_LOOKBACK_MS = 180 * 86400_000;
/** Activity rows per restore-audit read; a full page answers null (blocking). */
export const LANE_RESTORE_AUDIT_ROWS_CAP = 5000;
/** A human message inside this window keeps a lane (lane-retire rule 12; the machine cascade and the ticket drain use it too). */
export const LANE_HUMAN_WINDOW_MS = 14 * 86400_000;
/** Cap on a human-window user-row read; a full page reads human for every lane in it (fail-safe). */
export const LANE_HUMAN_ROWS_CAP = 5000;
/** First-message origins that prove a machine spawn (p4). Missing / 'user' = human. */
export const MACHINE_FIRST_ORIGINS = ['agent', 'webhook', 'schedule', 'hook', 'machine'] as const;
/** Ticket statuses whose CURRENT lane the ticket dispatcher still owns. */
export const LANE_OWNING_TICKET_STATUSES = ['open', 'in_progress', 'queued', 'reopened', 'awaiting_verification'] as const;
const LIVE_RUN_STATUSES = ['queued', 'running', 'interrupted'];
const LIVE_SATELLITE_STATUSES = ['running', 'provisioning'];
const OPEN_TODO_STATUSES = ['pending', 'in_progress', 'blocked'];
const PROOF_CHUNK = 50;
const AUDIT_CHUNK = 200;
/** Fifth review (2026-10-22): the restore-audit scan starts this long before the oldest asked chat was created (clock slack between writers). */
const RESTORE_AUDIT_CLOCK_SLACK_MS = 86400_000;

/** The wave's one switch parser ('1' | 'true' | 'on' — utils/kill-switch). */
const onFlag = killSwitchOn;
/** The same read as session-topology laneIdleRetireDisabled (kept here so this leaf never imports that chain). */
export function laneRetireSwitchOff(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_IDLE_RETIRE_DISABLED); }
/** ARCHIVE_CASCADE_DISABLED=1 restores the single-chat archive (platform.service re-exports this). */
export function archiveCascadeDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.ARCHIVE_CASCADE_DISABLED); }
/** The ticket drain's own switch (ticket-dispatch laneArchiveGapsDisabled reads it the same way). */
function ticketLaneArchiveGapsOff(env: NodeJS.ProcessEnv): boolean { return onFlag(env.TICKET_LANE_ARCHIVE_GAPS_DISABLED); }
/**
 * Every reader of the restore marker is off — lane-retire, the archive cascade
 * and the ticket drain's gap paths. Only then is a restore left unwritten (all
 * switches set = the pre-wave restore byte-for-byte).
 */
export function laneRestoreMarkerReadersOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return laneRetireSwitchOff(env) && archiveCascadeDisabled(env) && ticketLaneArchiveGapsOff(env);
}

export type LaneRestoreMarker = { at: string; source: string | null; actorChatId: string | null; cascade: boolean };

/** Remember that a chat was brought back from the archive. Never throws. */
export async function rememberLaneRestore(chatId: string, info: { source?: string | null; actorChatId?: string | null; cascade?: boolean }, now: Date = new Date()): Promise<void> {
  if (!chatId || laneRestoreMarkerReadersOff()) return;
  try {
    const marker: LaneRestoreMarker = { at: now.toISOString(), source: info.source ?? null, actorChatId: info.actorChatId ?? null, cascade: info.cascade === true };
    await storePut([...LANE_RESTORE_MARKER_NS], chatId, marker);
  } catch { /* best-effort: a lost marker only means a later pass may archive it again (the restore audit still reads it) */ }
}

async function readOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
const originOf = (metadata: unknown): string => String(asRecord(metadata).origin ?? '').trim();

/**
 * A user row is HUMAN unless its metadata.origin is one of the machine origins
 * (missing / 'user' / a human channel such as 'telegram' or 'owner' all read
 * human — the conservative side: a lane a person typed in is never retired on
 * an origin label this module does not know). Pure.
 */
export function isHumanUserRow(metadata: unknown): boolean {
  return !(MACHINE_FIRST_ORIGINS as readonly string[]).includes(originOf(metadata));
}

/** Same active semantics as sharing.controller getSharedChat / the idle-chat archiver. Pure. */
export function shareLinkIsActive(link: { isActive: boolean; expiresAt: Date | null } | null | undefined, now: Date = new Date()): boolean {
  return !!link && link.isActive && (!link.expiresAt || new Date(link.expiresAt).getTime() > now.getTime());
}

const standingLaneId = (): string => String(process.env.PLATFORM_ENGINEER_CHAT_ID ?? '').trim();

// ── Restore audit ────────────────────────────────────────────────────────────

/**
 * The chats among `ids` whose newest `chat.restore` Activity row (archiveChat's
 * audit, written in every switch state) is newer than their newest
 * `chat.archive` row — a restore the marker may not record (made before the
 * marker shipped, or while every marker reader was off). A restore with no
 * archive row after it counts. Third review (2026-10-22): the read is
 * restricted to the ASKED chats in SQL — one read per chunk of
 * AUDIT_CHUNK chats (both actions, the chunk's chatIds as JSON-path
 * equalities, the last LANE_RESTORE_AUDIT_LOOKBACK_MS) — never every restore
 * the owners ever made filtered in JS, and a chunk whose read fills a page
 * (LANE_RESTORE_AUDIT_ROWS_CAP) reads restored for ITS chats only (fail-safe)
 * instead of blocking the whole pass. null = a read failed (blocking).
 * The query is still a scan of the owners' recent audit rows (activities is
 * indexed on (userId, createdAt) only): an (userId, action, createdAt) index,
 * built CONCURRENTLY by hand, is the follow-up in docs/FRAMEWORK_BACKLOG.md.
 * Fifth review (2026-10-22): the scan starts a day before the chunk's OLDEST
 * chat was created (no audit row predates its chat), so a lane days old reads
 * days of the trail, not 180; callers batch (a machine cascade reads its whole
 * tree once) and share a per-pass memo (`cache`).
 */
export async function readRestoreAuditChats(ids: string[], now: Date = new Date(), cache?: RestoreAuditCache): Promise<Set<string> | null> {
  const asked0 = [...new Set(ids.filter(Boolean))];
  const out = new Set<string>();
  // Fourth review (2026-10-22): a caller-held per-pass cache (the ticket drain
  // reads the audit at four sites per drain) answers the ids it already holds;
  // only the rest are read, and a successful read fills it.
  const want = cache ? asked0.filter((id) => !cache.has(id)) : asked0;
  if (cache) for (const id of asked0) if (cache.get(id) === true) out.add(id);
  if (!want.length) return out;
  const fresh = new Set<string>();
  try {
    const owners: Array<{ id: string; userId: string | null; createdAt?: Date | null }> = await prisma.crossModelChat.findMany({ where: { id: { in: want } }, select: { id: true, userId: true, createdAt: true } });
    const ownerOf = new Map(owners.filter((o) => o.userId).map((o) => [o.id, o.userId as string]));
    const createdOf = new Map(owners.map((o) => [o.id, o.createdAt ? new Date(o.createdAt).getTime() : NaN]));
    const asked = want.filter((id) => ownerOf.has(id));
    if (!asked.length) {
      if (cache) for (const id of want) cache.set(id, false);
      return out;
    }
    const lookbackFloor = now.getTime() - LANE_RESTORE_AUDIT_LOOKBACK_MS;
    for (const chunk of chunks(asked, AUDIT_CHUNK)) {
      const inChunk = new Set(chunk);
      // Fifth review (2026-10-22): no audit row of a chat predates the chat, so the
      // scan starts at the chunk's OLDEST chat (minus a day of clock slack), never
      // further back than the lookback — a lane days old reads days of the
      // owner's trail, not 180 days of it (activities is indexed (userId,
      // createdAt) only; the LL-1 index is still the real fix).
      const created = chunk.map((id) => createdOf.get(id) ?? NaN);
      const oldest = created.every((t) => Number.isFinite(t)) ? Math.min(...created) - RESTORE_AUDIT_CLOCK_SLACK_MS : -Infinity;
      const since = new Date(Math.max(lookbackFloor, oldest));
      const rows = await prisma.activity.findMany({
        where: {
          userId: { in: [...new Set(chunk.map((id) => ownerOf.get(id)!))] },
          resource: 'platform',
          action: { in: ['chat.restore', 'chat.archive'] },
          createdAt: { gte: since },
          OR: chunk.map((id) => ({ metadata: { path: ['chatId'], equals: id } })),
        },
        select: { action: true, metadata: true, createdAt: true },
        take: LANE_RESTORE_AUDIT_ROWS_CAP,
      });
      if (rows.length >= LANE_RESTORE_AUDIT_ROWS_CAP) {
        // A truncated chunk cannot be read safely: its chats read restored (kept), the rest of the pass is not blocked.
        for (const id of chunk) fresh.add(id);
        continue;
      }
      const restoredAt = new Map<string, number>();
      const archivedAt = new Map<string, number>();
      for (const r of rows) {
        const id = String(asRecord(r.metadata).chatId ?? '');
        if (!inChunk.has(id)) continue;
        const t = new Date(r.createdAt).getTime();
        const m = r.action === 'chat.restore' ? restoredAt : r.action === 'chat.archive' ? archivedAt : null;
        if (m && (!m.has(id) || t > m.get(id)!)) m.set(id, t);
      }
      for (const [id, t] of restoredAt) if (!archivedAt.has(id) || t > archivedAt.get(id)!) fresh.add(id);
    }
    for (const id of fresh) out.add(id);
    if (cache) for (const id of want) cache.set(id, fresh.has(id));
    return out;
  } catch {
    return null;
  }
}

/** Fourth review (2026-10-22): a per-pass restore-audit memo (chat id → restored), owned by the caller. */
export type RestoreAuditCache = Map<string, boolean>;

/**
 * Third review (2026-10-22): the chats among `ids` that carry the restore
 * MARKER — for a reader that cannot afford the batched family / audit reads
 * on every pass (the run-reaper's rules (e) / (h), every 5 minutes). Answers an
 * empty set without reading while every marker reader switch is off (no marker
 * is written then — the pre-wave behaviour). null = the read failed (callers
 * keep every chat).
 */
export async function readRestoredChats(ids: string[]): Promise<Set<string> | null> {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length || laneRestoreMarkerReadersOff()) return new Set();
  try {
    const marked = await storeGetMany<LaneRestoreMarker>([...LANE_RESTORE_MARKER_NS], want);
    return new Set(marked.keys());
  } catch {
    return null;
  }
}

// ── Family ───────────────────────────────────────────────────────────────────

export interface LaneFamilyFacts {
  /** the asked ids with a live descendant */
  liveRoots: Set<string>;
  /** the asked ids that carry a restore marker themselves or under a descendant (only when asked for) */
  restoredRoots: Set<string>;
}

/**
 * Family facts per asked chat id. `restored: false` skips the marker read (a
 * liveness-only caller); `restoreAudit: true` also reads the restore audit
 * (readRestoreAuditChats) over the chats and their descendants. null = a read
 * failed or a level was capped.
 */
export async function readLaneFamilyFacts(ids: string[], opts: { restored?: boolean; restoreAudit?: boolean; restoreAuditCache?: RestoreAuditCache; now?: Date } = {}): Promise<LaneFamilyFacts | null> {
  const want = [...new Set(ids.filter(Boolean))];
  const out: LaneFamilyFacts = { liveRoots: new Set(), restoredRoots: new Set() };
  if (!want.length) return out;
  try {
    const rootOf = new Map<string, string>(want.map((id) => [id, id]));
    const descendants: string[] = [];
    let frontier = want;
    for (let depth = 0; depth < LANE_FAMILY_DEPTH && frontier.length; depth++) {
      const kids = await readOrNull(() => prisma.crossModelChat.findMany({
        where: { parentChatId: { in: frontier }, archivedAt: null },
        select: { id: true, parentChatId: true },
        take: LANE_FAMILY_ROWS_CAP,
      }));
      if (!kids || kids.length >= LANE_FAMILY_ROWS_CAP) return null;
      const next: string[] = [];
      for (const k of kids) {
        if (rootOf.has(k.id) || !k.parentChatId) continue; // a cycle / a row seen through two parents
        const root = rootOf.get(k.parentChatId);
        if (!root) continue;
        rootOf.set(k.id, root);
        next.push(k.id);
      }
      descendants.push(...next);
      frontier = next;
    }
    if (descendants.length) {
      const [runs, schedules, satellites] = await Promise.all([
        readOrNull(() => prisma.agentRun.findMany({ where: { sessionId: { in: descendants }, status: { in: LIVE_RUN_STATUSES } }, select: { sessionId: true } })),
        readOrNull(() => prisma.chatSchedule.findMany({ where: { sessionId: { in: descendants }, enabled: true }, select: { sessionId: true } })),
        readOrNull(() => (prisma as any).chatCodingState.findMany({ where: { id: { in: descendants }, status: { in: LIVE_SATELLITE_STATUSES } }, select: { id: true } }) as Promise<Array<{ id: string }>>),
      ]);
      if (!runs || !schedules || !satellites) return null;
      const live = [...runs.map((r) => String(r.sessionId)), ...schedules.map((s) => String(s.sessionId)), ...satellites.map((s) => String(s.id))];
      for (const id of live) { const root = rootOf.get(id); if (root) out.liveRoots.add(root); }
    }
    if (opts.restored !== false) {
      const marked = await readOrNull(() => storeGetMany<LaneRestoreMarker>([...LANE_RESTORE_MARKER_NS], [...want, ...descendants]));
      if (!marked) return null;
      for (const id of marked.keys()) { const root = rootOf.get(id); if (root) out.restoredRoots.add(root); }
      if (opts.restoreAudit) {
        const audited = await readRestoreAuditChats([...want, ...descendants].filter((id) => !marked.has(id)), opts.now ?? new Date(), opts.restoreAuditCache);
        if (!audited) return null;
        for (const id of audited) { const root = rootOf.get(id); if (root) out.restoredRoots.add(root); }
      }
    }
    return out;
  } catch {
    return null;
  }
}

// ── Inbound integrations ─────────────────────────────────────────────────────

/** A hook a SYSTEM path wired (child-result wakes, direct wakes, the Fleet wiring) — never an owner arming. */
const isSystemHook = (createdVia: unknown): boolean => String(createdVia ?? '').startsWith('system:');

/**
 * The chats among `ids` with an inbound integration the owner (or a session on
 * their behalf) armed: an ACTIVE ChatWebhook, or an ENABLED event hook
 * targeting the chat that is not a system hook (createdVia 'system:*').
 * A legacy hook with no createdVia counts (the conservative side). null = a
 * read failed (blocking).
 */
export async function readInboundIntegrations(ids: string[]): Promise<Set<string> | null> {
  const want = [...new Set(ids.filter(Boolean))];
  const out = new Set<string>();
  if (!want.length) return out;
  try {
    const [webhooks, hooks] = await Promise.all([
      prisma.chatWebhook.findMany({ where: { chatId: { in: want }, isActive: true }, select: { chatId: true } }),
      prisma.eventHook.findMany({ where: { targetChatId: { in: want }, enabled: true }, select: { targetChatId: true, createdVia: true } }),
    ]);
    for (const w of webhooks) out.add(String(w.chatId));
    for (const h of hooks) if (!isSystemHook(h.createdVia)) out.add(String(h.targetChatId));
    return out;
  } catch {
    return null;
  }
}

// ── Machine-spawn proof (p1–p4) ──────────────────────────────────────────────

export type MachineSpawnProof =
  | 'p1:ticket'
  | 'p1:session_machine'
  | 'p2:dispatched_to'
  | 'p2:previous_lane'
  | 'p3:supervisor_parent'
  | `p4:${(typeof MACHINE_FIRST_ORIGINS)[number]}`;

/** A read that fails answers null. A thunk also catches a synchronous throw (a client missing the model). */
async function leg<T>(p: Promise<T> | (() => Promise<T>)): Promise<T | null> {
  try { return await (typeof p === 'function' ? p() : p); } catch { return null; }
}

/**
 * Machine-spawn proof per chat id (batched). A chat absent from the map has no
 * proof. Precedence p1 > p2 > p3 > p4. A failed read leaves its proofs out
 * (fail-safe: no proof ⇒ never archived). Never throws.
 *   p1 a delegation_tasks row with childChatId = the chat and kind 'ticket', or
 *      kind 'session' with origin 'machine';
 *   p2 a ticket names it: context.dispatchedTo = the chat, or context.previousLanes
 *      contains it;
 *   p3 its parentChatId is a Fleet / Project Supervisor chat;
 *   p4 its FIRST user message carries metadata.origin agent | webhook | schedule |
 *      hook | machine (missing / 'user' = human). Second review fixer: a 'webhook'
 *      first message is NOT proof when the chat carries a ChatWebhook row (any
 *      state) — the owner armed that webhook, so the chat is the owner's
 *      integration, not a machine spawn (a failed webhook read drops the proof).
 * The display-parent backfill (scripts/framework-audit/backfill-display-parent.js)
 * uses the same rules — keep them identical.
 */
export async function proveMachineSpawned(ids: string[]): Promise<Map<string, MachineSpawnProof>> {
  const out = new Map<string, MachineSpawnProof>();
  const want = [...new Set(ids.filter(Boolean))];
  const set = (id: string, p: MachineSpawnProof) => { if (!out.has(id)) out.set(id, p); };
  for (const chunk of chunks(want, PROOF_CHUNK)) {
    const inChunk = new Set(chunk);
    // p1 — the delegation ledger.
    const tasks = await leg(prisma.delegationTask.findMany({
      where: { childChatId: { in: chunk }, OR: [{ kind: 'ticket' }, { kind: 'session', origin: 'machine' }] },
      select: { childChatId: true, kind: true },
    }));
    for (const t of tasks ?? []) {
      if (t.childChatId && inChunk.has(t.childChatId)) set(t.childChatId, t.kind === 'ticket' ? 'p1:ticket' : 'p1:session_machine');
    }
    // p2 — a ticket's current lane or one of its previous lanes.
    let todo = chunk.filter((id) => !out.has(id));
    if (todo.length) {
      const tickets = await leg(prisma.userFeatureRequest.findMany({
        where: { OR: todo.flatMap((id) => [{ context: { path: ['dispatchedTo'], equals: id } }, { context: { path: ['previousLanes'], array_contains: [id] } }]) },
        select: { context: true },
      }));
      for (const r of tickets ?? []) {
        const ctx = asRecord(r.context);
        const to = typeof ctx.dispatchedTo === 'string' ? ctx.dispatchedTo : '';
        if (to && inChunk.has(to)) set(to, 'p2:dispatched_to');
        if (Array.isArray(ctx.previousLanes)) for (const p of ctx.previousLanes) { const s = String(p); if (inChunk.has(s)) set(s, 'p2:previous_lane'); }
      }
    }
    // p3 — spawned by a supervisor (parentChatId → a Fleet / Project Supervisor chat).
    todo = chunk.filter((id) => !out.has(id));
    if (todo.length) {
      const rows = await leg(prisma.crossModelChat.findMany({ where: { id: { in: todo } }, select: { id: true, parentChatId: true } }));
      const parentIds = [...new Set((rows ?? []).map((r) => r.parentChatId).filter((p): p is string => !!p))];
      const parents = parentIds.length ? await leg(prisma.crossModelChat.findMany({ where: { id: { in: parentIds } }, select: { id: true, isSupervisor: true, isProjectSupervisor: true } })) : [];
      const supervisorIds = new Set((parents ?? []).filter((p) => p.isSupervisor || p.isProjectSupervisor).map((p) => p.id));
      for (const r of rows ?? []) if (r.parentChatId && supervisorIds.has(r.parentChatId)) set(r.id, 'p3:supervisor_parent');
    }
    // p4 — the FIRST user message's origin.
    todo = chunk.filter((id) => !out.has(id));
    const firsts = await Promise.all(todo.map((id) => leg(prisma.crossModelMessage.findFirst({
      where: { chatId: id, role: 'user' }, orderBy: { createdAt: 'asc' }, select: { metadata: true },
    })).then((m) => ({ id, o: m ? originOf(m.metadata) : '' }))));
    const viaWebhook = firsts.filter((f) => f.o === 'webhook').map((f) => f.id);
    // An owner-armed ChatWebhook on the chat: its first webhook message is the owner's integration.
    const ownerWebhook = viaWebhook.length
      ? await leg(prisma.chatWebhook.findMany({ where: { chatId: { in: viaWebhook } }, select: { chatId: true } }))
      : [];
    const ownerWebhookSet = ownerWebhook ? new Set(ownerWebhook.map((w) => String(w.chatId))) : null;
    for (const { id, o } of firsts) {
      if (!(MACHINE_FIRST_ORIGINS as readonly string[]).includes(o)) continue;
      if (o === 'webhook' && (!ownerWebhookSet || ownerWebhookSet.has(id))) continue;
      set(id, `p4:${o}` as MachineSpawnProof);
    }
  }
  return out;
}

// ── House rules (the ticket drain + the machine cascade) ─────────────────────

/** A rule that keeps a lane out of an automatic archive, in the order reasons are reported. */
export type LaneKeepReason =
  | 'live_run' | 'live_child' | 'owner_restored' | 'open_todos' | 'awaiting_owner' | 'human_recent'
  | 'share_link' | 'title_pinned' | 'inbound_integration' | 'ticket_owned' | 'standing_lane';
export const LANE_KEEP_REASONS: readonly LaneKeepReason[] = [
  'live_run', 'live_child', 'owner_restored', 'open_todos', 'awaiting_owner', 'human_recent',
  'share_link', 'title_pinned', 'inbound_integration', 'ticket_owned', 'standing_lane',
];

export type LaneKeepReasonOpts = { legs?: readonly LaneKeepReason[]; humanWindowMs?: number; restoreAudit?: boolean; restoreAuditCache?: RestoreAuditCache; now?: Date };

/**
 * The first house rule that keeps each lane (absent = none does), over ONE
 * batched read per rule. `legs` narrows the rules read (default: all);
 * `humanWindowMs` is the human-message window (default LANE_HUMAN_WINDOW_MS).
 * The restore leg reads the marker (and, with `restoreAudit`, the restore
 * audit; `restoreAuditCache` memoises that audit across one caller's pass).
 * null = any read failed or was capped — every caller reads that as BLOCKING
 * for every lane. Never throws.
 */
export async function readLaneKeepReasons(ids: string[], opts: LaneKeepReasonOpts = {}): Promise<Map<string, LaneKeepReason> | null> {
  const all = await readAllLaneKeepReasons(ids, opts);
  if (!all) return null;
  return new Map([...all].map(([id, reasons]) => [id, reasons[0]]));
}

/**
 * Fourth review (2026-10-22): EVERY house rule that keeps each lane, in
 * LANE_KEEP_REASONS order (absent = none does) — for a caller that must know a
 * rule independently of the first match (the ticket drain never pauses a lane
 * the owner RESTORED, whatever rule is reported first: a restored lane with a
 * live descendant reads 'live_child' first). Same reads and null contract as
 * readLaneKeepReasons. Never throws.
 */
export async function readAllLaneKeepReasons(ids: string[], opts: LaneKeepReasonOpts = {}): Promise<Map<string, LaneKeepReason[]> | null> {
  const want = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, LaneKeepReason[]>();
  if (!want.length) return out;
  const now = opts.now ?? new Date();
  const legs = new Set<LaneKeepReason>(opts.legs ?? LANE_KEEP_REASONS);
  const has = (l: LaneKeepReason) => legs.has(l);
  const skip = <T>(v: T) => Promise.resolve(v);
  try {
    const [liveRuns, family, todos, questions, confirmations, userRows, shares, pinned, inbound, owning] = await Promise.all([
      has('live_run') ? prisma.agentRun.findMany({ where: { sessionId: { in: want }, status: { in: LIVE_RUN_STATUSES } }, select: { sessionId: true, status: true } }) : skip([]),
      has('live_child') || has('owner_restored')
        ? readLaneFamilyFacts(want, { restored: has('owner_restored'), restoreAudit: opts.restoreAudit === true, restoreAuditCache: opts.restoreAuditCache, now })
        : skip({ liveRoots: new Set<string>(), restoredRoots: new Set<string>() } as LaneFamilyFacts),
      has('open_todos') ? prisma.projectTodo.findMany({ where: { assigneeChatId: { in: want }, status: { in: OPEN_TODO_STATUSES } }, select: { assigneeChatId: true } }) : skip([]),
      has('awaiting_owner') ? prisma.ownerQuestion.findMany({ where: { chatId: { in: want }, status: 'open' }, select: { chatId: true } }) : skip([]),
      has('awaiting_owner') ? prisma.pendingConfirmation.findMany({ where: { chatId: { in: want }, status: 'pending', expiresAt: { gt: now } }, select: { chatId: true } }) : skip([]),
      has('human_recent')
        ? prisma.crossModelMessage.findMany({ where: { chatId: { in: want }, role: 'user', createdAt: { gte: new Date(now.getTime() - (opts.humanWindowMs ?? LANE_HUMAN_WINDOW_MS)) } }, select: { chatId: true, metadata: true }, take: LANE_HUMAN_ROWS_CAP })
        : skip([]),
      has('share_link') ? prisma.chatShareLink.findMany({ where: { chatId: { in: want } }, select: { chatId: true, isActive: true, expiresAt: true } }) : skip([]),
      has('title_pinned') ? prisma.crossModelChat.findMany({ where: { id: { in: want } }, select: { id: true, titlePinned: true } }) : skip([]),
      has('inbound_integration') ? readInboundIntegrations(want) : skip(new Set<string>()),
      has('ticket_owned')
        ? prisma.userFeatureRequest.findMany({
          where: { status: { in: [...LANE_OWNING_TICKET_STATUSES] }, OR: want.map((id) => ({ context: { path: ['dispatchedTo'], equals: id } })) },
          select: { context: true },
        })
        : skip([]),
    ]);
    if (!family || !inbound) return null;
    const humanCapped = (userRows as any[]).length >= LANE_HUMAN_ROWS_CAP;
    const sets: Record<LaneKeepReason, Set<string>> = {
      live_run: new Set((liveRuns as any[]).filter((r) => LIVE_RUN_STATUSES.includes(String(r.status ?? ''))).map((r) => String(r.sessionId))),
      live_child: has('live_child') ? family.liveRoots : new Set(),
      owner_restored: has('owner_restored') ? family.restoredRoots : new Set(),
      open_todos: new Set((todos as any[]).map((t) => String(t.assigneeChatId ?? '')).filter(Boolean)),
      awaiting_owner: new Set([...(questions as any[]), ...(confirmations as any[])].map((r) => String(r.chatId ?? '')).filter(Boolean)),
      human_recent: humanCapped ? new Set(want) : new Set((userRows as any[]).filter((r) => isHumanUserRow(r.metadata)).map((r) => String(r.chatId))),
      share_link: new Set((shares as any[]).filter((s) => shareLinkIsActive(s, now)).map((s) => String(s.chatId))),
      title_pinned: new Set((pinned as any[]).filter((c) => c.titlePinned === true).map((c) => String(c.id))),
      inbound_integration: inbound,
      ticket_owned: new Set((owning as any[]).map((r) => String(asRecord(r.context).dispatchedTo ?? '')).filter(Boolean)),
      standing_lane: has('standing_lane') && standingLaneId() ? new Set([standingLaneId()]) : new Set(),
    };
    for (const id of want) {
      const reasons = LANE_KEEP_REASONS.filter((reason) => has(reason) && sets[reason].has(id));
      if (reasons.length) out.set(id, reasons);
    }
    return out;
  } catch {
    return null;
  }
}
