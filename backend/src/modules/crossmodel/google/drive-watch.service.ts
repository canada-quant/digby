/**
 * DriveWatch service — first-class Google Drive folder watch (2026-09-29,
 * owner-confirmed cf_822011a4).
 *
 * A lane registers a folder once (subscribe_drive_watch); the platform then
 * detects changes SERVER-SIDE via Google push notifications (changes.watch)
 * with ZERO model spend while nothing changed. On a real edit the webhook
 * receiver (mounted on the open router, see drive-watch.routes.ts) runs the
 * incremental pull — no model in the loop — and only if deduped changes are
 * non-empty wakes the target lane with the changed doc names. Same shape as
 * event hooks, not an LLM polling loop.
 *
 * Lifecycle:
 *   subscribe → changes.getStartPageToken → changes.watch (channel ~1 week)
 *   sync ping → 200 ACK, no fire
 *   change    → verify channelId+resourceId → changes.list delta → folder
 *               filter → (fileId, modifiedTime) dedupe → wake → persist token
 *   renewal   → daily tick (worker.ts): re-watch channels expiring <24h (or
 *               channel-less rows), plus one reconciliation pull per row as a
 *               fallback for missed pings.
 *
 * Folder scope: DIRECT children of the watched folder (the changes feed is
 * account-wide and carries each file's `parents`, which we request in the
 * `fields` mask — no per-file lookups needed). Sub-tree watching is v2.
 *
 * All Drive v3 calls are DIRECT axios (token-manager/google-mcp precedent) —
 * google-mcp's tool surface has no watch tool, so it is never round-tripped.
 */

import axios, { type AxiosResponse } from 'axios';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { getValidToken } from './token-manager';
import { enqueueDirectWake } from '../platform/hooks.service';

// ── Constants ────────────────────────────────────────────────────────────────

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** Renew channels expiring within this window (daily tick cadence). */
export const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Cap on the persisted dedupe window (last fired (fileId, modifiedTime) keys). */
export const MAX_FIRED_CHANGES = 200;

/** Cap on docs named in one wake prompt (prose stays readable). */
export const MAX_PROMPT_DOCS = 15;

/** Changes pulled per changes.list page. */
const CHANGES_PAGE_SIZE = 100;

/** Hard cap on pages per pull (10 × 100 = 1000 changes — far past any folder). */
const MAX_PAGES_PER_PULL = 10;

/** Never fire twice within this window even when pings arrive in a burst. */
export const MIN_FIRE_INTERVAL_MS = 30 * 1000;

/** resourceId sentinel for a row whose changes.watch failed at subscribe. */
const NO_CHANNEL = '';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DriveChange {
  fileId: string;
  name: string;
  modifiedTime: string;
}

interface DriveChangesResponse {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: Array<{
    fileId?: string;
    removed?: boolean;
    file?: {
      id?: string;
      name?: string;
      modifiedTime?: string;
      trashed?: boolean;
      parents?: string[];
    };
  }>;
}

export interface SubscribeDriveWatchInput {
  userId: string;
  /** Google account label (multi-account routing, token-manager convention). */
  label?: string | null;
  folderId: string;
  targetChatId: string;
  promptTemplate?: string | null;
}

