/**
 * Account → Coding → Dev container, routed to where Docker is (2026-10-13 —
 * owner: "properly configure it for professional config").
 *
 * WHY: the HTTP routes ran dev-container.service IN-PROCESS on the web boxes
 * A/B, which have had no Docker since 2026-09-24 (the DOCKER_HOST path to box
 * C's proxy is dead by design). So Settings showed "not running · container
 * mode is off or docker is unreachable" for a container that was running on C,
 * reported the web box's CODING_EGRESS_SECRET instead of C's, and Restart was
 * a no-op. Box C's worker owns Docker.
 *
 * HOW: every operation runs locally when this process has Docker
 * (isDockerAvailable), else rides the EXISTING Redis request/reply channel the
 * Files tab uses (worktree-remote-read.ts, op 'devc') to the worker that has
 * Docker. Nobody answering is said plainly ("the coding server did not
 * answer") — never a fake "not running".
 *
 * Restart / Restart tailnet / Reconnect run in the BACKGROUND on the Docker
 * box (a rebuild + verified join can take minutes — longer than an HTTP
 * request should hang): the start is acknowledged, progress lives in a Redis
 * record any web box reads (status.action), and Settings polls status while it
 * runs. One action per user at a time (Redis SET NX lock keyed by the request
 * id, so two responders answering the same request — a deploy's old + new
 * worker — run it once and the loser stays silent).
 *
 * Kill switch: DEV_CONTAINER_REMOTE_OPS_DISABLED=1 restores the in-process,
 * synchronous behaviour byte-for-byte.
 */

import { randomUUID } from 'crypto';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { isDockerAvailable } from './container.service';
import {
  getDevContainerStatus, restartUserDevContainer, restartDevTailnet, reconnectDevTailnet, reconnectNote,
  devContainerEnabledTriState, devContainerName, inFlightRunSummary, inFlightRestartNote,
  saveUserEgressPolicy, saveSessionEgressOverride, pushUserEgressPolicyNow, refreshSessionEgressNow,
  type DevContainerStatus, type DevContainerActionRecord,
} from './dev-container.service';
import { requestRemoteDevContainer, type DevcWireRequest } from './worktree-remote-read';

export type DevContainerAction = DevContainerActionRecord['action'];
export const DEV_CONTAINER_ACTIONS: readonly DevContainerAction[] = ['restart', 'tailnet_restart', 'tailnet_reconnect'];

export const DEVC_STATUS_TIMEOUT_MS = 20_000;
export const DEVC_START_TIMEOUT_MS = 15_000;
export const DEVC_EGRESS_TIMEOUT_MS = 15_000;
const ACTION_LOCK_TTL_SEC = 600;
const ACTION_RECORD_TTL_SEC = 3600;

export const UNREACHABLE_STATUS_NOTE = "The coding server didn't answer, so the container's live state is unknown right now. Try again in a minute.";
export const UNREACHABLE_ACTION_NOTE = "The coding server didn't answer — nothing was started. Try again in a minute.";
export const BUSY_ACTION_NOTE = 'Another dev container action is still running — wait for it to finish, then try again.';

