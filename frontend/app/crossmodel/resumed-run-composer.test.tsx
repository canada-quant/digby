/**
 * Resumed-run composer chrome (owner, prod 2026-09-27 00:50Z, guest, fresh
 * session: after a reload mid-answer the reopened chat correctly showed the
 * user bubble + the calm resume line, BUT the composer footer still read
 * "Digby is replying — your message queues and sends next. Stop ends it." with
 * the red Stop button — the streaming affordances — although no stream was
 * attached in that tab: the guest resume is a 5 s poll, Stop had nothing to
 * stop. Owner: "when I refreshed and went back to a chat that was mid response
 * it shouldn't show the progress and state in streaming anymore").
 *
 * ROOT CAUSE: CodeSessionView keyed `isStreaming` / `onStop` / the footer on
 * the bare `live.running` flag, and the guest resume's onWaiting set
 * `running:true` (it must — the live bubble shows the resume line) with no
 * way to say "nothing is attached here".
 *
 * FIX: `LiveRun.source` ('stream' | 'poll'); guest-resume.ts
 * `guestResumeLiveState()` marks the polled state; depth-ux-seams.ts
 * `composerRunAffordance` derives the composer chrome from a LIVE CONNECTION,
 * never from the running flag. Rendered-seam pins (react-dom/server — the
 * audit's route (A) idiom: behaviour, not source text):
 *   1. a resumed guest chat renders the resume line and NO stop / replying footer;
 *   2. a live attached stream renders them;
 *   3. a signed-in restored pending row renders no footer at all.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import ChatComposer, { type ChatComposerProps } from './components/ChatComposer';
import { LiveRunStatus } from './components/LiveRunStatus';
import { GUEST_RESUME_STATUS, guestResumeLiveState } from './guest-resume';
import { RUN_NOTE, composerRunAffordance, pendingRowsToPoll, type ComposerRunAffordance } from './depth-ux-seams';
import { mapPlainMessages, settleRestoredRows } from './plain-session';
import { pillFromMeta } from '@/lib/depth-ux';

const NOW = Date.parse('2026-09-27T00:50:00.000Z');
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

/** The view's composer wiring for one affordance (CodeSessionView: variant
 *  "code", isStreaming / onStop / footerNote from composerRunAffordance). */
function renderRunComposer(a: ComposerRunAffordance, over: Partial<ChatComposerProps> = {}): string {
  return renderToStaticMarkup(createElement(ChatComposer, {
    variant: 'code',
    composerRef: { current: null },
    onSubmit: () => {},
    canSubmit: true,
    isStreaming: a.streaming,
    onStop: a.streaming ? () => {} : undefined,
    footerNote: a.note ? createElement('p', { 'data-composer-note': true, className: 'text-[10px] text-muted-foreground/70 mt-1 px-1' }, a.note) : undefined,
    ...over,
  }));
}

const STOP_TITLE = 'Stop the run'; // ChatComposer's code-variant Stop button title

// ── 1. a resumed guest chat ──────────────────────────────────────────────────

describe('1. resumed guest chat (polled) — the resume line, NO stop / replying footer', () => {
  const live = guestResumeLiveState();
  const a = composerRunAffordance({ ...live, plain: true, chatId: null });

  it('the polled live state is running (the live bubble shows) but NOT streaming (nothing attached here)', () => {
    expect(live).toEqual({ running: true, source: 'poll', status: GUEST_RESUME_STATUS });
    expect(a).toEqual({ streaming: false, polled: true, note: RUN_NOTE.polledWait });
  });

  it('the live bubble renders the calm resume line and no clock', () => {
    const html = renderToStaticMarkup(createElement(LiveRunStatus, { status: live.status, since: null }));
    expect(html).toContain(GUEST_RESUME_STATUS);
    expect(html).not.toContain('tabular-nums'); // no ElapsedTimer without a run start
    expect(html).not.toContain('Stopping');
  });

  it('the composer renders no Stop button, no "Stop ends it.", no "Digby is replying" — a neutral hint only', () => {
    // The view holds a chatless mid-run send (canSubmit false, "Wait for this answer…").
    const html = renderRunComposer(a, { canSubmit: false, submitTitle: 'Wait for this answer…' });
    expect(html).not.toContain(STOP_TITLE);
    expect(html).not.toContain('Stop ends it');
    expect(html).not.toContain('Digby is replying');
    expect(html).toContain('data-composer-note');
    expect(html).toContain(RUN_NOTE.polledWait);
    expect(html).toContain('title="Wait for this answer…"');
    // The plain send icon, not the steer/queue variant (one submit button, disabled).
    expect(html.match(/<button[^>]*type="submit"/g)?.length).toBe(1);
    expect(html).toContain('disabled=""');
  });

  it('a polled resume WITH a chat row (a server busy-queue exists) says the message queues', () => {
    expect(composerRunAffordance({ ...live, plain: true, chatId: 'c1' })).toEqual({ streaming: false, polled: true, note: RUN_NOTE.polledQueue });
    expect(RUN_NOTE.polledQueue).not.toContain('Stop');
    expect(RUN_NOTE.polledWait).not.toContain('Stop');
  });
});

// ── 2. a live attached stream ────────────────────────────────────────────────

