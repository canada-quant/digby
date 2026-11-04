/**
 * audit 2026-10-08 W6-3 (P1-10) — the wake_triage "needed a turn" label is
 * HARNESS-only: housekeeping (archive_chat / add_knowledge_note / the state
 * ledger), a send_chat_message to the run's OWN chat, and the model's own
 * "ACTIONS TAKEN" text never count. REPLAY of the incident shapes that
 * auto-demoted wake_triage on 2026-10-07 18:24Z (precision 0.727 on 33 act
 * labels): 7 of the 23 in-band misses were housekeeping turns, 5 had zero
 * mutating calls but an ACTIONS TAKEN note (Fleet c0e22e36 14:57 / 15:08Z,
 * crossmodel daee2916 21:17Z, Schooltime 41bd202a 04:15Z), and Schooltime
 * minted a "receipt" by messaging its own chat (13:52Z, receipt bffb5328).
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' }, recordLoopMetric: jest.fn() }));
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  // The real classifier's precedence in miniature (an ACTIONS TAKEN marker ⇒ supervisor_action).
  classifySupervisorNote: (c: unknown) => (/\bACTIONS?\s+TAKEN\b/i.test(String(c ?? '')) ? 'supervisor_action' : /\b(?:SWEEP|WAKE):\s*no-op\b/i.test(String(c ?? '')) ? 'supervisor_noop' : 'supervisor_note'),
  reportUpTargetForSession: async () => null,
}));

import { recordLoopMetric } from './loop-metrics.service';
import { stashDecision } from './decision-gate';
import {
  WAKE_HOUSEKEEPING_TOOLS, deriveMachineRunActual, isRealActionTool, labelMachineRunOutcome, legacyWakeActed, realActionToolNames, wakeActed,
} from './decision-outcome-labels';

const FLEET = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
const SCHOOLTIME = '41bd202a-7152-437e-bf4b-a097981692b1';
const CROSSMODEL_PS = 'daee2916-fa75-4159-94a1-3d767abfd192';
const call = (name: string, args: Record<string, unknown> = {}) => ({ type: 'tool_call', name, args });
const triage = (p = 0.04) => stashDecision({ id: 'wt-1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 150, answers: { needs_turn_now: { type: 'noul', noul: p } } }, 'wake_triage');
const outcome = () => (recordLoopMetric as jest.Mock).mock.calls.map((c) => c[0]).find((r) => r?.meta?.phase === 'outcome' && r?.meta?.question === 'needs_turn_now');

beforeEach(() => { (recordLoopMetric as jest.Mock).mockReset(); delete process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED; });

describe('W6-3 replay — the shapes that auto-demoted wake_triage', () => {
  it('Fleet 14:57Z shape: reads + the ledger write + an ACTIONS TAKEN note ⇒ actual FALSE (agrees with Jev 0.04); the legacy label said true', async () => {
    const parts = [call('get_chat_status', { chatId: SCHOOLTIME }), call('list_chats'), call('update_supervisor_state', { patch: {} })];
    await labelMachineRunOutcome(triage(0.04), { parts, finalText: '**Fleet — 7:57 AM PDT.** ACTIONS TAKEN: verified both lanes; nothing needs you.', sessionId: FLEET });
    expect(outcome()).toMatchObject({ meta: { purpose: 'wake_triage', actual: false, agreed: true, labelSource: 'harness_v2', legacyActed: true } });
  });

  it('crossmodel housekeeping shape: archive_chat + add_knowledge_note after a lane completion ⇒ actual FALSE', async () => {
    const parts = [call('get_chat_status', { chatId: 'lane' }), call('add_knowledge_note', { name: 'lane learnings' }), call('archive_chat', { chatId: 'lane' }), call('update_supervisor_state')];
    await labelMachineRunOutcome(triage(0.06), { parts, finalText: 'Lane done — folded its learnings and archived it. ACTIONS TAKEN: archive_chat, add_knowledge_note.', sessionId: CROSSMODEL_PS });
    expect(outcome()).toMatchObject({ meta: { actual: false, agreed: true, legacyActed: true } });
    expect(String(outcome().meta.note)).toContain('mutating 2 (add_knowledge_note,archive_chat)');
  });

  it('Schooltime 13:52Z shape: a send_chat_message to its OWN chat (to mint a close "receipt") ⇒ actual FALSE', async () => {
    const parts = [call('send_chat_message', { chatId: SCHOOLTIME, message: 'Closing directives 0ba4d476 / d897eaef — closure report.' }), call('update_supervisor_state')];
    await labelMachineRunOutcome(triage(0.05), { parts, finalText: 'ACTIONS TAKEN: closed two directives (receipt bffb5328).', sessionId: SCHOOLTIME });
    expect(outcome()).toMatchObject({ meta: { actual: false } });
  });

  it('a REAL action — a steer to a lane, a todo transition, a schedule change, an owner push — labels actual TRUE', async () => {
    for (const parts of [
      [call('send_chat_message', { chatId: '0037460b-d239-474e-bd32-5fe3ec52d820', message: 'record all 4 cameras' })],
      [call('todo_update', { id: 'a62eb6ce', status: 'done' })],
      [call('update_schedule', { scheduleId: '50532ee7' })],
      [call('notify_user', { message: 'capture came up empty' })],
      [call('file_feedback', { title: 'x' })],
    ]) {
      (recordLoopMetric as jest.Mock).mockReset();
      await labelMachineRunOutcome(triage(0.9), { parts, finalText: 'done', sessionId: SCHOOLTIME });
      expect(outcome()).toMatchObject({ meta: { actual: true, agreed: true } });
    }
  });

  it('kill switch WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 restores the legacy label on the same shapes', async () => {
    process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED = '1';
    await labelMachineRunOutcome(triage(0.04), { parts: [call('archive_chat', { chatId: 'lane' })], finalText: 'archived', sessionId: CROSSMODEL_PS });
    expect(outcome()).toMatchObject({ meta: { actual: true, labelSource: 'legacy' } });
  });
});

describe('W6-3 pure pieces', () => {
  it('housekeeping is a closed list; real actions are every other mutating platform tool (new tools default to "acted" — the safe side)', () => {
    for (const t of ['update_supervisor_state', 'archive_chat', 'add_knowledge_note', 'remember_fact', 'observe_resource', 'rename_chat']) {
      expect(WAKE_HOUSEKEEPING_TOOLS.has(t)).toBe(true);
      expect(isRealActionTool(t)).toBe(false);
    }
    for (const t of ['send_chat_message', 'start_coding_session', 'todo_update', 'goal_update', 'schedule_message', 'cancel_schedule', 'flag_owner_question', 'notify_user', 'file_feedback', 'stop_run', 'dispatch_platform_task']) {
      expect(isRealActionTool(t)).toBe(true);
    }
    expect(isRealActionTool('get_chat_status')).toBe(false);
    expect(isRealActionTool('run_command')).toBe(false);
  });

  it('realActionToolNames drops self-sends only when the session is known; wakeActed reads it before the bare tool names', () => {
    const parts = [call('send_chat_message', { chatId: SCHOOLTIME }), call('send_chat_message', { chatId: 'lane-1' }), call('archive_chat')];
    expect(realActionToolNames(parts, SCHOOLTIME)).toEqual(['send_chat_message']);
    expect(realActionToolNames(parts)).toEqual(['send_chat_message', 'send_chat_message']);
    expect(realActionToolNames('junk')).toEqual([]);
    expect(wakeActed({ toolNames: ['send_chat_message'], noteKind: null, actionToolNames: [] })).toBe(false);
    expect(wakeActed({ toolNames: ['archive_chat'], noteKind: 'supervisor_action' })).toBe(false);
    expect(legacyWakeActed({ toolNames: ['archive_chat'], noteKind: null })).toBe(true);
    expect(deriveMachineRunActual('supervisor_turn_noop', { toolNames: ['archive_chat', 'update_supervisor_state'], noteKind: null })).toBe(false);
  });
});
