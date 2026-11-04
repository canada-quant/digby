jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../memory/context-store', () => ({ storeGet: async () => null }));
jest.mock('./decision-gate', () => ({ decide: async () => null, decisionMode: () => 'shadow', decisionOptionThreshold: (_p: string, _o: string, f: number) => f, stashDecision: () => null }));

import {
  attachDecision, preAskVerdict, shouldAttachWorkspace, ATTACH_GATE_NON_CODE_MIN_P, ATTACH_GATE_TIMEOUT_MS, ATTACH_GATE_SLACK_MS,
  WORKSPACE_ATTACH_GATE_METRIC, type AttachGateDeps,
} from './workspace-attach-gate';
import type { TaskKindResult, TaskKind } from './task-kind';

function res(top: TaskKind, p: number, over: Partial<{ mode: string; calibrated: boolean }> = {}): TaskKindResult {
  const probs = { writing: 0, code: 0, analysis: 0, lookup: 0, advice: 0, planning: 0, explain: 0 } as Record<TaskKind, number>;
  probs[top] = p;
  return {
    cls: { kind: p >= 0.5 ? top : null, p, top, probs, averaged: true, harm: 0.05 },
    decision: { mode: over.mode ?? 'shadow', calibrated: over.calibrated ?? true } as any,
    usableKind: p >= 0.5 ? top : null,
  };
}
const FACTS = { priorUserTurns: ['earlier ask'], priorLane: 'standard', turnIndex: 1 };
const act = (over: Partial<AttachGateDeps> = {}): AttachGateDeps => ({ mode: async () => 'act', facts: async () => FACTS, record: () => {}, env: {}, ...over });

