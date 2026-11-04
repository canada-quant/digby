/**
 * Stream-drop beacons (2026-10-20, owner: "why does connection drop?").
 *
 * The live answer's EventSource can die mid-run (a phone that locks, a laptop
 * that sleeps, a Wi-Fi hand-off, a deploy cutting the box) and nothing measured
 * it: the view reconnected (or told a guest to resend) silently. This tracker
 * turns one drop → recovery cycle into AT MOST two ux beacons:
 *
 *   - `stream_drop`   — the first error of an episode: { attempts (so far),
 *     ms = since the send, guest, outcome: 'retrying' (a reconnect is armed) |
 *     'resend' (no reconnect exists — the old guest dead end) }.
 *   - `stream_resume` — the episode's end: outcome 'resumed' (a reattach
 *     delivered frames again) | 'ended' (the run had finished — the answer was
 *     read from the server) | 'gone' (it never landed) | 'unknown'.
 *
 * One drop beacon per episode however many retries it takes, and at most
 * STREAM_BEACON_PAGE_CAP beacons per page lifetime — a tab flapping all
 * afternoon sends a bounded count (the server throttles too: the beacon route
 * is public). Never throws. NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED=1 ⇒ nothing
 * is sent (the pre-2026-10-20 behaviour).
 */

import { sendUxBeacon, type UxBeaconPayload } from './ux-beacon';

export function streamDropBeaconDisabled(): boolean {
  return process.env.NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED === '1';
}

/** Beacons per page lifetime (drop + resume together). */
export const STREAM_BEACON_PAGE_CAP = 30;

export type StreamDropOutcome = 'retrying' | 'resend';
export type StreamResumeOutcome = 'resumed' | 'ended' | 'gone' | 'unknown';

export interface StreamDropContext {
  chatId?: string | null;
  /** guest sessions: the client-minted session uuid */
  sessionId?: string | null;
  guest: boolean;
  mode?: string;
  /** reconnect attempts so far */
  attempts: number;
  /** ms since the send that started the run (undefined when this tab did not start it) */
  msSinceSend?: number;
}

export interface StreamDropTracker {
  /** The first drop of an episode sends `stream_drop`; later drops of the same episode send nothing. */
  drop(ctx: StreamDropContext, outcome: StreamDropOutcome): boolean;
  /** Closes an OPEN episode with `stream_resume`; a no-op when none is open. */
  resume(ctx: StreamDropContext, outcome: StreamResumeOutcome): boolean;
  /** A new send / a chat switch: forget an open episode without a beacon. */
  reset(): void;
  readonly episodeOpen: boolean;
}

export function createStreamDropTracker(deps: {
  send?: (p: UxBeaconPayload) => boolean;
  disabled?: () => boolean;
  cap?: number;
} = {}): StreamDropTracker {
  const send = deps.send ?? ((p: UxBeaconPayload) => sendUxBeacon(p));
  const disabled = deps.disabled ?? streamDropBeaconDisabled;
  const cap = deps.cap ?? STREAM_BEACON_PAGE_CAP;
  let open = false;
  let sent = 0;
  const emit = (event: 'stream_drop' | 'stream_resume', ctx: StreamDropContext, outcome: string): boolean => {
    try {
      if (disabled() || sent >= cap) return false;
      sent++;
      return send({
        event,
        ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.mode ? { mode: ctx.mode } : {}),
        ...(typeof ctx.msSinceSend === 'number' ? { ms: ctx.msSinceSend } : {}),
        attempts: ctx.attempts,
        guest: ctx.guest,
        outcome,
      });
    } catch {
      return false;
    }
  };
  return {
    drop(ctx, outcome) {
      if (open) return false;
      open = true;
      return emit('stream_drop', ctx, outcome);
    },
    resume(ctx, outcome) {
      if (!open) return false;
      open = false;
      return emit('stream_resume', ctx, outcome);
    },
    reset() { open = false; },
    get episodeOpen() { return open; },
  };
}
