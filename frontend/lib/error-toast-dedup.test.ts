/**
 * Ticket 05303f58 (BUG 2) — the CodeSessionView SSE 'error' handler dedupes
 * toasts by event signature: a terminal error replayed on every reconnect
 * (the reported "cloning failed" toast storm) surfaces ONCE, while a genuinely
 * new failure — even with an identical message — still toasts.
 */

import { describe, expect, it } from 'vitest';
import { errorToastSignature, shouldToastError } from './error-toast-dedup';

const CLONE_FAIL = 'Workspace re-provision failed: Cloning into \'/workspace\'... fatal: unable to connect';

describe('errorToastSignature (05303f58)', () => {
  it('prefers data.seq when the payload carries one', () => {
    expect(errorToastSignature({ seq: 42, message: 'boom' })).toBe('42|boom');
  });

  it('falls back to the SSE lastEventId (backend frames are id: runId:seq)', () => {
    expect(errorToastSignature({ message: 'boom' }, 'run1:7')).toBe('run1:7|boom');
  });

  it('falls back to the bare message when no seq exists (id-less frames)', () => {
    expect(errorToastSignature({ message: 'boom' })).toBe('|boom');
    expect(errorToastSignature(undefined)).toBe('|');
  });

  it('is stable across replays of the same persisted event', () => {
    const live = errorToastSignature({ message: CLONE_FAIL }, 'run1:12');
    const replayed = errorToastSignature({ message: CLONE_FAIL }, 'run1:12');
    expect(replayed).toBe(live);
  });

  it('distinguishes two events that share a message (a retried run failing again)', () => {
    const first = errorToastSignature({ message: CLONE_FAIL }, 'run1:12');
    const retry = errorToastSignature({ message: CLONE_FAIL }, 'run2:3');
    expect(retry).not.toBe(first);
  });
});

describe('shouldToastError (05303f58)', () => {
  it('the first occurrence toasts; exact repeats are skipped', () => {
    const seen = new Set<string>();
    const sig = errorToastSignature({ message: CLONE_FAIL }, 'run1:12');
    expect(shouldToastError(seen, sig)).toBe(true);  // first toast survives
    expect(shouldToastError(seen, sig)).toBe(false); // reconnect replay…
    expect(shouldToastError(seen, sig)).toBe(false); // …and again
    expect(seen.size).toBe(1);
  });

  it('a new failure with the SAME message but a new seq still toasts', () => {
    const seen = new Set<string>();
    expect(shouldToastError(seen, errorToastSignature({ message: CLONE_FAIL }, 'run1:12'))).toBe(true);
    expect(shouldToastError(seen, errorToastSignature({ message: CLONE_FAIL }, 'run2:3'))).toBe(true);
    expect(seen.size).toBe(2);
  });

  it('id-less frames dedupe on the message (the plain-chat / cross-instance path)', () => {
    const seen = new Set<string>();
    expect(shouldToastError(seen, errorToastSignature({ message: 'boom' }))).toBe(true);
    expect(shouldToastError(seen, errorToastSignature({ message: 'boom' }))).toBe(false);
    // …but a DIFFERENT message still surfaces.
    expect(shouldToastError(seen, errorToastSignature({ message: 'different boom' }))).toBe(true);
  });

  it('each seen set is independent (a fresh mount re-toasts)', () => {
    const sig = errorToastSignature({ message: 'boom' }, 'run1:1');
    expect(shouldToastError(new Set(), sig)).toBe(true);
    expect(shouldToastError(new Set(), sig)).toBe(true);
  });
});
