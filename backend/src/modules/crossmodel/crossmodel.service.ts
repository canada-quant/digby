import prisma from '../../config/database';
import { AppError } from '../../middleware/error-handler';
import logger from '../../utils/logger';
import { Message, PatienceMode, normalizePatienceMode } from './types';
import { getArchiveHiddenProjectIds, chatArchiveExclusion } from './archive-scope';
import { CHAT_LIST_ANCESTOR_HOPS, missingParentIds, spliceAncestors } from './chat-list-lineage';
import { displayParentNestingDisabled } from './platform/display-parent';
import { annotateCredentialPaste } from './platform/credential-paste';

/** The ticket-f95e1e30 map step: attach the one-tap vault flag to a transcript
 *  DTO row. Value-free and additive — a row with nothing to say is returned
 *  untouched (same object, no copy). Generic so it preserves the caller's DTO
 *  type (Message & { id }, CodingTranscriptRow, …). Exported for the unit test. */
export function annotateMessageCredentialPaste<T extends { role?: string | null; content?: string | null; metadata?: unknown }>(m: T): T {
  const metadata = annotateCredentialPaste(m, { ownerViewer: true });
  return (metadata === m.metadata ? m : { ...m, metadata }) as T;
}

/**
 * Best-effort audit trail (Activity, resource 'platform') — mirrors
 * platform.service / autonomy.service / hooks.service. Written at THIS
 * canonical layer so every caller (platform.deleteChat, the REST
 * DELETE /chats/:id, coding.controller.deleteSession) is attributable
 * (feedback 138b0347: a chat vanished with zero signal).
 */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`crossmodel audit write failed (${action}): ${err.message}`);
  }
}

/** One deep-search hit — a chat whose TITLE matched, or a message whose CONTENT
 *  matched (then `messageRole` is set and `snippet` is windowed around the term). */
export interface ChatSearchResult {
  chatId: string;
  chatTitle: string;
  /** Match context: the windowed message text, or the chat title for a title hit. */
  snippet: string;
  /** 'user' | 'assistant' for a message hit; null for a title hit. */
  messageRole: string | null;
  /** ISO timestamp of the matched message (or the chat's updatedAt for a title hit). */
  matchedAt: string;
  projectId: string | null;
  /** audit 2026-10-08 W1-3: set (true) on a hit in an archived chat / archived folder — only when the caller asked includeArchived. */
  archived?: boolean;
}

/**
 * Window a message around the first case-insensitive occurrence of `q` so the
 * search UI shows the match in context (with ellipses when it clips the ends).
 * Whitespace is collapsed first so a multi-line message reads as one line.
 */
function buildSearchSnippet(content: string, q: string, radius: number): string {
  const clean = (content || '').replace(/\s+/g, ' ').trim();
  const idx = clean.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) {
    // Defensive: the DB matched but the window can't locate the term (e.g. the
    // term spanned collapsed whitespace) — return the head of the message.
    return clean.length > radius * 2 ? clean.slice(0, radius * 2) + '…' : clean;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(clean.length, idx + q.length + radius);
  return (
    (start > 0 ? '…' : '') +
    clean.slice(start, end) +
    (end < clean.length ? '…' : '')
  );
}

/**
 * One listChats lineage hop WITHOUT the per-row message aggregate (lane
 * lifecycle second review fixer, 2026-10-21): the plain columns of `rowSelect`
 * for the ancestors, then each ancestor's message count (one chatId-indexed
 * groupBy) and newest rows (the select's own orderBy / take / select, one
 * chatId-indexed read per ancestor), merged into the same shape the full
 * select returns. Prisma's `_count` join aggregates the whole messages table
 * whenever the IN list holds more than one id. A failed fill re-reads the hop
 * with the full select (the pre-fix query). Throws only when that read does.
 */
async function leanAncestorHop(where: any, rowSelect: any): Promise<any[]> {
  const { _count: _omitCount, chatMessages: newestSpec, ...lean } = rowSelect;
  const rows: any[] = await prisma.crossModelChat.findMany({ where, select: lean });
  if (!rows.length) return rows;
  try {
    const ids = rows.map((r) => String(r.id));
    const [counts, newest] = await Promise.all([
      prisma.crossModelMessage.groupBy({ by: ['chatId'], where: { chatId: { in: ids } }, _count: { _all: true } }),
      Promise.all(ids.map((id) => prisma.crossModelMessage.findMany({ where: { chatId: id }, ...newestSpec }))),
    ]);
    const countBy = new Map<string, number>((counts ?? []).map((c: any) => [String(c.chatId), Number(c._count?._all ?? 0)]));
    return rows.map((r, i) => ({ ...r, _count: { chatMessages: countBy.get(String(r.id)) ?? 0 }, chatMessages: Array.isArray(newest[i]) ? newest[i] : [] }));
  } catch (err: unknown) {
    logger.warn(`listChats: lineage hop fill failed — full-select re-read: ${err instanceof Error ? err.message : String(err)}`);
    return prisma.crossModelChat.findMany({ where, select: rowSelect });
  }
}

export class CrossModelService {
  /**
   * Create a new chat
   */
  async createChat(userId: string, title: string, mode: PatienceMode | 'auto' = 'auto', projectId?: string | null, ghostMode = false) {
    // User Space auto-filing (P3 §3): a chat created WITHOUT an explicit
    // folder is filed into the owner's hidden user-space project — every chat
    // is code-CAPABLE from birth, while THE ROUTING RULE (§4) keeps its sends
    // plain until a satellite attaches. Best-effort: ensureUserSpace never
    // throws; a null result leaves the chat unfiled rather than failing its
    // creation. The Fleet Supervisor creates its rows DIRECTLY (never
    // routes here), so it stays unfiled at creation; historic feed chats
    // (retired 2026-10-20, ticket 43c24152) were created the same direct
    // way. (Creation path only — a later backfill may still file such
    // pre-existing unfiled rows; see scripts/backfill-user-space.ts.)
    let filingProjectId = projectId || null;
    if (!filingProjectId) {
      // Dynamic import, same discipline as the supervisor.service edge below
      // (platform modules sit upstream of this service).
      const { ensureUserSpace } = await import('./platform/user-space.service');
      filingProjectId = (await ensureUserSpace(userId))?.id ?? null;
    }
    const chat = await prisma.crossModelChat.create({
      data: {
        title,
        mode,
        // Ghost mode (owner 2026-10-22): the chat's private posture — set at
        // create (a "New ghost chat" affordance) or flipped later in
        // updateChat. Plain chats only: the platform's create_chat tool never
        // sets it and supervisor rows are created directly, never here.
        ...(ghostMode ? { ghostMode: true } : {}),
        user: {
          connect: { id: userId },
        },
        ...(filingProjectId ? { project: { connect: { id: filingProjectId } } } : {}),
        // NOTE: deprecated messages JSONB column intentionally omitted — never read,
        // all message storage uses the normalized crossModelMessage table instead.
      },
      select: {
        id: true,
        title: true,
        mode: true,
        projectId: true,
        isSupervisor: true,
        // Ghost mode (owner 2026-10-22): the created row's posture rides the
        // response so the client badges a "new ghost chat" immediately.
        ghostMode: true,
        createdAt: true,
        updatedAt: true,
        // Supervision opt-out (ticket 3217e287): the filing project's flag gates
        // the auto-provisioning trigger below — stripped from the return shape.
        project: { select: { supervised: true } },
      },
    });
    const { project: filingProject, ...chatRow } = chat;

    // Fleet Supervisor (best-effort, fire-and-forget): lazily ensure the
    // owner's ONE global supervisor chat (full fleet autonomy). Its wildcard
    // hook already covers this new chat — no per-chat wiring. NEVER awaited —
    // a supervisor hiccup must not slow or fail chat creation. Dynamic import:
    // supervisor.service pulls autonomy.service → crossmodel.service, so a
    // static edge would cycle.
    // Gated on the filing project's `supervised` flag (owner 2026-09-13,
    // ticket 3217e287): a chat created in an opted-OUT project must not
    // scaffold the fleet-supervisor framework. Ungrouped chats (no project row)
    // and the user-space auto-file (supervised=true by construction) still
    // trigger — mirrors the wildcard emission gate (hooks.service emitHooks).
    if (filingProject?.supervised !== false) {
      void import('./platform/supervisor.service')
        .then((sup) => sup.ensureFleetSupervisor(userId))
        .catch((err: any) => logger.warn(`fleet supervisor ensure failed (chat ${chat.id.slice(0, 8)}): ${err?.message}`));
    }

    return { ...chatRow, messages: [], messageCount: 0 };
  }

