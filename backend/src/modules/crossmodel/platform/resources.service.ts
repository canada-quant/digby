/**
 * Watched resources + training artifacts (remediation P7 item S1b).
 *
 * A lane running long external work (a GPU reservation, a training box, a paid
 * sandbox) REGISTERS the resource it is responsible for (watched_resources) and
 * must keep OBSERVING it (observe_resource — machine calls require ≥1 tool
 * receipt this run, so "I checked it" is backed by an actual execution). A
 * resource whose lastObservedAt ages past its maxUnobservedMinutes — or whose
 * reservation ends within 24h — raises ONE owner alarm per resource per 6h
 * (Telegram DM + a Fleet Supervisor thread note; the seam-alarm delivery
 * shape), from the attention-watchdog sweep.
 *
 * Retirement (ticket a0a199f8): releaseWatchedResource deletes the row (the
 * release_watched_resource tool — the box is torn down, the reservation ended,
 * or the row is a stale duplicate), and the sweep NEVER alarms for a resource
 * past its reservationEndsAt (a reservation that already ended would otherwise
 * ghost-alarm every 6h forever — the alarm-trust failure class of 25c5a7c3).
 *
 * Training artifacts (training_artifacts) are the durable outputs
 * (checkpoint/dataset/eval/model) a resource produced; verify_durable stamps
 * durableVerifiedAt (machine calls need receipt evidence naming the uri). The
 * coding doctrine refuses release/teardown of a watched resource until its
 * artifacts verify durable — a PROMPT-level rule (no run_command hard gate:
 * too broad), this table is what makes the rule checkable.
 *
 * Kill-switch for the sweep: WATCHED_RESOURCE_SWEEP_DISABLED=1.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';

// ── Limits (one home so tool descriptions and validation never drift) ─────────

export const RESOURCE_LABEL_MAX = 200;
export const RESOURCE_NOTES_MAX = 2000;
export const ARTIFACT_URI_MAX = 1000;
export const ARTIFACT_SHA_MAX = 128;
export const MAX_UNOBSERVED_MINUTES_MIN = 5;
export const MAX_UNOBSERVED_MINUTES_MAX = 7 * 24 * 60; // a week
export const MAX_UNOBSERVED_MINUTES_DEFAULT = 240; // 4h
export const ARTIFACT_KINDS = ['checkpoint', 'dataset', 'eval', 'model', 'other'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
/** Per-user row caps (runaway guard — a confused lane must not spam tables). */
export const WATCHED_RESOURCES_PER_USER_CAP = 50;
export const TRAINING_ARTIFACTS_PER_USER_CAP = 500;

// ── Views ─────────────────────────────────────────────────────────────────────

export interface WatchedResourceView {
  id: string;
  projectId: string | null;
  label: string;
  usdPerHour: number | null;
  reservationEndsAt: string | null;
  maxUnobservedMinutes: number;
  lastObservedAt: string | null;
  notes: string | null;
  createdAt: string;
}

export interface TrainingArtifactView {
  id: string;
  projectId: string | null;
  kind: string;
  label: string;
  uri: string;
  sha: string | null;
  bytes: number | null;
  durableVerifiedAt: string | null;
  runId: string | null;
  createdAt: string;
}

const iso = (d: Date | null | undefined): string | null => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : null);

function resourceView(r: any): WatchedResourceView {
  return {
    id: r.id, projectId: r.projectId ?? null, label: r.label,
    usdPerHour: r.usdPerHour ?? null,
    reservationEndsAt: iso(r.reservationEndsAt),
    maxUnobservedMinutes: r.maxUnobservedMinutes,
    lastObservedAt: iso(r.lastObservedAt),
    notes: r.notes ?? null,
    createdAt: iso(r.createdAt)!,
  };
}

function artifactView(a: any): TrainingArtifactView {
  return {
    id: a.id, projectId: a.projectId ?? null, kind: a.kind, label: a.label, uri: a.uri,
    sha: a.sha ?? null, bytes: a.bytes ?? null,
    durableVerifiedAt: iso(a.durableVerifiedAt),
    runId: a.runId ?? null,
    createdAt: iso(a.createdAt)!,
  };
}

