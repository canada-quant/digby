/**
 * Thinking stays on the server (owner 2026-10-04): the wire filter + the live-run choke point.
 */
import { isReasoningEvent, withholdFromClient, hideReasoningDisabled } from './reasoning-wire';
import { startLiveRun, pushRunEvent, subscribeRun, endLiveRun, setRunEventTap, RunEvent } from './live-runs';

describe('reasoning-wire', () => {
  it('names every event that carries model reasoning', () => {
    expect(isReasoningEvent('reasoning', { delta: 'x' })).toBe(true);
    expect(isReasoningEvent('subagent:reasoning', { delta: 'x' })).toBe(true);
    expect(isReasoningEvent('thinking-summary', { summary: 'Digby: x' })).toBe(true);
    expect(isReasoningEvent('agent-activity', { kind: 'reasoning', delta: 'x' })).toBe(true);
    // everything else is not reasoning
    expect(isReasoningEvent('agent-activity', { kind: 'tool', name: 'search_engine' })).toBe(false);
    expect(isReasoningEvent('text', { delta: 'x' })).toBe(false);
    expect(isReasoningEvent('progress', { message: 'Digby is thinking it through…' })).toBe(false);
    expect(isReasoningEvent('agent-activity', null)).toBe(false);
  });

  it('withholds reasoning by default; HIDE_REASONING_DISABLED=1 lets it through', () => {
    expect(hideReasoningDisabled({})).toBe(false);
    expect(withholdFromClient('reasoning', {}, {})).toBe(true);
    expect(withholdFromClient('reasoning', {}, { HIDE_REASONING_DISABLED: '1' })).toBe(false);
    expect(withholdFromClient('text', {}, {})).toBe(false);
  });

  it('pushRunEvent never buffers, fans out or taps a reasoning event', () => {
    startLiveRun('rw1');
    const seen: RunEvent[] = [];
    const tapped: RunEvent[] = [];
    setRunEventTap('rw1', (e) => tapped.push(e));
    subscribeRun('rw1', (e) => seen.push(e));
    pushRunEvent('rw1', 'reasoning', { delta: 'secret' });
    pushRunEvent('rw1', 'agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'secret' });
    pushRunEvent('rw1', 'thinking-summary', { summary: 'Digby: secret' });
    pushRunEvent('rw1', 'progress', { message: 'Digby is thinking it through…' });
    expect(seen.map((e) => e.type)).toEqual(['progress']);
    expect(tapped.map((e) => e.type)).toEqual(['progress']);
    // a late subscriber's replay holds no reasoning either
    const replay: RunEvent[] = [];
    subscribeRun('rw1', (e) => replay.push(e));
    expect(replay.map((e) => e.type)).toEqual(['progress']);
    endLiveRun('rw1');
  });

  it('HIDE_REASONING_DISABLED=1 restores the reasoning stream', () => {
    process.env.HIDE_REASONING_DISABLED = '1';
    try {
      startLiveRun('rw2');
      const seen: RunEvent[] = [];
      subscribeRun('rw2', (e) => seen.push(e));
      pushRunEvent('rw2', 'reasoning', { delta: 'x' });
      expect(seen.map((e) => e.type)).toEqual(['reasoning']);
      endLiveRun('rw2');
    } finally { delete process.env.HIDE_REASONING_DISABLED; }
  });
});
