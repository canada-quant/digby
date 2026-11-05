/**
 * Guest title + reload state wiring pins (owner report 2026-09-26: "guest
 * mode, chat title generation didn't work and when i refreshed and went back
 * to a chat that was mid response it shouldn't show the progress and state in
 * streaming anymore").
 *
 * SOURCE-LEVEL pins (the p1-shell-pins idiom — stable identifiers, never line
 * numbers; vitest runs in node, so client components pin at the source):
 *   1. the view applies a chatId-less run's server title (the 'chat-title'
 *      frame AND the autoTitle echo on complete) through plain.onGuestTitle,
 *      and the page wires it to retitleGuestSession;
 *   2. a reopened chatless session mounts with running:false and hands a
 *      mid-response transcript to resumeGuestSession — the ONLY path that may
 *      show a "still working" state, and only after the server says the run
 *      is live (onWaiting), with a calm status and no timer/parts;
 *   3. a restored signed-in chat polls a still-pending last row from this tab
 *      and settles the pill to "Check didn't finish" at the bound; a live
 *      reattach still goes through fetchPlainRunActive → connectStream(attach).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const VIEW = read('./components/CodeSessionView.tsx');
const PAGE = read('./page.tsx');
const PLAIN = read('./plain-session.ts');

function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `region anchor ${JSON.stringify(to)} missing after ${JSON.stringify(from)}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('1. guest title — the server title reaches the browser-local record', () => {
  it("the 'chat-title' frame (session_title) applies to guests when there is no chat id", () => {
    const r = region(VIEW, "else if (type === 'session_title')", "else if (type === 'plan_update')");
    expect(r).toContain('if (sid) onTitleChangeRef.current?.(sid, data.title);');
    expect(r).toContain('else if (plainRef.current?.guestSessionId) plainRef.current.onGuestTitle?.(plainRef.current.guestSessionId, String(data.title));');
  });

  it('the autoTitle echo on complete applies to guests (the only second chance — no title endpoint for sessions)', () => {
    const r = region(VIEW, '// Title catch-up (owner 2026-09-22', '// Per-chat Files section (57ef1b9f PR2)');
    expect(r).toContain('} else if (plainRef.current?.guestSessionId) {');
    expect(r).toContain("const echoed = typeof data?.autoTitle === 'string' ? data.autoTitle.trim() : '';");
    expect(r).toContain('if (echoed) plainRef.current.onGuestTitle?.(plainRef.current.guestSessionId, echoed);');
  });

  it('PlainSessionProps carries onGuestTitle and the page wires it to retitleGuestSession', () => {
    expect(VIEW).toContain('onGuestTitle?: (guestSessionId: string, title: string) => void;');
    expect(PAGE).toContain('retitleGuestSession,');
    const handler = region(PAGE, 'const handleGuestTitle = useCallback(', '}, []);');
    expect(handler).toContain('if (retitleGuestSession(gid, title)) setGuestSessions(loadGuestSessions());');
    expect(PAGE).toContain('onGuestTitle: chatlessActive?.guest && activeGuestId ? handleGuestTitle : undefined,');
  });
});

describe('2. reopened guest session — deterministic restore, no streaming chrome', () => {
  const load = region(VIEW, 'if (!chatId) {\n        const seed = plainRef.current?.initialTranscript ?? [];', 'return;\n      }');

  it('mounts with running:false from the browser-local transcript (nothing is attached in this tab)', () => {
    expect(load).toContain('setMessages(seed);');
    expect(load).toContain('setLive({ parts: [], pendingApproval: null, running: false });');
    expect(load).toContain('setPlainLoaded(true);');
  });

  // Stream drops (2026-10-20): the resume body moved into ONE starter
  // (startGuestResume) shared with the guest REATTACH paths (a dropped stream
  // whose run ended while disconnected) — the load effect hands it the seed;
  // the pins below follow the body into the starter, unchanged.
  const starter = region(VIEW, 'const startGuestResume = useCallback((gid: string, seed: CodingMessage[], opts?: { afterDrop?: boolean; streamed?: CodingMessage }) => {', '}, []);');

  it('only a MID-RESPONSE transcript (guestResumeNeeded) enters the resume path', () => {
    expect(load).toContain('if (gid && plainRef.current?.guest && guestResumeNeeded(seed)) startGuestResume(gid, seed);');
    expect(starter).toContain('void resumeGuestSession(gid, seed, {');
    expect(starter).toContain('fetchState: fetchGuestSessionState,');
  });

  it('the "still working" state is entered ONLY from onWaiting (the server said the run is live): calm status, no parts, no timer, no streaming chrome', () => {
    // 2026-09-27: guestResumeLiveState() = { running:true, source:'poll', status:GUEST_RESUME_STATUS }
    // — `source:'poll'` keys the composer off Stop / "Stop ends it." (resumed-run-composer.test.tsx).
    expect(starter).toContain('onWaiting: () => { if (alive()) setLive({ parts: [], pendingApproval: null, ...guestResumeLiveState() }); },');
    for (const r of [load, starter]) {
      expect(r).not.toContain('setRunStart(');
      expect(r).not.toContain('connectStream(');
    }
  });

  it('a hydrated answer is appended + mirrored to the store; every outcome ends with running:false', () => {
    // review 2026-10-20: guestResumeRowPick (guest-resume.ts) picks the row — without a streamed
    // candidate (this reload path) it is the history answer or nothing, exactly as before.
    expect(starter).toContain('const pick = guestResumeRowPick(r, opts?.streamed, seed);');
    expect(starter).toContain('if (pick) {');
    // audit sse-ui-restore-14: the row builder is the pure guestHydratedRow (carries the state's chips)
    expect(starter).toContain("const appended: CodingMessage = pick.use === 'streamed' ? pick.row : guestHydratedRow(pick.content, pick.chips);");
    expect(starter).toContain('plainRef.current?.onTranscriptChange?.([...messagesRef.current, appended]);');
    expect(starter).toContain('setLive({ parts: [], pendingApproval: null, running: false });');
  });

  it('a stale loop stops on remount / unmount (token ref, cleared on unmount)', () => {
    expect(VIEW).toContain('const guestResumeRef = useRef<string | null>(null);');
    expect(VIEW).toContain('useEffect(() => () => { guestResumeRef.current = null; }, []);');
    expect(starter).toContain('const alive = () => guestResumeRef.current === token;');
    expect(starter).toContain('shouldContinue: alive,');
  });
});

describe('3. restored signed-in chat — the check pill from metadata, a live reattach only when the run is live', () => {
  const load = region(VIEW, 'const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });', 'const attach = !!plainRef.current?.attachOnLoad;');

  it('the initial load settles stale pending rows and polls a young LAST row from this tab', () => {
    expect(load).toContain('const restored = settleRestoredRows(mapPlainMessages(full));');
    // Ticket c0b2b0c8: the plain GET now also returns pendingMessages — the
    // initial load appends the queued rows (empty case falls back to the old
    // exact line) and unions their ids into pendingSteerIds (pinned in
    // describe 4).
    expect(load).toContain('setMessages(restoredPending.length ? [...restored, ...restoredPending] : restored);');
    expect(load).toContain('startPendingRowPoll(restored, chatId);');
  });

  it('the post-run reload applies the same rule (settle + poll), so an attach-complete never leaves "Checking…" unpolled', () => {
    const r = region(VIEW, 'const reloadPlain = useCallback(async (sid: string) => {', '}, [startPendingRowPoll]);');
    expect(r).toContain('const restored = settleRestoredRows(mapPlainMessages(full));');
    expect(r).toContain('startPendingRowPoll(restored, sid);');
  });

  it('ONE poll per row, EVERY pending row (audit 2026-09-26 sse-ui-restore-5 — not only the last one): the helper dedupes by row id and settles the pill to "Check didn’t finish" at the bound', () => {
    const r = region(VIEW, 'const startPendingRowPoll = useCallback(', '}, []);');
    // audit sse-ui-restore-14: EVERY young pending row the poll can observe (pendingRowsToPoll), not only the last one
    expect(r).toContain('const { poll, unreachable } = pendingRowsToPoll(rows);');
    expect(r).toContain('for (const pendingRow of poll) {');
    expect(r).toContain('if (settle.length) setMessages(prev => settleRowsInterrupted(prev, settle));');
    expect(r).toContain('if (pendingPollRef.current.has(rowId)) continue;');
    expect(r).toContain('void pollPlainRevision(sid, rowId, (id, o) => crossModelApi.getChat(id, o), { shouldContinue: () => activeIdRef.current === sid })');
    expect(r).toContain('{ ...m, plainMeta: markCheckInterrupted(m.plainMeta) }');
  });

  it("the complete handler's revision poll goes through the same helper (no stacked polls, settled at the bound)", () => {
    const r = region(VIEW, "if (serverId && plainRef.current && sid && (data.pendingCrossCheck === true || plainRevisionPending(meta))) {", '}');
    expect(r).toContain('startPendingRowPoll([...messagesRef.current, appended], sid);');
    expect(VIEW).not.toContain('void pollPlainRevision(pollSid, serverId,');
  });

  it('mapPlainMessages stays raw; settleRestoredRows is the restore-site rule', () => {
    expect(PLAIN).toContain('export function settleRestoredRows(');
    expect(PLAIN).not.toContain('plainMeta: settleRestoredCheck(plainMeta,');
  });

  it('a live reattach still shows real progress — only after a definitive liveness TRUE, through the attach stream', () => {
    // 2026-10-27 (stale-delete UI fix): the catch below the attach block now
    // carries a 404 check (deleted chat → terminal 'deleted' state, owner
    // report) — the region terminator follows the new shape.
    const r = region(VIEW, 'const attach = !!plainRef.current?.attachOnLoad;', '} catch (e: any) {');
    expect(r).toContain('setLive({ parts: [], pendingApproval: null, running: attach });');
    expect(r).toContain('const active = await fetchPlainRunActive(chatId);');
    expect(r).toContain('if (active !== true || activeIdRef.current !== chatId || esRef.current) return;');
    expect(r).toContain("connectStream(chatId, '', { attach: true });");
  });
});

describe('4. server-listed queued rows (ticket c0b2b0c8) — pendingMessages survive reload in the queued partition, drop when drained', () => {
  it('plain-session maps the GET payload rows (pendingMessages → CodingMessage rows)', () => {
    expect(PLAIN).toContain('export function mapPlainPendingMessages(');
  });

  it('the initial load appends the pending rows and unions their ids into pendingSteerIds — server-listed queued rows render in the queued partition, indistinguishable from a locally-sent bubble', () => {
    const load = region(VIEW, 'const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });', 'const attach = !!plainRef.current?.attachOnLoad;');
    expect(load).toContain('const restoredPending = mapPlainPendingMessages(full);');
    expect(load).toContain('setMessages(restoredPending.length ? [...restored, ...restoredPending] : restored);');
    expect(load).toContain('setPendingSteerIds(prev => { const next = new Set(prev); for (const m of restoredPending) next.add(m.id); return next; });');
  });

  it('reloadPlain re-lists the server queue (dedup append), keeps still-listed ids pending, and releases drained ones', () => {
    const r = region(VIEW, 'const reloadPlain = useCallback(async (sid: string) => {', '}, [startPendingRowPoll]);');
    expect(r).toContain('const restoredPending = mapPlainPendingMessages(full);');
    // Ticket 81b229e1: the append is now ONE atomic commit (a dropped echo + the
    // server rows) instead of two sequential setMessages calls — the old
    // `return [...prev, ...restoredPending.filter(...)]` append double-rendered
    // a plain "Send now" message (tmp-* echo + its pending-<rowId> row).
    expect(r).toContain('const appendedPending = restoredPending.filter(m => !baseIds.has(m.id));');
    expect(r).toContain('setMessages(finalMessages);');
    expect(r).toContain('const listedPendingIds = new Set(restoredPending.map(m => m.id));');
    expect(r).toContain('if (mergedIds.has(id) && !r.idMap.has(id)) next.add(id);');
    expect(r).toContain('for (const id of listedPendingIds) next.add(id);');
    // The superseded echo must be released from the pending set, or the queued
    // partition keeps rendering a bubble that maps to no row.
    expect(r).toContain('if (replacedEchoIds.has(id)) continue;');
    // And the re-open snapshot must carry the SAME deduped array, or a remount
    // paints the duplicate straight back.
    expect(r).toContain('refreshPlainSnapshotMessages(sid, finalMessages);');
  });

  it('the PLAIN merge page-gates pending-* rows (a prev queue row the fresh page no longer lists was drained — never a duplicate bubble); the CODING merge is unchanged', () => {
    const plain = region(VIEW, 'function mergeLatestPlainPage(', 'const MSG_WINDOW');
    expect(plain).toContain("dropPrevAbsent: (id) => id.startsWith('pending-')");
    const coding = region(VIEW, 'function mergeLatestTranscriptPage(', 'function mergeLatestPlainPage(');
    expect(coding).not.toContain('dropPrevAbsent');
  });
});
