/**
 * Context Store — namespaced JSONB key-value persistence for memory/context state.
 *
 * Replaces @langchain/langgraph-checkpoint-postgres PostgresStore (removed 2026-07-10).
 * Same physical table ("store") and the same ":"-joined namespace encoding, so every
 * pre-existing production row is read/written unchanged:
 *   [userId, 'memory']    / 'contextState' → UserContextState
 *   [projectId, 'context'] / 'state'       → ProjectContextState
 *   [projectId, 'settings'] / 'state'      → ProjectSettings
 *   [chatId, 'thread']    / 'state'        → ConversationThreadState
 *   [feedId, 'feed']      / 'contextState' → feed context state
 *
 * Runs on the shared Prisma connection pool — the old store maintained its own
 * separate pg pool (the one that had to be hand-capped at max:8).
 *
 * SPLIT-READY BOUNDARY: this module is the only access path to the store table,
 * and its queries never join app-core tables. Moving the memory domain to a
 * dedicated Postgres later means pointing this module at a different client.
 */

import prisma from '../../../config/database';

function nsPath(namespace: string[]): string {
  return namespace.join(':');
}

/**
 * Read a value. Returns null when absent or expired (TTL parity with the old
 * PostgresStore — no current caller sets expiresAt, but old rows might carry it).
 */
