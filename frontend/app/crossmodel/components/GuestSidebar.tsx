'use client';

/**
 * GuestSidebar (feedback ticket 63bb607f) — the anonymous-user rail. The
 * SHELL is the shared AppRail primitive (UI overhaul Phase 1 — it used to be
 * a self-documented copy of the authed aside's classes): mobile drawer with
 * real dialog semantics + backdrop, md+ 264px column (Digby Frontier), no
 * resize handle for guests.
 *
 * Contents mirror the signed-in rail's skeleton (shared rail-parts): brand
 * row with the collapse button, a "New chat" row, the scrollable conversation list
 * (browser-local guest sessions — title + relative time + per-row delete),
 * an empty state, and a pinned footer CTA pushing /login (the owner's
 * limited-guest directive: "push cta to sign up for that access").
 */

import Link from 'next/link';
import { X, SquarePen, LogIn, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import AppRail from '@/components/ui/custom/app-rail';
import { relativeTime } from '@/lib/relative-time';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { RailBrandRow, RailActionRow, RailSectionLabel, railRowClass } from './rail-parts';
import type { GuestSessionRecord } from '../guest-sessions';
import { trackVisitEvent } from '@/lib/visitor-analytics';

export interface GuestSidebarProps {
  open: boolean;
  onClose: () => void;
  sessions: GuestSessionRecord[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}

export default function GuestSidebar({ open, onClose, sessions, activeId, onSelect, onDelete, onNewChat }: GuestSidebarProps) {
  return (
    // The shared rail shell: backdrop + drawer + dialog semantics all live in
    // AppRail; guests get the fixed 264px default (no resize controller).
    <AppRail open={open} onClose={onClose} label="Guest chat sidebar">
        {/* Brand row — identical to the signed-in rail's (Digby Frontier):
            hat · "Digby" · collapse (aria-label "Close sidebar"; the button
            carries the coarse-pointer 44px floor:
            [@media(pointer:coarse)]:min-h-11). */}
        <RailBrandRow onCollapse={onClose} />

        {/* New chat — same row language as the signed-in rail's. */}
        <div className="flex flex-shrink-0 flex-col gap-px px-2 pt-1 pb-2">
          <RailActionRow
            primary
            icon={<SquarePen className="size-[17px]" strokeWidth={1.75} />}
            label="New chat"
            hint={<span className="hidden md:inline">⌘⇧O</span>}
            onClick={onNewChat}
          />
        </div>

        {/* Conversation list — browser-local guest sessions, newest first. */}
        <div className="flex-1 overflow-y-auto px-2 pb-3 min-h-0">
          <RailSectionLabel first>Recent</RailSectionLabel>
          {sessions.length === 0 ? (
            <Empty className="py-4 px-3 gap-2 border-none">
              <EmptyHeader>
                <EmptyDescription className="text-[12.5px] text-ink-3">No conversations yet</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-px">
            {sessions.map(s => (
              <div
                key={s.id}
                className={cn('group cursor-pointer gap-1.5', railRowClass(s.id === activeId))}
                onClick={() => onSelect(s.id)}
              >
                <span className="flex-1 min-w-0 truncate">{s.title}</span>
                <span className="text-[11.5px] text-ink-3 flex-shrink-0 tabular-nums">{relativeTime(s.updatedAt)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                  className="p-1 rounded-md hover:bg-active text-ink-3 hover:text-ink opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity flex-shrink-0"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            </div>
          )}
        </div>

        {/* Footer CTA — guest chats are browser-local; the account is what
            makes history durable. /login is the app's only auth route. */}
        <div className="flex-shrink-0 border-t border-line p-2">
          <div className="rounded-xl p-3">
            <p className="text-[13.5px] font-medium text-ink mb-1">Sign up to save your history</p>
            <p className="text-[12px] leading-snug text-ink-3 mb-3">
              Guest chats are saved only in this browser — create a free account to keep them across devices.
            </p>
            <div className="flex gap-2">
              <Link
                href="/login"
                className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-line bg-raised hover:bg-hover hover:border-line-2 text-ink text-[13px] font-medium px-3 transition-colors"
              >
                <LogIn className="size-3.5" />
                Log in
              </Link>
              <Link
                href="/login?signup=true"
                onClick={() => trackVisitEvent('signup_cta', { where: 'guest_sidebar' }, { flush: true })}
                className="flex-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-send text-send-ink hover:opacity-90 text-[13px] font-medium px-3 transition"
              >
                <UserPlus className="size-3.5" />
                Sign up
              </Link>
            </div>
          </div>
        </div>
    </AppRail>
  );
}
