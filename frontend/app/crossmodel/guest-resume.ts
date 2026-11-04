/**
 * Guest resume (owner report 2026-09-26): a guest who reloaded mid-answer came
 * back to a chat with the assistant turn GONE — the run kept going server-side,
 * but a guest chat lives in localStorage (guest-sessions.ts) plus the 24h Redis
 * `cm_session:<id>` history the run appends to at finalize, and the assistant
 * message was only ever appended from the stream in the tab that was open.
 *
 * This is the pure, unit-testable half of the fix. On a reopened guest session
 * whose transcript ENDS on a user row ("mid-response"), CodeSessionView asks
 * `GET /api/crossmodel/session/:id/state` ({ active, messages }) and:
 *   - hydrates the answer the tab never received when the session history
 *     already holds it;
 *   - otherwise, while the run is still live (`active`), shows ONE calm
 *     "still working — this will update" state and polls until the answer
 *     lands or the run stops — NEVER the streaming chrome (no live parts,
 *     no timer, no status trail: nothing is attached in this tab);
 *   - otherwise leaves the transcript alone (the run died before persisting —
 *     the user simply sends again).
 *
 * The complete transcript case (last row is an assistant row) never reaches
 * this module: a restored finished chat is rendered exactly as before.
 * (The server's GUEST_SESSION_RESUME_DISABLED kill switch, which 404'd the endpoint, was deleted in
 * build 2026-10-08 S-2; a 404 is still treated as "unknown" and the client stops.)
 */

import apiClient from '@/lib/api-client';
import type { CodingMessage } from '@/lib/api/coding';

export interface GuestSessionState {
  /** A run for this session is live somewhere (either blue/green instance). */
  active: boolean;
  /** The server-side history — user/assistant pairs the runs persisted. The
   *  endpoint attaches the guest's depth chip (`signin_deeper`) to its LAST
   *  assistant message (2026-09-26, audit sse-ui-restore-14) so a hydrated
   *  answer carries the same control the streaming tab showed. */
  messages: Array<{ role: 'user' | 'assistant'; content: string; chips?: unknown }>;
}

/** Poll cadence / bound while the run is live: the longest guest run is a
 *  bounded Ensemble turn (lead deadline 360 s + a 75 s checker), so 20 min
 *  covers every honest case with margin; past it the run is treated as gone. */
export const GUEST_RESUME_POLL_MS = 5_000;
export const GUEST_RESUME_MAX_MS = 20 * 60_000;

/** The calm status the view shows while polling — never the streaming chrome. */
export const GUEST_RESUME_STATUS = 'Still working on this — the answer will appear here when it’s done';

/** The view's live-run slice while the resume polls (spread over the rest):
 *  a run is live somewhere, NOTHING is attached in this tab — `source:'poll'`
 *  keys the composer off the streaming chrome (depth-ux-seams.ts
 *  composerRunAffordance: no Stop, no "Stop ends it.", no queue variant).
 *  Owner, prod 2026-09-27: the reopened chat showed the calm line AND the
 *  red Stop — Stop had nothing to stop (the resume is a 5 s poll). */
export function guestResumeLiveState(): { running: true; source: 'poll'; status: string } {
  return { running: true, source: 'poll', status: GUEST_RESUME_STATUS };
}

export type GuestResumeResult =
  /** `chips`: the state's chips for that answer, present only when the server sent any. */
  | { kind: 'answer'; content: string; chips?: unknown }
  /** The run is (or was) live but no answer landed within the bound. */
  | { kind: 'gone' }
  /** No run is live and the session holds no answer for the trailing question. */
  | { kind: 'inactive' }
  /** The endpoint could not be read (network, kill switch) — leave the transcript alone. */
  | { kind: 'unknown' }
  | { kind: 'cancelled' };

/** A reopened transcript is "mid-response" when its LAST row is a user row. */
export function guestResumeNeeded(messages: CodingMessage[] | undefined | null): boolean {
  if (!messages || !messages.length) return false;
  return messages[messages.length - 1].role === 'user';
}

const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);

/**
 * The answer the session history holds for the transcript's TRAILING user row,
 * or null. Primary match: the LAST persisted pair's user text equals the local
 * trailing user text (the echo is the message the server received). Fallback:
 * index alignment — the N-th persisted pair answers the N-th local user row
 * (an echo rendered with a display label differs from the sent prompt). Both
 * miss ⇒ null (nothing persisted yet, or the history was capped past it).
 */
export function guestAnswerFromState(local: CodingMessage[], state: GuestSessionState | null | undefined): string | null {
  return guestAnswerRowFromState(local, state)?.content ?? null;
}

