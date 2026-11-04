/**
 * Digby Code — session-scoped retrieval memory, now a THIN FACADE over the
 * unified digby_memory store (memory/unified-memory.service.ts). Explorer /
 * web-researcher / compaction offload the full content they gather; the
 * orchestrator + coder pull it back on demand via the `search_memory` tool.
 *
 * NEW writes land in digby_memory (scope: session). READS query the unified
 * store (the legacy `coding_memory_chunks` fallback was removed 2026-09-22) so
 * sessions created before the migration keep their memory with zero data
 * movement — the legacy table drains naturally as sessions are deleted.
 *
 * 2026-09-14 (owner: coding sessions must read the project knowledge base and
 * project decisions, per-user gated): with a caller userId the project scope
 * goes through the unified store's GATED read (owner / inherited member —
 * memory-access.ts, never re-implemented here), widens to the folder chain,
 * and FEDERATES the project knowledge base (project_chunks via
 * rag.service.retrieveChunks, the chat path's exact scope + owned-blend rules)
 * as source 'document' — one search_memory call spans session findings,
 * learnings, code index, extracted decisions ('decision', filed by the memory
 * pipeline) and uploaded knowledge.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { embedTexts, rerankTexts, retrieveChunks } from '../rag.service';
import type { RetrievedChunk } from '../rag.service';
import {
  memStore, memSearch, memSearchForUser, memClear, memInventory, MemScope, MemHit,
  memSearchArchive, memSearchArchiveForUser, MemArchivedHit,
  rrfFuse, ageDecayFactor, worthEmbedding,
  memRecentRows, memRecentRowsForUser, MemRawRow,
} from '../memory/unified-memory.service';
import { ARCHIVE_SEARCH_TIMEOUT_MS, ARCHIVED_LABEL } from '../memory/memory-archive';
import { pickRawRecall, sameRunRawRecallDisabled, sameRunWindowMinutes, RAW_RECALL_LABEL } from '../memory/same-run-recall';
import { authorizedProjectScopeIds, ownsAllProjects } from '../memory/memory-access';
import { getRagScopeFolderIds } from '../platform/folder-inheritance';
import { redactInboundSecrets } from '../platform/secret-scan';

// Re-exported so existing imports/tests keep one canonical implementation.
export { rrfFuse, ageDecayFactor, worthEmbedding };

export interface FindingItem { ref?: string; title?: string; content: string; }
export interface RetrievedFinding {
  ref: string;
  source: string;
  content: string;
  /** Cross-encoder relevance (qwen3-rerank relevance_score, ~[0,1]) — set ONLY
   *  when the merged unified+knowledge-base pool was reranked here; undefined
   *  otherwise (memSearch ranks internally and exposes no score). Callers that
   *  filter on it must treat undefined as "keep". */
  score?: number;
  /** true for a COLD hit — a row the scope cap moved into digby_memory_archive
   *  (2026-10-20); its content leads with "[archived]". */
  archived?: boolean;
}

/** Source tag for project KNOWLEDGE BASE chunks (project_chunks via rag.service)
 *  federated into search_memory results — distinct from the unified store's
 *  'code' / 'learning' / 'decision' project sources. */
export const KNOWLEDGE_BASE_SOURCE = 'document';