  /**
   * Compute the caller's access level to a chat.
   *   'owner' — caller owns the chat (full control including delete).
   *   'write' — caller is an editor/admin member of the chat's project.
   *   'read'  — caller is a viewer member of the chat's project.
   *   'none'  — caller has no relationship to this chat.
   * Returns 'none' if the chat doesn't exist (callers should still 404).
   *
   * Folder-ancestor membership (ticket 7acaa7ba, 2026-09-28): a member row on
   * an ANCESTOR folder grants the same access platform.service getProjectAccess
   * grants (nearest/strongest row wins; an ancestor folder's OWNER has full
   * owner access to the subtree). Before this, getChatAccess consulted ONLY the
   * leaf project's member row, so an editor on a parent folder 404'd on every
   * chat inside a child folder while getProjectAccess said 'editor' — the two
   * primitives disagreed. Flag off (FOLDERS_INHERITANCE=off) = exact old
   * leaf-only behavior.
   */
  async getChatAccess(
    chatId: string,
    userId: string,
  ): Promise<{ access: 'none' | 'read' | 'write' | 'owner'; exists: boolean }> {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { id: true, userId: true, projectId: true },
    });

    if (!chat) return { access: 'none', exists: false };
    if (chat.userId === userId) return { access: 'owner', exists: true };

    if (chat.projectId) {
      // Leaf row first — the common case needs zero extra queries. An ancestor
      // row can only RAISE the rank (max semantics, same as getProjectAccess:
      // breanne-class case = viewer on the leaf, editor on the parent folder).
      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: chat.projectId, userId } },
        select: { role: true },
      });
      const rankOf = (role: string) => (role === 'viewer' ? 1 : role === 'editor' ? 2 : role === 'admin' ? 3 : 0);
      let rank = member ? rankOf(member.role) : 0;
      // Ancestor inheritance — only when inheritance is on. Same semantics as
      // getProjectAccess: ancestor owner → 'owner'; else the strongest member
      // row anywhere on the chain wins.
      if (process.env.FOLDERS_INHERITANCE !== 'off') {
        const { getAncestorChain } = await import('./platform/folder-inheritance');
        const chain = await getAncestorChain(chat.projectId);
        const ancestors = chain.slice(0, -1); // root…parent (leaf = the chat's own folder)
        if (ancestors.some((f) => f.userId === userId)) {
          return { access: 'owner', exists: true };
        }
        if (ancestors.length) {
          const rows = await prisma.projectMember.findMany({
            where: { userId, projectId: { in: ancestors.map((f) => f.id) } },
            select: { role: true },
          });
          for (const r of rows) rank = Math.max(rank, rankOf(r.role));
        }
      }
      if (rank >= 2) return { access: 'write', exists: true };
      if (rank === 1) return { access: 'read', exists: true };
    }

    return { access: 'none', exists: true };
  }

  /**
   * List chats visible to the caller — their own chats plus chats inside any
   * project they belong to. (Feed-discussion chats — a retired feed's
   * `📡 <title>` chat, ticket b6ce8490 — render ungrouped like any other
   * chat; the feeds subsystem was retired 2026-10-20, ticket 43c24152, and
   * each surviving feed chat now holds its migrated digest schedule.)
   *
   * DB-level filters (P6 fleet-supervisor): `q` (case-insensitive title
   * substring), `projectId` (folder), `mode` — applied in the WHERE clause so
   * pagination stays correct. Derived filters (running / codeCapable / coding
   * status) live one layer up in platform.service.listChats, which full-fetches
   * and filters post-enrichment (they depend on the live-run registry and the
   * satellite table, not this table).
   *
   * Archive (owner 2026-09-08): the DEFAULT list excludes archived rows — a
   * chat's own archivedAt stamp AND chats riding inside an archived folder's
   * subtree (folder archival stamps only the folder; see archive-scope.ts).
   * `filters.archived === true` flips to the Archived browse view: ONLY the
   * caller's OWN individually-stamped chats (restore is owner-only, and chats
   * hidden via a folder are restored WITH the folder, never listed one by one).
   */
  async listChats(
    userId: string,
    page: number = 1,
    limit: number = 20,
    filters?: { q?: string; projectId?: string; mode?: string; archived?: boolean; updatedAfter?: Date; archivedAny?: boolean; excludeProjectIds?: readonly string[] },
  ) {
    const skip = (page - 1) * limit;

    // SUPERVISION SCOPE (ticket 03d14b78): the Fleet Supervisor's machine-run
    // reads subtract the owner's opted-out projects at the WHERE level, so
    // pagination/totals stay honest (a post-filter would leave a page short and
    // a `total` that counts rows the caller may not see). Empty ⇒ no clause.
    // An explicit projectId naming an opted-out project is refused at the TOOL
    // layer; here the AND-ed exclusion simply yields zero rows, so no caller can
    // ever widen past the scope by passing a projectId.
    const excludedProjectIds = (filters?.excludeProjectIds ?? []).filter(Boolean);

    const memberProjectIds = (
      await prisma.projectMember.findMany({
        where: { userId },
        select: { projectId: true },
      })
    ).map((m) => m.projectId);

    // Archive scope resolved ONCE (6201e0ee): archivedAny keeps the FOLDER
    // half of the exclusion and drops only the row-level archivedAt:null
    // requirement — a just-archived row must be REPORTED so the client can
    // drop it; chats inside archived FOLDERS stay hidden either way (they are
    // not what changed, and the client CANNOT filter them — a folder-archived
    // row's own archivedAt reads null).
    const hiddenProjectIds = await getArchiveHiddenProjectIds(userId, memberProjectIds);

    const whereClause: any = filters?.archived
      ? {
          // Archived view: own stamped chats only (see docblock above).
          userId,
          archivedAt: { not: null },
        }
      : {
          OR: [
            { userId },
            ...(memberProjectIds.length > 0 ? [{ projectId: { in: memberProjectIds } }] : []),
          ],
          // Default view: no archived chats, nothing inside archived folders.
          ...(filters?.archivedAny
            ? hiddenProjectIds.length
              ? { AND: [{ OR: [{ projectId: null }, { projectId: { notIn: hiddenProjectIds } }] }] }
              : {}
            : chatArchiveExclusion(hiddenProjectIds)),
        };
    // Supervision scope (03d14b78): subtract opted-out projects on BOTH arms.
    // `notIn` alone would drop the ungrouped (projectId null) chats — SQL NULL
    // never satisfies NOT IN — so the null arm is spelled out explicitly.
    if (excludedProjectIds.length) {
      const scopeClause = { OR: [{ projectId: null }, { projectId: { notIn: excludedProjectIds } }] };
      whereClause.AND = [...(Array.isArray(whereClause.AND) ? whereClause.AND : whereClause.AND ? [whereClause.AND] : []), scopeClause];
    }
    // The bare visibility scope (before any narrowing filter) — the lineage
    // completion below re-uses it so a pulled-in ancestor is exactly as
    // visible to the caller as any listed row.
    const visibilityWhere: any = { ...whereClause };
    // Sibling keys AND with the visibility OR — a folder/mode/q filter can only
    // ever NARROW the visible set, never leak a chat the caller cannot see.
    if (filters?.q) whereClause.title = { contains: filters.q, mode: 'insensitive' };
    if (filters?.projectId) whereClause.projectId = filters.projectId;
    if (filters?.mode) whereClause.mode = filters.mode;
    // Sidebar live refresh (ticket d6b2eef5): rows touched at/after a watermark
    // — the client's delta poll. Inclusive so a same-millisecond row is never
    // missed (the client merge is an idempotent upsert).
    if (filters?.updatedAfter) whereClause.updatedAt = { gte: filters.updatedAfter };

    const rowSelect = {
      id: true,
      title: true,
      mode: true,
      projectId: true,
      parentChatId: true, // sub-session lineage — sidebar grouping + fleet list rows
      // Display-only nesting fallback (2026-10-21, platform/display-parent.ts):
      // the folder's Project Supervisor for a machine-spawned lane — the sidebar
      // nests on it only when parentChatId is not in the list. Not selected at
      // all under DISPLAY_PARENT_NESTING_DISABLED=1 (rows byte-for-byte today's).
      ...(displayParentNestingDisabled() ? {} : { displayParentChatId: true }),
      isSupervisor: true,
      // A project's supervisor lane (2026-10-22, ghost composer toggle review
      // fix): the web's ghost controls hide on supervisor chats — without it a
      // Project Supervisor row offered a ghost switch whose save 400'd.
      isProjectSupervisor: true,
      ghostMode: true, // ghost mode (owner 2026-10-22): the sidebar badge + toggle read it
      userId: true,
      archivedAt: true, // archive state — the Archived view renders it; live rows read null
      createdAt: true,
      updatedAt: true,
      _count: { select: { chatMessages: true } },
      // Newest few rows, not one: a per-SESSION status card (origin
      // session_status, 2026-09-15) is an assistant row written FOR the
      // owner every hour — it must not re-arm the sidebar's "new response"
      // dot or become the preview line. The newest NON-card row is the
      // last message; picked in JS (a SQL NOT over a JSON path would drop
      // the many rows whose metadata is NULL).
      chatMessages: {
        orderBy: { createdAt: 'desc' as const },
        take: 3,
        select: { id: true, content: true, createdAt: true, role: true, metadata: true },
      },
    };

    const [pageRows, total] = await Promise.all([
      prisma.crossModelChat.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { updatedAt: 'desc' },
        select: rowSelect,
      }),
      prisma.crossModelChat.count({ where: whereClause }),
    ]);

    // Lineage completion (ticket d6b2eef5): a page carrying a CHILD whose parent
    // is not on it (a fresh sub-session is newer than its parent, so page 1
    // routinely has the child alone) pulls the missing ancestors — bounded hops,
    // the caller's own visibility scope, the folder filter honoured so a parent
    // in another folder never lands in this folder's list — and splices each
    // one in right before its first descendant. The frontend then nests on
    // first paint instead of rendering flat and regrouping on the next page.
    // Never applied to the Archived view or the delta poll's watermark (an
    // ancestor is pulled BECAUSE it predates the page). Fail-open: a lookup
    // error leaves the plain page.
    let chats: typeof pageRows = pageRows;
    if (!filters?.archived) {
      const known = new Set(pageRows.map((c) => c.id));
      const fetched: typeof pageRows = [];
      let frontier = missingParentIds(pageRows, known);
      // Lane lifecycle second review fixer (2026-10-21): with display parents on,
      // most hops carry 2+ ids, and the row select's `_count.chatMessages` makes
      // Postgres hash-aggregate the WHOLE crossmodel_messages table for any IN
      // list longer than one id — on the most-polled endpoint. The hop selects
      // the plain columns and fills the count + newest rows per ancestor from
      // chatId-indexed reads (fillAncestorMessages); a failed fill re-reads the
      // hop with the full select. DISPLAY_PARENT_NESTING_DISABLED=1 keeps the
      // single full-select hop byte-for-byte.
      const leanHops = !displayParentNestingDisabled();
      for (let hop = 0; hop < CHAT_LIST_ANCESTOR_HOPS && frontier.length > 0; hop++) {
        const ancestorWhere: any = { AND: [visibilityWhere, { id: { in: frontier } }] };
        if (filters?.projectId) ancestorWhere.projectId = filters.projectId;
        const parents: typeof pageRows = await (leanHops ? leanAncestorHop(ancestorWhere, rowSelect) : prisma.crossModelChat.findMany({ where: ancestorWhere, select: rowSelect }))
          .catch((err: unknown) => {
            logger.warn(`listChats: lineage completion lookup failed (hop ${hop}): ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
        if (parents.length === 0) break;
        for (const p of parents) known.add(p.id);
        fetched.push(...parents);
        frontier = missingParentIds(parents, known);
      }
      if (fetched.length > 0) chats = spliceAncestors(pageRows, fetched);
    }

    const chatsWithCount = chats.map((chat) => {
      const { _count, chatMessages: newestRows, ...rest } = chat;
      // The newest row that is not a harness session-status card (see the
      // select above); falls back to the newest row when only cards exist.
      const latest = newestRows.find((m: any) => m?.metadata?.origin !== 'session_status') ?? newestRows[0];
      const chatMessages = latest ? [latest] : [];
      return {
        ...rest,
        messages: [], // backward compat — frontend may check this field
        messageCount: _count.chatMessages,
          lastMessage: chatMessages.length > 0
          ? (chatMessages[0].content.length > 50
            ? chatMessages[0].content.substring(0, 50) + '...'
            : chatMessages[0].content)
          : null,
        // Message-activity markers for unread/attention UI — keyed to the
        // latest MESSAGE (not updatedAt, which also bumps on renames/moves).
        // lastMessageId also feeds the agent list_chats tool: the fleet's
        // citation contract lets a wake cite a lane's latest message by its
        // REAL id prefix instead of inventing one for a message it knows
        // exists but never pulled (2026-08-31 phantom-msg-id strikes).
        lastMessageAt: chatMessages.length > 0 ? chatMessages[0].createdAt : null,
        lastMessageRole: chatMessages.length > 0 ? chatMessages[0].role : null,
        lastMessageId: chatMessages.length > 0 ? chatMessages[0].id : null,
        // Owner 2026-09-16: the newest row's TRIGGER — absent/'user' = a human
        // turn, 'schedule' | 'hook' | 'agent' | 'machine' | … = machine
        // traffic. The sidebar's unread dot lights only for replies to humans.
        lastMessageOrigin: chatMessages.length > 0 ? ((chatMessages[0] as any)?.metadata?.origin ?? null) : null,
      };
    });

    // P5-B: expose the coding CAPABILITY on every row (the retired mode='code'
    // marker is gone; legacy coding chats are known by their satellite). The FE
    // chooses CodeSessionView vs chat view on hasWorkspaceState (User Space §5
    // — THE ROUTING RULE); codeCapable only gates the attach triggers. ONE
    // batched satellite query for the whole page feeds getChatCapability's
    // preloadedState path — no per-chat satellite N+1.
    const { getChatCapability } = await import('./coding/coding-data.service');
    const states: Array<{ id: string; worktreePath: string | null }> = await (prisma as any).chatCodingState
      .findMany({
        where: { id: { in: chats.map(c => c.id) } },
        select: { id: true, worktreePath: true },
      })
      .catch(() => []);
    const stateByChat = new Map(states.map(s => [s.id, { worktreePath: s.worktreePath }]));
    const chatsWithCapability = await Promise.all(chatsWithCount.map(async (chat) => {
      const cap = await getChatCapability(chat, stateByChat.get(chat.id) ?? null);
      return { ...chat, codeCapable: cap.codeCapable, hasWorkspaceState: cap.hasWorkspaceState };
    }));

    // Attention state: `running` must be fleet-accurate — chat-busy unions the
    // in-process registry, the Redis liveness keys (chat runs on the OTHER
    // blue/green instance, P5 audit), and the durable agent_runs table (coding
    // runs execute in the WORKER process). `awaitingInput` comes from the
    // Redis pending approval/question keys (value = sessionId). All best-effort:
    // a Redis/DB hiccup degrades to false, never a 500 on the chat list.
    const { getBusyChatIds } = await import('./chat-agent/chat-busy');
    const { getPendingAttentionMap } = await import('./coding/session-run-lock');
    const pageIds = chatsWithCapability.map((c) => c.id);
    const [busyIds, attentionMap, scheduledRows] = await Promise.all([
      getBusyChatIds(pageIds).catch(() => new Set<string>()),
      getPendingAttentionMap().catch(() => new Map<string, { approvals: string[]; questions: string[] }>()),
      // Sidebar schedule indicator: ONE batched query for the whole page (never
      // per-chat — the chat list is a hot path). Chats with at least one ENABLED
      // schedule row get hasActiveSchedule.
      prisma.chatSchedule.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: pageIds }, enabled: true },
      }).catch(() => [] as Array<{ sessionId: string }>),
    ]);
    const scheduledChatIds = new Set(scheduledRows.map((r) => r.sessionId));
    const chatsWithAttention = chatsWithCapability.map((chat) => {
      const attention = attentionMap.get(chat.id);
      return {
        ...chat,
        running: busyIds.has(chat.id),
        awaitingInput: !!attention,
        awaitingKind: attention ? (attention.questions.length > 0 ? 'question' : 'approval') : null,
        hasActiveSchedule: scheduledChatIds.has(chat.id),
      };
    });

    return {
      chats: chatsWithAttention,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Deep search across ALL of the caller's OWN chats — by chat TITLE and by
   * message CONTENT (case-insensitive substring via Prisma `contains` +
   * `mode:'insensitive'` — the ILIKE idiom listChats already uses for its `q`
   * title filter). Scoped strictly to `userId`: a chat merely shared into a
   * project the caller views is NOT searched (this is "search MY chats",
   * mirroring the owned rows the sidebar surfaces). Feed-backed chats are
   * NOT excluded — topic feeds were retired 2026-10-20 (ticket 43c24152)
   * and their chats list like any own chat (b6ce8490): never exclude
   * them again.
   *
   * Ranking is intentionally simple and predictable (debounce-friendly — two
   * indexed substring scans, no embeddings / rerank): title matches first
   * (the strongest signal), then message matches, each newest-first, with at
   * most `PER_CHAT_MESSAGE_CAP` message snippets per chat so one long
   * conversation cannot crowd out the rest. Capped at RESULT_CAP total.
   */
  async searchChatsAndMessages(
    userId: string,
    query: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<{ results: ChatSearchResult[] }> {
    const q = (query || '').trim();
    if (!userId || q.length === 0) return { results: [] };

    const RESULT_CAP = 50;
    const PER_CHAT_MESSAGE_CAP = 3;
    const SNIPPET_RADIUS = 90; // chars of context on each side of the match

    // Archive: search defaults exclude archived chats and chats riding inside
    // an archived folder's subtree (mirrors listChats; owned scope ⇒ no extras).
    // audit 2026-10-08 W1-3: `includeArchived` (the search_chats tool's default)
    // searches them too and marks each hit `archived: true` — the owner's
    // "archive completed sessions" rule made supervisor recall shrink daily.
    const hiddenProjectIds = await getArchiveHiddenProjectIds(userId);
    const archiveExclusion = opts.includeArchived ? {} : chatArchiveExclusion(hiddenProjectIds);
    const hidden = new Set(hiddenProjectIds);
    const isArchived = (chat: { archivedAt?: Date | null; projectId?: string | null }): boolean =>
      !!chat.archivedAt || (!!chat.projectId && hidden.has(chat.projectId));

    const [titleRows, messageRows] = await Promise.all([
      prisma.crossModelChat.findMany({
        where: { userId, title: { contains: q, mode: 'insensitive' }, ...archiveExclusion },
        orderBy: { updatedAt: 'desc' },
        take: RESULT_CAP,
        select: { id: true, title: true, projectId: true, updatedAt: true, ...(opts.includeArchived ? { archivedAt: true } : {}) },
      }),
      prisma.crossModelMessage.findMany({
        where: {
          content: { contains: q, mode: 'insensitive' },
          chat: { userId, ...archiveExclusion },
        },
        orderBy: { createdAt: 'desc' },
        // Over-fetch: the per-chat + global caps below trim; a burst of hits in
        // one chat must not starve results from other chats.
        take: RESULT_CAP * 4,
        select: {
          chatId: true,
          role: true,
          content: true,
          createdAt: true,
          chat: { select: { title: true, projectId: true, ...(opts.includeArchived ? { archivedAt: true } : {}) } },
        },
      }),
    ]);

    const results: ChatSearchResult[] = [];

    // Title matches first — the snippet IS the title (the whole match is visible).
    for (const c of titleRows) {
      results.push({
        chatId: c.id,
        chatTitle: c.title,
        snippet: c.title,
        messageRole: null,
        matchedAt: c.updatedAt.toISOString(),
        projectId: c.projectId,
        ...(opts.includeArchived && isArchived(c as any) ? { archived: true } : {}),
      });
    }

    // Then message-content matches, newest-first, capped per chat.
    const perChat = new Map<string, number>();
    for (const m of messageRows) {
      if (results.length >= RESULT_CAP) break;
      const seen = perChat.get(m.chatId) ?? 0;
      if (seen >= PER_CHAT_MESSAGE_CAP) continue;
      perChat.set(m.chatId, seen + 1);
      results.push({
        chatId: m.chatId,
        chatTitle: m.chat.title,
        snippet: buildSearchSnippet(m.content, q, SNIPPET_RADIUS),
        messageRole: m.role,
        matchedAt: m.createdAt.toISOString(),
        projectId: m.chat.projectId,
        ...(opts.includeArchived && isArchived(m.chat as any) ? { archived: true } : {}),
      });
    }

    return { results: results.slice(0, RESULT_CAP) };
  }

  /**
   * Inline image attachments (ticket c6e8edda): resolve user-row attachment
   * chips (metadata.attachments, stamped at send time with the staged
   * uploadId) against this chat's durable ChatFile rows so the transcript can
   * render image chips inline — fileId + mimeType are injected into matching
   * chips. Thin wrapper over chat-files.service's injectChatFileIds (shared
   * with the fleet thread): ONE batched lookup, fully guarded on malformed
   * metadata, new metadata objects (loaded rows never mutated), chips without
   * an uploadId/match pass through unchanged, failures never fail the load.
   */
  private async injectAttachmentFileIds<T extends { metadata?: unknown }>(
    chatId: string,
    messages: T[],
  ): Promise<T[]> {
    const { injectChatFileIds } = await import('./chat-files.service');
    return injectChatFileIds(chatId, messages);
  }

  /**
   * Shared-project author attribution (f89d1213): resolve the DISTINCT
   * metadata.authorId stamps on the loaded user rows into display names —
   * ONE batched users query (PK `in`), only when at least one row is stamped
   * (legacy chats cost nothing). Emails are intentionally NOT selected
   * (sharing.controller idiom). Returns null when nothing resolved — the
   * additive `messageAuthors` field is then omitted entirely, and the
   * frontend falls back to its 'teammate' label for unresolvable ids
   * (e.g. a deleted account). Best-effort: a lookup failure must never
   * fail the transcript load.
   */
  private async resolveMessageAuthors(
    messages: Array<{ role: string; metadata?: unknown }>,
  ): Promise<Record<string, string> | null> {
    const ids = [...new Set(
      messages
        .filter((m) => m.role === 'user')
        .map((m) => (m.metadata as { authorId?: unknown } | undefined)?.authorId)
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    )];
    if (ids.length === 0) return null;
    try {
      const users = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, firstName: true, lastName: true },
      });
      const map: Record<string, string> = {};
      for (const u of users) {
        const display = (u.name || [u.firstName, u.lastName].filter(Boolean).join(' ')).trim();
        if (display) map[u.id] = display;
      }
      return Object.keys(map).length > 0 ? map : null;
    } catch (err: any) {
      logger.warn(`resolveMessageAuthors failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get chat by ID — loads messages from the normalized messages table.
   * Allowed for the chat owner OR any member (viewer/editor/admin) of the
   * project the chat belongs to.
   *
   * Opt-in transcript paging (initial-load cap): with NO `paging.messageLimit`
   * this is the legacy full-transcript load, byte-for-byte unchanged for the
   * existing callers (controller getChat without query, platform readers,
   * deleteChat). With `messageLimit` it returns the NEWEST N messages
   * (chronological within the page) plus `hasMoreMessages` and — when more
   * pages exist — `nextMessagesBefore`, the message-id cursor for the next
   * older page. Conventions mirror platform.service.getChatMessages (which
   * stays separate: it lacks metadata/parts). Paged message objects ALSO
   * carry the row `id` (additive — unified plain-view transcript keys, flip
   * blocker M4); the legacy unpaged branch carries it too since ticket
   * 017f090b (additive — feedback rows link back via messageId).
   */
  async getChatById(
    chatId: string,
    userId: string,
    requiredAccess: 'read' | 'write' | 'owner' = 'read',
    paging?: { messageLimit?: number; messagesBefore?: string },
  ) {
    const { access, exists } = await this.getChatAccess(chatId, userId);

    if (!exists) throw new AppError(404, 'Chat not found');

    const order = { none: 0, read: 1, write: 2, owner: 3 } as const;
    if (order[access] < order[requiredAccess]) {
      // Use 404 to avoid leaking existence to non-members; matches list behaviour.
      throw new AppError(access === 'none' ? 404 : 403,
        access === 'none' ? 'Chat not found' : 'Insufficient permissions for this chat');
    }

    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        title: true,
        mode: true,
        userId: true,
        projectId: true,
        isSupervisor: true,
        // Project-supervisor lane flag (hardening 2026-09-14): every lifecycle
        // guard downstream (updateChat rename/move, sendChatMessage's router
        // gate) reads it off THIS select — without it the guards read
        // undefined and are dead code.
        isProjectSupervisor: true,
        systemPrompt: true, // standing instructions — the Session settings editor reads them (T3b, 2026-09-24)
        leadModel: true, // per-chat lead-seat override (WI-O #4c, 2026-09-25); null = the instance seat
        ghostMode: true, // ghost mode (owner 2026-10-22): the chat's private posture — the UI badge + toggle read it
        archivedAt: true, // archive is not tombstoning — direct loads carry the state so the UI can offer Restore
        createdAt: true,
        updatedAt: true,
      },
    });

    // ── Legacy path (no messageLimit): full transcript, EXACTLY as before. ──
    if (paging?.messageLimit === undefined) {
      // Load messages from normalized table
      const rows = await prisma.crossModelMessage.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true, updatedAt: true },
      });

      // Additive (ticket 017f090b): carry the row id on the legacy path too —
      // the paged path already does; feedback submissions link back via messageId.
      const legacyMessages: (Message & { id: string })[] = rows.map(r => ({
        id: r.id,
        role: r.role as 'user' | 'assistant',
        content: r.content,
        timestamp: r.createdAt.toISOString(),
        // Ticket 68916075: last-write stamp (≈ finalize for coding-run placeholder
        // rows); omitted when NULL (rows predating the field). createdAt never restamps.
        ...(r.updatedAt ? { updatedAt: r.updatedAt.toISOString() } : {}),
        ...(r.metadata ? { metadata: r.metadata as Message['metadata'] } : {}),
        // One-Digby: agent-engine turns persist their ordered work trail (tools,
        // delegations, plans) — surfaced in the UI as a "Show work" section.
        ...(r.parts ? { parts: r.parts as unknown as object[] } : {}),
      }));

      // Additive (c6e8edda): attachment chips gain fileId + mimeType from the
      // durable ChatFile rows so image chips render inline (one batched
      // lookup; legacy transcripts without stamps cost nothing).
      let messages = await this.injectAttachmentFileIds(chatId, legacyMessages);

      // Ticket f95e1e30 (part 2): the one-tap "vault this" flag. Derived HERE,
      // per read, from the OWNER's own user rows — never stamped at persist time,
      // so a paste that already sits in the transcript gets its button without
      // waiting for history to age in, and a scanner improvement reaches old rows
      // for free. Value-free (count + pattern names only); owner-only (a project
      // member never sees a button the vault route would refuse). See
      // platform/credential-paste.ts for the full rationale + measured cost.
      if (access === 'owner') messages = messages.map(annotateMessageCredentialPaste);

      // Additive (f89d1213): authorId → display-name map for stamped user rows
      // so the frontend can label teammate messages without an N+1.
      const messageAuthors = await this.resolveMessageAuthors(messages);
      // Ticket c0b2b0c8: the chat GET also returns the chat's QUEUED user
      // messages so a reloaded/re-attached tab re-renders the queued bubbles
      // the backend drain still answers. Omitted when empty (payload stays
      // byte-identical to pre-fix for idle chats).
      const pendingMessages = await this.pendingUserMessages(chatId);
      // Ticket 5060c3d2 (owner: "when i leave a chat and come back mid
      // response i dont see the current progress"): the chat GET must carry
      // the SAME cross-process busy truth `listChats` already ships, because
      // the view decides "attach to the live run" off this one round trip.
      // Without it the open path had only LOCAL marks (lost on unmount) plus
      // one one-shot probe whose tri-state `null` means "unknown" — so a
      // fresh tab during a run rendered a settled chat with no spinner and
      // no answer, i.e. looked dead. Best-effort like every liveness read:
      // a Redis/DB hiccup degrades to false, never a 500.
      const { isChatBusy } = await import('./chat-agent/chat-busy');
      const running = await isChatBusy(chatId).catch(() => false);
      return { ...chat!, messages, access, running, ...(messageAuthors ? { messageAuthors } : {}), ...(pendingMessages.length ? { pendingMessages } : {}) };
    }

    // ── Paged path: newest `messageLimit` messages (optionally older than the
    // `messagesBefore` cursor), chronological within the page. ──────────────
    const messageLimit = paging.messageLimit;
    let before: { createdAt: Date; id: string } | undefined;
    if (paging.messagesBefore) {
      const cursor = await prisma.crossModelMessage.findUnique({
        where: { id: paging.messagesBefore },
        select: { chatId: true, createdAt: true },
      });
      if (!cursor || cursor.chatId !== chatId) {
        throw new AppError(400, 'Invalid before cursor for this chat');
      }
      before = { createdAt: cursor.createdAt, id: paging.messagesBefore };
    }

    const rows = await prisma.crossModelMessage.findMany({
      // Compound cursor (createdAt, id) mirroring the sort below: createdAt is
      // @default(now()) at ms precision, so ties are possible (e.g. a drain
      // handoff writing two rows in the same ms). A plain `createdAt < cursor`
      // filter strands a tied row in NO page — it sorts below the cursor by id
      // yet `lt` excludes equality — so "older" must be
      // createdAt < c OR (createdAt = c AND id < c.id).
      where: {
        chatId,
        ...(before
          ? {
              OR: [
                { createdAt: { lt: before.createdAt } },
                { createdAt: before.createdAt, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: messageLimit + 1, // +1 row = the hasMore probe
      select: { id: true, role: true, content: true, metadata: true, parts: true, createdAt: true, updatedAt: true },
    });
    const hasMoreMessages = rows.length > messageLimit;
    const page = rows.slice(0, messageLimit).reverse(); // chronological within the page

    const pagedMessages: (Message & { id: string })[] = page.map(r => ({
      // Additive vs the legacy branch above: the paged DTO ALSO carries the
      // row id — the unified plain view keys its transcript rows by it and
      // it is the same id family the paging cursor uses (One-Session P2
      // flip blocker M4: key={undefined} across the whole mapped list).
      id: r.id,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      timestamp: r.createdAt.toISOString(),
      // Ticket 68916075: last-write stamp (≈ finalize for coding-run placeholder
      // rows); omitted when NULL (rows predating the field). createdAt never restamps.
      ...(r.updatedAt ? { updatedAt: r.updatedAt.toISOString() } : {}),
      ...(r.metadata ? { metadata: r.metadata as Message['metadata'] } : {}),
      ...(r.parts ? { parts: r.parts as unknown as object[] } : {}),
    }));

    // Additive (c6e8edda): same batched chip → ChatFile fileId injection as
    // the legacy branch, scoped to THIS page's rows.
    let messages = await this.injectAttachmentFileIds(chatId, pagedMessages);

    // Ticket f95e1e30 (part 2): same one-tap vault flag as the legacy branch —
    // scoped to this page, derived per read, owner-only, value-free.
    if (access === 'owner') messages = messages.map(annotateMessageCredentialPaste);

    // Additive (f89d1213): same author map as the legacy branch, scoped to
    // THIS page's stamped rows (older pages resolve on their own fetch).
    const messageAuthors = await this.resolveMessageAuthors(messages);
    // Ticket c0b2b0c8: queued user bubbles ride on EVERY page of the paged
    // transcript too (the queue is chat-scoped, not page-scoped) — a
    // re-attached tab paginating older history still re-seeds its queued
    // partition. Omitted when empty.
    const pendingMessages = await this.pendingUserMessages(chatId);
    // Ticket 5060c3d2: same busy truth as the legacy branch above — this is
    // the shape the unified view actually uses (messageLimit is always set),
    // so omitting it here would leave the mid-run revert exactly as broken.
    const { isChatBusy: isChatBusyPaged } = await import('./chat-agent/chat-busy');
    const running = await isChatBusyPaged(chatId).catch(() => false);
    return {
      ...chat!,
      messages,
      access,
      running,
      hasMoreMessages,
      ...(hasMoreMessages && page.length ? { nextMessagesBefore: page[0].id } : {}),
      ...(messageAuthors ? { messageAuthors } : {}),
      ...(pendingMessages.length ? { pendingMessages } : {}),
    };
  }

  /**
   * Ticket c0b2b0c8 — the chat GET's QUEUED-message surface. Returns the
   * chat's not-yet-drained PENDING user messages as renderable DTOs so a
   * reloaded/re-attached tab re-renders the queued bubbles the backend drain
   * still answers (local `tmp-*` echo state dies with the tab; before this
   * the queued message vanished from the UI while still being run).
   *
   * - user-source ONLY: `agent` (send_chat_message) / `webhook` rows are
   *   machine-generated and must never render as the human's bubbles.
   * - ids are `pending-<rowId>`: they cannot collide with DB message ids
   *   (cuid) or the view's local echo ids (`tmp-*` / `steer-*`), and the
   *   frontend routes them into the queued partition by set membership.
   * - `pending: true` marks the row for the client as not-yet-persisted.
   */
  private async pendingUserMessages(chatId: string): Promise<
    { id: string; role: 'user'; content: string; timestamp: string; pending: true }[]
  > {
    // Fail-open: this is optional transcript ENRICHMENT — a pending-queue
    // hiccup (or an older/mock prisma surface without the model) must never
    // 500 the chat GET itself; the client then just sees the persisted
    // transcript, exactly the pre-fix behaviour (ticket c0b2b0c8).
    let rows: { id: string; content: string; createdAt: Date }[];
    try {
      rows = (await prisma.pendingChatMessage.findMany({
        where: { chatId, source: 'user' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, content: true, mode: true, createdAt: true },
      })) ?? [];
    } catch {
      return [];
    }
    return rows.map(r => ({
      id: `pending-${r.id}`,
      role: 'user' as const,
      content: r.content,
      timestamp: r.createdAt.toISOString(),
      pending: true as const,
    }));
  }

  /**
   * Delete chat — owner only. Editors/admins of a shared project cannot delete
   * other people's chats.
   */
  async deleteChat(chatId: string, userId: string) {
    await this.getChatById(chatId, userId, 'owner');

    // One-Digby merge: a coding chat carries runtime state (container, worktree,
    // session memory) — clean it up best-effort before the row goes (mirrors the
    // /coding delete path). Dynamic imports avoid a static cycle with coding/.
    const codingState = await (prisma as any).chatCodingState
      .findUnique({ where: { id: chatId }, select: { id: true, projectId: true } })
      .catch(() => null);
    if (codingState) {
      try {
        const { stopSessionContainer, removeSandboxHome } = await import('./coding/container.service');
        const { removeWorktree, removeSessionEnv } = await import('./coding/workspace.service');
        const { clearSessionMemory } = await import('./coding/coding-retrieval.service');
        const { deleteWorktreeSnapshot } = await import('./coding/worktree-snapshot.service');
        await stopSessionContainer(chatId).catch(() => {});
        await removeSandboxHome(chatId).catch(() => {}); // durable HOME (e267b760) too
        await removeWorktree(codingState.projectId, chatId).catch(() => {});
        await removeSessionEnv(chatId).catch(() => {}); // env-seed sidecar too
        await clearSessionMemory(chatId).catch(() => {});
        // Ticket 1c767622 (review round-2 finding 2 — the CANONICAL delete
        // path): the chat row dies, so its shared snapshot must too — a
        // deleted chat's file contents must not persist in Redis for 30d.
        await deleteWorktreeSnapshot(chatId).catch(() => {});
      } catch { /* best-effort — never block the delete */ }
      // Satellite first (no chat→state DB cascade until the P1-D FK lands).
      await (prisma as any).chatCodingState.delete({ where: { id: chatId } }).catch(() => {});
    }

    // Unified memory: drop this chat's distilled conversation record so deleted
    // content can't resurface in episodic recall. Best-effort, never blocking.
    try {
      const { memReplaceRef } = await import('./memory/unified-memory.service');
      await memReplaceRef({ type: 'user', id: userId }, 'conversation', chatId, []).catch(() => {});
    } catch { /* best-effort */ }

    await prisma.crossModelChat.delete({
      where: { id: chatId },
    });

    // Privacy (fs-durable-memory review, 2026-10-23): the chat's FK-less rows
    // go with it — the context store's chat-keyed namespaces (the thread
    // summary [chatId,'thread'] and a supervisor's cold closed-row archive
    // [chatId,'supervisor-archive'] — owner directive text + evidence) and the
    // chat-scope memory (the supervisor ledger's mirror rows). AFTER the row
    // delete (a failed delete keeps them); best-effort, never blocking.
    try {
      const { storeDeleteChatScoped } = await import('./memory/context-store');
      await storeDeleteChatScoped([chatId]);
    } catch (err: any) {
      logger.warn(`deleteChat: chat-keyed store cleanup failed for ${chatId}: ${err?.message ?? err}`);
    }
    try {
      const { memClear } = await import('./memory/unified-memory.service');
      await memClear({ type: 'chat', id: chatId }).catch(() => {});
    } catch { /* best-effort */ }

    // Attribution for every delete path that funnels here (feedback 138b0347).
    await audit(userId, 'chat.delete', { chatId });

    return { message: 'Chat deleted successfully' };
  }

  /**
   * Update chat (title, mode, or projectId). Owner or project editor/admin.
   * Moving a chat between projects still requires ownership of the CHAT, and
   * the mover must ALSO hold write access (owner or editor/admin member,
   * ancestor inheritance included) on the DESTINATION project — filing a chat
   * into a project injects that project's systemPrompt and [KNOWLEDGE BASE]
   * (RAG is scoped purely by chat.projectId) and grants its editors write on
   * the chat, so an unchecked target would leak another user's knowledge base.
   * A CODING chat (ChatCodingState satellite) may move ONLY into a plain folder
   * (repoProvider NULL) — detaching the session from its repo project; moves to
   * another workspace project or to null are refused. A PLAIN chat moved to
   * null re-files into the owner's hidden user-space project (User Space P3 §3
   * — "No folder (ungrouped)" IS the user space now), never disconnects.
   * P4: a mode update is normalized at this boundary — retired modes alias
   * (`deep_research_all` → `deep_research`, `fast`/`single` → `single_thinking`).
   * 2026-09-26: 'auto' IS persisted (the stored default — routed per send).
   */
  async updateChat(
    chatId: string,
    userId: string,
    data: { title?: string; mode?: PatienceMode | 'auto'; projectId?: string | null; systemPrompt?: string | null; leadModel?: string | null; ghostMode?: boolean },
    /** Session titles (2026-09-27): a title write PINS the chat (titlePinned=true — every harness renderer / repair path stops)
     *  unless the caller says `pinTitle:false` (a lane's goal-half override of its own chat via rename_chat). */
    titleOpts: { pinTitle?: boolean } = {},
  ) {
    // P4 intake normalization (before any guard reads data.mode).
    if (data.mode !== undefined) {
      data = { ...data, mode: normalizePatienceMode(data.mode) };
    }
    // Per-chat lead-seat override (WI-O #4c, 2026-09-25): '' / null clears; a
    // value must be a pick the Digby seat itself offers (built-ins from
    // builtInOptionsFor('chat_orchestrator') or an enabled [coding]-flagged
    // '<label>:<modelId>' registry model — legacy ids alias forward).
    if (data.leadModel !== undefined) {
      const raw = typeof data.leadModel === 'string' ? data.leadModel.trim() : '';
      if (!raw) {
        data = { ...data, leadModel: null };
      } else {
        const { resolveChatLeadPick, chatLeadBuiltInOptions } = await import('./chat-agent/chat-lead-model');
        const resolved = await resolveChatLeadPick(raw, userId);
        if (!resolved) {
          throw new AppError(400, `"${raw}" is not a lead model this instance offers: use a built-in (${(await chatLeadBuiltInOptions()).join(' / ')}) or an enabled "<label>:<modelId>" endpoint model flagged [coding].`);
        }
        data = { ...data, leadModel: resolved };
      }
    }
    // Standing instructions (T3b, 2026-09-24): trimmed; '' ⇒ null (cleared).
    if (data.systemPrompt !== undefined) {
      const sp = typeof data.systemPrompt === 'string' ? data.systemPrompt.trim() : '';
      if (sp.length > 20000) throw new AppError(400, 'Standing instructions must be ≤ 20,000 characters');
      data = { ...data, systemPrompt: sp ? sp : null };
    }

    // Moving a chat in/out of a project — and rewriting its standing
    // instructions (a persistence primitive on every future turn) — are
    // ownership-only operations.
    const required: 'write' | 'owner' = data.projectId !== undefined || data.systemPrompt !== undefined ? 'owner' : 'write';
    const existingChat = await this.getChatById(chatId, userId, required);
    if ((existingChat.isSupervisor || existingChat.isProjectSupervisor) && data.systemPrompt !== undefined) {
      throw new AppError(400, 'A supervisor chat\'s prompt is platform-managed and cannot be edited');
    }
    // The lead override is a PLAIN-chat setting: supervisor chats resolve their
    // own seats (Account → Admin → Endpoints → Model roles) and a coding session's
    // agent is the satellite's model (set_session_model / the side panel).
    if (data.leadModel !== undefined) {
      if (existingChat.isSupervisor || existingChat.isProjectSupervisor) {
        throw new AppError(400, 'A supervisor chat\'s lead model is its platform seat (Account → Admin → Endpoints → Model roles) and cannot be overridden per chat');
      }
      const codingState = await (prisma as any).chatCodingState.findUnique({ where: { id: chatId }, select: { id: true } });
      if (codingState) {
        throw new AppError(400, 'This chat is a coding session — its agent model is set with set_session_model (or the session side panel), not a chat lead override');
      }
    }
    // Ghost mode (owner 2026-10-22) is a PLAIN-chat posture, same rule as the
    // lead override: a supervisor chat's models are its platform seats, a
    // coding session's agent is the satellite's model. Flipping privacy on a
    // supervisor row would also strip its own memory folds — never allowed.
    if (data.ghostMode !== undefined) {
      if (existingChat.isSupervisor || existingChat.isProjectSupervisor) {
        throw new AppError(400, 'A supervisor chat cannot run in ghost mode — its models are platform seats and its memory is the fleet audit trail');
      }
      const codingState = await (prisma as any).chatCodingState.findUnique({ where: { id: chatId }, select: { id: true } });
      if (codingState) {
        throw new AppError(400, 'A coding session cannot run in ghost mode — its agent is the satellite\'s model (set_session_model)');
      }
    }

    // The Fleet Supervisor is a pinned system row: its title is a fixed label
    // and it must stay ungrouped (it spans the whole fleet). Mode changes stay
    // allowed. Covers the UI rename/move AND the rename_chat/move_chat tools.
    if (existingChat.isSupervisor && (data.title !== undefined || data.projectId !== undefined)) {
      throw new AppError(400, 'The Fleet Supervisor chat cannot be renamed or moved');
    }
    // A PROJECT supervisor chat is pinned the same way (hardening 2026-09-14):
    // its title tracks the project name ('<project> Supervisor', healed every
    // 15 min) and its projectId IS its identity — the state doc, project-scope
    // hook and hourly sweep are keyed on the row. A move into a project that
    // already has a lane trips the partial unique index (raw P2002 → 500); a
    // move into a lane-less project re-homes THIS row as that project's
    // supervisor while the origin project scaffolds a fresh amnesiac lane.
    // Same shape as the fleet guard above (an owner UI action on a system row,
    // not a machine-lane gate); mode changes stay allowed. SEPARATE message so
    // the pinned fleet string is unchanged. Note: pausing keeps
    // isProjectSupervisor=true (pause-never-delete), so the toggle does NOT
    // unlock a move — there is no legal move for this row.
    if (existingChat.isProjectSupervisor && (data.title !== undefined || data.projectId !== undefined)) {
      throw new AppError(400, 'A project supervisor chat is pinned to its project and cannot be renamed or moved');
    }

    // Framework surface (ticket 9471d338): the platform's own project is a
    // system surface — its framework lanes never move out, and nothing moves
    // in (Management → Framework is the only way to reach them). This is the
    // shared chokepoint: the move_chat tool AND every UI move (sidebar
    // drag/drop, the Move-to-folder dialog via REST PATCH) ride updateChat.
    // Renames of framework chats stay allowed (titles are chat state; the
    // project-row leaf guards own the project itself).
    if (data.projectId !== undefined) {
      const { instanceOwnRepoSlugSoft, isFrameworkProjectRow, frameworkGuardMessage } = await import('./platform/framework-project');
      const ownRepo = instanceOwnRepoSlugSoft();
      const currentProject = existingChat.projectId
        ? await prisma.crossModelProject.findUnique({ where: { id: existingChat.projectId }, select: { repoUrl: true } })
        : null;
      if (isFrameworkProjectRow(currentProject, ownRepo)) {
        throw new AppError(400, frameworkGuardMessage('move-out'));
      }
      if (data.projectId !== null) {
        const destProject = await prisma.crossModelProject.findUnique({ where: { id: data.projectId }, select: { repoUrl: true } });
        if (isFrameworkProjectRow(destProject, ownRepo)) {
          throw new AppError(403, frameworkGuardMessage('move-into'));
        }
      }
    }

    // P5-B / Fleet-HQ re-homing: a coding chat (ChatCodingState satellite) may
    // move ONLY into a PLAIN folder (repoProvider NULL), which detaches the
    // session from its repo project. Chat.projectId drives sidebar filing,
    // prompt/RAG scope and member access, while the whole coding run path keys
    // off the SATELLITE's projectId — so both rows move together in ONE
    // transaction below (a chat-only flip would split-brain the session). The
    // on-disk worktree is chatId-keyed (workspace.service worktreePath), so a
    // live worktree survives the move untouched; a re-provision after a reap
    // lands a repo-less blank worktree (run-executor ensureRunnable →
    // ensureBlankWorktree), and repo continuity stays with the old project.
    // Moves to ANOTHER workspace project (repoProvider set) would re-key the
    // repo — refused; moving to null is refused (the satellite's project
    // include drives the run path). Patience-mode changes on a coding chat are
    // unaffected (coding is the satellite, never a stored mode='code').
    let codingMoveTarget: string | null = null;
    if (data.projectId !== undefined) {
      // Destination authorization: the mover must hold write on the TARGET
      // project (owner or editor/admin member — the same getProjectAccess the
      // rest of the platform uses, ancestor inheritance included). 404-shaped
      // like platform.service.updateProject so a non-member can't confirm the
      // project exists. Dynamic import: platform.service statically imports
      // this service, so a static edge would cycle (same pattern as the
      // supervisor.service import in createChat).
      let targetProject: { id: string; repoProvider: string | null } | null = null;
      if (data.projectId !== null) {
        const { getProjectAccess } = await import('./platform/platform.service');
        const targetAccess = await getProjectAccess(data.projectId, userId);
        if (!targetAccess || targetAccess.role === 'viewer') {
          throw new AppError(404, 'Project not found or insufficient permissions');
        }
        targetProject = targetAccess.project;
      }

      // NO .catch on the satellite lookup: a DB error here must fail the whole
      // move. Swallowing it would classify a coding chat as plain and run the
      // chat-only update below — the exact chat-row/satellite split-brain the
      // $transaction exists to prevent.
      const codingState = await (prisma as any).chatCodingState.findUnique({
        where: { id: chatId },
        select: { id: true },
      });
      if (codingState) {
        if (!targetProject) {
          throw new AppError(400, 'A coding chat must stay filed in a folder — moving it out of its project is not allowed');
        }
        if (targetProject.repoProvider) {
          throw new AppError(400, 'Moving a coding chat into another workspace project would re-key its repo — start a new session there instead');
        }
        codingMoveTarget = data.projectId;
      } else if (data.projectId === null) {
        // User Space (P3 §3): for a PLAIN chat, "No folder (ungrouped)" no
        // longer disconnects — it RE-FILES the chat into the owner's hidden
        // user-space project (every chat is filed; the sidebar renders the
        // space as today's ungrouped section). The mover owns their space by
        // construction, so no destination authz applies. Best-effort: a
        // user-space hiccup (null) falls back to the legacy disconnect rather
        // than failing the move. Coding chats never reach here — the null-400
        // above fired first; the supervisor refusal fired earlier still.
        const { ensureUserSpace } = await import('./platform/user-space.service');
        const userSpace = await ensureUserSpace(userId);
        if (userSpace) data = { ...data, projectId: userSpace.id };
      }
    }

    // Handle projectId separately — need to use connect/disconnect
    const { projectId, ...rest } = data;
    const updateData: any = { ...rest };
    // Session titles (2026-09-27): a human / REST / tool rename pins the title
    // (the harness renderer and every repair path return early on it); a lane's
    // own goal-half override passes pinTitle:false and stays harness-refreshed.
    if (typeof data.title === 'string' && data.title.trim()) {
      updateData.titlePinned = titleOpts.pinTitle !== false;
      if (titleOpts.pinTitle !== false) updateData.titleStep = null;
    }
    if (data.systemPrompt !== undefined) {
      await audit(userId, data.systemPrompt ? 'chat.instructions.set' : 'chat.instructions.clear', { chatId, chars: data.systemPrompt?.length ?? 0, via: 'rest' });
    }

    if (projectId !== undefined) {
      if (projectId === null) {
        // Remove from project — reachable only as the User-Space fallback
        // (ensureUserSpace hiccup above): a plain chat's null move normally
        // re-files into the user space instead of disconnecting.
        updateData.project = { disconnect: true };
      } else {
        // Move to project
        updateData.project = { connect: { id: projectId } };
      }
    }

    if (codingMoveTarget) {
      // Coding chat → plain folder: flip BOTH rows atomically so the sidebar
      // filing / prompt scope (chat row) and the coding engine's project
      // pointer (satellite row) can never diverge.
      const moveTarget = codingMoveTarget;
      await prisma.$transaction(async (tx) => {
        await tx.crossModelChat.update({ where: { id: chatId }, data: updateData });
        await (tx as any).chatCodingState.update({
          where: { id: chatId },
          data: { projectId: moveTarget },
        });
      });
    } else {
      await prisma.crossModelChat.update({
        where: { id: chatId },
        data: updateData,
      });
    }

    // Return updated chat with messages from normalized table
    return this.getChatById(chatId, userId, 'read');
  }
}

export default new CrossModelService();