/** The answer AND the chips the state carried for it (the row the view appends). */
export function guestAnswerRowFromState(local: CodingMessage[], state: GuestSessionState | null | undefined): { content: string; chips?: unknown } | null {
  if (!state || !Array.isArray(state.messages) || !local.length) return null;
  const trailing = local[local.length - 1];
  if (trailing.role !== 'user') return null;
  const msgs = state.messages;
  const pick = (m: { content: string; chips?: unknown }) => ({ content: String(m.content), ...(m.chips !== undefined ? { chips: m.chips } : {}) });
  // Primary: the last persisted pair.
  for (let i = msgs.length - 1; i >= 1; i--) {
    if (msgs[i].role !== 'assistant' || msgs[i - 1].role !== 'user') continue;
    if (norm(msgs[i - 1].content) === norm(trailing.content) && norm(msgs[i].content)) return pick(msgs[i]);
    break; // only the LAST pair can answer the trailing question
  }
  // Fallback: index alignment on user rows.
  const localUserCount = local.filter((m) => m.role === 'user').length;
  let seen = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue;
    seen++;
    if (seen === localUserCount) {
      const next = msgs[i + 1];
      return next && next.role === 'assistant' && norm(next.content) ? pick(next) : null;
    }
  }
  return null;
}

const normFull = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

/** What the view appends once a resume resolves: the reattach's own streamed row, the history's row, or nothing. */
export type GuestResumeRowPick =
  | { use: 'streamed'; row: CodingMessage }
  | { use: 'history'; content: string; chips?: unknown }
  | null;

/**
 * The row to append when a guest resume resolves (review 2026-10-20). A guest
 * REATTACH (GET /session/:id/stream) can replay the PREVIOUS turn's run — a
 * retained finished run, a just-finished mirror — and nothing in the stream
 * says which question it answered, so its complete is never appended as is:
 *   - the history answers the trailing question ⇒ that answer; the reattach's
 *     own streamed row (sources / follow-ups) only when it IS that text;
 *   - the history could not be read (`unknown`) ⇒ the streamed row, unless it
 *     repeats the answer this tab already shows last (the previous turn's
 *     replay);
 *   - otherwise (inactive / gone / cancelled) ⇒ nothing — the caller says so.
 * Without a streamed candidate (a reload, an interrupted reattach) this is the
 * history answer or nothing, exactly as before.
 */
export function guestResumeRowPick(r: GuestResumeResult, streamed: CodingMessage | null | undefined, local: CodingMessage[]): GuestResumeRowPick {
  const streamedText = streamed ? normFull(streamed.content) : '';
  if (r.kind === 'answer') {
    if (streamed && streamedText && streamedText === normFull(r.content)) return { use: 'streamed', row: streamed };
    return { use: 'history', content: r.content, ...(r.chips !== undefined ? { chips: r.chips } : {}) };
  }
  if (r.kind === 'unknown' && streamed && streamedText) {
    let lastAnswer: CodingMessage | undefined;
    for (let i = local.length - 1; i >= 0; i--) if (local[i].role === 'assistant') { lastAnswer = local[i]; break; }
    if (lastAnswer && normFull(lastAnswer.content) === streamedText) return null;
    return { use: 'streamed', row: streamed };
  }
  return null;
}

/** GET the session state; null on any failure (never throws). */
export async function fetchGuestSessionState(sessionId: string): Promise<GuestSessionState | null> {
  try {
    const r = await apiClient.get(`/crossmodel/session/${encodeURIComponent(sessionId)}/state`);
    const d = r?.data?.data;
    if (!d || typeof d.active !== 'boolean' || !Array.isArray(d.messages)) return null;
    return { active: d.active, messages: d.messages };
  } catch {
    return null;
  }
}

export interface GuestResumeDeps {
  fetchState: (sessionId: string) => Promise<GuestSessionState | null>;
  /** False once the view moved on (another session opened / unmounted). */
  shouldContinue?: () => boolean;
  /** Fired ONCE when the first read says the run is still live — the view
   *  switches to the calm "still working" state here, never before. */
  onWaiting?: () => void;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  maxMs?: number;
  now?: () => number;
}

/**
 * Resolve a reopened mid-response guest session: hydrate the answer when the
 * history holds it; while the run is live, wait (bounded) for it to land.
 */
export async function resumeGuestSession(
  sessionId: string,
  local: CodingMessage[],
  deps: GuestResumeDeps,
): Promise<GuestResumeResult> {
  const interval = deps.intervalMs ?? GUEST_RESUME_POLL_MS;
  const maxMs = deps.maxMs ?? GUEST_RESUME_MAX_MS;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cont = () => (deps.shouldContinue ? deps.shouldContinue() : true);

  let state = await deps.fetchState(sessionId);
  if (!cont()) return { kind: 'cancelled' };
  if (!state) return { kind: 'unknown' };
  const first = guestAnswerRowFromState(local, state);
  if (first) return { kind: 'answer', ...first };
  if (!state.active) return { kind: 'inactive' };

  deps.onWaiting?.();
  const started = now();
  while (now() - started < maxMs) {
    await sleep(interval);
    if (!cont()) return { kind: 'cancelled' };
    state = await deps.fetchState(sessionId);
    if (!cont()) return { kind: 'cancelled' };
    if (!state) continue; // transient read failure — keep waiting within the bound
    const answer = guestAnswerRowFromState(local, state);
    if (answer) return { kind: 'answer', ...answer };
    // The run ended without persisting an answer for this question (cancelled /
    // failed) — stop waiting; the user can send again.
    if (!state.active) return { kind: 'gone' };
  }
  return { kind: 'gone' };
}
