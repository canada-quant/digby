/**
 * Depth UX seams (audit finding sse-ui-restore-14, 2026-09-26): the view logic
 * behind the pill / chip / poll / guest-hydration seam, exercised as BEHAVIOUR
 * (the "wiring" suites are source-text pins and had let four seam defects ride
 * through green CI). Each block reproduces the defect the finding named, then
 * pins the fix.
 */

import { describe, expect, it } from 'vitest';
import type { CodingMessage } from '@/lib/api/coding';
import { ESCALATE_LABEL, RUNG_ETA_TEXT, countSpentEscalations, escalationChipFor, parseChips, pillFromMeta } from '@/lib/depth-ux';
import { REVISION_POLL_PAGE, mapPlainMessages, plainRevisionPending, settleRestoredRows } from './plain-session';
import {
  CHECK_ADDENDUM_KIND, DEEPER_FINDINGS_KIND, ESCALATION_REFUSAL_RETRYABLE, ESCALATION_REFUSAL_TERMINAL,
  applyEscalationRefusal, chipAnchorId, escalationRefusalPlan, guestHydratedRow, isCheckAddendumRow, pendingRowsToPoll, settleRowsInterrupted,
} from './depth-ux-seams';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-26T20:40:00.000Z');
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

const serverChip = (escalationOf: string, nextRung: 'verify' | 'research' = 'verify') => parseChips([{ kind: 'escalate', escalationOf, nextRung }]);
const user = (id: string, content: string, escalationOf?: string): CodingMessage => ({ id, role: 'user', content, createdAt: agoIso(0), ...(escalationOf ? { plainMeta: { escalationOf } } : {}) });
const assistant = (id: string, meta?: CodingMessage['plainMeta'], createdAt = agoIso(0)): CodingMessage => ({ id, role: 'assistant', content: `answer ${id}`, createdAt, ...(meta ? { plainMeta: meta } : {}) });

/** The view's chip resolution (digDeeperChipFor) for one row of a transcript. */
function chipFor(history: CodingMessage[], m: CodingMessage, opts: { guest?: boolean; running?: boolean } = {}) {
  return escalationChipFor({
    chips: m.plainMeta?.chips, depth: m.plainMeta?.depth, origin: m.plainMeta?.origin, messageId: m.id,
    guest: !!opts.guest,
    spent: countSpentEscalations(history.map(h => ({ role: h.role, escalationOf: h.plainMeta?.escalationOf })), m.id),
    isLast: m.id === chipAnchorId(history), running: !!opts.running,
  });
}

// ── 1. a refused Dig-deeper tap ──────────────────────────────────────────────

describe('escalationRefusalPlan — the controller refusal codes, nothing else', () => {
  it('every refusal code plans an echo retraction; retryable codes restore the chip, terminal ones strip it', () => {
    for (const code of ESCALATION_REFUSAL_RETRYABLE) {
      expect(escalationRefusalPlan({ message: 'busy', code })).toEqual({ code, removeEcho: true, restoreChip: true, message: 'busy' });
    }
    for (const code of ESCALATION_REFUSAL_TERMINAL) {
      expect(escalationRefusalPlan({ message: 'no more', code })).toEqual({ code, removeEcho: true, restoreChip: false, message: 'no more' });
    }
    // the exact code the controller's busy branch sends (crossmodel.controller.ts queueBusyMessage)
    expect(escalationRefusalPlan({ message: 'Digby is still working in this chat — tap Dig deeper again when it finishes.', code: 'ESCALATION_BUSY' })?.restoreChip).toBe(true);
  });

  it('an ordinary error frame (no code / an unknown code / a non-object) is not a refusal — the view keeps its error handling', () => {
    expect(escalationRefusalPlan({ message: 'Agent crashed' })).toBeNull();
    expect(escalationRefusalPlan({ message: 'x', code: 'RATE_LIMITED' })).toBeNull();
    expect(escalationRefusalPlan(null)).toBeNull();
    expect(escalationRefusalPlan('ESCALATION_BUSY')).toBeNull();
  });

  it('a refusal with a blank message still plans with a fallback sentence', () => {
    expect(escalationRefusalPlan({ code: 'ESCALATION_BUSY', message: '   ' })?.message).toMatch(/could not run/);
  });
});

