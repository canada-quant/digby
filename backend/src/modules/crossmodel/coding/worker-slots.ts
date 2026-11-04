/**
 * worker-slots.ts — the LIVE coding-worker slot registry (2026-10-20).
 *
 * The project-supervisor spawn guard (platform-tools.ts
 * projectSupervisorSpawnGuard) caps a supervisor's concurrent children at
 * "the box's worker slots". Until this module the ceiling read
 * CODING_WORKER_CONCURRENCY from ITS OWN process — but the guard runs where
 * the supervisor chat turn runs (a web backend on box A / B, or box A's
 * cron-only worker), never on the coding box, and docker-compose.app.yml
 * forwards that env to the worker service only. The "hardware-bound" ceiling
 * was the hard-coded 24 everywhere it mattered while box C ran 32 slots.
 *
 * Now every worker with coding slots PUBLISHES them: ONE Redis hash
 * (`coding:worker:slots`, field = workerId, value = JSON
 * {workerId, box, concurrency, machineSlots, at}) written every
 * WORKER_SLOTS_PUBLISH_MS and cleared on stop / drain. A 0-slot (cron-only)
 * worker publishes nothing — it holds no slots. Readers fold the hash into
 * the fleet's MACHINE-CLAIMABLE slot count: entries older than
 * WORKER_SLOTS_FRESH_MS are ignored (a dead worker ages out — no TTL per
 * hash field, so the publisher also prunes fields older than
 * WORKER_SLOTS_PRUNE_MS), the NEWEST entry per box wins (a blue-green deploy
 * briefly runs two workers on one box — BOX_NAME, forwarded by compose, keys
 * them together; without it the container hostname does and the overlap
 * double-counts for at most one freshness window, in the fail-open
 * direction), and boxes SUM (one coding box today; a second adds its slots).
 *
 * Machine-claimable, not raw: the worker reserves its LAST slot for
 * interactive (user-origin) runs (worker.ts `lastSlot`), so machine-origin
 * children — every child a supervisor spawns — can occupy at most
 * concurrency − 1 slots (concurrency 1 has no reserve). Box C's 32 slots are
 * 31 machine slots; a 32nd child would only ever sit queued.
 *
 * Idiom mirrors infra-blockers.service.ts ((redisClient as any).hGetAll /
 * hSet / hDel; the client is resolved lazily so importing this leaf never
 * touches config/env). Fail-open everywhere: a Redis hiccup publishes
 * nothing / reads null; the guard then falls back to its env / default
 * chain. Kill switch WORKER_SLOT_REGISTRY_DISABLED=1 (no publish, reads
 * null — the pre-2026-10-20 env / default ceiling).
 */

import os from 'os';

export const WORKER_SLOTS_KEY = 'coding:worker:slots';
/** An entry older than this is a dead or wedged worker — ignored by readers. */
export const WORKER_SLOTS_FRESH_MS = 90_000;
/** Publish cadence — three publishes per freshness window. */
export const WORKER_SLOTS_PUBLISH_MS = 30_000;
/** Hash fields older than this are pruned by the next publisher (no per-field TTL in Redis). */
export const WORKER_SLOTS_PRUNE_MS = 10 * 60_000;

export interface WorkerSlotEntry {
  workerId: string;
  /** BOX_NAME when the box's env sets it (box-a / box-b / box-c), else the container hostname. */
  box: string;
  /** CODING_WORKER_CONCURRENCY as the worker runs it. */
  concurrency: number;
  /** Slots a machine-origin run can claim: concurrency − 1 (the interactive reserve), concurrency when it is 1. */
  machineSlots: number;
  /** ISO timestamp of the publish. */
  at: string;
}

export interface LiveWorkerSlots {
  /** Σ machineSlots over the newest fresh entry of every box. */
  slots: number;
  /** Σ concurrency over the same entries (the raw slot count, for the refusal text). */
  rawSlots: number;
  /** Fresh entries seen (every worker, overlap included). */
  workers: number;
  /** Distinct boxes counted. */
  boxes: number;
  entries: WorkerSlotEntry[];
}

type SlotRedis = {
  hSet?: (key: string, field: string, value: string) => Promise<unknown>;
  hGetAll?: (key: string) => Promise<Record<string, string>>;
  hDel?: (key: string, fields: string | string[]) => Promise<unknown>;
};

export function workerSlotRegistryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKER_SLOT_REGISTRY_DISABLED === '1';
}

