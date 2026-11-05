/**
 * Sidebar loading-state pins — ticket 26edb492: "when user waits for list of
 * chats to load from their account it shows empty and then just appears after
 * a minute or so — add a loading state so users know their chats aren't
 * deleted, just slow".
 *
 * The rail mounts the moment auth resolves but `chats` / `ownedProjects` are
 * still `[]` until their first fetches settle — both sections used to render
 * their EMPTY states during that window (blank rail / "No chats yet"), which
 * reads as data loss. These pins hold the fix in place:
 *
 *  - a one-shot `sidebarHydrated` flag, flipped ONCE from the mount loader
 *    after chats + folders + running sessions have ALL settled
 *    (`Promise.allSettled(...).finally`; owner 2026-10-20: the rail paints its
 *    final shape instead of chats first, folders next, spinners last), never
 *    re-armed;
 *  - a loading arm (`Loading chats…` + spinner + Skeleton rows) that renders
 *    BEFORE the error/empty arms in the chats section, and skeleton rows in
 *    the folders section;
 *  - the empty/error states remain gated on hydration so they only render
 *    once the first load has actually settled.
 *
 * Same source-level idiom as c3-legacy-retirement.test.tsx (no jsdom — pins
 * anchor on stable identifiers, never line numbers). VERIFICATION-ONLY: a
 * failing row is a BLOCKED finding to report, not a test to weaken.
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
  const b = src.indexOf(to);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('Sidebar loading state (ticket 26edb492) — chats list', () => {
  const chatsSection = region(
    PAGE,
    '{/* ── UNGROUPED CHATS SECTION ── */}',
    '{/* ── CONNECTED INSTANCES',
  );

  it('declares a one-shot sidebarHydrated flag initialized to not-hydrated', () => {
    expect(PAGE).toContain('const [sidebarHydrated, setSidebarHydrated] = useState(false)');
  });

  it('the loading arm renders before the error arm and carries the copy + spinner + skeletons', () => {
    // The ternary chain inside the empty-guard: loading → error → empty.
    // Ticket b5734922: the chats-section gate is the derived `railReady`
    // (sidebarHydrated || railSeeded) — a retained first paint suppresses the
    // skeleton, but the ORDERING of the three arms is unchanged, which is what
    // this row has always protected.
    const armStart = chatsSection.indexOf('!railReady ?');
    const errorArm = chatsSection.indexOf('chatListError ?');
    const emptyArm = chatsSection.indexOf('No chats yet. Start chatting!');
    expect(armStart, 'loading arm (!railReady) missing from chats section').toBeGreaterThanOrEqual(0);
    expect(errorArm, 'error arm (chatListError) missing from chats section').toBeGreaterThan(armStart);
    expect(emptyArm, 'empty arm missing from chats section').toBeGreaterThan(errorArm);

    // Copy + spinner idiom (matches ConnectedInstancesSection "Loading chats…").
    expect(chatsSection).toContain('Loading chats…');
    expect(chatsSection).toContain('<Loader2 className="size-3 animate-spin" />');
    // Skeleton rows fill the shape of the incoming chat rows.
    expect(chatsSection.match(/<Skeleton className="h-7/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // Accessible: a screen reader gets the same "still loading, not empty" signal.
    expect(chatsSection).toContain('role="status"');
    expect(chatsSection).toContain('aria-label="Loading chats"');
  });

  it('the error and empty arms never render over already-painted rows', () => {
    // The outer condition requires the lists to be EMPTY as well as the gate to
    // be ready — so once retained rows are painted (ticket b5734922), the outer
    // condition is false and neither the error nor the empty arm can render over
    // them. Both downstream arms sit behind the same `!railReady` ternary.
    expect(chatsSection).toContain(
      '(!railReady || (ungroupedChats.length === 0 && treeProjects.length === 0)) && (\n                    !railReady ?',
    );
    // The empty-list requirement is what keeps an error from replacing painted
    // rows, so pin it explicitly rather than relying on the string above.
    const guard = chatsSection.slice(0, chatsSection.indexOf('!railReady ?'));
    expect(guard).toContain('ungroupedChats.length === 0 && treeProjects.length === 0');
  });
});

