/**
 * partitionQueuedEchoes pins (ticket 08d31b1a).
 *
 * The incident: a message steered into a running coding session was echoed
 * at the END of the persisted messages array — but the live run block
 * renders AFTER the whole array, and in coding sessions that block grows
 * thousands of pixels tall. The echo landed at the live block's top edge,
 * far above the pinned viewport, so the user never saw it land and later
 * found the queued bubble "very high up" in the transcript. The view now
 * partitions: history renders in the list, queued echoes render in-flow
 * AFTER the live block (before the composer) where the user's attention is.
 * These pins keep the split pure and order-preserving so the chronological
 * array stays the record (PR #328's visibility goal is preserved — the
 * echo is never hidden).
 */

import { describe, it, expect } from 'vitest';
import { partitionQueuedEchoes, reconcileQueuedEchoes } from './queued-echoes';

type Row = { id: string; content: string };
const row = (id: string): Row => ({ id, content: `content of ${id}` });

describe('partitionQueuedEchoes (08d31b1a)', () => {
  it('empty pending set → identity: every message stays in history, nothing queued', () => {
    const messages = [row('a-1'), row('u-2'), row('a-3')];
    const { history, queuedEchoes } = partitionQueuedEchoes(messages, new Set());
    expect(history).toEqual(messages);
    expect(queuedEchoes).toEqual([]);
  });

  it('echoes are removed from history, which otherwise preserves order', () => {
    const messages = [row('a-1'), row('u-2'), row('a-3'), row('steer-4'), row('a-5')];
    const { history, queuedEchoes } = partitionQueuedEchoes(messages, new Set(['steer-4']));
    expect(history.map(m => m.id)).toEqual(['a-1', 'u-2', 'a-3', 'a-5']);
    expect(queuedEchoes.map(m => m.id)).toEqual(['steer-4']);
  });

  it('multiple echoes keep their relative order (queue order = send order)', () => {
    const messages = [row('steer-1'), row('a-2'), row('steer-3'), row('a-4'), row('tmp-5')];
    const { history, queuedEchoes } = partitionQueuedEchoes(messages, new Set(['steer-1', 'steer-3', 'tmp-5']));
    expect(history.map(m => m.id)).toEqual(['a-2', 'a-4']);
    expect(queuedEchoes.map(m => m.id)).toEqual(['steer-1', 'steer-3', 'tmp-5']);
  });

  it('ids NOT in the pending set are untouched (server rows can share content with an echo)', () => {
    const messages = [row('srv-1'), row('steer-2'), row('srv-3')];
    const { history, queuedEchoes } = partitionQueuedEchoes(messages, new Set(['steer-2']));
    expect(history.map(m => m.id)).toEqual(['srv-1', 'srv-3']);
    expect(queuedEchoes.map(m => m.id)).toEqual(['steer-2']);
  });

  it('works with an empty messages array', () => {
    const { history, queuedEchoes } = partitionQueuedEchoes<Row>([], new Set(['steer-1']));
    expect(history).toEqual([]);
    expect(queuedEchoes).toEqual([]);
  });

  it('does not mutate its inputs (pure — safe inside a render memo)', () => {
    const messages = [row('a-1'), row('steer-2')];
    const before = [...messages];
    partitionQueuedEchoes(messages, new Set(['steer-2']));
    expect(messages).toEqual(before);
  });
});

