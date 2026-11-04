/**
 * wake-material-rule.ts — audit 2026-10-08 W6: the ONE deterministic
 * "material change since my last wake" rule, the [SINCE YOUR LAST WAKE]
 * renderer and the continuity-history selector (pure).
 *
 * REPLAY shapes are the real ones from the audit window (owner's own
 * Schooltime project, 2026-10-08): the Drive watch lane 1c2b28d6's hourly
 * "No audio yet" run_completed digests (25 identical wakes, $4.30) and the
 * recorder lane 0037460b's substantive report.
 */

import {
  ELIDED_WAKE_PROMPT, HOOK_STATUS_NO_MATERIAL_CHANGE, MATERIAL_GATE_SUPERSEDED_PURPOSES, WAKE_LEDGER_HEADING, WAKE_LEDGER_MAX_CHARS,
  decideMaterialChange, emptyWakeLedgerDiff, isMachineUserRow, isMaterialLedgerTransition, isNearDuplicate, isNearDuplicateRunSummary, runOutcomeKey, materialGateFloorHours,
  materialGateMode, materialGateSupersedes, normalizeRunSummary, normalizedContainment, renderWakeLedgerDiff, selectWakeContinuityHistory,
  wakeHistoryNotes, wakeLedgerDiffActive, wakeLedgerUnderTest, type WakeLedgerDiff,
  HOOK_STATUS_PROGRESS_SELF_DRIVING, MATERIAL_GATE_SKIP_STATUSES, drawProgressControl, materialTiersDisabled, progressHeartbeatHours,
  progressSkipControlRate, progressSkipDecision, progressSourceLaneIds, reasonTier, statusChangeTier, type LedgerStatusChange,
  laneAskCue, runSummaryAskText,
} from './wake-material-rule';

const ENV_KEYS = [
  'SUPERVISOR_MATERIAL_GATE_DISABLED', 'SUPERVISOR_MATERIAL_GATE_SHADOW', 'SUPERVISOR_MATERIAL_GATE_FLOOR_HOURS',
  'SUPERVISOR_WAKE_LEDGER_DIFF_DISABLED', 'SUPERVISOR_WAKE_LEDGER_IN_TEST', 'SUPERVISOR_WAKE_HISTORY_NOTES',
];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

const DIGEST = (answerId: string, body: string) =>
  `RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0 ANSWER_MSG_ID: ${answerId} — the persisted final answer of this run (the row this digest quotes). When your note references this answer, cite this id's first 8 chars as 'msg <8 chars>'; never invent, reconstruct or lengthen a message id. Coding run completed. Final answer: ${body}`;
// Real 2026-10-08 Drive-watch digests (lane 1c2b28d6 → Schooltime supervisor 41bd202a), one hour apart.
const DRIVE_1414 = DIGEST('220df4b3-1e94-47f4-9439-e7e96d3cb3a9', 'No audio yet, 07:14 AM PDT (14:14Z) — `drive_search` (Personal, "Zoey Rome week audio m4a mp3 wav") → "No files found matching"; harness clock 2026-10-08T14:14:33Z; successor firing 58 of 500, daily 20/48.');
const DRIVE_1514 = DIGEST('c6f80e4b-4f56-4976-b886-4abaa0da33bb', 'No audio yet, 08:14 AM PDT (15:14Z) — `drive_search` (Personal, "Zoey Rome week audio m4a mp3 wav") → "No files found matching"; harness clock 2026-10-08T15:14:31Z; successor firing 59 of 500, daily 21/48.');
const DRIVE_1614 = DIGEST('79e8f434-3657-4b43-bbd8-0245c83cd1ce', 'No audio yet, 09:14 AM PDT (16:14Z) — `drive_search` (Personal, "Zoey Rome week audio m4a mp3 wav") → "No files found matching"; harness clock 2026-10-08T16:14:47Z; successor firing 60 of 500, daily 22/48.');
// Real 2026-10-08 15:08Z recorder-lane digest (0037460b) — a substantive, different report.
const RECORDER_1508 = DIGEST('d14639c8-ae08-44d1-8789-287c6d5be1ba', "Supervisor's edit verified live on my own read-back — **08:08 AM PDT** (15:08Z). `schedule_get 50532ee7` confirms exactly what the supervisor described and nothing else moved: - **Cadence: `recurring every 120m`** — untouched, prompt sha changed `717c0c1e…` → `39eac980…` (prompt-only edit, as stated");

const NOW = new Date('2026-10-08T16:15:00Z');
const HWM_1H = new Date('2026-10-08T15:15:00Z');
const diff = (patch: Partial<WakeLedgerDiff> = {}): WakeLedgerDiff => ({ ...emptyWakeLedgerDiff('41bd202a-7152-437e-bf4b-a097981692b1', HWM_1H, NOW), ...patch });

describe('switches', () => {
  it('under jest (NODE_ENV=test) both features are OFF unless a suite opts in; the kill switch / shadow switch then govern', () => {
    expect(wakeLedgerUnderTest()).toBe(true);
    expect(materialGateMode()).toBe('off');
    expect(wakeLedgerDiffActive()).toBe(false);
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    expect(materialGateMode()).toBe('act');
    expect(wakeLedgerDiffActive()).toBe(true);
    process.env.SUPERVISOR_MATERIAL_GATE_SHADOW = '1';
    expect(materialGateMode()).toBe('shadow');
    process.env.SUPERVISOR_MATERIAL_GATE_DISABLED = '1';
    expect(materialGateMode()).toBe('off');
    process.env.SUPERVISOR_WAKE_LEDGER_DIFF_DISABLED = '1';
    expect(wakeLedgerDiffActive()).toBe(false);
  });

  it('materialGateSupersedes names the four Jev wake purposes only while the gate ACTS', () => {
    expect(MATERIAL_GATE_SUPERSEDED_PURPOSES).toEqual(['wake_triage', 'sweep_triage', 'drain_triage', 'supervisor_turn_noop']);
    expect(materialGateSupersedes('wake_triage')).toBe(false); // under test: off
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    for (const p of MATERIAL_GATE_SUPERSEDED_PURPOSES) expect(materialGateSupersedes(p)).toBe(true);
    expect(materialGateSupersedes('auto_route')).toBe(false);
    expect(materialGateSupersedes('wake_effort')).toBe(false);
    process.env.SUPERVISOR_MATERIAL_GATE_SHADOW = '1';
    expect(materialGateSupersedes('wake_triage')).toBe(false);
  });

  it('floor hours default 4, clamp 1..24; history notes default 3, clamp 1..6; blank = default', () => {
    expect(materialGateFloorHours()).toBe(4);
    process.env.SUPERVISOR_MATERIAL_GATE_FLOOR_HOURS = '0.2'; expect(materialGateFloorHours()).toBe(1);
    process.env.SUPERVISOR_MATERIAL_GATE_FLOOR_HOURS = '99'; expect(materialGateFloorHours()).toBe(24);
    process.env.SUPERVISOR_MATERIAL_GATE_FLOOR_HOURS = ''; expect(materialGateFloorHours()).toBe(4);
    expect(wakeHistoryNotes()).toBe(3);
    process.env.SUPERVISOR_WAKE_HISTORY_NOTES = '9'; expect(wakeHistoryNotes()).toBe(6);
    process.env.SUPERVISOR_WAKE_HISTORY_NOTES = 'x'; expect(wakeHistoryNotes()).toBe(3);
  });
});

