/**
 * Pins for the queued-message CONTROL decisions (ticket ea04454c) and the
 * interrupt GESTURE that replaced the send-mode pill (ticket b54efe5d).
 *
 * The owner's first report: while a run was executing, two messages were typed
 * and silently queued — no affordance to interrupt-and-steer, no queue position,
 * no cancel, no promote. The server controls landed with that fix.
 *
 * The owner's SECOND report (b54efe5d): "poor ui design choice for steer/send
 * now — it should just be a small button to interrupt next to queued text area."
 * The two-word segmented pill is gone: interrupting is one small icon button
 * beside the send circle, shown only while it can do something. These pins stop
 * the pill (or any other sticky send MODE) coming back.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  queuedCaption,
  queueRowActions,
  moveItem,
  withPositions,
  queueRefusalMessage,
  queueFromError,
  refusalCodeFromError,
  showInterruptControl,
  INTERRUPT_AFFORDANCE,
  type QueuedItem,
} from './queue-controls';

describe('showInterruptControl (b54efe5d) — interrupting is a GESTURE, not a mode', () => {
  it('shows beside the send circle exactly when a live run meets a draft', () => {
    expect(showInterruptControl({ streaming: true, hasDraft: true, canInterrupt: true })).toBe(true);
  });

  it('hides on an empty draft — there is nothing to send, and Stop already owns that state', () => {
    // The composer's stopAsPrimary rule: empty draft mid-run = the send circle
    // IS Stop. A second interrupt button there would be a duplicate Stop.
    expect(showInterruptControl({ streaming: true, hasDraft: false, canInterrupt: true })).toBe(false);
  });

  it('hides when no run is live — an idle send needs no interrupt', () => {
    expect(showInterruptControl({ streaming: false, hasDraft: true, canInterrupt: true })).toBe(false);
  });

  it('hides where the host cannot interrupt (guest / chatless / no session row)', () => {
    expect(showInterruptControl({ streaming: true, hasDraft: true, canInterrupt: false })).toBe(false);
  });
});

describe('INTERRUPT_AFFORDANCE (b54efe5d) — icon-only, but never wordless', () => {
  it('names the action for screen readers and explains it in the tooltip', () => {
    for (const surface of ['chat', 'code'] as const) {
      const { label, title } = INTERRUPT_AFFORDANCE[surface];
      // The accessible name must carry the SIDE EFFECT, not just "Send now":
      // beside a submit circle that reads "Queue message" / "Steer the run", a
      // bare "Send now" name would make a voice-control user silently kill
      // their live run.
      expect(label).toContain('Send now');
      expect(label.toLowerCase()).toContain('stop');
      const t = title.toLowerCase();
      expect(t).toContain('send now');
      expect(t).toContain('stop');
      expect(t).toContain('immediately');
    }
  });

  it('promises the real side effect per surface (an answer vs a whole run)', () => {
    expect(INTERRUPT_AFFORDANCE.chat.label).toContain('answer');
    expect(INTERRUPT_AFFORDANCE.code.label).toContain('run');
  });
});

describe('the send-mode pill is GONE (b54efe5d) — no sticky interrupt can be armed', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const COMPOSER = read('../app/crossmodel/components/ChatComposer.tsx');
  const VIEW = read('../app/crossmodel/components/CodeSessionView.tsx');

  it('neither the composer nor its host carries the segmented control or a stored mode', () => {
    // Scoped honestly to the two files that owned the mode. The other
    // <ChatComposer> hosts (page.tsx, SupervisorChatTab.tsx) are covered by the
    // typechecker instead: the props and the SendMode type no longer exist, so
    // any surviving use is a compile error, which is a stronger gate than a
    // substring scan.
    for (const src of [COMPOSER, VIEW]) {
      expect(src).not.toContain('sendMode');
      expect(src).not.toContain('SendMode');
      expect(src).not.toContain('composerSendAction');
      expect(src).not.toContain('SEND_MODE_LABELS');
    }
  });

  it('the composer renders ONE small interrupt button, keyed on the gesture helper', () => {
    expect(COMPOSER).toContain('data-interrupt-send');
    expect(COMPOSER).toContain('showInterruptControl({');
    // Icon-only: a word here would be the pill again.
    expect(COMPOSER).not.toContain('>Send now<');
  });

  // Adversarial review (2026-11-05): deleting the whole feature from the host
  // left 122 tests green. The helper's own pins do not protect the WIRING, so
  // pin the two lines that make pressing the button actually interrupt —
  // without them "Send now" silently degrades to an ordinary queue, which is
  // the exact bug ea04454c existed to fix.
  it('the host WIRES the button to a real interrupt on both surfaces', () => {
    expect(VIEW).toContain(
      '{ onInterrupt: () => { if (plain) void send(undefined, undefined, { interrupt: true }); else void interruptWithMessage(); } }',
    );
  });

  it('a plain-chat interrupt still PROMOTES the row and stops the live run', () => {
    // enqueue → promote → stop. Drop this and the button becomes a plain queue.
    expect(VIEW).toContain('if (opts?.interrupt && pendingId && !plainCfg.guest) {');
    expect(VIEW).toContain('void promoteThenStop(sid, pendingId);');
  });
});

describe('queuedCaption (ea04454c) — a visible queue POSITION, not a bare "Queued"', () => {
  it('shows the 1-based position for a plain chat', () => {
    expect(queuedCaption({ position: 2, coding: false })).toBe('Queued #2 — runs when this turn finishes');
  });

  it('falls back to the position-less caption when the server has not spoken yet', () => {
    expect(queuedCaption({ position: null, coding: false })).toBe('Queued — runs when this turn finishes');
    expect(queuedCaption({ position: 0, coding: false })).toBe('Queued — runs when this turn finishes');
  });

  it('keeps the coding "folds in at its next step" truth (a steer is not a queue turn)', () => {
    expect(queuedCaption({ position: 1, coding: true })).toContain('folds into the run at its next step');
  });

  it('the client-side hold (guest / provisioning) states what it really does', () => {
    expect(queuedCaption({ position: 1, coding: false, held: true })).toBe('Queued — sends when this answer finishes');
  });
});

describe('queueRowActions (ea04454c) — ends disable instead of firing no-ops', () => {
  it('head row cannot move up or promote (it is already next)', () => {
    expect(queueRowActions(0, 3)).toEqual({ up: false, down: true, promote: false });
  });

  it('tail row cannot move down', () => {
    expect(queueRowActions(2, 3)).toEqual({ up: true, down: false, promote: true });
  });

  it('a lone row offers no order controls at all', () => {
    expect(queueRowActions(0, 1)).toEqual({ up: false, down: false, promote: false });
  });

  it('middle rows offer everything', () => {
    expect(queueRowActions(1, 3)).toEqual({ up: true, down: true, promote: true });
  });
});

describe('moveItem / withPositions (ea04454c) — reorder is pure and renumbers', () => {
  const rows = (): QueuedItem[] => [
    { id: 'a', position: 1, content: 'A', createdAt: 't1', attachmentCount: 0 },
    { id: 'b', position: 2, content: 'B', createdAt: 't2', attachmentCount: 0 },
    { id: 'c', position: 3, content: 'C', createdAt: 't3', attachmentCount: 0 },
  ];

  it('moves up and down one slot', () => {
    expect(moveItem(rows(), 'b', 'up').map(r => r.id)).toEqual(['b', 'a', 'c']);
    expect(moveItem(rows(), 'b', 'down').map(r => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('is a no-op at the ends (a double click cannot corrupt the order)', () => {
    expect(moveItem(rows(), 'a', 'up').map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(moveItem(rows(), 'c', 'down').map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('an unknown id returns the same order', () => {
    expect(moveItem(rows(), 'zzz', 'up').map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('never mutates the input array', () => {
    const input = rows();
    const before = input.map(r => r.id);
    moveItem(input, 'a', 'down');
    expect(input.map(r => r.id)).toEqual(before);
  });

  it('renumbers positions so a badge never shows a stale slot', () => {
    const moved = moveItem(rows(), 'c', 'up');
    expect(withPositions(moved).map(r => r.position)).toEqual([1, 2, 3]);
    expect(withPositions(moved).map(r => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('refusal mapping (ea04454c) — failures are named, not swallowed', () => {
  it('maps every server code to actionable human text', () => {
    expect(queueRefusalMessage('QUEUE_NOT_OWNER')).toContain('Only the sender');
    expect(queueRefusalMessage('QUEUE_NOT_USER_ROW')).toContain('machine sender');
    expect(queueRefusalMessage('QUEUE_ITEM_GONE')).toContain('already started or was removed');
    expect(queueRefusalMessage(undefined)).toContain('refreshing');
  });

  /**
   * Every code the backend can actually send must have its OWN message here
   * (ticket ffbf1315). QUEUE_BLOCKED_BY_OTHER was added to the controller
   * (crossmodel.controller.ts, the 'blocked' refusal — another person's waiting
   * row is in the way) but never to this mapper, so that real, actionable
   * refusal fell through to the generic "Could not update the queue —
   * refreshing it now."
   *
   * CAVEAT, stated honestly: this list is a RE-ENCODED literal, not derived
   * from the server — nothing here reads the controller. It pins that each of
   * the four codes currently in the wire protocol maps to a distinct message,
   * so removing a mapping fails. It CANNOT catch a brand-new server code on its
   * own; the durable guard is the backend suite, which fails if the controller
   * adds a refusal without a status/code pair.
   */
  it('has a distinct message for EVERY code the controller can return (ffbf1315)', () => {
    const serverCodes = ['QUEUE_NOT_OWNER', 'QUEUE_NOT_USER_ROW', 'QUEUE_BLOCKED_BY_OTHER', 'QUEUE_ITEM_GONE'];
    const generic = queueRefusalMessage(undefined);
    for (const code of serverCodes) {
      expect(queueRefusalMessage(code)).not.toBe(generic);
    }
    expect(queueRefusalMessage('QUEUE_BLOCKED_BY_OTHER')).toContain('Someone else is waiting');
  });

  it('recovers the FRESH queue from a refusal payload (one hop, no extra GET)', () => {
    const queue = [{ id: 'a', position: 1, content: 'A', createdAt: 't', attachmentCount: 0 }];
    const err = { response: { data: { code: 'QUEUE_ITEM_GONE', data: { queue } } } };
    expect(queueFromError(err)).toEqual(queue);
    expect(refusalCodeFromError(err)).toBe('QUEUE_ITEM_GONE');
  });

  it('returns null when the error carries no queue (caller falls back to a refetch)', () => {
    expect(queueFromError(new Error('network'))).toBeNull();
    expect(refusalCodeFromError(new Error('network'))).toBeUndefined();
  });
});