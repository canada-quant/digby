/**
 * Quiet toasts (ticket 9d07fd1f, owner 2026-10-19: "stop showing messages
 * interagent etc in toast and all messages in toast and deploys as well as
 * part of our minimalistic quiet front end view updates").
 *
 * Source-level pins (the C3 retirement-pin idiom — stable identifiers, never
 * line numbers) over the THREE machine-noise toast sites this ticket removed:
 *
 *   1. The inter-agent message toast (ticket a4370dd1) — the sidebar's
 *      useChatListEvents 'chat.message' handler no longer calls toast(); the
 *      chat row still reconciles through the delta refresh and the message
 *      renders in the transcript when the chat is opened.
 *   2. The coding-run pipeline toasts — 'pr_opened' (PR #N opened) and
 *      'branch_pushed' (Pushed <branch>) frames are no-op branches now; the
 *      final answer still names the PR/branch with links.
 *   3. The 'schedule_update' toast (Self-schedule set) — same retirement; the
 *      Schedules section and the answer carry it.
 *
 * What must NOT regress: every OTHER toast in these files (user-action
 * feedback: sent/error/copy/confirm) keeps firing; the stream frames still
 * exist as no-ops (server contract unchanged); the delta refresh still runs
 * for chat.message notices; the unread-dot machine-origin suppression stays.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = readSrc('../app/crossmodel/page.tsx');
const VIEW = readSrc('../app/crossmodel/components/CodeSessionView.tsx');

const onNoticeRegion = (): string => {
  // Same region discipline as a4370dd1: slice from the useChatListEvents call
  // to the next sibling hook, so assertions read the handler, not the file.
  const start = PAGE.indexOf('useChatListEvents({');
  const end = PAGE.indexOf('const codingPollFailures', start);
  return PAGE.slice(start, end > start ? end : undefined);
};

describe('9d07fd1f — quiet front end: no machine-noise toasts', () => {
  it('the inter-agent chat.message notice no longer toasts (a4370dd1 retired)', () => {
    const region = onNoticeRegion();
    expect(region).toContain("notice.kind === 'chat.message'");
    // The toast call, its stable id and the Open action are GONE.
    expect(region).not.toContain('toast(');
    expect(region).not.toContain('id: `agent-message:');
    expect(region).not.toContain('label: \'Open\'');
  });

  it('a chat.message notice still kicks the delta refresh (the row reconciles — the quiet surface)', () => {
    const region = onNoticeRegion();
    expect(region).toMatch(/chat\.message[\s\S]*refreshChatChanges\(\)/);
  });

  it('every other notice kind keeps today\u2019s behavior (delete drops locally; the rest reconcile)', () => {
    const region = onNoticeRegion();
    expect(region).toContain("notice.kind === 'chat.deleted'");
  });

  it('the coding-run pipeline frames no longer toast (pr_opened / branch_pushed / schedule_update)', () => {
    // The frames stay as no-op branches (stream contract unchanged) but their
    // toast calls are gone.
    expect(VIEW).toMatch(/type === 'pr_opened'\)\s*\{\s*\/\* quiet \(9d07fd1f\)/);
    expect(VIEW).toMatch(/type === 'branch_pushed'\)\s*\{\s*\/\* quiet \(9d07fd1f\)/);
    expect(VIEW).toMatch(/type === 'schedule_update'\)\s*\{\s*\/\* quiet \(9d07fd1f\)/);
    expect(VIEW).not.toContain('`PR #${data.number');
    expect(VIEW).not.toContain('`Pushed ${data.branch}`');
    expect(VIEW).not.toContain('Self-schedule set');
  });

  it('user-action toasts in the same files are untouched (the quiet rule is machine-noise only)', () => {
    // Sent/error/copy confirmations still fire — spot-pin two stable ones in
    // each file so a future overzealous "remove all toasts" pass fails here.
    expect(PAGE).toContain("import { toast } from 'sonner'");
    expect(VIEW).toContain("import { toast } from 'sonner'");
    expect(VIEW).toContain("type === 'queued'");
    expect(VIEW).toMatch(/type === 'queued'[\s\S]*?toast\.info\(/);
    expect(PAGE).toMatch(/toast\.success\(/);
    expect(VIEW).toMatch(/toast\.error\(/);
  });
});