describe('near-duplicate summaries (identical summaries collapse)', () => {
  it('REPLAY 2026-10-08: consecutive hourly Drive "No audio yet" digests are near-duplicates once the boilerplate, clocks, counters and ids are folded', () => {
    expect(normalizeRunSummary(DRIVE_1514)).not.toContain('ANSWER_MSG_ID');
    expect(normalizeRunSummary(DRIVE_1514)).toMatch(/^outcome completed verdict n\/a blocking 0 No audio yet/);
    expect(normalizedContainment(normalizeRunSummary(DRIVE_1514), normalizeRunSummary(DRIVE_1414))).toBeGreaterThanOrEqual(0.8);
    expect(isNearDuplicate(normalizeRunSummary(DRIVE_1614), normalizeRunSummary(DRIVE_1514))).toBe(true);
  });

  it('a different report from the same lane, or the first report from a source, is NOT a duplicate', () => {
    expect(isNearDuplicate(normalizeRunSummary(RECORDER_1508), normalizeRunSummary(DRIVE_1414))).toBe(false);
    expect(isNearDuplicate(normalizeRunSummary(DRIVE_1414), undefined)).toBe(false);
    expect(isNearDuplicate('anything', '')).toBe(false);
    // An outcome / verdict / blocking flip is never a duplicate, even with the same body.
    expect(isNearDuplicateRunSummary(DRIVE_1514, DRIVE_1414)).toBe(true);
    expect(runOutcomeKey(DRIVE_1514)).toBe('completed|n/a|0');
    expect(isNearDuplicateRunSummary(DRIVE_1514.replace('RUN_OUTCOME: completed', 'RUN_OUTCOME: failed'), DRIVE_1414)).toBe(false);
    expect(isNearDuplicateRunSummary(DRIVE_1514.replace('BLOCKING: 0', 'BLOCKING: 2'), DRIVE_1414)).toBe(false);
    expect(isNearDuplicateRunSummary(DRIVE_1514, undefined)).toBe(false);
  });
});

describe('isMaterialLedgerTransition', () => {
  const SELF = 'sup-1';
  it('done / blocked / dropped arrivals and unblocks are material; in_progress flips and rewrites are not', () => {
    expect(isMaterialLedgerTransition({ action: 'todo.update', fromStatus: 'in_progress', toStatus: 'done', actingChatId: 'lane-1' }, SELF)).toBe(true);
    expect(isMaterialLedgerTransition({ action: 'todo.update', fromStatus: 'pending', toStatus: 'blocked', actingChatId: 'lane-1' }, SELF)).toBe(true);
    expect(isMaterialLedgerTransition({ action: 'todo.update', fromStatus: 'blocked', toStatus: 'in_progress', actingChatId: 'lane-1' }, SELF)).toBe(true);
    expect(isMaterialLedgerTransition({ action: 'todo.update', fromStatus: 'pending', toStatus: 'in_progress', actingChatId: 'lane-1' }, SELF)).toBe(false);
    expect(isMaterialLedgerTransition({ action: 'todo.update', fromStatus: 'done', toStatus: 'done', actingChatId: 'lane-1' }, SELF)).toBe(false);
    expect(isMaterialLedgerTransition({ action: 'goal.update', fromStatus: 'active', toStatus: 'blocked', actingChatId: null }, SELF)).toBe(true);
    expect(isMaterialLedgerTransition({ action: 'goal.auto_done' }, SELF)).toBe(true);
  });
  it("the supervisor's own writes are never news; lane-created todos are routine; owner-created ones are material", () => {
    expect(isMaterialLedgerTransition({ action: 'todo.update', fromStatus: 'in_progress', toStatus: 'done', actingChatId: SELF }, SELF)).toBe(false);
    expect(isMaterialLedgerTransition({ action: 'todo.create', actingChatId: 'lane-1' }, SELF)).toBe(false);
    expect(isMaterialLedgerTransition({ action: 'goal.create', actingChatId: null }, SELF)).toBe(true);
    expect(isMaterialLedgerTransition({ action: 'goal.gate_update', actingChatId: null }, SELF)).toBe(false);
  });
});

