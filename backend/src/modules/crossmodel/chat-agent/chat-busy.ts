/**
 * Cross-process chat busy state — THE shared source of truth for "is a run
 * answering in this chat right now?".
 *
 * The live-run registry (coding/live-runs.ts) is process-local by design, but
 * prod runs several processes over one DB (blue/green web instances + the
 * worker; the ALB has no stickiness). A detached chat run executing on
 * instance A was invisible to instance B, so every liveness surface B served
 * reported idle — and worse, B's enqueue-vs-start gate could start a SECOND
 * concurrent run on the same chat (the server-side root of the #185/#183/#211
 * "chat looks dead while busy" symptom class).
 *
 * Three layers, cheapest first:
 *   1. the in-process registry (both run-key forms) — the local fast path;
 *   2. a Redis liveness key per chat (cm:liverun:<chatId>): SET NX by
 *      startDetachedChatRun's claim (the ATOMIC cross-process start gate),
 *      TTL-refreshed by the run's heartbeat, DELed by its finally. A hard
 *      crash simply lets it expire (LIVE_RUN_TTL_SEC);
 *   3. the durable agent_runs table (status queued/running) — coding runs
 *      execute in the WORKER process and never touch a web registry (the same
 *      union crossmodel.service.listChats already does).
 *
 * Cross-process STOP rides a Redis request flag (requestChatRunStop): the
 * OWNING process's run heartbeat polls it and applies the local cancelRun.
 *
 * Best-effort discipline (mirrors coding/session-run-lock.ts): a Redis/DB
 * hiccup degrades a READ to "not busy", and the claim FAILS OPEN (the local
 * registry still closes the same-process race) — blocking every chat run on a
 * cache hiccup is worse than briefly losing the cross-process guarantee.
 *
 * Deliberately dependency-light (live-runs + config only, NO import of
 * chat-agent.service) so every consumer — controller, platform.service,
 * fleet.service, crossmodel.service, chat-agent.service — can use it without
 * cycles.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { isRunActive, chatRunKeys } from '../coding/live-runs';

const LIVE_KEY = (chatId: string) => `cm:liverun:${chatId}`;
const STOP_KEY = (chatId: string) => `cm:liverun:stop:${chatId}`;

/**
 * Machine-origin marker on the liveness value (owner incident 2026-09-04,
 * supervisor chat c0e22e36): a user-typed message must be able to PREEMPT a
 * replayable machine run, which requires every busy surface to know WHO
 * triggered the active run — cross-process. The claim value carries it:
 * `<pid>` for user-triggered runs, `<pid>:machine` for machine-triggered ones
 * (machineWake / schedule / hook / agent / webhook origins). Readers that only
 * test existence (hasRemoteChatRun, getBusyChatIds) are unaffected — the value
 * stays a non-empty string either way.
 */
const MACHINE_MARKER = ':machine';
const liveValue = (machineTriggered: boolean) => `${process.pid}${machineTriggered ? MACHINE_MARKER : ''}`;

/** Comfortably above the heartbeat so a live run never flickers idle; short
 *  enough that a hard-crashed run (SIGKILL — no finally) unblocks its chat in
 *  under a minute. */
export const LIVE_RUN_TTL_SEC = 60;
/** Heartbeat cadence — refreshes the TTL and polls the stop flag. */
export const LIVE_RUN_HEARTBEAT_MS = 15_000;
/** Stop-request lifetime — outlives several heartbeats, dies fast enough that
 *  an unclaimed stale request can't linger for the next run (claims also
 *  clear it explicitly). */
const STOP_TTL_SEC = 120;

/** Local fast path: an active run in THIS process under either key form
 *  (chat-agent runs key `chat:${id}`, coding runs the bare id). */
export function isChatBusyLocally(chatId: string): boolean {
  return chatRunKeys(chatId).some((k) => isRunActive(k));
}

