/**
 * Ghost composer toggle (2026-10-22) — the SIGNED-IN ghost control beside the
 * composer (owner, raised twice: "the missing model icon for ghost testing").
 *
 * Ghost mode (#1888, lib/ghost-mode.ts) shipped a guest composer toggle and a
 * signed-in switch in the side panel's Settings tab only — which needs an
 * EXISTING chat, so a signed-in user's first message always ran on the normal
 * lineup and there was no way to START a private chat. This module is the pure
 * seam the page and CodeSessionView render from:
 *
 *  - on HOME (no chat row yet) the toggle ARMS ghost for the chat the next send
 *    creates — createChatWithGhost threads ghostMode:true into POST /chats, so
 *    the FIRST message already runs private;
 *  - on an OPEN chat it flips chat.ghostMode with updateChat, exactly like the
 *    side panel's GhostModeRow (same eligibility: the owner's own PLAIN chats —
 *    never coding sessions, supervisor chats / lanes, kids accounts, or chats
 *    shared from other people).
 *
 * Ghost mode is not admin-only (docs/GHOST_MODE.md "Who can use it": every
 * signed-in user on their own plain chats, and guests) — so the toggle renders
 * in the minimal view too.
 *
 * PR #1897 (on main first) shipped the open-chat half without a switch; the
 * re-integration (integ/ghost-composer) folded it into this seam, so ONE
 * switch governs the whole signed-in composer toggle:
 * NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1 (build-time) hides it on home
 * AND on open chats — the signed-in control is the side panel's Settings
 * switch alone (self-loading, no hint), and nothing new rides POST /chats.
 * The guest toggle is unaffected.
 *
 * Pure (no React, no API import) so it unit-tests like ghost-mode.ts.
 */

/** Kill switch — read at call time (vitest flips process.env per test). */
export function ghostComposerToggleDisabled(): boolean {
  return process.env.NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED === '1';
}

/** The sidebar-row facts the toggle reads (a CrossModelChat subset). */
export interface GhostRowFacts {
  userId?: string | null;
  isSupervisor?: boolean;
  isProjectSupervisor?: boolean;
  ghostMode?: boolean;
}

export interface GhostToggleInput {
  /** The signed-in viewer's id; null/undefined = a guest (guests keep their own toggle). */
  viewerId: string | null | undefined;
  isKid: boolean;
  /** The open chat (null on home and on a chatId-less mount). */
  chatId: string | null;
  /** A chatId-less view is mounted (guest session, or the signed-in createChat-failure fallback). */
  chatless: boolean;
  /** The open chat runs as a PLAIN chat (false = a coding session / workspace-attached chat). */
  plain: boolean;
  /** The open chat's sidebar row (undefined when the page holds none). */
  row?: GhostRowFacts | null;
}

/** Where the signed-in toggle acts: arm the next new chat, or flip an open chat. */
export type GhostToggleTarget =
  | { kind: 'new' }
  | { kind: 'chat'; chatId: string; on: boolean }
  | null;

/**
 * THE signed-in ghost eligibility rule (integ/ghost-composer, 2026-10-22 —
 * PR #1897's `signedInGhostChatId`, moved here so the composer toggle and the
 * side panel's Settings switch read ONE rule): the open chat's id when it is
 * the viewer's own PLAIN chat, else null. Never kids, coding sessions
 * (`plain` false), supervisor chats / lanes, or another person's chat in a
 * shared folder. A row that does not say (a minimal open-by-id / search row,
 * or no row) is NOT refused here — the side-panel switch self-loads and hides
 * itself on a supervisor read; the composer toggle additionally needs a KNOWN
 * posture (ghostToggleTarget). Not kill-switched: the side-panel switch
 * predates the composer toggle.
 */
export function ghostEligibleChatId(i: GhostToggleInput): string | null {
  if (!i.viewerId || i.isKid || !i.chatId || !i.plain) return null; // coding sessions: their agent is the satellite's model
  const row = i.row;
  if (row?.isSupervisor || row?.isProjectSupervisor) return null; // platform seats + fleet audit memory
  if (row?.userId && row.userId !== i.viewerId) return null; // someone else's chat in a shared folder
  return i.chatId;
}

