/**
 * Transcript repair (watch pass #4, 2026-09-08) — providers reject any
 * conversation whose assistant tool_calls turn isn't contiguously answered.
 * Pins the two prod shapes: an interleaved harness notice mid-batch (the
 * first derail-breaker's inline push) and truly-missing trailing results.
 */

import {
  transcriptNeedsRepair,
  repairToolCallTranscript,
  INTERRUPTED_TOOL_RESULT,
} from './transcript-repair';

const asst = (ids: string[]) => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map(id => ({ id, type: 'function', function: { name: id.split(':')[0], arguments: '{}' } })),
});
const tool = (id: string, content = `result ${id}`) => ({ role: 'tool', tool_call_id: id, content });
const user = (content: string) => ({ role: 'user', content });

describe('transcriptNeedsRepair', () => {
  it('healthy transcript: false', () => {
    expect(transcriptNeedsRepair([
      user('do it'), asst(['a:1', 'b:2']), tool('a:1'), tool('b:2'), { role: 'assistant', content: 'done' },
    ])).toBe(false);
  });

  it('a user message interleaved mid-batch (the inline-notice incident shape): true', () => {
    expect(transcriptNeedsRepair([
      asst(['a:1', 'b:2', 'c:3']), tool('a:1'), user('[HARNESS NOTICE]'), tool('b:2'), tool('c:3'),
    ])).toBe(true);
  });

  it('trailing ids with no result anywhere: true', () => {
    expect(transcriptNeedsRepair([asst(['a:1', 'b:2']), tool('a:1')])).toBe(true);
  });

  it('assistant turns without tool_calls never trigger', () => {
    expect(transcriptNeedsRepair([user('q'), { role: 'assistant', content: 'a' }])).toBe(false);
  });
});

describe('repairToolCallTranscript', () => {
  it('healthy transcript returns the SAME reference (no-repair detection)', () => {
    const msgs = [user('do it'), asst(['a:1']), tool('a:1')];
    expect(repairToolCallTranscript(msgs)).toBe(msgs);
  });

  it('pulls drifted results up contiguously and moves the notice after the batch', () => {
    const out = repairToolCallTranscript([
      asst(['a:1', 'b:2', 'c:3']), tool('a:1'), user('[HARNESS NOTICE]'), tool('b:2'), tool('c:3'),
    ]) as any[];
    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'tool', 'user']);
    expect(out.slice(1, 4).map(m => m.tool_call_id)).toEqual(['a:1', 'b:2', 'c:3']);
    expect(out[4].content).toBe('[HARNESS NOTICE]');
  });

  it('synthesizes the interrupted result for ids with no answer anywhere', () => {
    const out = repairToolCallTranscript([asst(['a:1', 'b:2']), tool('a:1'), { role: 'assistant', content: 'next' }]) as any[];
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'b:2', content: INTERRUPTED_TOOL_RESULT });
    expect(out[3].content).toBe('next');
  });

  it('a later assistant turn bounds the search window (results never steal across turns)', () => {
    const out = repairToolCallTranscript([
      asst(['a:1']),                       // unanswered — next turn starts immediately
      asst(['a:1']), tool('a:1'),          // same id, answered, belongs HERE
    ]) as any[];
    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(out[1].content).toBe(INTERRUPTED_TOOL_RESULT);
    expect(out[3].content).toBe('result a:1');
  });

  it('the full prod shape: 8-call derailment batch, notice after call 18, ids 19+ scrambled behind it', () => {
    const ids = ['x:18', 'a:19', 'b:20', 'c:21', 'd:22'];
    const out = repairToolCallTranscript([
      asst(ids), tool('x:18'), user('[HARNESS NOTICE — derail]'), tool('a:19'), tool('b:20'), tool('c:21'), tool('d:22'),
    ]) as any[];
    expect(transcriptNeedsRepair(out)).toBe(false);
    expect(out.slice(1, 6).map(m => m.tool_call_id)).toEqual(ids);
    expect(out[6].role).toBe('user');
  });
});
