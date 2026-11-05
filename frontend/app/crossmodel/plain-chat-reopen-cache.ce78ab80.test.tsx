/**
 * Plain-chat re-open cache — ticket ce78ab80 (owner report 2026-11-04: "how
 * come everytime i navigate away from chats and then back i have to wait so
 * long for chats to load? arent they in cache or anything ?").
 *
 * THE REPORTED BEHAVIOUR: the unified view is keyed on chatId
 * (`key={codeChatId}` in page.tsx), so returning to a chat fully remounts it
 * and the plain load effect starts from `setMessages([])`. The CODING path has
 * had a module-level snapshot since 2026-08-31 — it paints the cached
 * transcript instantly and revalidates — but the PLAIN path had no cache at
 * all: every re-open showed an empty screen until a blocking `getChat(50)`
 * landed. This pins the plain half of that idiom to the coding half:
 *
 *  - ONE store, read BEFORE the transcript GET (the paint must not wait);
 *  - ONE write, from the FETCHED page (a snapshot the server never confirmed
 *    would resurrect rows the fetch just deleted);
 *  - the cache is purged wherever the coding snapshot is purged, or the
 *    2026-10-27 stale-delete report comes back for plain chats;
 *  - a hit never paints streaming chrome (live state stays the fetch's).
 *
 * Same source-level idiom as deleted-chat-stale-view.test.tsx (no jsdom —
 * pins anchor on stable identifiers, never line numbers).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const VIEW = readSrc('./components/CodeSessionView.tsx');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

const PLAIN_LOAD = () => region(
  VIEW,
  '// Ticket ce78ab80 — snapshot-first, the plain twin of the coding',
  'startPendingRowPoll(restored, chatId);',
);

describe('plain chat re-open (ticket ce78ab80) — the transcript paints from cache, then revalidates', () => {
  it('declares ONE module-level plain snapshot store built from the shared, unit-tested factory', () => {
    // The lifetime rules (TTL, LRU, drop) live in lib/plain-transcript-snapshot.ts
    // and are unit-tested there; the view owns only the wiring.
    expect(VIEW).toContain("import { createSnapshotStore } from '@/lib/plain-transcript-snapshot';");
    expect(VIEW).toContain('const plainTranscriptSnapshots = createSnapshotStore<CodingMessage>();');
  });

  it('reads the snapshot BEFORE the blocking transcript GET, and paints rows + queued partition + paging from it', () => {
    const load = PLAIN_LOAD();
    // The read precedes the fetch — that ordering IS the fix. If a refactor
    // moved it below the await, the empty screen the owner reported returns
    // with every test still green, so pin the order explicitly.
    const readAt = load.indexOf('const snap = plainTranscriptSnapshots.read(chatId);');
    const fetchAt = load.indexOf('const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });');
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeGreaterThan(readAt);
    // A hit paints everything the transcript render needs, not just the rows:
    // queued bubbles (ticket c0b2b0c8) and the "Load earlier" envelope would
    // otherwise pop in after the fetch.
    expect(load).toContain('setMessages(snap.messages);');
    expect(load).toContain('setPendingSteerIds(new Set(snap.pendingIds));');
    expect(load).toContain('setPlainPaging(snap.paging);');
    expect(load).toContain('setSupervisorChat(snap.supervisorChat);');
  });

  it('the fetch stays authoritative — the snapshot only fills state until it lands', () => {
    const load = PLAIN_LOAD();
    // The post-fetch assignments are untouched: the snapshot never replaces
    // the server's transcript, it only pre-paints it.
    expect(load).toContain('setMessages(restoredPending.length ? [...restored, ...restoredPending] : restored);');
    expect(load).toContain('setPlainPaging({ hasMore: !!full.hasMoreMessages, cursor: full.nextMessagesBefore ?? null });');
  });

  it('writes the snapshot from the FETCHED page (never from a prior snapshot) so the cache cannot resurrect deleted rows', () => {
    const load = PLAIN_LOAD();
    const writeAt = load.indexOf('rememberPlainTranscript(');
    expect(writeAt).toBeGreaterThanOrEqual(0);
    const writeBody = load.slice(writeAt, load.indexOf(');', writeAt));
    // Same values the view just committed — cache and screen cannot disagree.
    expect(writeBody).toContain('restoredPending.length ? [...restored, ...restoredPending] : restored,');
    expect(writeBody).toContain('{ hasMore: !!full.hasMoreMessages, cursor: full.nextMessagesBefore ?? null },');
    expect(writeBody).toContain('restoredPending.map(m => m.id),');
    expect(writeBody).toContain('!!(full.isSupervisor || full.isProjectSupervisor),');
    // ...and it is written AFTER the await, i.e. from `full`.
    const fetchAt = load.indexOf('const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });');
    expect(writeAt).toBeGreaterThan(fetchAt);
  });

  it('the writer itself only ever stores what its caller just committed (no read-back of a prior snapshot)', () => {
    const helper = region(VIEW, 'function rememberPlainTranscript(', 'function refreshPlainSnapshotMessages');
    expect(helper).toContain('plainTranscriptSnapshots.write(chatId, {');
    expect(helper).toContain('pendingIds: Array.from(pendingIds),');
    // A writer that re-read the cache would let unconfirmed rows survive.
    expect(helper).not.toContain('.read(');
  });

  it('a cache hit never paints streaming chrome — live state belongs to the fetch (and the effect reset)', () => {
    const load = PLAIN_LOAD();
    const snapBlock = load.slice(
      load.indexOf('if (snap) {'),
      load.indexOf('}', load.indexOf('if (snap) {')) + 1,
    );
    // The snapshot carries transcript state only; painting `running` from it
    // would show a live bubble/Stop for a run that ended in another tab.
    expect(snapBlock).not.toContain('setLive(');
    expect(snapBlock).not.toContain('setRunStart(');
    expect(snapBlock).not.toContain('running');
  });

  it('purging a chat drops the PLAIN snapshot too — the stale-delete rule covers both flavors', () => {
    const purge = region(VIEW, 'export function purgeSessionSnapshot(chatId: string): void {', '// Ticket ce78ab80 (owner report 2026-11-04');
    expect(purge).toContain('sessionSnapshots.delete(chatId);');
    expect(purge).toContain('plainTranscriptSnapshots.drop(chatId);');
  });

  it('the coding path keeps its own snapshot wiring unchanged (this fix must not disturb it)', () => {
    const coding = region(VIEW, 'const snap = readSessionSnapshot(chatId);', 'codingApi.getPlan(chatId)');
    expect(coding).toContain('setMessages(snap.messages);');
    expect(coding).toContain('full = await codingApi.getSession(chatId, { messageLimit: CODING_PAGE });');
    // The plain store must never be read on the coding path.
    expect(coding).not.toContain('plainTranscriptSnapshots');
  });
});