/**
 * Which ghost control (if any) the signed-in composer shows. null = no toggle.
 *
 * An open chat must pass ghostEligibleChatId AND carry a row whose ghostMode
 * is KNOWN (a boolean): minimal rows built by the open-by-id / search paths
 * carry neither the posture nor the owner facts, and a toggle that guessed
 * "off" could not tell a ghost chat from a normal one — the page reads those
 * facts once (ghostFactsFromChat) and the toggle appears when they land.
 */
export function ghostToggleTarget(i: GhostToggleInput): GhostToggleTarget {
  if (ghostComposerToggleDisabled()) return null;
  if (!i.viewerId || i.isKid) return null;
  if (!i.chatId) {
    // Home: arm the chat the next send creates. A chatless mount (the
    // createChat-failure fallback) already carries its posture — no toggle.
    return i.chatless ? null : { kind: 'new' };
  }
  const chatId = ghostEligibleChatId(i);
  if (!chatId) return null;
  const row = i.row;
  if (!row || typeof row.ghostMode !== 'boolean') return null; // posture unknown — never guess
  return { kind: 'chat', chatId, on: row.ghostMode };
}

/** The POST /chats body the home composer sends. */
export interface NewChatBody {
  title: string;
  projectId?: string;
  ghostMode?: boolean;
}

/**
 * The home composer's create call with the ARMED ghost posture. Unarmed, the
 * body is byte-identical to before (no ghostMode key — the server default
 * false); armed, ghostMode:true rides POST /chats so the created row — and
 * therefore the FIRST send's run — is already private.
 */
export function createChatWithGhost<T>(
  createChat: (data: NewChatBody) => Promise<T>,
  body: { title: string; projectId?: string },
  ghostArmed: boolean,
): Promise<T> {
  return createChat(ghostArmed ? { ...body, ghostMode: true } : body);
}

/**
 * Flip an OPEN chat's ghost posture — the GhostModeRow save (PUT /chats/:id
 * { ghostMode }). Resolves to the new value; a refusal (supervisor / coding
 * row, 403) rejects with the server's error for the caller's toast.
 * `onSaved` (review fix) gets the PUT's answer — the saved chat row, whose
 * updatedAt orders the pending-flip hold (holdPendingGhostFlips).
 */
export async function flipChatGhost(
  updateChat: (id: string, data: { ghostMode: boolean }) => Promise<unknown>,
  chatId: string,
  current: boolean,
  onSaved?: (saved: unknown) => void,
): Promise<boolean> {
  const next = !current;
  const saved = await updateChat(chatId, { ghostMode: next });
  onSaved?.(saved);
  return next;
}

/**
 * The row patch from a getChat read for a MINIMAL row (open-by-id / search /
 * URL paths): the posture always (an older backend's absent field reads off),
 * and the owner / supervisor facts only where the row lacks them — never
 * overwriting what the list already said.
 */
export interface GhostRowPatch {
  ghostMode: boolean;
  userId?: string;
  isSupervisor?: boolean;
  isProjectSupervisor?: boolean;
}

export function ghostFactsFromChat(row: GhostRowFacts, full: unknown): GhostRowPatch {
  const f = (full && typeof full === 'object' ? full : {}) as Record<string, unknown>;
  return {
    ghostMode: f.ghostMode === true,
    ...(row.userId == null && typeof f.userId === 'string' ? { userId: f.userId } : {}),
    ...(row.isSupervisor === undefined && typeof f.isSupervisor === 'boolean' ? { isSupervisor: f.isSupervisor } : {}),
    ...(row.isProjectSupervisor === undefined && typeof f.isProjectSupervisor === 'boolean'
      ? { isProjectSupervisor: f.isProjectSupervisor }
      : {}),
  };
}

