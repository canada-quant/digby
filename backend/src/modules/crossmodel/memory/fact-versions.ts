/**
 * Fact versions — value history for user-memory facts (2026-10-20 memory upgrade).
 *
 * WHY: the canonical user_memory.facts blob ({key: value}) is rewritten by the
 * turn extractor, the rebuild, the nightly dream, the Memory tab and the
 * remember/forget tools — and every write OVERWROTE or DELETED a fact with no
 * history, no per-fact timestamp and no source chat. "When did Digby learn I
 * moved?" and "which of these two facts is newer?" had no answer, so neither the
 * extractor nor the dream could judge recency.
 *
 * WHAT: an append-mostly history table (user_memory_fact_versions). Every blob
 * writer calls recordFactVersions(before, after) AFTER its blob write succeeded:
 *   - a new key            → an OPEN version (validTo NULL) is inserted;
 *   - a changed value      → the open version is CLOSED (endedReason 'replaced',
 *                            replacedBy = the new value) and a new open version
 *                            inserted — the old value is kept, not overwritten;
 *   - a removed key        → removal 'purge' DELETES every version of the key
 *                            (a user-intent forget — forget_fact, the Memory tab,
 *                            the extractor's grounded remove/reject — must really
 *                            forget); removal 'supersede' (dream consolidation)
 *                            closes it as 'consolidated', replacedBy `key:<into>`
 *                            when the dream merged it into another key.
 * Facts that predate this table have no open version: when one changes or is
 * consolidated, a 'backfill' version is created lazily first (validFrom = the
 * user_memory_facts row's createdAt when available) so the replacement links.
 *
 * The blob stays CANONICAL — every guard (rejections, name rule, dream guards)
 * still operates on it; this table is history + per-fact metadata only.
 *
 * Never throws (background memory code). Kill switch FACT_VERSIONS_DISABLED=1:
 * no reads, no writes, and the prompts that render "(since …)" dates are
 * byte-identical to before.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { stripPgUnsafe } from './text-utils';

export function factVersionsEnabled(): boolean {
  return process.env.FACT_VERSIONS_DISABLED !== '1';
}

export type FactVersionRemoval = 'purge' | 'supersede';
export type FactVersionEndedReason = 'replaced' | 'consolidated';

/** Per-fact metadata from the open (current) version. `since` is an ISO timestamp. */
export interface FactMeta {
  since: string;
  source: string;
  sourceChatId: string | null;
}
export type FactMetaMap = Record<string, FactMeta>;

export interface FactVersionRow {
  id: string;
  key: string;
  value: string;
  source: string;
  sourceChatId: string | null;
  validFrom: Date;
  validTo: Date | null;
  endedReason: string | null;
  replacedBy: string | null;
  createdAt: Date;
}

export interface RecordFactVersionsInput {
  userId: string;
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  /** turn | rebuild | dream | api | tool | profile | … */
  source: string;
  chatId?: string | null;
  /** How a key that disappeared from the blob is recorded. */
  removal: FactVersionRemoval;
  /** dream merges: removed key → the key it was merged into (replacedBy `key:<into>`). */
  mergedInto?: Record<string, string>;
  /** Removed keys that are DELETED regardless of `removal` (a dream scrub of a banned topic is a user forget). */
  purgeKeys?: string[];
}

export interface FactVersionWriteSummary {
  opened: number;
  closed: number;
  purgedKeys: number;
  backfilled: number;
}

/** A stored value is capped — a fact is a sentence, never a transcript. The SAME
 *  normalisation runs on both sides of every comparison, so a capped value never churns. */
export const FACT_VERSION_VALUE_MAX = 8000;
const KEY_MAX = 512;
const SOURCE_MAX = 40;

/** The rule line added to prompts that render "(since …)" dates. */
export const FACT_RECENCY_RULE = '"(since YYYY-MM-DD)" is when a fact was stored — when two facts conflict, the newer one is the current state.';

function normValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (!s.trim()) return null;
  return stripPgUnsafe(s).slice(0, FACT_VERSION_VALUE_MAX);
}

/** The VISIBLE facts of a blob as normalised strings (internal `__` keys and empty values skipped — what every reader shows). */
export function visibleFactValues(facts: Record<string, unknown> | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return out;
  for (const [k, v] of Object.entries(facts)) {
    if (k.startsWith('__')) continue;
    const key = stripPgUnsafe(k).slice(0, KEY_MAX);
    if (!key.trim()) continue;
    const value = normValue(v);
    if (value === null) continue;
    out.set(key, value);
  }
  return out;
}

/** Model handle, or null when the Prisma client (or a test double) has no such model. */
function versionsModel(): any | null {
  const m = (prisma as any)?.userMemoryFactVersion;
  return m && typeof m.findMany === 'function' ? m : null;
}

