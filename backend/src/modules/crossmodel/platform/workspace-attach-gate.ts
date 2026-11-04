/**
 * WORKSPACE ATTACH GATE (2026-10-20, real-user audit). A send into a CODE-CAPABLE chat (every chat is auto-filed into a
 * capable user-space project) with no workspace state yet used to attach one — converting the chat into a coding
 * session for good — whenever the keyword list in auto-router.ts CODE_INTENT matched. That list carries bare words
 * ("fix", "bug", "implement", "branch", "merge", "commit", "exception"…), so the model bench's "fix the grammar: their
 * going to there house later" (test account) ran the coding harness, which answered from an empty scaffold workspace
 * and posted a session status card under the reply; "how do i fix a leaky faucet" or "merge two PDFs" take the same
 * path. Worse, every webhook frame carries "delete the branch" in its rules text, so a plain chat receiving a webhook
 * was converted on its first fire.
 *
 * The keyword hit is now a TRIGGER and the verdict is:
 *   - webhook origin  → never attach (a machine wake never converts a chat; the frame text is not the sender's words);
 *   - agent origin    → the keyword decides (no ask — machine text is never asked as a human turn);
 *   - a STRONG label  → attach (a file name, a repo path, a PR — "update README.md with the install steps" is a repo ask
 *                       a job-type classifier would call writing);
 *   - uploads / a message past the turn plan's window → the keyword decides (the ask could not see the same state);
 *   - else the task_kind decision (platform/task-kind.ts) over the SAME state the turn plan asks (turnPlanSessionFacts:
 *     prior user turns, prior lane, turn index; segment 'user') — the later turn-plan ask is then a memo hit with the
 *     same kind. A CONFIDENT (p ≥ 0.8), calibrated non-code verdict keeps the turn a chat; a code verdict, a
 *     low-confidence answer, an unanswered / off / uncalibrated ask keep the keyword behaviour.
 * The gate can only REMOVE an attach: a missed attach costs a chat answer the user can redo with the Code chip; a
 * wrong attach is permanent.
 *
 * Mode — the consumer's OWN flag, like the kind-aware pick's modelPickKind (task_kind's gate mode is act-capped: a pure
 * evidence key): `workspaceAttachGate` on ['instance','turn-plan']/'config' (turn-plan.ts workspaceAttachGateMode;
 * writer scripts/framework-audit/set-workspace-attach-gate.js). off = the keyword alone attaches (no ask); shadow (the
 * default) = the verdict is recorded and the keyword still attaches — the ask runs in the BACKGROUND, never before the
 * send's first byte; act = the verdict applies (the ask is awaited, bounded by ATTACH_GATE_TIMEOUT_MS + slack).
 * Kill switch WORKSPACE_ATTACH_KIND_GATE_DISABLED=1 ⇒ off. One loop_metrics `workspace_attach_gate` row per gated send
 * (`wouldAttach` = the verdict, `attach` = what happened). Both send seams use it (crossmodel.controller.ts streamQuery,
 * platform.service.ts send).
 */

import { routeMessageHeuristic, detectCodeIntent } from './auto-router';
import type { TaskKind, TaskKindResult } from './task-kind';

export const WORKSPACE_ATTACH_GATE_METRIC = 'workspace_attach_gate';
/** A non-code verdict blocks the attach only at or above this averaged probability. */
export const ATTACH_GATE_NON_CODE_MIN_P = 0.8;
/** The ask's own bound (Jev p50 ≈ 0.2 s); act also races the whole call against this + ATTACH_GATE_SLACK_MS. */
export const ATTACH_GATE_TIMEOUT_MS = 1500;
export const ATTACH_GATE_SLACK_MS = 500;
/** The only label a verdict may veto — a bare word; every other CODE_INTENT label names repo evidence. */
export const WEAK_CODE_LABEL = 'code intent';
/** The turn plan's message window (turn-plan.ts TURN_PLAN_MESSAGE_CHARS — the ask sees no more than this). */
const STATE_MESSAGE_CHARS = 2000;

