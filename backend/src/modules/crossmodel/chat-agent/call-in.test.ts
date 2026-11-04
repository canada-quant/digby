/**
 * roster 2026-10-06 D-2 — the lead's call_in tool: where it is offered, which model it calls in (pools, other family),
 * and its bounds (one per turn, a window inside the lead's budget, a hard harness race, never throws).
 */
import {
  callInOffer, pickCallInModels, callInToolSchema, callInDoctrineRow, callInWorkerDoctrine, createCallInTool, callInMaxMs,
  CALL_IN_MAX_MS_DEFAULT, CALL_IN_MIN_MS, CALL_IN_RESERVE_MS, CALL_IN_HARD_GRACE_MS, CALL_IN_MAX_STEPS, CALL_IN_TOOL,
  type CallInCandidateCard, type CallInDeps, type CallInOfferInput,
} from './call-in';
import { parseRosterConfig } from '../platform/roster-config';
import { modelFamily } from '../model-endpoints/model-catalog';
import { STATUS } from './status-voice';

const human: CallInOfferInput = { userId: 'u1', supervisor: false, machine: false, escalation: false, council: false, quick: false, checkerRunning: false };

afterEach(() => { delete process.env.CALL_IN_DISABLED; delete process.env.CALL_IN_MAX_MS; });

describe('callInOffer — where the tool is offered', () => {
  it('canary (the default mode): only the canary users; act: every signed-in human turn', () => {
    expect(callInOffer(human, parseRosterConfig({})).offered).toBe(false);
    const canary = callInOffer(human, parseRosterConfig({ rosterCanaryUserIds: ['u1'] }));
    expect(canary).toMatchObject({ offered: true, roles: ['checker', 'colleague'], mode: 'canary', canary: true });
    expect(callInOffer({ ...human, userId: 'u2' }, parseRosterConfig({ callIn: 'act' }))).toMatchObject({ offered: true, mode: 'act', canary: false });
  });

  it('never on a supervisor chat, a machine turn, a Dig-deeper rung, a council, the Quick lane or a guest — even in act', () => {
    const act = parseRosterConfig({ callIn: 'act', rosterCanaryUserIds: ['u1'] });
    for (const [over, why] of [
      [{ supervisor: true }, 'supervisor chat'], [{ machine: true }, 'machine turn'], [{ escalation: true }, 'dig deeper rung'],
      [{ council: true }, 'council turn'], [{ quick: true }, 'quick lane'], [{ userId: null }, 'guest'],
    ] as const) {
      expect(callInOffer({ ...human, ...over } as CallInOfferInput, act)).toMatchObject({ offered: false, why });
    }
  });

  it('a running Double Checker leaves only the colleague role (one checker per answer); mode off and CALL_IN_DISABLED=1 offer nothing', () => {
    const act = parseRosterConfig({ callIn: 'act' });
    expect(callInOffer({ ...human, checkerRunning: true }, act).roles).toEqual(['colleague']);
    expect(callInOffer(human, parseRosterConfig({ callIn: 'off', rosterCanaryUserIds: ['u1'] })).offered).toBe(false);
    process.env.CALL_IN_DISABLED = '1';
    expect(callInOffer(human, act)).toMatchObject({ offered: false, why: 'CALL_IN_DISABLED', mode: 'disabled' });
  });
});

