/**
 * Restored check state (owner report 2026-09-26: after a refresh, a chat that
 * was mid-response still showed the run's progress/state "as if streaming").
 * The persisted half of that: an assistant row whose metadata still says
 * `check.state:'checking'` / `pendingCrossCheck:true` rendered "Checking…"
 * forever after a reload — nothing in the new tab polled it. Pins:
 *   - settleRestoredCheck: a stale or un-pollable pending row settles to
 *     'interrupted' ("Check didn't finish"); a young pollable row stays
 *     'checking' (the view starts pollPlainRevision); checked / updated /
 *     skipped / legacy metas pass through untouched;
 *   - mapPlainMessages applies it on every restore (signed-in load + reload);
 *   - pollPlainRevision resolving null at the bound is what the view settles;
 *   - pillFromMeta renders the settled state as the interrupted pill.
 */

import { describe, it, expect } from 'vitest';
import {
  RESTORED_CHECK_SETTLE_MS, REVISION_POLL_MAX_MS,
  mapPlainMessages, markCheckInterrupted, plainRevisionPending, pollPlainRevision, settleRestoredCheck, settleRestoredRows,
} from './plain-session';
import { PILL_TEXT, pillFromMeta } from '@/lib/depth-ux';
import type { PlainMessageMeta } from '@/lib/api/coding';

const NOW = Date.parse('2026-09-26T20:40:00.000Z');
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

describe('settleRestoredCheck', () => {
  it('a young pollable "checking" row stays checking (the view polls it)', () => {
    const meta: PlainMessageMeta = { check: { state: 'checking' } };
    expect(settleRestoredCheck(meta, { createdAt: agoIso(60_000), canPoll: true, now: NOW })).toBe(meta);
  });

  it('a stale "checking" row settles to interrupted — "Check didn’t finish", never "Checking…"', () => {
    const meta: PlainMessageMeta = { check: { state: 'checking' }, pendingCrossCheck: true, sources: [{ documentName: 'x' }] };
    const settled = settleRestoredCheck(meta, { createdAt: agoIso(RESTORED_CHECK_SETTLE_MS + 1), canPoll: true, now: NOW });
    expect(settled).toEqual({ check: { state: 'interrupted' }, sources: [{ documentName: 'x' }] });
    expect(plainRevisionPending(settled)).toBe(false);
    expect(pillFromMeta(settled)).toEqual({ kind: 'interrupted' });
    expect(PILL_TEXT.interrupted).toBe('Check didn’t finish');
  });

  it('an un-pollable pending row (guest — nothing can update it) settles regardless of age', () => {
    const young = settleRestoredCheck({ pendingCrossCheck: true }, { createdAt: agoIso(1_000), canPoll: false, now: NOW });
    expect(young).toEqual({ check: { state: 'interrupted' } });
  });

  it('a pending row with no createdAt is treated as stale', () => {
    expect(settleRestoredCheck({ check: { state: 'checking' } }, { canPoll: true, now: NOW })).toEqual({ check: { state: 'interrupted' } });
  });

  it('checked / updated / skipped / legacy metas pass through untouched', () => {
    const checked: PlainMessageMeta = { check: { state: 'checked' } };
    const updated: PlainMessageMeta = { check: { state: 'updated', changed: ['the height'] }, revision: { at: 'x', reason: 'r', previousContent: 'old' } };
    const skipped: PlainMessageMeta = { check: { state: 'skipped' } };
    const legacy: PlainMessageMeta = { crossCheck: { outcome: 'unchanged' } };
    for (const m of [checked, updated, skipped, legacy]) {
      expect(settleRestoredCheck(m, { createdAt: agoIso(RESTORED_CHECK_SETTLE_MS * 2), canPoll: true, now: NOW })).toBe(m);
    }
    expect(settleRestoredCheck(undefined, { canPoll: true, now: NOW })).toBeUndefined();
    expect(pillFromMeta(checked)).toEqual({ kind: 'checked' });
    expect(pillFromMeta(updated)).toEqual({ kind: 'updated', changed: ['the height'] });
    expect(pillFromMeta(skipped)).toBeNull();
  });

  it('the settle window sits past the poll bound (the late check cannot land after it)', () => {
    expect(RESTORED_CHECK_SETTLE_MS).toBeGreaterThan(REVISION_POLL_MAX_MS);
  });
});