describe('reconcileQueuedEchoes (owner report 2026-09-16 — queued bubbles vanished on a mid-run reload)', () => {
  const isLocalEcho = (id: string) => /^(tmp-|steer-|a-\d+$|m-\d+-)/.test(id);
  const at = (s: string) => `2026-09-16T21:${s}:00.000Z`;
  const user = (id: string, content: string, createdAt: string, role = 'user') => ({ id, role, content, createdAt });

  it('a pending steer echo is REPLACED by its server twin and the pending set is re-keyed to the server id', () => {
    const prev = [user('m-1-local', 'first turn', at('00')), user('srv-a', 'hello agent', at('01')), user('steer-1758055200000', 'please also run the tests', at('05'))];
    const page = [user('srv-a', 'hello agent', at('01')), user('srv-steer', 'please also run the tests', at('05')), { id: 'srv-run', role: 'assistant', content: '', createdAt: at('02') }];
    const { messages, idMap } = reconcileQueuedEchoes(prev, page, new Set(['steer-1758055200000']), { isLocalEcho });
    expect(messages.map((m) => m.id)).toEqual(['srv-a', 'srv-run', 'srv-steer']);
    expect(idMap.get('steer-1758055200000')).toBe('srv-steer');
    // the partition then renders the SERVER row in the queued slot
    const pending = new Set([...idMap.values()]);
    expect(partitionQueuedEchoes(messages, pending).queuedEchoes.map((m) => m.id)).toEqual(['srv-steer']);
  });

  it('a pending echo whose persist has not landed yet is KEPT (never erased by a reload); a non-pending local echo is dropped', () => {
    const prev = [user('srv-a', 'hello agent', at('01')), user('steer-2', 'not yet persisted', at('06')), user('tmp-9', 'stale plain echo', at('07'))];
    const page = [user('srv-a', 'hello agent', at('01'))];
    const { messages, idMap } = reconcileQueuedEchoes(prev, page, new Set(['steer-2']), { isLocalEcho });
    expect(messages.map((m) => m.id)).toEqual(['srv-a', 'steer-2']);
    expect(idMap.size).toBe(0);
  });

  it('twin matching needs the same trimmed text, a user row, and a send time inside the window; each server row is claimed once', () => {
    const prev = [user('steer-1', 'run it', at('05')), user('steer-2', 'run it', at('06'))];
    const page = [user('srv-1', 'run it ', at('05')), user('srv-old', 'run it', '2026-09-16T19:00:00.000Z'), { id: 'srv-asst', role: 'assistant', content: 'run it', createdAt: at('05') }];
    const { messages, idMap } = reconcileQueuedEchoes(prev, page, new Set(['steer-1', 'steer-2']), { isLocalEcho });
    expect(idMap.get('steer-1')).toBe('srv-1');
    expect(idMap.has('steer-2')).toBe(false); // srv-1 already claimed; srv-old is outside the window
    expect(messages.map((m) => m.id)).toEqual(['srv-old', 'srv-1', 'srv-asst', 'steer-2']);
  });

  describe('plain busy-queue semantics (owner report 2026-09-18 — "it disappears but shows the toast, then later reappears")', () => {
    // The plain view passes an ASYMMETRIC window: the twin is persisted when
    // the drain RUNS the message (minutes/hours later), never before the send.
    const plainOpts = { isLocalEcho, windowBeforeMs: 60_000, windowAfterMs: Number.POSITIVE_INFINITY };

    it('a reload while the run is still live KEEPS the pending tmp-* echo (the server has no row for it yet)', () => {
      const prev = [user('srv-a', 'earlier turn', at('01')), user('tmp-1758226000000', 'ok but what about nebius?', at('10'))];
      const page = [user('srv-a', 'earlier turn', at('01')), { id: 'srv-run', role: 'assistant', content: 'still working…', createdAt: at('02') }];
      const { messages, idMap } = reconcileQueuedEchoes(prev, page, new Set(['tmp-1758226000000']), plainOpts);
      expect(messages.map((m) => m.id)).toEqual(['srv-a', 'srv-run', 'tmp-1758226000000']);
      expect(idMap.size).toBe(0);
    });

    it('the twin persisted 61 MINUTES later (drain time) is still matched — the symmetric 10-min window would have missed it and shown two bubbles', () => {
      const prev = [user('tmp-1', 'ok but what about nebius?', '2026-09-18T19:10:00.000Z')];
      const page = [user('srv-late', 'ok but what about nebius?', '2026-09-18T20:11:00.000Z')];
      const sym = reconcileQueuedEchoes(prev, page, new Set(['tmp-1']), { isLocalEcho });
      expect(sym.idMap.size).toBe(0); // the old rule: no twin → echo kept → duplicate
      const plain = reconcileQueuedEchoes(prev, page, new Set(['tmp-1']), plainOpts);
      expect(plain.idMap.get('tmp-1')).toBe('srv-late');
      expect(plain.messages.map((m) => m.id)).toEqual(['srv-late']);
    });

    it('an OLDER row with the same text is never claimed as the twin (a twin can only be newer than the send)', () => {
      const prev = [user('srv-old', 'ok', '2026-09-18T18:00:00.000Z'), user('tmp-2', 'ok', '2026-09-18T19:10:00.000Z')];
      const page = [user('srv-old', 'ok', '2026-09-18T18:00:00.000Z')];
      const { messages, idMap } = reconcileQueuedEchoes(prev, page, new Set(['tmp-2']), plainOpts);
      expect(idMap.size).toBe(0);
      expect(messages.map((m) => m.id)).toEqual(['srv-old', 'tmp-2']);
    });

    it('a twin a few seconds BEFORE the echo stamp (clock skew) still matches within windowBeforeMs', () => {
      const prev = [user('tmp-3', 'skewed', '2026-09-18T19:10:30.000Z')];
      const page = [user('srv-skew', 'skewed', '2026-09-18T19:10:00.000Z')];
      expect(reconcileQueuedEchoes(prev, page, new Set(['tmp-3']), plainOpts).idMap.get('tmp-3')).toBe('srv-skew');
    });
  });

  it('server rows always win on id; older paged-in rows survive the merge', () => {
    const prev = [user('srv-old', 'paged in earlier', at('00')), user('srv-a', 'stale copy', at('01'))];
    const page = [user('srv-a', 'fresh copy', at('01'))];
    const { messages } = reconcileQueuedEchoes(prev, page, new Set(), { isLocalEcho });
    expect(messages.map((m) => [m.id, m.content])).toEqual([['srv-old', 'paged in earlier'], ['srv-a', 'fresh copy']]);
  });
});

