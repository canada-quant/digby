/**
 * WorkspacePanel section registry (Session UI Convergence C2, ticket
 * 71b1fec6, design D1): WHICH right-panel sections a conversation mounts is
 * keyed by session capability, not by which surface happens to render the
 * panel. Every WorkspacePanel mount builds its section list through this
 * table, so the two mounts (CodeSessionView's in-flow column for coding
 * sessions; the page-level panel that serves plain chats until C3 retires it
 * with the legacy view) can never drift on which sections exist:
 *
 *   | Section   | Plain session          | Coding session                        |
 *   |-----------|------------------------|---------------------------------------|
 *   | overview  | —                      | ✓ (codingApi-only data — design D2)   |
 *   | artifacts | — (folded into Files — owner 2026-09-23: "shouldn't this be consolidated?") | — (folded into Files — D1) |
 *   | files     | ✓ (ONE list: uploads + generated files + documents) | ✓          |
 *   | schedules | ✓ (chat-keyed,non-kid) | ✓ (non-kid)                           |
 *
 * Artifacts consolidation (2026-09-23): plain chats used to mount a separate
 * "Artifacts" tab beside "Files" while coding sessions had already folded
 * canvases INTO Files (D1) — the owner saw two tabs for one idea. Files is now
 * the ONE place for a conversation's outputs on every surface: uploads +
 * agent-created documents on top, Artifacts (canvases) below. The 'artifacts'
 * id stays in the union for stored preferences / tests but the registry never
 * emits it. A chatless plain session mounts Files too (documents only — the
 * upload list is chat-keyed and hides itself).
 *
 * ONE list (2026-10-07, owner: "not artifacts it should just all be files"):
 * the separate canvases list under the uploads is gone — documents are rows in
 * the same newest-first files list (ChatFilesSection `docs`, FilesPane). The
 * word "Artifacts" appears nowhere a user can read it; the legacy id's label
 * reads "Files".
 *
 * Fleet REMOVED from the panel entirely (owner scoping principle 2026-09-07:
 * "the sidepanel should only pertain to that chat or project or session — not
 * everything"). Global fleet surfaces live ONLY on the Management page; the
 * Project Pulse block the Fleet tab carried moved into the coding Overview
 * section, scoped to the session's own project.
 *
 * Schedules (rm9, owner directive 2026-09-02): EVERY chat can carry schedule
 * rows — plain chats fire detached chat-agent turns, not just coding sessions —
 * so the tab mounts for both kinds. It is chat-keyed like Files (no chatless
 * mount) and an OWNER surface (kid accounts never see it; a kid's PARENT
 * manages the kid chat's schedules from their own account).
 *
 * Pure module: the section NODES stay with the mounts (they close over
 * surface state); the registry decides ids, order, and labels. C3 (ticket
 * 71b1fec6) retired the page-level panel mount with the legacy view — the ONE
 * surviving mount is CodeSessionView's in-flow column, fed page-built plain
 * sections via plain.panelSections.
 */

export type WorkspaceSectionId = 'overview' | 'artifacts' | 'browser' | 'files' | 'schedules' | 'settings';

export interface WorkspaceSectionCaps {
  /** 'plain' = non-coding chat (no ChatCodingState satellite); 'coding' = coding session. */
  kind: 'plain' | 'coding';
  /** Kid accounts never get the Schedules section — it is an owner surface
      (same isKid gate as the rest of the fleet chrome). */
  isKid?: boolean;
  /** C3 (ticket 71b1fec6): anonymous GUEST sessions mount NO workspace panel
      at all — the owner's limited-guest-mode directive ("very limited features
      and push cta to sign up for that access"). */
  guest?: boolean;
  /** C3: chatId-less sessions (the signed-in createChat-failure fallback) have
      no per-chat Files section — uploads/generated docs are chat-keyed. */
  chatless?: boolean;
  /** Browser program (UI Phase 6a): the agent-browser section used to mount
      ONLY once the conversation had browser activity. Since 2026-09-23 (owner:
      "I don't see where the browser tab is") it is ALWAYS present for every
      non-guest mount — an empty state explains what will appear there, and a
      reload seeds it from persisted screenshots. The cap is accepted for
      caller compatibility but no longer gates anything. */
  hasBrowserActivity?: boolean;
}

export const WORKSPACE_SECTION_LABELS: Record<WorkspaceSectionId, string> = {
  overview: 'Overview',
  artifacts: 'Files', // legacy id — never shown as "Artifacts" (2026-10-07)
  browser: 'Browser',
  files: 'Files',
  schedules: 'Schedules',
  settings: 'Settings',
};

/** The ordered section ids a session with the given capabilities mounts. */
export function workspaceSectionIds(caps: WorkspaceSectionCaps): WorkspaceSectionId[] {
  if (caps.guest) return []; // C3: guests get no panel — limited mode + sign-up CTAs
  const ids: WorkspaceSectionId[] = [];
  if (caps.kind === 'coding') ids.push('overview');
  // Files hosts Artifacts on every surface (2026-09-23 consolidation) — so it
  // mounts for chatless plain sessions as well (canvases are not chat-keyed).
  ids.push('files');
  // Schedules: chat-keyed (like files) AND an owner surface (kid-gated).
  if (!caps.isKid && (caps.kind === 'coding' || !caps.chatless)) ids.push('schedules');
  // Browser (Phase 6a → permanent 2026-09-23): always mounted — with an empty
  // state until the conversation browses or drives the Mac. Before Settings so
  // CodeSessionView's plain-mode append can't diverge from this order.
  ids.push('browser');
  // Settings (owner directive 2026-09-09 — "the settings that show in the
  // other icon should show in a tab within the sidebar"): the floating ⋯ menu's
  // per-session controls (New chat, Patience, Attach a workspace, Autonomy, the
  // workspace block + Agent mode) as the panel's LAST tab, for every non-guest
  // mount — chatless included (none of it is chat-keyed). The node is
  // page-built (it closes over page state) and appended by CodeSessionView
  // like the browser section, in this order.
  ids.push('settings');
  // NO fleet section (owner scoping principle 2026-09-07): the panel pertains
  // to THIS chat/project/session only — global fleet lives on /management.
  return ids;
}