/**
 * Record the version changes between two blob states. Call AFTER the blob write
 * succeeded, fire-and-forget (`void recordFactVersions(...)`). Never throws;
 * returns null when disabled / nothing changed / the write failed.
 */
export function recordFactVersions(input: RecordFactVersionsInput): Promise<FactVersionWriteSummary | null> {
  if (!factVersionsEnabled() || !input?.userId) return Promise.resolve(null);
  // Serialize per user within this process: two writers that finish close together
  // (a turn's extraction + a remember_fact) must not both read the same open row.
  const userId = input.userId;
  const prev = userChains.get(userId) ?? Promise.resolve(null);
  const run = prev.then(() => writeFactVersions(input), () => writeFactVersions(input));
  userChains.set(userId, run);
  void run.then(() => { if (userChains.get(userId) === run) userChains.delete(userId); });
  return run;
}

const userChains = new Map<string, Promise<FactVersionWriteSummary | null>>();

async function writeFactVersions(input: RecordFactVersionsInput): Promise<FactVersionWriteSummary | null> {
  try {
    const model = versionsModel();
    if (!model) return null;
    const userId = input.userId;
    const source = String(input.source || 'unknown').slice(0, SOURCE_MAX);
    const chatId = typeof input.chatId === 'string' && input.chatId.trim() ? input.chatId : null;
    const b = visibleFactValues(input.before);
    const a = visibleFactValues(input.after);

    const touched: string[] = [];
    for (const [k, v] of a) if (b.get(k) !== v) touched.push(k); // added or changed
    for (const k of b.keys()) if (!a.has(k)) touched.push(k);    // removed
    if (!touched.length) return null;

    const purgeSet = new Set((input.purgeKeys ?? []).filter((k) => typeof k === 'string'));
    const isPurge = (k: string) => input.removal === 'purge' || purgeSet.has(k);
    const removedKeys = touched.filter((k) => !a.has(k));
    const purgedKeys = removedKeys.filter(isPurge);
    const keysNeedingOpen = touched.filter((k) => !purgedKeys.includes(k));

    // One round trip for both reads, issued before the fire-and-forget index sync
    // (syncUserFactRows) can delete a removed key's row and lose its createdAt.
    const backfillCandidates = keysNeedingOpen.filter((k) => b.has(k));
    const factIndex = (prisma as any)?.userMemoryFact;
    const [openRows, indexRows] = await Promise.all([
      keysNeedingOpen.length
        ? model.findMany({ where: { userId, key: { in: keysNeedingOpen }, validTo: null }, select: { id: true, key: true, value: true, validFrom: true }, orderBy: { validFrom: 'desc' } })
        : Promise.resolve([]),
      backfillCandidates.length && factIndex && typeof factIndex.findMany === 'function'
        ? factIndex.findMany({ where: { userId, key: { in: backfillCandidates } }, select: { key: true, createdAt: true } }).catch(() => [])
        : Promise.resolve([]),
    ]);
    const openByKey = new Map<string, Array<{ id: string; value: string }>>();
    for (const r of (openRows as any[]) || []) {
      if (!r || typeof r.key !== 'string') continue;
      const list = openByKey.get(r.key) ?? [];
      list.push({ id: String(r.id), value: String(r.value ?? '') });
      openByKey.set(r.key, list);
    }
    const indexCreatedAt = new Map<string, Date>();
    for (const r of (indexRows as any[]) || []) {
      if (r && typeof r.key === 'string' && r.createdAt) indexCreatedAt.set(r.key, new Date(r.createdAt));
    }

    const now = new Date();
    const ops: any[] = [];
    const creates: any[] = [];
    let closed = 0;
    let backfilled = 0;

    if (purgedKeys.length) ops.push(model.deleteMany({ where: { userId, key: { in: purgedKeys } } }));

    for (const key of keysNeedingOpen) {
      const target = a.get(key); // undefined = removed under 'supersede'
      const open = openByKey.get(key) ?? [];
      const ended: FactVersionEndedReason = target === undefined ? 'consolidated' : 'replaced';
      const into = input.mergedInto?.[key];
      const replacedBy = target !== undefined ? target : (typeof into === 'string' && into.trim() ? `key:${stripPgUnsafe(into).slice(0, KEY_MAX)}` : null);

      // The open version already holding the target value stays open (a re-sync, never a churn).
      const keep = target !== undefined ? open.find((o) => o.value === target) : undefined;
      const toClose = open.filter((o) => o !== keep).map((o) => o.id);
      if (toClose.length) {
        ops.push(model.updateMany({ where: { id: { in: toClose } }, data: { validTo: now, endedReason: ended, replacedBy } }));
        closed += toClose.length;
      }
      // A fact that predates this table: create its version lazily (already closed) so the replacement links.
      const prev = b.get(key);
      if (!open.length && prev !== undefined) {
        const from = indexCreatedAt.get(key);
        creates.push({
          userId, key, value: prev, source: 'backfill', sourceChatId: null,
          validFrom: from && !Number.isNaN(from.getTime()) && from.getTime() <= now.getTime() ? from : now,
          validTo: now, endedReason: ended, replacedBy,
        });
        backfilled += 1;
        closed += 1;
      }
      if (target !== undefined && !keep) {
        creates.push({ userId, key, value: target, source, sourceChatId: chatId, validFrom: now });
      }
    }
    const opened = creates.filter((c) => !c.validTo).length;
    if (creates.length) ops.push(model.createMany({ data: creates }));
    if (!ops.length) return null;

    const tx = (prisma as any).$transaction;
    if (typeof tx === 'function') await tx.call(prisma, ops);
    else await Promise.all(ops);
    return { opened, closed, purgedKeys: purgedKeys.length, backfilled };
  } catch (err: any) {
    logger.debug(`fact-versions: recordFactVersions failed for ${input?.userId} (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}

/** Delete every version of every fact (clear memory). Never throws. */
export async function purgeAllFactVersions(userId: string): Promise<number> {
  if (!factVersionsEnabled()) return 0;
  try {
    const model = versionsModel();
    if (!model || !userId) return 0;
    const r = await model.deleteMany({ where: { userId } });
    return Number(r?.count ?? 0);
  } catch (err: any) {
    logger.debug(`fact-versions: purgeAllFactVersions failed for ${userId} (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * key → { since, source, sourceChatId } from the OPEN versions. A key with no
 * open version (a fact that predates this table) falls back to its
 * user_memory_facts row's createdAt with source 'backfill' — the same anchor the
 * lazy backfill would give it. Returns {} when disabled or on any failure.
 */
export async function getFactMeta(userId: string): Promise<FactMetaMap> {
  if (!factVersionsEnabled()) return {};
  try {
    const model = versionsModel();
    if (!model || !userId) return {};
    const factIndex = (prisma as any)?.userMemoryFact;
    const [open, index] = await Promise.all([
      model.findMany({ where: { userId, validTo: null }, select: { key: true, validFrom: true, source: true, sourceChatId: true }, orderBy: { validFrom: 'desc' } }),
      factIndex && typeof factIndex.findMany === 'function'
        ? factIndex.findMany({ where: { userId }, select: { key: true, createdAt: true } }).catch(() => [])
        : Promise.resolve([]),
    ]);
    const out: FactMetaMap = {};
    for (const r of (open as any[]) || []) {
      if (!r || typeof r.key !== 'string' || out[r.key]) continue; // newest open wins (desc)
      const since = toIso(r.validFrom);
      if (!since) continue;
      out[r.key] = { since, source: String(r.source ?? ''), sourceChatId: r.sourceChatId ?? null };
    }
    for (const r of (index as any[]) || []) {
      if (!r || typeof r.key !== 'string' || out[r.key]) continue;
      const since = toIso(r.createdAt);
      if (since) out[r.key] = { since, source: 'backfill', sourceChatId: null };
    }
    return out;
  } catch (err: any) {
    logger.debug(`fact-versions: getFactMeta failed for ${userId} (non-fatal): ${err?.message ?? err}`);
    return {};
  }
}

/** Version history, newest first (optionally one key). Returns [] when disabled or on failure. */
export async function getFactHistory(userId: string, key?: string, limit = 50): Promise<FactVersionRow[]> {
  if (!factVersionsEnabled()) return [];
  try {
    const model = versionsModel();
    if (!model || !userId) return [];
    const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    const rows = await model.findMany({
      where: { userId, ...(typeof key === 'string' && key ? { key } : {}) },
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
      take,
    });
    return (rows as FactVersionRow[]) || [];
  } catch (err: any) {
    logger.debug(`fact-versions: getFactHistory failed for ${userId} (non-fatal): ${err?.message ?? err}`);
    return [];
  }
}

function toIso(d: unknown): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** " (since YYYY-MM-DD)" for a fact, or '' when unknown. */
export function factSinceSuffix(meta: FactMetaMap | null | undefined, key: string): string {
  const since = meta?.[key]?.since;
  return since && /^\d{4}-\d{2}-\d{2}/.test(since) ? ` (since ${since.slice(0, 10)})` : '';
}

/** key → "YYYY-MM-DD" for read surfaces (list_memory). */
export function factSinceDates(meta: FactMetaMap | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, m] of Object.entries(meta || {})) if (m?.since) out[k] = m.since.slice(0, 10);
  return out;
}