/** Slots a MACHINE-origin run can claim on a worker of `concurrency` slots (worker.ts `lastSlot` reserve). */
export function machineClaimableSlots(concurrency: number): number {
  if (!Number.isFinite(concurrency) || concurrency <= 0) return 0;
  const c = Math.floor(concurrency);
  return c > 1 ? c - 1 : c;
}

/** Stable box label: BOX_NAME from the box's env overrides, else the container hostname (infra-watch's rule). */
export function workerBoxLabel(env: NodeJS.ProcessEnv = process.env, hostname: string = os.hostname()): string {
  const v = String(env.BOX_NAME || '').trim();
  return v || hostname.slice(0, 12);
}

export function buildWorkerSlotEntry(input: { workerId: string; concurrency: number; box?: string; now?: Date }): WorkerSlotEntry {
  const concurrency = Number.isFinite(input.concurrency) && input.concurrency > 0 ? Math.floor(input.concurrency) : 0;
  return {
    workerId: input.workerId,
    box: input.box ?? workerBoxLabel(),
    concurrency,
    machineSlots: machineClaimableSlots(concurrency),
    at: (input.now ?? new Date()).toISOString(),
  };
}

function parseEntry(field: string, raw: unknown): WorkerSlotEntry | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    const concurrency = Number(p.concurrency);
    const at = typeof p.at === 'string' ? p.at : '';
    if (!Number.isFinite(concurrency) || concurrency <= 0 || !Number.isFinite(Date.parse(at))) return null;
    const machineSlots = Number.isFinite(Number(p.machineSlots)) && Number(p.machineSlots) >= 0
      ? Math.floor(Number(p.machineSlots))
      : machineClaimableSlots(concurrency);
    const box = typeof p.box === 'string' && p.box.trim() ? p.box.trim() : field;
    return { workerId: typeof p.workerId === 'string' && p.workerId ? p.workerId : field, box, concurrency: Math.floor(concurrency), machineSlots, at };
  } catch {
    return null;
  }
}

/**
 * Pure fold of the registry hash: fresh entries only, the NEWEST per box,
 * boxes summed. `null` when no fresh entry exists (nothing published, every
 * worker dead, or only 0-slot workers — which never publish).
 */
export function liveWorkerSlotsFromHash(raw: Record<string, string> | null | undefined, now: number = Date.now(), freshMs: number = WORKER_SLOTS_FRESH_MS): LiveWorkerSlots | null {
  if (!raw || typeof raw !== 'object') return null;
  const fresh: WorkerSlotEntry[] = [];
  for (const [field, value] of Object.entries(raw)) {
    const e = parseEntry(field, value);
    if (!e) continue;
    const age = now - Date.parse(e.at);
    if (age > freshMs) continue; // a future-stamped entry (clock skew) counts as fresh — fail-open
    fresh.push(e);
  }
  if (!fresh.length) return null;
  const newestPerBox = new Map<string, WorkerSlotEntry>();
  for (const e of fresh) {
    const cur = newestPerBox.get(e.box);
    if (!cur || Date.parse(e.at) > Date.parse(cur.at)) newestPerBox.set(e.box, e);
  }
  let slots = 0;
  let rawSlots = 0;
  for (const e of newestPerBox.values()) { slots += e.machineSlots; rawSlots += e.concurrency; }
  if (slots <= 0) return null;
  return { slots, rawSlots, workers: fresh.length, boxes: newestPerBox.size, entries: [...newestPerBox.values()] };
}

/** One line for refusal text / status: "32 slot(s) − the interactive reserve = 31 machine slot(s) on 1 worker / 1 box". */
export function describeLiveWorkerSlots(view: LiveWorkerSlots): string {
  const reserve = view.rawSlots - view.slots;
  const head = reserve > 0
    ? `${view.rawSlots} worker slot(s) − ${reserve} interactive reserve = ${view.slots} machine-claimable slot(s)`
    : `${view.slots} machine-claimable worker slot(s)`;
  return `${head} on ${view.workers} live worker(s) / ${view.boxes} box(es): ${view.entries.map(e => `${e.box}=${e.concurrency}`).join(', ')}`;
}

/** The shared client, resolved ONCE per process (the dynamic import keeps this leaf side-effect-free to import). */
let slotRedisPromise: Promise<SlotRedis | null> | null = null;
function slotRedis(): Promise<SlotRedis | null> {
  if (!slotRedisPromise) {
    slotRedisPromise = import('../../../config/redis')
      .then((mod: any) => {
        const client = mod?.default;
        return client && typeof client === 'object' ? (client as SlotRedis) : null;
      })
      .catch(() => null);
  }
  return slotRedisPromise;
}