describe('decideMaterialChange — hook origin', () => {
  const rows = (summary: string, src = '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5') => [{ eventType: 'run_completed', sourceChatId: src, summary }];

  it('REPLAY 2026-10-08 Schooltime: an hourly Drive digest identical to the last DELIVERED one, nothing else moved ⇒ NOT material (the wake is skipped)', () => {
    const v = decideMaterialChange({
      origin: 'hook', diff: diff({ runsFinished: [{ chatId: '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5', status: 'completed', at: '2026-10-08T16:14:59Z' }] }),
      hwmAt: HWM_1H, now: NOW, isFleet: false, floorHours: 4,
      rows: rows(DRIVE_1614), prevSummaryBySource: { '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5': DRIVE_1514 },
    });
    expect(v).toMatchObject({ material: false, reasons: [], heartbeat: false, sinceMin: 60 });
  });

  it('the same Drive digest with no previous delivery on record, or a new report, IS material (new_report)', () => {
    expect(decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: rows(DRIVE_1614), prevSummaryBySource: {} }).reasons).toEqual(['new_report']);
    expect(decideMaterialChange({
      origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false,
      rows: rows(RECORDER_1508, '0037460b-d239-474e-bd32-5fe3ec52d820'), prevSummaryBySource: { '0037460b-d239-474e-bd32-5fe3ec52d820': DRIVE_1414 },
    }).reasons).toEqual(['new_report']);
  });

  it('alarm-class rows, a cap bypass and the heartbeat floor always deliver', () => {
    expect(decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'run_failed', alarm: true }] }).reasons).toEqual(['alarm']);
    expect(decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: rows(DRIVE_1614), prevSummaryBySource: { '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5': DRIVE_1514 }, alarm: true }).material).toBe(true);
    const old = new Date(NOW.getTime() - 5 * 3_600_000);
    const v = decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: old, now: NOW, isFleet: false, floorHours: 4, rows: rows(DRIVE_1614), prevSummaryBySource: { '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5': DRIVE_1514 } });
    expect(v).toMatchObject({ material: true, heartbeat: true, reasons: ['heartbeat'] });
  });

  it('owner messages / answers, material ledger transitions, failed lane runs, PRs and other event types are material; pushes alone are not', () => {
    const base = { origin: 'hook' as const, hwmAt: HWM_1H, now: NOW, isFleet: false, rows: rows(DRIVE_1614), prevSummaryBySource: { '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5': DRIVE_1514 } };
    expect(decideMaterialChange({ ...base, diff: diff({ ownerMessages: [{ chatId: 'x', at: NOW.toISOString(), head: 'record all 4 cameras', self: true }] }) }).reasons).toEqual(['owner_message']);
    expect(decideMaterialChange({ ...base, diff: diff({ ownerAnswers: [{ id: 'oq_1', chatId: 'x', status: 'answered', at: NOW.toISOString() }] }) }).reasons).toEqual(['owner_answer']);
    expect(decideMaterialChange({ ...base, diff: diff({ statusChanges: [{ kind: 'todo', id: 't', action: 'todo.update', from: 'in_progress', to: 'done', at: NOW.toISOString() }] }) }).reasons).toEqual(['goal_todo_change']);
    expect(decideMaterialChange({ ...base, diff: diff({ runsFailed: [{ chatId: 'l', status: 'failed', at: NOW.toISOString() }] }) }).reasons).toEqual(['lane_failed']);
    expect(decideMaterialChange({ ...base, diff: diff({ artifacts: [{ chatId: 'l', tool: 'merge_pull_request', at: NOW.toISOString(), ref: '#23' }] }) }).reasons).toEqual(['artifact']);
    expect(decideMaterialChange({ ...base, diff: diff({ artifacts: [{ chatId: 'l', tool: 'git_push', at: NOW.toISOString(), ref: '2b7bc8aa' }] }) }).material).toBe(false);
    expect(decideMaterialChange({ ...base, diff: diff(), rows: [{ eventType: 'schedule_near_cap' }] }).reasons).toEqual(['event:schedule_near_cap']);
    expect(decideMaterialChange({ ...base, diff: diff(), rows: [{ eventType: 'todo_done' }] }).reasons).toEqual(['todo_done']);
    // A stalled lane is a SWEEP reason only (a hook wake carries its own event).
    expect(decideMaterialChange({ ...base, diff: diff({ stalledLanes: [{ chatId: 'l', todoId: 't', idleMin: 75 }] }) }).material).toBe(false);
  });
});

describe('decideMaterialChange — sweep and drain origins', () => {
  it('a sweep with nothing moved is skipped; an idle lane holding in-progress work makes it material (the One Piece 75-min idle shape)', () => {
    expect(decideMaterialChange({ origin: 'sweep', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false }).material).toBe(false);
    expect(decideMaterialChange({ origin: 'sweep', diff: diff({ stalledLanes: [{ chatId: '7bd45d57', todoId: 't1', idleMin: 75 }] }), hwmAt: HWM_1H, now: NOW, isFleet: true }).reasons).toEqual(['stall']);
  });

  it('drain: a near-duplicate lane report is not material; a new lane report, a peer / supervisor message, or an empty batch is', () => {
    const body = 'Early-window health check — timer ALIVE, 4/4 enabled; first real in-window attempts 09:30 + 09:36.';
    const mk = (drain: any[], prev: Record<string, string> = {}, isFleet = false) => decideMaterialChange({ origin: 'drain', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet, drain, prevAgentBodyBySource: prev });
    expect(mk([{ sourceChatId: 'lane-1', body, sourceIsLane: true }], { 'lane-1': body.replace('09:30 + 09:36', '10:30 + 10:36') }).material).toBe(false);
    expect(mk([{ sourceChatId: 'lane-1', body, sourceIsLane: true }]).reasons).toEqual(['lane_report']);
    expect(mk([{ sourceChatId: 'fleet', body: 'Steer the recorder lane.', sourceIsLane: false }]).reasons).toEqual(['peer_message']);
    expect(mk([]).reasons).toEqual(['peer_message']);
  });

  it('drain into the Fleet: a status-only PS report-up is not material; one with an ask or a state change is', () => {
    const mk = (body: string) => decideMaterialChange({ origin: 'drain', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: true, drain: [{ sourceChatId: 'ps-1', body, sourceIsProjectSupervisor: true }] });
    expect(mk('Lanes steady; recorder lane still running its window, nothing new.').material).toBe(false);
    expect(mk('PR #23 merged; goal G2 delivered.').reasons).toEqual(['report_ask_or_change']);
    expect(mk('Can you confirm the Apple account on the Mac?').reasons).toEqual(['report_ask_or_change']);
  });
});