/** search_memory widening (audit #11): which unified-store scopes to query. */
export interface SearchMemoryOpts {
  /** 'session' = this session's findings; 'project' = durable project knowledge
   *  (learnings, code index, decisions, knowledge-base documents); 'all'
   *  (default) = both. */
  scope?: 'session' | 'project' | 'all';
  /** Required for the project scope — without it, project search is a no-op. */
  projectId?: string;
  /** Optional source filter (e.g. ['learning'], ['code'], ['document'], ['decision']). */
  sources?: string[];
  /**
   * The CALLER's user id — the per-user memory gate (owner 2026-09-14: one user
   * can never read memory or knowledge about another user or another user's
   * projects). With it, every scope goes through the unified store's gated read
   * (memSearchForUser: project scopes must be owned or member-inherited, the
   * session must be the caller's own chat) and the project knowledge base is
   * federated in (rag.service.retrieveChunks — folder-chain scope + the
   * OWNED-projects blend). WITHOUT it the project scope is DROPPED (fail
   * closed — a project read cannot be authorized) and only the caller's own
   * session scope is searched.
   */
  userId?: string;
  /** A plain chat in the hidden user space (userSpaceChatIsolated, 2026-10-20): the project scope's learnings /
   *  decisions (written from every ungrouped chat) are not searched; the knowledge base still federates in. */
  projectMemoryIsolated?: boolean;
  /**
   * Cold leg (2026-10-20, memory-archive.ts): when the hot search returns fewer
   * than k findings, top up from digby_memory_archive (rows the scope cap moved
   * out — FTS only), labelled "[archived]". OPT-IN: only the explicit
   * search_memory TOOL passes it — searchMemory is also the run-start
   * project-memory injection's reader (run-executor), and injected blocks
   * never read the cold tier. Bounded (≤ k total, ARCHIVE_SEARCH_TIMEOUT_MS)
   * and fail-open (an archive error or timeout = the hot result unchanged).
   */
  includeArchive?: boolean;
  /**
   * Supervisor chats (2026-10-22, SUPERVISOR_SEARCH_MEMORY_SCOPES): the
   * caller's OWN chat scope — where the supervisor-state mirror lives (source
   * 'supervisor_state': every live + archived directive / ask and dispatch).
   * Joins the session leg (never scope 'project'); needs userId and goes
   * through the same per-user gate (memSearchForUser drops a chat the caller
   * neither owns nor may read through its project).
   */
  chatScopeId?: string;
  /**
   * Supervisor chats: the caller's user-scope 'conversation' distills whose
   * ref is this chat id (memory.graph distillConversationToUnifiedMemory) —
   * the owner's past exchanges in THIS chat, never their other chats and
   * never another user's scope (the user scope is always the caller's own
   * userId, gated again by memSearchForUser). A separate ref-filtered leg
   * merged and reranked into the result; never scope 'project'.
   */
  conversationRef?: string;
  /**
   * SAME-RUN RAW RECALL (2026-10-31, goal 9ecd595e / RAG-1, WRP-1 defect D4).
   * ON for `search_memory` (the explicit tool — the surface the Polk County run
   * used), OFF for every injected reader (run-start project-memory injection,
   * learnings, enrichment): an injected block must never trade ranked recall
   * for recency. When on, `memory/same-run-recall.ts` decides:
   *   (a) rows written inside the same-run window that share query vocabulary
   *       answer the read DIRECTLY from the (scope_type, scope_id) index — no
   *       embed, no vector, no rerank, no provider round-trip — which is how a
   *       run recalls the SERP it just stored;
   *   (b) when the hybrid ladder returns NOTHING but the scope holds fresh
   *       rows, those rows are returned labelled `[raw recall — semantic miss,
   *       raw rows returned]` instead of a bare empty result that the model
   *       reads as "it was never stored".
   * Kill switch: SAME_RUN_RAW_RECALL_DISABLED=1. A raw read also costs one
   * extra bounded index query — callers on a tight deadline leave it off.
   */
  sameRunRecall?: boolean;
}

/** The user-scope source of conversation distills (memory.graph distillConversationToUnifiedMemory). */
export const CONVERSATION_SOURCE = 'conversation';

/** Store gathered findings for a session (gate → chunk → embed → insert). Best-effort.
 *  `opts.maxChunks` widens memStore's default 40-chunk-per-call cap for callers
 *  that legitimately store many items at once (compaction v2's per-part offload —
 *  the default cap silently dropped everything past the first ~17 items). */
export async function storeFindings(sessionId: string, source: string, items: FindingItem[], opts?: { maxChunks?: number }): Promise<number> {
  return memStore({ type: 'session', id: sessionId }, source, items, opts);
}

/**
 * Retrieve the most relevant stored findings for a query — unified store first
 * (hybrid fusion + decay + rerank inside memSearch); legacy-table fallback fills
 * remaining slots for pre-migration sessions.
 *
 * Widened (audit #11): with opts.projectId the PROJECT scope joins the query
 * (durable learnings + semantic code index live there), so one search_memory
 * call spans session findings AND project knowledge. memSearch already accepts
 * scope arrays + a source filter — this just assembles them.
 */