export async function storeGet<T>(namespace: string[], key: string): Promise<T | null> {
  const row = await prisma.contextStoreEntry.findUnique({
    where: { namespacePath_key: { namespacePath: nsPath(namespace), key } },
    select: { value: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  return row.value as T;
}

/**
 * Batched read of many keys under ONE namespace (CI-WATCH 2026-10-20: the
 * 5-min ci-watch cron reads one verdict row per candidate sha — one query, not
 * hundreds). Missing / expired keys are simply absent from the returned map.
 */
export async function storeGetMany<T>(namespace: string[], keys: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const uniq = [...new Set(keys.filter((k) => typeof k === 'string' && k.length > 0))];
  if (!uniq.length) return out;
  const rows = await prisma.contextStoreEntry.findMany({
    where: { namespacePath: nsPath(namespace), key: { in: uniq } },
    select: { key: true, value: true, expiresAt: true },
  });
  const now = Date.now();
  for (const r of rows) {
    if (r.expiresAt && r.expiresAt.getTime() < now) continue;
    out.set(r.key, r.value as T);
  }
  return out;
}

/**
 * List the rows of ONE namespace, oldest first, bounded. Two callers
 * (2026-10-20): the owner-decision digest queue + reversible-default index
 * (OWNER-INTERRUPT-ECONOMY — one row per queued card so concurrent flags never
 * race a read-modify-write) and the merge-intent / condition-wake cron
 * (MERGE-INTENT-AWAIT — a handful of open rows). `limit` (a number or
 * `{ limit }`) is clamped to [1, 1000]; expired rows are skipped.
 */
export async function storeListNamespace<T>(
  namespace: string[],
  opts: number | { limit?: number } = {}
): Promise<Array<{ key: string; value: T; createdAt: Date | null; updatedAt: Date | null }>> {
  const raw = Math.round(Number(typeof opts === 'number' ? opts : (opts.limit ?? 200)));
  const take = Math.max(1, Math.min(Number.isFinite(raw) ? raw : 200, 1000));
  const rows = await prisma.contextStoreEntry.findMany({
    where: { namespacePath: nsPath(namespace) },
    orderBy: { createdAt: 'asc' },
    take,
    select: { key: true, value: true, createdAt: true, updatedAt: true, expiresAt: true },
  });
  const now = Date.now();
  const out: Array<{ key: string; value: T; createdAt: Date | null; updatedAt: Date | null }> = [];
  for (const r of rows) {
    if (r.expiresAt && r.expiresAt.getTime() < now) continue;
    out.push({ key: r.key, value: r.value as T, createdAt: r.createdAt ?? null, updatedAt: r.updatedAt ?? null });
  }
  return out;
}

/**
 * Delete every row of ONE namespace last written before `before` (CI-WATCH
 * 2026-10-20: the ci-watch verdict rows only matter inside the 24 h receipt
 * window, so the cron prunes its own namespace). Rows with no updatedAt are
 * judged on createdAt. Returns the deleted count.
 */
export async function storePruneNamespace(namespace: string[], before: Date): Promise<number> {
  const res = await prisma.contextStoreEntry.deleteMany({
    where: {
      namespacePath: nsPath(namespace),
      OR: [{ updatedAt: { lt: before } }, { updatedAt: null, createdAt: { lt: before } }],
    },
  });
  return res.count;
}

/** Upsert a value under [namespace, key]. */
export async function storePut(
  namespace: string[],
  key: string,
  value: Record<string, unknown>,
  opts: { ttlMs?: number } = {},
): Promise<void> {
  const namespacePath = nsPath(namespace);
  const expiresAt = opts.ttlMs && opts.ttlMs > 0 ? new Date(Date.now() + opts.ttlMs) : null;
  await prisma.contextStoreEntry.upsert({
    where: { namespacePath_key: { namespacePath, key } },
    create: { namespacePath, key, value: value as any, ...(expiresAt ? { expiresAt } : {}) },
    update: { value: value as any, updatedAt: new Date(), ...(expiresAt ? { expiresAt } : {}) },
  });
}

/**
 * Atomically RAISE one numeric top-level field of an existing JSON-object row
 * to `value` — and touch nothing else (2026-10-22, fs-durable-memory review:
 * the thread-counter bookkeeping used to storePut the WHOLE thread state it had
 * loaded at the start of the turn, clobbering a newer threadSummary /
 * openTopics an overlapping extraction saved in between). One UPDATE statement
 * (`jsonb_set` on the stored value), so no read-modify-write window; the field
 * only ever moves UP (a row already holding `value` or more — a concurrent
 * save got there first — is left alone). No row, a non-object value or a
 * non-finite `value` ⇒ nothing written. Returns true when the row was updated.
 */
export async function storeAdvanceNumberField(
  namespace: string[],
  key: string,
  field: string,
  value: number
): Promise<boolean> {
  if (!field || !Number.isFinite(value)) return false;
  const n = Math.floor(value);
  const updated = await prisma.$executeRaw`UPDATE "store"
    SET "value" = jsonb_set("value", ARRAY[${field}::text], to_jsonb(${n}::int), true), "updated_at" = now()
    WHERE "namespace_path" = ${nsPath(namespace)} AND "key" = ${key}
      AND jsonb_typeof("value") = 'object'
      AND (CASE WHEN jsonb_typeof("value" -> ${field}::text) = 'number' THEN ("value" ->> ${field}::text)::numeric ELSE -1 END) < ${n}::int`;
  return Number(updated) > 0;
}

/**
 * Escape a literal for a SQL LIKE pattern (Postgres' default escape char is
 * the backslash). Prisma 7's `startsWith` hands its argument to LIKE
 * UNESCAPED — verified 2026-10-23 on Postgres 16 with the Prisma 7.10 client + the pg
 * adapter: `startsWith: '%%%%%%%%'` and `startsWith: '________'` each matched
 * every row, and `startsWith: 'a\\bc'` matched 'abc…'. Pure.
 */
export function escapeLikeLiteral(s: string): string {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Rows of SEVERAL namespaces whose key starts with `keyPrefix` (2026-10-22,
 * fs-durable-memory: resolving a directive id / prefix against the supervisor
 * ledgers' cold closed-row archives — one row per directive id). Bounded
 * (`limit` clamped to [1, 200]); expired rows skipped. `keyPrefix` is matched
 * LITERALLY: its `\`, `%` and `_` are escaped before Prisma's `startsWith`
 * (which does NOT escape them — see escapeLikeLiteral), and every returned
 * key is re-checked with a plain `startsWith` in JS.
 */
export async function storeFindByKeyPrefix<T>(
  namespaces: string[][],
  keyPrefix: string,
  limit = 20
): Promise<Array<{ namespace: string; key: string; value: T }>> {
  const paths = [...new Set(namespaces.map(nsPath))];
  if (!paths.length || !keyPrefix) return [];
  const take = Math.max(1, Math.min(Math.floor(limit) || 20, 200));
  const rows = await prisma.contextStoreEntry.findMany({
    where: { namespacePath: { in: paths }, key: { startsWith: escapeLikeLiteral(keyPrefix) } },
    take,
    select: { namespacePath: true, key: true, value: true, expiresAt: true },
  });
  const now = Date.now();
  return rows
    .filter((r) => typeof r.key === 'string' && r.key.startsWith(keyPrefix))
    .filter((r) => !(r.expiresAt && r.expiresAt.getTime() < now))
    .map((r) => ({ namespace: r.namespacePath, key: r.key, value: r.value as T }));
}

// ── Chat-keyed namespaces a deleted chat must not outlive (2026-10-23) ───────
// The store has no FK to the chat table (SPLIT-READY: no join to app-core
// tables), so deleting a chat — or the account that owns it — leaves its
// chat-keyed rows behind. These two hold the chat's own words: the thread
// summary / open topics ([chatId,'thread']) and the supervisor ledger's cold
// closed-row archive ([chatId,'supervisor-archive'] — owner directive text +
// evidence, up to 180 rows). storeDeleteChatScoped clears them on: the chat
// delete (crossmodel.service deleteChat), the project delete's coding-chat
// cascade (platform.service deleteProject — projects.controller, the platform
// route, the delete_project tool), the legacy /coding project delete
// (coding-data deleteCodingProjectData), deleteCodingChatData and both account
// deletes — self-service (auth.service deleteAccount) and the admin hard
// delete (crossmodel.controller adminDeleteUser), which share
// auth.service purgeUserAccount since review 2026-10-23 (the admin path was a
// raw FK cascade). A supervisor write racing a delete:
// each path above purges AFTER its chat rows are gone (the two transactional
// ones sweep in the transaction and again after the commit), and a write
// that lands later fails on the chat FK and purges its own cold rows
// (supervisor-state.service upsertDoc) / re-checks the chat after a mirror
// write (supervisor-state-memory enqueue*Embed); a late thread save re-checks
// the chat too (memory.graph saveThreadState). Exact namespace paths, so the
// delete rides the (namespace_path, key) primary key — no prefix scan.
/** The supervisor ledger's cold-archive namespace kind ([chatId, this]). */
export const SUPERVISOR_ARCHIVE_STORE_KIND = 'supervisor-archive';
/**
 * A finished background worker's report, spilled so a container replacement
 * cannot destroy work the model already paid for (ticket 458342f5;
 * coding/background-delegation.ts BACKGROUND_SPILL_STORE_KIND — the literal is
 * duplicated here on purpose: this module is the split-ready store boundary and
 * never imports the coding harness).
 */
export const BACKGROUND_REPORT_STORE_KIND = 'background-report';
/** The chat-keyed namespace kinds storeDeleteChatScoped clears. */
export const CHAT_SCOPED_STORE_KINDS: readonly string[] = ['thread', SUPERVISOR_ARCHIVE_STORE_KIND, BACKGROUND_REPORT_STORE_KIND];
/** Namespace paths of `chatIds`' chat-keyed rows (CHAT_SCOPED_STORE_KINDS). Pure. */
export function chatScopedStorePaths(chatIds: ReadonlyArray<string>): string[] {
  const ids = [...new Set((chatIds ?? []).filter((c) => typeof c === 'string' && c.length > 0))];
  return ids.flatMap((id) => CHAT_SCOPED_STORE_KINDS.map((kind) => nsPath([id, kind])));
}
/** The slice of a Prisma client (or transaction client) storeDeleteChatScoped needs. */
export interface StoreDeleteClient {
  contextStoreEntry: { deleteMany: (args: { where: { namespacePath: { in: string[] } } }) => Promise<{ count: number }> };
}
/**
 * Delete every chat-keyed row (CHAT_SCOPED_STORE_KINDS) of `chatIds`, in
 * chunks of 500 namespace paths. `client` may be a transaction client (account
 * deletion runs it inside its transaction). Returns rows deleted; throws what
 * the client throws (callers outside a transaction catch it — best-effort).
 */
export async function storeDeleteChatScoped(chatIds: ReadonlyArray<string>, client: StoreDeleteClient = prisma as unknown as StoreDeleteClient): Promise<number> {
  const paths = chatScopedStorePaths(chatIds);
  let n = 0;
  for (let i = 0; i < paths.length; i += 500) {
    const res = await client.contextStoreEntry.deleteMany({ where: { namespacePath: { in: paths.slice(i, i + 500) } } });
    n += Number(res?.count ?? 0);
  }
  return n;
}

/**
 * Atomic CLAIM under [namespace, key]: create-only, returning false when the
 * row already exists (Prisma P2002 on the composite PK). This is the durable
 * at-most-once primitive for dispatch/closure flows (ticket-dispatch,
 * closure-manifest) — unlike check-then-put there is no window between the
 * read and the write.
 */
export async function storeCreate(
  namespace: string[],
  key: string,
  value: Record<string, unknown>
): Promise<boolean> {
  try {
    await prisma.contextStoreEntry.create({
      data: { namespacePath: nsPath(namespace), key, value: value as any },
    });
    return true;
  } catch (err: any) {
    if (err?.code === 'P2002') return false; // already claimed
    throw err;
  }
}

/** Delete a value under [namespace, key] (idempotent). Rolls back a failed claim. */
export async function storeDelete(namespace: string[], key: string): Promise<void> {
  await prisma.contextStoreEntry.deleteMany({
    where: { namespacePath: nsPath(namespace), key },
  });
}