describe('renderWakeLedgerDiff', () => {
  it('renders the heading, 8-char id PREFIXES, the sections that have rows, the gate-skip transparency line and a verdict line', () => {
    const d = diff({
      ownerMessages: [{ chatId: '41bd202a-7152-437e-bf4b-a097981692b1', at: '2026-10-08T15:47:53Z', head: 'also make sure to keep a tidy workspace', self: true }],
      statusChanges: [{ kind: 'todo', id: 'a62eb6ce-0000-4000-8000-000000000000', title: 'Hue decrypt-by-play capture', action: 'todo.update', from: 'in_progress', to: 'done', at: '2026-10-08T15:52:00Z', byChatId: '0037460b-d239-474e-bd32-5fe3ec52d820' }],
      runsFinished: [{ chatId: '0037460b-d239-474e-bd32-5fe3ec52d820', title: 'Hue emulator audio', status: 'completed', at: '2026-10-08T15:52:00Z' }],
      artifacts: [{ chatId: '0037460b-d239-474e-bd32-5fe3ec52d820', tool: 'git_push', at: '2026-10-08T15:14:00Z', ref: '2b7bc8aa' }],
      gateSkips: [{ sourceChatId: '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5', title: 'Drive watch', n: 3 }],
    });
    const text = renderWakeLedgerDiff(d, { floorHours: 4, verdict: { material: true, reasons: ['owner_message', 'goal_todo_change'], heartbeat: false, sinceMin: 60, floorHours: 4 } });
    expect(text.startsWith(WAKE_LEDGER_HEADING)).toBe(true);
    expect(text).toContain('(60 min)');
    expect(text).toContain('at least every 4 h');
    expect(text).toContain('Owner messages: in this chat 15:47Z "also make sure to keep a tidy workspace"');
    expect(text).toContain('todo a62eb6ce "Hue decrypt-by-play capture" in_progress→done by 0037460b');
    expect(text).toContain('Lane runs: finished 1 (0037460b "Hue emulator audio" 15:52Z)');
    expect(text).toContain('push 2b7bc8aa');
    expect(text).toContain('Skipped by the material gate since your last wake');
    expect(text).toContain('1c2b28d6 "Drive watch" ×3');
    expect(text).toContain('Material: yes — owner_message, goal_todo_change');
    expect(text).not.toMatch(/…[0-9a-f]{8}/); // never a suffix-only id (W1 F7 class)
  });

  it('an empty diff says so in one line; the block never exceeds the cap', () => {
    expect(renderWakeLedgerDiff(diff())).toContain('Nothing recorded in the ledger since your last wake.');
    const big = diff({ ownerMessages: Array.from({ length: 50 }, (_, i) => ({ chatId: `c${i}`.padEnd(36, '0'), at: NOW.toISOString(), head: 'x'.repeat(300), self: false })), otherLedgerChanges: 7 });
    const text = renderWakeLedgerDiff(big);
    expect(text.length).toBeLessThanOrEqual(WAKE_LEDGER_MAX_CHARS);
    expect(text).toContain('+44 more');
  });

  // Todo 13dfa16d (framework-audit monitor lesson 7): artifacts render the
  // work item the EVENT named (ids.todoId/ticketId stamped at event time),
  // never a join to the lane's CURRENT title. The 2026-10-16 specimens: PR
  // #1590 (branch block-escalation-27c215d6) served todo 27c215d6 but every
  // digest after the 14:14:53Z title switch labelled it with lane title todo
  // 908f48a7; PR #1587 was labelled with a todo done before dawn.
  it('renders the artifact\'s OWN work-item stamp ("PR merged #1590 → todo 27c215d6") — not the lane title todo', () => {
    const d = diff({
      artifacts: [
        // PR #1590 as the wake ledger now maps it: the receipt's stamp, not the title.
        { chatId: 'c5f4fd6c-1111-4222-8333-444455556666', title: 'Owner-status contract · merged PR #1590', tool: 'merge_pull_request', at: '2026-10-16T15:48:00Z', ref: '#1590', workItem: 'todo 27c215d6' },
        { chatId: 'c5f4fd6c-1111-4222-8333-444455556666', title: 'Owner-status contract · merged PR #1590', tool: 'git_push', at: '2026-10-16T15:21:00Z', ref: '4c68aa20', workItem: 'todo 27c215d6' },
        // PR #1587 — the receipt says todo 36fe141e; the honest stamp wins.
        { chatId: '5f90c628-1111-4222-8333-444455556666', title: 'Framework Operator · probe', tool: 'open_pull_request', at: '2026-10-16T14:02:00Z', ref: '#1587', workItem: 'todo 36fe141e' },
      ],
    });
    const text = renderWakeLedgerDiff(d);
    expect(text).toContain('PR merged #1590 → todo 27c215d6');
    expect(text).toContain('push 4c68aa20 → todo 27c215d6');
    expect(text).toContain('PR opened #1587 → todo 36fe141e');
    // The SCD trap: the lane's CURRENT title todo (908f48a7 — the goal half
    // after the 14:14:53Z switch) is NOT the artifact's label.
    expect(text).not.toContain('#1590 → todo 908f48a7');
  });

  it('a ticket stamp renders "ticket …" (the 2c203dac class: PR #1591 served the live-lane-board ticket)', () => {
    const d = diff({ artifacts: [{ chatId: 'x'.padEnd(36, '0'), tool: 'merge_pull_request', at: NOW.toISOString(), ref: '#1591', workItem: 'ticket 2c203dac' }] });
    expect(renderWakeLedgerDiff(d)).toContain('PR merged #1591 → ticket 2c203dac');
  });

  it('a legacy artifact with no stamp prints "→ unattributed" honestly — never a guessed lane-title todo', () => {
    const d = diff({ artifacts: [{ chatId: 'x'.padEnd(36, '0'), tool: 'git_push', at: NOW.toISOString(), ref: 'd0d2ab07', unattributed: true }] });
    const text = renderWakeLedgerDiff(d);
    expect(text).toContain('push d0d2ab07 → unattributed');
    expect(text).not.toMatch(/push d0d2ab07 → todo /);
  });
});

