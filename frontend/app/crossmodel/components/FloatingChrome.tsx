'use client';

/**
 * FloatingChrome — the chat column's in-flow 56px HEADER (Digby Frontier
 * redesign, 2026-10-06). ONE quiet row, no menus (owner, same day: "why is
 * there so many menus … three dots … more options when you click the title …
 * all that should be in the sidebar or settings"):
 *
 *   LEFT   — while the sidebar is closed: PanelLeft (open sidebar) + SquarePen
 *            (new chat); in a chat, the chat TITLE as plain text.
 *   RIGHT  — in a chat the owner can share: the Share pill; the side-panel
 *            toggle (PanelRight, aria-pressed) whenever a panel-capable session
 *            is mounted; guests with the rail closed: Log in / Sign up.
 *
 * Every per-chat action has exactly ONE home elsewhere: Rename / Share / Move
 * to folder / Archive / Delete on the sidebar row's menu; New chat, Attach a
 * workspace, Autonomy…, instructions and the workspace block (branch · Push ·
 * Open PR · Agent mode) in the side panel's Settings tab
 * (SessionSettingsSection). Nothing here duplicates them.
 *
 * The host renders it at the top of the CHAT column — CodeSessionView mounts
 * it above its transcript and the home screen above the hero.
 *
 * Safe areas: the header pads env(safe-area-inset-top) (installed PWA /
 * notch) and the landscape left/right insets (ticket c0e58120 — the Dynamic
 * Island eats ~59px of a side edge); env() is 0 everywhere else.
 */

import { SquarePen, PanelRight, PanelLeft, Share, Ghost } from 'lucide-react';
import type { PermissionMode } from '@/lib/api/coding';
import { cn } from '@/lib/utils';
import { GHOST_MODE_TOOLTIP } from '@/lib/ghost-mode';

/** Chrome state a workspace-backed session pushes up to the host page (see
 *  CodeSessionView); rendered by the side panel's Settings tab. */
export interface CodingChrome {
  branch: string;
  model: string;
  status: string;
  errorMessage?: string | null;
  permissionMode: PermissionMode;
  publishing: 'push' | 'pr' | null;
  projectId: string | null;
  actions: {
    push: () => void;
    openPr: () => void;
    setPermissionMode: (m: PermissionMode) => void;
  };
}

/** 34×34 radius-9 ghost icon button (ink-3 → ink on hover). Coarse pointers
 *  get the 44px floor. */
export const HEADER_ICON_BTN =
  'flex size-[34px] [@media(pointer:coarse)]:size-11 flex-shrink-0 items-center justify-center rounded-[9px] ' +
  'text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink select-none touch-manipulation ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-2';

/** The header's safe-area geometry (ticket c0e58120 + the PWA status bar):
 *  56px of content below env(safe-area-inset-top), 12px side padding plus the
 *  landscape side insets. Exported for the pin test. */
export const HEADER_STYLE = {
  height: 'calc(56px + env(safe-area-inset-top, 0px))',
  paddingTop: 'env(safe-area-inset-top, 0px)',
  paddingLeft: 'calc(env(safe-area-inset-left, 0px) + 12px)',
  paddingRight: 'calc(env(safe-area-inset-right, 0px) + 12px)',
} as const;