describe('dropPrevAbsent (ticket c0b2b0c8 — the fresh page is the source of truth for the server-side queue)', () => {
  const isLocalEcho = (id: string) => /^(tmp-|steer-|a-\d+$|m-\d+-)/.test(id);
  const at = (s: string) => `2026-09-16T21:${s}:00.000Z`;
  const user = (id: string, content: string, createdAt: string, role = 'user') => ({ id, role, content, createdAt });
  // The plain view's real predicate, mirrored exactly (CodeSessionView
  // mergeLatestPlainPage): only `pending-<rowId>` rows — the ones the GET's
  // pendingMessages listed — are page-gated.
  const plainQueue = { isLocalEcho, windowBeforeMs: 60_000, windowAfterMs: Number.POSITIVE_INFINITY, dropPrevAbsent: (id: string) => id.startsWith('pending-') };

  it('a prev pending row the fresh page no longer lists is DROPPED (drained — its persisted twin is in the page; keeping it would render a duplicate bubble)', () => {
    const prev = [user('srv-a', 'hello agent', at('01')), user('pending-pq1', 'queued while the run was live', at('05'))];
    const page = [user('srv-a', 'hello agent', at('01')), user('srv-drained', 'queued while the run was live', at('09'))];
    const { messages, idMap } = reconcileQueuedEchoes(prev, page, new Set(['pending-pq1']), plainQueue);
    expect(messages.map((m) => m.id)).toEqual(['srv-a', 'srv-drained']);
    expect(idMap.size).toBe(0); // not an echo-twin handoff — the server row simply replaces the queue row
  });

  it('a pending row the fresh page STILL lists is KEPT (still queued behind the live run)', () => {
    const prev = [user('srv-a', 'hello agent', at('01')), user('pending-pq1', 'still waiting', at('05'))];
    const page = [user('srv-a', 'hello agent', at('01')), user('pending-pq1', 'still waiting', at('05'))];
    const { messages } = reconcileQueuedEchoes(prev, page, new Set(['pending-pq1']), plainQueue);
    expect(messages.map((m) => m.id)).toEqual(['srv-a', 'pending-pq1']);
  });

  it('the predicate is per-id — a pending tmp-* echo with no twin is still KEPT (the pre-existing plain busy-queue rule is untouched)', () => {
    const prev = [user('srv-a', 'hello agent', at('01')), user('tmp-1758226000000', 'not a server queue row', at('06'))];
    const page = [user('srv-a', 'hello agent', at('01'))];
    const { messages } = reconcileQueuedEchoes(prev, page, new Set(['tmp-1758226000000']), plainQueue);
    expect(messages.map((m) => m.id)).toEqual(['srv-a', 'tmp-1758226000000']);
  });

  it('the coding path never passes dropPrevAbsent: a prev pending steer echo absent from the page follows the OLD rules (kept — persist not landed)', () => {
    const prev = [user('steer-2', 'steered mid-run', at('05'))];
    const page = [{ id: 'srv-run', role: 'assistant', content: '', createdAt: at('02') }];
    const { messages } = reconcileQueuedEchoes(prev, page, new Set(['steer-2']), { isLocalEcho });
    expect(messages.map((m) => m.id)).toEqual(['srv-run', 'steer-2']);
  });
});