describe('selectWakeContinuityHistory', () => {
  const wake = (n: number) => `[MACHINE-TRIGGERED RUN — no user is on this turn. Current time: …] [SUPERVISOR STATE … snapshot ${n}] ${'s'.repeat(2000)}`;
  it('keeps the last 3 own notes + every owner-typed turn; machine prompts become one stub; alternation holds', () => {
    const h: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 1; i <= 6; i += 1) { h.push({ role: 'user', content: wake(i) }); h.push({ role: 'assistant', content: `note ${i}` }); }
    h.splice(4, 0, { role: 'user', content: 'record all 4 cameras for 30 min' }, { role: 'assistant', content: 'on it' });
    const out = selectWakeContinuityHistory(h, 3);
    expect(out.map((m) => m.content)).toEqual([
      'record all 4 cameras for 30 min', 'on it',
      ELIDED_WAKE_PROMPT, 'note 4', ELIDED_WAKE_PROMPT, 'note 5', ELIDED_WAKE_PROMPT, 'note 6',
    ]);
    for (let i = 1; i < out.length; i += 1) expect(out[i].role).not.toBe(out[i - 1].role);
    expect(out.some((m) => m.content.includes('[SUPERVISOR STATE'))).toBe(false);
  });

  it('agent sends / queue banners / acks are machine rows; an [IMAGE: …] owner message is human', () => {
    expect(isMachineUserRow('[AGENT-SENT MESSAGE — from chat "x" (0037460b)] report')).toBe(true);
    expect(isMachineUserRow('[3 agent messages arrived while this chat was busy — coalesced]')).toBe(true);
    expect(isMachineUserRow('[MATERIAL GATE — 2 queued agent message(s) …]')).toBe(true);
    expect(isMachineUserRow('[2 status-only report-up(s) from project supervisor(s) …]')).toBe(true);
    expect(isMachineUserRow('[IMAGE: Screenshot 2026-10-08 at 12.12.31 PM.png — the session]')).toBe(false);
    expect(isMachineUserRow('how is this project going?')).toBe(false);
  });

  it('tolerates leading assistant rows, an empty history and a 1-note budget', () => {
    expect(selectWakeContinuityHistory([], 3)).toEqual([]);
    expect(selectWakeContinuityHistory([{ role: 'assistant', content: 'orphan' }, { role: 'user', content: wake(1) }, { role: 'assistant', content: 'n1' }], 1))
      .toEqual([{ role: 'user', content: ELIDED_WAKE_PROMPT }, { role: 'assistant', content: 'n1' }]);
  });

  it('exports the terminal hook status the call sites stamp', () => {
    expect(HOOK_STATUS_NO_MATERIAL_CHANGE).toBe('skipped:no_material_change');
  });
});

// ── SUP-WAKE-TIERS (supervisor SOTA 2026-10-20) ─────────────────────────────

describe('tiers — switches', () => {
  afterEach(() => { for (const k of ['SUPERVISOR_MATERIAL_TIERS_DISABLED', 'SUPERVISOR_PROGRESS_HEARTBEAT_HOURS', 'SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE']) delete process.env[k]; });
  it('tiers on by default; the kill switch; progress heartbeat default 8 (1..72); control rate default 10 (0..1000, 0 = none)', () => {
    expect(materialTiersDisabled()).toBe(false);
    process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED = '1'; expect(materialTiersDisabled()).toBe(true);
    expect(progressHeartbeatHours()).toBe(8);
    process.env.SUPERVISOR_PROGRESS_HEARTBEAT_HOURS = '0'; expect(progressHeartbeatHours()).toBe(1);
    process.env.SUPERVISOR_PROGRESS_HEARTBEAT_HOURS = '500'; expect(progressHeartbeatHours()).toBe(72);
    process.env.SUPERVISOR_PROGRESS_HEARTBEAT_HOURS = 'x'; expect(progressHeartbeatHours()).toBe(8);
    expect(progressSkipControlRate()).toBe(10);
    process.env.SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE = '-3'; expect(progressSkipControlRate()).toBe(0);
    process.env.SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE = '4.9'; expect(progressSkipControlRate()).toBe(4);
  });
  it('drawProgressControl: 1 in N with an injectable RNG; rate 0 never draws', () => {
    expect(drawProgressControl(10, () => 0.05)).toBe(true);
    expect(drawProgressControl(10, () => 0.1)).toBe(false);
    expect(drawProgressControl(1, () => 0.99)).toBe(true);
    expect(drawProgressControl(0, () => 0)).toBe(false);
  });
  it('the skip statuses the diff reads', () => {
    expect(HOOK_STATUS_PROGRESS_SELF_DRIVING).toBe('skipped:progress_self_driving');
    expect(MATERIAL_GATE_SKIP_STATUSES).toEqual(['skipped:no_material_change', 'skipped:progress_self_driving']);
  });
});

describe('tiers — REASON_TIER table', () => {
  it.each([
    ['alarm', 'decision'], ['owner_message', 'decision'], ['owner_answer', 'decision'], ['lane_failed', 'decision'],
    ['stall', 'decision'], ['report_ask_or_change', 'decision'], ['peer_message', 'decision'], ['event:ci_failed', 'decision'],
    ['lane_ask', 'decision'],
    ['new_report', 'progress'], ['lane_report', 'progress'], ['artifact', 'progress'], ['heartbeat', 'progress'],
    // Unlisted reasons are DECISION (never gated): every other event:<type>, any future reason.
    ['event:schedule_near_cap', 'decision'], ['event:schedule_cap_skipped', 'decision'], ['event:run_failed', 'decision'], ['something_new', 'decision'],
  ])('%s → %s', (reason, tier) => {
    expect(reasonTier(reason, { statusChanges: [] })).toBe(tier);
  });
});

