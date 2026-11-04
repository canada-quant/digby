/**
 * Trajectory evals — run ONE trial through the REAL agent loop (build
 * 2026-10-08 E-8). JEST ONLY: import ./eval-mocks.testkit before this module.
 *
 * A trial = the case's frozen input → coding/agent.ts runCodingAgent (or
 * runChatWorker for a checker) with the role's real profile and today's
 * doctrine (prompt.ts) → the delivered final + the captured tool calls. The
 * model is the replay of a recording, or a live seat (its outputs recorded).
 * Mutating tools are captured by the fixture layer and NEVER executed.
 */

import type { Recording, TrajectoryCase } from './types';
import type { TrialOutcome } from './graders';
import { trialStore, type EvalRegistryEntry, type TrialRuntime } from './eval-runtime';
import { AgentLabeler, ReplayModel } from './replay-model';
import { buildTrialPrompt } from './prompt';

export interface TrialOptions {
  mode: 'replay' | 'live';
  /** Replay: the recording to serve. */
  recording?: Recording;
  /** Live: the seat model (a built-in id or a `<label>:<model>` gateway spec). */
  model?: string;
  trialId: string;
  /** Live: wall-clock bound per trial (the loop is cancelled cooperatively). */
  timeoutMs?: number;
  /** Live: 'high' caps the lead's reasoning effort (default — cost/time); 'max' keeps prod's machine-wake effort. */
  effort?: 'high' | 'max';
  /** Live: returns true when the run-wide cost cap is reached (the trial is cancelled). */
  stopRequested?: () => boolean;
  /** Live: a gateway for `<label>:<model>` seats (else the spec is mapped to its family built-in by the runner). */
  gateway?: { baseUrl: string; apiKey: string } | null;
  /** Tests only: stands in for the provider in live mode (same signature as runModelTurn). */
  liveModelOverride?: (...args: any[]) => Promise<any>;
}

/** The seat a role runs on when the case names none (prod's built-in seats). */
export function defaultSeatModel(c: TrajectoryCase): string {
  return c.seat?.model || 'glm-5.3';
}

function registryEntryFor(spec: string, gateway: TrialOptions['gateway']): EvalRegistryEntry | null {
  const i = spec.indexOf(':');
  if (i <= 0) return null;
  const label = spec.slice(0, i);
  const model = spec.slice(i + 1);
  const baseUrl = (gateway?.baseUrl || 'https://eval-gateway.invalid/v1').replace(/\/+$/, '');
  return {
    url: `${baseUrl}/chat/completions`,
    baseUrl,
    apiKey: gateway?.apiKey || 'eval-replay',
    model,
    label,
    supportsVision: false,
    coding: true,
    chatCapable: true,
    kind: 'chat',
    maxToolsSource: 'none',
    providerClass: 'open',
    reasoningEffort: 'auto',
    matryoshka: false,
    thinkingOff: false,
    providerShape: 'openai_chat',
  };
}

async function profileFor(c: TrajectoryCase): Promise<any> {
  const p = await import('../../coding/agent-profiles');
  const base = c.role === 'fleet_supervisor' ? p.supervisorProfile()
    : c.role === 'project_supervisor' ? p.projectSupervisorProfile()
      : p.chatProfile('thinking', false);
  return c.harness?.maxSteps ? { ...base, maxSteps: c.harness.maxSteps } : base;
}

