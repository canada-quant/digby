/**
 * Tool-name disambiguation + schema scoping — the CAUSE-level fix for the
 * kimi-k3 wrong-tool emission class (owner 2026-09-22: "isn't there a better
 * way to fix this from happening at the cause").
 *
 * What prod showed (48 h, 14 kimi-k3 runs, 111 refused update_feedback calls):
 * the model's reasoning named run_command / list_schedules / update_plan and
 * the ONE function call that came out was `update_feedback({id:"noop"})` —
 * emitted alone in its turn, never seeded by a transcript read, first
 * appearing mid-run. The ids (`noop-plan-refresh`, `noop-not-applicable`) and
 * the preceding `update_plan` results give the mechanism away: a HOT coding
 * tool (`update_plan`, called every few steps) shares its `update_` prefix
 * with COLD admin tools (`update_feedback`, `update_supervisor_state`) and
 * the decoder lands on the sibling. glm-5.3 does not make this slip; a
 * ~120-tool / ~55k-token schema on a 200k-token fill makes kimi do it.
 *
 * Three controllable causes, each fixed at the cause site:
 *   1. NAME COLLISION — the two cold tools get model-facing names that share
 *      no prefix with any hot tool (`triage_ticket`, `save_supervisor_state`).
 *      Internal names never change: schemas are renamed at the moment they are
 *      offered, emitted names are mapped back the moment a turn returns, and
 *      the OLD names remain accepted aliases. Always on (RSW-1: the
 *      TOOL_NAME_DISAMBIGUATION kill switch was deleted 2026-11-02).
 *   2. SCHEMA SCOPE — triage tools are only meaningful in a run that works a
 *      feedback ticket, and supervisor-state tools only in a supervisor chat.
 *      A coding lane with no ticket in scope never sees them (an on-demand
 *      `load_tool_group({group:"triage"})` restores them, same pattern as the
 *      account group); supervisor-only tools leave every non-supervisor schema.
 *      `TRIAGE_TOOLS_ALWAYS_VISIBLE=1` / `SUPERVISOR_TOOLS_ALWAYS_VISIBLE=1`.
 *   3. ECHO — a turn that was ONLY a refused slip is removed from the replayed
 *      transcript (agent.ts), so the model is not shown its own slip to copy
 *      (prod: seq 839 → 841 immediate repeats). Always on (RSW-1: the
 *      SLIP_ECHO_PRUNE kill switch was deleted 2026-11-02).
 *   4. REFUSAL SHAPE (D5, 2026-09-27) — the supervisor-only executor refusal is
 *      failure-shaped and the agent loop perma-withholds the tool after two
 *      refusals (`SUPERVISOR_ONLY_PERMA_AFTER`); see the block above
 *      `supervisorOnlyRefusal`.
 *
 * Pure leaf: no imports, so the agent loop, platform-tools, doctrine builders
 * and jest scaffolds can all load it.
 */

/** internal name → model-facing name. Keys are the ONLY tools that get renamed. */
export const MODEL_FACING_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  update_feedback: 'triage_ticket',
  update_supervisor_state: 'save_supervisor_state',
});

const REVERSE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(MODEL_FACING_TOOL_NAMES).map(([k, v]) => [v, k])),
);

/** The name the MODEL sees for an internal tool name (identity when unmapped). */
export function modelToolName(internal: string): string {
  return MODEL_FACING_TOOL_NAMES[internal] ?? internal;
}

/** The INTERNAL name for a name the model emitted — accepts both the
 *  model-facing name and the legacy internal name (alias), always. */
export function internalToolName(emitted: string): string {
  return REVERSE[emitted] ?? emitted;
}

/** True when the model emitted a legacy alias (telemetry: measures how often
 *  the old name still surfaces). */
export function isLegacyAliasEmission(emitted: string): boolean {
  return emitted in MODEL_FACING_TOOL_NAMES;
}