export function workspaceAttachKindGateDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const s = String(env.WORKSPACE_ATTACH_KIND_GATE_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

export type AttachGateMode = 'off' | 'shadow' | 'act';
export type AttachOrigin = 'user' | 'agent' | 'webhook';

export type AttachReason =
  | 'no_code_intent'   // the keyword list did not fire — nothing to attach
  | 'gate_disabled'    // mode off (store or kill switch): the keyword hit attaches, nothing asked
  | 'webhook_origin'   // a webhook fire never converts a chat
  | 'agent_origin'     // an agent send: the keyword decides, nothing asked
  | 'strong_label'     // a file / repo path / PR named — attach, nothing asked
  | 'has_uploads'      // the ask could not see the same state — the keyword decides
  | 'long_message'     // past the turn plan's window — the keyword decides
  | 'shadow_pending'   // shadow: the ask runs in the background, the keyword decides now
  | 'kind_unavailable' // no usable answer (error, timeout, off, uncalibrated) — the keyword hit attaches
  | 'kind_code'        // the decision called it code — attach
  | 'kind_unsure'      // a non-code lean below ATTACH_GATE_NON_CODE_MIN_P — the keyword hit attaches
  | 'kind_not_code';   // a confident non-code verdict — the turn stays a chat

export interface AttachDecision {
  /** What the seam does. In shadow always the keyword behaviour; in act the verdict. */
  attach: boolean;
  /** The verdict (null while a shadow ask is still pending — its row carries it). */
  wouldAttach: boolean | null;
  mode: AttachGateMode;
  reason: AttachReason;
  /** The keyword list's label (auto-router CODE_INTENT), null when it did not fire. */
  label: string | null;
  kind: TaskKind | null;
  p: number | null;
}

const decisionOf = (attach: boolean, reason: AttachReason, label: string | null, kind: TaskKind | null = null, p: number | null = null, mode: AttachGateMode = 'act'): AttachDecision =>
  ({ attach, wouldAttach: attach, mode, reason, label, kind, p });

/** The verdict from the keyword label and the task_kind result (pure). `disabled` = mode off. */
export function attachDecision(label: string | null, res: TaskKindResult | null, disabled = false): AttachDecision {
  if (!label) return decisionOf(false, 'no_code_intent', null);
  if (disabled) return decisionOf(true, 'gate_disabled', label, null, null, 'off');
  const cls = res?.cls ?? null;
  const decision = res?.decision ?? null;
  if (!cls || !decision || decision.mode === 'off' || decision.calibrated === false) {
    return decisionOf(true, 'kind_unavailable', label, cls?.top ?? null, cls ? cls.p : null);
  }
  if (cls.top === 'code') return decisionOf(true, 'kind_code', label, 'code', cls.p);
  if (cls.p >= ATTACH_GATE_NON_CODE_MIN_P) return decisionOf(false, 'kind_not_code', label, cls.top, cls.p);
  return decisionOf(true, 'kind_unsure', label, cls.top, cls.p);
}

/** The verdict that needs NO ask, or null when the decision must judge (pure). */
export function preAskVerdict(label: string, opts: { origin?: AttachOrigin; hasUploads?: boolean; messageChars: number }): AttachDecision | null {
  if (opts.origin === 'webhook') return decisionOf(false, 'webhook_origin', label);
  if (opts.origin === 'agent') return decisionOf(true, 'agent_origin', label);
  if (label !== WEAK_CODE_LABEL) return decisionOf(true, 'strong_label', label);
  if (opts.hasUploads) return decisionOf(true, 'has_uploads', label);
  if (opts.messageChars > STATE_MESSAGE_CHARS) return decisionOf(true, 'long_message', label);
  return null;
}

type SessionFacts = { priorUserTurns: string[]; priorLane: string | null; turnIndex: number };

export interface AttachGateDeps {
  /** The gate's mode (default: turn-plan.ts workspaceAttachGateMode — the store row, absent ⇒ shadow). */
  mode?: () => Promise<AttachGateMode>;
  /** The chat's turn-plan session facts (default: lane-depth.ts turnPlanSessionFacts). */
  facts?: (chatId: string | null) => Promise<SessionFacts>;
  decideKind?: (state: Record<string, unknown>, opts: { timeoutMs: number; sessionId?: string; segment?: string }) => Promise<TaskKindResult>;
  record?: (row: { kind: string; sessionId?: string; value?: number; unit?: string; meta: Record<string, unknown> }) => void;
  env?: Record<string, string | undefined>;
}

function recordRow(deps: AttachGateDeps, chatId: string | null | undefined, ms: number, d: AttachDecision): void {
  try {
    const record = deps.record ?? ((row) => { void import('./loop-metrics.service').then((m) => m.recordLoopMetric(row)).catch(() => {}); });
    record({
      kind: WORKSPACE_ATTACH_GATE_METRIC, ...(chatId ? { sessionId: chatId } : {}), value: ms, unit: 'ms',
      meta: { mode: d.mode, attach: d.attach, wouldAttach: d.wouldAttach, reason: d.reason, label: d.label, kind: d.kind, p: d.p === null ? null : Number(d.p.toFixed(3)) },
    });
  } catch { /* telemetry never blocks a send */ }
}

/** The task_kind ask over the turn plan's state for this chat. Never throws (null = no answer). */
async function askKind(message: string, chatId: string | null, segment: string, deps: AttachGateDeps): Promise<TaskKindResult | null> {
  try {
    const { turnPlanState } = await import('./turn-plan');
    const facts = await (deps.facts ?? (async (id: string | null) => (await import('./lane-depth')).turnPlanSessionFacts(id)))(chatId);
    const decideKind = deps.decideKind ?? (await import('./task-kind')).decideTaskKind;
    const state = turnPlanState({
      message, priorUserTurns: facts.priorUserTurns, priorLane: (facts.priorLane ?? null) as Parameters<typeof turnPlanState>[0]['priorLane'],
      turnIndex: facts.turnIndex, images: 0, documents: 0,
    });
    return await decideKind(state, { timeoutMs: ATTACH_GATE_TIMEOUT_MS, ...(chatId ? { sessionId: chatId } : {}), segment });
  } catch {
    return null;
  }
}

const raceNull = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), ms); (t as { unref?: () => void }).unref?.(); })]);