/**
 * A MINIMAL sidebar row built from a getChat body (integ/ghost-composer review
 * fix, 2026-10-22) — the same shape the open-by-id / search paths build, plus
 * the ghost facts and the archive stamp (an archived chat opened by id stays
 * out of the visible list). null when the body is not a chat.
 */
export interface GhostMinimalRow extends GhostRowPatch {
  id: string;
  title?: string;
  projectId?: string | null;
  mode?: string;
  codeCapable?: boolean;
  hasWorkspaceState?: boolean;
  updatedAt?: string;
  createdAt: string;
  archivedAt?: string | null;
  messages: unknown[];
}

export function ghostRowFromChat(full: unknown, nowIso: string = new Date().toISOString()): GhostMinimalRow | null {
  if (!full || typeof full !== 'object') return null;
  const f = full as Record<string, unknown>;
  if (typeof f.id !== 'string' || !f.id) return null;
  return {
    id: f.id,
    ...(typeof f.title === 'string' ? { title: f.title } : {}),
    ...(f.projectId === null || typeof f.projectId === 'string' ? { projectId: f.projectId as string | null } : {}),
    ...(typeof f.mode === 'string' ? { mode: f.mode } : {}),
    ...(typeof f.codeCapable === 'boolean' ? { codeCapable: f.codeCapable } : {}),
    ...(typeof f.hasWorkspaceState === 'boolean' ? { hasWorkspaceState: f.hasWorkspaceState } : {}),
    ...(typeof f.updatedAt === 'string' ? { updatedAt: f.updatedAt } : {}),
    createdAt: typeof f.createdAt === 'string' ? f.createdAt : nowIso,
    ...(typeof f.archivedAt === 'string' ? { archivedAt: f.archivedAt } : {}),
    messages: [],
    ...ghostFactsFromChat({}, full),
  };
}

/**
 * Apply a ghost-facts read to the sidebar list (integ/ghost-composer review
 * fix, 2026-10-22). The OPEN chat's row is patched (ghostFactsFromChat); when
 * the list holds NO row for it — an older chat opened by search / URL whose
 * minimal row a full list refresh (sidebar Retry, archive-restore) dropped —
 * the row is put back from the read, but only while that chat is still open
 * (`open`), so a late answer never plants an unrelated row. Without it the
 * composer toggle vanished for good: no row ⇒ posture unknown ⇒ no toggle,
 * and nothing ever read the facts again. Returns `prev` when nothing changes.
 */
export function withGhostFacts<T extends { id: string }>(prev: T[], chatId: string, full: unknown, open: boolean): T[] {
  if (prev.some((c) => c.id === chatId)) {
    return prev.map((c) => (c.id === chatId ? { ...c, ...ghostFactsFromChat(c as GhostRowFacts, full) } : c));
  }
  if (!open) return prev;
  const row = ghostRowFromChat(full);
  if (!row || row.id !== chatId) return prev;
  return [row as unknown as T, ...prev];
}

/**
 * A just-SAVED ghost flip, held against a STALE sidebar row (integ/ghost-composer
 * review fix, 2026-10-22). The sidebar row is the ONE record of a chat's ghost
 * posture (the composer toggle, the header badge and — through the hint — the
 * side-panel switch all read it), and the live refresh overwrites rows with no
 * ordering check: a GET /chats/changes (or a full list) the server built BEFORE
 * the PUT, landing after it, put the OLD posture back on screen until the next
 * delta. While a flip is pending, an incoming row is:
 *
 *  - CONFIRMING (same value) → accepted, the hold ends;
 *  - NEWER than the PUT's own updatedAt (the chat changed again after it — a
 *    flip from another tab) → accepted as the truth, the hold ends;
 *  - otherwise STALE → its ghostMode is replaced by the saved value.
 *
 * A hold also ends after GHOST_PENDING_FLIP_TTL_MS (the server row is then the
 * truth whatever it says). Display-only: the server was always right; this only
 * keeps the screen from showing an older copy of it. Pure.
 */