const NAME_RE = new RegExp(`\\b(${Object.keys(MODEL_FACING_TOOL_NAMES).join('|')})\\b`, 'g');

/** Rewrite internal tool names inside HARNESS-AUTHORED text (doctrine, briefs,
 *  refusal envelopes, tool descriptions) to their model-facing names. Never
 *  apply this to tool RESULTS that may carry repository source text — a lane
 *  editing this very code must read the real identifiers. */
export function withModelToolNames(text: string): string {
  if (!text) return text;
  return text.replace(NAME_RE, (m) => MODEL_FACING_TOOL_NAMES[m] ?? m);
}

/** Shallow-copy tool schemas with model-facing function names + descriptions. */
export function applyModelToolNames<T extends { function: { name: string; description?: string } }>(schemas: T[]): T[] {
  return schemas.map((t) => {
    const name = t?.function?.name;
    const mapped = name ? MODEL_FACING_TOOL_NAMES[name] : undefined;
    const desc = t?.function?.description;
    const newDesc = desc ? withModelToolNames(desc) : desc;
    if (!mapped && newDesc === desc) return t;
    return { ...t, function: { ...t.function, ...(mapped ? { name: mapped } : {}), ...(newDesc !== desc ? { description: newDesc } : {}) } };
  });
}

/** Both spellings of every offered tool — for intent detection over reasoning
 *  text that may name either form. */
export function offeredNamesBothForms(offered: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of offered) { out.add(n); const m = MODEL_FACING_TOOL_NAMES[n]; if (m) out.add(m); }
  return out;
}

// ── Schema scope ─────────────────────────────────────────────────────────────

/** Feedback-queue triage tools: meaningful only when a run works a ticket. */
export const TRIAGE_TOOLS: ReadonlySet<string> = new Set(['list_feedback', 'update_feedback']);
export const TRIAGE_TOOL_GROUP = 'triage';

/** Tools whose executor refuses outside a supervisor chat — offering them
 *  elsewhere only gives the decoder a wrong target. */
export const SUPERVISOR_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'get_supervisor_state', 'update_supervisor_state', 'register_infra_blocker', 'clear_infra_blocker',
]);

export function isTriageTool(name: string): boolean { return TRIAGE_TOOLS.has(name); }
export function isSupervisorOnlyTool(name: string): boolean { return SUPERVISOR_ONLY_TOOLS.has(name); }

// ── Supervisor-only refusals (D5, 2026-09-27) ────────────────────────────────
// Prod (worker 28de72e5, "GLM-5.3 Deployment on Dual Sparks", project
// 0560b7b8): 90 update_supervisor_state calls, zero receipts. The executor's
// refusal was `{"error":"… only available on the Fleet Supervisor chat"}` — a
// shape NO failure marker matched (learnings-index.service.ts
// FAILURE_MARKERS), so it read as SUCCESS to the derail streak and RESET it on
// every call: the breaker never tripped, the tool never left the schema, and
// the lane burned a model round per call. A supervisor-only refusal is
// DETERMINISTIC for a lane whose PROFILE lacks supervisorTools — a chat's
// supervisor flags do not change mid-run, so the call can never succeed in
// this run and there is nothing a one-round withhold could let recover. Two
// fixes: (1) the refusal is the platform `ok:false` envelope (failure-shaped
// under the existing `^\{\s*"ok":\s*false` marker; the legacy `error` key is
// kept for readers of the old shape); (2) the agent loop perma-withholds the
// tool after SUPERVISOR_ONLY_PERMA_AFTER refusals (default 2 — one slip is
// containment, the second is a lock) instead of the generic 3+3 ladder. The
// perma is a SCOPE lock, not a derailment trip: it never feeds the run-end /
// derail-rescue gate (review fixer 2026-09-27). The ladder keys on the
// PROFILE, never on the executor's answer: a supervisor-profiled lane is
// never counted, so a transient state-row read failure cannot lock a real
// supervisor out of its own state tools (the executor answers such a failure
// with the DISTINCT `state_read_failed` envelope below, which the ladder does
// not match).