export async function searchMemory(sessionId: string, query: string, k = 6, opts?: SearchMemoryOpts): Promise<RetrievedFinding[]> {
  if (!query.trim()) return [];
  const scope = opts?.scope ?? 'all';
  const userId = opts?.userId?.trim() || undefined;
  const wantsProject = scope !== 'session' && !!opts?.projectId;
  const srcOpts = opts?.sources?.length ? { sources: opts.sources } : undefined;
  // purpose stamps the memory_search_timing row so the per-purpose cost view
  // (audit-live-state memory_search_timing_4h, owner steer f41e856f) can
  // attribute coding-session retrieval; unattributed rows are invisible to it.
  const timingOpts = { ...srcOpts, purpose: 'coding_retrieval' as const };

  const scopes: MemScope[] = [];
  if (scope !== 'project') scopes.push({ type: 'session', id: sessionId });
  // Supervisor chat scope (2026-10-22): gated like the session scope, so only with a known caller.
  const chatScopeId = opts?.chatScopeId?.trim();
  if (scope !== 'project' && chatScopeId && userId) scopes.push({ type: 'chat', id: chatScopeId });

  // ── Project scope: per-user gate + folder-chain widening (owner 2026-09-14) ──
  // The project scope is only searchable on behalf of a KNOWN user: the gate
  // (memory-access.authorizedProjectScopeIds — owner or member of the project /
  // an ancestor folder) needs a user to authorize. No userId ⇒ the project
  // scope is dropped, never widened; the caller's own session still searches.
  let ragScopeIds: string[] = [];          // root→leaf folder chain (leaf = the project)
  let authorizedProject = false;           // the leaf itself passed the gate
  if (wantsProject) {
    if (!userId) {
      logger.debug(`coding-retrieval: project scope requested without a userId — dropped (fail closed) for session ${sessionId.slice(0, 8)}`);
    } else {
      const projectId = opts!.projectId!;
      // Same folder-chain scope the chat KB path uses (chat-context.ts): a
      // decision or learning filed at "Work" is visible from "Work/Client A".
      ragScopeIds = await getRagScopeFolderIds(projectId).catch(() => [projectId]);
      if (!ragScopeIds.includes(projectId)) ragScopeIds = [...ragScopeIds, projectId];
      const allowed = await authorizedProjectScopeIds(userId, [projectId, ...ragScopeIds.filter(id => id !== projectId)]);
      authorizedProject = allowed.includes(projectId);
      if (!opts?.projectMemoryIsolated) for (const id of allowed) scopes.push({ type: 'project', id });
    }
  }
  if (!scopes.length && !authorizedProject) return [];

  // ── Supervisor conversation leg (2026-10-22): the caller's OWN user-scope
  // distills of THIS chat (ref = the chat id), ref-filtered in SQL so the
  // owner's other chats never enter; started now so it overlaps the main read.
  const conversationRef = opts?.conversationRef?.trim();
  const wantsConversation = scope !== 'project' && !!conversationRef && !!userId
    && (!opts?.sources?.length || opts.sources.includes(CONVERSATION_SOURCE));
  const conversationScopes: MemScope[] = wantsConversation ? [{ type: 'user', id: userId! }] : [];
  const conversationP: Promise<MemHit[]> = wantsConversation
    ? memSearchForUser(userId!, conversationScopes, query, k, { sources: [CONVERSATION_SOURCE], refs: [conversationRef!], purpose: 'coding_retrieval' }).catch(() => [] as MemHit[])
    : Promise.resolve([]);

  // ── SAME-RUN RAW RECALL, pre-hybrid (2026-10-31, RAG-1 / WRP-1 D4) ────────
  // The Polk County run STORED its own SERP and then could not recall it in the
  // SAME run: recall meant embed → vector → FTS → RRF → rerank, and that ladder
  // answered empty. A row written minutes ago in this scope is an INDEX READ —
  // no query embedding, no vector scan, no rerank, no provider round-trip — so
  // when a fresh row shares the query's vocabulary it answers the read outright.
  // Freshness-window bounded (memory/same-run-recall.ts), so this can never turn
  // semantic recall into "newest rows always win". Session/chat scopes only: a
  // project scope's rows are durable knowledge, not this run's own writes.
  const rawScopes: MemScope[] = scopes.filter(s => s.type === 'session' || s.type === 'chat');
  const wantRawRecall = opts?.sameRunRecall === true && !sameRunRawRecallDisabled() && rawScopes.length > 0;
  const rawWindowMs = sameRunWindowMinutes() * 60_000;
  // One bounded index read, reused by both the pre-hybrid and the fallback half.
  const rawRowsP: Promise<MemRawRow[] | null> = wantRawRecall
    ? (userId
        ? memRecentRowsForUser(userId, rawScopes, { limit: 60, sinceMs: Date.now() - rawWindowMs, ...(srcOpts?.sources ? { sources: srcOpts.sources } : {}) })
        : memRecentRows(rawScopes, { limit: 60, sinceMs: Date.now() - rawWindowMs, ...(srcOpts?.sources ? { sources: srcOpts.sources } : {}) }))
        .catch(() => null)
    : Promise.resolve(null);
  if (wantRawRecall) {
    const rawRows = await rawRowsP;
    const pick = rawRows ? pickRawRecall(rawRows, query, 'first', { k }) : null;
    if (pick) {
      recordSameRunRawRecall('raw-first', pick, rawScopes, query, { sessionId, chatId: chatScopeId });
      return pick.rows.map(rawRowToFinding);
    }
  }

  // ── Unified store (digby_memory): the gated read whenever we know the caller.
  // memSearchForUser re-applies the project gate (harmless: same predicate) and
  // ALSO gates the session scope — the chat row must be the caller's own or
  // sit in a project they may read.
  const hits: MemHit[] = !scopes.length
    ? []
    : userId
      ? await memSearchForUser(userId, scopes, query, k, timingOpts)
      : await memSearch(scopes, query, k, timingOpts);
  const unified: RetrievedFinding[] = hits.map(h => ({
    // Learning rows carry a content-hash ref — show the human-meaningful origin instead.
    ref: h.source === 'learning' ? 'learnings.md' : h.ref,
    source: h.source,
    content: h.content,
  }));

  // ── Knowledge-base federation: the project's documents (uploads, notes,
  // URLs → project_chunks) join the same search. Only for an AUTHORIZED
  // project, and only when no source filter excludes 'document'.
  let docs: RetrievedFinding[] = [];
  if (authorizedProject && userId && (!opts?.sources?.length || opts.sources.includes(KNOWLEDGE_BASE_SOURCE))) {
    docs = await searchKnowledgeBase(query, opts!.projectId!, ragScopeIds, userId, k).catch(() => []);
  }

  const conversation = (await conversationP).map(conversationHitToFinding);

  let out: RetrievedFinding[];
  if (docs.length || conversation.length) {
    out = await mergeAndRerank(query, unified, [...docs, ...conversation], k);
  } else {
    out = unified;
  }

  // ── Cold leg (2026-10-20): the explicit tool tops a short hot result up
  // from the archive — the SAME scopes (already gated above / re-gated by
  // memSearchArchiveForUser) and source filter, never the knowledge base.
  if (opts?.includeArchive && out.length < k && scopes.length) {
    out = await topUpFromArchive(out, scopes, query, k, userId, srcOpts?.sources);
  }
  // … and the conversation leg's own cold rows (the user scope's source-blind
  // newest-800 cap archives a supervisor's older distills first), same ref filter.
  if (opts?.includeArchive && out.length < k && conversationScopes.length) {
    out = await topUpFromArchive(out, conversationScopes, query, k, userId, [CONVERSATION_SOURCE], [conversationRef!], { redact: true });
  }

  // (The legacy coding_memory_chunks fallback read is gone — owner 2026-09-22:
  // the table's last write was 2026-07-18 and the instrumented read path never
  // returned a row; migration 20260922193000 drops the table.)

  // ── SAME-RUN RAW RECALL, fallback half (2026-10-31, RAG-1 / WRP-1 D4) ────
  // The hybrid ladder answered EMPTY for a scope that holds rows this run just
  // wrote. That is the exact incident: the model read "no stored memory matched"
  // as "it was never stored" and re-ran the search instead of using the SERP it
  // held. Returning the fresh raw rows (labelled) is strictly better than a bare
  // empty result. Only reached when every ranked leg returned nothing, so a
  // working read is never overridden.
  if (wantRawRecall && out.length === 0) {
    const rawRows = await rawRowsP;
    const pick = rawRows ? pickRawRecall(rawRows, query, 'fallback', { k }) : null;
    if (pick) {
      recordSameRunRawRecall('raw-fallback', pick, rawScopes, query, { sessionId, chatId: chatScopeId });
      return pick.rows.map(rawRowToFinding);
    }
  }
  return out;
}