export interface PendingGhostFlip {
  /** The saved posture. */
  value: boolean;
  /** The chat's updatedAt the PUT answered with (ISO); null when the saver had none. */
  updatedAt: string | null;
  /** Client clock (ms) when the save landed — for the TTL only. */
  at: number;
}

export const GHOST_PENDING_FLIP_TTL_MS = 120_000;

export function holdPendingGhostFlips<T extends { id: string; ghostMode?: boolean; updatedAt?: unknown }>(
  rows: ReadonlyArray<T>,
  pending: ReadonlyMap<string, PendingGhostFlip>,
  now: number,
): { rows: T[]; settled: string[] } {
  if (pending.size === 0) return { rows: rows as T[], settled: [] };
  const settled: string[] = [];
  let out: T[] | null = null;
  rows.forEach((row, i) => {
    const p = row && typeof row.id === 'string' ? pending.get(row.id) : undefined;
    if (!p) return;
    if (now - p.at > GHOST_PENDING_FLIP_TTL_MS) { settled.push(row.id); return; }
    if (typeof row.ghostMode !== 'boolean') return; // the row does not say — nothing to hold against
    if (row.ghostMode === p.value) { settled.push(row.id); return; }
    const at = typeof row.updatedAt === 'string' ? row.updatedAt : null;
    if (p.updatedAt && at && at > p.updatedAt) { settled.push(row.id); return; } // ISO strings compare lexically
    if (!out) out = rows.slice();
    out[i] = { ...row, ghostMode: p.value };
  });
  return { rows: out ?? (rows as T[]), settled };
}

/**
 * The side panel's GhostModeRow state (review fix, 2026-10-22). The row
 * self-loads chat.ghostMode with getChat on mount, and since the composer
 * toggle it also follows the host's row posture (`hint`) so the two controls
 * never disagree. Two rules keep that honest:
 *
 *  - once a hint or the row's OWN save has set the value, the mount-time read
 *    is STALE — its answer is dropped (a flip whose PUT lands before that GET
 *    used to be reset by it, and nothing re-synced the controls until a
 *    remount);
 *  - no hint (the page passes none under
 *    NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1) is the pre-toggle row
 *    byte-for-byte: 'Loading…' and a disabled switch until the read answers.
 *
 * The read also carries the supervisor facts a minimal sidebar row may lack —
 * a supervisor chat cannot run in ghost mode (the save 400s), so the row
 * hides. That fact is immutable, so it applies even to a dropped read.
 */
export interface GhostRowState {
  /** null = loading (the switch shows 'Loading…' and starts disabled). */
  value: boolean | null;
  /** A hint or a local save set `value` — a later self-load answer is dropped. */
  settled: boolean;
  /** The row's own read says this is a supervisor chat — the row hides. */
  supervisor: boolean;
}

export type GhostRowEvent =
  /** Mount / a new chatId: start loading. */
  | { type: 'open' }
  /** The host's view of the posture (undefined = unknown — no-op). */
  | { type: 'hint'; hint: boolean | undefined }
  /** The mount-time getChat answered. */
  | { type: 'loaded'; ghostMode: boolean; supervisor: boolean }
  /** The read failed (an older backend has no field) — off. */
  | { type: 'load_failed' }
  /** This row's own updateChat landed. */
  | { type: 'saved'; ghostMode: boolean };

export const GHOST_ROW_INITIAL: GhostRowState = { value: null, settled: false, supervisor: false };

export function ghostRowReducer(s: GhostRowState, e: GhostRowEvent): GhostRowState {
  switch (e.type) {
    case 'open':
      return GHOST_ROW_INITIAL;
    case 'hint':
      return typeof e.hint === 'boolean' ? { ...s, value: e.hint, settled: true } : s;
    case 'loaded':
      return { ...s, value: s.settled ? s.value : e.ghostMode, supervisor: e.supervisor };
    case 'load_failed':
      return s.settled ? s : { ...s, value: false };
    case 'saved':
      return { ...s, value: e.ghostMode, settled: true };
    default:
      return s;
  }
}
