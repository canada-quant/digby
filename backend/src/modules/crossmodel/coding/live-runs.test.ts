/**
 * Tests for the live-run registry (reattach support): buffer + replay + fan-out,
 * active-flag lifecycle, and post-finish replay within the retention window.
 */

import {
  isRunActive, runExists, startLiveRun, pushRunEvent, subscribeRun, endLiveRun, cancelRun, isRunCancelled, runStartedAt, RunEvent,
  setRunEventTap, primeRunSeq, markRunShutdownInterrupted, isRunShutdownInterrupted,
  bindLiveRun, tryStartLiveRun, noteRunProgress, runLastProgressAt,
} from './live-runs';

describe('live-runs registry', () => {
  it('pushRunEvent stamps every event with a server ISO wall-clock (2026-09-08 — replayed parts show when they happened)', () => {
    startLiveRun('ts1');
    const seen: RunEvent[] = [];
    subscribeRun('ts1', (e) => seen.push(e));
    pushRunEvent('ts1', 'text', { delta: 'x' });
    expect(seen).toHaveLength(1);
    expect(typeof seen[0].ts).toBe('string');
    expect(Number.isNaN(new Date(seen[0].ts as string).getTime())).toBe(false);
    endLiveRun('ts1');
  });

  test('unknown session is inactive and cannot be subscribed', () => {
    expect(isRunActive('nope')).toBe(false);
    expect(subscribeRun('nope', () => {})).toBeNull();
  });

  test('buffers events and replays them to a late subscriber', () => {
    startLiveRun('s1');
    expect(isRunActive('s1')).toBe(true);
    pushRunEvent('s1', 'init', { model: 'glm-5.2' });
    pushRunEvent('s1', 'text', { delta: 'hello' });

    const seen: RunEvent[] = [];
    const unsub = subscribeRun('s1', e => seen.push(e));
    expect(unsub).not.toBeNull();
    // replayed the buffer in order
    expect(seen.map(e => e.type)).toEqual(['init', 'text']);

    // new events fan out live to the subscriber
    pushRunEvent('s1', 'text', { delta: ' world' });
    expect(seen.map(e => e.type)).toEqual(['init', 'text', 'text']);

    unsub!();
    pushRunEvent('s1', 'text', { delta: '!' }); // no longer delivered
    expect(seen).toHaveLength(3);
    endLiveRun('s1');
  });

  test('end marks the run done; a late subscriber still replays incl. terminal', () => {
    startLiveRun('s2');
    pushRunEvent('s2', 'init', {});
    pushRunEvent('s2', 'complete', { finalText: 'done' });
    endLiveRun('s2');
    expect(isRunActive('s2')).toBe(false);

    const seen: RunEvent[] = [];
    const unsub = subscribeRun('s2', e => seen.push(e)); // within retention window
    expect(unsub).not.toBeNull(); // returns a no-op unsub, not null
    expect(seen.map(e => e.type)).toEqual(['init', 'complete']);
  });

  test('cancel flag is set per run and cleared by a fresh start', () => {
    expect(isRunCancelled('c1')).toBe(false); // unknown session
    startLiveRun('c1');
    expect(isRunCancelled('c1')).toBe(false);
    cancelRun('c1');
    expect(isRunCancelled('c1')).toBe(true);
    startLiveRun('c1'); // a new run starts uncancelled
    expect(isRunCancelled('c1')).toBe(false);
    endLiveRun('c1');
  });

  test('starting a run replaces any prior buffer for the same session', () => {
    startLiveRun('s3');
    pushRunEvent('s3', 'text', { delta: 'old' });
    startLiveRun('s3'); // fresh slot
    const seen: RunEvent[] = [];
    subscribeRun('s3', e => seen.push(e));
    expect(seen).toHaveLength(0); // old buffer gone
    endLiveRun('s3');
  });

  test('runExists covers active AND just-finished (retained) runs; runStartedAt reports start', () => {
    expect(runExists('r1')).toBe(false);
    startLiveRun('r1');
    expect(runExists('r1')).toBe(true);
    expect(typeof runStartedAt('r1')).toBe('number');
    endLiveRun('r1');
    // still retained (done, not evicted) → attach can replay the terminal event
    expect(isRunActive('r1')).toBe(false);
    expect(runExists('r1')).toBe(true);
    expect(runStartedAt('nope')).toBeNull();
  });

  test('ring buffer drops the OLDEST events (keeps recency + the terminal), and flags truncation', () => {
    startLiveRun('ring');
    // Push well past the 20k cap; a distinctive first event must be evicted.
    pushRunEvent('ring', 'init', { first: true });
    for (let i = 0; i < 20_100; i++) pushRunEvent('ring', 'text', { i });
    pushRunEvent('ring', 'complete', { finalText: 'done' });

    const seen: RunEvent[] = [];
    subscribeRun('ring', e => seen.push(e));
    // A truncation notice is emitted first…
    expect(seen[0]).toMatchObject({ type: 'progress', data: { stage: 'truncated' } });
    // …the evicted 'init' is gone…
    expect(seen.some(e => e.type === 'init')).toBe(false);
    // …but the terminal 'complete' (pushed last) survived.
    expect(seen[seen.length - 1]).toMatchObject({ type: 'complete' });
    endLiveRun('ring');
  });
});