/** A raw (query-free) stored row → the finding shape `search_memory` renders.
 *  The label tells the MODEL why this hit looks unranked, so it can say
 *  "semantic miss, raw rows" instead of "memory doesn't have it" (D4b). */
function rawRowToFinding(row: MemRawRow): RetrievedFinding {
  return {
    ref: row.source === 'learning' ? 'learnings.md' : row.ref,
    source: row.source,
    content: `${RAW_RECALL_LABEL} ${row.content}`,
  };
}

/**
 * One row per raw rescue (2026-10-31, RAG-1 / WRP-1 D4's regression detector):
 * value = rows returned, meta { path, chatId, overlap, ageMinutes, scopes, queryChars }.
 * `path: 'raw-fallback'` is THE incident class — the hybrid legs found nothing
 * for a scope holding fresh rows — and its rate is the number to watch; it must
 * stay at zero. Fire-and-forget, never throws, never carries the query text.
 *
 * ATTRIBUTION (2026-10-31, VERIFY-4 finding). The first cut emitted NO caller
 * identity: the row carried `chat:null`/`run:null`, so a raw rescue could never
 * be tied to the run that produced it. That made acceptance criterion (c)
 * ("the just-fetched SERP is retrievable in the SAME run") UNMEASURABLE BY
 * CONSTRUCTION — not merely unobserved — because a live re-run produces a row
 * nobody can attribute to it. The KPI `raw-fallback = 0` did not cover this:
 * a zero with no chat attached proves nothing about any particular run.
 * `sessionId` now rides the row's own sessionId column AND meta.chatId, so a
 * probe can say "THIS run took the raw path".
 */