// ── CRUD (owner-scoped; validation throws plain Error — the tool surface
//    renders any rejection's message, and AppError's env chain is jest-hostile) ─

export async function registerWatchedResource(userId: string, input: {
  label: string;
  projectId?: string | null;
  usdPerHour?: number;
  reservationEndsAt?: string | Date | null;
  maxUnobservedMinutes?: number;
  notes?: string;
}): Promise<WatchedResourceView> {
  const label = String(input.label ?? '').trim().slice(0, RESOURCE_LABEL_MAX);
  if (!label) throw new Error('label is required (what resource is being watched — name it so an alarm reads unambiguously).');
  const count = await prisma.watchedResource.count({ where: { userId } });
  if (count >= WATCHED_RESOURCES_PER_USER_CAP) {
    throw new Error(`Watched-resource cap reached (${count}/${WATCHED_RESOURCES_PER_USER_CAP}) — release stale entries before registering new ones.`);
  }
  const usdPerHour = Number(input.usdPerHour);
  const maxUnobservedRaw = Math.round(Number(input.maxUnobservedMinutes));
  const maxUnobservedMinutes = Number.isFinite(maxUnobservedRaw)
    ? Math.min(MAX_UNOBSERVED_MINUTES_MAX, Math.max(MAX_UNOBSERVED_MINUTES_MIN, maxUnobservedRaw))
    : MAX_UNOBSERVED_MINUTES_DEFAULT;
  let reservationEndsAt: Date | null = null;
  if (input.reservationEndsAt) {
    const d = new Date(input.reservationEndsAt as any);
    if (Number.isNaN(d.getTime())) throw new Error('reservationEndsAt must be an ISO timestamp (or omitted).');
    reservationEndsAt = d;
  }
  const row = await prisma.watchedResource.create({
    data: {
      userId,
      label,
      projectId: String(input.projectId ?? '').trim() || null,
      usdPerHour: Number.isFinite(usdPerHour) && usdPerHour > 0 ? usdPerHour : null,
      reservationEndsAt,
      maxUnobservedMinutes,
      lastObservedAt: new Date(), // registration IS the first observation
      notes: String(input.notes ?? '').trim().slice(0, RESOURCE_NOTES_MAX) || null,
    },
  });
  logger.info(`resources: watched resource ${row.id} registered ("${label}", observe every ≤${maxUnobservedMinutes}m) for user ${userId.slice(0, 8)}`);
  return resourceView(row);
}

/** Exact id → unique ≥8-char id prefix → unique exact label. Throws on ambiguity. */
export async function resolveWatchedResource(userId: string, ref: string): Promise<any | null> {
  const q = String(ref ?? '').trim();
  if (!q) return null;
  const exact = await prisma.watchedResource.findFirst({ where: { id: q, userId } });
  if (exact) return exact;
  if (q.length >= 8) {
    const byPrefix = await prisma.watchedResource.findMany({ where: { userId, id: { startsWith: q } }, take: 3 });
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) throw new Error(`Ambiguous resource id prefix "${q}" — matches ${byPrefix.map((r: any) => r.id).join(', ')}. Pass the full id.`);
  }
  const byLabel = await prisma.watchedResource.findMany({ where: { userId, label: q }, take: 3 });
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`Ambiguous resource label "${q}" — ${byLabel.length} rows carry it. Pass the id.`);
  return null;
}

/**
 * Ticket 251e9329 (mishap, 2026-09-13): the old flat refusal advertised a
 * recovery path that did not exist — "list via get_account_overview" pointed
 * at a tool with NO watched-resources section, so a lane whose
 * schedule-mandated resource id was deleted out-of-band (deletions then had
 * no in-app caller — release_watched_resource, ticket a0a199f8, is it now)
 * could not enumerate the registry, re-issued the same blind call 3× and
 * tripped the derail breaker. The refusal now names what IS registered (ids +
 * labels — the same ids the overview lists) so the caller self-heals in ONE
 * round. Degrades to the plain guidance if the registry read itself fails;
 * never changes the error class. Shared by observeResource (thrown) and the
 * release_watched_resource tool's not_found envelope (verb = 'release').
 */
