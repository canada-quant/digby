/**
 * Supervisor-state → digby_memory bridge (ticket 2b8508cb, 2026-10-18).
 *
 * The wake block (formatStateForWake) is a 6000-char WINDOW: on a busy
 * supervisor the trim ladder drops oldest dispatches first, then notes,
 * project lines, refutations, non-standing directives and — last — asks.
 * Nothing evicted is deleted (get_supervisor_state reads the full doc), but
 * the wake never sees it again and the transcript is dieted to 24 messages,
 * so a dropped dispatch was effectively forgotten between wakes.
 *
 * This module embeds the durable doc rows as digby_memory rows under source
 * `supervisor_state` in the chat's OWN chat scope, so the per-turn retrieval
 * (retrieveSupervisorLearnings already carries session+chat scopes into
 * memSearchProjectsBlended) and search_memory can surface them RELEVANTLY
 * instead of the wake block showing them chronologically-if-they-fit. One
 * row per directive (live + archived) and per dispatch — replace-by-ref, so
 * the store mirrors the doc at all times and NEVER grows a duplicate.
 *
 * SEPARATE module (not in supervisor-state.service.ts): that file is a LEAF
 * (prisma + logger only — static-import-safe from the chat-agent run-start
 * path), and unified-memory pulls rag.service → utility-llm + axios. It is
 * therefore DYNAMICALLY imported at each seam, exactly like
 * loop-metrics.service / run-journal.service in the same flows, so suites
 * that exercise the write path without mocking the memory store see a
 * failed dynamic import degrade to a log line instead of a worker crash
 * (the 2026-09-21 liveness-suite class).
 *
 * Every export is TOTAL: a store failure logs and returns 0 — a memory hiccup
 * must never fail a state-doc write (the doc stays the source of truth).
 * Kill switch SUPERVISOR_STATE_MEMORY_DISABLED=1 disables the write side.
 */

import { createHash } from 'crypto';
import logger from '../../../utils/logger';
import type { SupervisorDirective, SupervisorStateDoc } from './supervisor-state.service';
import type { KpiView } from './kpi-of-record';
import { memClear, memDeleteRefs, memListRefs, memReplaceRef, memSearch, memStore, type MemHit, type MemItem, type MemScope } from '../memory/unified-memory.service';

/** digby_memory source tag for embedded supervisor-state rows. */
export const SUPERVISOR_STATE_MEM_SOURCE = 'supervisor_state';
/** The single replace-by-ref ref for the whole doc (the legacy batch mirror; per-row refs since MIND-HYGIENE). */
export const SUPERVISOR_STATE_MEM_REF = 'supervisor-state';
/** Kill switch: SUPERVISOR_STATE_MEMORY_DISABLED=1 stops the embed side. */
export function supervisorStateMemoryDisabled(): boolean {
  return process.env.SUPERVISOR_STATE_MEMORY_DISABLED === '1';
}
/** Twin of supervisor-state.service's supervisorLedgerArchiveAnsweredDisabled (that module imports this one dynamically — no static import back). */
function archiveAnsweredDisabled(): boolean {
  return process.env.SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED === '1';
}

// ── MIND-HYGIENE recall (2026-10-20) ─────────────────────────────────────────
// Three defects made the [SUPERVISOR STATE (retrieved)] block mostly noise:
//  1. The machine-wake query was the wake's trigger text — for a stock sweep
//     the SAME constant prompt every time, so the same rows came back every
//     sweep whatever had changed. The query is now the rendered ledger diff
//     ([SINCE YOUR LAST WAKE] — what actually moved), falling back to the
//     trigger text when the diff is empty or absent (recallQueryFromLedgerDiff).
//  2. Most hits were rows the wake block above ALREADY showed. A hit is now
//     rendered only when its row is NOT visible in the composed wake (trimmed
//     for space, archived, or closed) — the recall exists for what the window
//     dropped (supervisorStateRowVisible).
//  3. memReplaceRef stamped every row with the batch ref and ONE created_at,
//     so "newest first" and the store's age decay were meaningless (every
//     write re-stamped the whole doc as new). Rows are now stored under
//     CONTENT-ADDRESSED per-row refs ('<kind> <id> @<row time> #<hash>'): an
//     unchanged row is never rewritten (it keeps its own created_at), a
//     changed row gets a new ref, a vanished one is deleted, and recall sorts
//     by the row's own time.
// Kill switch SUPERVISOR_RECALL_DIFF_QUERY_DISABLED=1 restores all three
// (trigger-text query, no visibility filter, the batch-ref mirror).
export function supervisorRecallDiffQueryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.SUPERVISOR_RECALL_DIFF_QUERY_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Longest recall query (the memSearch query is clipped to 2000 here too). */
export const SUPERVISOR_RECALL_QUERY_MAX = 2000;

/**
 * The recall query for a machine wake: the [SINCE YOUR LAST WAKE] diff body
 * (its harness heading line, the "Material:" verdict line and the "nothing
 * recorded" line dropped — they carry no row-specific vocabulary), squashed
 * and clipped; the trigger text when the diff is absent or says nothing
 * moved. Pure.
 */
