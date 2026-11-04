/**
 * infra-blockers.service.ts — the fleet-wide INFRA-BLOCKER registry
 * (feedback 2b45941b).
 *
 * One Redis hash (`coding:infra:blockers`, field = blocker id, value = JSON
 * entry) every web instance reads at machine-wake FIRE time. Writers: the
 * Fleet Supervisor via the register_infra_blocker / clear_infra_blocker
 * platform tools (platform-tools.ts, supervisor-gated like
 * update_supervisor_state); readers: appendInfraBlockerNotice on the two
 * terminal-stop seams (fireScheduleTarget + queueContinuationRun) and the
 * list_infra_blockers read tool.
 *
 * Why Redis and not prisma/process-local: the registry must be visible to
 * BOTH blue and green web processes the moment it is written (a deploy is
 * often the thing that is blocked), and it must survive nothing — entries
 * carry their own expiresAt and self-prune on read. Process-local latches
 * (the DeepSeek billing latch) are per-instance and were rejected for this
 * fleet-wide shape; prisma would couple fire-time latency to the DB for a
 * value that is advisory-only.
 *
 * Fail-open everywhere: a Redis hiccup returns [] / a refused write, never a
 * thrown firing. Hash-field writes (hSet/hDel) are per-entry atomic — no
 * read-modify-write race between a register and a clear. Idiom mirrors
 * attention-watchdog.service.ts's state hash ((redisClient as any).hGetAll/
 * hSet/hDel).
 */

import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import {
  InfraBlocker,
  DEFAULT_BLOCKER_TTL_HOURS,
  MAX_BLOCKER_TTL_HOURS,
  blockerExpired,
  buildInfraBlockerNotice,
  isDeployRunbookPrompt,
} from './infra-blockers';

const REGISTRY_KEY = 'coding:infra:blockers';

/** Hard caps — the notice is prompt text; a pathological registry must not
 *  inflate every firing. Registration refuses beyond this. */
export const MAX_ACTIVE_BLOCKERS = 10;

let lastWarnAt = 0;
function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  logger.warn(`infra-blockers: ${message}`);
}

function clampTtlHours(ttlHours: number | undefined | null): number {
  if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0) return DEFAULT_BLOCKER_TTL_HOURS;
  return Math.min(ttlHours, MAX_BLOCKER_TTL_HOURS);
}

function parseEntry(raw: unknown): InfraBlocker | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.id !== 'string' || typeof v.label !== 'string' || typeof v.registeredAt !== 'string') return null;
    return v as InfraBlocker;
  } catch {
    return null;
  }
}

/**
 * List the ACTIVE (unexpired) blockers, oldest first. Expired + malformed
 * entries are pruned best-effort in the same pass. Fail-open: any Redis
 * hiccup returns [] (a firing proceeds unannotated — the same posture as a
 * terminal-stop lookup failure).
 */