export interface DriveWatchView {
  id: string;
  label: string | null;
  folderId: string;
  targetChatId: string;
  promptTemplate: string;
  expiration: string | null;
  channelActive: boolean;
  lastFiredAt: string | null;
  createdAt: string;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * The (fileId, modifiedTime) dedupe key — two changes are the SAME edit when
 * both match. Any edit or rename bumps modifiedTime, so a doc edited twice
 * between fires still fires once, with its newest state.
 */
export function changeKey(c: DriveChange): string {
  return `${c.fileId}:${c.modifiedTime}`;
}

/** Parse the persisted dedupe window; a corrupt row degrades to empty. */
export function parseFiredChanges(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string' && k.includes(':'));
}

/** Build the next dedupe window: newest (fresh) keys first, capped. */
export function nextFiredWindow(fresh: DriveChange[], previousKeys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of fresh) {
    const k = changeKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  for (const k of previousKeys) {
    if (out.length >= MAX_FIRED_CHANGES) break;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out.slice(0, MAX_FIRED_CHANGES);
}

/**
 * Dedupe a fresh pull against the last-fired window: returns the changes that
 * are NEW (same fileId never fired at this modifiedTime) — the fire set.
 */
export function dedupeAgainstFired(
  fresh: DriveChange[],
  lastFiredKeys: string[],
): DriveChange[] {
  const lastSet = new Set(lastFiredKeys);
  return fresh.filter((c) => !lastSet.has(changeKey(c)));
}

/**
 * Keep only changes for DIRECT children of the watched folder. The changes
 * feed is account-wide; each entry's file resource carries `parents`, so a
 * change is in-scope iff folderId ∈ parents. Removed entries without a file
 * resource cannot prove membership — skip them (Drive trashes first, and the
 * trash event carries parents, so in-folder deletions still surface).
 */
export function filterChangesForFolder(
  changes: DriveChange[],
  parentsByFileId: Map<string, string[]>,
  folderId: string,
): DriveChange[] {
  return changes.filter((c) => (parentsByFileId.get(c.fileId) ?? []).includes(folderId));
}

/** Build the wake prompt — the changed doc names ARE the payload. */
export function buildWakePrompt(
  watch: { label: string | null; folderId: string; promptTemplate: string },
  changes: DriveChange[],
): string {
  const shown = changes.slice(0, MAX_PROMPT_DOCS);
  const docLines = shown.map((c) => `- ${c.name} (edited ${c.modifiedTime})`);
  const extra = changes.length > MAX_PROMPT_DOCS ? `\n… and ${changes.length - MAX_PROMPT_DOCS} more` : '';
  const docList = `${docLines.join('\n')}${extra}`;
  const labelSuffix = watch.label ? ` on Google account "${watch.label}"` : '';
  if (watch.promptTemplate) {
    return watch.promptTemplate
      .replaceAll('{{docs}}', docList)
      .replaceAll('{{docNames}}', shown.map((c) => c.name).join(', '))
      .replaceAll('{{folderId}}', watch.folderId);
  }
  return [
    `[DRIVE WATCH] A watched Google Drive folder changed${labelSuffix} (folder ${watch.folderId}):`,
    docList,
    '',
    'Docs listed above were created or edited in the watched folder. Read them as this watch\'s instructions direct.',
  ].join('\n');
}

/**
 * Renewal expiry math (exported for tests): should a channel expiring at
 * `expiration` be re-created by a tick running at `now`? True when it expires
 * within RENEWAL_WINDOW_MS; a channel expired long ago (> 7d) belongs to a
 * dead row and is still renewed (stop+re-create) — returns false only for
 * invalid dates, which the caller leaves alone.
 */
export function shouldRenew(expiration: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!expiration) return true; // no channel bound (subscribe-time failure) → try again
  const exp = typeof expiration === 'string' ? new Date(expiration) : expiration;
  if (Number.isNaN(exp.getTime())) return false;
  return exp.getTime() - now.getTime() <= RENEWAL_WINDOW_MS;
}

// ── Channel lifecycle ────────────────────────────────────────────────────────

/** The public push URL handed to Google (share-link host convention). */
export function driveWatchWebhookUrl(): string {
  const host = (process.env.FRONTEND_URL ?? 'https://digby.ai').split(',')[0].replace(/\/$/, '');
  return `${host}/api/crossmodel/google/drive-watch/webhook`;
}

/**
 * Create a watch: seed the page token (changes.getStartPageToken — so the
 * first fire reports only FUTURE changes), then open the push channel. If the
 * channel open fails the row is still created with the NO_CHANNEL sentinel —
 * the daily tick re-tries the channel and its reconciliation pull keeps the
 * folder covered at ≤1 day latency, so a Google blip at subscribe time never
 * kills a tutor's watch.
 */
export async function createDriveWatch(input: SubscribeDriveWatchInput): Promise<DriveWatchView> {
  const token = await getValidToken(input.userId, input.label ?? undefined);
  if (!token) {
    throw new Error(
      `No Google account connected${input.label ? ` for label "${input.label}"` : ''} — connect one in Account → Integrations first.`,
    );
  }

  // Same-owner gate (PR #1157 review, 2026-09-29): the watch wakes targetChatId
  // with input-controlled promptTemplate, so the target must be one of the
  // SUBSCRIBER'S chats — the hook_subscribe ownership rule, enforced in the
  // service layer so every future caller inherits it.
  const targetChat = await prisma.crossModelChat.findUnique({
    where: { id: input.targetChatId },
    select: { userId: true },
  });
  if (!targetChat || targetChat.userId !== input.userId) {
    throw new Error(
      'subscribe_drive_watch requires targetChatId to be one of YOUR chats (same owner) — got a chat id owned by another user or unknown.',
    );
  }

  const seedToken = await fetchStartPageToken(token);

  // Idempotent re-subscribe (FO firing 53, 2026-09-30): the (userId, folderId,
  // targetChatId) triple is unique in schema — a repeat subscribe used to
  // surface a raw Prisma P2002 to the tool caller (observed 07:28Z). hook_subscribe's
  // PAIR-DEDUP convention instead: an existing triple is UPDATED in place — stop
  // its old channel (if bound), open a fresh one, refresh token + template.
  const existing = await prisma.driveWatch.findUnique({
    where: { userId_folderId_targetChatId: { userId: input.userId, folderId: input.folderId, targetChatId: input.targetChatId } },
  });
  if (existing) {
    if (existing.resourceId !== NO_CHANNEL) {
      try {
        await stopChannel(existing.userId, existing.label, existing.channelId, existing.resourceId);
      } catch (err: any) {
        logger.warn(`drive-watch: channels.stop failed on re-subscribe (replacing anyway): ${err?.message ?? err}`, {
          source: 'drive-watch',
          watchId: existing.id,
        });
      }
    }
    const channelId = `dg-dw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const channel = await openChannel(token, channelId);
    const row = await prisma.driveWatch.update({
      where: { id: existing.id },
      data: {
        label: input.label ?? 'Personal',
        channelId,
        resourceId: channel?.resourceId ?? NO_CHANNEL,
        token: seedToken,
        expiration: channel?.expiration ?? null,
        promptTemplate: input.promptTemplate ?? '',
      },
    });
    if (!channel) {
      logger.warn(
        `drive-watch: channel open failed on re-subscribe (folder ${input.folderId}) — row ${row.id} kept; daily tick re-tries, reconciliation pull covers changes`,
        { source: 'drive-watch', watchId: row.id },
      );
    }
    return toView(row);
  }

  const channelId = `dg-dw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = await openChannel(token, channelId);

  const row = await prisma.driveWatch.create({
    data: {
      userId: input.userId,
      label: input.label ?? 'Personal',
      folderId: input.folderId,
      channelId,
      resourceId: channel?.resourceId ?? NO_CHANNEL,
      token: seedToken,
      expiration: channel?.expiration ?? null,
      targetChatId: input.targetChatId,
      promptTemplate: input.promptTemplate ?? '',
    },
  });
  if (!channel) {
    logger.warn(
      `drive-watch: channel open failed at subscribe (folder ${input.folderId}) — row ${row.id} kept; daily tick re-tries, reconciliation pull covers changes`,
      { source: 'drive-watch', watchId: row.id },
    );
  }
  return toView(row);
}

/** Stop a channel at Google and delete the row. Unknown id → false. */
export async function removeDriveWatch(userId: string, watchId: string): Promise<boolean> {
  const row = await prisma.driveWatch.findFirst({ where: { id: watchId, userId } });
  if (!row) return false;
  if (row.resourceId !== NO_CHANNEL) {
    try {
      await stopChannel(row.userId, row.label, row.channelId, row.resourceId);
    } catch (err: any) {
      logger.warn(`drive-watch: channels.stop failed (row deleted anyway): ${err?.message ?? err}`, {
        source: 'drive-watch',
        watchId: row.id,
      });
    }
  }
  await prisma.driveWatch.delete({ where: { id: row.id } });
  return true;
}

/** List a user's watches (for the tools' unsubscribe-by-folder UX). */
export async function listDriveWatches(userId: string): Promise<DriveWatchView[]> {
  const rows = await prisma.driveWatch.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toView);
}

async function openChannel(
  accessToken: string,
  channelId: string,
): Promise<{ resourceId: string; expiration: Date } | null> {
  try {
    const res = await axios.post(
      `${DRIVE_API}/changes/watch`,
      { id: channelId, type: 'web_hook', address: driveWatchWebhookUrl() },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { supportsAllDrives: true, includeItemsFromAllDrives: true },
        timeout: 15000,
      },
    );
    const resourceId = typeof res.data?.resourceId === 'string' ? res.data.resourceId : '';
    if (!resourceId) return null;
    const expMs = Number(res.data?.expiration);
    const expiration = !Number.isNaN(expMs) && expMs > 0 ? new Date(expMs) : new Date(Date.now() + 6 * 24 * 3600 * 1000);
    return { resourceId, expiration };
  } catch (err: any) {
    logger.warn(
      `drive-watch: changes.watch failed: ${err?.response?.status ?? ''} ${err?.message ?? err}`,
      { source: 'drive-watch', channelId },
    );
    return null;
  }
}

