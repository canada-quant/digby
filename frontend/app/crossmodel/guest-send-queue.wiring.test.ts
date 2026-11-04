/**
 * Wiring pins for the guest send-while-running queue (d0777a67) — change
 * detectors over CodeSessionView's source, same style as
 * provision-queue.wiring pins and c3-legacy-retirement. The BEHAVIOUR of the
 * pure leaf is pinned in lib/guest-send-queue.test.ts.
 *
 * The reported bug: "queued messages doesn't seem to work when not logged
 * in" — a guest's mid-run send hit the C3 chatless guard
 * (`if (live.running && !chatId) return;`) and vanished, while the footer
 * promise said "your message queues and sends next".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const VIEW = read('./components/CodeSessionView.tsx');
const CHROME = read('./components/FloatingChrome.tsx');

describe('d0777a67 [CodeSessionView] — a guest mid-run send stages, echoes, drains', () => {
  it('the C3 chatless guard STAGES guest sends instead of dropping them', () => {
    expect(VIEW).toContain('stageChatlessBehindLive({ liveRunning: true, guest: !!plainCfg.guest })');
    expect(VIEW).toContain('const item = makeGuestQueued({ message, uploads: heldAtts });');
    // The composer is cleared like a real send (nothing staged is lost).
    expect(VIEW).toContain('setGuestQueue([...guestQueueRef.current, item]);');
  });

  // Ticket 625773b5: guests have an attachment bar now, so a mid-run hold must
  // snapshot it — otherwise the ungated surface would drop every staged file.
  it('625773b5: the hold SNAPSHOTS the attachment bar and an attachment-only hold still stages', () => {
    expect(VIEW).toContain('const heldAtts = guestHold && !escalationOf ? (plainCfg.takeAttachments?.() ?? []) : [];');
    expect(VIEW).toContain('if (guestHold && (message.trim() || heldAtts.length > 0)) {');
    // The held chips render on the queued bubble (visible, not phantom).
    expect(VIEW).toContain('...(q.uploads?.length ? { plainMeta: { attachments: q.uploads.map(u => ({ filename: u.filename ?? \'file\', type: u.type ?? \'document\', localPreview: u.localPreview })) } } : {}),');
  });

  it('a drain effect fires ONE merged send when the live run ends', () => {
    expect(VIEW).toContain('const action = guestDrainAction({ queued: guestQueueRef.current.length, liveRunning: live.running });');
    expect(VIEW).toContain('const merged = mergeGuestQueued(guestQueueRef.current);');
    // The held uploads ride the drain send (625773b5) — takeAttachments is
    // empty by then, so overrideUploads is the only carrier.
    expect(VIEW).toContain('void send(merged.message, undefined, { overrideUploads: merged.uploads as unknown as AttachmentInfo[] });');
  });

  it('625773b5: the plain send path HONORS overrideUploads (else held chips vanish)', () => {
    expect(VIEW).toContain(': (opts?.overrideUploads ?? plainCfg.takeAttachments?.() ?? []);');
  });

  it('queued guest bubbles render in the queued-echo slot with their own caption', () => {
    expect(VIEW).toContain('const guestQueued = isGuestQueueId(m.id);');
    expect(VIEW).toContain('<DigbyLoader size={16} label="Queued" /> {GUEST_QUEUE_CAPTION}');
    // Guest echoes ride the same queued partition as steer/provision echoes.
    expect(VIEW).toContain('const out = [...steerEchoes, ...provisionEchoes, ...guestEchoes];');
  });

  it('the composer lets a GUEST submit mid-run (queue) — the hold is fallback-only', () => {
    // The old gate dropped every chatless mid-run send: `!(plain && !chatId && live.running)`.
    expect(VIEW).not.toContain('!(plain && !chatId && live.running)}');
    expect(VIEW).toContain('!(plain && !chatId && !plain.guest && live.running))}');
    // Guests get the queue affordance, not the wait hold.
    expect(VIEW).toContain("(plain.guest ? 'Queue message' : 'Wait for this answer…')");
  });

  it('the drain is guest-scoped: never for authed chats or the fallback mount', () => {
    expect(VIEW).toContain('if (!plain || !plainRef.current?.guest || chatId) return;');
  });

  it('N1: the drain is gated on the SERVER-side run state (a guest Stop leaves the server run live)', () => {
    // fetchGuestSessionState().active must agree (null fails open) before the
    // merged send fires — a chatless busy send is a terminal error server-side.
    expect(VIEW).toContain('const st = await fetchGuestSessionState(gid);');
    expect(VIEW).toContain('if (!st || !st.active) { drainNow(); return; }');
  });

  it('N2: an empty/whitespace draft never stages a phantom queued bubble', () => {
    // 625773b5: the guard is now "text OR held attachments" — a blank draft
    // with nothing staged still no-ops, and an attachment-only hold is real.
    expect(VIEW).toContain('if (guestHold && (message.trim() || heldAtts.length > 0)) {');
  });
});

describe('d0777a67 [FloatingChrome] — the guest header cluster fits a phone', () => {
  it('both auth buttons take the 44px coarse-pointer touch floor', () => {
    expect(CHROME).toContain('[@media(pointer:coarse)]:min-h-11');
  });

  it('under sm the cluster collapses to the single primary CTA (Sign up)', () => {
    // Log in hides on phones; Sign up stays (title + two 44px icon buttons fit).
    expect(CHROME).toContain('hidden sm:flex h-[34px]');
    expect(CHROME).toContain('flex h-[34px] min-h-[34px] [@media(pointer:coarse)]:min-h-11 flex-shrink-0 items-center rounded-full bg-send');
  });

  it('the cluster never shrinks the title out of the row (flex-shrink-0)', () => {
    expect(CHROME).toContain('flex flex-shrink-0 items-center gap-1.5');
  });
});