export function remoteOpsDisabled(): boolean {
  const v = String(process.env.DEV_CONTAINER_REMOTE_OPS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const actionKey = (userId: string) => `coding:devaction:${userId.slice(0, 12)}`;
const actionLockKey = (userId: string) => `coding:devaction-lock:${userId.slice(0, 12)}`;

/** The Redis client slice this module uses — injectable for tests. */
export interface ActionStore {
  set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
}
const store = (): ActionStore => redisClient as unknown as ActionStore;

export async function readActionRecord(userId: string, s: ActionStore = store()): Promise<DevContainerActionRecord | null> {
  try {
    const raw = await s.get(actionKey(userId));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && typeof rec.action === 'string' && typeof rec.state === 'string' ? (rec as DevContainerActionRecord) : null;
  } catch {
    return null;
  }
}

async function writeActionRecord(userId: string, rec: DevContainerActionRecord, s: ActionStore): Promise<void> {
  await s.set(actionKey(userId), JSON.stringify(rec), { EX: ACTION_RECORD_TTL_SEC }).catch(() => null);
}

/** A tailscale TS_AUTHKEY row exists (presence only — never decrypted here). */
async function keySaved(userId: string): Promise<boolean> {
  const row = await prisma.codingCredential.findFirst({
    where: { userId, provider: 'tailscale', envKey: 'TS_AUTHKEY' }, select: { id: true },
  }).catch(() => null);
  return !!row;
}

function startedNote(action: DevContainerAction): string {
  if (action === 'restart') return 'Rebuilding the dev container with your saved key — this can take a couple of minutes.';
  if (action === 'tailnet_reconnect') return 'Reconnecting the tailnet with your saved key…';
  return 'Restarting the tailnet daemon…';
}

/** What a finished action leaves on the record. Pure. */
export function finishedRecord(action: DevContainerAction, st: DevContainerStatus, startedAt: string, reconnectOk?: boolean): DevContainerActionRecord {
  const joined = st.running && st.tailscale?.state === 'Running';
  const ok = action === 'tailnet_reconnect' ? reconnectOk === true : joined;
  let note = st.note;
  if (!note) {
    if (action === 'restart') {
      note = joined
        ? 'Rebuilt — the container joined your tailnet with the saved key.'
        : "Rebuilt, but the container couldn't join your tailnet, so sessions are using per-session containers. Check the saved key, then press Restart again.";
    } else {
      note = joined ? 'The tailnet daemon restarted and rejoined.' : "The tailnet daemon restarted but didn't rejoin.";
    }
  }
  return { action, state: ok ? 'done' : 'failed', startedAt, finishedAt: new Date().toISOString(), note };
}

export interface ActionStart { accepted: boolean; note: string }

export interface ActionDeps {
  store: ActionStore;
  run: {
    restart: (userId: string) => Promise<DevContainerStatus>;
    tailnet_restart: (userId: string) => Promise<DevContainerStatus>;
    tailnet_reconnect: (userId: string) => Promise<{ outcome: string; status: DevContainerStatus }>;
  };
}
const defaultDeps = (): ActionDeps => ({
  store: store(),
  run: { restart: restartUserDevContainer, tailnet_restart: restartDevTailnet, tailnet_reconnect: reconnectDevTailnet },
});

/**
 * Start an action on THIS process (it must have Docker). Preflight refusals
 * answer at once; an accepted action runs in the background and records its
 * outcome. null = a peer responder already took this exact request (stay
 * silent so the requester gets the winner's reply).
 */
export async function beginDevContainerAction(
  userId: string, action: DevContainerAction, requestId: string, deps: ActionDeps = defaultDeps(),
): Promise<ActionStart | null> {
  if ((await devContainerEnabledTriState(userId)) !== true) {
    return { accepted: false, note: 'The dev container is not enabled for this account.' };
  }
  if (action === 'tailnet_reconnect' && !(await keySaved(userId))) {
    return { accepted: false, note: reconnectNote('no_key') };
  }
  if (action === 'restart') {
    const summary = await inFlightRunSummary(userId);
    if (!summary || summary.count > 0) return { accepted: false, note: inFlightRestartNote(summary) };
  }
  const s = deps.store;
  let locked: boolean;
  try {
    locked = !!(await s.set(actionLockKey(userId), requestId, { NX: true, EX: ACTION_LOCK_TTL_SEC }));
  } catch {
    // The request itself arrived over Redis, so a failing SET is a blip —
    // refuse rather than risk a second concurrent rebuild.
    return { accepted: false, note: BUSY_ACTION_NOTE };
  }
  if (!locked) {
    const holder = await s.get(actionLockKey(userId)).catch(() => null);
    if (holder === requestId) return null; // a peer responder took this same request
    return { accepted: false, note: BUSY_ACTION_NOTE };
  }
  const startedAt = new Date().toISOString();
  await writeActionRecord(userId, { action, state: 'running', startedAt, note: startedNote(action) }, s);
  const release = async () => {
    const holder = await s.get(actionLockKey(userId)).catch(() => null);
    if (holder === requestId) await s.del(actionLockKey(userId)).catch(() => 0);
  };
  void (async () => {
    let rec: DevContainerActionRecord;
    try {
      if (action === 'tailnet_reconnect') {
        const r = await deps.run.tailnet_reconnect(userId);
        rec = finishedRecord(action, r.status, startedAt, r.outcome === 'joined');
      } else {
        rec = finishedRecord(action, await deps.run[action](userId), startedAt);
      }
    } catch (err: any) {
      logger.warn(`dev-container: ${action} for ${userId.slice(0, 8)} threw: ${String(err?.message ?? err).slice(0, 140)}`);
      rec = { action, state: 'failed', startedAt, finishedAt: new Date().toISOString(), note: 'The action failed unexpectedly. Try again in a minute.' };
    }
    await writeActionRecord(userId, rec, s);
    await release();
    logger.info(`dev-container: ${action} for ${userId.slice(0, 8)} finished — ${rec.state}`);
  })();
  return { accepted: true, note: startedNote(action) };
}

/**
 * The responder half (op 'devc'), on the worker that has Docker. null = this
 * process has no Docker (stay silent — another box may answer).
 */
export async function handleDevcRequest(devc: DevcWireRequest, requestId: string, deps: ActionDeps = defaultDeps()): Promise<unknown | null> {
  if (!(await isDockerAvailable())) return null;
  const { userId, action } = devc;
  switch (action) {
    case 'status':
      return { status: await getDevContainerStatus(userId) };
    case 'restart':
    case 'tailnet_restart':
    case 'tailnet_reconnect': {
      const start = await beginDevContainerAction(userId, action, requestId, deps);
      return start === null ? null : { start };
    }
    case 'egress_push':
      return { pushed: await pushUserEgressPolicyNow(userId) };
    case 'session_egress_refresh': {
      const sessionId = devc.args?.sessionId;
      if (!sessionId) return { refreshed: false };
      // Re-check ownership here too: the session must belong to the asking user.
      const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { userId: true } }).catch(() => null);
      if (!row || row.userId !== userId) return { refreshed: false };
      return { refreshed: await refreshSessionEgressNow(sessionId) };
    }
    default:
      return { error: 'unknown action' };
  }
}