describe('steer queue', () => {
  const { pushSteer, drainSteer } = jest.requireActual('./live-runs');
  test('pushSteer only works on an active run; drain returns and clears', () => {
    expect(pushSteer('steer-none', 'hi')).toBe(false); // no run
    startLiveRun('steer-1');
    expect(pushSteer('steer-1', '  add dark mode ')).toBe(true);
    expect(pushSteer('steer-1', 'and a footer')).toBe(true);
    expect(pushSteer('steer-1', '   ')).toBe(false); // empty ignored
    const drained = drainSteer('steer-1');
    expect(drained).toEqual({ text: 'add dark mode\n\nand a footer', images: [] }); // trimmed + joined
    expect(drainSteer('steer-1')).toBeNull(); // cleared after drain
    endLiveRun('steer-1');
  });
  test('steer carries images; combined images cap at MAX_IMAGES with a note', () => {
    const img = (name: string) => ({ mediaType: 'image/png', data: 'aGVsbG8=', name });
    startLiveRun('steer-3');
    expect(pushSteer('steer-3', '', [img('a.png')])).toBe(true); // image-only steer allowed
    expect(pushSteer('steer-3', 'more', [img('b.png'), img('c.png'), img('d.png'), img('e.png')])).toBe(true);
    const drained = drainSteer('steer-3');
    expect(drained?.images).toHaveLength(4); // 5 pushed → capped at MAX_IMAGES
    expect(drained?.text).toContain('more');
    expect(drained?.text).toContain('1 attached image(s) dropped');
    endLiveRun('steer-3');
  });
  test('a finished run cannot be steered', () => {
    startLiveRun('steer-2');
    endLiveRun('steer-2');
    expect(pushSteer('steer-2', 'too late')).toBe(false);
  });
});

describe('P4 unified chat run keys', () => {
  const { chatRunKeys, findLiveRunKey } = jest.requireActual('./live-runs') as typeof import('./live-runs');

  test('chatRunKeys covers both pipeline forms: chat-agent then coding (bare chatId)', () => {
    expect(chatRunKeys('abc')).toEqual(['chat:abc', 'abc']);
  });

  test('findLiveRunKey resolves a chat-agent run (chat: form)', () => {
    expect(findLiveRunKey('k1')).toBeNull(); // nothing registered
    startLiveRun('chat:k1');
    expect(findLiveRunKey('k1')).toBe('chat:k1');
    endLiveRun('chat:k1');
  });

  test('findLiveRunKey resolves a coding run (bare chatId form)', () => {
    startLiveRun('k2');
    expect(findLiveRunKey('k2')).toBe('k2');
    endLiveRun('k2');
  });

  test('an active run beats a retained finished one; a retained run still resolves', () => {
    // finished-but-retained coding run + active chat run → the ACTIVE key wins
    startLiveRun('k3');
    endLiveRun('k3'); // retained in the eviction window
    startLiveRun('chat:k3');
    expect(findLiveRunKey('k3')).toBe('chat:k3');
    endLiveRun('chat:k3');
    // only retained finished runs left → still attachable (replays the terminal)
    expect(findLiveRunKey('k3')).toBe('chat:k3');
  });
});