function recordSameRunRawRecall(
  path: 'raw-first' | 'raw-fallback',
  pick: { rows: unknown[]; overlap: number; ageMinutes: number },
  scopes: MemScope[],
  query: string,
  attribution?: { sessionId?: string; chatId?: string },
): void {
  const chatId = attribution?.chatId || attribution?.sessionId || null;
  void import('../platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SAME_RUN_RAW_RECALL,
      // the run's identity rides the row COLUMN too (not only meta) so the
      // metric view's chatId filter reaches these rows.
      ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
      value: pick.rows.length,
      unit: 'rows',
      meta: {
        path,
        // null (not omitted) when the caller gave nothing: an explicit null is
        // the honest shape and keeps the key-set stable across rows.
        chatId,
        overlap: Math.round(pick.overlap * 100) / 100,
        ageMinutes: pick.ageMinutes,
        scopes: scopes.map(s => s.type).join(','),
        queryChars: query.length,
      },
    }))
    .catch(() => undefined);
}

/** Content fingerprint for de-duplicating cold hits against hot ones (the
 *  dedupe store path can re-store a chunk the cap had already archived). */
function findingFingerprint(content: string): string {
  return content.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)?/, '').replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
}

/**
 * Append up to k − hot.length archived findings (labelled "[archived]") to a
 * short hot result. Gated exactly like the hot read (memSearchArchiveForUser
 * when the caller is known, else the session-only ungated path), bounded by
 * ARCHIVE_SEARCH_TIMEOUT_MS, and fail-open: any error / timeout returns `hot`
 * untouched. Never throws.
 */
