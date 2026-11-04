/**
 * Sub-session sidebar grouping (2026-09-02, sub-session promotion piece 6).
 *
 * Pure helpers — no React: the sidebar's chat lists (ungrouped section + each
 * folder's chats) group CHILD chats (parentChatId set — sessions spawned by
 * another chat via start_coding_session) nested under their parent row.
 *
 * Fallback contract: a child whose parent is NOT in the given list (other
 * page, filtered out, preview-sliced away, or deleted — parentChatId is a
 * soft ref) nests under its DISPLAY parent when that one is in the list, and
 * otherwise renders FLAT as its own top-level row; nothing is ever hidden by
 * grouping. Deeper descendants attach to their nearest IN-LIST ancestor, so
 * the render stays one indent level while grandchildren remain visible.
 *
 * Display parents (2026-10-21): a machine-spawned lane — a ticket / family
 * lane the ticket drain spawned with no parent, a lane the (hidden, ungrouped)
 * Fleet Supervisor spawned into a folder — carries displayParentChatId = the
 * folder's Project Supervisor (server: platform/display-parent.ts). The real
 * parent always wins when it is in the list (a lane's own child stays under
 * that lane); the display parent is only the fallback. It is display-only —
 * nothing else in the app reads it — and the server stops sending it under
 * DISPLAY_PARENT_NESTING_DISABLED=1, which restores parentChatId-only nesting.
 */

export interface LineageChat {
  id: string;
  parentChatId?: string | null;
  /** Display-only nesting fallback (the folder's Project Supervisor). */
  displayParentChatId?: string | null;
}

/**
 * The row a chat nests under in THIS list: its parentChatId when that row is
 * in the list, else its displayParentChatId when THAT row is, else null (a
 * root). A self-reference is never a parent.
 */
export function nestParentId<T extends LineageChat>(chat: T, byId: ReadonlyMap<string, T>): string | null {
  const p = chat.parentChatId;
  if (p && p !== chat.id && byId.has(p)) return p;
  const d = chat.displayParentChatId;
  if (d && d !== chat.id && byId.has(d)) return d;
  return null;
}

export interface ChatGroup<T extends LineageChat> {
  chat: T;
  /** Direct + deeper descendants present in the input list, in input order. */
  children: T[];
  /**
   * Ids of the children whose walk to this root crossed a DISPLAY-parent hop
   * (a machine-spawned lane under the folder's supervisor, and that lane's own
   * descendants). Set only when non-empty. The folder preview bounds these
   * (previewChatGroups); real-lineage children are never trimmed.
   */
  displayChildIds?: ReadonlySet<string>;
  /** Preview only: display-attached children left behind "Show more". */
  hiddenChildCount?: number;
}

/** One flattened sidebar row (see flattenChatGroups). */
export interface LineageRow<T extends LineageChat> {
  chat: T;
  /** True = render indented under the preceding parent row. */
  isChild: boolean;
  /** Number of nested children under this row (0 for child rows). */
  childCount: number;
  /** True = this parent's children are currently hidden (show the count). */
  collapsed: boolean;
  /**
   * Set (> 0) only on the LAST child row of an expanded group whose preview
   * left display-attached children out: render a "+N more sub-sessions" row
   * after it (the folder's "Show more" reveals them).
   */
  moreChildren?: number;
}

/**
 * Group a chat list by lineage. Top-level groups keep the INPUT order of their
 * root chats (the lists arrive sorted by recency); children keep input order
 * within their group. Cycle-safe: a lineage cycle (impossible via spawn, but
 * the column is a soft ref) degrades to every member rendering, none lost.
 */