describe('live-runs durability hooks (Phase 1)', () => {
  test('events carry a monotonic seq and the tap observes every event', () => {
    startLiveRun('dur-1');
    const tapped: RunEvent[] = [];
    setRunEventTap('dur-1', e => tapped.push(e));
    pushRunEvent('dur-1', 'init', {});
    pushRunEvent('dur-1', 'text', { delta: 'a' });
    pushRunEvent('dur-1', 'text', { delta: 'b' });
    expect(tapped.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(tapped.map(e => e.type)).toEqual(['init', 'text', 'text']);
    // subscribers see the seq too (buffer replay carries it)
    const seen: RunEvent[] = [];
    subscribeRun('dur-1', e => seen.push(e));
    expect(seen.map(e => e.seq)).toEqual([1, 2, 3]);
    endLiveRun('dur-1');
  });

  test('primeRunSeq continues the counter after a resume and never rewinds', () => {
    startLiveRun('dur-2');
    pushRunEvent('dur-2', 'init', {}); // seq 1
    primeRunSeq('dur-2', 40);
    pushRunEvent('dur-2', 'text', { delta: 'x' });
    primeRunSeq('dur-2', 10); // must NOT rewind
    pushRunEvent('dur-2', 'text', { delta: 'y' });
    const seen: RunEvent[] = [];
    subscribeRun('dur-2', e => seen.push(e));
    expect(seen.map(e => e.seq)).toEqual([1, 41, 42]);
    endLiveRun('dur-2');
  });

  test('a broken tap cannot break the run', () => {
    startLiveRun('dur-3');
    setRunEventTap('dur-3', () => { throw new Error('db down'); });
    expect(() => pushRunEvent('dur-3', 'text', { delta: 'x' })).not.toThrow();
    expect(isRunActive('dur-3')).toBe(true);
    endLiveRun('dur-3');
  });

  test('shutdown interrupt marker distinguishes SIGTERM from user Stop', () => {
    startLiveRun('dur-4');
    expect(isRunShutdownInterrupted('dur-4')).toBe(false);
    markRunShutdownInterrupted('dur-4');
    expect(isRunShutdownInterrupted('dur-4')).toBe(true);
    expect(isRunCancelled('dur-4')).toBe(false); // not a user Stop
    endLiveRun('dur-4');
    expect(isRunShutdownInterrupted('dur-4-unknown')).toBe(false);
  });
});

describe('attachRunToResponse — stream drops (2026-10-20)', () => {
  const { attachRunToResponse, isRunTruncated } = jest.requireActual('./live-runs') as typeof import('./live-runs');
  const mkReq = () => {
    const handlers: Array<() => void> = [];
    return { req: { on: (_ev: 'close', cb: () => void) => { handlers.push(cb); } }, close: () => handlers.forEach(cb => cb()) };
  };
  const mkRes = () => {
    const res: any = { writableEnded: false, frames: [] as string[], setHeader: () => {}, flushHeaders: () => {} };
    res.write = (c: string) => { res.frames.push(c); return true; };
    res.end = () => { res.writableEnded = true; };
    return res;
  };
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('onDrop fires when the VIEWER leaves while the run is active (events written so far, connection lifetime)', () => {
    startLiveRun('drop-1');
    pushRunEvent('drop-1', 'chunk', { content: 'a' });
    const { req, close } = mkReq();
    const res = mkRes();
    const onDrop = jest.fn();
    const onClose = jest.fn();
    attachRunToResponse({ req, res, runKey: 'drop-1', onDrop, onClose });
    pushRunEvent('drop-1', 'chunk', { content: 'b' });
    jest.advanceTimersByTime(1_500);
    close();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ eventsWritten: 2, elapsedMs: 1_500 });
    expect(onClose).toHaveBeenCalledTimes(1); // the caller's own hook still runs
    expect(isRunActive('drop-1')).toBe(true); // a disconnect never touches the run
    endLiveRun('drop-1');
  });

  test('no drop after the terminal ended the response, or once the run is no longer active', () => {
    startLiveRun('drop-2');
    const a = mkReq();
    const onDropA = jest.fn();
    attachRunToResponse({ req: a.req, res: mkRes(), runKey: 'drop-2', onDrop: onDropA });
    pushRunEvent('drop-2', 'complete', {});
    a.close();
    expect(onDropA).not.toHaveBeenCalled();
    endLiveRun('drop-2');

    startLiveRun('drop-3');
    const b = mkReq();
    const onDropB = jest.fn();
    attachRunToResponse({ req: b.req, res: mkRes(), runKey: 'drop-3', onDrop: onDropB });
    endLiveRun('drop-3'); // ended without a terminal reaching this viewer
    b.close();
    expect(onDropB).not.toHaveBeenCalled();
  });

  test('a throwing onDrop never breaks the attach cleanup', () => {
    startLiveRun('drop-4');
    const { req, close } = mkReq();
    const res = mkRes();
    attachRunToResponse({ req, res, runKey: 'drop-4', onDrop: () => { throw new Error('telemetry down'); } });
    expect(() => close()).not.toThrow();
    expect(res.writableEnded).toBe(true);
    endLiveRun('drop-4');
  });

  test('isRunTruncated reports a ring buffer that dropped its head (and false for an unknown run)', () => {
    startLiveRun('trunc-1');
    expect(isRunTruncated('trunc-1')).toBe(false);
    for (let i = 0; i < 20_001; i++) pushRunEvent('trunc-1', 'chunk', { content: 'x' });
    expect(isRunTruncated('trunc-1')).toBe(true);
    expect(isRunTruncated('nope')).toBe(false);
    endLiveRun('trunc-1');
  });

  describe('bindLiveRun — a handle on ONE run, never the key (integration review 2026-10-20)', () => {
    it("a straggler of run A never writes into run B on the same key: buffer, subscribers, tap, progress, Stop", () => {
      expect(tryStartLiveRun('chat:bind1')).toBe(true);
      const a = bindLiveRun('chat:bind1');
      const tapA: RunEvent[] = [];
      setRunEventTap('chat:bind1', (e) => tapA.push(e));
      const seenA: RunEvent[] = [];
      subscribeRun('chat:bind1', (e) => seenA.push(e));
      a.push('progress', { message: 'A working' });
      a.noteProgress(1_000);
      expect(seenA.map(e => e.data.message)).toEqual(['A working']);
      expect(runLastProgressAt('chat:bind1')).toBe(1_000);
      expect(a.isCurrent()).toBe(true);
      endLiveRun('chat:bind1');
      expect(a.isCurrent()).toBe(false);

      // A finished: a post-terminal push reaches nothing — not even A's own mirror tap
      a.push('agent-activity', { kind: 'sub_end' });
      expect(tapA).toHaveLength(1);

      // the queue drain starts run B under the same key
      expect(tryStartLiveRun('chat:bind1')).toBe(true);
      const seenB: RunEvent[] = [];
      subscribeRun('chat:bind1', (e) => seenB.push(e));
      a.push('model-response', { model: 'triple_checker', response: 'OLD COUNCIL REPORT' });
      a.noteProgress(9_999);
      expect(seenB).toEqual([]);
      expect(runLastProgressAt('chat:bind1')).toBeNull();
      expect(tapA).toHaveLength(1);

      // Stop on B is B's: A's straggler keeps going (its late finding still posts)
      cancelRun('chat:bind1');
      expect(isRunCancelled('chat:bind1')).toBe(true);
      expect(a.isCancelled()).toBe(false);

      // B's own handle works as before
      const b = bindLiveRun('chat:bind1');
      b.push('chunk', { content: 'B answer' });
      noteRunProgress('chat:bind1', 5);
      expect(seenB.map(e => e.type)).toEqual(['chunk']);
      expect(b.isCancelled()).toBe(true);
      endLiveRun('chat:bind1');
    });

    it("Stop on A while A runs is A's (the straggler reads it), and no run under the key gives an inert handle", () => {
      startLiveRun('chat:bind2');
      const a = bindLiveRun('chat:bind2');
      cancelRun('chat:bind2');
      expect(a.isCancelled()).toBe(true);
      endLiveRun('chat:bind2');

      const none = bindLiveRun('chat:never-started');
      expect(() => none.push('progress', { message: 'x' })).not.toThrow();
      expect(none.isCancelled()).toBe(false);
      expect(none.isCurrent()).toBe(false);
      none.noteProgress();
      expect(runExists('chat:never-started')).toBe(false);
    });
  });
});
