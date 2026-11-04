/**
 * HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20) — what a
 * supervisor wake did is stated from the harness record, not the model's own
 * ACTIONS TAKEN text. The fixtures replay the production shapes the design
 * cited: a model block whose ids were copied from the WRONG tool (the
 * receipt_tool_mismatch class, 106 → 201 rows/day), a zero-call narration,
 * a report-up-only project-supervisor wake, a staged card, a self-send.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));
jest.mock('./supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note', reportUpTargetForSession: async () => null }));

import {
  HARNESS_ACTIONS_HEADER, HARNESS_NOOP_LINE, HARNESS_RECORD_ZERO_LINE, applyHarnessReceipts, harnessLineKind, harnessNoteKind,
  harnessActionLineCount, harnessReceiptsMeta, harnessReceiptsView, isHarnessAppendixBlock, renderHarnessActionLine, stripHarnessNoopLines, stripModelActionsBlock,
  stripModelActionsBlockFromParts, splitTrailingHarnessAppendix, stripTrailingHarnessAppendix, stripTrailingNoopCloseLine, stripTrailingNoopCloseLineFromParts, isHarnessTrailerBlock, supervisorHarnessReceiptsDisabled, wakeNoteRetryCloseClause, type HarnessReceiptsView,
} from './harness-receipts';
import { isRealActionTool, realActionToolNames } from './decision-outcome-labels';
import { UNVERIFIED_FOOTNOTE_HEADER } from './unverified-claims';

const SELF = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
const LANE = '9e39ec5c-0b5a-4bd8-8a0b-5a1ff0a1b2c3';
const FLEET = 'f1ee7000-aaaa-4bbb-8ccc-000000000001';
const R1 = 'd24c4c9b-1111-4222-8333-444455556666';
const R2 = '5e6f7a8b-1111-4222-8333-444455556666';
const R3 = '0a1b2c3d-1111-4222-8333-444455556666';

const call = (name: string, args: Record<string, unknown> = {}) => ({ type: 'tool_call', name, args });
const res = (name: string, result: unknown) => ({ type: 'tool_result', name, result: typeof result === 'string' ? result : JSON.stringify(result) });

const savedEnv = process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
  else process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = savedEnv;
});

describe('harnessReceiptsView — the wake\'s real mutating calls from the harness record', () => {
  const parts = [
    call('get_chat_status', { chatId: LANE }), res('get_chat_status', { ok: true }),
    call('send_chat_message', { chatId: LANE, content: 'steer' }),
    res('send_chat_message', { ok: true, tool: 'send_chat_message', ids: { chatId: LANE }, receiptId: R1 }),
    call('update_supervisor_state', { patch: {} }), res('update_supervisor_state', { ok: true }),
    call('todo_update', { id: '7c1e5b9f-0000-4000-8000-000000000001', status: 'done' }),
    res('todo_update', { ok: true, ids: { todoId: '7c1e5b9f-0000-4000-8000-000000000001' }, receiptId: R2 }),
    call('send_chat_message', { chatId: SELF, content: 'note to self' }),
    res('send_chat_message', { ok: true, ids: { chatId: SELF }, receiptId: R3 }),
    call('schedule_message', { chatId: LANE, prompt: 'p' }), res('schedule_message', { ok: false, needsConfirmation: true, confirmationId: 'cf_1' }),
  ];
  const receipts = [
    { id: R1, tool: 'send_chat_message', ok: true, ids: { chatId: LANE } },
    { id: R2, tool: 'todo_update', ok: true, ids: { todoId: '7c1e5b9f-0000-4000-8000-000000000001' } },
    { id: R3, tool: 'send_chat_message', ok: true, ids: { chatId: SELF } },
    { id: 'aaaa1111-0000-4000-8000-000000000009', tool: 'schedule_message', ok: false, ids: { staged: true, confirmationId: 'cf_1' } },
  ];

  it('lists executed real actions with target + receipt id8; housekeeping, reads and self-sends never count; a staged card is not executed', () => {
    const view = harnessReceiptsView({ parts, receipts, sessionId: SELF, isAction: isRealActionTool });
    expect(view.actions.map(renderHarnessActionLine)).toEqual([
      '- send_chat_message → chat 9e39ec5c · receipt d24c4c9b',
      '- todo_update → todo 7c1e5b9f · receipt 5e6f7a8b',
    ]);
    expect(view.notExecuted).toEqual([expect.objectContaining({ tool: 'schedule_message', executed: false, staged: true })]);
    expect(view.reportUps).toEqual([]);
  });

  it('the vocabulary is decision-outcome-labels realActionToolNames (parity on every executed call)', () => {
    const view = harnessReceiptsView({ parts, receipts, sessionId: SELF, isAction: isRealActionTool });
    const executedOrStaged = [...view.actions, ...view.notExecuted].map((c) => c.tool).sort();
    expect(executedOrStaged).toEqual([...realActionToolNames(parts, SELF)].sort());
  });

  it('a project supervisor\'s send to the Fleet Supervisor is a report-up, kept apart from lane actions', () => {
    const p = [call('send_chat_message', { chatId: FLEET, content: 'goal moved' }), res('send_chat_message', { ok: true, ids: { chatId: FLEET }, receiptId: R1 })];
    const view = harnessReceiptsView({ parts: p, receipts: [], sessionId: SELF, reportUpTargetChatId: FLEET, isAction: isRealActionTool });
    expect(view.actions).toEqual([]);
    expect(view.reportUps).toEqual([expect.objectContaining({ tool: 'send_chat_message', target: 'chat f1ee7000', receiptId: 'd24c4c9b', reportUp: true })]);
  });

  it('pairs a prose result with its receipt by tool order; a call that never answered is not executed; junk input ⇒ empty view', () => {
    const p = [call('flag_owner_question', { question: 'q' }), res('flag_owner_question', 'Flagged question oq_abc123 for the owner.'), call('goal_update', { id: 'g1' })];
    const view = harnessReceiptsView({ parts: p, receipts: [], sessionId: SELF, isAction: isRealActionTool });
    expect(view.actions.map((a) => a.tool)).toEqual(['flag_owner_question']);
    expect(view.actions[0].receiptId).toBeNull();
    expect(view.notExecuted.map((a) => a.tool)).toEqual(['goal_update']);
    expect(harnessReceiptsView({ parts: 'junk', isAction: isRealActionTool })).toEqual({ actions: [], reportUps: [], notExecuted: [] });
    // a refusal prose / an {error} body is not an execution
    const r = harnessReceiptsView({ parts: [call('goal_update', { id: 'g' }), res('goal_update', 'Tool goal_update failed: nope'), call('todo_update', { id: 't' }), res('todo_update', { error: 'supervisor_only' })], isAction: isRealActionTool });
    expect(r.actions).toEqual([]);
    expect(r.notExecuted.map((c) => c.tool)).toEqual(['goal_update', 'todo_update']);
  });

  it('a goal_update whose only field was a REFUSED ranking write is "Not executed", with or without its receipt (interaction fix 2026-10-20)', () => {
    const G = 'abcd1234-0000-4000-8000-000000000001';
    const noop = { id: G, title: 'Ship it', priority: 1, prioritySource: 'owner', priorityNote: "priority/dueAt NOT changed: … The owner's P1 stands.", rankingApplied: false, changed: false };
    const p = [call('goal_update', { goalId: G, priority: 4 }), res('goal_update', noop)];
    for (const receipts of [[], [{ id: R1, tool: 'goal_update', ok: false, ids: { goalId: G, rankingRefused: true } }]]) {
      const view = harnessReceiptsView({ parts: p, receipts, sessionId: SELF, isAction: isRealActionTool });
      expect(view.actions).toEqual([]);
      expect(view.notExecuted).toEqual([expect.objectContaining({ tool: 'goal_update', target: 'goal abcd1234', executed: false, staged: false })]);
      const a = applyHarnessReceipts('Bench goal is the owner\'s P1; left as is.', view, {});
      expect(a.harnessActions).toBe(0);
      expect(a.text).toMatch(/Not executed \(harness\): goal_update → goal abcd1234 \(refused or failed\)/);
      expect(a.text).not.toContain(HARNESS_ACTIONS_HEADER);
    }
    // A refusal beside a real write (no changed:false) is an executed action.
    const { changed: _c, ...applied } = noop;
    const v2 = harnessReceiptsView({ parts: [call('goal_update', { goalId: G, title: 'x', priority: 4 }), res('goal_update', applied)], receipts: [], sessionId: SELF, isAction: isRealActionTool });
    expect(v2.actions.map((c) => c.tool)).toEqual(['goal_update']);
  });
});

describe('stripModelActionsBlock — the model-typed block goes; the model\'s own words stay', () => {
  it('strips the doctrine block (header + bullets) and keeps the deltas and the Receipts line', () => {
    const note = [
      '**CanLaw** — eval moved 61.2 → 63.0 % (ETA ~2 h).',
      'Receipts: msg 16ad4828',
      '',
      'ACTIONS TAKEN',
      '- Resolved duplicate ticket 9c307167 via filer self-close — receipt ticket 9c307167',
      '- steered lane Benchmarks — msg ab12cd34',
    ].join('\n');
    const s = stripModelActionsBlock(note);
    expect(s.text).toBe('**CanLaw** — eval moved 61.2 → 63.0 % (ETA ~2 h).\nReceipts: msg 16ad4828');
    expect(s.strippedLines).toBe(3);
  });

  it('covers the paraphrased headers (bold, heading, receipt-count, same-line item, plain paragraph) and copied harness lines', () => {
    expect(stripModelActionsBlock('Deltas.\n\n**ACTIONS TAKEN (2):**\n1. sent X\n2) armed Y').text).toBe('Deltas.');
    expect(stripModelActionsBlock('Deltas.\n## Actions taken\n- one').text).toBe('Deltas.');
    // never across a blank line (review fix 2026-10-20): a later list is not the block's
    expect(stripModelActionsBlock('Deltas.\n**Actions (2, with receipts):**\n- a\n\n- b').text).toBe('Deltas.\n\n- b');
    expect(stripModelActionsBlock('Deltas.\nACTIONS TAKEN — Routed 5 fleet items to lanes').text).toBe('Deltas.');
    expect(stripModelActionsBlock('Deltas.\nACTIONS TAKEN\nSteered lane X (msg 12345678).\n\nNext: watch.').text).toBe('Deltas.\n\nNext: watch.');
    expect(stripModelActionsBlock(`Deltas.\n\n${HARNESS_ACTIONS_HEADER}\n- send_chat_message → chat 1a2b3c4d · receipt 5e6f7a8b`).text).toBe('Deltas.');
    expect(stripModelActionsBlock(`Deltas.\n\n${HARNESS_NOOP_LINE}`).text).toBe('Deltas.');
  });

  it('never touches prose, blockquoted audit quotes, the close markers, a later section or a report of a LANE\'s actions', () => {
    const prose = 'Actions taken by the lane were good; no ACTIONS TAKEN this sweep.\n> ACTIONS TAKEN\n> - quoted';
    expect(stripModelActionsBlock(prose)).toEqual({ text: prose, strippedLines: 0, forgedLines: 0 });
    const laneReport = '**Actions taken by the CanLaw lane:**\n- merged PR #12\nACTIONS TAKEN BY LANES\n- x';
    expect(stripModelActionsBlock(laneReport)).toEqual({ text: laneReport, strippedLines: 0, forgedLines: 0 });
    expect(stripModelActionsBlock('ACTIONS TAKEN\n- a\nWAKE: reported — x sent up').text).toBe('WAKE: reported — x sent up');
    expect(stripModelActionsBlock('ACTIONS TAKEN\n- a\n\n**Next**\n- b').text).toBe('**Next**\n- b');
  });

  // Review fixes 2026-10-20 — the first cut ate owner-facing lines beside the block (reproduced cases).
  it('(a) an owner question right under a bare header + one item line survives', () => {
    const note = 'CanLaw: eval at 61%.\n\nACTIONS TAKEN\nSteered CanLaw lane… (receipt ab12cd34).\nOWNER QUESTION: approve the Hyperstack move? Needs your yes by 18:00.';
    const s = stripModelActionsBlock(note);
    expect(s.text).toBe('CanLaw: eval at 61%.\n\nOWNER QUESTION: approve the Hyperstack move? Needs your yes by 18:00.');
    expect(s.strippedLines).toBe(2);
  });

  it('(b) a header with a same-line item takes no un-bulleted line after it ("Needs you" survives)', () => {
    expect(stripModelActionsBlock('Status.\nACTIONS TAKEN: steered lane (receipt ab12cd34)\nNeeds you: approve spend for H100 — blocking.').text)
      .toBe('Status.\nNeeds you: approve spend for H100 — blocking.');
    expect(stripModelActionsBlock('Status: lane green.\nACTIONS TAKEN: steered CanLaw to rerun eval (receipt abcd1234)\nNext: wait for eval result, ETA 2h.\nOwner: nothing needed.'))
      .toEqual({ text: 'Status: lane green.\nNext: wait for eval result, ETA 2h.\nOwner: nothing needed.', strippedLines: 1, forgedLines: 0 });
  });

  it('(c) a digest-shaped "ACTIONS TAKEN (last 24h)" list stops at the blank line — the open owner item stays', () => {
    const digest = 'Daily digest — fleet\n\nACTIONS TAKEN (last 24h):\n- CanLaw lane merged PR #338\n- spark lane re-ran bench…\n\n- Open: Hyperstack directive awaiting your wording\n\nWAKE: done';
    expect(stripModelActionsBlock(digest).text).toBe('Daily digest — fleet\n\n- Open: Hyperstack directive awaiting your wording\n\nWAKE: done');
  });

  it('an owner-facing line ends the block (never taken); an owner-cue header is no block; an action line merely naming the owner goes with it', () => {
    expect(stripModelActionsBlock('ACTIONS TAKEN\n- steered lane X (msg 12345678)\n- Should we move the run to the H100 box?\n- armed schedule').text)
      .toBe('- Should we move the run to the H100 box?\n- armed schedule');
    const ask = 'ACTIONS TAKEN: none — needs your approval for the H100 spend\n- held the lane';
    expect(stripModelActionsBlock(ask)).toEqual({ text: ask, strippedLines: 0, forgedLines: 0 });
    expect(stripModelActionsBlock('ACTIONS TAKEN\n- answered owner (receipt 1a2b3c4d)').text).toBe('');
    expect(stripModelActionsBlock('Note.\nACTIONS TAKEN\n- flag_owner_question → q1 (receipt 1a2b3c4d)').text).toBe('Note.');
  });

  it('an indented continuation of a bullet goes with it; a bare header takes ONE item line, never a paragraph', () => {
    expect(stripModelActionsBlock('Note.\nACTIONS TAKEN\n- steered lane X — told it\n  to rerun the eval (msg 12345678)\nNext: watch.').text).toBe('Note.\nNext: watch.');
    expect(stripModelActionsBlock('Note.\nACTIONS TAKEN\nSteered lane X.\nThe eval is at 61% and climbing.').text).toBe('Note.\nThe eval is at 61% and climbing.');
  });

  it('the markdown-repaired doctrine shape (a blank between a BARE header and its first bullet) still strips; no other gap does', () => {
    expect(stripModelActionsBlock('ACTIONS TAKEN\n\n- answered owner (receipt 1a2b3c4d)').text).toBe('');
    expect(stripModelActionsBlock('Deltas.\n\n**ACTIONS TAKEN**\n\n- steered X\n- armed Y\n\n- Open: Z')).toEqual({ text: 'Deltas.\n\n- Open: Z', strippedLines: 4, forgedLines: 0 });
    // a same-line-item header takes no gap; a gap before an owner-facing bullet or an un-bulleted line is not taken
    expect(stripModelActionsBlock('ACTIONS TAKEN: steered X\n\n- Open: Z').text).toBe('- Open: Z');
    expect(stripModelActionsBlock('ACTIONS TAKEN\n\n- Needs you: approve the spend').text).toBe('- Needs you: approve the spend');
    expect(stripModelActionsBlock('ACTIONS TAKEN\n\nSteered lane X.').text).toBe('Steered lane X.');
  });

  it('a copied harness line is stripped in both wordings (pre- and post-2026-10-20)', () => {
    expect(stripModelActionsBlock('Narration.\nWAKE: no-op (harness: 0 mutating calls)').text).toBe('Narration.');
    expect(stripModelActionsBlock('Narration.\nHarness record: 0 mutating calls this wake.').text).toBe('Narration.');
    expect(stripModelActionsBlock(`Narration.\n${HARNESS_RECORD_ZERO_LINE}`).text).toBe('Narration.');
  });

  it('parts: model text parts stripped; guard / struck parts untouched; same array when nothing changed', () => {
    const parts = [{ type: 'tool_call', name: 'x' }, { type: 'text', text: 'Hi\nACTIONS TAKEN\n- a' }, { type: 'text', marker: 'guard', text: 'ACTIONS TAKEN\n- g' }];
    const out = stripModelActionsBlockFromParts(parts);
    expect(out.parts[1]).toEqual({ type: 'text', text: 'Hi' });
    expect(out.parts[2]).toBe(parts[2]);
    const clean = [{ type: 'text', text: 'Hi' }];
    expect(stripModelActionsBlockFromParts(clean).parts).toBe(clean);
  });
  it('stripModelActionsBlock counts model-typed copies of harness lines apart from an ACTIONS TAKEN block (footnote wording)', () => {
    expect(stripModelActionsBlock('Status: green.\n\nWAKE: no-op (harness: 0 lane actions)')).toEqual({ text: 'Status: green.', strippedLines: 1, forgedLines: 1 });
    expect(stripModelActionsBlock('Status: green.\n\nACTIONS TAKEN\n- steered X\nNot executed (harness): y')).toEqual({ text: 'Status: green.', strippedLines: 3, forgedLines: 1 });
    expect(stripModelActionsBlock('Status: green.\n\nACTIONS TAKEN\n- steered X').forgedLines).toBe(0);
  });
});

describe('applyHarnessReceipts — the harness writes the receipts', () => {
  const view = (over: Partial<HarnessReceiptsView> = {}): HarnessReceiptsView => ({ actions: [], reportUps: [], notExecuted: [], ...over });
  const act = { tool: 'send_chat_message', target: 'chat 9e39ec5c', receiptId: 'd24c4c9b', executed: true, staged: false, reportUp: false };

  it('executed calls ⇒ the ACTIONS TAKEN (harness) block, one line per call', () => {
    const a = applyHarnessReceipts('Lane steered toward the eval fix.', view({ actions: [act] }));
    expect(a.text).toBe(`Lane steered toward the eval fix.\n\n${HARNESS_ACTIONS_HEADER}\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b`);
    expect(a).toEqual(expect.objectContaining({ mode: 'actions', harnessActions: 1 }));
  });

  it('zero calls ⇒ the single no-op line — unless the note already closes no-op, answers an owner ask or carries the reported shape', () => {
    expect(applyHarnessReceipts('Long narration of the fleet…', view()).text).toBe(`Long narration of the fleet…\n\n${HARNESS_NOOP_LINE}`);
    const quiet = applyHarnessReceipts('WAKE: no-op — nothing moved on any project since the previous wake', view());
    expect(quiet).toEqual(expect.objectContaining({ mode: 'noop_present', appendix: '', text: 'WAKE: no-op — nothing moved on any project since the previous wake' }));
    expect(applyHarnessReceipts('Here is the status you asked for.', view(), { quietZero: true }).text).toBe(`Here is the status you asked for.\n\n${HARNESS_RECORD_ZERO_LINE}`);
    expect(applyHarnessReceipts('WAKE: reported — PR #12 sent to the Fleet Supervisor; no lane action', view()).mode).toBe('record');
    expect(applyHarnessReceipts('', view()).text).toBe(HARNESS_NOOP_LINE);
  });

  it('report-up only ⇒ the reported close (or a report-up line under a note that already says reported); staged ⇒ a not-executed line', () => {
    const up = { ...act, target: 'chat f1ee7000', reportUp: true };
    const r = applyHarnessReceipts('Goal moved.', view({ reportUps: [up] }));
    expect(r.mode).toBe('reported');
    expect(r.appendix).toMatch(/^WAKE: reported \(harness: 0 lane actions; 1 report-up to the Fleet Supervisor — send_chat_message → chat f1ee7000 · receipt d24c4c9b\)$/);
    expect(applyHarnessReceipts('WAKE: reported — goal moved', view({ reportUps: [up] })).appendix).toMatch(/^Reported up \(harness\): send_chat_message/);
    const staged = applyHarnessReceipts('Asked for a card.', view({ notExecuted: [{ ...act, tool: 'schedule_message', executed: false, staged: true }] }));
    expect(staged.appendix).toBe('WAKE: no-op (harness: 0 lane actions executed)\nNot executed (harness): schedule_message → chat 9e39ec5c (staged on a confirmation card)');
  });

  it('caps the action lines and stamps a bounded metadata record', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...act, receiptId: `0000000${i % 10}` }));
    const a = applyHarnessReceipts('x', view({ actions: many }));
    expect(a.appendix.split('\n')).toHaveLength(1 + 10 + 1);
    expect(a.appendix).toContain('- +3 more');
    expect(harnessReceiptsMeta(a, 4)).toEqual({ v: 1, mode: 'actions', reportUps: 0, notExecuted: 0, modelBlockLines: 4 });
  });
});

describe('classification from the harness record', () => {
  it('harnessNoteKind reads metadata.harnessActions; null without it or under the kill switch', () => {
    expect(harnessNoteKind({ harnessActions: 2 })).toBe('supervisor_action');
    expect(harnessNoteKind({ harnessActions: 0, harnessReceipts: { mode: 'noop' } })).toBe('supervisor_noop');
    expect(harnessNoteKind({ harnessActions: 0, harnessReceipts: { mode: 'reported', reportUps: 1 } })).toBe('supervisor_report_up');
    expect(harnessNoteKind({ harnessActions: 0, harnessReceipts: { mode: 'record' } })).toBe('supervisor_note');
    expect(harnessNoteKind({ origin: 'hook' })).toBeNull();
    expect(harnessNoteKind(null)).toBeNull();
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    expect(harnessNoteKind({ harnessActions: 2 })).toBeNull();
    expect(supervisorHarnessReceiptsDisabled()).toBe(true);
  });

  it('harnessLineKind: the harness block wins over a model no-op marker; null without a harness line', () => {
    expect(harnessLineKind(`WAKE: no-op — nothing moved\n\n${HARNESS_ACTIONS_HEADER}\n- send_chat_message → chat 1 · receipt 2`)).toBe('supervisor_action');
    expect(harnessLineKind(`Narration\n\n${HARNESS_NOOP_LINE}`)).toBe('supervisor_noop');
    expect(harnessLineKind('Goal moved.\n\nWAKE: reported (harness: 0 lane actions; 1 report-up …)')).toBe('supervisor_note');
    expect(harnessLineKind('ACTIONS TAKEN\n- typed by the model')).toBeNull();
  });

  const emptyView = (): HarnessReceiptsView => ({ actions: [], reportUps: [], notExecuted: [] });
  // Follow-through minors (2026-10-22): the neutral record line is appended ONLY in mode 'record' (an owner-ask
  // answer, an answer-first follow-through round, a reported-shape note with no send) — it reads as a plain note,
  // matching harnessNoteKind, never the ≤200-char no-op fall-through of a content-only classifier.
  it("harnessLineKind: the neutral 'Harness record:' line reads 'supervisor_note' (mode 'record'); the follow-through switch restores null", () => {
    const shortResult = `Read back the reply: plan accepted.\n\n${HARNESS_RECORD_ZERO_LINE}`;
    expect(harnessLineKind(shortResult)).toBe('supervisor_note');
    expect(harnessLineKind(`Narration.\n\nHarness record: 0 mutating calls this wake.`)).toBe('supervisor_note'); // pre-rewording rows
    // the record line is exactly what applyHarnessReceipts appends in mode 'record' — and only there
    const rec = applyHarnessReceipts('Read back the reply: plan accepted.', emptyView(), { quietZero: true });
    expect(rec.mode).toBe('record');
    expect(harnessLineKind(rec.text)).toBe('supervisor_note');
    expect(harnessNoteKind({ harnessActions: 0, harnessReceipts: harnessReceiptsMeta(rec, 0) })).toBe('supervisor_note');
    // a genuine no-op wake never carries it: mode 'noop' appends the WAKE no-op line, 'noop_present' appends nothing
    const noop = applyHarnessReceipts('All lanes healthy.', emptyView());
    expect(noop.mode).toBe('noop');
    expect(noop.text).not.toContain('Harness record:');
    expect(harnessLineKind(noop.text)).toBe('supervisor_noop');
    const present = applyHarnessReceipts('WAKE: no-op — nothing moved', emptyView(), { quietZero: true });
    expect(present.mode).toBe('noop_present');
    expect(present.text).not.toContain('Harness record:');
    expect(harnessLineKind(present.text)).toBeNull();
    // a sentence that merely mentions the record mid-line is no harness line
    expect(harnessLineKind('The Harness record: line is neutral.')).toBeNull();
    try {
      process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED = '1';
      expect(harnessLineKind(shortResult)).toBeNull();
      expect(harnessLineKind(`Narration\n\n${HARNESS_NOOP_LINE}`)).toBe('supervisor_noop');
    } finally {
      delete process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED;
    }
    try {
      process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
      expect(harnessLineKind(shortResult)).toBeNull();
    } finally {
      delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    }
  });

  it("stripTrailingNoopCloseLine: removes ONLY the model's trailing WAKE/SWEEP no-op close line(s)", () => {
    expect(stripTrailingNoopCloseLine('Read back the reply: plan accepted.\n\nWAKE: no-op — nothing moved')).toMatchObject({ text: 'Read back the reply: plan accepted.', strippedLines: 1 });
    expect(stripTrailingNoopCloseLine('Done.\n**WAKE: no-op** — nothing moved since your answer.\n\n').text).toBe('Done.');
    expect(stripTrailingNoopCloseLine('Done.\n- SWEEP: no-op\n\nWAKE: no-op — nothing moved')).toMatchObject({ text: 'Done.', strippedLines: 2 });
    // never a line in the middle, never a mid-line quote, never anything else
    const mid = 'WAKE: no-op — nothing moved\n\nThen the lane replied: plan accepted.';
    expect(stripTrailingNoopCloseLine(mid)).toMatchObject({ text: mid, strippedLines: 0 });
    const quoted = "The lane closed with 'WAKE: no-op' — it had nothing to do.";
    expect(stripTrailingNoopCloseLine(quoted)).toMatchObject({ text: quoted, strippedLines: 0 });
    const reported = 'Goal moved.\n\nWAKE: reported — sent up';
    expect(stripTrailingNoopCloseLine(reported).text).toBe(reported);
    // the harness's OWN zero-action line is never the model's close (phase 2 owns it)
    const harnessLine = `Read back the reply.\n\n${HARNESS_NOOP_LINE}`;
    expect(stripTrailingNoopCloseLine(harnessLine)).toMatchObject({ text: harnessLine, strippedLines: 0 });
    // a stripped round then gets the neutral record (mode 'record') instead of 'noop_present'
    const stripped = stripTrailingNoopCloseLine('Read back the reply.\n\nWAKE: no-op — nothing moved').text;
    expect(applyHarnessReceipts(stripped, emptyView(), { quietZero: true })).toMatchObject({ mode: 'record', text: `Read back the reply.\n\n${HARNESS_RECORD_ZERO_LINE}` });
  });

  // Review fix (2026-10-22 minors, item 1): a round made ONLY of the no-op close was stripped to '' — the row became
  // the bare 'Harness record:' line, no longer a no-op reply, and the owner ask closed on a content-free bubble.
  it('stripTrailingNoopCloseLine never strips a note to nothing: a bare close (marker + its boilerplate) stays whole', () => {
    for (const bare of [
      'WAKE: no-op — nothing moved',
      'WAKE: no-op',
      '**WAKE: no-op** — nothing moved since your answer.',
      'WAKE: no-op — nothing moved in the fleet since the previous wake',
      'SWEEP: no-op — ledger unchanged.',
      'WAKE: no-op (nothing to do this wake)',
      'WAKE: no-op — nothing moved\nReceipts: none',
      'WAKE: no-op — nothing moved\n\n[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]\nThis note was delivered as written.',
    ]) {
      expect(stripTrailingNoopCloseLine(bare)).toMatchObject({ text: bare, strippedLines: 0, edits: [] });
    }
  });

  // Re-review fix (2026-10-23): a "reason" that is itself wake.close boilerplate was kept as the reason — the chained
  // close 'nothing moved since your answer; no lane action' became the row 'No lane action' + the record line, no
  // longer a no-op reply, and the owner ask closed on a content-free bubble (item 1 again, other wording).
  it('stripTrailingNoopCloseLine: a CHAINED close (boilerplate after boilerplate, a trailing separator) is bare — never a reason', () => {
    for (const bare of [
      'WAKE: no-op — nothing moved since your answer; no lane action',
      'WAKE: no-op — nothing moved since your answer; nothing to report',
      'WAKE: no-op — nothing moved since your answer; no lane action needed.',
      'WAKE: no-op — nothing moved since your answer; ledger unchanged',
      'WAKE: no-op — nothing moved since your answer; all quiet.',
      'WAKE: no-op — nothing moved since your answer; idle',
      'WAKE: no-op — nothing moved since your answer; no new receipts',
      'WAKE: no-op — nothing moved on any project since the previous wake; no lane action',
      'WAKE: no-op — nothing moved; ',
      'WAKE: no-op — nothing moved,',
      'WAKE: no-op — nothing moved since your answer; no lane action; ledger unchanged.',
      'WAKE: no-op — nothing moved since your answer. No lane action needed.',
      '**WAKE: no-op** — **nothing moved** since your answer; **no lane action**',
      'SWEEP: no-op — ledger unchanged; nothing to do —',
    ]) {
      expect(stripTrailingNoopCloseLine(bare)).toMatchObject({ text: bare, strippedLines: 0, edits: [] });
      // under the model's own words the chained bare close goes whole (no boilerplate left behind as a "reason")
      expect(stripTrailingNoopCloseLine(`Read back the reply.\n\n${bare}`)).toMatchObject({ text: 'Read back the reply.', strippedLines: 1, reasonLines: 0 });
    }
    // a real reason after a chain of boilerplate is still kept (every leading clause goes)
    expect(stripTrailingNoopCloseLine('WAKE: no-op — nothing moved since your answer; no lane action; the tt-rd supervisor has not replied yet').text)
      .toBe('The tt-rd supervisor has not replied yet');
    expect(stripTrailingNoopCloseLine('WAKE: no-op — nothing moved. No lane action. The lane is idle').text).toBe('The lane is idle');
  });

  it('stripTrailingNoopCloseLine keeps the REASON a close carries, as plain text — only the marker and its boilerplate go', () => {
    const r = stripTrailingNoopCloseLine('WAKE: no-op — nothing moved since your answer; the tt-rd supervisor has not replied yet');
    expect(r).toMatchObject({ text: 'The tt-rd supervisor has not replied yet', strippedLines: 1, reasonLines: 1 });
    expect(r.edits).toEqual([{ kind: 'marker', line: 'WAKE: no-op — nothing moved since your answer; the tt-rd supervisor has not replied yet', replacement: 'The tt-rd supervisor has not replied yet' }]);
    expect(stripTrailingNoopCloseLine('Checked the lane.\n\nWAKE: no-op — nothing moved in the fleet since the previous wake — waiting on the CanLaw reply.').text)
      .toBe('Checked the lane.\n\nWaiting on the CanLaw reply.');
    // no boilerplate to cut: the whole sentence after the marker is the reason
    expect(stripTrailingNoopCloseLine('WAKE: no-op — the tt-rd supervisor has not replied yet.').text).toBe('The tt-rd supervisor has not replied yet.');
    expect(stripTrailingNoopCloseLine('WAKE: no-op — nothing moved, the lane is still compiling').text).toBe('Nothing moved, the lane is still compiling');
    // the boilerplate's where / since clauses never swallow a reason past a sentence end or a spaced hyphen
    expect(stripTrailingNoopCloseLine('WAKE: no-op — nothing moved since 18:00Z. The lane is idle').text).toBe('The lane is idle');
    expect(stripTrailingNoopCloseLine('WAKE: no-op — nothing moved since your answer - tt-rd is idle').text).toBe('tt-rd is idle');
    expect(stripTrailingNoopCloseLine('**WAKE: no-op** — **nothing moved** since your answer; the lane is idle').text).toBe('The lane is idle');
    expect(stripTrailingNoopCloseLine('Done.\n\n_WAKE: no-op_ — nothing moved').text).toBe('Done.');
    // emphasis / parentheses closing the marker never dangle; a list item / quote keeps its chrome, a heading drops it
    expect(stripTrailingNoopCloseLine('**WAKE: no-op — the lane is idle**').text).toBe('The lane is idle');
    expect(stripTrailingNoopCloseLine('WAKE: no-op (tt-rd has not replied)').text).toBe('tt-rd has not replied');
    expect(stripTrailingNoopCloseLine('Done:\n- item one\n- **WAKE: no-op** — waiting on tt-rd').text).toBe('Done:\n- item one\n- Waiting on tt-rd');
    expect(stripTrailingNoopCloseLine('> WAKE: no-op — waiting on tt-rd').text).toBe('> Waiting on tt-rd');
    expect(stripTrailingNoopCloseLine('Done.\n\n## WAKE: no-op — waiting on tt-rd').text).toBe('Done.\n\nWaiting on tt-rd');
    // the applied record then follows the reason (mode 'record'), never 'noop_present'
    expect(applyHarnessReceipts(r.text, emptyView(), { quietZero: true })).toMatchObject({ mode: 'record', text: `The tt-rd supervisor has not replied yet\n\n${HARNESS_RECORD_ZERO_LINE}` });
  });

  // Review fix (item 3): the variants that still reached the owner.
  it('stripTrailingNoopCloseLine variants: a Receipts line under the close, heading / quote / bullet chrome, a harness trailer after it', () => {
    const R = 'Read back the reply: plan accepted.';
    // the close's own empty Receipts line goes with it; a Receipts line that names receipts stays
    expect(stripTrailingNoopCloseLine(`${R}\n\nWAKE: no-op — nothing moved\nReceipts: none`)).toMatchObject({ text: R, strippedLines: 1 });
    expect(stripTrailingNoopCloseLine(`${R}\n\n**WAKE: no-op** — nothing moved\n**Receipts:** —`).text).toBe(R);
    expect(stripTrailingNoopCloseLine(`${R}\n\nWAKE: no-op — nothing moved\nReceipts: get_chat_status d24c4c9b`).text).toBe(`${R}\n\nReceipts: get_chat_status d24c4c9b`);
    for (const chrome of ['## ', '### ', '> ', '- ', '* ', '1. ', '> **']) {
      expect(stripTrailingNoopCloseLine(`${R}\n\n${chrome}WAKE: no-op${chrome.endsWith('**') ? '**' : ''} — nothing moved`).text).toBe(R);
    }
    // harness trailers appended before the strip (struck-repeat / computer-claim annotation, claims-lane note,
    // deferral note) are skipped — the close above them goes, the trailer stays last
    const trailers = [
      `${UNVERIFIED_FOOTNOTE_HEADER}\nThis note was delivered as written. It is a near-verbatim copy (93% the same, timestamps aside) of the previous note.\nTreat its claims as unverified until a fresh tool result confirms them; nothing above was removed or changed.`,
      `${UNVERIFIED_FOOTNOTE_HEADER}\nThis note was delivered as written. It says it acted on the screen this turn (1 line(s)), but this run made no computer_task call:\n- [screen input] "Clicked Record."`,
      '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]\nThe typed claims block could not be parsed.',
      '[harness — deferred-action note] This note defers an action ("next wake") but armed no schedule and messaged no lane.',
    ];
    for (const t of trailers) {
      expect(stripTrailingNoopCloseLine(`${R}\n\nWAKE: no-op — nothing moved\n\n${t}`)).toMatchObject({ text: `${R}\n\n${t}`, strippedLines: 1 });
      expect(stripTrailingNoopCloseLine(`${R}\n\nWAKE: no-op — nothing moved\nReceipts: none\n\n${t}\n\n${trailers[2]}`).text).toBe(`${R}\n\n${t}\n\n${trailers[2]}`);
    }
    // a trailer alone (no close above it) changes nothing; a model paragraph after the close stops the walk
    const noClose = `${R}\n\n${trailers[0]}`;
    expect(stripTrailingNoopCloseLine(noClose)).toMatchObject({ text: noClose, strippedLines: 0 });
    const prose = `${R}\n\nWAKE: no-op — nothing moved\n\nOne more thing: the lane asked for the key.`;
    expect(stripTrailingNoopCloseLine(prose)).toMatchObject({ text: prose, strippedLines: 0 });
    expect(isHarnessTrailerBlock(trailers[0])).toBe(true);
    expect(isHarnessTrailerBlock('Plain model words.')).toBe(false);
  });

  it('stripTrailingNoopCloseLineFromParts: the trailing model text parts (a raw [FOLLOWUPS] tail kept); tool / guard / struck parts never touched', () => {
    const parts = [call('get_chat_status', {}), res('get_chat_status', { ok: true }), { type: 'text', text: 'Read back the reply.\n\nWAKE: no-op — nothing moved' }, { type: 'reasoning', text: 'x' }, { type: 'text', text: '\n' }];
    const out = stripTrailingNoopCloseLineFromParts(parts);
    expect(out.strippedLines).toBe(1);
    expect((out.parts[2] as any).text).toBe('Read back the reply.');
    expect((parts[2] as any).text).toContain('WAKE: no-op'); // input untouched
    const fu = stripTrailingNoopCloseLineFromParts([{ type: 'text', text: 'Done.\nWAKE: no-op — nothing moved\n[FOLLOWUPS]\n- next?\n[/FOLLOWUPS]' }]);
    expect((fu.parts[0] as any).text).toBe('Done.\n[FOLLOWUPS]\n- next?\n[/FOLLOWUPS]');
    const guard = [{ type: 'text', text: 'WAKE: no-op — nothing moved', marker: 'guard' }];
    expect(stripTrailingNoopCloseLineFromParts(guard).parts).toBe(guard);
    const toolLast = [{ type: 'text', text: 'Read back the reply.\n\nWAKE: no-op — nothing moved' }, call('get_chat_status', {})];
    expect(stripTrailingNoopCloseLineFromParts(toolLast).parts).toBe(toolLast);
    const none = [{ type: 'text', text: 'Read back the reply.' }];
    expect(stripTrailingNoopCloseLineFromParts(none)).toEqual({ parts: none, strippedLines: 0 });
    // a bare close in its own part keeps it (the note would be empty)
    const bare = [{ type: 'text', text: 'WAKE: no-op — nothing moved' }];
    expect(stripTrailingNoopCloseLineFromParts(bare).parts).toBe(bare);
  });

  // Review fix (item 3): a claims-lane notes part (or any harness trailer part) after the model's last part made the
  // last-part walk miss, so the stored parts kept the line the content had dropped.
  it("stripTrailingNoopCloseLineFromParts locates the content strip's own lines — past a trailer part, in a part that is not last", () => {
    const note = 'Read back the reply.\n\nWAKE: no-op — nothing moved since your answer; the tt-rd supervisor has not replied yet';
    const trailer = '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]\nThe typed claims block could not be parsed.';
    const s = stripTrailingNoopCloseLine(`${note}\n\n${trailer}`);
    expect(s.text).toBe(`Read back the reply.\n\nThe tt-rd supervisor has not replied yet\n\n${trailer}`);
    const parts = [{ type: 'text', text: note }, { type: 'text', text: trailer }];
    const located = stripTrailingNoopCloseLineFromParts(parts, s.edits);
    expect(located.strippedLines).toBe(1);
    expect((located.parts[0] as any).text).toBe('Read back the reply.\n\nThe tt-rd supervisor has not replied yet');
    expect(located.parts[1]).toBe(parts[1]);
    // without the edits the walk skips the trailer part too
    expect((stripTrailingNoopCloseLineFromParts(parts).parts[0] as any).text).toBe('Read back the reply.\n\nThe tt-rd supervisor has not replied yet');
    // the line located in an earlier part (a later tool round wrote no text), the Receipts line removed with it
    const s2 = stripTrailingNoopCloseLine('Read back the reply.\n\nWAKE: no-op — nothing moved\nReceipts: none');
    const earlier = [{ type: 'text', text: 'Read back the reply.\n\nWAKE: no-op — nothing moved\nReceipts: none' }, call('get_chat_status', {}), res('get_chat_status', { ok: true })];
    const out = stripTrailingNoopCloseLineFromParts(earlier, s2.edits);
    expect((out.parts[0] as any).text).toBe('Read back the reply.');
    // a guard / struck part never takes an edit
    const struck = [{ type: 'text', text: 'Read back the reply.\n\nWAKE: no-op — nothing moved', struck: true }];
    expect(stripTrailingNoopCloseLineFromParts(struck, s2.edits).parts).toBe(struck);
  });

  it('stripHarnessNoopLines drops ONLY the zero-action lines (the stuck-note backstop) — the harness action block stays', () => {
    expect(stripHarnessNoopLines(`Same narration.\n\n${HARNESS_NOOP_LINE}`)).toBe('Same narration.');
    expect(stripHarnessNoopLines(`Same narration.\n\n${HARNESS_RECORD_ZERO_LINE}`)).toBe('Same narration.');
    const acted = `Steered.\n\n${HARNESS_ACTIONS_HEADER}\n- a → chat 1 · receipt 2\n- b · receipt n/a`;
    expect(stripHarnessNoopLines(acted)).toBe(acted);
    const plain = 'No harness lines here.';
    expect(stripHarnessNoopLines(plain)).toBe(plain);
  });

  // Review fix (2026-10-20): the owner briefing reads the MODEL's words — the harness no-op line parsed as the
  // model's 'WAKE: no-op' and briefed a free-form note as "Nothing new".
  it('stripTrailingHarnessAppendix drops the trailing appendix of every mode (the briefing\'s view) — never to nothing, unchanged without one', () => {
    const note = 'CanLaw eval landed at 0.81 on the det-v2 suite.';
    const act = { tool: 'send_chat_message', target: 'chat 9e39ec5c', receiptId: 'd24c4c9b', executed: true, staged: false, reportUp: false };
    const views: HarnessReceiptsView[] = [
      { actions: [], reportUps: [], notExecuted: [] },
      { actions: [act], reportUps: [], notExecuted: [] },
      { actions: [], reportUps: [{ ...act, reportUp: true }], notExecuted: [] },
      { actions: [], reportUps: [], notExecuted: [{ ...act, executed: false, staged: true }] },
    ];
    for (const v of views) {
      const applied = applyHarnessReceipts(note, v);
      expect(applied.appendix).not.toBe('');
      expect(stripTrailingHarnessAppendix(applied.text)).toBe(note);
    }
    expect(stripTrailingHarnessAppendix(applyHarnessReceipts(note, views[0], { quietZero: true }).text)).toBe(note);
    // A note that is ONLY the record stays the record; a note with no appendix is the same string.
    expect(stripTrailingHarnessAppendix(HARNESS_NOOP_LINE)).toBe(HARNESS_NOOP_LINE);
    const plain = `${note}\n\nWAKE: no-op — nothing moved\n`;
    expect(stripTrailingHarnessAppendix(plain)).toBe(plain);
    // Only the TAIL: a harness line with prose after it is never touched.
    const mid = `${note}\n\n${HARNESS_NOOP_LINE}\n\nMore prose.`;
    expect(stripTrailingHarnessAppendix(mid)).toBe(mid);
  });

  it('splitTrailingHarnessAppendix separates the trailing appendix paragraph; head unchanged without one', () => {
    const note = 'Sweep: lanes green.';
    const applied = applyHarnessReceipts(note, harnessReceiptsView({ parts: [], receipts: [], sessionId: SELF, isAction: isRealActionTool }));
    const split = splitTrailingHarnessAppendix(applied.text);
    expect(split.head).toBe(note);
    expect(split.appendix).toBe(applied.appendix);
    expect(splitTrailingHarnessAppendix(note)).toEqual({ head: note, appendix: '' });
    expect(splitTrailingHarnessAppendix(applied.appendix)).toEqual({ head: applied.appendix, appendix: '' });
  });

  it('isHarnessAppendixBlock / harnessActionLineCount read the harness block (guard-chrome transparency; the status card count)', () => {
    expect(isHarnessAppendixBlock(`${HARNESS_ACTIONS_HEADER}\n- a · receipt 1`)).toBe(true);
    expect(isHarnessAppendixBlock(HARNESS_NOOP_LINE)).toBe(true);
    expect(isHarnessAppendixBlock(HARNESS_RECORD_ZERO_LINE)).toBe(true);
    expect(isHarnessAppendixBlock('WAKE: reported (harness: 0 lane actions; 1 report-up …)')).toBe(true);
    expect(isHarnessAppendixBlock('Not executed (harness): x')).toBe(true);
    expect(isHarnessAppendixBlock('ACTIONS TAKEN\n- typed by the model')).toBe(false);
    expect(isHarnessAppendixBlock('WAKE: no-op — nothing moved')).toBe(false);
    expect(harnessActionLineCount(`${HARNESS_ACTIONS_HEADER}\n- a · receipt 1\n- b · receipt 2\n- +3 more (get_run_receipts lists every receipt)\nReported up (harness): x`)).toBe(5);
    expect(harnessActionLineCount('ACTIONS TAKEN\n- typed')).toBe(0);
  });

  it('the empty-completion retry clause follows the doctrine variant in force', () => {
    expect(wakeNoteRetryCloseClause()).toContain('the harness appends the receipts');
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    expect(wakeNoteRetryCloseClause()).toBe('close with the ACTIONS TAKEN or WAKE: no-op line the doctrine requires');
  });
});