describe('pickCallInModels — pools, other family', () => {
  const catalog = new Map([
    ['cql:deepseek-v4.1-flash', { spec: 'cql:deepseek-v4.1-flash', family: 'deepseek', servable: true }],
    ['cql:glm-5.3-flash', { spec: 'cql:glm-5.3-flash', family: 'glm', servable: true }],
    ['cql:kimi-k3', { spec: 'cql:kimi-k3', family: 'kimi', servable: true }],
    ['cql:qwen-nothink', { spec: 'cql:qwen-nothink', family: 'qwen', servable: true, thinkingOff: true }],
    ['kimi-k2.6', { spec: 'kimi-k2.6', family: 'kimi', servable: false }],
  ]);
  const pools = { checker: ['cql:glm-5.3-flash', 'cql:deepseek-v4.1-flash'], colleague: ['kimi-k2.6', 'cql:qwen-nothink', 'cql:kimi-k3', 'cql:deepseek-v4.1-flash'] };

  it('checker: the checker pool first, never the lead\'s family', () => {
    expect(pickCallInModels('checker', { lead: 'glm-5.3', pools, catalog, familyOf: modelFamily }).map((p) => p.spec))
      .toEqual(['cql:deepseek-v4.1-flash', 'cql:kimi-k3']);
  });

  it('colleague: the colleague pool first; unservable / no-think / same-family / the lead itself are skipped', () => {
    expect(pickCallInModels('colleague', { lead: 'cql:deepseek-v4.1-flash', pools, catalog, familyOf: modelFamily }).map((p) => p.spec))
      .toEqual(['cql:kimi-k3', 'cql:glm-5.3-flash']);
  });

  it('frontier hard rule (owner 2026-10-06 late): a frontier card — or a frontier-seated Double Checker reached through the seat fallback (no card) — is never called in; only AUTO_PICK_FRONTIER_ENABLED=1 admits it', () => {
    const cat = new Map<string, CallInCandidateCard>([...catalog, ['cql:api-openai-gpt-6-astra', { spec: 'cql:api-openai-gpt-6-astra', family: 'gpt', servable: true, frontier: true }]]);
    const p = { checker: ['cql:api-openai-gpt-6-astra', 'cql:api-anthropic-claude-fable-5-1', 'cql:kimi-k3'], colleague: [] };
    expect(pickCallInModels('checker', { lead: 'glm-5.3', pools: p, catalog: cat, familyOf: modelFamily, env: {} }).map((x) => x.spec)).toEqual(['cql:kimi-k3']);
    expect(pickCallInModels('checker', { lead: 'glm-5.3', pools: p, catalog: cat, familyOf: modelFamily, env: { AUTO_PICK_FRONTIER_ENABLED: '1' } }).map((x) => x.spec))
      .toEqual(['cql:api-openai-gpt-6-astra', 'cql:api-anthropic-claude-fable-5-1', 'cql:kimi-k3']);
  });

  it('a spec the catalog does not know stays a candidate (family from the id); only same-family models ⇒ none', () => {
    expect(pickCallInModels('checker', { lead: 'glm-5.3', pools: { checker: ['deepseek-flash'], colleague: [] }, catalog: new Map(), familyOf: modelFamily }))
      .toEqual([{ spec: 'deepseek-flash', family: 'deepseek' }]);
    expect(pickCallInModels('checker', { lead: 'glm-5.3', pools: { checker: ['glm-5.3-flash'], colleague: ['glm-5.3'] }, catalog: new Map(), familyOf: modelFamily })).toEqual([]);
  });
});