export const SUPERVISOR_ONLY_REFUSAL_REASON = 'supervisor_only';

/** The structured refusal a supervisor-only tool returns outside a
 *  supervisor chat. `ok` is the FIRST key on purpose — the failure marker is
 *  anchored on it. */
export function supervisorOnlyRefusal(modelFacingTool: string, message: string): string {
  return JSON.stringify({ ok: false, tool: modelFacingTool, reason: SUPERVISOR_ONLY_REFUSAL_REASON, error: message, message }, null, 1);
}

export const STATE_READ_FAILED_REASON = 'state_read_failed';

/** The envelope a supervisor-only tool returns when the chat's supervisor
 *  flags could NOT be read (DB error) — failure-shaped, but a DIFFERENT
 *  reason from `supervisor_only`, so a transient outage is never presented as
 *  "this is not a supervisor chat" and never counts toward the D5 perma. */
export function stateReadFailedRefusal(modelFacingTool: string): string {
  const message = `${modelFacingTool}: could not read this chat's supervisor flags (transient store error) — retry the call`;
  return JSON.stringify({ ok: false, tool: modelFacingTool, reason: STATE_READ_FAILED_REASON, transient: true, error: message, message }, null, 1);
}

const SUPERVISOR_ONLY_REFUSAL_RE = /^\{\s*"ok":\s*false,\s*"tool":\s*"[^"\n]{1,80}",\s*"reason":\s*"supervisor_only"/;

/** True when a tool result IS the supervisor-only refusal envelope
 *  (head-anchored — a result that merely quotes one never matches). */
export function isSupervisorOnlyRefusal(result: string): boolean {
  return SUPERVISOR_ONLY_REFUSAL_RE.test((result || '').slice(0, 400));
}

/** How many supervisor-only refusals of ONE tool perma-withhold it for the
 *  rest of the run (always ≥ 1). */
export function supervisorOnlyPermaAfter(): number {
  const n = Number(process.env.SUPERVISOR_ONLY_PERMA_AFTER);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

export function triageToolsAlwaysVisible(): boolean { return process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE === '1'; }
export function supervisorToolsAlwaysVisible(): boolean { return process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE === '1'; }

/** The ticket-dispatch brief headers (feedback/ticket-dispatch.service.ts) and
 *  the explicit names a prompt uses when it wants the queue worked. This is a
 *  SCHEMA PRELOAD heuristic (the on-demand group stays available regardless),
 *  never a gate on what the model may do. */
const TICKET_WORK_RE = /\[TICKET (?:BATCH )?DISPATCH|\blist_feedback\b|\bupdate_feedback\b|\btriage_ticket\b|\bfeedback tickets?\b/i;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
  return '';
}

/** Does this run's own prompt material ask for feedback-queue work? Scans the
 *  user message, the harness scheduler notice and the USER turns of history
 *  (a dispatched lane's later runs carry the brief in history). */
export function runMentionsTicketWork(input: {
  userMessage?: string;
  schedulerNotice?: string;
  history?: Array<{ role: string; content: unknown }>;
}): boolean {
  if (TICKET_WORK_RE.test(input.userMessage || '')) return true;
  if (TICKET_WORK_RE.test(input.schedulerNotice || '')) return true;
  for (const h of input.history ?? []) {
    if (h?.role !== 'user') continue;
    if (TICKET_WORK_RE.test(textOf(h.content))) return true;
  }
  return false;
}

/** Placeholder-shaped id values seen in prod slips (telemetry classifier only —
 *  the grounding check in tool-preflight decides refusals). */
export function looksLikePlaceholderId(v: unknown): boolean {
  const s = String(v ?? '').trim();
  if (!s) return true;
  return /^(noop|none|null|placeholder|skip|x|test|n\/?a|todo|tbd)(?:[-_].*)?$|^__.*__$|nonexistent|placeholder/i.test(s);
}
