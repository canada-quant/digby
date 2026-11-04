/**
 * Cross-tab FOLDER rename/archive/delete reconciliation pins — owner report
 * 2026-10-27 ("fix more ui flow issues like this"), review round 2 defect 2:
 * a folder renamed/archived/deleted in one tab kept its old name/count in
 * every OTHER open sidebar — the chat-row delta feed (GET /chats/changes) is
 * chat-scoped and can never see folder rows, and no project-level push
 * existed. The fix adds project.* notice kinds end to end:
 *
 *  backend  chat-events.ts: kind union + validation (projectId on
 *          project.* kinds), platform.service.ts: publishProjectNotice
 *          (owner + every ProjectMember) on rename/archive/restore/delete.
 *  frontend lib/chat-events.ts: ChatListNotice union + the parser gate
 *          (the old chatId-only gate silently DROPPED project notices);
 *          page.tsx: project.* notices route to refreshFolderLists (ONE
 *          debounced projectsApi.list() pull).
 *
 * Same source-level idiom as deleted-chat-stale-view.test.tsx (no jsdom).
 * VERIFICATION-ONLY: a failing row is a BLOCKED finding, not a test to weaken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CHAT_EVENTS_FE = readSrc('../../lib/chat-events.ts');
const PAGE = readSrc('./page.tsx');
const CHAT_EVENTS_BE = readSrc('../../../backend/src/modules/crossmodel/platform/chat-events.ts');
const PLATFORM_SERVICE = readSrc('../../../backend/src/modules/crossmodel/platform/platform.service.ts');

describe('Cross-tab folder rename/archive/delete (review round 2, defect 2)', () => {
  it('backend: the notice kind union carries the project.* kinds, with projectId', () => {
    expect(CHAT_EVENTS_BE).toContain("'project.renamed' | 'project.archived' | 'project.restored' | 'project.deleted'");
    expect(CHAT_EVENTS_BE).toContain('projectId?: string;');
  });

  it('backend: publishChatListEvent validates the projectId shape on project.* kinds (never rides a malformed id)', () => {
    const i = CHAT_EVENTS_BE.indexOf('const isProjectKind =');
    expect(i).toBeGreaterThanOrEqual(0);
    // Slice past the notice construction — the projectId/chatId spread lives
    // INSIDE the object literal, after the `const notice` line.
    const end = CHAT_EVENTS_BE.indexOf('deliverLocal(userId, notice);', i);
    const body = CHAT_EVENTS_BE.slice(i, end);
    expect(body).toContain("event.kind.startsWith('project.')");
    expect(body).toContain("!/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) return");
    expect(body).toContain('...(isProjectKind ? { projectId } : { chatId })');
  });

  it('backend: updateProject publishes project.renamed ONLY when the name actually changed', () => {
    expect(PLATFORM_SERVICE).toContain("kind: 'project.renamed', projectId");
    const i = PLATFORM_SERVICE.indexOf("kind: 'project.renamed', projectId");
    const guard = PLATFORM_SERVICE.slice(Math.max(0, PLATFORM_SERVICE.lastIndexOf('if (', i)), i + 80);
    expect(guard).toContain('name !== undefined && name.trim() !== access.project.name');
  });

  it('backend: archive/restore and delete publish their kinds; the fan-out covers owner + every ProjectMember', () => {
    expect(PLATFORM_SERVICE).toContain("archived ? 'project.archived' : 'project.restored'");
    expect(PLATFORM_SERVICE).toContain("kind: 'project.deleted', projectId");
    expect(PLATFORM_SERVICE).toContain('async function publishProjectNotice(');
    const fn = PLATFORM_SERVICE.slice(
      PLATFORM_SERVICE.indexOf('async function publishProjectNotice('),
      PLATFORM_SERVICE.indexOf('}\n', PLATFORM_SERVICE.indexOf('async function publishProjectNotice(')),
    );
    expect(fn).toContain('prisma.projectMember.findMany');
    expect(fn).toContain('publishChatListEvent(target, event)');
  });

  it('frontend: the notice union matches and the parser gate accepts projectId (the old gate dropped project notices)', () => {
    expect(CHAT_EVENTS_FE).toContain("'project.renamed' | 'project.archived' | 'project.restored' | 'project.deleted'");
    expect(CHAT_EVENTS_FE).toContain('projectId?: string;');
    expect(CHAT_EVENTS_FE).toContain("typeof parsed.data.chatId === 'string' || typeof parsed.data.projectId === 'string'");
  });

  it('page.tsx: project.* notices route to ONE debounced folder-list pull, without a chat-row delta fetch', () => {
    const i = PAGE.indexOf("notice.kind === 'project.renamed'");
    expect(i).toBeGreaterThanOrEqual(0);
    const body = PAGE.slice(Math.max(0, PAGE.lastIndexOf('// Owner 2026-10-27 (stale-rename sweep', i)), PAGE.indexOf('if (!chatsSinceRef.current) {', i));
    expect(body).toContain('refreshFolderLists();');
    expect(body).toContain('return;');
    // No refreshChatChanges() inside the project.* branch (no chat row changed).
    expect(body.indexOf('refreshChatChanges')).toBe(-1);
  });
});