async function stopChannel(
  userId: string,
  label: string | null,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const token = await getValidToken(userId, label ?? undefined);
  if (!token) return; // no token → the channel dies at expiry (~1 week) anyway
  await axios.post(
    `${DRIVE_API}/channels/stop`,
    { id: channelId, resourceId },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 },
  );
}

async function fetchStartPageToken(accessToken: string): Promise<string | null> {
  try {
    const res = await axios.get<{ startPageToken?: string }>(`${DRIVE_API}/changes/startPageToken`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { supportsAllDrives: true },
      timeout: 15000,
    });
    return res.data?.startPageToken ?? null;
  } catch (err: any) {
    logger.warn(`drive-watch: startPageToken failed: ${err?.response?.status ?? ''} ${err?.message ?? err}`, {
      source: 'drive-watch',
    });
    return null;
  }
}

// ── Webhook receiver path (no model in the loop) ─────────────────────────────

/**
 * Handle a Google push. Google identifies the channel via the
 * `X-Goog-Channel-ID` / `X-Goog-Resource-ID` headers and signals the ping
 * class via `X-Goog-Resource-State`:
 *   - 'sync'    — the immediate post-watch ping → ACK 200, never fire
 *   - 'exists'  — a change in the watched resource → pull + maybe fire
 *   - 'not_exists' — the resource (channel) is gone → ACK, renewal re-creates
 *
 * SECURITY (unauthenticated-but-safe): the route carries no user JWT, so the
 * ONLY thing that may fire a row is a push whose channelId AND resourceId
 * both match the stored row — resourceId is a Google-minted opaque string
 * delivered only in the changes.watch response, never logged, never exposed
 * by any API. Rows still bound to the NO_CHANNEL sentinel (channel never
 * opened) 403 every push — nothing legitimate is listening for them.
 */