describe('tiers — statusChangeTier (goal_todo_change / todo_done refinement)', () => {
  const ch = (patch: Partial<LedgerStatusChange>): LedgerStatusChange => ({ kind: 'todo', id: 't1', action: 'todo.update', from: 'in_progress', to: 'done', at: NOW.toISOString(), byChatId: 'lane-1', goalOpenTodos: 2, ...patch });
  it.each([
    ['lane-made todo done with open successors', {}, 'progress'],
    ['lane-made todo done, goal has NO open successor', { goalOpenTodos: 0 }, 'decision'],
    ['lane-made todo done, successor count unknown', { goalOpenTodos: undefined }, 'decision'],
    ['owner / harness-made todo done', { byChatId: null }, 'decision'],
    ['todo → blocked', { from: 'in_progress', to: 'blocked' }, 'decision'],
    ['todo out of blocked', { from: 'blocked', to: 'in_progress' }, 'decision'],
    ['todo dropped (scope)', { to: 'dropped' }, 'decision'],
    ['todo.auto_unblock', { action: 'todo.auto_unblock', from: null, to: null }, 'decision'],
    ['todo.force_done', { action: 'todo.force_done' }, 'decision'],
    ['owner-created todo', { action: 'todo.create', byChatId: null, from: null, to: null }, 'decision'],
    ['any goal transition', { kind: 'goal', action: 'goal.update', from: 'active', to: 'done' }, 'decision'],
    ['goal.auto_done', { kind: 'goal', action: 'goal.auto_done', from: null, to: null }, 'decision'],
  ])('%s → %s', (_label, patch, tier) => {
    expect(statusChangeTier(ch(patch as Partial<LedgerStatusChange>))).toBe(tier);
  });
});

describe('tiers — the verdict tier (max over reasons)', () => {
  const LANE = '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5';
  const laneDone = (open: number): LedgerStatusChange => ({ kind: 'todo', id: 't1', action: 'todo.update', from: 'in_progress', to: 'done', at: NOW.toISOString(), byChatId: LANE, goalOpenTodos: open });
  it('a new report alone is PROGRESS; adding any decision reason makes the verdict DECISION; not material is none', () => {
    const v = decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'run_completed', sourceChatId: LANE, summary: DRIVE_1614 }], prevSummaryBySource: {} });
    expect(v).toMatchObject({ material: true, reasons: ['new_report'], tier: 'progress', decisionReasons: [] });
    const w = decideMaterialChange({ origin: 'hook', diff: diff({ ownerMessages: [{ chatId: 'x', at: NOW.toISOString(), head: 'stop', self: true }] }), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'run_completed', sourceChatId: LANE, summary: DRIVE_1614 }], prevSummaryBySource: {} });
    expect(w).toMatchObject({ tier: 'decision', decisionReasons: ['owner_message'] });
    expect(decideMaterialChange({ origin: 'sweep', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false })).toMatchObject({ material: false, tier: 'none' });
  });
  it('the 4 h heartbeat is PROGRESS; red CI is DECISION; other event types are DECISION', () => {
    const old = new Date(NOW.getTime() - 5 * 3_600_000);
    expect(decideMaterialChange({ origin: 'sweep', diff: diff(), hwmAt: old, now: NOW, isFleet: false, floorHours: 4 }).tier).toBe('progress');
    expect(decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'ci_failed' }] }).tier).toBe('decision');
    expect(decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'schedule_near_cap' }] }).tier).toBe('decision');
  });
  it('a lane-made todo_done with work left in its goal is PROGRESS; the LAST open todo of a goal done is DECISION', () => {
    const hook = (sc: LedgerStatusChange[]) => decideMaterialChange({ origin: 'hook', diff: diff({ statusChanges: sc }), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'todo_done', sourceChatId: LANE }] });
    expect(hook([laneDone(3)])).toMatchObject({ reasons: ['goal_todo_change', 'todo_done'], tier: 'progress' });
    expect(hook([laneDone(0)])).toMatchObject({ tier: 'decision', decisionReasons: ['goal_todo_change', 'todo_done'] });
    // A todo_done row the diff cannot see (no matching lane-made done) is DECISION — unseen ⇒ never gated.
    expect(hook([])).toMatchObject({ reasons: ['todo_done'], tier: 'decision' });
  });
  it('drain: a new lane report is PROGRESS; a peer message / Fleet report-up with an ask is DECISION', () => {
    const mk = (drain: any[], isFleet = false) => decideMaterialChange({ origin: 'drain', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet, drain });
    expect(mk([{ sourceChatId: 'lane-1', body: 'Window 3 recorded, 4 files.', sourceIsLane: true }]).tier).toBe('progress');
    expect(mk([{ sourceChatId: 'fleet', body: 'Steer the recorder lane.', sourceIsLane: false }]).tier).toBe('decision');
    expect(mk([{ sourceChatId: 'ps-1', body: 'Can you confirm the Apple account?', sourceIsProjectSupervisor: true }], true).tier).toBe('decision');
  });
});

describe('ALARM-CAUSE-AWARE in the rule — quiet rows + resume-queued failures', () => {
  it('a quiet row (stopped by a chat / resume queued / lane self-stop) adds no reason of its own', () => {
    const v = decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [
      { eventType: 'run_failed', sourceChatId: 'l1', quietCause: 'cancelled' },
      { eventType: 'run_failed', sourceChatId: 'l2', quietCause: 'provider_transient' },
      { eventType: 'schedule_disabled', sourceChatId: 'l3', quietCause: 'self_stop' },
    ] });
    expect(v).toMatchObject({ material: false, reasons: [], tier: 'none' });
    // The same rows without a cause are the event types they always were.
    expect(decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'schedule_disabled', sourceChatId: 'l3' }] }).reasons).toEqual(['event:schedule_disabled']);
  });
  it('a failed run whose provider-limit resume took over is not lane_failed; any other failure is (and stays decision)', () => {
    const at = NOW.toISOString();
    expect(decideMaterialChange({ origin: 'sweep', diff: diff({ runsFailed: [{ chatId: 'l', status: 'failed', at, resumeQueued: true }] }), hwmAt: HWM_1H, now: NOW, isFleet: false }).material).toBe(false);
    expect(decideMaterialChange({ origin: 'sweep', diff: diff({ runsFailed: [{ chatId: 'l', status: 'failed', at, resumeQueued: true }, { chatId: 'm', status: 'failed', at }] }), hwmAt: HWM_1H, now: NOW, isFleet: false }))
      .toMatchObject({ reasons: ['lane_failed'], tier: 'decision' });
  });
  it('renders a resume-queued failure honestly', () => {
    const text = renderWakeLedgerDiff(diff({ runsFailed: [{ chatId: '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5', status: 'failed', at: NOW.toISOString(), resumeQueued: true, error: 'model provider killed the run (transient failure, HTTP 429)' }] }));
    expect(text).toContain('[provider limit — resume queued]');
  });
});

