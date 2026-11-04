/**
 * Trajectory evals — the safety net catches what it exists to catch (build
 * 2026-10-08 E):
 *  - deleting a harness fix shows up: with the content-filter lane switched
 *    off, the frozen refusal no longer fails over and the replay DIVERGES;
 *  - a behaviour-preserving deletion stays invisible to the GRADES: the
 *    zero-tool pre-final gate (observe-only in prod; deleted by build
 *    2026-10-08 S-2) took its metric with it, yet the frozen zero-tool wake
 *    still grades exactly as recorded;
 *  - offline means offline: inside a replay trial axios / fetch are refused;
 *  - the prompt is TODAY's doctrine for every role;
 *  - the live runner's own plumbing (pass^k, judge, cost cap, recordings),
 *    exercised with a scripted model standing in for the provider.
 */

import './eval-mocks.testkit';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { loadCases } from './suite';
import { runReplaySuite, runLiveSuite, liveOptionsFromEnv, parseSeatOverrides, liveSeatFor } from './runner.testkit';
import { runTrial } from './harness.testkit';
import { trialStore, type TrialRuntime } from './eval-runtime';
import { AgentLabeler, ReplayModel, toTurnResult } from './replay-model';
import type { TrajectoryCase } from './types';

jest.setTimeout(60_000);