/**
 * ATOMIC cross-process claim of a chat's run slot (SET NX) — the data-
 * integrity half: two instances can never both start a run on one chat.
 * Callers reserve the LOCAL registry slot first (tryStartLiveRun — closes the
 * same-process TOCTOU synchronously), then claim here; losing either → busy.
 * A successful claim clears any stale stop-request left by a Stop that raced
 * the previous run's end — it must not cancel the run it never targeted.
 * FAILS OPEN on a Redis outage (see module doc).
 */
export async function claimChatLiveRun(chatId: string, opts?: { machineTriggered?: boolean }): Promise<boolean> {
  try {
    const r = await redisClient.set(LIVE_KEY(chatId), liveValue(opts?.machineTriggered === true), { NX: true, EX: LIVE_RUN_TTL_SEC });
    if (r !== 'OK') return false;
    await redisClient.del(STOP_KEY(chatId)).catch(() => {});
    return true;
  } catch (err: any) {
    logger.warn(`chat-busy: claim degraded to local-only for ${chatId} (Redis unavailable): ${err?.message ?? err}`);
    return true;
  }
}

/** Extend the liveness key (owner-only; called on the run's heartbeat).
 *  `machineTriggered` must match the claim's — the refresh rewrites the value. */
export async function refreshChatLiveRun(chatId: string, machineTriggered = false): Promise<void> {
  try {
    await redisClient.set(LIVE_KEY(chatId), liveValue(machineTriggered), { EX: LIVE_RUN_TTL_SEC });
  } catch { /* best-effort — the TTL simply keeps its previous window */ }
}

/**
 * True when the chat's ACTIVE run is MACHINE-triggered (the claim carries the
 * `:machine` marker) — the F1 preemption gate. FAIL-SAFE: absent key, a
 * user-triggered claim, a Redis hiccup, or a coding run (which never claims
 * this key — its busy truth is agent_runs) all answer false, so a user-typed
 * run or a coding run can NEVER be selected for preemption by a degraded read.
 */
export async function isChatRunMachineTriggered(chatId: string): Promise<boolean> {
  try {
    const v = await redisClient.get(LIVE_KEY(chatId));
    return typeof v === 'string' && v.endsWith(MACHINE_MARKER);
  } catch {
    return false;
  }
}

/**
 * Batched machine-lock read (attention-watchdog zombie-run stop, live incident
 * 2026-09-10): which of `chatIds` hold a live-run lock whose claim value
 * carries the machine marker. ONE MGET, never per-chat. FAIL-SAFE like
 * isChatRunMachineTriggered: an absent key, a user-triggered claim, or a Redis
 * hiccup all keep a chat OUT of the result — a degraded read can never
 * nominate a chat (least of all a user's own run) for a stop.
 */
export async function getMachineLockedChatIds(chatIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (chatIds.length === 0) return out;
  try {
    const values = await redisClient.mGet(chatIds.map((id) => LIVE_KEY(id)));
    if (Array.isArray(values)) {
      values.forEach((v, i) => {
        if (typeof v === 'string' && v.endsWith(MACHINE_MARKER) && chatIds[i]) out.add(chatIds[i]);
      });
    }
  } catch { /* fail-safe — see doc */ }
  return out;
}

/** Release the liveness key when the run ends (BEFORE the queue drain, so the
 *  drain's fresh start can re-claim it). */
export async function releaseChatLiveRun(chatId: string): Promise<void> {
  try {
    await redisClient.del(LIVE_KEY(chatId));
  } catch { /* best-effort — the key expires on its own within the TTL */ }
}

