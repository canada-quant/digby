/**
 * Trajectory evals — the FIXTURE tool layer (build 2026-10-08 E-2).
 *
 * Read tools answer from the case's frozen fixtures (first match wins).
 * Mutating tools are CAPTURED and answered with a deterministic success
 * envelope — nothing is ever executed. A read with no fixture answers a
 * neutral "no matching records" (never an error that would steer the run).
 * Pure: the harness passes the mutating-tool predicate in.
 */

import { createHash } from 'crypto';
import type { CallMatcher, ToolFixture } from './types';

export interface CapturedCall {
  /** Global order across the whole trial (lead + workers). */
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  /** What the run was told (the fixture output or the default envelope). */
  output: string;
  mutating: boolean;
  /** 'lead' or the worker label the call came from (best effort). */
  agent: string;
  /** Which seam answered: a fixture, the mutating capture, or the neutral default. */
  source: 'fixture' | 'captured' | 'default';
}

const WEB_TOOL_RE = /^(web_search|search_engine|web_pipe|scrape_as_markdown|scrape_as_html|scrape_batch|youtube_pipe|fetch_url|browser_task)$/;

/** Stringify an argument for substring matching (objects → compact JSON). */
function argText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** CallMatcher semantics (see types.ts): lenient, case-insensitive, outcome-oriented. */
export function matchArgs(spec: CallMatcher['args'] | undefined, args: Record<string, unknown>): boolean {
  if (!spec) return true;
  for (const [key, want] of Object.entries(spec)) {
    const have = key === '*' ? argText(args) : argText(args?.[key]);
    if (typeof want === 'number' || typeof want === 'boolean') {
      if (key === '*' ? !have.includes(String(want)) : args?.[key] !== want) return false;
      continue;
    }
    if (typeof want === 'string') {
      if (!have.toLowerCase().includes(want.toLowerCase())) return false;
      continue;
    }
    if (want && typeof want === 'object' && typeof (want as any).re === 'string') {
      if (!new RegExp((want as any).re, 'i').test(have)) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function matchCall(m: CallMatcher, call: Pick<CapturedCall, 'tool' | 'args' | 'output'>): boolean {
  const tools = Array.isArray(m.tool) ? m.tool : [m.tool];
  if (!tools.includes(call.tool)) return false;
  if (!matchArgs(m.args, call.args)) return false;
  if (m.output && !new RegExp(m.output, 'i').test(call.output)) return false;
  return true;
}

export function findFixture(fixtures: ToolFixture[], tool: string, args: Record<string, unknown>): ToolFixture | null {
  for (const f of fixtures) {
    if (f.tool !== tool) continue;
    if (matchArgs(f.args, args)) return f;
  }
  return null;
}

export function renderFixtureOutput(output: ToolFixture['output']): string {
  return typeof output === 'string' ? output : JSON.stringify(output, null, 1);
}

/** A uuid-shaped id derived from the trial's call (deterministic — replays stay byte-stable). */
export function evalReceiptId(caseId: string, tool: string, args: Record<string, unknown>, seq: number): string {
  const h = createHash('sha1').update(`${caseId}|${tool}|${argText(args)}|${seq}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The envelope a captured MUTATING call returns: ok + a receipt id, shaped
 * like the platform's own success envelope so a live model reads it as done.
 */
export function capturedEnvelope(caseId: string, tool: string, args: Record<string, unknown>, seq: number): string {
  return JSON.stringify({ ok: true, tool, receiptId: evalReceiptId(caseId, tool, args, seq), message: `${tool} executed.` });
}

/**
 * The answer for a read with no fixture. Not an error and not "empty": the
 * first live run (2026-10-08) showed a model reading thirteen "No matching
 * records" answers as a platform outage and escalating it — the snapshot
 * simply does not hold that read, and the answer says so plainly.
 */
export const NOT_IN_SNAPSHOT = 'No data — this read is outside the frozen snapshot this turn runs on; rely on the request and the other reads.';
export function neutralReadOutput(tool: string): string {
  if (WEB_TOOL_RE.test(tool)) return 'No results.';
  return JSON.stringify({ ok: true, results: [], note: NOT_IN_SNAPSHOT });
}

/**
 * Answer one tool call against the fixtures. Fixtures win for every tool (a
 * case may freeze a mutating tool's real envelope too); otherwise a mutating
 * tool is captured, a read gets the neutral answer.
 */
export function answerToolCall(opts: {
  caseId: string;
  fixtures: ToolFixture[];
  tool: string;
  args: Record<string, unknown>;
  seq: number;
  isMutating: (tool: string) => boolean;
}): { output: string; mutating: boolean; source: CapturedCall['source'] } {
  const mutating = opts.isMutating(opts.tool);
  const fx = findFixture(opts.fixtures, opts.tool, opts.args);
  if (fx) return { output: renderFixtureOutput(fx.output), mutating, source: 'fixture' };
  if (mutating) return { output: capturedEnvelope(opts.caseId, opts.tool, opts.args, opts.seq), mutating, source: 'captured' };
  return { output: neutralReadOutput(opts.tool), mutating, source: 'default' };
}