describe('prompt text', () => {
  it('the schema and the doctrine row name call_in and only the roles on offer', () => {
    const both = callInToolSchema(['checker', 'colleague']);
    expect(both.function.name).toBe(CALL_IN_TOOL);
    expect((both.function.parameters as any).properties.role.enum).toEqual(['checker', 'colleague']);
    expect((both.function.parameters as any).required).toEqual(['role', 'brief']);
    expect((callInToolSchema(['colleague']).function.parameters as any).properties.role.enum).toEqual(['colleague']);
    const row = callInDoctrineRow(['checker', 'colleague']);
    expect(row).toMatch(/^## Calling in help \(call_in\)/);
    expect(row).toMatch(/ONCE/);
    expect(row).toMatch(/never say a second model checked your answer unless its report is in this turn/);
    expect(callInDoctrineRow(['colleague'])).not.toMatch(/role 'checker'/);
    expect(row.length).toBeLessThan(900);
  });

  it('the worker doctrine is read-only, bounded and role-shaped', () => {
    const d = callInWorkerDoctrine({ role: 'checker', brief: 'verify the 2025 GDP figure', windowMs: 120_000, systemContext: '[CTX]', now: new Date('2026-10-06T10:00:00Z') });
    expect(d).toMatch(/INDEPENDENT model of a different family/);
    expect(d).toMatch(/verify the 2025 GDP figure/);
    expect(d).toMatch(/CANNOT ask the user anything or act on their behalf/);
    expect(d).toMatch(new RegExp(`about 120s and at most ${CALL_IN_MAX_STEPS} tool rounds`));
    expect(d).toContain('[CTX]');
    expect(callInWorkerDoctrine({ role: 'colleague', brief: 'b', windowMs: 60_000 })).toMatch(/research colleague CALLED IN/);
  });

  it('the status lines follow the status voice', () => {
    expect(STATUS.callIn.start('the Double Checker', 'verify the GDP')).toBe('Digby called in the Double Checker — “verify the GDP”…');
    expect(STATUS.callIn.done('the Triple Checker', 42_000)).toBe('Digby has the report from the Triple Checker (42s) — weighing it…');
    expect(STATUS.callIn.missed('the Double Checker')).toBe('Digby is carrying on without the Double Checker…');
  });

  it('CALL_IN_MAX_MS is clamped', () => {
    expect(callInMaxMs({})).toBe(CALL_IN_MAX_MS_DEFAULT);
    expect(callInMaxMs({ CALL_IN_MAX_MS: '5' })).toBe(30_000);
    expect(callInMaxMs({ CALL_IN_MAX_MS: '999999' })).toBe(300_000);
    expect(callInMaxMs({ CALL_IN_MAX_MS: 'x' })).toBe(CALL_IN_MAX_MS_DEFAULT);
  });
});

describe('createCallInTool — the bounded executor', () => {
  function harness(over: Partial<CallInDeps> = {}) {
    let clock = 1_000_000;
    const sent: Array<{ type: string; data: any }> = [];
    const rows: any[] = [];
    const cards: any[] = [];
    const worker = jest.fn(async (_req: any) => ({ finalText: 'The figure is 2.1% (source: stats.gov).\n\nACTIONS TAKEN:\n- sent the report', parts: [{ type: 'tool_call', name: 'search_engine' }, { type: 'tool_result', name: 'search_engine' }] }));
    const deps: CallInDeps = {
      roles: ['checker', 'colleague'],
      leadModel: () => 'glm-5.3',
      leadBudget: () => ({ startedAt: 1_000_000, deadlineMs: 480_000 }),
      candidates: async () => ({ pools: { checker: ['cql:deepseek-v4.1-flash'], colleague: ['cql:deepseek-v4.1-flash', 'cql:kimi-k3'] }, catalog: new Map() }),
      familyOf: modelFamily,
      unservable: async () => null,
      runWorker: worker,
      send: (type, data) => { sent.push({ type, data }); },
      onCard: (key, card) => { cards.push({ key, card }); },
      record: (meta) => { rows.push(meta); },
      now: () => clock,
      ...over,
    };
    const ci = createCallInTool(deps);
    return { ci, deps, sent, rows, cards, worker, tick: (ms: number) => { clock += ms; } };
  }

  it('runs ONE other-family model on the brief, inside the window, and returns its report for the lead to weigh', async () => {
    const h = harness();
    const out = await h.ci.tool.execute({ role: 'checker', brief: 'verify the 2.1% growth figure' });
    expect(h.worker).toHaveBeenCalledTimes(1);
    const req = h.worker.mock.calls[0][0];
    expect(req).toMatchObject({ role: 'checker', model: 'cql:deepseek-v4.1-flash', maxSteps: CALL_IN_MAX_STEPS, windowMs: CALL_IN_MAX_MS_DEFAULT });
    expect(req.doctrine).toMatch(/verify the 2\.1% growth figure/);
    expect(out).toMatch(/^\[CALL-IN REPORT — the Double Checker \(checker, another model family\)/);
    expect(out).toMatch(/2\.1% \(source: stats\.gov\)/);
    expect(out).not.toMatch(/ACTIONS TAKEN/); // a read-only worker's action claims are stripped
    expect(out).toMatch(/Weigh it against your own research/);
    expect(h.ci.record()).toMatchObject({ role: 'checker', model: 'cql:deepseek-v4.1-flash', family: 'deepseek', ok: true, outcome: 'ok', webToolCalls: 1 });
    expect(h.rows.at(-1)).toMatchObject({ phase: 'call', outcome: 'ok', role: 'checker', model: 'cql:deepseek-v4.1-flash', family: 'deepseek', leadModel: 'glm-5.3', leadFamily: 'glm' });
    expect(h.cards[0]).toMatchObject({ key: 'double_checker', card: { modelUsed: 'cql:deepseek-v4.1-flash', persona: 'Double Checker' } });
    expect(h.sent.some((e) => e.type === 'progress' && /Digby called in the Double Checker/.test(e.data.message))).toBe(true);
    expect(h.sent.some((e) => e.type === 'agent-activity' && e.data.kind === 'sub_end')).toBe(false); // the card path emits it
  });

  it('ONE per turn: a second call returns the first report again — never a second run', async () => {
    const h = harness();
    const first = await h.ci.tool.execute({ role: 'colleague', brief: 'find the 2024 figure' });
    const second = await h.ci.tool.execute({ role: 'checker', brief: 'again' });
    expect(h.worker).toHaveBeenCalledTimes(1);
    expect(second).toContain(first);
    expect(second).toMatch(/already used for this answer/);
    expect(h.rows.at(-1)).toMatchObject({ outcome: 'repeat' });
  });

  it('refuses without spending the slot: a checker while one already runs, a missing brief, a bad role', async () => {
    const h = harness({ roles: ['colleague'] });
    expect(await h.ci.tool.execute({ role: 'checker', brief: 'x' })).toMatch(/A Double Checker already runs on this answer/);
    expect(await h.ci.tool.execute({ role: 'colleague', brief: '  ' })).toMatch(/needs a brief/);
    expect(await h.ci.tool.execute({ role: 'oracle', brief: 'x' })).toMatch(/needs role 'colleague'/);
    expect(h.worker).not.toHaveBeenCalled();
    expect(await h.ci.tool.execute({ role: 'colleague', brief: 'x' })).toMatch(/CALL-IN REPORT — the Triple Checker/);
    expect(h.cards[0].key).toBe('triple_checker');
  });

  it('the window lives inside the lead\'s budget: too little time left ⇒ an honest refusal, no run', async () => {
    const h = harness({ leadBudget: () => ({ startedAt: 1_000_000, deadlineMs: 240_000 }) });
    h.tick(240_000 - CALL_IN_RESERVE_MS - CALL_IN_MIN_MS + 1_000); // 44 s usable < CALL_IN_MIN_MS
    expect(await h.ci.tool.execute({ role: 'checker', brief: 'x' })).toMatch(/Not enough time left/);
    expect(h.worker).not.toHaveBeenCalled();
    expect(h.rows.at(-1)).toMatchObject({ outcome: 'refused', reason: 'no_time' });
    const h2 = harness({ leadBudget: () => ({ startedAt: 1_000_000, deadlineMs: 240_000 }) });
    h2.tick(60_000);
    await h2.ci.tool.execute({ role: 'checker', brief: 'x' });
    expect(h2.worker.mock.calls[0][0].windowMs).toBe(240_000 - 60_000 - CALL_IN_RESERVE_MS);
  });

  it('no other-family candidate / every candidate unservable ⇒ an honest refusal (slot spent, no run)', async () => {
    const h = harness({ candidates: async () => ({ pools: { checker: ['glm-5.3-flash'], colleague: [] }, catalog: new Map() }) });
    expect(await h.ci.tool.execute({ role: 'checker', brief: 'x' })).toMatch(/No model of another family can be called in here \(no other-family candidate\)/);
    const h2 = harness({ unservable: async () => 'no key' });
    expect(await h2.ci.tool.execute({ role: 'colleague', brief: 'x' })).toMatch(/no servable candidate/);
    expect(h.worker).not.toHaveBeenCalled();
    expect(h2.worker).not.toHaveBeenCalled();
    const h3 = harness({ candidates: async () => { throw new Error('pools down'); } });
    expect(await h3.ci.tool.execute({ role: 'checker', brief: 'x' })).toMatch(/pools unavailable/);
  });

  it('an empty / errored / thrown worker ⇒ the lead answers on its own research (an error card, never a throw)', async () => {
    for (const [impl, re] of [
      [async () => ({ finalText: '  ' }), /it returned nothing/],
      [async () => ({ finalText: 'provider said no', modelErrored: true }), /its model failed/],
      [async () => { throw new Error('boom'); }, /its model failed/],
    ] as const) {
      const h = harness({ runWorker: jest.fn(impl as any) });
      const out = await h.ci.tool.execute({ role: 'checker', brief: 'x' });
      expect(out).toMatch(re);
      expect(out).toMatch(/answer on your own research/);
      expect(h.ci.record()?.ok).toBe(false);
      expect(h.cards[0].card.error).toMatch(/^call_in /);
    }
  });

  it('a wedged worker is cut at the window + grace and told to stop (the latch)', async () => {
    jest.useFakeTimers();
    try {
      let seenCancel: (() => boolean) | null = null;
      const h = harness({ runWorker: jest.fn((req: any) => { seenCancel = req.isCancelled; return new Promise(() => {}); }) as any, now: () => Date.now(), leadBudget: () => ({ startedAt: Date.now(), deadlineMs: 480_000 }) });
      const p = h.ci.tool.execute({ role: 'checker', brief: 'x' });
      await jest.advanceTimersByTimeAsync(CALL_IN_MAX_MS_DEFAULT + CALL_IN_HARD_GRACE_MS + 10);
      await expect(p).resolves.toMatch(/it ran out of time/);
      expect(seenCancel!()).toBe(true);
      expect(h.ci.record()?.outcome).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('the user\'s Stop reaches the worker; a throwing dependency never escapes', async () => {
    let stopped = false;
    const h = harness({ isCancelled: () => stopped, runWorker: jest.fn(async (req: any) => { stopped = true; expect(req.isCancelled()).toBe(true); return { finalText: 'partial' }; }) as any });
    expect(await h.ci.tool.execute({ role: 'checker', brief: 'x' })).toMatch(/the run was stopped/);
    const h2 = harness({ leadBudget: () => { throw new Error('nope'); } });
    await expect(h2.ci.tool.execute({ role: 'checker', brief: 'x' })).resolves.toMatch(/call_in failed before it could start/);
  });
});