export async function noWatchedResourceMessage(userId: string, ref: string, verb: 'observe' | 'release' = 'observe'): Promise<string> {
  // Reviewer nit (ticket 251e9329 review): the executor's refuse() slices the
  // message at 400 chars — with SHOW_MAX 4 × LABEL_MAX 40 the worst case was
  // 397, leaving no margin (and a long label-ref truncated the listing).
  // 3 × 32 keeps the worst case ≈314 with a full 36-char uuid ref.
  const SHOW_MAX = 3;
  const LABEL_MAX = 32;
  let rows: Array<{ id: string; label: string }> = [];
  try {
    rows = await prisma.watchedResource.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: SHOW_MAX + 1,
      select: { id: true, label: true },
    });
  } catch {
    return `No watched resource "${ref}" — register_watched_resource first (or list via get_account_overview → watchedResources).`;
  }
  if (!rows.length) {
    return `No watched resource "${ref}" — register_watched_resource first (the registry is EMPTY; get_account_overview → watchedResources confirms).`;
  }
  const shown = rows.slice(0, SHOW_MAX).map((r) => `${String(r.id).slice(0, 8)} "${String(r.label).slice(0, LABEL_MAX)}"`);
  const more = rows.length > SHOW_MAX ? ` (+${rows.length - SHOW_MAX} more)` : '';
  return `No watched resource "${ref}" — register_watched_resource first, or ${verb} one that exists: ${shown.join(', ')}${more} (full list: get_account_overview → watchedResources).`;
}

/** Stamp lastObservedAt = now (the caller enforces the machine-receipt gate). */
export async function observeResource(userId: string, ref: string, note?: string): Promise<WatchedResourceView> {
  const row = await resolveWatchedResource(userId, ref);
  if (!row) throw new Error(await noWatchedResourceMessage(userId, ref));
  const data: any = { lastObservedAt: new Date() };
  const trimmed = String(note ?? '').trim().slice(0, RESOURCE_NOTES_MAX);
  if (trimmed) data.notes = trimmed;
  const updated = await prisma.watchedResource.update({ where: { id: row.id }, data });
  return resourceView(updated);
}

/**
 * Delete a watched resource — the lane released/tore it down, the reservation
 * ended, or the row is a stale duplicate (ticket a0a199f8). Owner-scoped: any
 * of the owner's lanes (or the fleet supervisor) may retire a row. Returns the
 * RELEASED view (null when the ref resolves to nothing); delete failures
 * PROPAGATE so the tool envelope stays honest (a swallowed failure would leave
 * the row alarming while reporting success).
 */
export async function releaseWatchedResource(userId: string, ref: string, reason?: string): Promise<WatchedResourceView | null> {
  const row = await resolveWatchedResource(userId, ref);
  if (!row) return null;
  await prisma.watchedResource.delete({ where: { id: row.id } });
  const why = String(reason ?? '').trim().slice(0, 300);
  logger.info(`resources: watched resource ${row.id} released ("${row.label}"${why ? `, reason: ${why}` : ''}) for user ${userId.slice(0, 8)}`);
  return resourceView(row);
}

export async function registerArtifact(userId: string, input: {
  kind: string;
  label: string;
  uri: string;
  projectId?: string | null;
  sha?: string;
  bytes?: number;
  runId?: string | null;
}): Promise<TrainingArtifactView> {
  const kind = String(input.kind ?? '').trim();
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`kind must be one of: ${ARTIFACT_KINDS.join(' | ')}`);
  }
  const label = String(input.label ?? '').trim().slice(0, RESOURCE_LABEL_MAX);
  const uri = String(input.uri ?? '').trim().slice(0, ARTIFACT_URI_MAX);
  if (!label) throw new Error('label is required.');
  if (!uri) throw new Error('uri is required (where the artifact lives — s3://…, hf://…, an absolute path, a URL).');
  const count = await prisma.trainingArtifact.count({ where: { userId } });
  if (count >= TRAINING_ARTIFACTS_PER_USER_CAP) {
    throw new Error(`Artifact cap reached (${count}/${TRAINING_ARTIFACTS_PER_USER_CAP}).`);
  }
  const bytes = Number(input.bytes);
  const row = await prisma.trainingArtifact.create({
    data: {
      userId,
      kind,
      label,
      uri,
      projectId: String(input.projectId ?? '').trim() || null,
      sha: String(input.sha ?? '').trim().slice(0, ARTIFACT_SHA_MAX) || null,
      bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : null,
      runId: String(input.runId ?? '').trim() || null,
    },
  });
  logger.info(`resources: artifact ${row.id} registered (${kind} "${label}") for user ${userId.slice(0, 8)}`);
  return artifactView(row);
}