// ── Requester half (the HTTP routes) ─────────────────────────────────────────

/** Run here when this process has Docker, or when the kill switch keeps everything in-process. */
async function runsHere(): Promise<boolean> {
  return remoteOpsDisabled() || (await isDockerAvailable());
}

/** What the web box knows without Docker — for "the coding server didn't answer". */
async function unreachableStatus(userId: string): Promise<DevContainerStatus> {
  const enabled = (await devContainerEnabledTriState(userId)) === true;
  let policyRules: number | null = null;
  try {
    const prefs = await prisma.userPreferences.findUnique({ where: { userId }, select: { devContainerEgressAllow: true } });
    if (prefs?.devContainerEgressAllow) {
      const parsed = JSON.parse(prefs.devContainerEgressAllow);
      if (Array.isArray(parsed)) policyRules = parsed.length;
    }
  } catch { /* cosmetic */ }
  return {
    enabled, running: false, container: devContainerName(userId), image: '', tailscale: null,
    keyConfigured: await keySaved(userId),
    egress: { mode: enabled ? 'unknown' : 'off', shim: null, policyRules },
    reach: 'unreachable',
    note: UNREACHABLE_STATUS_NOTE,
  };
}

function statusFromReply(reply: unknown): DevContainerStatus | null {
  const st = (reply as any)?.status;
  return st && typeof st === 'object' && typeof st.container === 'string' ? (st as DevContainerStatus) : null;
}

