/**
 * Chat-list lineage completion (ticket d6b2eef5, 2026-09-28).
 *
 * WHY: the sidebar nests a CHILD chat (parentChatId set — a session spawned by
 * another chat) under its parent row, but the list is paged 30 rows by recency.
 * A freshly spawned child is newer than its parent, so page 1 often carried the
 * child WITHOUT the parent: the child rendered flat, then jumped under its
 * parent once a later page (or a reload) brought the parent in — the "sidebar
 * quickly reorganizes itself" the owner reported. The fix completes lineage
 * SERVER-SIDE: a page that carries a child whose ancestor is missing pulls that
 * ancestor (bounded hops, same visibility scope) and splices it in right before
 * its first descendant, so nesting is right on first paint.
 *
 * Display parents (2026-10-21, platform/display-parent.ts): a machine-spawned lane
 * may also carry displayParentChatId — the folder's Project Supervisor, the
 * sidebar's nesting fallback when parentChatId is absent from the list. It is
 * completed the same way (the supervisor row is pulled onto a page carrying a
 * ticket lane, so the lane nests on first paint); the row is selected only
 * when DISPLAY_PARENT_NESTING_DISABLED is unset, so under the switch these
 * helpers see parentChatId alone, exactly as before.
 *
 * Pure helpers only — the DB reads stay in crossmodel.service listChats.
 */

export interface LineageRow {
  id: string;
  parentChatId?: string | null;
  /** Display-only nesting fallback (the folder's Project Supervisor); never lineage authority. */
  displayParentChatId?: string | null;
}

/** How many parent hops a page completes (child → parent → grandparent). */
export const CHAT_LIST_ANCESTOR_HOPS = 2;

/**
 * Parent ids referenced by `rows` that are not in `known` (deduped, input
 * order — per row its parentChatId first, then its displayParentChatId).
 * `known` is the set of ids already on the page (and already fetched
 * ancestors) — the caller adds what it fetches before asking for the next hop.
 * A display parent is collected even when the real parent is known: the
 * client may still filter that parent out (the hidden Fleet Supervisor), and
 * then the display parent is what the lane nests under.
 */
export function missingParentIds(rows: ReadonlyArray<LineageRow>, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const p of [r.parentChatId, r.displayParentChatId]) {
      if (!p || known.has(p) || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Insert every fetched ancestor right BEFORE its first descendant in `rows`
 * (grandparent before parent before child), keeping the page's own order for
 * everything else. An ancestor no page row descends from is appended at the
 * end (defensive — the caller only fetches referenced parents). Idempotent:
 * an ancestor already on the page is never duplicated. The walk follows a
 * row's parentChatId when that ancestor was fetched, else its
 * displayParentChatId when THAT was fetched, else stops.
 */
export function spliceAncestors<T extends LineageRow>(rows: ReadonlyArray<T>, ancestors: ReadonlyArray<T>): T[] {
  if (ancestors.length === 0) return [...rows];
  const onPage = new Set(rows.map((r) => r.id));
  const byId = new Map<string, T>();
  for (const a of ancestors) if (!onPage.has(a.id) && !byId.has(a.id)) byId.set(a.id, a);
  if (byId.size === 0) return [...rows];

  const emitted = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    // Collect the not-yet-emitted fetched ancestors of this row, nearest first,
    // then emit them top-most first so a grandparent precedes its parent.
    const chain: T[] = [];
    const guard = new Set<string>([row.id]);
    // The next fetched ancestor: the real parent when it was fetched, else the
    // display parent when it was (an on-page / unknown id stops the walk).
    const next = (r: T): string | null => {
      if (r.parentChatId && byId.has(r.parentChatId)) return r.parentChatId;
      if (r.displayParentChatId && byId.has(r.displayParentChatId)) return r.displayParentChatId;
      return null;
    };
    let parentId = next(row);
    while (parentId && !guard.has(parentId)) {
      guard.add(parentId);
      const a = byId.get(parentId)!;
      if (!emitted.has(a.id)) chain.push(a);
      parentId = next(a);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      emitted.add(chain[i].id);
      out.push(chain[i]);
    }
    out.push(row);
  }
  for (const a of byId.values()) if (!emitted.has(a.id)) out.push(a);
  return out;
}