export async function handleDrivePush(
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; fired: boolean }> {
  const channelId = headerValue(headers['x-goog-channel-id']);
  const resourceId = headerValue(headers['x-goog-resource-id']);
  const resourceState = headerValue(headers['x-goog-resource-state']);
  if (!channelId || !resourceId || !resourceState) {
    return { status: 400, fired: false }; // not a Google push — reject without detail
  }

  const row = await prisma.driveWatch.findFirst({ where: { channelId } });
  if (!row) return { status: 404, fired: false }; // unknown channel — 404 stops Google's retries

  if (row.resourceId === NO_CHANNEL) return { status: 403, fired: false }; // channel never bound
  if (row.resourceId !== resourceId) return { status: 403, fired: false }; // not our channel

  if (resourceState === 'sync') return { status: 200, fired: false };

  if (resourceState === 'not_exists') {
    // Channel gone (expired/revoked) — ACK so Google stops retrying; the
    // daily tick re-creates it. No pull: the channel, not the folder, died.
    logger.info(`drive-watch: channel for watch ${row.id} reported not_exists — renewal tick will re-create`);
    return { status: 200, fired: false };
  }

  if (row.expiration && row.expiration.getTime() < Date.now()) {
    // Straggler after expiry — ACK; renewal re-creates the channel.
    return { status: 200, fired: false };
  }

  const fired = await pullAndMaybeFire(row.id);
  return { status: 200, fired };
}