describe('tiers — progress source lanes + the skip decision', () => {
  const SUP_ID = '41bd202a-7152-437e-bf4b-a097981692b1';
  it('collects the report rows, lane messages, PRs, lane-made closes and finished / resume-queued runs — never the supervisor, alarms or quiet rows', () => {
    const at = NOW.toISOString();
    const d = diff({
      artifacts: [{ chatId: 'pr-lane', tool: 'open_pull_request', at }, { chatId: 'push-lane', tool: 'git_push', at }],
      statusChanges: [
        { kind: 'todo', id: 't1', action: 'todo.update', from: 'in_progress', to: 'done', at, byChatId: 'done-lane', goalOpenTodos: 1 },
        { kind: 'todo', id: 't2', action: 'todo.update', from: 'in_progress', to: 'blocked', at, byChatId: 'blocked-lane' },
      ],
      runsFinished: [{ chatId: 'run-lane', status: 'completed', at }, { chatId: SUP_ID, status: 'completed', at }],
      runsFailed: [{ chatId: 'resume-lane', status: 'failed', at, resumeQueued: true }, { chatId: 'dead-lane', status: 'failed', at }],
    });
    const ids = progressSourceLaneIds({ origin: 'hook', diff: d, rows: [
      { eventType: 'run_completed', sourceChatId: 'report-lane' },
      { eventType: 'run_failed', sourceChatId: 'alarm-lane', alarm: true },
      { eventType: 'run_failed', sourceChatId: 'quiet-lane', quietCause: 'cancelled' },
    ] });
    expect(ids.sort()).toEqual(['done-lane', 'pr-lane', 'report-lane', 'resume-lane', 'run-lane']);
    expect(progressSourceLaneIds({ origin: 'drain', diff: diff(), drain: [{ sourceChatId: 'lane-x', body: 'b', sourceIsLane: true }, { sourceChatId: 'peer', body: 'b', sourceIsLane: false }] })).toEqual(['lane-x']);
    expect(progressSourceLaneIds({ origin: 'sweep', diff: diff() })).toEqual([]);
  });

  it.each([
    // [label, input, expected]
    ['decision tier is never gated', { verdict: { material: true, tier: 'decision' }, sinceMs: 0, sourceLanes: 2, selfDriving: true }, { wouldSkip: false, why: 'not_progress' }],
    ['not material is not this rule', { verdict: { material: false, tier: 'none' }, sinceMs: 0, sourceLanes: 0, selfDriving: null }, { wouldSkip: false, why: 'not_progress' }],
    ['past the progress heartbeat delivers', { verdict: { material: true, tier: 'progress' }, sinceMs: 8 * 3_600_000, sourceLanes: 2, selfDriving: true }, { wouldSkip: false, why: 'progress_heartbeat' }],
    ['no source lane delivers', { verdict: { material: true, tier: 'progress' }, sinceMs: 0, sourceLanes: 0, selfDriving: null }, { wouldSkip: false, why: 'no_source_lanes' }],
    ['a failed lookup delivers', { verdict: { material: true, tier: 'progress' }, sinceMs: 0, sourceLanes: 2, selfDriving: null }, { wouldSkip: false, why: 'lookup_failed' }],
    ['a lane not driving itself delivers', { verdict: { material: true, tier: 'progress' }, sinceMs: 0, sourceLanes: 2, selfDriving: false }, { wouldSkip: false, why: 'not_self_driving' }],
    // review fix 2026-10-20: a stalled source lane / more lanes than one read covers deliver whatever the read said.
    ['a stalled source lane delivers', { verdict: { material: true, tier: 'progress' }, sinceMs: 0, sourceLanes: 2, selfDriving: true, stalledSource: true }, { wouldSkip: false, why: 'stalled_lane' }],
    ['too many source lanes delivers', { verdict: { material: true, tier: 'progress' }, sinceMs: 0, sourceLanes: 51, selfDriving: true, tooManyLanes: true }, { wouldSkip: false, why: 'too_many_lanes' }],
    ['every lane self-driving below the heartbeat skips', { verdict: { material: true, tier: 'progress' }, sinceMs: 2 * 3_600_000, sourceLanes: 2, selfDriving: true }, { wouldSkip: true, why: 'self_driving' }],
  ])('%s', (_label, input, expected) => {
    expect(progressSkipDecision({ progressHeartbeatHours: 8, ...(input as any) })).toEqual(expected);
  });
});

// ── Review fix 2026-10-20: lane asks are DECISION (lane_ask) ────────────────

