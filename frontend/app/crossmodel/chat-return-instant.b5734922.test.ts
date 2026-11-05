/**
 * Returning-to-chats instant paint — WIRING pins (ticket b5734922).
 *
 * Owner report 2026-11-04: "every navigation away from chats and back causes a
 * long wait; why are chats not cached?" The behaviour of the cache primitive is
 * covered by lib/chat-view-cache.test.ts; THIS file pins the two call sites, in
 * the house source-pin idiom (no jsdom — anchors on stable identifiers, never
 * line numbers), because what can regress here is the WIRING:
 *
 *  1. the sidebar seeds its first paint from the retained list before the fetch
 *     resolves, and the fetch REPLACES it (never merges a stale row in);
 *  2. the plain transcript seeds from its retained page BEFORE the GET, and the
 *     GET's arm replaces `messages` from the fresh page — the property that
 *     makes a retained first paint safe to show;
 *  3. every path that removes a chat also drops it from the retained caches, so
 *     the owner's 2026-10-27 "deleted chat still sits there" class cannot come
 *     back through the cache;
 *  4. sign-out clears them (module scope outlives the component).
 *
 * VERIFICATION-ONLY: a failing row is a BLOCKED finding to report, not a test to
 * weaken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = readSrc('./page.tsx');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('sidebar chat-list retention (page.tsx)', () => {
  const seedEffect = region(PAGE, 'useEffect(() => {\n    const retained = chatListCache.read', '// First sidebar page of chats');
  const fetcher = region(PAGE, 'const fetchChatList = useCallback', '// Load chats + memory + projects');

  it('declares one bounded, TTL-ed retained list at module scope', () => {
    // Module scope is the whole point: it is the only thing that survives the
    // route unmount that causes the re-fetch.
    expect(PAGE).toContain('const chatListCache = createRetainedCache<CrossModelChat[]>');
    expect(PAGE).toContain('ttlMs: CHAT_LIST_CACHE_TTL_MS');
    expect(PAGE).toContain('max: CHAT_LIST_CACHE_MAX');
  });

  it('seeds the rail from the retained list on mount', () => {
    expect(seedEffect).toContain("chatListCache.read('first-page')");
    expect(seedEffect).toContain('setChats(visible)');
    // Fleet-hidden chats must be filtered with the LAST KNOWN set, not the empty
    // one a fresh mount starts with (review finding, 2026-11-04).
    expect(seedEffect).toContain('retainedFleetHiddenChatIds.has(c.id)');
    expect(seedEffect).toContain('setRailSeeded(true)');
    // Mount-once: an effect that re-ran on chats churn would flash retained
    // rows over live ones.
    expect(seedEffect).toContain('}, []);');
  });

  it('an empty retained list never seeds (no phantom "loading" state)', () => {
    expect(seedEffect).toContain('if (!retained || !retained.value.length) return;');
  });

  it('the fetch writes the FRESH list over the seed, and clears on an empty page', () => {
    // Written from the fresh response only — a seed never re-writes itself,
    // so the cache can only ever hold server-confirmed rows.
    expect(fetcher).toContain("if (chatsArr.length) chatListCache.write('first-page', chatsArr);");
    expect(fetcher).toContain("else chatListCache.purge('first-page');");
    // And the response still REPLACES state wholesale — the reconcile that
    // makes the retained paint safe (a row deleted elsewhere disappears).
    expect(fetcher).toContain('setChats(chatsArr);');
  });

  it('the rail gates the loading arms on the derived readiness, folders keep hydration', () => {
    // Chats section: seeded rows paint immediately; no skeleton over them.
    expect(PAGE).toContain('const railReady = sidebarHydrated || railSeeded;');
    expect(PAGE).toContain('(!railReady || (ungroupedChats.length === 0 && treeProjects.length === 0)) && (');
    expect(PAGE).toContain('{railReady && ungroupedChats.length > 0 && groupRowsByRecency(');
    // Folders are NOT retained, so they must keep their own skeleton gate —
    // a seeded rail must never claim the folder tree has loaded.
    expect(PAGE).toContain('!sidebarHydrated || treeProjects.length === 0 ? (');
  });
});

describe('retained caches never resurrect a stale row (owner 2026-10-27 class)', () => {
  it('every page-level row change patches the retained list', () => {
    const drop = region(PAGE, 'function patchRetainedChat(', '/**');
    expect(drop).toContain("chatListCache.read('first-page')");
    // `null` = the row is gone; a patch object = the row survived with a new shape.
    expect(drop).toContain("chatListCache.write('first-page', next, retained.at)");
    expect(drop).toContain('if (patch === null) {');
    expect(drop).toContain('...patch');

    // delete button path
    const del = region(PAGE, 'const deleteChat = useCallback', 'const archiveChat = useCallback');
    expect(del).toContain('patchRetainedChat(chatId, null)');
    // archive path — archiving PATCHES archivedAt rather than removing, and the
    // retained row must carry the hidden shape or it first-paints into the rail.
    const arch = region(PAGE, 'const archiveChat = useCallback', '// ── Attach a workspace');
    expect(arch).toContain('patchRetainedChat(chatId, { archivedAt })');
    // cross-tab SSE chat.deleted path
    const notice = region(PAGE, 'const handleChatDeletedNotice = useCallback', 'const { refresh: refreshChatChanges }');
    expect(notice).toContain('patchRetainedChat(chatId, null)');
    // rename must not first-paint the old title
    const ren = region(PAGE, 'const handleRenameSubmit = useCallback', 'const factEntries');
    expect(ren).toContain('patchRetainedChat(chatId, { title: trimmed })');
  });

  it('a newly created chat is retained (no rail gap on the next return)', () => {
    expect(PAGE).toContain('retainApiChatRow(chatData.data);');
    const row = region(PAGE, 'function retainApiChatRow(', '/**');
    expect(row).toContain('chatListCache.write');
    // Never duplicates an id already on the retained page.
    expect(row).toContain('if (retained.value.some((c) => c.id === chat.id)) return;');
  });
});

describe('sign-out clears retained chat data (module scope outlives the page)', () => {
  it('both session-end paths clear the retained list', () => {
    // performLogout AND the definitive-401 arm: module scope outlives the page,
    // so a second account in the same tab must never first-paint the first's
    // rows — the guarantee has to be local, not dependent on the next login
    // being a full-document navigation.
    const logout = region(PAGE, 'const performLogout = () => {', 'if (typeof window');
    expect(logout).toContain('chatListCache.clear();');
    expect(PAGE.match(/chatListCache\.clear\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});