// ── Incremental pull + fire ──────────────────────────────────────────────────

/**
 * The no-model change pull: changes.list with the STORED pageToken, page
 * through, keep direct children of the watched folder, dedupe by
 * (fileId, modifiedTime) against the last-fired window. Only when the deduped
 * set is non-empty (and the rate cap allows) wake the target lane with the
 * changed doc names — and persist token + window only AFTER a successful
 * enqueue, so a failed wake retries the same docs on the next ping instead of
 * losing them (at-least-once with dedupe; a rare duplicate is benign, a lost
 * doc is not).
 */
export async function pullAndMaybeFire(watchId: string): Promise<boolean> {
  const row = await prisma.driveWatch.findUnique({ where: { id: watchId } });
  if (!row) return false;

  const token = await getValidToken(row.userId, row.label ?? undefined);
  if (!token) {
    logger.warn(`drive-watch: no valid Google token for watch ${row.id} — pull skipped`, {
      source: 'drive-watch',
      watchId: row.id,
    });
    return false;
  }

  let pageToken: string | null = row.token;
  if (!pageToken) {
    pageToken = await fetchStartPageToken(token); // seed failed at subscribe
    if (!pageToken) return false;
  }

  const collected: DriveChange[] = [];
  const parentsByFileId = new Map<string, string[]>();
  let newStartPageToken: string | null = null;
  try {
    for (let i = 0; i < MAX_PAGES_PER_PULL; i++) {
      const res: AxiosResponse<DriveChangesResponse> = await axios.get<DriveChangesResponse>(`${DRIVE_API}/changes`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pageToken,
          pageSize: CHANGES_PAGE_SIZE,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          includeRemoved: true,
          fields:
            'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,modifiedTime,trashed,parents))',
        },
        timeout: 20000,
      });
      for (const ch of res.data.changes ?? []) {
        const fileId = ch.fileId ?? ch.file?.id;
        if (!fileId) continue;
        if (ch.file?.parents) parentsByFileId.set(fileId, ch.file.parents);
        if (ch.removed && !ch.file) continue; // cannot prove folder membership
        collected.push({
          fileId,
          name: ch.file?.name ?? '(removed)',
          modifiedTime: ch.file?.modifiedTime ?? new Date().toISOString(),
        });
      }
      pageToken = res.data.nextPageToken ?? null;
      if (res.data.newStartPageToken) {
        newStartPageToken = res.data.newStartPageToken;
        break;
      }
      if (!pageToken) break;
    }
  } catch (err: any) {
    logger.warn(
      `drive-watch: changes.list failed for watch ${row.id}: ${err?.response?.status ?? ''} ${err?.message ?? err} — pageToken kept, retry next ping`,
      { source: 'drive-watch', watchId: row.id },
    );
    return false;
  }

  const persistToken = newStartPageToken ?? pageToken;
  const inFolder = filterChangesForFolder(collected, parentsByFileId, row.folderId);
  const newChanges = dedupeAgainstFired(inFolder, parseFiredChanges(row.lastFiredChanges));

  if (newChanges.length === 0) {
    // Nothing to fire: just advance the pointer (the at-most-once path).
    if (persistToken) {
      await prisma.driveWatch.update({
        where: { id: row.id },
        data: { token: persistToken, lastSyncedAt: new Date() },
      });
    }
    return false;
  }

  // Rate cap — leave the row untouched so these docs re-fire after the window.
  if (row.lastFiredAt && Date.now() - row.lastFiredAt.getTime() < MIN_FIRE_INTERVAL_MS) {
    return false;
  }

  const prompt = buildWakePrompt(row, newChanges);
  const wake = await enqueueDirectWake({
    targetChatId: row.targetChatId,
    prompt,
    meta: { driveWatchId: row.id, folderId: row.folderId, changeCount: newChanges.length },
  });
  if (!wake.ok) {
    logger.warn(`drive-watch: wake enqueue failed for watch ${row.id}: ${wake.error ?? 'unknown'} — will retry next ping`, {
      source: 'drive-watch',
      watchId: row.id,
    });
    return false;
  }

  await prisma.driveWatch.update({
    where: { id: row.id },
    data: {
      token: persistToken ?? row.token,
      lastFiredChanges: nextFiredWindow(newChanges, parseFiredChanges(row.lastFiredChanges)),
      lastFiredAt: new Date(),
      lastSyncedAt: new Date(),
    },
  });
  return true;
}