describe('tiers — laneAskCue (an ask / a blocker in a lane\'s own words)', () => {
  it.each([
    // [text, expected]
    ['Two options for the migration: A drops the column, B keeps it — which one?', true],
    ['Should I switch to approach B? I\'ll hold until you answer.', true],
    ['step 3 done; blocked on X — need a decision', true],
    ['Blocked: the API key for the Drive scope is missing.', true],
    ['BLOCKER: owner must log in to the Mac.', true],
    ['Waiting for your approval before I merge PR #23.', true],
    ['I cannot proceed without the staging credentials.', true],
    ['Can you confirm the Apple account on the Mac', true],
    ['This needs owner approval (cost > $50).', true],
    ['Lane is still blocked pending the vendor reply.', true],
    ['Please confirm the cadence change.', true],
    ['Cadence options: 30 or 60 min — **keep 30?**', true],
    // status-only progress — never an ask
    ['Window 3 recorded, 4 files uploaded.', false],
    ['Early-window health check — timer ALIVE, 4/4 enabled; first real in-window attempts 09:30 + 09:36.', false],
    ['No audio yet — `drive_search` → "No files found matching"; successor firing 60 of 500.', false],
    ['PR #23 merged; goal G2 delivered; tests 412/412 green.', false],
    ['No decision needed — continuing with step 4.', false],
    ['Not blocked by the outage any more; resumed the backfill.', false],
    ['This doesn\'t need approval; it is inside the lane charter.', false],
    ['Unblocked the queue and finished the migration.', false],
    ['Fetched https://example.com/api?page=2&size=50 and parsed 50 rows; `cfg?.retries` defaults to 3.', false],
  ])('%s → %s', (text, expected) => {
    expect(laneAskCue(text)).toBe(expected);
  });

  it('runSummaryAskText reads the lane\'s words only: header, answer-id line and harness notes stripped', () => {
    const chatShape = 'RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0\nANSWER_MSG_ID: 79e8f434 — the persisted final answer of this run (the row this digest quotes). When your note references this answer, cite this id\'s first 8 chars as \'msg <8 chars>\'; never invent, reconstruct or lengthen a message id.\nChat run completed. Answer: Recorded window 3.';
    expect(laneAskCue(runSummaryAskText(chatShape))).toBe(false);
    expect(runSummaryAskText(chatShape)).not.toContain('ANSWER_MSG_ID');
    const handoff = `${DIGEST('a1', 'Deck built.')}\n\n[DELIVERABLES ALREADY POSTED on chat c1 (message m1): deck.pdf. The harness handed them back with download links — acknowledge that message; do not re-post, re-stage or re-narrate these files, and never send the user to the session's Files tab.]`;
    expect(laneAskCue(runSummaryAskText(handoff))).toBe(false);
    expect(laneAskCue(runSummaryAskText(DIGEST('a2', 'Deck built — should I also export the PPTX?')))).toBe(true);
  });

  it('hook: a non-duplicate run summary carrying an ask is lane_ask (DECISION); a near-duplicate stays nothing; tiers off ⇒ new_report, no tier keys', () => {
    const LANE = '1c2b28d6-21fc-4fb4-9b3b-9f04cd3f7ec5';
    const ask = DIGEST('d1', 'Step 3 done; blocked on the Drive OAuth scope — need a decision before I widen it.');
    const mk = (prev: Record<string, string> = {}) => decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows: [{ eventType: 'run_completed', sourceChatId: LANE, summary: ask }], prevSummaryBySource: prev });
    expect(mk()).toMatchObject({ reasons: ['lane_ask'], tier: 'decision', decisionReasons: ['lane_ask'] });
    expect(mk({ [LANE]: ask }).material).toBe(false);
    process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED = '1';
    try {
      const v = mk();
      expect(v.reasons).toEqual(['new_report']);
      expect(Object.keys(v).sort()).toEqual(['floorHours', 'heartbeat', 'material', 'reasons', 'sinceMin']);
    } finally { delete process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED; }
  });

  it('drain: a lane question is lane_ask (DECISION); a plain lane report stays lane_report (PROGRESS); the same question repeated is a near-duplicate', () => {
    const q = 'Two options for the migration: A drops the column, B keeps it — which one?';
    const mk = (body: string, prev: Record<string, string> = {}) => decideMaterialChange({ origin: 'drain', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, drain: [{ sourceChatId: 'lane-1', body, sourceIsLane: true }], prevAgentBodyBySource: prev });
    expect(mk(q)).toMatchObject({ reasons: ['lane_ask'], tier: 'decision' });
    expect(mk('Window 3 recorded, 4 files.')).toMatchObject({ reasons: ['lane_report'], tier: 'progress' });
    expect(mk(q, { 'lane-1': q }).material).toBe(false);
    // A batch mixing a status line and an ask is DECISION (max over reasons).
    const both = decideMaterialChange({ origin: 'drain', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, drain: [
      { sourceChatId: 'lane-1', body: 'Window 3 recorded, 4 files.', sourceIsLane: true },
      { sourceChatId: 'lane-2', body: q, sourceIsLane: true },
    ] });
    expect(both).toMatchObject({ reasons: ['lane_report', 'lane_ask'], tier: 'decision', decisionReasons: ['lane_ask'] });
  });
});

// ── LANE-IDLE-WAKE (2026-10-20, coding/lane-idle.ts) ────────────────────────
describe('LANE-IDLE-WAKE — the lane_idle DECISION reason + the widened stall line', () => {
  afterEach(() => { delete process.env.LANE_IDLE_WAKE_DISABLED; delete process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED; });
  const hook = (rows: any[]) => decideMaterialChange({ origin: 'hook', diff: diff(), hwmAt: HWM_1H, now: NOW, isFleet: false, rows });

  it('a harness lane-idle wake row (alarm-class todo_wake) names its own reason, which is DECISION-tier; the kill switch drops the label only', () => {
    const v = hook([{ eventType: 'todo_wake', alarm: true, wakeKind: 'lane_idle', sourceChatId: 'sup' }]);
    expect(v.reasons).toEqual(['alarm', 'lane_idle']);
    expect(v.tier).toBe('decision');
    expect(v.decisionReasons).toEqual(['alarm', 'lane_idle']);
    expect(reasonTier('lane_idle', diff())).toBe('decision');
    // Even a quiet (non-alarm) copy of the row is a decision on its own.
    expect(hook([{ eventType: 'todo_wake', wakeKind: 'lane_idle' }]).tier).toBe('decision');
    process.env.LANE_IDLE_WAKE_DISABLED = '1';
    expect(hook([{ eventType: 'todo_wake', alarm: true, wakeKind: 'lane_idle' }]).reasons).toEqual(['alarm']);
  });

  it('the stall line names pending work and never-started lanes; the kill switch restores the in-progress wording', () => {
    const d = diff({ stalledLanes: [
      { chatId: '7bd45d57-aaaa', title: 'Events', todoId: 'todo-pend-1', todoTitle: 'Backfill', idleMin: 95, todoStatus: 'pending' },
      { chatId: '0037460b-bbbb', todoId: 'todo-new-22', todoTitle: 'Schema', idleMin: 40, neverStarted: true },
    ] });
    const text = renderWakeLedgerDiff(d, { floorHours: 4 });
    expect(text).toContain('Idle lanes holding open work (no live run, no schedule due within 2 h or its own cadence): 7bd45d57 "Events" — todo todo-pen "Backfill" (pending), idle 95 min');
    expect(text).toContain('0037460b — todo todo-new "Schema", never started, assigned 40 min ago');
    process.env.LANE_IDLE_WAKE_DISABLED = '1';
    expect(renderWakeLedgerDiff(d, { floorHours: 4 })).toContain('Idle lanes holding in-progress work (no live run, no armed schedule): 7bd45d57 "Events" — todo todo-pen "Backfill", idle 95 min');
  });
});
