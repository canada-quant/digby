/**
 * Deleted-chat stale-view pins — owner report 2026-10-27 (Fleet Supervisor
 * chat c0e22e36): "when you delete a chat or a session it doesn't go away but
 * still sits in the chat if you have it open - poor ui flow".
 *
 * The bug had three layers, each pinned here:
 *
 *  1. THE OPEN VIEW never unmounted: deleteChat/archiveChat cleared
 *     `currentChatId` but NOT `codeChatId` — the unified view mounts on
 *     `(codeChatId || chatlessActive)`, keyed by chatId, so the deleted chat's
 *     panel kept rendering its stale transcript with a dead stream behind it.
 *     Fix: ONE shared `dropDeletedChatFromView` used by the sidebar delete
 *     button, the archive action, and the SSE `chat.deleted` notice.
 *  2. THE SNAPSHOT CACHE (module-level, survives the remount) served the
 *     deleted chat's cached transcript on re-open (deep link / dashboard row)
 *     before the first GET 404s. Fix: `purgeSessionSnapshot` export, purged by
 *     the page on every removal path.
 *  3. THE RECONNECT LOOP retried forever: a deleted chat 404s every probe, but
 *     404 was swallowed into the generic catch (`() => null`) or mapped to
 *     'no_workspace' — so the view looped on "Reconnecting…" (or showed the
 *     wrong copy) instead of the honest terminal "deleted" state. Fix:
 *     `markChatDeleted` + the `'deleted'` loadFailed arm + 404→'gone' in
 *     fetchPlainRunActive.
 *
 * Same source-level idiom as sidebar-chat-loading.test.tsx (no jsdom — pins
 * anchor on stable identifiers, never line numbers). VERIFICATION-ONLY: a
 * failing row is a BLOCKED finding to report, not a test to weaken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = readSrc('./page.tsx');
const VIEW = readSrc('./components/CodeSessionView.tsx');

describe('Deleted-chat view clearing — page.tsx (owner 2026-10-27)', () => {
  it('declares the ONE shared view-clearing handler and it unmounts the open view', () => {
    // The handler must clear BOTH mount ids — currentChatId alone left the
    // unified view mounted (the exact reported bug).
    expect(PAGE).toContain('const dropDeletedChatFromView = useCallback((chatId: string) => {');
    const i = PAGE.indexOf('const dropDeletedChatFromView = useCallback((chatId: string) => {');
    const body = PAGE.slice(i, PAGE.indexOf('}, []);', i));
    expect(body).toContain('setCurrentChatId(null)');
    expect(body).toContain('setCodeChatId(null)');
    expect(body).toContain('setCodeChatPlain(false)');
    expect(body).toContain('purgeSessionSnapshot(chatId)');
  });

  it('the files panel does not outlive the chat it was showing (review M1: dead chat kept an unclosable panel)', () => {
    // M1 (2026-10-27): `dropDeletedChatFromView` cleared the chrome but kept
    // `panelOpen`/`canvases`/`activeCanvasId` — the Flanking header's workspace
    // toggle vanishes with the view (`showWorkspaceToggle` needs codeChatId),
    // so the deleted chat's docs stayed on screen with no way to close them.
    // The panel trio must be cleared exactly like `startNewChat` clears them.
    const i = PAGE.indexOf('const dropDeletedChatFromView = useCallback((chatId: string) => {');
    const body = PAGE.slice(i, PAGE.indexOf('}, []);', i));
    expect(body).toContain('setPanelOpen(false)');
    expect(body).toContain('setCanvases([])');
    expect(body).toContain('setActiveCanvasId(null)');
  });

  it('deleteChat clears the open view AND refreshes folder counts (the badge must drop with the row)', () => {
    const i = PAGE.indexOf('const deleteChat = useCallback(async (chatId: string) => {');
    expect(i).toBeGreaterThanOrEqual(0);
    const body = PAGE.slice(i, PAGE.indexOf('}, [', i));
    expect(body).toContain('dropDeletedChatFromView(chatId)');
    expect(body).toContain('refreshFolderLists()');
  });

  it('archiveChat clears an open view of the archived chat and refreshes folders too', () => {
    const i = PAGE.indexOf('const archiveChat = useCallback(async (chatId: string) => {');
    expect(i).toBeGreaterThanOrEqual(0);
    const body = PAGE.slice(i, PAGE.indexOf('}, [', i));
    expect(body).toContain('dropDeletedChatFromView(chatId)');
    expect(body).toContain('refreshFolderLists()');
  });

  it('the SSE chat.deleted notice routes through the SAME handler as the button (no drift)', () => {
    // chatId is optional on the widened notice union (project.* kinds carry
    // projectId), so the branch guards it — the pin follows the guarded shape.
    expect(PAGE).toContain("if (notice.kind === 'chat.deleted' && notice.chatId) {");
    expect(PAGE).toContain('handleChatDeletedNotice(notice.chatId);');
    // The named callback itself must drop the row + clear the view + folders.
    const i = PAGE.indexOf('const handleChatDeletedNotice = useCallback((chatId: string) => {');
    const body = PAGE.slice(i, PAGE.indexOf('}, [', i));
    expect(body).toContain('setChats(prev => prev.filter(c => c.id !== chatId))');
    expect(body).toContain('dropDeletedChatFromView(chatId)');
  });

  it('remote folder mutations (archive/restore/move/create notices) refresh folder state', () => {
    // Finding B: the delta fetch reconciles chat rows but NEVER folder
    // counts/names — a chat archived or moved elsewhere left the badge stale.
    expect(PAGE).toContain("notice.kind === 'chat.archived' || notice.kind === 'chat.restored'");
    expect(PAGE).toContain("|| notice.kind === 'chat.moved' || notice.kind === 'chat.created'");
    expect(PAGE).toContain('const refreshFolderLists = useCallback(() => {');
  });

  it('a deep link to a deleted chat says so instead of failing silently', () => {
    const i = PAGE.indexOf('crossModelApi.getChat(urlChatId, { messageLimit: 1 })');
    const body = PAGE.slice(i, i + 1600);
    expect(body).toContain("e?.response?.status === 404");
    expect(body).toContain('That chat no longer exists');
  });
});

describe('Deleted-chat terminal state — CodeSessionView.tsx (owner 2026-10-27)', () => {
  it("extends the loadFailed union with 'deleted' and renders the honest terminal arm", () => {
    expect(VIEW).toContain("useState<false | 'no_workspace' | 'deleted' | 'error'>(false)");
    expect(VIEW).toContain("if (loadFailed === 'deleted') {");
    // The arm is terminal — no retry affordance (every retry would 404).
    const i = VIEW.indexOf("if (loadFailed === 'deleted') {");
    const arm = VIEW.slice(i, VIEW.indexOf('if (loadFailed ===', i + 10));
    // Review round 2, defect 3: the 404 is ACCESS-gated — "deleted" and
    // "access revoked" (unshared) are indistinguishable, so the copy names
    // availability to THIS USER, never a bare claim of deletion.
    expect(arm).toContain('no longer available to you');
    expect(arm).toContain('deleted, moved, or unshared');
    expect(arm).not.toContain('onRetry');
    // The plain flavor gets chat copy, the coding flavor session copy.
    expect(arm).toContain('This chat is no longer available to you');
    expect(arm).toContain('This session is no longer available to you');
  });

  it('a CODING cold-load 404 runs the confirm-probe too (review round 2, defect 1)', () => {
    // The coding session GET 404s for BOTH a deleted chat AND a live
    // satellite-less chat; the cold load used to map it straight to
    // no_workspace — a stale-row open of a deleted session showed the
    // misleading "no workspace yet" copy. The catch now confirms via the
    // plain chat read before choosing an arm.
    const i = VIEW.indexOf('full = await codingApi.getSession(chatId, { messageLimit: CODING_PAGE });');
    const body = VIEW.slice(i, VIEW.indexOf('const running = full.status', i));
    expect(body).toContain('confirmCodingChatGone(chatId)');
    expect(body).toContain("verdict === 'gone' ? 'deleted'");
    expect(body).toContain("verdict === 'no_workspace' ? 'no_workspace'");
  });

  it('declares markChatDeleted and it stops the reconnect loop + purges the snapshot', () => {
    expect(VIEW).toContain('const markChatDeleted = useCallback((sid: string) => {');
    const i = VIEW.indexOf('const markChatDeleted = useCallback((sid: string) => {');
    const body = VIEW.slice(i, VIEW.indexOf('}, [', i));
    expect(body).toContain('es?.close()');
    expect(body).toContain('clearTimeout(reconnectRef.current.timer)');
    // Review round 1, finding 9: the busy-queue stream dies too (the unmount
    // teardown closes it; the terminal path must not leave it running).
    expect(body).toContain('plainQueueEsRef.current?.close()');
    expect(body).toContain("setLoadFailed('deleted')");
    expect(body).toContain('purgeSessionSnapshot(sid)');
    // The sidebar spinner dies with the loop (setRunning(sid, false)).
    expect(body).toContain('setRunning(sid, false)');
  });

  it('a coding 404 is CONFIRMED via the plain chat read before latching deleted (404 ≠ deleted)', () => {
    // Review round 1, finding 2: the coding session GET 404s for BOTH a
    // deleted chat AND a live chat whose satellite was detached — the
    // confirm-probe splits them (getChat 404 ⇒ gone; 200 ⇒ no_workspace).
    expect(VIEW).toContain("const confirmCodingChatGone = useCallback(async (sid: string): Promise<'gone' | 'no_workspace' | 'unknown'> => {");
    const i = VIEW.indexOf('const confirmCodingChatGone = useCallback');
    const body = VIEW.slice(i, VIEW.indexOf('}, []);', i));
    expect(body).toContain('crossModelApi.getChat(sid, { messageLimit: 1 })');
    expect(body).toContain("return 'no_workspace'");
    expect(body).toContain("return 'gone'");
    // Both coding-404 consumers (reconnect slow-phase + resync) route through it.
    expect(VIEW.match(/await confirmCodingChatGone\(sid\)/g)?.length ?? 0).toBe(2);
    // The no_workspace fallback keeps the panel alive (re-attachable), never
    // the terminal deleted state, for a satellite-detached live chat.
    const reconnect = VIEW.indexOf("if (verdict === 'no_workspace') {");
    expect(reconnect).toBeGreaterThan(0);
  });

  it('the plain probes act on the tri-state gone signal (reconnect + resync)', () => {
    expect(VIEW).toContain("if (active === 'gone') {");
    expect(VIEW.match(/if \(active === 'gone'\) \{/g)?.length ?? 0).toBe(2);
    expect(VIEW).toContain('const active = await fetchPlainRunActive(sid); // tri-state');
  });

  it('exports purgeSessionSnapshot so the page can drop the cached transcript of a deleted chat', () => {
    expect(VIEW).toContain('export function purgeSessionSnapshot(chatId: string): void');
    expect(VIEW).toContain('sessionSnapshots.delete(chatId);');
  });

  it('the cold-load catches map a 404 to the deleted state, not no_workspace/error', () => {
    // Plain path: 404 ⇒ 'deleted' (was 'error' — retryable on a dead chat).
    const plainCatch = VIEW.indexOf('catch (e: any) {', VIEW.indexOf('const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });'));
    const body = VIEW.slice(plainCatch, plainCatch + 500);
    expect(body).toContain("e?.response?.status === 404 ? 'deleted' : 'error'");
  });
});