describe('2. live attached stream — Stop + "Stop ends it." render', () => {
  it('plain chat: the queue note, the Stop button, the queue submit title', () => {
    const a = composerRunAffordance({ running: true, plain: true, chatId: 'c1' });
    expect(a).toEqual({ streaming: true, polled: false, note: RUN_NOTE.plainStreaming });
    const html = renderRunComposer(a, { submitTitle: 'Queue message' });
    expect(html).toContain(STOP_TITLE);
    expect(html).toContain('Digby is replying — your message queues and sends next. Stop ends it.');
    expect(html).toContain('title="Queue message"');
  });

  it("an explicit source:'stream' is the same as unset (every connectStream path leaves it unset)", () => {
    expect(composerRunAffordance({ running: true, source: 'stream', plain: true, chatId: 'c1' }).streaming).toBe(true);
    expect(composerRunAffordance({ running: true, source: 'stream', plain: true, chatId: null }).streaming).toBe(true);
  });

  it('coding session: the steer note + Stop while a run streams; the session-status chain when idle', () => {
    const streaming = composerRunAffordance({ running: true, plain: false, chatId: 's1', sessionStatus: 'running' });
    expect(streaming.note).toBe(RUN_NOTE.codeStreaming);
    expect(renderRunComposer(streaming)).toContain(STOP_TITLE);
    expect(composerRunAffordance({ running: false, plain: false, chatId: 's1', sessionStatus: 'running' })).toEqual({ streaming: false, polled: false, note: RUN_NOTE.codeAttaching });
    expect(composerRunAffordance({ running: false, plain: false, chatId: 's1', sessionStatus: 'error' }).note).toBe(RUN_NOTE.codeError);
    expect(composerRunAffordance({ running: false, plain: false, chatId: 's1', sessionStatus: 'provisioning' }).note).toBe(RUN_NOTE.codeProvisioning);
    expect(composerRunAffordance({ running: false, plain: false, chatId: 's1', sessionStatus: 'ready' }).note).toBeNull();
    expect(composerRunAffordance({ running: false, plain: false, chatId: 's1' }).note).toBeNull();
    // A plain chat never shows the coding chain.
    expect(composerRunAffordance({ running: false, plain: true, chatId: 'c1', sessionStatus: 'error' }).note).toBeNull();
  });

  it('the live bubble with a run start renders the clock', () => {
    const html = renderToStaticMarkup(createElement(LiveRunStatus, { status: 'Searching the web', since: NOW - 5_000 }));
    expect(html).toContain('Searching the web');
    expect(html).toContain('tabular-nums');
  });
});

// ── 3. a signed-in restored pending row ──────────────────────────────────────

describe('3. signed-in restored pending row — polled from this tab, no footer, no Stop', () => {
  const full = {
    messages: [
      { id: 'u1', role: 'user', content: 'Q1', createdAt: agoIso(90_000) },
      { id: 'a1', role: 'assistant', content: 'A1', createdAt: agoIso(60_000), metadata: { check: { state: 'checking' } } },
    ],
  };

  it('the restored row keeps its "Checking…" pill for the poll while the composer is the idle one', () => {
    const rows = settleRestoredRows(mapPlainMessages(full), { canPoll: true, now: NOW });
    expect(pendingRowsToPoll(rows).poll.map(r => r.id)).toEqual(['a1']);
    expect(pillFromMeta(rows[1].plainMeta)).toEqual({ kind: 'checking' });
    // The restore path mounts with running:false when nothing attached on load
    // (attachOnLoad is page state a reload does not carry; a live reattach is
    // the separate fetchPlainRunActive → connectStream(attach) branch).
    const a = composerRunAffordance({ running: false, plain: true, chatId: 'c1' });
    expect(a).toEqual({ streaming: false, polled: false, note: null });
    const html = renderRunComposer(a, { submitTitle: 'Send message' });
    expect(html).not.toContain(STOP_TITLE);
    expect(html).not.toContain('data-composer-note');
    expect(html).not.toContain('Still working');
    expect(html).not.toContain('Stop ends it');
    expect(html).toContain('title="Send message"');
  });
});

// ── 4. wiring pins (change detectors — the behaviour is pinned above) ────────

describe('4. CodeSessionView wiring — the composer keys on the seam, only the guest resume marks a poll', () => {
  const VIEW = readFileSync(fileURLToPath(new URL('./components/CodeSessionView.tsx', import.meta.url)), 'utf8');

  it('isStreaming / onStop / footerNote come from composerRunAffordance, not live.running', () => {
    expect(VIEW).toContain('const composerRun = composerRunAffordance({ running: live.running, source: live.source, plain: !!plain, chatId, sessionStatus: activeSession?.status });');
    expect(VIEW).toContain('isStreaming={composerRun.streaming}');
    expect(VIEW).toContain('onStop={composerRun.streaming ? () => void stopRun() : undefined}');
    // 7acaa7ba: memberViewOnly (read-only view of another owner's session) takes
    // the note first; the affordance note renders otherwise — same one-line slot.
    expect(VIEW).toContain('footerNote={');
    expect(VIEW).toContain('memberViewOnly');
    expect(VIEW).toContain('? <p data-composer-note');
    expect(VIEW).not.toContain('isStreaming={live.running}');
    expect(VIEW).not.toContain("footerNote={(() => {");
  });

  it("the guest resume's onWaiting is the ONLY writer of source:'poll' (via guestResumeLiveState)", () => {
    expect(VIEW).toContain('onWaiting: () => { if (alive()) setLive({ parts: [], pendingApproval: null, ...guestResumeLiveState() }); },');
    expect(VIEW).not.toContain("source: 'poll'");
    expect(VIEW.split('...guestResumeLiveState()').length - 1).toBe(1); // one spread call site
    expect(VIEW).not.toContain("source: 'stream'"); // 'stream' is the unset default, never written
  });

  it('the live bubble status row is the LiveRunStatus leaf (the resume line renders through it)', () => {
    expect(VIEW).toContain('<LiveRunStatus stopping={live.stopping} status={live.status} since={runStart} />');
  });
});