export async function runTrial(c: TrajectoryCase, opts: TrialOptions): Promise<TrialOutcome> {
  const started = Date.now();
  const { MUTATING_TOOLS } = await import('../../coding/tools');
  const { UsageAccumulator } = await import('../../coding/cost');
  const agent = await import('../../coding/agent');
  // Replay runs on the model the recording was made with (a live recording names its trial model), else the case's seat.
  const model = opts.mode === 'live' ? (opts.model || defaultSeatModel(c)) : (opts.recording?.model || defaultSeatModel(c));
  const prompt = buildTrialPrompt(c);
  const usage = new UsageAccumulator();
  const rt: TrialRuntime = {
    caseId: c.id,
    mode: opts.mode,
    fixtures: c.fixtures,
    isMutating: (tool: string) => MUTATING_TOOLS.has(tool),
    now: new Date(c.input.now),
    timezone: c.input.timezone || 'UTC',
    registry: (spec: string) => registryEntryFor(spec, opts.gateway),
    fallbackModel: c.harness?.fallbackModel,
    ...(opts.mode === 'replay' ? { replay: new ReplayModel(opts.recording!) } : {}),
    labeler: new AgentLabeler(),
    calls: [],
    seq: 0,
    modelCalls: 0,
    modelsUsed: [],
    turns: [],
    issued: [],
    store: new Map(),
    metrics: [],
    ...(opts.mode === 'live' && opts.liveModelOverride ? { liveCall: opts.liveModelOverride } : {}),
  };
  let timedOut = false;
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; }, opts.timeoutMs) : null;
  timer?.unref?.();
  const humanTurn = c.trigger !== 'machine_wake';
  const outcome: TrialOutcome = {
    caseId: c.id,
    mode: opts.mode,
    recordingId: opts.mode === 'replay' ? opts.recording!.id : opts.trialId,
    model,
    finalText: '',
    calls: rt.calls,
    issued: rt.issued,
    modelCalls: 0,
    modelsUsed: [],
    inputsText: '',
    costUsd: 0,
    inTokens: 0,
    outTokens: 0,
    durationMs: 0,
  };
  try {
    const input: any = {
      worktree: '',
      sessionId: c.input.chatId || `eval-${c.id}`,
      projectId: c.input.projectId || 'chat',
      userId: 'eval-user',
      permissionMode: 'auto',
      model,
      projectName: 'chat',
      branch: 'chat',
      seatRole: c.role === 'fleet_supervisor' ? 'supervisor' : c.role === 'project_supervisor' ? 'project_supervisor' : 'chat_orchestrator',
      profile: await profileFor(c),
      doctrineOverride: prompt.doctrine,
      history: (c.input.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      userMessage: c.input.message,
      ...(humanTurn ? { userTurnAt: new Date(c.input.now), userTurnText: c.input.message.slice(0, 20_000) } : {}),
      machineTriggered: !humanTurn,
      usage,
      emit: () => {},
      isCancelled: () => timedOut || (opts.stopRequested?.() ?? false),
      ...(opts.mode === 'live' && opts.effort !== 'max' ? { effortCap: 'high' } : {}),
    };
    if (opts.mode === 'live' && humanTurn) {
      try {
        const { humanTurnProviderExtra } = await import('../../chat-agent/human-turn-effort');
        Object.assign(input, humanTurnProviderExtra(model, false));
      } catch { /* prod's human-turn effort cut is best-effort here */ }
    }
    const result = await trialStore.run(rt, () => (c.role === 'checker'
      ? agent.runChatWorker(input, 'cross_checker')
      : agent.runCodingAgent(input)));
    // Grade what the reader gets: the [FOLLOWUPS] block becomes suggestion chips (stripped from the
    // answer in prod, langgraph/pipeline-utils parseFollowUps) — a chip is a user prompt, not a claim.
    outcome.rawFinalText = result.finalText ?? '';
    try {
      const pu = await import('../../langgraph/pipeline-utils');
      outcome.finalText = pu.parseFollowUps(outcome.rawFinalText).cleanText;
    } catch {
      outcome.finalText = outcome.rawFinalText;
    }
    outcome.modelErrored = result.modelErrored === true;
  } catch (err: any) {
    outcome.error = String(err?.message || err).slice(0, 500);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const snap = usage.snapshot();
  outcome.modelCalls = rt.modelCalls;
  outcome.modelsUsed = rt.modelsUsed;
  outcome.inputsText = rt.inputsText ?? `${prompt.doctrine}\n\n${c.input.message}`;
  if (rt.diverged) outcome.diverged = rt.diverged;
  const unused = rt.replay?.unused() ?? [];
  if (unused.length) outcome.unusedTurns = unused.reduce((s, u) => s + u.count, 0);
  if (opts.mode === 'live') outcome.turns = rt.turns;
  outcome.costUsd = snap.totalCostUsd;
  outcome.inTokens = snap.totalInTokens;
  outcome.outTokens = snap.totalOutTokens;
  outcome.durationMs = Date.now() - started;
  if (timedOut && !outcome.error) outcome.error = `trial timed out after ${opts.timeoutMs} ms`;
  outcome.promptSources = prompt.sources;
  const hm: Record<string, number> = {};
  for (const m of rt.metrics) {
    const seam = (m.meta as any)?.seam;
    const key = seam ? `${m.kind}:${seam}` : m.kind;
    hm[key] = (hm[key] ?? 0) + 1;
  }
  outcome.harnessMetrics = hm;
  return outcome;
}