describe('applyEscalationRefusal — the DEFECT: a refused tap left its echo, so the chip advanced a rung that never ran', () => {
  const history = [user('u1', 'q'), assistant(A1, { chips: serverChip(A1, 'verify'), depth: { plan: { preset: 'single_thinking', spawnChecker: false, council: 'none' } } })];
  const echo = user('tmp-1', ESCALATE_LABEL, A1);
  const afterTap = [...history, echo];

  it('reproduces the defect: with the echo left in place the chip reads the NEXT rung (research) although verify never ran', () => {
    expect(chipFor(afterTap, afterTap[1])).toMatchObject({ kind: 'escalate', nextRung: 'research', etaText: RUNG_ETA_TEXT.research });
  });

  it('a RETRYABLE refusal (ESCALATION_BUSY) removes the echo and the chip is back exactly as the server sent it', () => {
    const plan = escalationRefusalPlan({ code: 'ESCALATION_BUSY', message: 'busy' })!;
    const rows = applyEscalationRefusal(afterTap, { echoId: 'tmp-1', escalationOf: A1 }, plan);
    expect(rows.map(r => r.id)).toEqual(['u1', A1]);
    expect(rows[1]).toBe(history[1]); // untouched row keeps its identity
    expect(chipFor(rows, rows[1])).toMatchObject({ kind: 'escalate', escalationOf: A1, nextRung: 'verify' });
  });

  it('a TERMINAL refusal (ESCALATION_EXHAUSTED / DEPTH_BUDGET_EXCEEDED) removes the echo AND strips the parent chip — nothing re-offers the refused rung', () => {
    for (const code of ['ESCALATION_EXHAUSTED', 'DEPTH_BUDGET_EXCEEDED', 'DIG_DEEPER_DISABLED']) {
      const plan = escalationRefusalPlan({ code, message: 'no' })!;
      const rows = applyEscalationRefusal(afterTap, { echoId: 'tmp-1', escalationOf: A1 }, plan);
      expect(rows.map(r => r.id)).toEqual(['u1', A1]);
      expect(rows[1].plainMeta?.chips).toBeUndefined();
      expect(rows[1].plainMeta?.depth).toBeDefined(); // the rest of the meta survives
      expect(chipFor(rows, rows[1])).toBeNull();
    }
  });

  it('only THIS tap\'s echo is removed: an older persisted escalation echo (a real spent rung) stays and still counts', () => {
    const spentEarlier = user('u2', ESCALATE_LABEL, A1);
    const rows = [history[0], history[1], spentEarlier, echo];
    const plan = escalationRefusalPlan({ code: 'ESCALATION_BUSY', message: 'busy' })!;
    const out = applyEscalationRefusal(rows, { echoId: 'tmp-1', escalationOf: A1 }, plan);
    expect(out.map(r => r.id)).toEqual(['u1', A1, 'u2']);
    expect(countSpentEscalations(out.map(h => ({ role: h.role, escalationOf: h.plainMeta?.escalationOf })), A1)).toBe(1);
  });

  it('a mismatched in-flight record (wrong echo id / wrong target) changes nothing and returns the same array', () => {
    const plan = escalationRefusalPlan({ code: 'ESCALATION_BUSY', message: 'busy' })!;
    expect(applyEscalationRefusal(afterTap, { echoId: 'tmp-9', escalationOf: A1 }, plan)).toBe(afterTap);
    expect(applyEscalationRefusal(afterTap, { echoId: 'tmp-1', escalationOf: A2 }, plan)).toBe(afterTap);
  });
});

// ── 2. which pending rows are polled ─────────────────────────────────────────

describe('pendingRowsToPoll — the DEFECT: only the LAST assistant row was polled, a younger non-last "checking" row spun forever', () => {
  // the exact restored-check-state fixture: a2 young/checking (not last), a3 last/checked
  const full = {
    messages: [
      { id: 'u1', role: 'user', content: 'Q1', createdAt: agoIso(60 * 60_000) },
      { id: 'a1', role: 'assistant', content: 'A1', createdAt: agoIso(59 * 60_000), metadata: { check: { state: 'checking' } } },
      { id: 'u2', role: 'user', content: 'Q2', createdAt: agoIso(2 * 60_000) },
      { id: 'a2', role: 'assistant', content: 'A2', createdAt: agoIso(60_000), metadata: { check: { state: 'checking' } } },
      { id: 'a3', role: 'assistant', content: 'A3', createdAt: agoIso(30_000), metadata: { check: { state: 'checked' } } },
    ],
  };
  const restored = settleRestoredRows(mapPlainMessages(full), { canPoll: true, now: NOW });

  it('the fix: a2 (young, checking, inside the poll page) is polled; a1 settled to interrupted is not; a3 checked is not', () => {
    expect(restored.find(r => r.id === 'a2')!.plainMeta?.check?.state).toBe('checking');
    const plan = pendingRowsToPoll(restored);
    expect(plan.poll.map(r => r.id)).toEqual(['a2']);
    expect(plan.unreachable).toEqual([]);
  });

  it('a pending row the poll can never see (outside the newest REVISION_POLL_PAGE rows) is reported unreachable, and settleRowsInterrupted settles it honestly', () => {
    const rows: CodingMessage[] = [assistant('old', { check: { state: 'checking' } })];
    for (let i = 0; i < REVISION_POLL_PAGE; i++) rows.push(user(`u${i}`, 'q'), assistant(`a${i}`, { check: { state: 'checked' } }));
    const last = assistant('young', { check: { state: 'checking' } });
    rows.push(last);
    const plan = pendingRowsToPoll(rows);
    expect(plan.poll.map(r => r.id)).toEqual(['young']);
    expect(plan.unreachable.map(r => r.id)).toEqual(['old']);
    const settled = settleRowsInterrupted(rows, ['old']);
    expect(pillFromMeta(settled[0].plainMeta)).toEqual({ kind: 'interrupted' });
    expect(plainRevisionPending(settled[0].plainMeta)).toBe(false);
    expect(settled[settled.length - 1]).toBe(last); // identity kept for untouched rows
    expect(settleRowsInterrupted(rows, [])).toBe(rows);
  });

  it('the just-answered turn: the appended pending row AND a still-pending earlier row are both polled (dedupe is the caller\'s ref)', () => {
    const rows = [user('u1', 'q'), assistant('a1', { check: { state: 'checking' } }), user('u2', 'q'), assistant('a2', { pendingCrossCheck: true })];
    expect(pendingRowsToPoll(rows).poll.map(r => r.id)).toEqual(['a1', 'a2']);
  });
});