export default function FloatingChrome(props: {
  isLoggedIn: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  /** Show the side-panel toggle whenever a panel-capable session view is
   *  mounted (page-owned panel state). */
  showWorkspaceToggle?: boolean;
  workspaceOpen?: boolean;
  onToggleWorkspace?: () => void;
  onLogin?: () => void;
  onSignup?: () => void;
  /** The open conversation's title (a chat / session is mounted). Absent on
   *  the home screen — no title, no Share pill. */
  chatTitle?: string | null;
  /** Ghost mode (2026-10-22): the OPEN conversation runs in ghost mode —
   *  shows the quiet Ghost badge beside the title. Guests pass their
   *  browser-local per-session flag; signed-in chats the chat row's
   *  ghostMode. */
  ghostActive?: boolean;
  /** Share the open chat (the host's share dialog) — renders the Share pill. */
  onShare?: () => void;
}) {
  const {
    isLoggedIn, sidebarOpen, onToggleSidebar, onNewChat,
    showWorkspaceToggle, workspaceOpen, onToggleWorkspace,
    onLogin, onSignup, chatTitle, ghostActive, onShare,
  } = props;
  const inChat = chatTitle != null;

  return (
    <header
      data-chat-header
      className="relative z-(--z-raised) flex flex-shrink-0 items-center gap-1.5 bg-background"
      style={HEADER_STYLE}
    >
      {/* LEFT — sidebar closed: open-sidebar + new-chat (fade in). Guests get
          their own guest rail, so this is not gated on isLoggedIn. On phones
          the rail is a drawer, so these show whenever it is closed. */}
      {!sidebarOpen && (
        <div className="dg-fade flex items-center gap-0.5">
          <button
            type="button"
            onClick={onToggleSidebar}
            title="Open sidebar"
            aria-label="Open sidebar"
            className={HEADER_ICON_BTN}
          >
            <PanelLeft className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onNewChat}
            title="New chat"
            aria-label="New chat"
            className={HEADER_ICON_BTN}
          >
            <SquarePen className="size-[17px]" strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      )}

      {/* The chat title — plain text, no menu (rename / share / move / archive
          live on the sidebar row; per-chat settings in the side panel). */}
      {inChat && (
        <h1 className="min-w-0 max-w-[60%] truncate px-2.5 text-[14px] font-medium text-ink" title={chatTitle || 'New chat'}>
          {chatTitle || 'New chat'}
        </h1>
      )}

      {/* Ghost mode (2026-10-22): a quiet badge beside the title while the
          OPEN conversation runs in ghost mode — guests (browser-local flag)
          and signed-in chats (chat row) both light it. Non-interactive: the
          control itself lives where per-chat controls live (the side panel's
          Settings tab for signed-in chats; the composer toggle for guests). */}
      {inChat && ghostActive && (
        <span
          data-testid="ghost-mode-badge"
          title={GHOST_MODE_TOOLTIP}
          aria-label={GHOST_MODE_TOOLTIP}
          className="flex h-[26px] flex-shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-[11.5px] font-medium text-ink-3"
        >
          <Ghost className="size-3.5" strokeWidth={1.75} aria-hidden />
          Ghost
        </span>
      )}

      <div className="flex-1" />

      {/* Share pill (in a chat the signed-in owner can share). */}
      {inChat && onShare && (
        <button
          type="button"
          onClick={onShare}
          className="flex h-[34px] flex-shrink-0 items-center gap-[7px] rounded-full border border-line bg-raised px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-line-2"
        >
          <Share className="size-3.5" strokeWidth={1.75} aria-hidden />
          <span className="hidden sm:inline">Share</span>
          <span className="sr-only sm:hidden">Share</span>
        </button>
      )}

      {/* Side-panel toggle: the panel's Settings tab holds every per-chat
          control (attach a workspace, autonomy, agent mode, branch, PR). */}
      {isLoggedIn && showWorkspaceToggle && (
        <button
          type="button"
          onClick={() => onToggleWorkspace?.()}
          title={workspaceOpen ? 'Hide side panel' : 'Show side panel'}
          aria-label={workspaceOpen ? 'Hide side panel' : 'Show side panel'}
          aria-pressed={!!workspaceOpen}
          className={cn(HEADER_ICON_BTN, workspaceOpen && 'bg-hover text-ink')}
        >
          <PanelRight className="size-[18px]" strokeWidth={1.75} />
        </button>
      )}

      {/* Guests with the rail closed (always, on phones): Log in / Sign up —
          the open guest rail carries the same two in its footer.
          Mobile (d0777a67): the 56px row also holds two 44px icon buttons
          (coarse-pointer floor) plus the title, so under sm the cluster
          collapses to ONE compact pill (Sign up — the primary CTA); the full
          pair renders ≥sm. Both buttons take the 44px coarse-pointer floor. */}
      {!isLoggedIn && !sidebarOpen && (onLogin || onSignup) && (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {onLogin && (
            <button type="button" onClick={onLogin}
              title="Log in"
              className="hidden sm:flex h-[34px] min-h-[34px] [@media(pointer:coarse)]:min-h-11 items-center rounded-full px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink">
              Log in
            </button>
          )}
          {onSignup && (
            <button type="button" onClick={onSignup}
              className="flex h-[34px] min-h-[34px] [@media(pointer:coarse)]:min-h-11 flex-shrink-0 items-center rounded-full bg-send px-3.5 text-[13px] font-medium text-send-ink transition-opacity hover:opacity-90">
              Sign up
            </button>
          )}
        </div>
      )}
    </header>
  );
}