/** True when SOME process holds this chat's Redis liveness key. */
export async function hasRemoteChatRun(chatId: string): Promise<boolean> {
  try {
    const n = await redisClient.exists(LIVE_KEY(chatId));
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/** Ask whichever process owns this chat's run to stop it (its heartbeat polls).
 *  Returns whether the flag actually landed: callers that arm follow-up state
 *  on the stop being requested (the attention-watchdog's zombie-stop dedupe)
 *  must release that state on a false — otherwise a Redis blip would burn the
 *  one stop the dedupe window allows on a flag that never existed. */
export async function requestChatRunStop(chatId: string): Promise<boolean> {
  try {
    await redisClient.set(STOP_KEY(chatId), '1', { EX: STOP_TTL_SEC });
    return true;
  } catch {
    return false; // best-effort — the caller decides whether the miss matters
  }
}

/**
 * Withdraw an unclaimed stop request (F1 preemption): when the machine run a
 * preemption targeted ends between the marker read and the stop write, the
 * flag would otherwise linger and could cancel the NEXT run — which may be the
 * user's own. Best-effort like everything here (a claim also clears it).
 */
export async function clearChatRunStopRequest(chatId: string): Promise<void> {
  try {
    await redisClient.del(STOP_KEY(chatId));
  } catch { /* best-effort — claimChatLiveRun clears stale requests too */ }
}

/** Owner-side stop poll: true once per request (GET then DEL). */
export async function takeChatRunStopRequest(chatId: string): Promise<boolean> {
  try {
    const v = await redisClient.get(STOP_KEY(chatId));
    if (v == null) return false;
    await redisClient.del(STOP_KEY(chatId)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Durable coding-run check (worker tier): a queued/running agent_runs row. */
async function hasActiveAgentRun(chatId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).agentRun.findFirst({
      where: { sessionId: chatId, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    return !!row;
  } catch {
    return false;
  }
}

/**
 * THE one busy check: local registry → Redis liveness key → durable
 * agent_runs. Every "is this chat busy?" surface goes through here (or the
 * batched getBusyChatIds below) — never through the local registry alone.
 */
export async function isChatBusy(chatId: string): Promise<boolean> {
  if (isChatBusyLocally(chatId)) return true;
  if (await hasRemoteChatRun(chatId)) return true;
  return hasActiveAgentRun(chatId);
}

/**
 * STRICT busy check for recovery sweepers (ticket 68bc5aec): the SAME three
 * layers as isChatBusy, but Redis/DB errors PROPAGATE instead of degrading to
 * "not busy" — the caller (the plain-chat orphan sweeper) fails CLOSED and
 * aborts its whole pass rather than re-firing or draining into a chat whose
 * live run a cache hiccup hid (mirror of coding/session-run-lock.ts
 * isSessionRunLockedStrict). The fail-open isChatBusy above stays for its
 * interactive call sites, where a hiccup degrades to a harmless honest close.
 */
export async function isChatBusyStrict(chatId: string): Promise<boolean> {
  if (isChatBusyLocally(chatId)) return true;
  const n = await redisClient.exists(LIVE_KEY(chatId));
  if (Number(n) > 0) return true;
  const row = await (prisma as any).agentRun.findFirst({
    where: { sessionId: chatId, status: { in: ['queued', 'running'] } },
    select: { id: true },
  });
  return !!row;
}

/**
 * Batched busy check for list surfaces (fleet overview, chat lists): local
 * checks are in-memory, then ONE Redis MGET for every remaining chat and ONE
 * agent_runs query for whatever is still unresolved — never a serial
 * per-chat await chain.
 */
export async function getBusyChatIds(chatIds: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  const remaining: string[] = [];
  for (const id of chatIds) {
    if (isChatBusyLocally(id)) busy.add(id);
    else remaining.push(id);
  }
  if (remaining.length === 0) return busy;

  try {
    const values = await redisClient.mGet(remaining.map((id) => LIVE_KEY(id)));
    if (Array.isArray(values)) {
      values.forEach((v, i) => {
        if (typeof v === 'string' && v && remaining[i]) busy.add(remaining[i]);
      });
    }
  } catch { /* best-effort — fall through to the durable check */ }

  const unresolved = remaining.filter((id) => !busy.has(id));
  if (unresolved.length > 0) {
    try {
      const rows: Array<{ sessionId: string }> = await (prisma as any).agentRun.findMany({
        where: { sessionId: { in: unresolved }, status: { in: ['queued', 'running'] } },
        select: { sessionId: true },
      });
      for (const r of rows) busy.add(r.sessionId);
    } catch { /* best-effort — degrade to what the cheaper layers found */ }
  }
  return busy;
}
