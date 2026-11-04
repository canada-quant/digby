/**
 * Digby Code — DURABLE pending-approval/question records (Phase 4).
 *
 * The LEG-2c transport (session-run-lock.ts) is cross-PROCESS but not
 * cross-RESTART: a worker restart (deploy, crash) abandons every in-memory
 * awaitApproval/awaitAnswer, its pending-presence keys expire with it, and a
 * human's click on the parked card hits the endpoint's `success:false` — the
 * decision is LOST even when a restarted run re-asks the identical question
 * minutes later.
 *
 * This module keeps a small durable record per wait plus a per-session
 * FINGERPRINT pointer so the pieces find each other across restarts:
 *
 *   coding:pend:<kind>:<id>                → JSON DurablePendingRecord
 *   coding:pendfp:<kind>:<sessionId>:<fp>  → the fingerprint's CURRENT id
 *
 * The fingerprint is sha1 of a caller-supplied seed (approval: tool name +
 * stable-stringified args; question: text + options) — an identical re-ask
 * hashes identically. Three flows close the restart gap:
 *
 *   1. Answer recorded, THEN the run restarts and re-asks  → the registry
 *      finds the ANSWERED record by fingerprint and resolves immediately with
 *      the recorded decision (the human is not re-prompted).
 *   2. Restart BEFORE any answer, human clicks the OLD id  → the resolve
 *      endpoint's durable fallback records the decision on the old record and
 *      delivers it to the fingerprint's CURRENT id (the re-asked wait) via
 *      the session's resolution mailbox.
 *   3. Human clicks an already-decided id  → idempotent success:true.
 *
 * Record TTLs sit just above the LEG-2c pending-key TTLs so a record never
 * vanishes while its endpoint route is still live, and a long-dead wait does
 * not linger. Best-effort like session-run-lock: every op fails OPEN (a Redis
 * hiccup degrades to pre-Phase-4 behavior, never a thrown 500).
 */

import crypto from 'crypto';
import redisClient from '../../../config/redis';

export type PendingKind = 'approval' | 'question';

export type DurableStatus = 'pending' | 'answered' | 'denied' | 'expired';

export interface DurablePendingRecord {
  id: string;
  kind: PendingKind;
  sessionId: string;
  fingerprint: string | null;
  /** Human-readable summary (approval prompt / question text), pre-sliced. */
  detail: string;
  status: DurableStatus;
  /** The recorded decision ('allow'|'always'|'deny') or answer text. */
  resolution?: string;
  /** approval records (2026-09-24): the tool the request is for — approve_request
   *  refuses ask-only tools in machine runs by reading THIS, never the prompt text. */
  tool?: string;
  createdAt: number;
  resolvedAt?: number;
}

const RECORD_KEY = (kind: PendingKind, id: string) => `coding:pend:${kind}:${id}`;
const FP_KEY = (kind: PendingKind, sessionId: string, fp: string) =>
  `coding:pendfp:${kind}:${sessionId}:${fp}`;

// Just above the LEG-2c pending-key TTLs (900 s approval / 3960 s question) so
// the durable record outlives every route that could still reference it.
export const APPROVAL_RECORD_TTL_SEC = 17 * 60;
export const QUESTION_RECORD_TTL_SEC = 67 * 60;
const ttlFor = (kind: PendingKind): number =>
  kind === 'approval' ? APPROVAL_RECORD_TTL_SEC : QUESTION_RECORD_TTL_SEC;

/** JSON with recursively-sorted object keys, so fingerprint seeds are key-order independent. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha1 hex of the seed — the join key between an abandoned wait and its re-asked twin. */
export function fingerprintFor(kind: PendingKind, seed: string): string {
  return crypto.createHash('sha1').update(`${kind}\n${seed}`).digest('hex');
}

/** Create/overwrite the durable record for a wait (+ point its fingerprint at it). */
export async function saveDurablePending(rec: DurablePendingRecord): Promise<void> {
  const ttl = ttlFor(rec.kind);
  await redisClient.set(RECORD_KEY(rec.kind, rec.id), JSON.stringify(rec), { EX: ttl }).catch(() => {});
  if (rec.fingerprint) {
    await redisClient.set(FP_KEY(rec.kind, rec.sessionId, rec.fingerprint), rec.id, { EX: ttl }).catch(() => {});
  }
}

/** Load a record by id (malformed JSON degrades to absent). */
export async function loadDurablePending(kind: PendingKind, id: string): Promise<DurablePendingRecord | null> {
  const raw = await redisClient.get(RECORD_KEY(kind, id)).catch(() => null);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as DurablePendingRecord;
    if (rec && typeof rec.id === 'string' && typeof rec.sessionId === 'string' && typeof rec.status === 'string') {
      return rec;
    }
  } catch { /* malformed → treat as absent */ }
  return null;
}

/** The id a fingerprint currently points at (the live re-asked wait), or null. */
export async function currentIdForFingerprint(kind: PendingKind, sessionId: string, fingerprint: string): Promise<string | null> {
  return redisClient.get(FP_KEY(kind, sessionId, fingerprint)).catch(() => null);
}

/** The record a fingerprint points at (the registry's restart-replay lookup), or null. */
export async function findDurableByFingerprint(kind: PendingKind, sessionId: string, fingerprint: string): Promise<DurablePendingRecord | null> {
  const id = await currentIdForFingerprint(kind, sessionId, fingerprint);
  if (!id) return null;
  return loadDurablePending(kind, id);
}

/** Re-point a fingerprint at a NEW id (the restarted run's re-asked wait). */
export async function aliasDurableFingerprint(kind: PendingKind, sessionId: string, fingerprint: string, newId: string): Promise<void> {
  await redisClient.set(FP_KEY(kind, sessionId, fingerprint), newId, { EX: ttlFor(kind) }).catch(() => {});
}

/**
 * Terminal transition, FIRST-WRITER-WINS: only a 'pending' record moves, so a
 * late timeout/stop can never clobber a recorded human decision.
 */
export async function markDurableResolved(
  kind: PendingKind,
  id: string,
  status: Exclude<DurableStatus, 'pending'>,
  resolution?: string,
): Promise<void> {
  const rec = await loadDurablePending(kind, id);
  if (!rec || rec.status !== 'pending') return;
  rec.status = status;
  rec.resolvedAt = Date.now();
  if (resolution != null) rec.resolution = resolution.slice(0, 8000);
  await redisClient.set(RECORD_KEY(kind, id), JSON.stringify(rec), { EX: ttlFor(kind) }).catch(() => {});
}