describe('markCheckInterrupted', () => {
  it('clears pendingCrossCheck and sets the interrupted state, keeping the rest of the meta', () => {
    expect(markCheckInterrupted({ pendingCrossCheck: true, followUps: ['a'] })).toEqual({ check: { state: 'interrupted' }, followUps: ['a'] });
    expect(markCheckInterrupted(undefined)).toEqual({ check: { state: 'interrupted' } });
  });
});

describe('settleRestoredRows — a restored transcript settles stale pending rows (both restore sites)', () => {
  const full = {
    messages: [
      { id: 'u1', role: 'user', content: 'Q1', createdAt: agoIso(60 * 60_000) },
      { id: 'a1', role: 'assistant', content: 'A1', createdAt: agoIso(59 * 60_000), metadata: { check: { state: 'checking' } } },
      { id: 'u2', role: 'user', content: 'Q2', createdAt: agoIso(2 * 60_000) },
      { id: 'a2', role: 'assistant', content: 'A2', createdAt: agoIso(60_000), metadata: { check: { state: 'checking' } } },
      { id: 'a3', role: 'assistant', content: 'A3', createdAt: agoIso(30_000), metadata: { check: { state: 'checked' } } },
    ],
  };

  it('an hour-old "checking" row reads interrupted; a minute-old one stays pending for the poll; checked stays checked', () => {
    const rows = settleRestoredRows(mapPlainMessages(full), { canPoll: true, now: NOW });
    expect(rows.find(r => r.id === 'a1')!.plainMeta).toEqual({ check: { state: 'interrupted' } });
    expect(rows.find(r => r.id === 'a2')!.plainMeta).toEqual({ check: { state: 'checking' } });
    expect(rows.find(r => r.id === 'a3')!.plainMeta).toEqual({ check: { state: 'checked' } });
    // Untouched rows keep their identity (no needless re-render churn).
    const mapped = mapPlainMessages(full);
    const settled = settleRestoredRows(mapped, { canPoll: true, now: NOW });
    expect(settled[4]).toBe(mapped[4]);
    expect(settled[0]).toBe(mapped[0]);
  });

  it('mapPlainMessages itself stays RAW (the revision poll must see the pending state to keep polling)', () => {
    const rows = mapPlainMessages(full);
    expect(rows.find(r => r.id === 'a1')!.plainMeta).toEqual({ check: { state: 'checking' } });
  });

  it('a restored mid-response transcript (trailing user row) carries NO streaming state — rows only', () => {
    const rows = settleRestoredRows(mapPlainMessages({ messages: [full.messages[0], full.messages[1], full.messages[2]] }), { canPoll: true, now: NOW });
    expect(rows.map(r => r.role)).toEqual(['user', 'assistant', 'user']);
    // Nothing on a restored row says "streaming": no live parts, no status, no running flag.
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['content', 'createdAt', 'id', 'parts', 'plainMeta', 'role']);
  });
});

describe('pollPlainRevision — the bound resolves null (the view then settles the pill)', () => {
  it('a row that never settles within the bound resolves null, not a stale "checking" row', async () => {
    const fetchChat = async () => ({ messages: [{ id: 'a2', role: 'assistant', content: 'A2', createdAt: new Date().toISOString(), metadata: { check: { state: 'checking' } } }] });
    const row = await pollPlainRevision('c1', 'a2', fetchChat, { intervalMs: 1, maxMs: 5, sleep: async () => {} });
    expect(row).toBeNull();
  });

  it('a row whose late check landed resolves with the settled row', async () => {
    const fetchChat = async () => ({ messages: [{ id: 'a2', role: 'assistant', content: 'A2 revised', createdAt: new Date().toISOString(), metadata: { check: { state: 'updated', changed: ['x'] } } }] });
    const row = await pollPlainRevision('c1', 'a2', fetchChat, { intervalMs: 1, maxMs: 50, sleep: async () => {} });
    expect(row?.plainMeta).toEqual({ check: { state: 'updated', changed: ['x'] } });
    expect(pillFromMeta(row?.plainMeta)).toEqual({ kind: 'updated', changed: ['x'] });
  });
});