/**
 * Should this send attach a workspace? Only called for a code-capable chat with no workspace state (the seams keep
 * their supervisor / kid / owner / escalation guards). Never throws: any failure answers the keyword behaviour.
 */
export async function shouldAttachWorkspace(
  message: string,
  opts: { chatId?: string | null; origin?: AttachOrigin; hasUploads?: boolean; segment?: string } = {},
  deps: AttachGateDeps = {},
): Promise<AttachDecision> {
  const text = String(message ?? '');
  // The same trigger the router evaluates (routeMessageHeuristic.needsWorkspace ⇔ a CODE_INTENT label).
  const label = routeMessageHeuristic({ content: text, hasWorkspace: true }).needsWorkspace
    ? (detectCodeIntent(text.replace(/\s+/g, ' ').trim()) ?? WEAK_CODE_LABEL)
    : null;
  if (!label) return attachDecision(null, null);
  const env = deps.env ?? process.env;
  if (workspaceAttachKindGateDisabled(env)) return attachDecision(label, null, true);
  let mode: AttachGateMode = 'shadow';
  try {
    mode = deps.mode ? await deps.mode() : await (await import('./turn-plan')).workspaceAttachGateMode(env);
  } catch { mode = 'shadow'; }
  if (mode === 'off') return attachDecision(label, null, true);
  const chatId = opts.chatId ?? null;
  const t0 = Date.now();
  const pre = preAskVerdict(label, { origin: opts.origin, hasUploads: opts.hasUploads, messageChars: text.length });
  if (pre) {
    const out = mode === 'act' ? pre : { ...pre, attach: true, mode: 'shadow' as const };
    recordRow(deps, chatId, Date.now() - t0, out);
    return out;
  }
  const segment = opts.segment ?? 'user';
  if (mode === 'shadow') {
    // Never before the send's first byte: the verdict is recorded when it lands; the keyword decides now.
    void askKind(text, chatId, segment, deps)
      .then((res) => recordRow(deps, chatId, Date.now() - t0, { ...attachDecision(label, res), attach: true, mode: 'shadow' }))
      .catch(() => {});
    return { attach: true, wouldAttach: null, mode: 'shadow', reason: 'shadow_pending', label, kind: null, p: null };
  }
  const res = await raceNull(askKind(text, chatId, segment, deps), ATTACH_GATE_TIMEOUT_MS + ATTACH_GATE_SLACK_MS);
  const out = attachDecision(label, res);
  recordRow(deps, chatId, Date.now() - t0, out);
  return out;
}