export function groupChatsByParent<T extends LineageChat>(chats: T[]): Array<ChatGroup<T>> {
  const byId = new Map(chats.map((c) => [c.id, c]));

  /** Walk up the nesting chain (nestParentId — the in-list parent, else the
   *  in-list display parent) to the nearest TOP in-list ancestor (self when
   *  neither is in the list — the flat-render fallback); `viaDisplay` = some
   *  hop took the display parent (the real one was off-list). */
  const walkUp = (chat: T): { root: T; viaDisplay: boolean } => {
    let current = chat;
    let viaDisplay = false;
    const seen = new Set<string>([chat.id]);
    for (let next = nestParentId(current, byId); next && !seen.has(next); next = nestParentId(current, byId)) {
      if (next !== current.parentChatId) viaDisplay = true;
      current = byId.get(next)!;
      seen.add(current.id);
    }
    return { root: current, viaDisplay };
  };
  const rootOf = (chat: T): T => walkUp(chat).root;

  const isRoot = (chat: T): boolean => rootOf(chat).id === chat.id;

  const groups = new Map<string, ChatGroup<T>>();
  const displayChildIds = new Map<string, Set<string>>();
  const order: string[] = [];
  const ensureGroup = (root: T): ChatGroup<T> => {
    let g = groups.get(root.id);
    if (!g) {
      g = { chat: root, children: [] };
      groups.set(root.id, g);
      order.push(root.id);
    }
    return g;
  };

  // Pass 1: register every ROOT at its own input position.
  for (const c of chats) {
    if (isRoot(c)) ensureGroup(c);
  }
  // Pass 2: attach non-roots (input order) under their nearest in-list root.
  // Cycle pathology (soft-ref column — impossible via spawn, but never trust
  // it): a chain whose walk lands on a NON-root resolves to a flat own row, so
  // every chat renders exactly once and React keys stay unique.
  for (const c of chats) {
    if (isRoot(c)) continue;
    const { root, viaDisplay } = walkUp(c);
    if (isRoot(root)) {
      ensureGroup(root).children.push(c);
      if (viaDisplay) {
        const via = displayChildIds.get(root.id) ?? new Set<string>();
        via.add(c.id);
        displayChildIds.set(root.id, via);
      }
    } else ensureGroup(c);
  }
  return order.map((id) => {
    const g = groups.get(id)!;
    const via = displayChildIds.get(id);
    if (via) g.displayChildIds = via;
    return g;
  });
}

/**
 * Flatten groups into render rows, honoring per-parent collapse state:
 * a collapsed parent keeps its row (childCount shows the hidden count) and
 * skips its children. Childless chats are plain rows (childCount 0).
 */
export function flattenChatGroups<T extends LineageChat>(
  groups: Array<ChatGroup<T>>,
  collapsedParentIds: ReadonlySet<string>,
): Array<LineageRow<T>> {
  const rows: Array<LineageRow<T>> = [];
  for (const g of groups) {
    const hidden = g.hiddenChildCount ?? 0;
    const collapsed = g.children.length > 0 && collapsedParentIds.has(g.chat.id);
    // A preview-trimmed group's count names every child, shown or not.
    rows.push({ chat: g.chat, isChild: false, childCount: g.children.length + hidden, collapsed });
    if (!collapsed) {
      for (const child of g.children) {
        rows.push({ chat: child, isChild: true, childCount: 0, collapsed: false });
      }
      if (hidden > 0 && g.children.length > 0) rows[rows.length - 1].moreChildren = hidden;
    }
  }
  return rows;
}

/* ── Folder preview over GROUPS (owner 2026-10-20: "sessions that are child to
 * parent sessions all load under each other and then everything scrambles
 * underneath in the right place after it's loaded") ─────────────────────────
 *
 * The folder preview used to slice the flat newest-N chats FIRST and group
 * by parent AFTER, so a fresh child (newer than its parent) landed in the
 * preview while its parent did not — rendering flat — until a later state
 * change (running ids, the delta poll, "Show more") pulled the parent in and
 * everything re-nested. Grouping now happens on the WHOLE folder list and the
 * preview is taken over groups: a parent and its children are ONE preview
 * unit, ordered by the group's newest activity, active groups pinned first.
 * Pure: the same inputs always give the same nesting, whatever loaded first. */