const byId = (id: string): TrajectoryCase => {
  const c = loadCases(undefined, [id])[0];
  if (!c) throw new Error(`case ${id} missing`);
  return c;
};

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  return fn().finally(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

describe('deleting or re-arming harness behaviour is visible in the replay', () => {
  it('content-filter lane OFF → the frozen refusal is re-sent to the same seat and the replay diverges', async () => {
    const c = byId('content-filter-retry-storm');
    const today = await runReplaySuite([c]);
    expect(today.cases[0].trials[0].grade.status).toBe('pass');
    const regressed = await withEnv({ CONTENT_FILTER_LANE_DISABLED: '1' }, () => runReplaySuite([c]));
    const t = regressed.cases[0].trials[0];
    expect(t.grade.status).toBe('diverged');
    expect(t.outcome.diverged).toMatch(/recorded from model "glm-5.3", the harness now asks "api-alibaba-qwen3.8-max"/);
    expect(regressed.cases[0].passHatK).toBe(false);
  });

  it('the deleted zero-tool gate (build 2026-10-08 S-2) leaves the frozen zero-tool wake grading exactly as recorded — only its observe-only metric is gone', async () => {
    const c = byId('supervisor-stale-relay-open-question');
    const status = (r: Awaited<ReturnType<typeof runReplaySuite>>, id: string) => r.cases[0].trials.find((t) => t.outcome.recordingId === id)!;
    const today = await runReplaySuite([c]);
    expect(status(today, 'incident').grade.status).toBe('fail');
    expect(status(today, 'reference').grade.status).toBe('pass');
    expect(status(today, 'incident').outcome.harnessMetrics?.['guard_strike:zero_tool_prefinal']).toBeUndefined();
    // The old re-arm switch is gone too: setting it changes nothing.
    const rearmed = await withEnv({ ZERO_TOOL_GATE_ENFORCE: '1' }, () => runReplaySuite([c]));
    expect(status(rearmed, 'incident').grade.status).toBe('fail');
  });
});

describe('protocol side calls never fail a replay', () => {
  it('the typed finish_run SHADOW nudge on a machine wake is answered by the replay, not counted as divergence', async () => {
    const c = byId('fleet-wake-phantom-dispatch');
    const r = await runReplaySuite([c]);
    for (const t of r.cases[0].trials) {
      expect(t.matchesExpectation).toBe(true);
      expect(t.outcome.harnessMetrics?.eval_protocol_call ?? 0).toBeGreaterThanOrEqual(1);
    }
    const off = await withEnv({ FINISH_RUN_DISABLED: '1' }, () => runReplaySuite([c]));
    expect(off.cases[0].trials.every((t) => !t.outcome.harnessMetrics?.eval_protocol_call)).toBe(true);
    expect(off.cases[0].passHatK).toBe(true);
  });
});

describe('offline means offline', () => {
  it('a replay trial cannot reach the network (axios or fetch); outside a trial nothing is intercepted', async () => {
    const rt = { mode: 'replay', metrics: [] as any[] } as unknown as TrialRuntime;
    await trialStore.run(rt, async () => {
      await expect(axios.get('https://example.invalid/x')).rejects.toThrow(/network call blocked/);
      await expect(axios.post('https://example.invalid/y', {})).rejects.toThrow(/network call blocked/);
      await expect((globalThis as any).fetch('https://example.invalid/z')).rejects.toThrow(/network call blocked/);
    });
    expect(rt.metrics.map((m) => (m.meta as any).via)).toEqual(['axios.get', 'axios.post', 'fetch']);
  });
});

describe('the prompt is today\'s doctrine', () => {
  it.each([
    ['fleet-relays-false-unpushed-note', ['fleet_supervisor_prompt', 'chat_doctrine']],
    ['stanne-phantom-message-tt-rd', ['project_supervisor_prompt', 'chat_doctrine']],
    ['guest-phantom-search-failure', ['chat_doctrine']],
    ['checker-contradicts-unread-evidence', ['verify_silence_rule']],
  ])('%s runs on %j', async (id, sources) => {
    const c = byId(id);
    const o = await runTrial(c, { mode: 'replay', recording: c.recordings.find((r) => r.kind === 'reference') ?? c.recordings[0], trialId: 't' });
    expect(o.promptSources).toEqual(expect.arrayContaining(sources as string[]));
    expect(o.inputsText).toContain(c.input.message.slice(0, 40));
  });

  // REVIEW F2 (ticket 4f7263e4): the first-word note is composed ONLY at the
  // live chat seam (chat-agent.service.ts crossCheckBlock) — it deliberately
  // does NOT ride the eval prompt (prompt.ts passes crossCheckBlock: '', the
  // frozen recordings predate the note and would diverge if it appeared).
  // Pinned so the non-riding is a contract, not an accident; the note's own
  // behavior is pinned in chat-agent (sse-adapter + compute-policy suites).
  it('the trial doctrine never carries the first-word note (crossCheckBlock: \'\' — frozen recordings predate it; review F2, ticket 4f7263e4)', async () => {
    const c = byId('guest-phantom-search-failure');
    const o = await runTrial(c, { mode: 'replay', recording: c.recordings.find((r) => r.kind === 'reference') ?? c.recordings[0], trialId: 't' });
    expect(o.promptSources).toEqual(expect.arrayContaining(['chat_doctrine']));
    expect(String((o as any).doctrine ?? o.inputsText)).not.toMatch(/## First word/);
    expect(String((o as any).doctrine ?? o.inputsText)).not.toMatch(/OPEN WITH ONE USEFUL LINE/);
  });
});

describe('live runner plumbing (scripted model in place of the provider)', () => {
  /** A stand-in provider that answers every conversation from the case's reference recording. */
  function scriptedModel(c: TrajectoryCase) {
    const rec = c.recordings.find((r) => r.kind === 'reference')!;
    let queues = new Map<string, ReplayModel>();
    const labeler = new AgentLabeler();
    let n = 0;
    return async (_provider: any, messages: any[]) => {
      const agent = labeler.label(messages);
      // A lead request with no tool results yet is a NEW trial — restart its script.
      if (agent === 'lead' && !messages.some((m: any) => m?.role === 'tool')) queues = new Map();
      if (!queues.has(agent)) queues.set(agent, new ReplayModel(rec));
      n += 1;
      return { ...toTurnResult(queues.get(agent)!.next('lead'), n), usage: { promptTokens: 1000, completionTokens: 100 } };
    };
  }

  it('k trials per case → pass^k, judge verdicts, recordings written, spend summed', async () => {
    const c = byId('stanne-phantom-message-tt-rd');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-live-'));
    const model = scriptedModel(c);
    const report = await withEnv({ ZAI_API_KEY: 'k', MOONSHOT_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' }, () => runLiveSuite([c], {
      k: 2, maxUsd: 5, concurrency: 1, trialTimeoutMs: 30_000, effort: 'high', gateway: null,
      judge: async () => ({ text: '{"verdict":"pass","reason":"ok"}', costUsd: 0.001 }),
      recordDir: dir,
      liveModelOverride: (...a: any[]) => {
        // each trial gets a fresh script (a new conversation per trial)
        return (model as any)(...a);
      },
    }));
    const r = report.cases[0];
    expect(r.trials).toHaveLength(2);
    expect(r.trials.map((t) => t.grade.status)).toEqual(['pass', 'pass']);
    expect(r).toMatchObject({ passHatK: true, passes: 2, k: 2 });
    expect(report).toMatchObject({ passHatKCases: 1, ranCases: 1 });
    expect(r.trials[0].outcome.judge).toMatchObject({ 'judge-answer-first': 'pass', 'judge-tool-honest': 'pass' });
    expect(report.costUsd).toBeGreaterThan(0);
    const recs = JSON.parse(fs.readFileSync(path.join(dir, `${c.id}.recordings.json`), 'utf8'));
    expect(recs[0]).toMatchObject({ kind: 'live', expect: 'pass' });
    expect(recs[0].turns[0]).toMatchObject({ agent: 'lead', model: 'kimi-k3' });
  });

  it('the cost cap stops starting trials (a capped case is reported, never scored)', async () => {
    const c = byId('stanne-switch-model-unsourced');
    const report = await runLiveSuite([c], { k: 3, maxUsd: 0, concurrency: 1, trialTimeoutMs: 30_000, effort: 'high', gateway: null, judge: null, liveModelOverride: scriptedModel(c) });
    expect(report.cases[0].skipped).toMatch(/cost cap/);
    expect(report.ranCases).toBe(0);
  });

  it('live options + seat mapping come from the environment', () => {
    const o = liveOptionsFromEnv({ EVAL_K: '2', EVAL_MAX_USD: '7.5', EVAL_SEATS: 'fleet_supervisor=glm-5.3,chat=deepseek-flash', EVAL_JUDGE_MODEL: 'off', EVAL_REPORT_DIR: '/tmp/x' } as any);
    expect(o).toMatchObject({ k: 2, maxUsd: 7.5, concurrency: 4, effort: 'high', judgeModel: null, reportDir: '/tmp/x', gateway: null });
    expect(parseSeatOverrides('a=b, c=d:e')).toEqual({ a: 'b', c: 'd:e' });
    const c = byId('fleet-relays-false-unpushed-note');
    expect(liveSeatFor(c, { seatOverrides: {} })).toBe('glm-5.3');
    expect(liveSeatFor(c, { seatOverrides: { fleet_supervisor: 'kimi-k3' } })).toBe('kimi-k3');
    expect(liveSeatFor(c, { seatOverrides: {}, gateway: { baseUrl: 'https://g/v1', apiKey: 'k' } })).toBe('cql-litellm:api-optimize-zai-glm-5.3');
  });
});
