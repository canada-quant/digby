/**
 * interleaveSteers pins (owner report 2026-09-09): steers sent during a
 * coding run render INSIDE that run's timeline after the run completes —
 * not stacked under the final answer.
 */

import { describe, expect, it } from 'vitest';
import { interleaveSteers, STEER_SEGMENT_ID_RE } from './steer-interleave';

type Part = { type: string; text?: string; ts?: string };
type Row = { id: string; role: string; createdAt: string; content: string; parts?: Part[] };
const t = (s: number) => new Date(Date.UTC(2026, 8, 9, 12, 0, s)).toISOString();
const part = (type: string, sec: number | null, text = ''): Part => ({ type, text, ...(sec === null ? {} : { ts: t(sec) }) });

// The captured shape: one assistant row spanning the run (createdAt = run
// start), three steers sent mid-run, persisted at send time.
const RUN: Row = {
  id: 'a1', role: 'assistant', createdAt: t(0), content: 'FINAL ANSWER',
  parts: [part('tool_call', 5, 'read repo'), part('tool_result', 8), part('text', 40, 'Where should the kernel work exist? …'), part('text', 60, 'FINAL ANSWER')],
};
const Q1: Row = { id: 'u1', role: 'user', createdAt: t(10), content: 'where is our dspark2 drafter progress?' };
const Q2: Row = { id: 'u2', role: 'user', createdAt: t(20), content: 'sorry i mean give the info to the glm53 agent' };
const Q3: Row = { id: 'u3', role: 'user', createdAt: t(50), content: 'wait so is our own custom drafter done?' };
const NEXT: Row = { id: 'u4', role: 'user', createdAt: t(90), content: 'a new turn after the run' };

describe('interleaveSteers', () => {
  it('splits the run at each steer so the transcript reads work → question → work → answer', () => {
    const out = interleaveSteers([RUN, Q1, Q2, Q3, NEXT]);
    expect(out.map(m => m.id)).toEqual(['a1::s1', 'u1', 'u2', 'a1::s2', 'u3', 'a1', 'u4']);
    // Segment 1: the two tool parts before Q1; nothing between Q1 and Q2 (no empty segment).
    expect(out[0].parts!.map(p => p.type)).toEqual(['tool_call', 'tool_result']);
    expect(out[0].content).toBe('');
    expect(out[0].createdAt).toBe(t(5));
    // Segment 2: the text at 40s sits between Q2 (20s) and Q3 (50s).
    expect(out[3].parts!.map(p => p.text)).toEqual(['Where should the kernel work exist? …']);
    // The final segment keeps the ORIGINAL id + the final text.
    expect(out[5].id).toBe('a1');
    expect(out[5].content).toBe('FINAL ANSWER');
    expect(out[5].parts!.map(p => p.text)).toEqual(['FINAL ANSWER']);
    expect(out[5].createdAt).toBe(t(60));
    // The post-run turn is untouched.
    expect(out[6]).toBe(NEXT);
  });

  it('a user row after the run\'s last part is the NEXT turn, never spliced in', () => {
    const rows: Row[] = [RUN, NEXT];
    const out = interleaveSteers(rows);
    expect(out).toBe(rows);
    expect(out.map(m => m.id)).toEqual(['a1', 'u4']);
  });

  it('identity-preserving when nothing splits (legacy rows without ts, plain turns)', () => {
    const legacy: Row = { ...RUN, parts: [part('text', null, 'old row')] };
    const rows: Row[] = [legacy, Q1, NEXT];
    expect(interleaveSteers(rows)).toBe(rows);
    const noSteer: Row[] = [RUN, NEXT];
    expect(interleaveSteers(noSteer)).toBe(noSteer);
    const empty: Row[] = [];
    expect(interleaveSteers(empty)).toBe(empty);
  });

  it('unstamped parts ride with their stamped predecessor; trailing unstamped parts stay with the later segment', () => {
    const run: Row = { ...RUN, parts: [part('tool_call', 5), part('reasoning', null, 'thinking…'), part('text', 60, 'answer')] };
    const out = interleaveSteers([run, Q1]);
    // The unstamped reasoning part after the 5s tool call follows the 60s text (it ran after Q1 — no stamp to prove otherwise, so it stays with the later segment).
    expect(out.map(m => m.id)).toEqual(['a1::s1', 'u1', 'a1']);
    expect(out[0].parts!.map(p => p.type)).toEqual(['tool_call']);
    expect(out[2].parts!.map(p => p.type)).toEqual(['reasoning', 'text']);
  });

  it('a steer sent before the first stamped part renders first, then the whole run (no empty leading segment)', () => {
    const early: Row = { id: 'u0', role: 'user', createdAt: t(2), content: 'quick — also check X' };
    const out = interleaveSteers([RUN, early]);
    expect(out.map(m => m.id)).toEqual(['u0', 'a1']);
    expect(out[1].parts).toHaveLength(4);
  });

  it('segment ids are recognisable and never collide with real rows', () => {
    const out = interleaveSteers([RUN, Q1]);
    expect(STEER_SEGMENT_ID_RE.test(out[0].id)).toBe(true);
    expect(STEER_SEGMENT_ID_RE.test('a1')).toBe(false);
    expect(new Set(out.map(m => m.id)).size).toBe(out.length);
  });
});