describe('Sidebar loading state (ticket 26edb492) — folders section', () => {
  const foldersSection = region(
    PAGE,
    '{/* ── FOLDERS SECTION ── */}',
    // 7acaa7ba: the flat SHARED WITH ME section was RETIRED (shared folders
    // render inside the folders tree now) — the next boundary downstream is
    // the UNGROUPED CHATS section.
    '{/* ── UNGROUPED CHATS SECTION ── */}',
  );

  it('skeleton rows render while un-hydrated; the "New Folder" empty button waits for hydration', () => {
    // The empty-guard ternary is `visibleProjects.length === 0 ? (sidebarHydrated ? (
    //   New Folder button ) : ( skeleton ))` — the button renders only once
    // hydrated; the skeleton owns the in-flight window.
    const loading = foldersSection.indexOf('sidebarHydrated ?');
    expect(loading, 'folders section lacks a sidebarHydrated guard').toBeGreaterThanOrEqual(0);
    expect(foldersSection).toContain('aria-label="Loading folders"');
    expect(foldersSection.match(/<Skeleton className="h-6/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // The guard precedes the "New Folder" button (the button is gated on it).
    const newFolder = foldersSection.indexOf('New Folder');
    expect(newFolder).toBeGreaterThan(loading);
    // And the section renders skeletons ONLY while un-hydrated — the skeleton
    // branch is the else arm of the hydration ternary.
    const skeletonIdx = foldersSection.indexOf('aria-label="Loading folders"');
    expect(skeletonIdx).toBeGreaterThan(loading);
  });
});

describe('Sidebar loading state (ticket 26edb492; 2026-10-20 one flip after ALL rail loaders settle)', () => {
  it('the chat-list fetcher itself no longer flips hydration (the mount loader owns the flip)', () => {
    const fetcher = region(PAGE, 'const fetchChatList = useCallback', '// Load chats + memory + projects');
    expect(fetcher).not.toContain('setSidebarHydrated(true)');
  });

  it('hydration flips ONCE after chats + folders + running sessions have all settled (success or failure)', () => {
    const loaders = region(PAGE, 'const loaders: Promise<any>[] = [', '// After all loaders, handle deep links');
    // allSettled never rejects and every loader self-catches, so a dead fetch
    // can never hang the skeletons; .finally keeps the flip on every path.
    expect(loaders).toContain('Promise.allSettled([loaders[0], loaders[2], loaders[3]]).finally(() => {');
    expect(loaders).toContain('setSidebarHydrated(true)');
    // loaders[0] = chats, [2] = running seed, [3] = folders — pinned by order.
    expect(loaders.indexOf('fetchChatList(),')).toBeLessThan(loaders.indexOf('codingApi.listRunning()'));
    expect(loaders.indexOf('codingApi.listRunning()')).toBeLessThan(loaders.indexOf('projectsApi.list()'));
  });

  it('both sections paint only once hydrated — no partial list before the skeletons clear', () => {
    const foldersSection = region(PAGE, '{/* ── FOLDERS SECTION ── */}', '{/* ── UNGROUPED CHATS SECTION ── */}');
    expect(foldersSection).toContain('!sidebarHydrated || treeProjects.length === 0 ? (');
    // Ticket b5734922: the chats list gates on the derived `railReady`
    // (sidebarHydrated || railSeeded) so a retained first paint renders rows
    // immediately; `railSeeded` is one-shot and only ever set from retained
    // (server-confirmed) rows, so it cannot paint a partial list.
    expect(PAGE).toContain('{railReady && ungroupedChats.length > 0 && groupRowsByRecency(');
    expect(PAGE).toContain('const railReady = sidebarHydrated || railSeeded;');
  });

  it('the flag never re-arms — no reset-to-false call site exists', () => {
    // One-shot hydration: refetches (Retry, archive restores, loadMore) must
    // never flash skeletons over already-rendered rows. The ONLY setter call
    // is the flip to true.
    expect(PAGE).not.toContain('setSidebarHydrated(false)');
    expect((PAGE.match(/setSidebarHydrated\(true\)/g) ?? []).length).toBe(1); // the mount loader's allSettled flip
  });
});
