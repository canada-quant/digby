/**
 * Trajectory evals — the REPLAY model (build 2026-10-08 E-3).
 *
 * Serves a recording's model outputs in order, one queue per agent ('lead',
 * then workers 'w1', 'w2' … in the order their conversations first appear).
 * When the harness asks for MORE outputs than were recorded (a new retry
 * round, a reject-back the incident never saw) the replay has DIVERGED: the
 * recording no longer describes what today's harness would send the model,
 * so the trial is reported as such (re-record it with the live mode) rather
 * than graded on a made-up turn.
 */

import { createHash } from 'crypto';
import type { RecordedTurn, Recording } from './types';

export class ReplayDivergedError extends Error {
  constructor(public readonly agent: string, public readonly served: number, detail?: string) {
    super(detail ?? `replay diverged: the harness asked agent "${agent}" for model output #${served + 1}, the recording has ${served}`);
    this.name = 'ReplayDivergedError';
  }
}

/** Stable fingerprint of one agent loop's conversation (system head + first user message head). */
export function conversationKey(messages: any[]): string {
  const text = (m: any): string => {
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
    return '';
  };
  const sys = (messages || []).find((m: any) => m?.role === 'system');
  const user = (messages || []).find((m: any) => m?.role === 'user');
  return createHash('sha1').update(`${text(sys).slice(0, 600)}\u0000${text(user).slice(0, 600)}`).digest('hex').slice(0, 16);
}

/** Assigns 'lead' to the first conversation seen and w1, w2 … to the next ones. */
export class AgentLabeler {
  private labels = new Map<string, string>();
  label(messages: any[]): string {
    const key = conversationKey(messages);
    let l = this.labels.get(key);
    if (!l) {
      l = this.labels.size === 0 ? 'lead' : `w${this.labels.size}`;
      this.labels.set(key, l);
    }
    return l;
  }
}

export interface ReplayTurnResult {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
}

/** An axios-shaped HTTP error (what runModelTurn throws on a provider rejection). */
export function providerHttpError(status: number, body: string): Error {
  const { Readable } = require('stream') as typeof import('stream');
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: Readable.from([body]) },
  });
}

export function toTurnResult(t: RecordedTurn, index: number): ReplayTurnResult {
  const toolCalls = (t.toolCalls ?? []).map((tc, i) => ({
    id: tc.id ?? `call_eval_${index}_${i}`,
    name: tc.name,
    arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
  }));
  return {
    content: t.content ?? '',
    reasoning: t.reasoning ?? '',
    toolCalls,
    finishReason: t.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
  };
}

export class ReplayModel {
  private queues = new Map<string, RecordedTurn[]>();
  private served = new Map<string, number>();
  private total = 0;

  constructor(recording: Recording) {
    for (const t of recording.turns) {
      const agent = t.agent || 'lead';
      if (!this.queues.has(agent)) this.queues.set(agent, []);
      this.queues.get(agent)!.push(t);
    }
  }

  /**
   * Next recorded output for `agent`; throws ReplayDivergedError when the
   * recording is exhausted, or when the turn names the model that produced it
   * and the harness is now asking a different one.
   */
  next(agent: string, askedModel?: string): RecordedTurn {
    const q = this.queues.get(agent) ?? [];
    const n = this.served.get(agent) ?? 0;
    if (n >= q.length) throw new ReplayDivergedError(agent, n);
    const t = q[n];
    if (t.model && askedModel && t.model !== askedModel) {
      throw new ReplayDivergedError(agent, n, `replay diverged: output #${n + 1} for agent "${agent}" was recorded from model "${t.model}", the harness now asks "${askedModel}"`);
    }
    this.served.set(agent, n + 1);
    this.total += 1;
    return t;
  }

  /** Recorded outputs nobody asked for (the harness now ends the run sooner than the recording). */
  unused(): Array<{ agent: string; count: number }> {
    const out: Array<{ agent: string; count: number }> = [];
    for (const [agent, q] of this.queues) {
      const left = q.length - (this.served.get(agent) ?? 0);
      if (left > 0) out.push({ agent, count: left });
    }
    return out;
  }

  get servedTotal(): number { return this.total; }
}
