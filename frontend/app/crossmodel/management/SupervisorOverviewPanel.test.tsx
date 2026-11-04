/**
 * Status-card honesty tests (F3 — owner incident 2026-09-04, supervisor chat
 * c0e22e36: the card said "Idle — waiting for your next message" for 12
 * minutes while the owner's typed question sat in the pending queue).
 *
 * renderToStaticMarkup on the real component (the repo's node-environment
 * vitest idiom — no jsdom, effects never run, so the panel's own polls never
 * fire and the props-driven Status card is what renders). Pins the three
 * shapes: idle / queued-idle / busy-with-queued — plus the deploy-skew
 * default (old backends omit queuedUserCount) and the machine-only queue.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SupervisorOverviewPanel } from './SupervisorOverviewPanel';

const render = (props: { running: boolean; queuedCount: number; queuedUserCount?: number }) =>
  renderToStaticMarkup(createElement(SupervisorOverviewPanel, { onGoLogs: () => {}, ...props }));

describe('SupervisorOverviewPanel — Status card (F3 honest queued status)', () => {
  it('truly idle (nothing queued) → Idle badge + "Waiting for your next message."', () => {
    const html = render({ running: false, queuedCount: 0, queuedUserCount: 0 });
    expect(html).toContain('Idle');
    expect(html).toContain('Waiting for your next message.');
    expect(html).not.toContain('Queued<');
    expect(html).not.toContain('Answering your message');
  });

  it('idle-with-YOUR-message-queued → Queued badge (never Idle) + the answering-next copy', () => {
    const html = render({ running: false, queuedCount: 2, queuedUserCount: 1 });
    expect(html).not.toContain('>Idle<');
    expect(html).toContain('>Queued<');
    expect(html).toContain('Answering your message as soon as the current check finishes — 1 queued.');
    expect(html).not.toContain('Waiting for your next message.');
    expect(html).toContain('2 queued'); // the total-depth badge stays
  });

  it('busy-running with YOUR message queued → Running badge + honest behind-the-run copy', () => {
    const html = render({ running: true, queuedCount: 3, queuedUserCount: 2 });
    expect(html).toContain('>Running<');
    expect(html).toContain('Working — your message is queued behind the current run.');
    expect(html).not.toContain('Waiting for your next message.');
  });

  it('busy-running with nothing of yours queued keeps the plain working copy', () => {
    const html = render({ running: true, queuedCount: 0, queuedUserCount: 0 });
    expect(html).toContain('Working on a turn right now — watch it live in the chat.');
  });

  it('MACHINE-only queue while idle stays Idle (honest: nothing of the user\'s waits) but keeps the depth badge', () => {
    const html = render({ running: false, queuedCount: 3, queuedUserCount: 0 });
    expect(html).toContain('>Idle<');
    expect(html).toContain('3 queued');
    expect(html).toContain('Waiting for your next message.');
  });

  it('deploy skew: an old backend omitting queuedUserCount degrades to today\'s behavior (default 0)', () => {
    const html = render({ running: false, queuedCount: 1 });
    expect(html).toContain('>Idle<');
    expect(html).toContain('Waiting for your next message.');
  });
});
