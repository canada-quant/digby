/**
 * Stream drops (2026-10-20, owner "why does connection drop?") — the
 * CodeSessionView wiring, pinned at SOURCE level (the view's EventSource /
 * effects make a full render infeasible under the node vitest environment —
 * the same idiom as c1-convergence-smoke.test.tsx: stable identifiers and
 * ordering, never line numbers). The pure halves are pinned in
 * guest-reconnect.test.ts and lib/stream-drop-beacon.test.ts.
 *
 *   1. a GUEST's es.onerror reconnects through GET /session/:id/stream with the
 *      shared backoff instead of "Connection lost — send your message again"
 *      (which survives only for the no-session / switch-off path);
 *   2. resyncActive no longer early-returns for a guest with a session id;
 *   3. a window 'online' listener triggers resyncActive (guarded by its switch);
 *   4. EVERY guest reattach completion reads the answer from the session
 *      history (startGuestResume) — never appended as is: a partial one has no
 *      candidate, a whole one offers its streamed row, kept only when the
 *      history confirms it (review 2026-10-20: the reattach can replay the
 *      PREVIOUS turn's run);
 *   5. drop / resume beacons ride one tracker; a new send resets it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const VIEW = readFileSync(fileURLToPath(new URL('./components/CodeSessionView.tsx', import.meta.url)), 'utf8');

/** The source between two anchors (throws when an anchor is missing — a renamed seam must fail loudly). */
const region = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`anchor not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`end anchor not found: ${to}`);
  return src.slice(a, b);
};

describe('es.onerror — the guest reconnect (stream drops 2026-10-20)', () => {
  const onerror = region(VIEW, 'es.onerror = () => {', '// Host callbacks are read via refs');

  it('a guest with a session id reconnects through its own attach URL with the shared backoff', () => {
    const guest = region(onerror, 'if (plainRef.current && sid == null) {', "if (sid == null) return; // defensive");
    expect(guest).toContain('const gid = guestReconnectSessionId(plainRef.current, sid);');
    expect(guest).toContain('reconnectBackoff(guestAttempts)');
    expect(guest).toContain("connectStream(null, '', { attach: true, url: buildGuestAttachUrl(gid) });");
    // The slow phase reconciles against /session/:id/state and hands an ended run to the resume.
    expect(guest).toContain('await fetchGuestSessionState(gid)');
    expect(guest).toContain('startGuestResume(gid, messagesRef.current, { afterDrop: true });');
  });

  it('"send your message again" survives ONLY for the no-reconnect path (no session id / switch off)', () => {
    const guest = region(onerror, 'if (plainRef.current && sid == null) {', "if (sid == null) return; // defensive");
    const deadEnd = region(guest, 'if (!gid) {', 'reconnectRef.current.attempts = guestAttempts + 1;');
    expect(deadEnd).toContain("status: 'Connection lost — send your message again to retry'");
    expect(guest.indexOf("'Connection lost — send your message again to retry'")).toBe(guest.lastIndexOf("'Connection lost — send your message again to retry'"));
  });

  it('the signed-in path keeps its schedule through the same backoff helper', () => {
    const signedIn = onerror.slice(onerror.indexOf("if (sid == null) return; // defensive"));
    expect(signedIn).toContain('const { slow, delay } = reconnectBackoff(attempts);');
    expect(signedIn).toContain("connectStream(sid, '', { attach: true });");
  });

  it('every drop opens (or continues) ONE beacon episode', () => {
    expect(onerror).toContain("dropTrackerRef.current.drop(streamDropCtx(sid, guestAttempts), 'resend');");
    expect(onerror).toContain("dropTrackerRef.current.drop(streamDropCtx(sid, guestAttempts), 'retrying');");
    expect(onerror).toContain("dropTrackerRef.current.drop(streamDropCtx(sid, attempts), 'retrying');");
  });
});

describe('resyncActive — guests reconcile too', () => {
  const resync = region(VIEW, 'const resyncActive = useCallback(async () => {', '// Plain mode (P2 increment 2)');

  it('no early return for a guest with a session id: probe /state, reattach while live, hydrate when ended', () => {
    expect(resync).not.toMatch(/if \(!sid\) return;/);
    expect(resync).toContain('const gid = guestReconnectSessionId(plainRef.current, sid);');
    expect(resync).toContain('if (!guestResumeNeeded(messagesRef.current) || guestResumeRef.current) return;');
    expect(resync).toContain("connectStream(null, '', { attach: true, url: buildGuestAttachUrl(gid) });");
    expect(resync).toContain('startGuestResume(gid, messagesRef.current, { afterDrop });');
    expect(resync).toContain('const afterDrop = dropTrackerRef.current.episodeOpen;');
    expect(resync).toContain('if (sendStartedRef.current && Date.now() - sendStartedRef.current.at < 10_000) return;');
    // The same 1.5 s dedupe and "a flowing stream is left alone" guards as the signed-in path.
    expect(resync).toContain('if (Date.now() - lastResyncRef.current < 1500) return;');
    expect(resync).toContain('if (es0 && es0.readyState !== 2) return;');
  });
});

describe("window 'online' resync", () => {
  it('network back triggers resyncActive, guarded by NEXT_PUBLIC_ONLINE_RESYNC_DISABLED and removed on cleanup', () => {
    const effect = region(VIEW, 'const onFocus = () => { void resyncActive(); };', '}, [resyncActive]);');
    expect(effect).toContain('const onOnline = () => { void resyncActive(); };');
    expect(effect).toContain('const listenOnline = !onlineResyncDisabled();');
    expect(effect).toContain("if (listenOnline) window.addEventListener('online', onOnline);");
    expect(effect).toContain("if (listenOnline) window.removeEventListener('online', onOnline);");
  });
});

describe('guest reattach completion', () => {
  it('every guest reattach completion reads the answer from the session history — a partial one with no candidate', () => {
    const complete = region(VIEW, "else if (type === 'complete') {", "} else if (type === 'error') {");
    const guest = region(complete, '} else if (guestAttachId) {', '} else {');
    expect(guest).toContain('const whole = !(data?.interrupted === true || data?.handedOff === true || replayTruncated);');
    expect(guest).toContain('startGuestResume(guestAttachId, messagesRef.current, { afterDrop: true, ...(streamed ? { streamed } : {}) });');
    expect(VIEW).toContain("} else if (r.kind === 'gone' || (opts?.afterDrop && r.kind === 'inactive')) {");
    expect(VIEW).toContain("if (type === 'progress' && data?.stage === 'truncated') replayTruncated = true;");
  });

  // Review 2026-10-20: a whole guest-attach complete used to fall through to
  // the plain append — a replay of the PREVIOUS turn's run was then persisted
  // as the answer to the new question.
  it('a WHOLE guest reattach complete is never appended directly: its row is only a candidate the history must confirm', () => {
    const complete = region(VIEW, "else if (type === 'complete') {", "} else if (type === 'error') {");
    const guestAt = complete.indexOf('} else if (guestAttachId) {');
    const plainAppendAt = complete.indexOf('setMessages(prev => [...prev, appended]);');
    expect(guestAt).toBeGreaterThan(-1);
    expect(guestAt).toBeLessThan(plainAppendAt); // the guest branch is taken before the plain append
    const guest = region(complete, '} else if (guestAttachId) {', '} else {');
    expect(guest).not.toContain('setMessages(');
    expect(guest).not.toContain('onTranscriptChange');
    const starter = region(VIEW, 'const startGuestResume = useCallback(', '}, []);');
    expect(starter).toContain('const pick = guestResumeRowPick(r, opts?.streamed, seed);');
    expect(starter).toContain("const appended: CodingMessage = pick.use === 'streamed' ? pick.row : guestHydratedRow(pick.content, pick.chips);");
  });

  it('the reload resume and the reattach share ONE starter', () => {
    expect(VIEW).toContain('if (gid && plainRef.current?.guest && guestResumeNeeded(seed)) startGuestResume(gid, seed);');
    expect(VIEW.match(/void resumeGuestSession\(/g)).toHaveLength(1);
  });
});

describe('drop / resume beacons', () => {
  it('the first frame of a reattach closes an open episode; a new send resets it', () => {
    expect(VIEW).toContain("dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), type === 'complete' && data?.interrupted ? 'ended' : 'resumed');");
    expect(VIEW).toContain('dropTrackerRef.current.reset();');
  });
});