export interface PreviewGroupsResult<T extends LineageChat> {
  /** Groups to render (parents with their children), active groups first. */
  visible: Array<ChatGroup<T>>;
  /** Chats (parents + children) left behind the "Show more" toggle. */
  hiddenCount: number;
  /** True when a "Show more / Show less" toggle makes sense at all. */
  overflow: boolean;
}

/** Newest activity stamp in a group (the root or any child). */
export function groupActivityMs<T extends LineageChat & { updatedAt?: string | null }>(g: ChatGroup<T>): number {
  const stamp = (c: T) => new Date(c.updatedAt || 0).getTime() || 0;
  return Math.max(stamp(g.chat), ...g.children.map(stamp));
}

/**
 * Bound a group's DISPLAY-attached children for the preview (review fix
 * 2026-10-21): once every ticket / family / Fleet-spawned lane nests under the
 * Project Supervisor the whole folder is ONE group, and a group renders all of
 * its children — so the group-level slice alone showed every lane and the
 * "Show more" toggle vanished. Keeps every active display child (the open
 * chat, a running / awaiting lane is never hidden) plus the newest ones up to
 * `childLimit`; real-lineage children are never trimmed. Returns the group
 * unchanged when nothing is cut.
 */
function trimDisplayChildren<T extends LineageChat & { updatedAt?: string | null }>(
  g: ChatGroup<T>,
  isActive: (chat: T) => boolean,
  childLimit: number,
): ChatGroup<T> {
  const via = g.displayChildIds;
  if (!via || via.size === 0) return g;
  const displayKids = g.children.filter((c) => via.has(c.id));
  if (displayKids.length <= childLimit) return g;
  const stamp = (c: T) => new Date(c.updatedAt || 0).getTime() || 0;
  const keep = new Set(displayKids.filter(isActive).map((c) => c.id));
  for (const c of [...displayKids].sort((a, b) => stamp(b) - stamp(a))) {
    if (keep.size >= childLimit) break;
    keep.add(c.id);
  }
  const hiddenChildCount = displayKids.length - keep.size;
  if (hiddenChildCount === 0) return g;
  return { ...g, children: g.children.filter((c) => !via.has(c.id) || keep.has(c.id)), hiddenChildCount };
}

/**
 * Pick the groups a folder shows before "Show more": active groups (the open
 * chat, a running / awaiting member) pinned first, then by newest activity,
 * `limit` groups total (never fewer than the pinned ones); each group's
 * display-attached children are bounded to `childLimit` (default `limit`) —
 * see trimDisplayChildren. `showAll` returns every group untrimmed, still
 * activity-ordered.
 */
export function previewChatGroups<T extends LineageChat & { updatedAt?: string | null }>(
  groups: Array<ChatGroup<T>>,
  isActive: (chat: T) => boolean,
  limit: number,
  showAll = false,
  childLimit = limit,
): PreviewGroupsResult<T> {
  const count = (gs: Array<ChatGroup<T>>) => gs.reduce((n, g) => n + 1 + g.children.length, 0);
  const total = count(groups);
  const ordered = [...groups].sort((a, b) => groupActivityMs(b) - groupActivityMs(a));
  let sliced = ordered;
  if (ordered.length > limit) {
    const groupActive = (g: ChatGroup<T>) => isActive(g.chat) || g.children.some(isActive);
    const pinned = ordered.filter(groupActive);
    const rest = ordered.filter((g) => !groupActive(g));
    sliced = [...pinned, ...rest].slice(0, Math.max(limit, pinned.length));
  }
  const visible = sliced.map((g) => trimDisplayChildren(g, isActive, childLimit));
  const overflow = ordered.length > limit || visible.some((g) => (g.hiddenChildCount ?? 0) > 0);
  if (showAll) return { visible: ordered, hiddenCount: 0, overflow };
  return { visible, hiddenCount: total - count(visible), overflow };
}
