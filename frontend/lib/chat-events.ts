'use client';

/**
 * Chat-list events (ticket 6201e0ee) — the sidebar's server-push
 * invalidation subscription.
 *
 * WHY: framework lanes (supervisors, ticket dispatchers, spawned children)
 * mutate chat rows server-side — archive, spawn, rename, move — and the
 * sidebar only learned about it on a 15 s / 60 s delta poll (or a manual page
 * refresh for archives, which the delta feed could not see at all). This hook
 * keeps ONE EventSource open to GET /api/crossmodel/chats/events and calls
 * onNotice for every chat-list invalidation the server pushes, so page.tsx
 * can kick the existing delta poll (refreshChatChanges) IMMEDIATELY.
 *
 * The wire is hint-only: a notice is { kind, chatId, at } — no chat data. The
 * delta fetch stays the single source of truth for rows (authorization, row
 * shape, visibility all live in the list path).
 *
 * Reconnect: EventSource's built-in retry (it re-requests after a drop) plus
 * a hard remount when the auth token changes (a 401 closes the stream; the
 * next token re-opens it). 'complete' (the disabled/terminal event) closes
 * and does NOT retry — CHAT_EVENTS_DISABLED=1 on the server means the push
 * half is off and the delta poll alone carries the sidebar.
 *
 * This module lives in lib/ (NOT page.tsx) on purpose: the C3 retirement pin
 * forbids `new EventSource(` inside page.tsx — the page holds no stream
 * machinery; this hook encapsulates it like CodeSessionView does for runs.
 *
 * (build-time; the server side has CHAT_EVENTS_DISABLED=1).
 */

import { useEffect, useRef, useState } from 'react';

/** One server push — a hint to re-run the delta fetch, never data. */
export interface ChatListNotice {
  /** 'chat.message' (ticket a4370dd1) is not a list mutation: an accepted
   *  agent-to-agent message landed in chatId — the sidebar reconciles the
   *  row (the a4370dd1 toast was retired by 9d07fd1f's quiet front end).
   *  project.* kinds (owner 2026-10-27 stale-rename sweep): a FOLDER row
   *  mutated (renamed/archived/restored/deleted) — answered by ONE
   *  projectsApi.list() pull, not the chat-row delta fetch. */
  kind: 'chat.created' | 'chat.archived' | 'chat.restored' | 'chat.renamed' | 'chat.moved' | 'chat.deleted' | 'chat.message'
    | 'project.renamed' | 'project.archived' | 'project.restored' | 'project.deleted';
  /** The chat row that changed (chat.* kinds). */
  chatId?: string;
  /** The project/folder row that changed (project.* kinds). */
  projectId?: string;
  at: string;
  /** 'chat.message' only — the SENDING chat (agent traffic), same-user fleet. */
  sourceChatId?: string;
  /** 'chat.message' only — the sending chat's title at send time. */
  sourceTitle?: string;
}

/** The SSE URL (EventSource can't set headers — the access token rides ?token=,
 *  the same fallback the run-attach stream uses). Exported for tests. */
export function chatEventsUrl(apiBase: string, token: string): string {
  const params = new URLSearchParams(token ? { token } : {});
  return `${apiBase}/crossmodel/chats/events${params.toString() ? `?${params.toString()}` : ''}`;
}

/**
 * Subscribe to the signed-in user's chat-list invalidation stream.
 * `enabled` gates the connection (signed-in, non-kid, not kill-switched);
 * `onNotice` fires for every pushed notice (throttling belongs to the caller
 * — one delta fetch serves a burst).
 */
export function useChatListEvents(opts: {
  enabled: boolean;
  token: string | null;
  onNotice: (notice: ChatListNotice) => void;
}): void {
  const { enabled, token } = opts;
  const onNoticeRef = useRef(opts.onNotice);
  useEffect(() => { onNoticeRef.current = opts.onNotice; });

  // Review N2 (6201e0ee): the access token in localStorage rotates every ~15 m
  // (the api client's refresh loop), but a page-level `token` STATE would only
  // know at mount — the stream would retry a dead token forever. Re-read the
  // live token on window focus and feed THAT to the effect below, so the
  // stream re-opens with a fresh token whenever the user returns to the tab.
  const [liveToken, setLiveToken] = useState(token);
  useEffect(() => { setLiveToken(token); }, [token]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      try { setLiveToken(localStorage.getItem('accessToken')); } catch { /* storage blocked */ }
    };
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, []);

  useEffect(() => {
    if (!enabled || !liveToken) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    let es: EventSource | null = null;
    let closed = false;
    try {
      es = new EventSource(chatEventsUrl(apiBase, liveToken));
    } catch {
      return; // constructor failure — the delta poll remains the backstop
    }
    es.onmessage = (ev: MessageEvent<string>) => {
      let parsed: { type?: string; data?: ChatListNotice } | null = null;
      try { parsed = JSON.parse(ev.data); } catch { return; }
      if (!parsed) return;
      // chat.* kinds carry chatId; project.* kinds (owner 2026-10-27
      // stale-rename sweep) carry projectId — either id shape is a valid
      // notice; the OLD chatId-only gate silently DROPPED project notices.
      if (parsed.type === 'chat-list-changed' && parsed.data
        && (typeof parsed.data.chatId === 'string' || typeof parsed.data.projectId === 'string')) {
        onNoticeRef.current(parsed.data);
        return;
      }
      if (parsed.type === 'complete') {
        // Terminal (server disabled or ending the stream) — close and do NOT
        // let EventSource retry: the push half is off, the delta poll carries it.
        closed = true;
        es?.close();
      }
      // 'ready' / unknown types: nothing to do (forward-compat).
    };
    es.onerror = () => {
      // EventSource retries on its own; nothing to surface (the delta poll
      // backstops any gap). A 401 (expired token) also lands here — the
      // focus-listener above re-reads the token and this effect re-mounts
      // with the fresh one; same-origin prod additionally rides the
      // cm_access cookie (optionalAuthenticate checks it BEFORE ?token=).
    };
    return () => {
      if (!closed) es?.close();
    };
  }, [enabled, liveToken]);
}