async function topUpFromArchive(hot: RetrievedFinding[], scopes: MemScope[], query: string, k: number, userId: string | undefined, sources: string[] | undefined, refs?: string[], opts: { redact?: boolean } = {}): Promise<RetrievedFinding[]> {
  const clean = (s: string) => (opts.redact ? redactInboundSecrets(s) : s);
  const want = k - hot.length;
  if (want <= 0) return hot;
  let timer: NodeJS.Timeout | undefined;
  try {
    const archiveOpts = { ...(sources?.length ? { sources } : {}), ...(refs?.length ? { refs } : {}), purpose: 'coding_retrieval_archive' };
    const search: Promise<MemArchivedHit[]> = userId
      ? memSearchArchiveForUser(userId, scopes, query, k, archiveOpts)
      : memSearchArchive(scopes, query, k, archiveOpts);
    const timeout = new Promise<MemArchivedHit[]>((resolve) => { timer = setTimeout(() => resolve([]), ARCHIVE_SEARCH_TIMEOUT_MS); });
    const cold = await Promise.race([search.catch(() => [] as MemArchivedHit[]), timeout]);
    if (!cold.length) return hot;
    const seen = new Set(hot.map(f => findingFingerprint(f.content)).filter(Boolean));
    const out = [...hot];
    for (const h of cold) {
      if (out.length >= k) break;
      const fp = findingFingerprint(h.content);
      if (fp && seen.has(fp)) continue;
      if (fp) seen.add(fp);
      out.push({
        ref: h.source === 'learning' ? 'learnings.md' : clean(h.ref),
        source: h.source,
        content: `${ARCHIVED_LABEL} ${clean(h.content)}`,
        archived: true,
      });
    }
    return out;
  } catch (e: any) {
    logger.debug(`coding-retrieval: archive top-up failed (non-fatal, hot results stand): ${e?.message ?? e}`);
    return hot;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Project knowledge base → findings. Mirrors the chat path (chat-context.ts
 * RAG injection) exactly: folder-chain scope (ancestors = the chain minus the
 * leaf), the crossProjectMemory setting decides whether the caller's OTHER
 * OWNED projects blend in (default ON; retrieveChunks itself restricts the
 * blend to projects the user owns — never member-shared, never another
 * user's), and the doc-count gate skips the embedding call for projects with
 * no knowledge base at all (the common coding case). Never throws.
 */
async function searchKnowledgeBase(query: string, projectId: string, ragScopeIds: string[], userId: string, k: number): Promise<RetrievedFinding[]> {
  try {
    // getProjectSettings lives in memory.graph, whose static import chain is
    // heavy (context.service) — dynamic import, same idiom as coding-data.service.
    let crossProjectMemory = true; // the default-on setting; an explicit false isolates
    try {
      const { getProjectSettings } = await import('../langgraph/memory.graph');
      crossProjectMemory = (await getProjectSettings(projectId)).crossProjectMemory !== false;
    } catch { /* unreadable settings → default ON, like getProjectSettings itself */ }
    // Blend the caller's OTHER projects only when they own this one (EOD review
    // 2026-09-14): a member's private projects never enter a shared project.
    const blendUserId = crossProjectMemory && (await ownsAllProjects(userId, [projectId])) ? userId : undefined;
    const docCount = await prisma.projectDocument.count({
      where: {
        status: 'ready',
        OR: [{ projectId: { in: ragScopeIds } }, ...(blendUserId ? [{ userId: blendUserId, projectId: { not: null } }] : [])],
      },
    });
    if (docCount === 0) return [];
    const chunks: RetrievedChunk[] = await retrieveChunks(query, projectId, k, 'dashscope', ragScopeIds.filter(id => id !== projectId), blendUserId);
    return chunks.map(chunkToFinding);
  } catch (e: any) {
    logger.warn(`coding-retrieval: knowledge-base search failed (non-fatal, unified hits stand): ${e?.message ?? e}`);
    return [];
  }
}

/**
 * A conversation distill → a finding: its searchable question (the row title)
 * and date lead the summary. Redacted (review 2026-10-23): a distill is a
 * model summary of the RAW owner message, and its refs ("systems, files, URLs,
 * or entities mentioned") can copy a pasted credential — the supervisor leg
 * would hand it back verbatim to any later wake. Title, content and ref all
 * go through the inbound redactor.
 */
export function conversationHitToFinding(h: MemHit): RetrievedFinding {
  const t = Date.parse(h.createdAt);
  const when = Number.isFinite(t) ? `[${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z] ` : '';
  const q = h.title ? `Q: ${h.title}\n` : '';
  return { ref: h.ref ? redactInboundSecrets(h.ref) : h.ref, source: h.source || CONVERSATION_SOURCE, content: redactInboundSecrets(`${when}${q}${h.content}`) };
}

/** RetrievedChunk → RetrievedFinding: source 'document', ref 'doc:<documentId>#<chunkIndex>',
 *  content led by '[<documentName>]' (+ the source project for blended-in chunks). */
export function chunkToFinding(c: RetrievedChunk): RetrievedFinding {
  const label = `[${c.documentName || 'document'}]${c.sourceProjectName ? ` [project: ${c.sourceProjectName}]` : ''}`;
  // No `score` here: rag.service's relevanceScore is a rerank score OR an RRF
  // score depending on its fallback path — not one scale. Only mergeAndRerank's
  // own cross-encoder pass sets `score`.
  return {
    ref: `doc:${c.documentId}#${c.chunkIndex}`,
    source: KNOWLEDGE_BASE_SOURCE,
    content: `${label} ${c.content}`,
  };
}

/**
 * Merge unified hits with knowledge-base findings and re-rank the pool with
 * the cross-encoder (top k). Duplicates (a KB chunk also bridged into the
 * unified store) collapse on a content fingerprint. When the reranker is
 * unavailable the pool keeps unified-first order, sliced to k; the rerank
 * score rides `score` so run-start injection can floor on it.
 */
async function mergeAndRerank(query: string, unified: RetrievedFinding[], docs: RetrievedFinding[], k: number): Promise<RetrievedFinding[]> {
  const pool: RetrievedFinding[] = [];
  const seen = new Set<string>();
  for (const f of [...unified, ...docs]) {
    const fp = f.content.replace(/^\[[^\]]*\]\s*(\[[^\]]*\]\s*)?/, '').replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase();
    if (fp && seen.has(fp)) continue;
    if (fp) seen.add(fp);
    pool.push(f);
  }
  if (pool.length <= 1) return pool.slice(0, k);
  const ranked = await rerankTexts(query, pool.map(f => f.content), Math.min(k, pool.length)).catch(() => null);
  if (!ranked || !ranked.length) {
    return pool.slice(0, k).map(f => ({ ref: f.ref, source: f.source, content: f.content }));
  }
  const out: RetrievedFinding[] = [];
  for (const r of ranked) {
    const f = pool[r.index];
    if (!f) continue;
    out.push({ ref: f.ref, source: f.source, content: f.content, score: r.score });
    if (out.length >= k) break;
  }
  return out;
}

/**
 * One-line inventory of this session's stored findings for the system prompt,
 * so the model KNOWS retrieval will pay before it thinks to call search_memory
 * (a model that believes memory is empty never searches it). '' when the
 * session has stored nothing (fresh sessions) or on any failure — never throws.
 */
export async function buildSessionMemoryInventory(sessionId: string): Promise<string> {
  try {
    const counts = await memInventory({ type: 'session', id: sessionId });
    const entries = Object.entries(counts);
    if (!entries.length) return '';
    const total = entries.reduce((n, [, c]) => n + c, 0);
    const bySource = entries.map(([s, c]) => `${s} ${c}`).join(', ');
    return `[SESSION MEMORY INVENTORY] ${total} stored chunk${total === 1 ? '' : 's'} from earlier work in this session are retrievable via search_memory (by source: ${bySource}) — search before re-reading or re-fetching what was already gathered.`;
  } catch {
    return '';
  }
}

/** Drop a session's stored findings (called on session delete). Best-effort. */
export async function clearSessionMemory(sessionId: string): Promise<void> {
  await memClear({ type: 'session', id: sessionId });
}