/** Exact id → unique ≥8-char id prefix → unique exact uri. Throws on ambiguity. */
export async function resolveArtifact(userId: string, ref: string): Promise<any | null> {
  const q = String(ref ?? '').trim();
  if (!q) return null;
  const exact = await prisma.trainingArtifact.findFirst({ where: { id: q, userId } });
  if (exact) return exact;
  if (q.length >= 8) {
    const byPrefix = await prisma.trainingArtifact.findMany({ where: { userId, id: { startsWith: q } }, take: 3 });
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) throw new Error(`Ambiguous artifact id prefix "${q}" — matches ${byPrefix.map((r: any) => r.id).join(', ')}. Pass the full id.`);
  }
  const byUri = await prisma.trainingArtifact.findMany({ where: { userId, uri: q }, orderBy: { createdAt: 'desc' }, take: 3 });
  if (byUri.length >= 1) return byUri[0]; // uri re-registrations: the newest row is the live one
  return null;
}

/** Stamp durableVerifiedAt = now (the caller enforces the machine-evidence gate). */
export async function verifyArtifactDurable(userId: string, ref: string): Promise<TrainingArtifactView> {
  const row = await resolveArtifact(userId, ref);
  if (!row) throw new Error(`No training artifact "${ref}" — register_artifact first.`);
  const updated = await prisma.trainingArtifact.update({ where: { id: row.id }, data: { durableVerifiedAt: new Date() } });
  return artifactView(updated);
}

// ── The watchdog sweep (S1b) — seam-alarm delivery shape, 6h NX dedupe ────────

export const RESOURCE_ALARM_DEDUPE_SEC = 6 * 3600;
export const RESOURCE_ALARM_KEY = (id: string) => `watched-resource:alarm:${id}`;
export const RESERVATION_WARN_WINDOW_MS = 24 * 3600_000;
const SWEEP_TAKE = 500;

