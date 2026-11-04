/**
 * Agent-message notification (ticket a4370dd1) — the sidebar's toast when an
 * agent-to-agent message lands in one of the user's chats.
 *
 * Source-level pins (the C3 retirement-pin idiom — stable identifiers, never
 * line numbers) over the page's onNotice gate plus the notice's wire shape:
 * the chat.message toast is RETIRED (9d07fd1f quiet front end), the delta
 * refresh still runs, the unread dot's machine-origin suppression is
 * untouched, and every other kind keeps today's reconcile/drop behavior.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const HOOK = readSrc('./chat-events.ts');
const PAGE = readSrc('../app/crossmodel/page.tsx');
const ATTENTION = readSrc('./chat-attention.ts');

const onNoticeRegion = (): string => {
  // Slice from the useChatListEvents call to the next sibling hook — a REAL
  // marker that exists in page.tsx (the running-sessions poll comment below
  // the hook's closing), so the region is the handler, not the whole file
  // (review a4370dd1-5: the previous end marker was absent and the region
  // silently spanned ~189K chars).
  const start = PAGE.indexOf('useChatListEvents({');
  const end = PAGE.indexOf('const codingPollFailures', start);
  return PAGE.slice(start, end > start ? end : undefined);
};

describe('a4370dd1 — machine notification for agent-to-agent messages', () => {
  it('the notice wire carries the sender (id + title), never the content', () => {
    expect(HOOK).toContain("'chat.message'");
    expect(HOOK).toContain('sourceChatId?: string;');
    expect(HOOK).toContain('sourceTitle?: string;');
    // The hook forwards whatever kind arrives (no allowlist rewrite): the
    // passthrough contract — the server decides kinds, the client renders.
    expect(HOOK).not.toContain("kind === 'chat-list-changed'");
  });

  it('a chat.message notice no longer toasts — quiet front end (9d07fd1f), the row reconciles instead', () => {
    const region = onNoticeRegion();
    expect(region).toContain("notice.kind === 'chat.message'");
    // 9d07fd1f (owner 2026-10-19 "minimalistic quiet front end"): the toast is
    // RETIRED — the chat row itself is the quiet surface (delta refresh below).
    expect(region).not.toContain('toast(');
    // The wire still names the sender for anyone re-adding a surface (server shape unchanged).
    expect(HOOK).toContain('sourceChatId?: string;');
    expect(HOOK).toContain('sourceTitle?: string;');
  });

  it('a chat.message notice also kicks the delta refresh (the row still reconciles through the poll)', () => {
    const region = onNoticeRegion();
    expect(region).toMatch(/chat\.message[\s\S]*refreshChatChanges\(\)/);
  });

  it('the unread dot still ignores machine origins (owner 2026-09-16 — the toast replaces, not re-lights, the dot)', () => {
    // isMessageForUser: only absent/''/'user' origins light the dot — the
    // 'agent' origin arrives in MACHINE_ORIGINS, keeping the dot OFF.
    expect(ATTENTION).toContain('isMessageForUser(chat.lastMessageOrigin)');
    expect(ATTENTION).toMatch(/MACHINE_ORIGINS|machine/i);
  });

  it('every other notice kind keeps today\u2019s behavior (delete drops locally; the rest reconcile)', () => {
    const region = onNoticeRegion();
    expect(region).toContain("notice.kind === 'chat.deleted'");
  });

  it('toast idiom: sonner is still imported by the page (other user-action toasts remain)', () => {
    expect(PAGE).toContain("import { toast } from 'sonner'");
  });

  it('burst-safe toast id RETIRED with the toast itself (9d07fd1f quiet front end)', () => {
    const region = onNoticeRegion();
    expect(region).not.toContain('id: `agent-message:${notice.chatId}`');
  });
});