describe('workspace attach gate — the keyword hit is a trigger, the task_kind decision judges (2026-10-20)', () => {
  it('attachDecision: no keyword ⇒ nothing to attach; mode off ⇒ the keyword attaches', () => {
    expect(attachDecision(null, res('code', 1))).toMatchObject({ attach: false, reason: 'no_code_intent' });
    expect(attachDecision('code intent', res('writing', 1), true)).toMatchObject({ attach: true, reason: 'gate_disabled', mode: 'off' });
  });

  it('attachDecision: only a confident, calibrated non-code verdict keeps the turn a chat', () => {
    expect(attachDecision('code intent', res('writing', 0.95))).toMatchObject({ attach: false, wouldAttach: false, reason: 'kind_not_code', kind: 'writing' });
    expect(attachDecision('code intent', res('writing', ATTACH_GATE_NON_CODE_MIN_P))).toMatchObject({ attach: false });
    expect(attachDecision('code intent', res('code', 0.55))).toMatchObject({ attach: true, reason: 'kind_code' });
    expect(attachDecision('code intent', res('explain', 0.6))).toMatchObject({ attach: true, reason: 'kind_unsure' });
    expect(attachDecision('code intent', null)).toMatchObject({ attach: true, reason: 'kind_unavailable' });
    expect(attachDecision('code intent', { cls: null, decision: null, usableKind: null })).toMatchObject({ attach: true, reason: 'kind_unavailable' });
    expect(attachDecision('code intent', res('writing', 0.99, { mode: 'off' }))).toMatchObject({ attach: true, reason: 'kind_unavailable' });
    expect(attachDecision('code intent', res('writing', 0.99, { calibrated: false }))).toMatchObject({ attach: true, reason: 'kind_unavailable' });
  });

  it('preAskVerdict: a webhook never converts a chat; an agent send and a STRONG label keep the keyword; uploads / a long message are not asked', () => {
    expect(preAskVerdict('code intent', { origin: 'webhook', messageChars: 10 })).toMatchObject({ attach: false, reason: 'webhook_origin' });
    expect(preAskVerdict('file mention', { origin: 'webhook', messageChars: 10 })).toMatchObject({ attach: false, reason: 'webhook_origin' });
    expect(preAskVerdict('code intent', { origin: 'agent', messageChars: 10 })).toMatchObject({ attach: true, reason: 'agent_origin' });
    for (const l of ['file mention', 'repo path', 'pull request', 'PR']) expect(preAskVerdict(l, { origin: 'user', messageChars: 10 })).toMatchObject({ attach: true, reason: 'strong_label' });
    expect(preAskVerdict('code intent', { origin: 'user', hasUploads: true, messageChars: 10 })).toMatchObject({ attach: true, reason: 'has_uploads' });
    expect(preAskVerdict('code intent', { origin: 'user', messageChars: 2001 })).toMatchObject({ attach: true, reason: 'long_message' });
    expect(preAskVerdict('code intent', { origin: 'user', messageChars: 2000 })).toBeNull();
  });

  it('act: the bench\'s grammar fix stays a chat — asked over the TURN PLAN\'s state (session facts, segment user); one row', async () => {
    const rows: any[] = [];
    const decideKind = jest.fn(async () => res('writing', 0.97));
    const out = await shouldAttachWorkspace('fix the grammar: their going to there house later, its gonna be fun', { chatId: 'c1' }, act({ decideKind, record: (r) => rows.push(r) }));
    expect(out).toMatchObject({ attach: false, reason: 'kind_not_code', label: 'code intent', kind: 'writing', mode: 'act' });
    const [state, opts] = decideKind.mock.calls[0] as any[];
    expect(state).toMatchObject({ message: expect.stringMatching(/^fix the grammar/), previous_user_messages: ['earlier ask'], previous_answer_lane: 'standard', turn_in_chat: 2, attachments: 'none' });
    expect(opts).toMatchObject({ sessionId: 'c1', segment: 'user', timeoutMs: ATTACH_GATE_TIMEOUT_MS });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: WORKSPACE_ATTACH_GATE_METRIC, sessionId: 'c1', unit: 'ms', meta: { mode: 'act', attach: false, wouldAttach: false, reason: 'kind_not_code', kind: 'writing', p: 0.97 } });
  });

  it('act: a code verdict attaches; a strong label attaches WITHOUT asking; no keyword asks nothing; a failing ask keeps the keyword', async () => {
    expect(await shouldAttachWorkspace('there is a bug, the build error says x is undefined', {}, act({ decideKind: async () => res('code', 0.9) })))
      .toMatchObject({ attach: true, reason: 'kind_code' });
    const decideKind = jest.fn(async () => res('writing', 1));
    expect(await shouldAttachWorkspace('update README.md with the new install steps', {}, act({ decideKind }))).toMatchObject({ attach: true, reason: 'strong_label', label: 'file mention' });
    expect(await shouldAttachWorkspace("what's the weather tomorrow", {}, act({ decideKind }))).toMatchObject({ attach: false, reason: 'no_code_intent' });
    expect(await shouldAttachWorkspace('fix my essay', {}, act({ decideKind, env: { WORKSPACE_ATTACH_KIND_GATE_DISABLED: '1' } }))).toMatchObject({ attach: true, reason: 'gate_disabled' });
    expect(decideKind).not.toHaveBeenCalled();
    expect(await shouldAttachWorkspace('fix my essay', {}, act({ decideKind: async () => { throw new Error('x'); } }))).toMatchObject({ attach: true, reason: 'kind_unavailable' });
    expect(await shouldAttachWorkspace('fix my essay', {}, act({ facts: async () => { throw new Error('db'); } }))).toMatchObject({ attach: true, reason: 'kind_unavailable' });
  });

  it('act: the whole ask is bounded by the timeout + slack (a hung decision keeps the keyword)', async () => {
    jest.useFakeTimers();
    try {
      const p = shouldAttachWorkspace('fix my essay', {}, act({ decideKind: () => new Promise<TaskKindResult>(() => {}) }));
      await jest.advanceTimersByTimeAsync(ATTACH_GATE_TIMEOUT_MS + ATTACH_GATE_SLACK_MS + 10);
      expect(await p).toMatchObject({ attach: true, reason: 'kind_unavailable' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('shadow (the default mode — the store row absent): returns at once with the keyword, the verdict row lands from the background ask', async () => {
    const rows: any[] = [];
    let release!: (r: TaskKindResult) => void;
    const decideKind = jest.fn(() => new Promise<TaskKindResult>((r) => { release = r; }));
    const sh = await shouldAttachWorkspace('fix the grammar: their going to there house', { chatId: 'c2' }, { facts: async () => FACTS, decideKind, record: (r) => rows.push(r), env: {} });
    expect(sh).toMatchObject({ mode: 'shadow', attach: true, wouldAttach: null, reason: 'shadow_pending' });
    expect(rows).toHaveLength(0);
    await new Promise((r) => setImmediate(r));
    release(res('writing', 0.97));
    await new Promise((r) => setImmediate(r));
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ mode: 'shadow', attach: true, wouldAttach: false, reason: 'kind_not_code' });
    // A pre-ask verdict in shadow: recorded at once, the keyword still decides (a webhook still attaches in shadow).
    const wh = await shouldAttachWorkspace('rules: delete the branch …', { origin: 'webhook' }, { mode: async () => 'shadow', record: (r) => rows.push(r), env: {} });
    expect(wh).toMatchObject({ mode: 'shadow', attach: true, wouldAttach: false, reason: 'webhook_origin' });
    const off = await shouldAttachWorkspace('fix the grammar', {}, { decideKind, record: () => {}, env: {}, mode: async () => 'off' });
    expect(off).toMatchObject({ mode: 'off', attach: true, reason: 'gate_disabled' });
    expect(await shouldAttachWorkspace('fix my essay', {}, { facts: async () => FACTS, decideKind, record: () => {}, env: {}, mode: async () => { throw new Error('store'); } }))
      .toMatchObject({ mode: 'shadow', attach: true });
  });
});
