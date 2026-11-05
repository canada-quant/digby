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
import { partitionQueuedEchoes, reconcileQueuedEchoes, reconcilePendingEchoes, isPlainQueueEchoId } from './queued-echoes';

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

/**
 * reconcilePendingEchoes — "Send now" rendered the message TWICE
 * (owner report 2026-11-05, ticket 81b229e1).
 *
 * INCIDENT: the plain-chat Send now path queues the message, promotes it, then
 * STOPS the live run. The stop calls reloadPlain while the promoted row is
 * still in `pending_chat_messages` (nothing has drained it yet), so the SAME
 * text arrived over two paths:
 *   - the optimistic `tmp-<epochMs>` echo the composer appended at send time
 *     (still in pendingSteerIds — nothing persisted it yet, so
 *     reconcileQueuedEchoes could not twin it), and
 *   - that same message as the server-listed `pending-<rowId>` row.
 * Dedup was by id only, so both survived and the queued partition drew two
 * identical bubbles. The server row is the record (it is what will run), so
 * the local echo is dropped and the echo id is mapped onto the row id.
 */
describe('reconcilePendingEchoes (ticket 81b229e1 — "Send now" showed the message twice)', () => {
  const at = (s: string) => `2026-11-05T21:${s}:00.000Z`;
  const row = (id: string, content: string, createdAt: string, role = 'user') => ({ id, role, content, createdAt });

  it('THE BUG: a promoted queue row supersedes its own tmp-* echo — exactly ONE row survives', () => {
    const echo = row('tmp-1762376400000', 'fix the send now bug', at('00'));
    const serverRow = row('pending-pq1', 'fix the send now bug', at('00'));
    const { messages, idMap } = reconcilePendingEchoes([echo], [serverRow], { isQueueEcho: isPlainQueueEchoId });
    // The echo is DROPPED — the caller appends serverRow, so the rendered set
    // is one bubble, not two.
    expect(messages).toEqual([]);
    expect([...idMap.entries()]).toEqual([['tmp-1762376400000', 'pending-pq1']]);
  });

  it('without the reconcile the duplicate is structural: both ids are distinct, so an id-only append keeps both', () => {
    const echo = row('tmp-1762376400000', 'same text', at('00'));
    const serverRow = row('pending-pq1', 'same text', at('00'));
    const naive = [...[echo], ...[serverRow].filter((p) => !new Set([echo.id]).has(p.id))];
    expect(naive.map((m) => m.id)).toEqual(['tmp-1762376400000', 'pending-pq1']); // 2 bubbles = the bug
  });

  it('an echo with NO matching queue row is KEPT (the run is still live — nothing has been queued yet)', () => {
    const echo = row('tmp-1762376400000', 'not queued', at('00'));
    const { messages, idMap } = reconcilePendingEchoes([echo], [], { isQueueEcho: isPlainQueueEchoId });
    expect(messages.map((m) => m.id)).toEqual(['tmp-1762376400000']);
    expect(idMap.size).toBe(0);
  });

  it('DIFFERENT text never matches — an unrelated queued row cannot swallow the echo', () => {
    const echo = row('tmp-1762376400000', 'message A', at('00'));
    const other = row('pending-pq1', 'message B', at('00'));
    const { messages } = reconcilePendingEchoes([echo], [other], { isQueueEcho: isPlainQueueEchoId });
    expect(messages.map((m) => m.id)).toEqual(['tmp-1762376400000']);
  });

  it('an OLD identical message is never claimed by the clock fallback (outside the window)', () => {
    const echo = row('tmp-1762376400000', 'ok', at('00'));
    const stale = row('pending-pq9', 'ok', '2026-11-05T19:00:00.000Z');
    const { messages, idMap } = reconcilePendingEchoes([echo], [stale], { isQueueEcho: isPlainQueueEchoId });
    expect(messages.map((m) => m.id)).toEqual(['tmp-1762376400000']);
    expect(idMap.size).toBe(0);
  });

  /**
   * Blocking finding #2 from the adversarial review: `promoteQueuedUserMessage`
   * REWRITES the row this reconciles (backend …/chat-agent/queue-controls.ts) —
   * it re-stamps createdAt to just before the caller's OLDEST queued row. So
   * the row may be far OLDER than the echo, and a clock window alone would miss
   * the pair and leave the duplicate on screen. The send path therefore records
   * the exact pairing, and identity wins outright regardless of timestamps.
   */
  it('IDENTITY beats the clock: a promote-re-stamped row is still matched (the bug this was blocking)', () => {
    const echo = row('tmp-1762376400000', 'send now me', at('00'));
    // Re-stamped 40 minutes earlier by promoteQueuedUserMessage — far outside
    // any sane clock window, identical text.
    const restamped = row('pending-pq1', 'send now me', '2026-11-05T20:20:00.000Z');
    const pairing = new Map([['tmp-1762376400000', 'pending-pq1']]);
    const { messages, idMap } = reconcilePendingEchoes([echo], [restamped], {
      isQueueEcho: isPlainQueueEchoId, echoToPending: pairing,
    });
    expect(messages).toEqual([]);                       // echo dropped
    expect([...idMap.entries()]).toEqual([['tmp-1762376400000', 'pending-pq1']]);
  });

  it('identity never claims a row that is not actually listed (the drain already took it)', () => {
    const echo = row('tmp-1762376400000', 'gone', at('00'));
    const pairing = new Map([['tmp-1762376400000', 'pending-vanished']]);
    const { messages, idMap } = reconcilePendingEchoes([echo], [], {
      isQueueEcho: isPlainQueueEchoId, echoToPending: pairing,
    });
    expect(messages.map((m) => m.id)).toEqual(['tmp-1762376400000']); // keep the echo — it is all we have
    expect(idMap.size).toBe(0);
  });

  it('identity is not double-spent by two echoes pointing at the SAME row', () => {
    const e1 = row('tmp-1', 'a', at('00'));
    const e2 = row('tmp-2', 'b', at('01'));
    const only = row('pending-a', 'a', at('00'));
    const pairing = new Map([['tmp-1', 'pending-a'], ['tmp-2', 'pending-a']]);
    const { messages } = reconcilePendingEchoes([e1, e2], [only], {
      isQueueEcho: isPlainQueueEchoId, echoToPending: pairing,
    });
    expect(messages.map((m) => m.id)).toEqual(['tmp-2']); // second echo kept
  });

  it('an unparseable timestamp never matches on content alone', () => {
    const echo = row('tmp-1762376400000', 'same', at('00'));
    const bad = row('pending-pq1', 'same', 'not-a-date');
    const { messages } = reconcilePendingEchoes([echo], [bad], { isQueueEcho: isPlainQueueEchoId });
    expect(messages.map((m) => m.id)).toEqual(['tmp-1762376400000']);
  });

  it('each queue row is claimed at most ONCE (two identical sends map to two distinct rows)', () => {
    const e1 = row('tmp-1', 'dup', at('00'));
    const e2 = row('tmp-2', 'dup', at('01'));
    const r1 = row('pending-a', 'dup', at('00'));
    const { messages, idMap } = reconcilePendingEchoes([e1, e2], [r1], { isQueueEcho: isPlainQueueEchoId });
    expect(messages.map((m) => m.id)).toEqual(['tmp-2']); // only the second echo survives
    expect([...idMap.entries()]).toEqual([['tmp-1', 'pending-a']]);
  });

  it('is narrow: steer-* and non-tmp rows are untouched (coding steers are persisted eagerly, not queued)', () => {
    const steer = row('steer-1762376400000', 'steered', at('00'));
    const tmpEcho = row('tmp-1762376400000', 'steered', at('00'));
    const { messages } = reconcilePendingEchoes([steer, tmpEcho], [row('pending-pq1', 'steered', at('00'))], { isQueueEcho: isPlainQueueEchoId });
    // steer-* is not a plain-queue echo → never dropped here.
    expect(messages.map((m) => m.id)).toEqual(['steer-1762376400000']);
  });

  it('isPlainQueueEchoId matches ONLY the plain composer echo family', () => {
    expect(isPlainQueueEchoId('tmp-1762376400000')).toBe(true);
    expect(isPlainQueueEchoId('steer-1762376400000')).toBe(false);
    expect(isPlainQueueEchoId('pending-pq1')).toBe(false);
    expect(isPlainQueueEchoId('srv-abc')).toBe(false);
    expect(isPlainQueueEchoId('')).toBe(false);
    expect(isPlainQueueEchoId(null)).toBe(false);
    expect(isPlainQueueEchoId(undefined)).toBe(false);
  });

  it('an assistant row of the same text is never a twin', () => {
    const echo = row('tmp-1762376400000', 'same words', at('00'));
    const asst = row('pending-pq1', 'same words', at('00'), 'assistant');
    const { messages } = reconcilePendingEchoes([echo], [asst], { isQueueEcho: isPlainQueueEchoId });
    expect(messages.map((m) => m.id)).toEqual(['tmp-1762376400000']);
  });
});