/** Test seam: forget the cached client (a test that re-mocks config/redis). */
export function __resetWorkerSlotsRedisForTest(): void {
  slotRedisPromise = null;
}

let lastWarnAt = 0;
async function warnThrottled(message: string): Promise<void> {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  try {
    const { default: logger } = await import('../../../utils/logger');
    logger.warn(`worker-slots: ${message}`);
  } catch { /* logging never throws */ }
}

/**
 * Publish this worker's slots (HSET) and prune fields older than
 * WORKER_SLOTS_PRUNE_MS. A 0-slot worker publishes NOTHING (it holds no
 * slots; its presence must not count). Returns whether a write happened.
 * Never throws.
 */
export async function publishWorkerSlots(input: { workerId: string; concurrency: number; box?: string; now?: Date }, redis?: SlotRedis | null): Promise<boolean> {
  if (workerSlotRegistryDisabled()) return false;
  const entry = buildWorkerSlotEntry(input);
  if (entry.concurrency <= 0) return false;
  const client = redis === undefined ? await slotRedis() : redis;
  if (!client || typeof client.hSet !== 'function') return false;
  try {
    await client.hSet(WORKER_SLOTS_KEY, entry.workerId, JSON.stringify(entry));
  } catch (err: any) {
    await warnThrottled(`publish failed for ${entry.workerId} (fail-open — readers fall back to env / default): ${err?.message ?? err}`);
    return false;
  }
  // Prune: fields no live worker refreshes (a replaced container's pid) — bounded growth.
  try {
    if (typeof client.hGetAll === 'function' && typeof client.hDel === 'function') {
      const raw = await client.hGetAll(WORKER_SLOTS_KEY);
      const now = (input.now ?? new Date()).getTime();
      const stale: string[] = [];
      for (const [field, value] of Object.entries(raw ?? {})) {
        if (field === entry.workerId) continue;
        const e = parseEntry(field, value);
        if (!e || now - Date.parse(e.at) > WORKER_SLOTS_PRUNE_MS) stale.push(field);
      }
      if (stale.length) await client.hDel(WORKER_SLOTS_KEY, stale);
    }
  } catch { /* prune is best-effort — a stale field is ignored by readers anyway */ }
  return true;
}

/** Remove this worker's entry (stop / drain). Never throws. */
export async function clearWorkerSlots(workerId: string, redis?: SlotRedis | null): Promise<void> {
  const client = redis === undefined ? await slotRedis() : redis;
  if (!client || typeof client.hDel !== 'function') return;
  try { await client.hDel(WORKER_SLOTS_KEY, workerId); } catch { /* best-effort — the entry ages out */ }
}

/**
 * The fleet's live machine-claimable slot count, or null when the registry
 * is disabled, empty, stale or unreadable (the caller falls back). Never
 * throws.
 */
export async function readLiveWorkerSlots(redis?: SlotRedis | null, now: number = Date.now()): Promise<LiveWorkerSlots | null> {
  if (workerSlotRegistryDisabled()) return null;
  const client = redis === undefined ? await slotRedis() : redis;
  if (!client || typeof client.hGetAll !== 'function') return null;
  try {
    const raw = await client.hGetAll(WORKER_SLOTS_KEY);
    return liveWorkerSlotsFromHash(raw, now);
  } catch (err: any) {
    await warnThrottled(`read failed (fail-open — env / default ceiling applies): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Per-process publisher for startWorker: publishes at once and every
 * `intervalMs`; the returned stop() is SYNCHRONOUS (the startBoxHealthReporter
 * shape — stop() / drain() must not wait on Redis to hand off): it clears the
 * interval and fires the entry's removal best-effort (an unanswered HDEL
 * ages out of readers in WORKER_SLOTS_FRESH_MS anyway). A 0-slot worker gets
 * a no-op (nothing to publish, nothing to clear).
 */
export function startWorkerSlotPublisher(input: { workerId: string; concurrency: number; box?: string; intervalMs?: number }): () => void {
  if (workerSlotRegistryDisabled() || !(input.concurrency > 0)) return () => {};
  const box = input.box ?? workerBoxLabel();
  const publish = () => { void publishWorkerSlots({ workerId: input.workerId, concurrency: input.concurrency, box }); };
  publish();
  const timer = setInterval(publish, input.intervalMs ?? WORKER_SLOTS_PUBLISH_MS);
  (timer as any).unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    void clearWorkerSlots(input.workerId);
  };
}