// ── 3. the chip anchor ───────────────────────────────────────────────────────

describe('chipAnchorId — the DEFECT: a check ADDENDUM row became "the latest answer" and no chip rendered anywhere', () => {
  // late-crosscheck.ts conversation_moved: the addendum is posted under the NEWER turn
  const parent = assistant(A1, { chips: serverChip(A1, 'research'), check: { state: 'updated', changed: ['the height'] } });
  const newer = assistant(A2, { chips: serverChip(A2, 'verify'), followUps: ['and then?'] });
  const addendum = assistant('add-1', { kind: CHECK_ADDENDUM_KIND, addendumFor: A1, check: { state: 'updated', changed: ['the height'] } } as any);
  const history = [user('u1', 'q1'), parent, user('u2', 'q2'), newer, addendum];

  it('the fix: the anchor skips the addendum — the newer answer keeps its Dig-deeper control (and its follow-ups anchor there too)', () => {
    expect(isCheckAddendumRow(addendum)).toBe(true);
    expect(chipAnchorId(history)).toBe(A2);
    expect(chipFor(history, newer)).toMatchObject({ kind: 'escalate', escalationOf: A2, nextRung: 'verify' });
    expect(chipFor(history, parent)).toBeNull();
    expect(chipFor(history, addendum)).toBeNull();
  });

  it('a "Deeper findings" row anchors itself: the server pins the original message\'s next-rung chip on it (verify rung) or none (research rung)', () => {
    const echo = user('u2', ESCALATE_LABEL, A1);
    const deeperVerify = assistant('d-1', { kind: DEEPER_FINDINGS_KIND, chips: serverChip(A1, 'research'), depth: { plan: { preset: 'thinking', spawnChecker: true, council: 'none', source: 'escalation' } } });
    const h1 = [user('u1', 'q'), assistant(A1, { chips: serverChip(A1, 'verify') }), echo, deeperVerify];
    expect(chipAnchorId(h1)).toBe('d-1');
    expect(chipFor(h1, deeperVerify)).toMatchObject({ kind: 'escalate', escalationOf: A1, nextRung: 'research' });
    const deeperResearch = assistant('d-2', { kind: DEEPER_FINDINGS_KIND, depth: { plan: { preset: 'deep_research', council: 'background', source: 'escalation' } } });
    const h2 = [user('u1', 'q'), assistant(A1, { chips: serverChip(A1, 'research') }), echo, deeperResearch];
    expect(chipAnchorId(h2)).toBe('d-2');
    for (const m of h2) expect(chipFor(h2, m)).toBeNull();
  });

  it('no assistant row ⇒ no anchor; a transcript of only addenda ⇒ no anchor (nothing invented)', () => {
    expect(chipAnchorId([user('u1', 'q')])).toBeUndefined();
    expect(chipAnchorId([user('u1', 'q'), addendum])).toBeUndefined();
  });
});

// ── 4. guest hydration ───────────────────────────────────────────────────────

describe('guestHydratedRow — the DEFECT: a guest answer hydrated after a reload carried no chip (the streaming tab showed one)', () => {
  const signin = [{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }];

  it('the fix: the state\'s chips ride the row and the guest chip renders under it', () => {
    const row = guestHydratedRow('Mount Logan, 5,959 m.', signin, { id: 'a-1', createdAt: agoIso(0) });
    expect(row).toEqual({ id: 'a-1', role: 'assistant', content: 'Mount Logan, 5,959 m.', createdAt: agoIso(0), plainMeta: { chips: [{ kind: 'signin_deeper', label: 'Sign in for a deeper look' }] } });
    expect(chipFor([user('u1', 'q'), row], row, { guest: true })).toEqual({ kind: 'signin_deeper', label: 'Sign in for a deeper look' });
  });

  it('no chips / malformed chips ⇒ a plain row (a legacy backend sends none); a signed-in view never shows the guest chip', () => {
    expect(guestHydratedRow('x', undefined, { id: 'a', createdAt: 't' })).toEqual({ id: 'a', role: 'assistant', content: 'x', createdAt: 't' });
    expect(guestHydratedRow('x', [{ kind: 'bogus' }], { id: 'a', createdAt: 't' }).plainMeta).toBeUndefined();
    const row = guestHydratedRow('x', signin, { id: 'a', createdAt: 't' });
    expect(chipFor([row], row, { guest: false })).toBeNull();
  });
});
