/**
 * Guest resume (owner report 2026-09-26): a guest who reloaded mid-answer came
 * back to a vanished assistant turn. Pins the pure half of the fix
 * (guest-resume.ts): when a reopened transcript is "mid-response", how the
 * session-state read hydrates the missing answer, and how the bounded wait
 * behaves while the run is still live — never a streaming affordance, never a
 * phantom answer.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({ default: { get: vi.fn() } }));

import apiClient from '@/lib/api-client';
import type { CodingMessage } from '@/lib/api/coding';
import {
  GUEST_RESUME_MAX_MS, GUEST_RESUME_POLL_MS, GUEST_RESUME_STATUS,
  fetchGuestSessionState, guestAnswerFromState, guestAnswerRowFromState, guestResumeNeeded, guestResumeRowPick, resumeGuestSession,
  type GuestSessionState,
} from './guest-resume';

const SID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const user = (content: string, id = `u-${content.length}`): CodingMessage => ({ id, role: 'user', content, createdAt: '2026-09-26T20:36:00.000Z' });
const assistant = (content: string, id = `a-${content.length}`): CodingMessage => ({ id, role: 'assistant', content, createdAt: '2026-09-26T20:37:00.000Z' });

const Q1 = 'What is the tallest mountain in Canada and how tall is it?';
const A1 = 'Mount Logan, at 5,959 m, is the tallest mountain in Canada.';
const Q2 = 'And what is the second tallest mountain in Canada?';
const A2 = 'Mount Saint Elias, at 5,489 m.';

describe('guestResumeNeeded — only a transcript that ENDS on a user row is mid-response', () => {
  it('true for [user] and [user, assistant, user]; false for a finished transcript / empty', () => {
    expect(guestResumeNeeded([user(Q1)])).toBe(true);
    expect(guestResumeNeeded([user(Q1), assistant(A1), user(Q2)])).toBe(true);
    expect(guestResumeNeeded([user(Q1), assistant(A1)])).toBe(false);
    expect(guestResumeNeeded([])).toBe(false);
    expect(guestResumeNeeded(undefined)).toBe(false);
  });
});

describe('guestAnswerFromState — the persisted answer for the trailing question', () => {
  it('matches the LAST persisted pair by the user text the server received', () => {
    const state: GuestSessionState = { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1 }] };
    expect(guestAnswerFromState([user(Q1)], state)).toBe(A1);
    // whitespace-insensitive
    expect(guestAnswerFromState([user(`  ${Q1.replace(' ', '\n')} `)], state)).toBe(A1);
  });

  it('a second turn: only the LAST pair answers the trailing question', () => {
    const state: GuestSessionState = { active: false, messages: [
      { role: 'user', content: Q1 }, { role: 'assistant', content: A1 },
      { role: 'user', content: Q2 }, { role: 'assistant', content: A2 },
    ] };
    expect(guestAnswerFromState([user(Q1), assistant(A1), user(Q2)], state)).toBe(A2);
  });

  it('nothing persisted for the trailing question yet ⇒ null (never the PREVIOUS answer)', () => {
    const state: GuestSessionState = { active: true, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1 }] };
    expect(guestAnswerFromState([user(Q1), assistant(A1), user(Q2)], state)).toBeNull();
    expect(guestAnswerFromState([user(Q1)], { active: true, messages: [] })).toBeNull();
    expect(guestAnswerFromState([user(Q1)], null)).toBeNull();
  });

  it('falls back to index alignment when the echo text differs from the sent prompt (display label)', () => {
    const state: GuestSessionState = { active: false, messages: [
      { role: 'user', content: 'Long news follow-up prompt the server received' }, { role: 'assistant', content: A1 },
    ] };
    expect(guestAnswerFromState([user('Short display label')], state)).toBe(A1);
  });

  it('a finished local transcript never hydrates (trailing row is the assistant)', () => {
    const state: GuestSessionState = { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1 }] };
    expect(guestAnswerFromState([user(Q1), assistant(A1)], state)).toBeNull();
  });
});

describe('resumeGuestSession — hydrate, or wait calmly while the run is live', () => {
  const local = [user(Q1)];
  const answered: GuestSessionState = { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1 }] };
  const live: GuestSessionState = { active: true, messages: [] };
  const dead: GuestSessionState = { active: false, messages: [] };
  const noSleep = async () => {};

  it('hydrates immediately when the session already holds the answer — no waiting state', async () => {
    const onWaiting = vi.fn();
    const r = await resumeGuestSession(SID, local, { fetchState: async () => answered, onWaiting, sleep: noSleep });
    expect(r).toEqual({ kind: 'answer', content: A1 });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('run live: fires onWaiting ONCE, polls, and resolves with the answer when it lands', async () => {
    const onWaiting = vi.fn();
    const reads = [live, live, answered];
    const fetchState = vi.fn(async () => reads.shift() ?? answered);
    const r = await resumeGuestSession(SID, local, { fetchState, onWaiting, sleep: noSleep, intervalMs: 1 });
    expect(r).toEqual({ kind: 'answer', content: A1 });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(fetchState).toHaveBeenCalledTimes(3);
  });

  it('run live then gone without an answer ⇒ gone (the user sends again)', async () => {
    const reads = [live, dead];
    const r = await resumeGuestSession(SID, local, { fetchState: async () => reads.shift() ?? dead, sleep: noSleep, intervalMs: 1 });
    expect(r).toEqual({ kind: 'gone' });
  });

  it('no run and no answer ⇒ inactive, without ever entering the waiting state', async () => {
    const onWaiting = vi.fn();
    const r = await resumeGuestSession(SID, local, { fetchState: async () => dead, onWaiting, sleep: noSleep });
    expect(r).toEqual({ kind: 'inactive' });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('endpoint unreadable (kill switch / network) ⇒ unknown — the transcript is left alone', async () => {
    const r = await resumeGuestSession(SID, local, { fetchState: async () => null, sleep: noSleep });
    expect(r).toEqual({ kind: 'unknown' });
  });

  it('transient read failures mid-wait keep waiting within the bound', async () => {
    const reads: Array<GuestSessionState | null> = [live, null, null, answered];
    const r = await resumeGuestSession(SID, local, { fetchState: async () => (reads.length ? reads.shift()! : answered), sleep: noSleep, intervalMs: 1 });
    expect(r).toEqual({ kind: 'answer', content: A1 });
  });

  it('the bound passes with the run still live ⇒ gone', async () => {
    let t = 0;
    const r = await resumeGuestSession(SID, local, {
      fetchState: async () => live, sleep: noSleep, intervalMs: 1, maxMs: 10, now: () => (t += 4),
    });
    expect(r).toEqual({ kind: 'gone' });
  });

  it('the view moving on cancels the loop', async () => {
    let calls = 0;
    const r = await resumeGuestSession(SID, local, {
      fetchState: async () => { calls++; return live; }, sleep: noSleep, intervalMs: 1,
      shouldContinue: () => calls < 2,
    });
    expect(r).toEqual({ kind: 'cancelled' });
  });

  it('defaults: 5 s cadence, 20 min bound, a calm status line (never streaming chrome)', () => {
    expect(GUEST_RESUME_POLL_MS).toBe(5_000);
    expect(GUEST_RESUME_MAX_MS).toBe(20 * 60_000);
    expect(GUEST_RESUME_STATUS).toMatch(/still working/i);
  });
});

describe('fetchGuestSessionState — the open endpoint, never throws', () => {
  it('reads GET /crossmodel/session/:id/state and validates the shape', async () => {
    (apiClient.get as any).mockResolvedValueOnce({ data: { data: { active: true, messages: [{ role: 'user', content: Q1 }] } } });
    const s = await fetchGuestSessionState(SID);
    expect(apiClient.get).toHaveBeenCalledWith(`/crossmodel/session/${SID}/state`);
    expect(s).toEqual({ active: true, messages: [{ role: 'user', content: Q1 }] });
  });

  it('a malformed payload or a rejected request reads null', async () => {
    (apiClient.get as any).mockResolvedValueOnce({ data: { data: { nope: true } } });
    expect(await fetchGuestSessionState(SID)).toBeNull();
    (apiClient.get as any).mockRejectedValueOnce(new Error('404'));
    expect(await fetchGuestSessionState(SID)).toBeNull();
  });
});

// ── audit sse-ui-restore-14 (2026-09-26): the state's chips ride the answer ──

describe('guestAnswerRowFromState / resumeGuestSession — the hydrated answer carries the server chips', () => {
  const localMid: CodingMessage[] = [user(Q1)];
  const signin = [{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }];

  it('the row carries chips when the state message has them and omits the key otherwise (the older toEqual shapes hold)', () => {
    expect(guestAnswerRowFromState(localMid, { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1, chips: signin }] }))
      .toEqual({ content: A1, chips: signin });
    expect(guestAnswerRowFromState(localMid, { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1 }] }))
      .toEqual({ content: A1 });
    expect(guestAnswerFromState(localMid, { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1, chips: signin }] })).toBe(A1);
    // the chips ride the state read verbatim (fetchGuestSessionState passes messages through)
    expect(guestAnswerRowFromState(localMid, { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1, chips: [{ kind: 'bogus' }] }] }))
      .toEqual({ content: A1, chips: [{ kind: 'bogus' }] });
  });

  it('resumeGuestSession returns the chips on the answer result — immediately and after a poll', async () => {
    const withChips: GuestSessionState = { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1, chips: signin }] };
    expect(await resumeGuestSession(SID, localMid, { fetchState: async () => withChips })).toEqual({ kind: 'answer', content: A1, chips: signin });
    let n = 0;
    const later = async (): Promise<GuestSessionState> => (n++ === 0 ? { active: true, messages: [{ role: 'user', content: Q1 }] } : withChips);
    expect(await resumeGuestSession(SID, localMid, { fetchState: later, sleep: async () => {}, intervalMs: 1 })).toEqual({ kind: 'answer', content: A1, chips: signin });
  });
});

// ── review 2026-10-20: a guest REATTACH's complete is resolved, never trusted ──
// The reattach (GET /session/:id/stream) can replay the PREVIOUS turn's run (a
// retained finished run, a just-finished mirror) — the 26th /stream of a window
// 429s, the tab reconnects, and Q1's answer used to be appended as Q2's.

describe('guestResumeRowPick — the row a resolved guest resume appends', () => {
  const streamedRow = (content: string): CodingMessage => ({ ...assistant(content, 'a-stream'), plainMeta: { followUps: ['More?'] } as any });
  const waitingOnQ2: CodingMessage[] = [user(Q1), assistant(A1), user(Q2)];

  it('a replay of the PREVIOUS turn is never this turn\'s answer: the history has none for Q2 ⇒ nothing appended', async () => {
    // History holds only Q1/A1; the reattach streamed A1 again.
    const state: GuestSessionState = { active: false, messages: [{ role: 'user', content: Q1 }, { role: 'assistant', content: A1 }] };
    const r = await resumeGuestSession(SID, waitingOnQ2, { fetchState: async () => state });
    expect(r).toEqual({ kind: 'inactive' });
    expect(guestResumeRowPick(r, streamedRow(A1), waitingOnQ2)).toBeNull();
  });

  it('the history answers the trailing question with the streamed text ⇒ the streamed row (sources / follow-ups kept)', () => {
    const row = streamedRow(`${A2}  `);
    expect(guestResumeRowPick({ kind: 'answer', content: A2 }, row, waitingOnQ2)).toEqual({ use: 'streamed', row });
  });

  it('the history answers with a DIFFERENT text ⇒ the history row (its chips), never the streamed one', () => {
    const chips = [{ kind: 'signin_deeper' }];
    expect(guestResumeRowPick({ kind: 'answer', content: A2, chips }, streamedRow(A1), waitingOnQ2)).toEqual({ use: 'history', content: A2, chips });
    expect(guestResumeRowPick({ kind: 'answer', content: A2 }, streamedRow(''), waitingOnQ2)).toEqual({ use: 'history', content: A2 });
  });

  it('history unreadable ⇒ the streamed row, unless it repeats the answer this tab already shows last', () => {
    const fresh = streamedRow(A2);
    expect(guestResumeRowPick({ kind: 'unknown' }, fresh, waitingOnQ2)).toEqual({ use: 'streamed', row: fresh });
    expect(guestResumeRowPick({ kind: 'unknown' }, streamedRow(A1), waitingOnQ2)).toBeNull();
    expect(guestResumeRowPick({ kind: 'unknown' }, streamedRow('  '), waitingOnQ2)).toBeNull();
  });

  it('no streamed candidate (a reload, an interrupted reattach) ⇒ the history answer or nothing, as before', () => {
    expect(guestResumeRowPick({ kind: 'answer', content: A2, chips: [] }, undefined, waitingOnQ2)).toEqual({ use: 'history', content: A2, chips: [] });
    for (const r of [{ kind: 'unknown' }, { kind: 'inactive' }, { kind: 'gone' }, { kind: 'cancelled' }] as const) {
      expect(guestResumeRowPick(r, undefined, waitingOnQ2)).toBeNull();
      expect(guestResumeRowPick(r.kind === 'unknown' ? { kind: 'inactive' } : r, streamedRow(A2), waitingOnQ2)).toBeNull();
    }
  });
});