export function recallQueryFromLedgerDiff(ledgerBlock: string | null | undefined, fallback: string): string {
  const body = String(ledgerBlock ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\[SINCE YOUR LAST WAKE/i.test(l) && !/^Material:/i.test(l) && !/^Nothing recorded in the ledger/i.test(l) && !/^\(Read bounds hit/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const q = body.length >= 12 ? body : String(fallback ?? '').trim();
  return q.slice(0, SUPERVISOR_RECALL_QUERY_MAX);
}

/** A row's identity as the mirror stores it — `kind` + the first 24 chars of its id. */
export interface SupervisorStateRowKey { kind: 'directive' | 'dispatch'; id: string }

/**
 * The row identity of a recall hit: the per-row ref ('directive <id> @… #…'),
 * else the legacy batch row's TITLE ('Directive [id8] (…)' / 'Archived
 * directive [id8] …' / 'Dispatch kind → id'). null when neither parses. Pure.
 */
export function supervisorStateRowKeyOfHit(hit: { ref?: string | null; title?: string | null }): SupervisorStateRowKey | null {
  const ref = String(hit?.ref ?? '');
  const m = /^(directive|dispatch|archive) (\S+)/.exec(ref);
  // A cold-archive row ('archive <id> @… #…', 2026-10-22) is a directive row.
  if (m && ref !== SUPERVISOR_STATE_MEM_REF) return { kind: m[1] === 'dispatch' ? 'dispatch' : 'directive', id: m[2] };
  const title = String(hit?.title ?? '');
  const d = /^(?:Archived )?[Dd]irective \[([^\]]+)\]/.exec(title);
  if (d) return { kind: 'directive', id: d[1] };
  const x = /^Dispatch \S+ → (\S+)/.exec(title);
  if (x) return { kind: 'dispatch', id: x[1] };
  return null;
}

/**
 * Is this row already VISIBLE in the composed wake text? A directive line
 * renders as '[<id>] …', a dispatch as '<kind> → <id>'. The key's id may be a
 * PREFIX (the per-row ref keeps 24 chars, a legacy title 8), so an id of ≥ 8
 * chars matches the start of the rendered id; a shorter id must match the
 * whole bracketed / arrowed form, so a 2-char model id never hides a row by
 * coincidence. Only the row's OWN rendering counts — a lane's 8-char prefix
 * in the ledger diff is not the dispatch record. Pure.
 */
export function supervisorStateRowVisible(key: SupervisorStateRowKey, visibleText: string): boolean {
  const id = key.id.trim();
  if (!id || !visibleText) return false;
  const open = key.kind === 'directive' ? `[${id}` : `→ ${id}`;
  if (id.length >= 8) return visibleText.includes(open);
  return key.kind === 'directive' ? visibleText.includes(`[${id}]`) : new RegExp(`→ ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(visibleText);
}

/**
 * Is this directive row one the wake deliberately shows WITHOUT its id, or
 * hides on purpose? The machine wake's [OPEN OWNER ASKS — ANSWER FIRST] block
 * renders open asks as text only (no id), and owner-asks' `hideAskIds` also
 * names asks already answered but not yet closed, which the wake keeps out
 * for 72 h (upward-chatter-1c). Both are "visible" for the recall filter —
 * re-surfacing them as retrieved open directives would undo that suppression
 * (review fix 2026-10-20). Same prefix rule as supervisorStateRowVisible: a
 * key id of ≥ 8 chars matches the start of a hidden id, a shorter one must
 * match it whole. Pure.
 */
export function supervisorStateRowHidden(key: SupervisorStateRowKey, hiddenIds: ReadonlyArray<string> | null | undefined): boolean {
  if (key.kind !== 'directive' || !hiddenIds?.length) return false;
  const id = key.id.trim();
  if (!id) return false;
  return hiddenIds.some((h) => {
    const full = String(h ?? '').trim();
    return !!full && (id.length >= 8 ? full.startsWith(id) : full === id);
  });
}

/**
 * Collapse byte-identical recall hits (same ref, title and content) to the
 * first, keeping memSearch's relevance order. The per-row mirror serializes
 * list → delete → store only IN-PROCESS: a backend owner turn and a worker
 * sweep writing the same supervisor's doc in the same second can each insert
 * the same new ref, and the doubled rows persist until the doc next changes —
 * without this they would spend two of the k slots on one row (review fix
 * 2026-10-20). Pure.
 */
export function dedupeRecallHits<T extends { ref?: string | null; title?: string | null; content?: string | null }>(hits: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of hits ?? []) {
    const key = `${h?.ref ?? ''}\u0000${h?.title ?? ''}\u0000${h?.content ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** The row's own timestamp carried in a per-row ref ('… @<iso> #…'), as epoch ms; null when absent. Pure. */
export function rowAtFromRef(ref: string | null | undefined): number | null {
  const m = /\s@(\S+)\s#/.exec(String(ref ?? ''));
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/**
 * The doc as one MemItem per durable row. Deterministic ORDER (directives
 * oldest→newest, then archived, then dispatches oldest→newest) so the
 * content hash below only changes when a row actually changes; dispatched in
 * the same call every time — memStore's maxChunks cap applies to the WHOLE
 * batch, so the batch must be big enough for the doc's real shape
 * (50 directives + 200 archived + 30 dispatches + 1 header ⇒ 281).
 * `skipGate` rides the store call: rows shorter than the 25-char
 * worthEmbedding floor are curated doc content, exactly the class that gate
 * exists to drop by accident.
 */
export function supervisorStateMemItems(doc: SupervisorStateDoc): MemItem[] {
  if (!doc || typeof doc !== 'object') return [];
  const items: MemItem[] = [];
  const push = (ref: string, title: string, content: string) => {
    if (!content || !content.trim()) return;
    items.push({ ref, title: title.slice(0, 500), content });
  };
  for (const d of doc.directives ?? []) {
    // A row without its identifying pair carries nothing retrievable.
    if (!d?.id || !d?.text) continue;
    push(
      `directive ${String(d.id).slice(0, 24)}`,
      `Directive [${String(d.id).slice(0, 8)}] (${d.status ?? 'open'}${d.standing ? ', standing' : ''}${d.scope ? `, scope: ${d.scope}` : ''})`,
      `Directive ${d.id} (${d.at || 'unknown time'}): ${d.text}${d.evidence ? ` — evidence: ${d.evidence}` : ''} — status: ${d.status ?? 'open'}${d.standing ? ' (standing)' : ''}${d.scope ? ` (scope: ${d.scope})` : ''}${d.messageId ? ` (owner msg ${String(d.messageId).slice(0, 8)})` : ''}`,
    );
  }
  // 2026-10-22: a CLOSED archived row (moved out at the 50-row cap — an
  // answered owner ask, a done order) keeps what closed it and the owner
  // message it came from, so a recall hit can be traced to the reply. Open
  // archived rows render exactly as before (no re-embed churn).
  for (const d of doc.archived ?? []) {
    if (!d?.id || !d?.text) continue;
    const it = archivedDirectiveMemItem(d);
    push(`directive ${String(d.id).slice(0, 24)}`, it.title, it.content);
  }
  for (const x of doc.dispatches ?? []) {
    if (!x?.id) continue;
    push(
      `dispatch ${String(x.id).slice(0, 24)}`,
      `Dispatch ${x.kind} → ${x.id}`,
      `Dispatch ${x.kind} → ${x.id} at ${x.at || 'unknown time'}${x.note ? ` — ${x.note}` : ''} (historical ledger: ran on a prior wake)`,
    );
  }
  return items;
}

/** Title + content of one ARCHIVED directive row (hot or cold) — a closed row carries its evidence + owner msg id. Pure. */
export function archivedDirectiveMemItem(d: SupervisorDirective): { title: string; content: string } {
  const closed = !archiveAnsweredDisabled() && (d.status ?? 'open') !== 'open';
  return {
    title: `Archived directive [${String(d.id).slice(0, 8)}] (${d.status ?? 'open'})`,
    content: `Archived directive ${d.id} (${d.at || 'unknown time'}): ${d.text}${closed && d.evidence ? ` — evidence: ${d.evidence}` : ''} — status: ${d.status ?? 'open'}${d.archivedAt ? ` (archived ${d.archivedAt})` : ''}${d.scope ? ` (scope: ${d.scope})` : ''}${closed && d.messageId ? ` (owner msg ${String(d.messageId).slice(0, 8)})` : ''}`,
  };
}

// ── Cold-archive mirror (review 2026-10-22) ───────────────────────────────────
// The hot doc keeps only the newest closed archived rows; older ones live in
// the cold archive (supervisor-state.service spillClosedArchive). Their mirror
// rows use the 'archive ' ref prefix, so the per-doc mirror — which deletes
// every ref the HOT doc no longer wants — leaves them alone; this reconcile
// (run whenever the cold set changes) keeps them equal to the cold set.
/** Ref prefix of a cold-archive mirror row. */
export const SUPERVISOR_STATE_COLD_REF_PREFIX = 'archive ';
/** Is this mirror ref a cold-archive row? Pure. */
export function isColdArchiveRef(ref: string | null | undefined): boolean {
  return String(ref ?? '').startsWith(SUPERVISOR_STATE_COLD_REF_PREFIX);
}

/** The cold rows as mirror items under CONTENT-ADDRESSED 'archive <id24> @<at> #<hash>' refs. Pure. */
export function supervisorStateColdMemRows(rows: SupervisorDirective[]): MemItem[] {
  const seen = new Set<string>();
  const out: MemItem[] = [];
  for (const d of rows ?? []) {
    if (!d?.id || !d?.text) continue;
    const it = archivedDirectiveMemItem(d);
    const at = String(d.at || '').replace(/\s+/g, '') || '?';
    const hash = createHash('sha1').update(`${it.title}\n${it.content}`).digest('hex').slice(0, 12);
    const ref = `${SUPERVISOR_STATE_COLD_REF_PREFIX}${String(d.id).slice(0, 24)} @${at} #${hash}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, title: it.title.slice(0, 500), content: it.content });
  }
  return out;
}

/**
 * Reconcile the cold mirror rows with the FULL cold set: delete 'archive '
 * refs the set no longer holds, store the new ones (unchanged rows keep their
 * created_at). Never throws; returns rows stored.
 */
export async function embedSupervisorStateColdRows(chatId: string, rows: SupervisorDirective[], opts: { userId?: string } = {}): Promise<number> {
  if (supervisorStateMemoryDisabled() || !chatId) return 0;
  const items = supervisorStateColdMemRows(rows);
  const cacheKey = `${chatId}#cold`;
  const hash = createHash('sha256').update(`cold\n${items.map((r) => r.ref).join('\n')}`).digest('hex');
  const prev = lastEmbedded.get(cacheKey);
  if (prev && prev.hash === hash && Date.now() - prev.at < LAST_EMBED_TTL_MS) return 0;
  try {
    const scope: MemScope = { type: 'chat', id: chatId };
    const listed = await memListRefs(scope, SUPERVISOR_STATE_MEM_SOURCE);
    if (!listed) return 0;
    const want = new Set(items.map((r) => String(r.ref)));
    const haveCold = new Map(listed.filter((r) => isColdArchiveRef(r.ref)).map((r) => [r.ref, r.rows]));
    const doubled = [...want].filter((ref) => (haveCold.get(ref) ?? 0) > 1);
    const drop = [...haveCold.keys()].filter((ref) => !want.has(ref)).concat(doubled);
    if (drop.length) await memDeleteRefs(scope, SUPERVISOR_STATE_MEM_SOURCE, drop);
    const fresh = items.filter((r) => !haveCold.has(String(r.ref)) || doubled.includes(String(r.ref)));
    const n = fresh.length
      ? await memStore(scope, SUPERVISOR_STATE_MEM_SOURCE, fresh, { userId: opts.userId, maxChunks: Math.max(300, fresh.length), skipCap: true, skipGate: true })
      : 0;
    if (n >= fresh.length) lastEmbedded.set(cacheKey, { hash, at: Date.now() });
    return n;
  } catch (err: any) {
    logger.warn(`supervisor-state: cold-archive memory embed failed for ${chatId} (non-fatal): ${err?.message ?? err}`, { source: SUPERVISOR_STATE_MEM_SOURCE });
    return 0;
  }
}

/** Per-doc content hash — the short-circuit so no-op writes never re-embed. */
export function supervisorStateMemHash(doc: SupervisorStateDoc): string {
  return createHash('sha256').update(JSON.stringify(supervisorStateMemItems(doc))).digest('hex');
}

/**
 * MIND-HYGIENE: the doc as per-row items under CONTENT-ADDRESSED refs —
 * '<kind> <id24> @<row time> #<sha1(title+content) 12>'. The same row with
 * the same text always yields the same ref (so the store keeps it, and its
 * created_at, untouched); any change to the row yields a new ref. The row
 * time is the directive's / dispatch's own `at` ('?' when unknown). A
 * directive id living in both the live and archived lists keeps both rows
 * (their content differs, so their refs do). Pure.
 */
export function supervisorStateMemRows(doc: SupervisorStateDoc): MemItem[] {
  const ats = new Map<string, string>();
  for (const d of [...(doc?.directives ?? []), ...(doc?.archived ?? [])]) if (d?.id) ats.set(`directive ${String(d.id).slice(0, 24)}`, String(d.at || ''));
  for (const x of doc?.dispatches ?? []) if (x?.id) ats.set(`dispatch ${String(x.id).slice(0, 24)}`, String(x.at || ''));
  const seen = new Set<string>();
  const out: MemItem[] = [];
  for (const it of supervisorStateMemItems(doc)) {
    const base = String(it.ref || '').trim();
    const at = String(ats.get(base) || '').replace(/\s+/g, '') || '?';
    const hash = createHash('sha1').update(`${it.title ?? ''}\n${it.content}`).digest('hex').slice(0, 12);
    const ref = `${base} @${at} #${hash}`;
    if (seen.has(ref)) continue; // a byte-identical duplicate row stores once
    seen.add(ref);
    out.push({ ...it, ref });
  }
  return out;
}

// In-process per-chat last-embedded hash: upsertDoc rewrites the doc on
// nearly every turn (the read-side archive tidy alone rewrites), and the
// model merge often changes nothing material. A rewrite whose ITEMS are
// byte-identical skips the store round-trip entirely.
const lastEmbedded = new Map<string, { hash: string; at: number }>();
const LAST_EMBED_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Embed the CURRENT doc (delete-then-store, ref-scoped): the store mirrors
 * the doc exactly — rows for directives that closed/disappeared are deleted,
 * updated rows are re-embedded. Never throws; returns rows stored (0 on
 * kill switch, no-op or failure).
 */
export async function embedSupervisorStateDoc(chatId: string, doc: SupervisorStateDoc, opts: { userId?: string } = {}): Promise<number> {
  if (supervisorStateMemoryDisabled()) return 0;
  if (!chatId || !doc) return 0;
  if (!supervisorRecallDiffQueryDisabled()) return embedSupervisorStateRows(chatId, doc, opts);
  const items = supervisorStateMemItems(doc);
  // The mode rides the hash: flipping the kill switch re-mirrors once in the new shape.
  const hash = createHash('sha256').update(`batch\n${JSON.stringify(items)}`).digest('hex');
  const prev = lastEmbedded.get(chatId);
  if (prev && prev.hash === hash && Date.now() - prev.at < LAST_EMBED_TTL_MS) return 0;
  try {
    // A switch flip from the per-row mirror: drop its rows first, or recall
    // would read both shapes side by side. Best-effort (a failed listing
    // leaves them; the next per-row write cleans the batch row up anyway).
    try {
      const listed = await memListRefs({ type: 'chat', id: chatId }, SUPERVISOR_STATE_MEM_SOURCE);
      const strays = (listed ?? []).map((r) => r.ref).filter((r) => r !== SUPERVISOR_STATE_MEM_REF && !isColdArchiveRef(r));
      if (strays.length) await memDeleteRefs({ type: 'chat', id: chatId }, SUPERVISOR_STATE_MEM_SOURCE, strays);
    } catch { /* the cleanup is best-effort — the batch mirror below proceeds */ }
    // Empty doc: the ref delete still runs (mirrors the doc), then stores nothing.
    const scope: MemScope = { type: 'chat', id: chatId };
    const n = items.length
      ? await memReplaceRef(scope, SUPERVISOR_STATE_MEM_SOURCE, SUPERVISOR_STATE_MEM_REF, items, {
          userId: opts.userId,
          // One row per doc row, dispatched in ONE call — maxChunks caps the
          // whole batch (memStore: rows.length >= maxChunks ⇒ break), so it
          // must cover the doc's REAL shape. evictDirectivesAtCap never drops
          // an open/standing row, so an all-open ledger can legitimately hold
          // MORE than MAX_DIRECTIVES (50) — plus archived (200) and
          // dispatches (30). Size the cap from the actual batch, floored at
          // the doc's nominal max shape (review N2: a fixed 300 silently
          // truncated the tail — dispatches — on a pathological supervisor).
          maxChunks: Math.max(300, items.length),
          // The chat scope's whole-scope cap (800, source-blind) must NOT
          // sweep this store: mirror-rows are bounded by the doc's own caps
          // (replace-by-ref) and would otherwise evict unrelated chat rows
          // on a busy supervisor. Same defence-in-depth shape the project-
          // scope writers adopted after the 2026-09-14 17.6k-row deletion.
          skipCap: true,
          // Rows under the 25-char worthEmbedding floor are curated doc
          // content (the learnings.md precedent), not noise.
          skipGate: true,
        })
      : await memReplaceRef(scope, SUPERVISOR_STATE_MEM_SOURCE, SUPERVISOR_STATE_MEM_REF, []);
    // Cache the hash ONLY on a confirmed mirror (review N1): memStore swallows
    // store failures internally and returns 0 — caching on n=0 with a
    // non-empty doc would mask a transient INSERT failure (the DELETE already
    // ran ⇒ mirror rows GONE) until the doc's next content change, serving
    // stale/empty recall for up to the TTL. An empty doc mirrors "nothing"
    // successfully, so it caches too.
    if (n > 0 || items.length === 0) lastEmbedded.set(chatId, { hash, at: Date.now() });
    return n;
  } catch (err: any) {
    logger.warn(`supervisor-state: memory embed failed for ${chatId} (non-fatal): ${err?.message ?? err}`, { source: SUPERVISOR_STATE_MEM_SOURCE });
    return 0;
  }
}

/**
 * MIND-HYGIENE per-row mirror: list the refs already stored, DELETE the ones
 * the doc no longer wants (a closed / changed / vanished row, the legacy batch
 * ref, a duplicated ref), and STORE only the rows whose content-addressed ref
 * is new — an unchanged row is never rewritten, so it keeps its own
 * created_at (recall order and the store's age decay mean something again).
 * An unreadable listing stores nothing and caches nothing (the next write
 * retries); a partial insert is caught by the next write's listing. Never
 * throws; returns rows stored.
 */
async function embedSupervisorStateRows(chatId: string, doc: SupervisorStateDoc, opts: { userId?: string }): Promise<number> {
  const rows = supervisorStateMemRows(doc);
  const hash = createHash('sha256').update(`rows\n${rows.map((r) => r.ref).join('\n')}`).digest('hex');
  const prev = lastEmbedded.get(chatId);
  if (prev && prev.hash === hash && Date.now() - prev.at < LAST_EMBED_TTL_MS) return 0;
  try {
    const scope: MemScope = { type: 'chat', id: chatId };
    const listed = await memListRefs(scope, SUPERVISOR_STATE_MEM_SOURCE);
    if (!listed) return 0; // unreadable store — never read "empty" into it
    const want = new Set(rows.map((r) => String(r.ref)));
    const have = new Map(listed.map((r) => [r.ref, r.rows]));
    // A wanted ref holding more than one row is a cross-container double
    // insert (rows are < one 3,500-char chunk) — drop it and store it once.
    const doubled = [...want].filter((ref) => (have.get(ref) ?? 0) > 1);
    // Cold-archive rows ('archive …') belong to the cold reconcile, never to this hot mirror.
    const drop = [...have.keys()].filter((ref) => !want.has(ref) && !isColdArchiveRef(ref)).concat(doubled);
    if (drop.length) await memDeleteRefs(scope, SUPERVISOR_STATE_MEM_SOURCE, drop);
    const fresh = rows.filter((r) => !have.has(String(r.ref)) || doubled.includes(String(r.ref)));
    const n = fresh.length
      ? await memStore(scope, SUPERVISOR_STATE_MEM_SOURCE, fresh, {
          userId: opts.userId,
          maxChunks: Math.max(300, fresh.length),
          skipCap: true, // same reasons as the batch mirror above
          skipGate: true,
        })
      : 0;
    // Cache only a confirmed mirror (review N1): every fresh row landed (or none was due).
    if (n >= fresh.length) lastEmbedded.set(chatId, { hash, at: Date.now() });
    return n;
  } catch (err: any) {
    logger.warn(`supervisor-state: per-row memory embed failed for ${chatId} (non-fatal): ${err?.message ?? err}`, { source: SUPERVISOR_STATE_MEM_SOURCE });
    return 0;
  }
}

// Per-chat embed serializer (review N3): the doc writes are serialized by
// enqueueDocWrite, but a bare fire-and-forget embed DETACHES from that chain —
// two rapid writes could interleave their memReplaceRef delete/insert rounds
// (A.delete, B.delete, A.insert(v1), B.insert(v2)) and leave stale v1 rows
// beside v2, and the next content-equal write hash-skips and never cleans
// them. Chaining the embeds per chat keeps them strictly ordered — the last
// embed in the chain is always the latest doc snapshot, so the mirror
// converges. Doc writes are NOT blocked (the chain runs detached); the
// cross-container window is the same one the doc itself documents.
const embedChains = new Map<string, Promise<void>>();

/**
 * After an embed that WROTE rows: re-check the chat. A chat delete runs
 * memClear({type:'chat'}) after its row delete, so an embed already queued on
 * this serializer (or mid-insert) when the chat died re-inserted owner
 * directive text that nothing would ever delete (fs-durable-memory re-review,
 * 2026-10-23). Write-then-check closes it: either the delete's memClear runs
 * after these rows landed, or this check sees the chat gone and clears the
 * chat scope itself. Only a lookup that answers "not found" (null) clears —
 * a failed lookup clears nothing. Never throws.
 */
async function clearChatScopeIfChatGone(chatId: string, wrote: number): Promise<void> {
  if (!(wrote > 0)) return;
  try {
    const { default: prisma } = await import('../../../config/database');
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { id: true } });
    if (chat !== null) return;
    await memClear({ type: 'chat', id: chatId });
    lastEmbedded.delete(chatId);
    lastEmbedded.delete(`${chatId}#cold`);
    logger.info(`supervisor-state: mirror write landed after chat ${chatId} was deleted — chat-scope memory cleared`, { source: SUPERVISOR_STATE_MEM_SOURCE });
  } catch (err: any) {
    logger.warn(`supervisor-state: deleted-chat mirror check failed for ${chatId} (non-fatal): ${err?.message ?? err}`, { source: SUPERVISOR_STATE_MEM_SOURCE });
  }
}

/**
 * Enqueue an embed on the chat's serializer — fire-and-forget, ordered.
 * Never throws; never blocks the caller.
 */
export function enqueueSupervisorStateEmbed(chatId: string, doc: SupervisorStateDoc, opts: { userId?: string } = {}): void {
  const prev = embedChains.get(chatId) ?? Promise.resolve();
  const run: Promise<void> = prev.then(() => embedSupervisorStateDoc(chatId, doc, opts)).then((n) => clearChatScopeIfChatGone(chatId, n)).catch(() => {});
  embedChains.set(chatId, run);
  void run.finally(() => {
    if (embedChains.get(chatId) === run) embedChains.delete(chatId);
  }).catch(() => {});
}

/** Enqueue a cold-archive mirror reconcile on the same per-chat serializer. Fire-and-forget; never throws. */
export function enqueueSupervisorStateColdEmbed(chatId: string, rows: SupervisorDirective[], opts: { userId?: string } = {}): void {
  const prev = embedChains.get(chatId) ?? Promise.resolve();
  const run: Promise<void> = prev.then(() => embedSupervisorStateColdRows(chatId, rows, opts)).then((n) => clearChatScopeIfChatGone(chatId, n)).catch(() => {});
  embedChains.set(chatId, run);
  void run.finally(() => {
    if (embedChains.get(chatId) === run) embedChains.delete(chatId);
  }).catch(() => {});
}

// ── Recall ────────────────────────────────────────────────────────────────

/** Cap on the rendered recall block. */
export const SUPERVISOR_STATE_RECALL_CAP = 1500;
/**
 * Soft deadline for the recall leg's memory search (review N4): the vector
 * leg's embed call alone can block up to ~30s on a slow provider (the exact
 * class the fleet-learnings leg needed a deadline for — unified-memory.service
 * documents 27s embeds on live rows). The recall block is a best-effort
 * enrichment, never a gate: past the deadline memSearch degrades to whatever
 * it has (FTS leg / no rerank) or nothing, and the turn proceeds.
 */
export const SUPERVISOR_STATE_RECALL_DEADLINE_MS = 8000;
/** Kill switch for the recall block only. */
export function supervisorStateRecallDisabled(): boolean {
  return process.env.SUPERVISOR_STATE_RECALL_DISABLED === '1';
}

// ── Closed archived rows rank LAST (review 2026-10-22, fs-durable-memory) ─────
// The 50-row cap now archives done / answered rows (up to 200 kept, the older
// ones cold) and every one is mirrored into the chat scope this recall
// searches, so a plain top-k could come back as nothing but closed history
// and crowd out the trimmed OPEN orders the block exists for. The recall now
// runs a refs-filtered leg over the doc's rows minus the closed archived ones
// (open rows are always candidates), renders those first, and adds at most
// SUPERVISOR_RECALL_CLOSED_MAX closed archived rows after them — to fill
// slots the open rows left, or when the query matches one strongly.
// SUPERVISOR_LEDGER_ARCHIVE_ANSWERED_DISABLED=1 restores the single search (whatever
// SUPERVISOR_RECALL_DIFF_QUERY_DISABLED says — review round 3: the batch mirror tiers too).
/** At most this many CLOSED archived rows join a recall block — always after the open rows. */
export const SUPERVISOR_RECALL_CLOSED_MAX = 2;

/** Is this recall hit a CLOSED archived row (a cold 'archive …' ref, or an 'Archived directive […] (done|answered)' title)? Pure. */
export function isClosedArchivedRecallHit(hit: { ref?: string | null; title?: string | null }): boolean {
  if (isColdArchiveRef(hit?.ref)) return true;
  const m = /^Archived directive \[[^\]]*\] \(([^)]*)\)/.exec(String(hit?.title ?? ''));
  return !!m && m[1].trim() !== 'open';
}

const RECALL_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'answered', 'archived', 'before', 'being', 'could', 'directive', 'does', 'done',
  'each', 'evidence', 'from', 'have', 'into', 'just', 'more', 'most', 'must', 'only', 'open', 'other', 'over', 'owner',
  'should', 'some', 'status', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'under', 'until', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your', 'yet',
]);
/** Significant lower-case words (≥ 4 chars, no stopwords, no bare hex / numbers). Pure. */
function recallWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? []) {
    if (RECALL_STOPWORDS.has(w) || /^[0-9a-f-]{8,}$/.test(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

/**
 * Does the query match this CLOSED row strongly enough to surface it even
 * when open rows fill the block? Its id (≥ 8 chars) named in the query, or ≥ 3
 * shared significant words covering ≥ 60 % of the row's own directive words
 * (its text, not the harness wrapper). Pure.
 */
export function closedRecallStrongMatch(query: string, hit: { ref?: string | null; title?: string | null; content?: string | null }): boolean {
  const q = String(query ?? '').toLowerCase();
  if (!q.trim()) return false;
  const key = supervisorStateRowKeyOfHit(hit);
  if (key && key.id.length >= 8 && q.includes(key.id.slice(0, 8).toLowerCase())) return true;
  const content = String(hit?.content ?? '');
  const m = /^Archived directive \S+ \([^)]*\): (.*?)(?: — evidence: .*?)? — status: /.exec(content);
  const rowWords = recallWords(m ? m[1] : content);
  if (rowWords.size < 3) return false;
  const queryWords = recallWords(q);
  let shared = 0;
  for (const w of rowWords) if (queryWords.has(w)) shared += 1;
  return shared >= 3 && shared / rowWords.size >= 0.6;
}

/** The doc the tiered recall partitions on (one read; never throws — null on failure). */
async function recallDoc(chatId: string): Promise<SupervisorStateDoc | null> {
  try {
    const svc = await import('./supervisor-state.service');
    return await svc.getSupervisorState(chatId);
  } catch {
    return null;
  }
}

/**
 * The per-turn recall block — semantic hits from the embedded store, NEWEST
 * FIRST (a supervisor's live directives and latest dispatches are what a
 * turn most needs; the vector engine returns by similarity, not recency,
 * and the wake-block chronological guarantee is exactly what the 6000-char
 * cap broke). Queries the chat scope ONLY (this supervisor's own doc rows),
 * gated by memSearchForUser when reached through the blended search. Never
 * throws; '' when the switch is off, nothing hits or anything fails.
 * Closed archived rows (review 2026-10-22) come last and bounded — see
 * SUPERVISOR_RECALL_CLOSED_MAX.
 */
export async function buildSupervisorStateRecallBlock(
  chatId: string,
  query: string,
  k = 5,
  opts: {
    /** MIND-HYGIENE: the composed wake text — a hit whose row renders there is skipped. Absent ⇒ the
     *  block renders the state doc itself (formatStateForWake) to know what the turn already sees. */
    visibleText?: string;
    /** Directive ids the composed wake shows without their id or hides on purpose (owner-asks `hideAskIds`) — treated as visible. */
    hiddenIds?: ReadonlyArray<string>;
  } = {},
): Promise<string> {
  if (supervisorStateRecallDisabled() || !chatId || !query?.trim()) return '';
  const hygiene = !supervisorRecallDiffQueryDisabled();
  // Closed archived rows rank last whatever the mirror's shape (review round 3:
  // this used to hang off SUPERVISOR_RECALL_DIFF_QUERY_DISABLED too, so killing
  // the diff-query hygiene let 200 closed rows crowd the open orders out again).
  // Per-row mirror: the hot leg searches the doc's rows minus closed archived
  // ones by ref. Batch mirror (hygiene off): every HOT doc row rides the one
  // batch ref and the cold rows ride 'archive …' refs, so the hot leg searches
  // the batch ref (open rows + ≤ 20 hot closed ones) and titles do the split.
  const tiered = !archiveAnsweredDisabled();
  try {
    const q = String(query).slice(0, SUPERVISOR_RECALL_QUERY_MAX);
    const scope: MemScope[] = [{ type: 'chat', id: chatId }];
    const searchOpts = { sources: [SUPERVISOR_STATE_MEM_SOURCE], purpose: 'supervisor_state_recall', deadlineMs: SUPERVISOR_STATE_RECALL_DEADLINE_MS };
    // Hygiene: over-fetch, then keep only rows the turn does NOT already see.
    // (Tiered: over-fetch too, so the closed rows the tail drops leave room for open ones.)
    const fetchK = hygiene || tiered ? Math.min(20, Math.max(k, k * 3)) : k;
    // One doc read serves both the refs leg and (human seam) the visibility render.
    const docP: Promise<SupervisorStateDoc | null> | undefined = (tiered && hygiene) || (hygiene && opts.visibleText === undefined) ? recallDoc(chatId) : undefined;
    const plainP = memSearch(scope, q, fetchK, searchOpts);
    const primaryP: Promise<MemHit[]> = !tiered
      ? Promise.resolve([] as MemHit[])
      : !hygiene
        ? memSearch(scope, q, fetchK, { ...searchOpts, refs: [SUPERVISOR_STATE_MEM_REF] }).catch(() => [] as MemHit[])
        : docP
          ? docP.then((doc) => {
              const refs = doc ? supervisorStateMemRows(doc).filter((r) => !isClosedArchivedRecallHit(r)).map((r) => String(r.ref)) : [];
              return refs.length ? memSearch(scope, q, fetchK, { ...searchOpts, refs }).catch(() => [] as MemHit[]) : ([] as MemHit[]);
            })
          : Promise.resolve([] as MemHit[]);
    const visibleP = hygiene ? (opts.visibleText !== undefined ? Promise.resolve(opts.visibleText) : renderedStateText(chatId, process.env, docP)) : Promise.resolve('');
    const [plain, primary, visibleText] = await Promise.all([plainP, primaryP, visibleP]);
    const hits = tiered ? [...(primary ?? []), ...(plain ?? [])] : (plain ?? []);
    if (!hits.length) return '';
    // An empty visibleText (the render failed / no state block on the turn) applies no filter — every hit shows (fail toward delivery).
    const filtered = hygiene && !!visibleText;
    // Two legs can return the same row — dedupe whenever they were merged.
    const unique = hygiene || tiered ? dedupeRecallHits(hits) : hits;
    const shown = filtered
      ? unique.filter((h) => {
          const key = supervisorStateRowKeyOfHit(h);
          return !key || (!supervisorStateRowVisible(key, visibleText) && !supervisorStateRowHidden(key, opts.hiddenIds));
        })
      : unique;
    // The k MOST RELEVANT survivors (memSearch's order), then newest first by
    // the row's OWN time (per-row ref), else the stored time.
    const rowTime = (h: { ref?: string; createdAt?: string }) => (hygiene ? rowAtFromRef(h.ref) : null) ?? Date.parse(h.createdAt || '');
    const newestFirst = <T extends { ref?: string; createdAt?: string }>(rows: T[]) => rows.sort((a, b) => (rowTime(b) || 0) - (rowTime(a) || 0));
    let byAge: MemHit[];
    let closedTail: MemHit[] = [];
    if (tiered) {
      const openRows = shown.filter((h) => !isClosedArchivedRecallHit(h));
      const closedRows = shown.filter((h) => isClosedArchivedRecallHit(h));
      byAge = newestFirst(openRows.slice(0, k));
      const fill = Math.max(0, k - byAge.length);
      closedTail = newestFirst(
        closedRows.filter((h, i) => i < fill || closedRecallStrongMatch(q, h)).slice(0, SUPERVISOR_RECALL_CLOSED_MAX),
      );
    } else {
      byAge = newestFirst(shown.slice(0, k));
    }
    if (!byAge.length && !closedTail.length) return '';
    const header = filtered
      ? `[SUPERVISOR STATE (retrieved) — semantic hits from your durable state doc that the wake block above does NOT show (trimmed for space, archived, or closed), most relevant to what changed since your last wake; newest first]`
      : `[SUPERVISOR STATE (retrieved) — semantic hits from your durable state doc — the wake block above is a 6000-char window; these are the rows most relevant to this turn, newest first]`;
    const caveat = `(Treat like the wake block: directives are orders to honor, dispatches are a HISTORICAL ledger of prior wakes — never re-cite one as an action taken this turn.)`;
    const lines: string[] = [header, caveat];
    let cap = Math.max(0, SUPERVISOR_STATE_RECALL_CAP - header.length - caveat.length - 2);
    const render = (h: MemHit): boolean => {
      const body = (h.content || '').replace(/\s+/g, ' ').trim();
      if (!body) return true;
      // The row's identity rides the TITLE (review N5: the legacy batch mirror
      // put 'supervisor-state' in every h.ref; a per-row ref carries a hash
      // the model needs no more than that). Titles are 'Directive [id] (…)' /
      // 'Dispatch kind → id' / 'Archived directive …'.
      const label = (h.title || '').replace(/\s+/g, ' ').trim();
      const line = `- [${label}] ${body}`;
      if (cap - line.length < 0) return false;
      cap -= line.length + 1;
      lines.push(line);
      return true;
    };
    for (const h of byAge) if (!render(h)) break;
    if (closedTail.length) {
      // Open rows took the budget first; closed history only rides what is left.
      const sub = 'Closed (done / answered — archived history, not open orders):';
      if (cap - sub.length >= 0) {
        const before = lines.length;
        cap -= sub.length + 1;
        lines.push(sub);
        for (const h of closedTail) if (!render(h)) break;
        if (lines.length === before + 1) lines.pop(); // no closed line fitted — drop the sub-header
      }
    }
    return lines.length > 2 ? lines.join('\n') : '';
  } catch {
    return '';
  }
}

/**
 * The state block the turn already carries, for the visibility filter when
 * the caller did not pass the composed text (the human-turn seam in
 * chat-context runs BEFORE chat-agent composes its owner-turn block). It
 * renders exactly as that block does (review fix 2026-10-20): with the same
 * KPI annotation (loadKpisForSupervisorChat — longer project lines trim more
 * rows, and a row the turn does not see must stay recallable).
 * '' on ANY failure — no
 * filter, every hit shows (fail toward delivery). Dynamic imports:
 * supervisor-state.service is the leaf this module is imported FROM.
 * The SUPERVISOR_OWNER_STATE_DISABLED release switch was removed 2026-10-30
 * (RSW-1 cohort delete) — the owner-turn state block is always on.
 */
export async function renderedStateText(chatId: string, env: NodeJS.ProcessEnv = process.env, preloadedDoc?: Promise<SupervisorStateDoc | null>): Promise<string> {
  try {
    const svc = await import('./supervisor-state.service');
    // `preloadedDoc` (review 2026-10-22): the recall's own doc read — one read serves both.
    const docP = preloadedDoc ? preloadedDoc.then((d) => d ?? svc.getSupervisorState(chatId)) : svc.getSupervisorState(chatId);
    const [doc, kpis] = await Promise.all([docP, ownerTurnKpis(chatId)]);
    return svc.formatStateForWake(doc, new Date(), { kpis });
  } catch {
    return '';
  }
}

/** The KPIs the owner-turn state block is annotated with (chat-agent's owner-turn seam: project scope for a project supervisor, fleet scope for the Fleet Supervisor). [] on any failure. */
async function ownerTurnKpis(chatId: string): Promise<KpiView[]> {
  try {
    const { default: prisma } = await import('../../../config/database');
    const row = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true, userId: true, projectId: true } });
    if (!row) return [];
    const { loadKpisForSupervisorChat } = await import('./kpi-register.service');
    return await loadKpisForSupervisorChat({ projectId: row.isProjectSupervisor ? row.projectId : null, userId: row.userId, fleet: row.isSupervisor === true });
  } catch {
    return [];
  }
}

// ── Search surface (the API route's query arm) ──────────────────────────────

/**
 * Semantic query over the embedded rows for an external reader (the
 * supervisor-state API route). Newest first, capped; never throws.
 */
export async function searchSupervisorStateMem(chatId: string, query: string, k = 20): Promise<Array<{ ref: string; title: string; content: string; createdAt: string }>> {
  if (!chatId || !query?.trim()) return [];
  try {
    const hits = await memSearch([{ type: 'chat', id: chatId }], String(query).slice(0, 2000), Math.max(1, Math.min(50, k)), {
      sources: [SUPERVISOR_STATE_MEM_SOURCE],
      purpose: 'supervisor_state_route',
    });
    const rowTime = (h: { ref?: string; createdAt?: string }) => rowAtFromRef(h.ref) ?? Date.parse(h.createdAt || '');
    return (hits || [])
      .sort((a, b) => (rowTime(b) || 0) - (rowTime(a) || 0))
      .map((h) => ({ ref: h.ref || '', title: h.title || '', content: h.content || '', createdAt: h.createdAt || '' }));
  } catch {
    return [];
  }
}