export async function listActiveInfraBlockers(now: Date = new Date()): Promise<InfraBlocker[]> {
  try {
    const raw = await (redisClient as any).hGetAll(REGISTRY_KEY);
    const out: InfraBlocker[] = [];
    const prune: string[] = [];
    for (const [field, value] of Object.entries(raw ?? {})) {
      const entry = parseEntry(value);
      if (!entry) {
        prune.push(field);
        continue;
      }
      if (blockerExpired(entry, now)) {
        prune.push(field);
        continue;
      }
      out.push(entry);
    }
    if (prune.length) {
      await (redisClient as any).hDel(REGISTRY_KEY, prune).catch(() => {});
    }
    out.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
    return out;
  } catch (err: any) {
    warnThrottled(`list failed (firing proceeds unannotated): ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Register (or refresh, same id) a fleet-wide blocker. Refuses past
 * MAX_ACTIVE_BLOCKERS (register the umbrella incident, not every symptom —
 * the 2026-09-18 disk wall was ONE blocker). Returns the stored entry.
 * Throws NOTHING on Redis failure — returns { ok:false } instead so a tool
 * surface can relay the refusal.
 */
export async function registerInfraBlocker(input: {
  label: string;
  detail?: string | null;
  ttlHours?: number | null;
  registeredBy?: string | null;
  id?: string | null;
}): Promise<{ ok: true; blocker: InfraBlocker } | { ok: false; reason: string }> {
  const label = String(input?.label ?? '').trim().slice(0, 200);
  if (!label) return { ok: false, reason: 'label is required' };
  const now = new Date();
  try {
    const existing = await listActiveInfraBlockers(now);
    const id = (input.id && String(input.id).trim()) || `ib_${Math.random().toString(16).slice(2, 10)}`;
    if (!existing.some((b) => b.id === id) && existing.length >= MAX_ACTIVE_BLOCKERS) {
      return { ok: false, reason: `registry full (${MAX_ACTIVE_BLOCKERS} active) — clear or let entries expire first` };
    }
    const ttl = clampTtlHours(input.ttlHours);
    const blocker: InfraBlocker = {
      id,
      label,
      detail: input.detail ? String(input.detail).slice(0, 500) : null,
      registeredAt: now.toISOString(),
      registeredBy: input.registeredBy ? String(input.registeredBy).slice(0, 80) : null,
      expiresAt: new Date(now.getTime() + ttl * 3_600_000).toISOString(),
    };
    await (redisClient as any).hSet(REGISTRY_KEY, id, JSON.stringify(blocker));
    return { ok: true, blocker };
  } catch (err: any) {
    warnThrottled(`register failed: ${err?.message ?? err}`);
    return { ok: false, reason: `registry write failed: ${err?.message ?? err}` };
  }
}

/** Clear one blocker by id (full id or unique prefix — the fleet's 8-char
 *  idiom). Ambiguous prefix is refused with the candidate ids. */
export async function clearInfraBlocker(idOrPrefix: string): Promise<{ ok: boolean; cleared?: string; reason?: string; candidates?: string[] }> {
  const needle = String(idOrPrefix ?? '').trim();
  if (!needle) return { ok: false, reason: 'id is required' };
  try {
    const raw = await (redisClient as any).hGetAll(REGISTRY_KEY);
    const ids = Object.keys(raw ?? {});
    const exact = ids.includes(needle) ? [needle] : ids.filter((k) => k.startsWith(needle));
    if (exact.length === 0) return { ok: false, reason: `no blocker matches '${needle}'`, candidates: ids };
    if (exact.length > 1) return { ok: false, reason: `ambiguous prefix '${needle}'`, candidates: exact };
    await (redisClient as any).hDel(REGISTRY_KEY, [exact[0]]);
    return { ok: true, cleared: exact[0] };
  } catch (err: any) {
    warnThrottled(`clear failed: ${err?.message ?? err}`);
    return { ok: false, reason: `registry write failed: ${err?.message ?? err}` };
  }
}

/**
 * Fire-time annotation seam (feedback 2b45941b): when the fully-decorated
 * machine-wake prompt reads like a deploy/merge/publish runbook AND the
 * registry holds active blockers, append the advisory [FLEET INFRA BLOCKER]
 * block. Shares the terminal-stop doctrine: ADVISORY only (never a skip),
 * fail-open (a registry hiccup never delays a firing).
 * Called from BOTH machine-wake seams — fireScheduleTarget (schedule
 * firings + hook wakes) and queueContinuationRun (the continuation fast
 * lane, which bypasses fireScheduleTarget).
 */
export async function appendInfraBlockerNotice(prompt: string, label: string): Promise<string> {
  try {
    if (!isDeployRunbookPrompt(prompt)) return prompt;
    const blockers = await listActiveInfraBlockers();
    if (!blockers.length) return prompt;
    return `${prompt}\n\n${buildInfraBlockerNotice(blockers, new Date())}`;
  } catch (err: any) {
    logger.warn(`coding schedule: [FLEET INFRA BLOCKER] scan failed for ${label} (firing proceeds without it): ${err?.message ?? err}`);
    return prompt;
  }
}
