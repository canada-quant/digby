/**
 * retire-nudge (WI-G, 2026-09-25) — the one-time deploy retire notice a MACHINE
 * chat run gets at its next tool round on a RETIRING colour. Pins:
 *   - delivered exactly ONCE per run, and only once the process is retiring;
 *   - the inner injector's text (drafts / colleague notes) is preserved ahead
 *     of the nudge; a null inner result still delivers the nudge alone;
 *   - user turns return the inner injector untouched (never a wrapper);
 *   - the remaining-seconds estimate = budget − elapsed since the retire
 *     stamp, floored at 0; telemetry seam fires once with step + remaining.
 */

import {
  wrapInjectWithRetireNudge,
  retireRemainingSeconds,
  retireNudgeText,
  retireBudgetSeconds,
  DEFAULT_RETIRE_BUDGET_SECONDS,
} from './retire-nudge';

describe('retireRemainingSeconds', () => {
  it('budget minus elapsed since the retire stamp, floored at 0; no stamp → the whole budget', () => {
    const since = '2026-09-25T10:00:00.000Z';
    const at = (s: number) => Date.parse(since) + s * 1000;
    expect(retireRemainingSeconds({ retiringSinceIso: since, budgetSeconds: 900, nowMs: at(0) })).toBe(900);
    expect(retireRemainingSeconds({ retiringSinceIso: since, budgetSeconds: 900, nowMs: at(300) })).toBe(600);
    expect(retireRemainingSeconds({ retiringSinceIso: since, budgetSeconds: 900, nowMs: at(5000) })).toBe(0);
    expect(retireRemainingSeconds({ retiringSinceIso: null, budgetSeconds: 900, nowMs: at(300) })).toBe(900);
  });
});

describe('env knobs', () => {
  it("budget defaults to the deploy script's 900 s", () => {
    expect(retireBudgetSeconds({})).toBe(DEFAULT_RETIRE_BUDGET_SECONDS);
    expect(retireBudgetSeconds({ DEPLOY_RETIRE_BUDGET_SECONDS: '1500' })).toBe(1500);
    expect(retireBudgetSeconds({ DEPLOY_RETIRE_BUDGET_SECONDS: 'nope' })).toBe(900);
  });
});

describe('wrapInjectWithRetireNudge', () => {
  const since = '2026-09-25T10:00:00.000Z';
  const base = (over: Partial<Parameters<typeof wrapInjectWithRetireNudge>[1]> = {}) => ({
    machineTriggered: true,
    isRetiring: () => true,
    retiringSinceIso: () => since,
    budgetSeconds: 900,
    now: () => Date.parse(since) + 120_000,
    ...over,
  });

  it('delivers the nudge exactly once, on the first round that finds the process retiring', async () => {
    let retiring = false;
    const onNudge = jest.fn();
    const inject = wrapInjectWithRetireNudge(undefined, base({ isRetiring: () => retiring, onNudge }))!;
    expect(await inject(0)).toBeNull();          // not retiring yet
    retiring = true;
    const first = await inject(1);
    expect(typeof first).toBe('string');
    expect(first).toContain('RETIRING');
    expect(first).toContain('roughly 780 s');    // 900 − 120
    expect(await inject(2)).toBeNull();          // never again
    expect(await inject(3)).toBeNull();
    expect(onNudge).toHaveBeenCalledTimes(1);
    expect(onNudge).toHaveBeenCalledWith({ step: 1, remainingSeconds: 780 });
  });

  it("preserves the inner injector's text ahead of the nudge, for string and object results", async () => {
    const strInner = jest.fn(async (step: number) => (step === 1 ? '[DRAFTS]' : null));
    const inject = wrapInjectWithRetireNudge(strInner, base())!;
    const out = (await inject(1)) as string;
    expect(out.startsWith('[DRAFTS]\n\n')).toBe(true);
    expect(out).toContain(retireNudgeText(780));
    expect(await inject(2)).toBeNull();

    const objInner = async () => ({ text: '[NOTES]', images: [{ id: 'img' }] as any[] });
    const inject2 = wrapInjectWithRetireNudge(objInner, base())!;
    const out2 = (await inject2(1)) as { text: string; images?: any[] };
    expect(out2.text.startsWith('[NOTES]\n\n')).toBe(true);
    expect(out2.text).toContain('RETIRING');
    expect(out2.images).toEqual([{ id: 'img' }]);
    // after the nudge the inner result flows through untouched
    expect(await inject2(2)).toEqual({ text: '[NOTES]', images: [{ id: 'img' }] });
  });

  it('a user turn is never nudged — the inner injector is returned as-is (undefined stays undefined)', async () => {
    const inner = async () => 'x';
    expect(wrapInjectWithRetireNudge(inner, base({ machineTriggered: false }))).toBe(inner);
    expect(wrapInjectWithRetireNudge(undefined, base({ machineTriggered: false }))).toBeUndefined();
  });

  it('a telemetry seam that throws never breaks the injection', async () => {
    const inject = wrapInjectWithRetireNudge(undefined, base({ onNudge: () => { throw new Error('boom'); } }))!;
    expect(await inject(1)).toContain('RETIRING');
  });

  it('remaining seconds floor at 0 once the budget is spent', async () => {
    const inject = wrapInjectWithRetireNudge(undefined, base({ now: () => Date.parse(since) + 2_000_000 }))!;
    expect(await inject(1)).toContain('roughly 0 s');
  });
});

// audit 2026-10-06 T4-4 (spark.md F3c): the retire notice tells the run to
// FINISH any re-arm / dispatch it already decided on before writing its final;
// RETIRE_NUDGE_FINISH_REARM_DISABLED=1 restores the previous text byte-for-byte.
describe('retireNudgeText — finish the re-arm first (audit 2026-10-06 T4-4)', () => {
  it('asks for the real re-arm / dispatch call before the final', () => {
    const t = retireNudgeText(300, {} as any);
    expect(t).toContain('first finish any re-arm or dispatch you already decided on');
    expect(t).toContain('schedule_message');
    expect(t).toContain('PLANNED — NOT EXECUTED');
    expect(t).not.toContain('write your final message in your next turn');
  });
  it('kill switch restores the previous wording byte-for-byte', () => {
    expect(retireNudgeText(300, { RETIRE_NUDGE_FINISH_REARM_DISABLED: '1' } as any)).toBe(
      '[HARNESS NOTICE — deploy: this server is RETIRING and is torn down in roughly 300 s. Finish THIS run now: stop exploring, write your final message in your next turn from what you already have, and label anything unfinished as PLANNED — NOT EXECUTED. If the server is replaced before you finish, the harness re-fires this turn on the new server with your executed-tool receipts, so nothing is lost — but a run that finishes here costs nothing to replay.]',
    );
  });
});
