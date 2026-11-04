/**
 * Trajectory evals — the per-TRIAL runtime the module seams consult (build
 * 2026-10-08 E-5).
 *
 * The mocked seams (eval-mocks.testkit.ts: the provider call, the three tool
 * executors, the registry / seat lookups, the clock block, the context store)
 * read the CURRENT trial from an AsyncLocalStorage, so live trials can run
 * concurrently without sharing fixtures, captures or clocks. Outside a trial
 * (no store) every seam falls through to the real implementation.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { RecordedTurn, ToolFixture } from './types';
import type { CapturedCall } from './fixtures';
import { answerToolCall } from './fixtures';
import { AgentLabeler, ReplayDivergedError, ReplayModel, providerHttpError, toTurnResult } from './replay-model';

export interface EvalRegistryEntry {
  url: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  label: string;
  supportsVision: boolean;
  coding: boolean;
  chatCapable: boolean;
  kind: 'chat';
  maxToolsSource: 'none';
  providerClass: 'open';
  reasoningEffort: 'auto';
  contextWindow?: number;
  matryoshka: boolean;
  thinkingOff: boolean;
  providerShape: 'openai_chat';
}

export interface TrialRuntime {
  caseId: string;
  mode: 'replay' | 'live';
  fixtures: ToolFixture[];
  isMutating: (tool: string) => boolean;
  now: Date;
  timezone: string;
  /** Registry resolution for `<label>:<model>` specs (gateway seats). */
  registry: (spec: string) => EvalRegistryEntry | null;
  /** The custom fallback a seat lookup answers (content-filter class cases). */
  fallbackModel?: string;
  replay?: ReplayModel;
  labeler: AgentLabeler;
  calls: CapturedCall[];
  seq: number;
  modelCalls: number;
  modelsUsed: string[];
  /** Live: every model output, ready to be saved as a recording. */
  turns: RecordedTurn[];
  /** Every tool call the MODEL issued (executed or refused by a harness preflight) — what call_ids_grounded grades. */
  issued: Array<{ agent: string; tool: string; args: Record<string, unknown> }>;
  diverged?: string;
  /** The lead's first request (what the model saw before answering). */
  inputsText?: string;
  store: Map<string, unknown>;
  /** Tests only: stands in for the provider in a LIVE trial (the runner's own plumbing is tested offline). */
  liveCall?: (...args: any[]) => Promise<any>;
  metrics: Array<{ kind: string; meta?: unknown }>;
}

export const trialStore = new AsyncLocalStorage<TrialRuntime>();

export function currentTrial(): TrialRuntime | undefined {
  return trialStore.getStore();
}

function noteIssued(rt: TrialRuntime, agent: string, toolCalls: Array<{ name: string; arguments?: string }> | undefined): void {
  for (const tc of toolCalls ?? []) {
    let args: Record<string, unknown> = {};
    try { const v = JSON.parse(tc.arguments || '{}'); if (v && typeof v === 'object') args = v; } catch { /* malformed — recorded empty */ }
    rt.issued.push({ agent, tool: tc.name, args });
  }
}

function messageText(m: any): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/**
 * PROTOCOL side calls: harness-initiated model turns whose output is never
 * delivered and never executed (today: the typed finish_run SHADOW nudge,
 * build 2026-10-08 F-1 — "its output is never delivered and finalText is never
 * touched"). They do not change what a trial delivers, so a replay answers
 * them with an empty reply (the harness then auto-finishes from receipts)
 * instead of diverging, and a live trial answers them for real without
 * recording them as the model's work. Every other unrecorded model call is
 * still a divergence.
 */
export function protocolSideCall(messages: any[]): string | null {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!last || last.role !== 'user' || typeof last.content !== 'string') return null;
  try {
    const { FINISH_RUN_NUDGE } = require('../../coding/finish-run');
    if (FINISH_RUN_NUDGE && last.content === FINISH_RUN_NUDGE) return 'finish_run_nudge';
  } catch { /* module absent — no protocol call */ }
  return null;
}

/** The provider-call seam. `actual` is the real coding-model runModelTurn. */
export async function evalRunModelTurn(actual: (...a: any[]) => Promise<any>, args: any[]): Promise<any> {
  const rt = currentTrial();
  if (!rt) return actual(...args);
  const [provider, messages, , callbacks] = args;
  const proto = protocolSideCall(messages);
  if (proto) {
    rt.metrics.push({ kind: 'eval_protocol_call', meta: { id: proto } });
    if (rt.mode === 'replay') return { content: '', reasoning: '', toolCalls: [], finishReason: 'stop' };
    return (rt.liveCall ?? actual)(...args);
  }
  const agent = rt.labeler.label(messages);
  if (agent === 'lead' && rt.inputsText == null) {
    rt.inputsText = (messages || []).map((m: any) => messageText(m)).join('\n\n');
  }
  rt.modelCalls += 1;
  rt.modelsUsed.push(String(provider?.model ?? ''));
  if (rt.mode === 'replay') {
    let t: RecordedTurn;
    try {
      t = rt.replay!.next(agent, provider?.model ? String(provider.model) : undefined);
    } catch (err) {
      if (err instanceof ReplayDivergedError && !rt.diverged) rt.diverged = err.message;
      throw err;
    }
    if (t.error) throw providerHttpError(t.error.status, t.error.body);
    const r = toTurnResult(t, rt.modelCalls);
    noteIssued(rt, agent, r.toolCalls);
    try { if (r.content) callbacks?.onContent?.(r.content); } catch { /* streaming callbacks are cosmetic */ }
    return r;
  }
  try {
    const r = await (rt.liveCall ?? actual)(...args);
    noteIssued(rt, agent, r?.toolCalls);
    rt.turns.push({
      agent,
      ...(provider?.model ? { model: String(provider.model) } : {}),
      content: r?.content ?? '',
      ...(r?.reasoning ? { reasoning: String(r.reasoning).slice(0, 4000) } : {}),
      toolCalls: (r?.toolCalls ?? []).map((tc: any) => {
        let parsed: unknown = tc.arguments;
        try { parsed = JSON.parse(tc.arguments || '{}'); } catch { /* keep the raw string */ }
        return { name: tc.name, args: parsed as any, id: tc.id };
      }),
      ...(r?.finishReason ? { finishReason: r.finishReason } : {}),
    });
    return r;
  } catch (err: any) {
    const status = Number(err?.response?.status) || 0;
    if (status) rt.turns.push({ agent, ...(provider?.model ? { model: String(provider.model) } : {}), error: { status, body: String(err?.digbyBody ?? err?.message ?? '').slice(0, 2000) } });
    throw err;
  }
}

/** The tool seam shared by executeCodingTool / ToolCache.getOrExecute / executeIntegrationTool. */
export function evalToolCall(tool: string, rawArgs: unknown, agent = 'lead'): string | null {
  const rt = currentTrial();
  if (!rt) return null;
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  rt.seq += 1;
  const ans = answerToolCall({ caseId: rt.caseId, fixtures: rt.fixtures, tool, args, seq: rt.seq, isMutating: rt.isMutating });
  rt.calls.push({ seq: rt.seq, tool, args, output: ans.output, mutating: ans.mutating, agent, source: ans.source });
  return ans.output;
}

export { ReplayDivergedError };