export function watchedResourceSweepDisabled(): boolean {
  const v = String(process.env.WATCHED_RESOURCE_SWEEP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Why a resource alarms this sweep, or null. Pure — exported for tests. */
export function resourceAlarmReason(
  r: { maxUnobservedMinutes: number; lastObservedAt: Date | null; createdAt: Date; reservationEndsAt: Date | null },
  now: Date,
): 'unobserved' | 'reservation_ending' | null {
  // Ticket a0a199f8 (option c): a resource PAST its reservation end alarms NO
  // MORE — the provider window has closed (the box is typically reclaimed), so
  // every further alarm is a ghost that trains the owner to ignore the channel
  // (the alarm-trust failure class of ticket 25c5a7c3). The row stays listed in
  // get_account_overview → watchedResources for a lane/supervisor to retire
  // explicitly with release_watched_resource.
  if (r.reservationEndsAt && new Date(r.reservationEndsAt).getTime() <= now.getTime()) return null;
  const lastSeen = r.lastObservedAt ?? r.createdAt;
  if (now.getTime() - new Date(lastSeen).getTime() > r.maxUnobservedMinutes * 60_000) return 'unobserved';
  if (r.reservationEndsAt && new Date(r.reservationEndsAt).getTime() - now.getTime() < RESERVATION_WARN_WINDOW_MS) return 'reservation_ending';
  return null;
}

/** The alarm text (exported so tests pin it and wording stays greppable). */
export function resourceAlarmText(
  r: WatchedResourceView,
  reason: 'unobserved' | 'reservation_ending',
  now: Date,
): string {
  const lastSeenMs = new Date(r.lastObservedAt ?? r.createdAt).getTime();
  const hoursUnobserved = Math.max(0, Math.round((now.getTime() - lastSeenMs) / 3600_000 * 10) / 10);
  const burn = r.usdPerHour ? ` — burning ~$${r.usdPerHour}/h (≈$${Math.round(hoursUnobserved * r.usdPerHour * 100) / 100} since last observed)` : '';
  const head = reason === 'unobserved'
    ? `⏰ Watched resource "${r.label}" has gone UNOBSERVED for ~${hoursUnobserved}h (its lane promised a check every ${r.maxUnobservedMinutes} min)${burn}.`
    : `⏳ Watched resource "${r.label}"'s reservation ends ${r.reservationEndsAt} (within 24h)${burn}.`;
  return (
    `${head} Someone (the responsible lane, or you) should observe it now — and if it is done, verify its artifacts durable ` +
    `(verify_durable) before releasing it. Resource id ${r.id}${r.notes ? `; notes: ${String(r.notes).slice(0, 200)}` : ''}. ` +
    `Deduped: this resource alarms at most once per 6h.`
  );
}

/**
 * One sweep over all watched resources: alarm each overdue/ending one (once per
 * 6h per resource) via Telegram DM + a supervisor-thread note. Returns the
 * number of alarms EMITTED. NEVER throws (attention-watchdog wiring contract).
 */
export async function sweepWatchedResources(opts?: { now?: Date }): Promise<number> {
  try {
    if (watchedResourceSweepDisabled()) return 0;
    const now = opts?.now ?? new Date();
    const rows = await prisma.watchedResource.findMany({ orderBy: { createdAt: 'asc' }, take: SWEEP_TAKE });
    let emitted = 0;
    for (const r of rows ?? []) {
      try {
        const reason = resourceAlarmReason(r, now);
        if (!reason) continue;
        const claimed = await (redisClient as any).set(RESOURCE_ALARM_KEY(r.id), now.toISOString(), { NX: true, EX: RESOURCE_ALARM_DEDUPE_SEC });
        if (claimed !== 'OK') continue; // already alarmed inside the window
        const text = resourceAlarmText(resourceView(r), reason, now);
        await notifyOwnerOfResource(r.userId, text);
        emitted += 1;
      } catch (err: any) {
        logger.warn(`resources: alarm for ${r?.id} failed (non-fatal): ${err?.message ?? err}`);
      }
    }
    return emitted;
  } catch (err: any) {
    try { logger.warn(`resources: watched-resource sweep failed (non-fatal): ${err?.message ?? err}`); } catch { /* never throws */ }
    return 0;
  }
}

/**
 * Deliver ONE alarm: Telegram DM when linked (the P3 outage push channel) AND a
 * Fleet Supervisor thread note (origin 'attention-watchdog' — survives the
 * machine-noise filter), so the durable trace exists even when the DM landed.
 */
async function notifyOwnerOfResource(userId: string, text: string): Promise<void> {
  let pushed = false;
  try {
    const { isConfigured, sendMessage } = await import('../telegram/telegram.service');
    if (isConfigured()) {
      const link = await prisma.telegramLink.findUnique({ where: { userId } });
      if (link) pushed = !!(await sendMessage(link.chatId, text));
    }
  } catch { /* fall through — the supervisor note below is the durable channel */ }
  try {
    const sup = await prisma.crossModelChat.findFirst({ where: { userId, isSupervisor: true }, select: { id: true } });
    if (sup) {
      await prisma.crossModelMessage.create({
        data: {
          chatId: sup.id,
          role: 'assistant',
          content: `${text}${pushed ? '' : ' (No Telegram link/config — this supervisor note is the only delivery; treat it as urgent.)'}`,
          metadata: { origin: 'attention-watchdog', kind: 'watched-resource' },
        },
      });
    }
  } catch (err: any) {
    logger.warn(`resources: supervisor note failed for user ${String(userId).slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
  }
  logger.info(`resources: watched-resource alarm ${pushed ? 'pushed to Telegram + noted' : 'noted in the supervisor thread only'}`, { userId });
}