/** GET /coding/dev-container/status. */
export async function routedDevContainerStatus(userId: string): Promise<DevContainerStatus> {
  if (remoteOpsDisabled()) return getDevContainerStatus(userId);
  if (await isDockerAvailable()) {
    const st = await getDevContainerStatus(userId);
    return { ...st, reach: 'local', action: await readActionRecord(userId) };
  }
  const reply = await requestRemoteDevContainer({ userId, action: 'status' }, DEVC_STATUS_TIMEOUT_MS);
  const remote = statusFromReply(reply);
  const st = remote ? { ...remote, reach: 'remote' as const } : await unreachableStatus(userId);
  return { ...st, action: await readActionRecord(userId) };
}

export type RoutedActionResult =
  | { kind: 'started' | 'done'; status: DevContainerStatus; note: string }
  | { kind: 'refused'; status: DevContainerStatus; note: string }
  | { kind: 'unreachable'; status: DevContainerStatus; note: string };

/** POST restart / tailnet restart / tailnet reconnect. */
export async function routedDevContainerAction(userId: string, action: DevContainerAction): Promise<RoutedActionResult> {
  if (remoteOpsDisabled()) {
    // Pre-2026-10-13 behaviour: synchronous, in-process.
    const status = action === 'restart' ? await restartUserDevContainer(userId)
      : action === 'tailnet_restart' ? await restartDevTailnet(userId)
        : (await reconnectDevTailnet(userId)).status;
    return { kind: 'done', status, note: status.note ?? '' };
  }
  let start: ActionStart | null;
  if (await isDockerAvailable()) {
    start = await beginDevContainerAction(userId, action, randomUUID());
  } else {
    const reply = await requestRemoteDevContainer({ userId, action }, DEVC_START_TIMEOUT_MS);
    const s = (reply as any)?.start;
    start = s && typeof s.accepted === 'boolean' && typeof s.note === 'string' ? (s as ActionStart) : null;
    if (!start) {
      // The reply may have been lost after the coding server DID start it —
      // check the record before telling the owner nothing happened.
      const rec = await readActionRecord(userId);
      const fresh = rec && rec.action === action && rec.state === 'running'
        && Date.now() - Date.parse(rec.startedAt) < 2 * DEVC_START_TIMEOUT_MS;
      if (fresh) start = { accepted: true, note: rec!.note ?? startedNote(action) };
    }
  }
  const status = await routedDevContainerStatus(userId);
  if (!start) return { kind: 'unreachable', status, note: UNREACHABLE_ACTION_NOTE };
  return { kind: start.accepted ? 'started' : 'refused', status: { ...status, note: start.note }, note: start.note };
}

/** PUT /coding/dev-container/egress — DB write here, live push where Docker is. */
export async function routedSaveUserEgressPolicy(userId: string, raw: unknown): Promise<{ allow: string[] | null; pushed: boolean }> {
  if (await runsHere()) return saveUserEgressPolicy(userId, raw);
  const saved = await saveUserEgressPolicy(userId, raw, { push: false });
  const reply = await requestRemoteDevContainer({ userId, action: 'egress_push' }, DEVC_EGRESS_TIMEOUT_MS);
  return { ...saved, pushed: (reply as any)?.pushed === true };
}

/** PUT /coding/sessions/:id/tailnet-egress — same split for a per-session override. */
export async function routedSaveSessionEgressOverride(userId: string, sessionId: string, raw: unknown): Promise<{ allow: string[] | null; refreshed: boolean }> {
  if (await runsHere()) return saveSessionEgressOverride(sessionId, raw);
  const saved = await saveSessionEgressOverride(sessionId, raw, { refresh: false });
  const reply = await requestRemoteDevContainer({ userId, action: 'session_egress_refresh', args: { sessionId } }, DEVC_EGRESS_TIMEOUT_MS);
  return { ...saved, refreshed: (reply as any)?.refreshed === true };
}