// ── Daily renewal tick (worker.ts) ───────────────────────────────────────────

export interface RenewalReport {
  checked: number;
  renewed: number;
  renewFailed: number;
  fired: number;
}

/**
 * Renew + reconcile every watch: (1) re-create channels expiring within 24h
 * (stop old, watch new, update the row) and rows whose channel never opened;
 * (2) run one incremental pull per row as the fallback for missed pings.
 * Zero model spend — pulls run no model; only real changes fire wakes.
 */
export async function renewDriveWatches(now: Date = new Date()): Promise<RenewalReport> {
  const report: RenewalReport = { checked: 0, renewed: 0, renewFailed: 0, fired: 0 };
  const rows = await prisma.driveWatch.findMany();
  for (const row of rows) {
    report.checked++;
    if (shouldRenew(row.expiration, now)) {
      const ok = await rewatchChannel(row.id);
      if (ok) report.renewed++;
      else report.renewFailed++;
    }
    if (await pullAndMaybeFire(row.id)) report.fired++;
  }
  return report;
}

/** Stop the old channel and open a fresh one for a watch row. */
async function rewatchChannel(watchId: string): Promise<boolean> {
  const row = await prisma.driveWatch.findUnique({ where: { id: watchId } });
  if (!row) return false;
  const token = await getValidToken(row.userId, row.label ?? undefined);
  if (!token) return false;
  if (row.resourceId !== NO_CHANNEL) {
    try {
      await stopChannel(row.userId, row.label, row.channelId, row.resourceId);
    } catch {
      // Old channel is dead or already stopped — the new watch proceeds.
    }
  }
  const channelId = `dg-dw-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = await openChannel(token, channelId);
  if (!channel) return false;
  await prisma.driveWatch.update({
    where: { id: row.id },
    data: { channelId, resourceId: channel.resourceId, expiration: channel.expiration },
  });
  return true;
}

// ── Shared ───────────────────────────────────────────────────────────────────

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function toView(row: {
  id: string;
  label: string | null;
  folderId: string;
  targetChatId: string;
  promptTemplate: string;
  expiration: Date | null;
  resourceId: string;
  lastFiredAt: Date | null;
  createdAt: Date;
}): DriveWatchView {
  return {
    id: row.id,
    label: row.label,
    folderId: row.folderId,
    targetChatId: row.targetChatId,
    promptTemplate: row.promptTemplate,
    expiration: row.expiration?.toISOString() ?? null,
    channelActive: row.resourceId !== NO_CHANNEL,
    lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
