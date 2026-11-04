/**
 * Deterministic context edits — build 2026-10-08 C (context.md Option A items
 * 4–5, Option B tier 1). Pure leaf: no I/O, no imports beyond types.
 *
 * 1. TOOL-RESULT CLEARING. The field converged on tiers (Anthropic
 *    `clear_tool_uses`, Manus "restorable compression", JetBrains "The
 *    Complexity Trap"): first clear old tool RESULTS to a restorable stub,
 *    summarise only when clearing cannot free enough. A cleared result keeps
 *    its `tool_call_id` (pairing intact), names the call and keeps a short head
 *    of the original — the LLM summariser this replaces only ever saw the
 *    first 400 chars of each tool result (compaction.ts `brief`), so a 400-char
 *    head loses nothing the summary could have carried, and every user /
 *    assistant / system message stays verbatim. Used by the chat fast path
 *    (act) and by tier 1 (context-gauge.ts — ACTS on top-level runs since
 *    build 2026-10-11 T1, records a shadow on its control arm).
 *
 * 2. MALFORMED TOOL-CALL HISTORY REPAIR. Run 99b4f357 (2026-10-07): a
 *    `computer_task` call whose `function.arguments` was not valid JSON stayed
 *    in history; the gateway answered every later request with HTTP 400
 *    "Invalid tool call in messages: tool_calls[].function.arguments for
 *    function 'computer_task' must be a JSON object string (or an object), got
 *    invalid J…". Backoff (same payload) and a `mode:'full'` compaction (424
 *    messages cut, 40 offload items) could not fix it — the bad call sat in
 *    the verbatim recent window — and the run failed after 204 steps. The
 *    right edit is deterministic: re-serialise each unparseable `arguments`
 *    as a valid JSON object that says what happened. The call was never
 *    executed (agent.ts rejects malformed arguments before dispatch), so the
 *    stub changes no fact the model relied on.
 */

export interface ContextMessage {
  role: string;
  content?: any;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: unknown; type?: string; function?: { name?: string; arguments?: unknown }; [k: string]: unknown } | null | undefined>;
  [k: string]: any;
}

/** Every cleared stub starts with this — a stub is never cleared twice. */
export const CLEARED_RESULT_PREFIX = '[cleared to save context';

/**
 * Tool results that are never cleared: the run's plan, the verify verdict, the
 * supervisor's own state and worker digests (sub-agent reports are already
 * 1–2k-token digests of work that cannot be cheaply re-run). Steers, the task,
 * harness notices and recaps are user / system messages — never candidates.
 */
export const CLEAR_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'update_plan',
  'verify',
  'get_supervisor_state',
  'delegate',
  'delegate_parallel',
  'ask_user',
  'wait_for_chat',
]);

export interface ToolCallInfo { name: string; args: string }

/** tool_call_id → { name, raw arguments } across the assistant turns. Pure. */
export function toolCallsById(messages: ReadonlyArray<ContextMessage>): Map<string, ToolCallInfo> {
  const out = new Map<string, ToolCallInfo>();
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const t of m.tool_calls) {
      if (typeof t?.id !== 'string') continue;
      const a = t.function?.arguments;
      out.set(t.id, { name: String(t.function?.name ?? 'tool'), args: typeof a === 'string' ? a : a == null ? '' : JSON.stringify(a) });
    }
  }
  return out;
}

/** True when a tool message's content is already a clearing stub. */
export function isClearedResult(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(CLEARED_RESULT_PREFIX);
}

/** One-line, bounded rendering of a call's arguments for the stub. Pure. */
export function argsBrief(raw: string, max = 120): string {
  const flat = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * The restorable stub. `headChars` 0 ⇒ the tier-1 shape (no excerpt).
 * Says how to restore the result (re-run the call) — never search_memory:
 * nothing about a cleared result is stored anywhere but agent_events.
 */
export function clearedResultStub(o: { tool: string; args: string; originalChars: number; head?: string }): string {
  const call = `${o.tool}(${argsBrief(o.args)})`;
  const head = o.head ?? '';
  const kept = head ? ` — the first ${head.length} are kept below` : '';
  return `${CLEARED_RESULT_PREFIX}: ${call} returned ${o.originalChars.toLocaleString('en-US')} chars${kept}. Re-run the call if you need the full result.]${head ? `\n${head}…` : ''}`;
}

export interface ClearableResult {
  /** index in the transcript */
  index: number;
  toolCallId: string;
  tool: string;
  args: string;
  chars: number;
}

/**
 * Index of the first message of the K-th most recent assistant tool round —
 * everything at or after it is "recent" and never cleared. Returns 0 (nothing
 * is old enough) when the run has made fewer than K tool rounds.
 */
export function recentRoundsStart(messages: ReadonlyArray<ContextMessage>, keepRecentRounds: number): number {
  if (keepRecentRounds <= 0) return messages.length;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      seen += 1;
      if (seen === keepRecentRounds) return i;
    }
  }
  return 0;
}

/**
 * Tool results old enough and large enough to clear, OLDEST first. Never the
 * system prompt, never a result inside the last `keepRecentRounds` tool
 * rounds, never an exempt tool, never an already-cleared stub, never array
 * (vision) content. Pure.
 */
export function clearableToolResults(
  messages: ReadonlyArray<ContextMessage>,
  opts: { keepRecentRounds: number; minResultChars: number; exemptTools?: ReadonlySet<string>; skipIds?: ReadonlySet<string> },
): ClearableResult[] {
  const exempt = opts.exemptTools ?? CLEAR_EXEMPT_TOOLS;
  const end = recentRoundsStart(messages, opts.keepRecentRounds);
  if (end <= 1) return [];
  const calls = toolCallsById(messages);
  const out: ClearableResult[] = [];
  for (let i = 1; i < end; i++) {
    const m = messages[i];
    if (m?.role !== 'tool' || typeof m.content !== 'string') continue;
    const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
    if (!id || opts.skipIds?.has(id)) continue;
    if (m.content.length < opts.minResultChars || isClearedResult(m.content)) continue;
    const call = calls.get(id);
    const tool = call?.name ?? 'tool';
    if (exempt.has(tool)) continue;
    out.push({ index: i, toolCallId: id, tool, args: call?.args ?? '', chars: m.content.length });
  }
  return out;
}

export interface ClearOutcome {
  messages: ContextMessage[];
  cleared: number;
  freedChars: number;
  beforeChars: number;
  afterChars: number;
  /** transcript index of the first cleared result (the cache edit point) */
  firstClearedIndex: number;
  /** cleared result count per tool name */
  tools: Record<string, number>;
}

/**
 * Clear old tool results, OLDEST first, until the transcript is at or under
 * `targetChars` (batched: one edit, as Anthropic's `clear_at_least` does —
 * every edit invalidates the provider cache after the edit point). Returns
 * null when nothing is clearable. Never removes a message, never changes a
 * role or a tool_call_id. `beforeChars` is the caller's own measure of the
 * transcript (compaction.ts messagesChars); the delta is exact because only
 * string tool contents change.
 */
export function clearOldToolResults(
  messages: ReadonlyArray<ContextMessage>,
  opts: { beforeChars: number; targetChars: number; keepRecentRounds: number; minResultChars: number; headChars: number; exemptTools?: ReadonlySet<string> },
): ClearOutcome | null {
  const candidates = clearableToolResults(messages, opts);
  if (!candidates.length) return null;
  const out = messages.slice();
  let after = opts.beforeChars;
  let freed = 0;
  let cleared = 0;
  let first = -1;
  const tools: Record<string, number> = {};
  for (const c of candidates) {
    if (after <= opts.targetChars) break;
    const original = String(out[c.index].content);
    const head = opts.headChars > 0 ? original.slice(0, opts.headChars) : '';
    const stub = clearedResultStub({ tool: c.tool, args: c.args, originalChars: original.length, head });
    const delta = original.length - stub.length;
    if (delta <= 0) continue; // a stub that is not smaller is never written
    out[c.index] = { ...out[c.index], content: stub };
    after -= delta;
    freed += delta;
    cleared += 1;
    if (first === -1) first = c.index;
    tools[c.tool] = (tools[c.tool] ?? 0) + 1;
  }
  if (!cleared) return null;
  return { messages: out, cleared, freedChars: freed, beforeChars: opts.beforeChars, afterChars: after, firstClearedIndex: first, tools };
}

/** One tool result chosen for clearing (a ClearableResult the caller decided to clear). */
export type ClearPick = Pick<ClearableResult, 'index' | 'toolCallId' | 'tool' | 'args'>;

/** The stub a result becomes (head kept when `headChars` > 0). Pure. */
export function stubForResult(original: string, tool: string, args: string, headChars: number): string {
  const head = headChars > 0 ? original.slice(0, headChars) : '';
  return clearedResultStub({ tool, args, originalChars: original.length, head });
}

/**
 * Apply ONE batched clear (build 2026-10-11 T1 — the tier-1 ACT path): every
 * picked tool result becomes its restorable stub. Returns the edited
 * transcript (a new array — message objects are replaced, never mutated) and
 * the ORIGINAL bodies, which the caller keeps for the evidence guard's
 * resume haystack (run-executor `guardPriorToolTexts`). A pick that is not a
 * string tool result, already a stub, or whose stub would not be smaller is
 * skipped. Never removes a message, never touches a role or a tool_call_id.
 * Pure.
 */
export function applyToolResultClears(
  messages: ReadonlyArray<ContextMessage>,
  picks: ReadonlyArray<ClearPick>,
  headChars: number,
): { messages: ContextMessage[]; originals: string[]; clearedIds: string[]; cleared: number; freedChars: number; firstClearedIndex: number; tools: Record<string, number> } {
  const out = messages.slice();
  const originals: string[] = [];
  const clearedIds: string[] = [];
  const tools: Record<string, number> = {};
  let freed = 0;
  let first = -1;
  for (const p of picks) {
    const m = out[p.index];
    if (m?.role !== 'tool' || typeof m.content !== 'string' || m.tool_call_id !== p.toolCallId || isClearedResult(m.content)) continue;
    const stub = stubForResult(m.content, p.tool, p.args, headChars);
    if (stub.length >= m.content.length) continue;
    originals.push(m.content);
    clearedIds.push(p.toolCallId);
    freed += m.content.length - stub.length;
    out[p.index] = { ...m, content: stub };
    if (first === -1 || p.index < first) first = p.index;
    tools[p.tool] = (tools[p.tool] ?? 0) + 1;
  }
  return { messages: out, originals, clearedIds, cleared: originals.length, freedChars: freed, firstClearedIndex: first, tools };
}

/**
 * Rough char weight of a message (content text + tool_calls JSON + reasoning)
 * — the tier-1 SHADOW's token estimate (chars / 4) for "tokens after the edit
 * point". An estimate only; the act paths use compaction.ts messagesChars.
 */
export function roughMessageChars(m: ContextMessage | null | undefined): number {
  if (!m) return 0;
  let n = 0;
  const c = m.content;
  if (typeof c === 'string') n += c.length;
  else if (Array.isArray(c)) for (const p of c) n += p?.type === 'text' ? String(p.text ?? '').length : 1_500;
  else if (c) n += JSON.stringify(c).length;
  if (typeof m.reasoning_content === 'string') n += m.reasoning_content.length;
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

// ── Malformed tool-call history (run 99b4f357) ──────────────────────────────

/**
 * A provider body that names a malformed tool-call ARGUMENTS payload in the
 * request history. Deliberately narrow; a false match is harmless anyway —
 * the repair only acts when history really holds unparseable arguments, and
 * otherwise the turn falls through to the lanes it took before.
 */
export const MALFORMED_TOOL_HISTORY_RE = /invalid tool[ _]?calls? in (?:the )?messages|tool_calls?(?:\[\d*\])?\.function\.arguments[^\n]{0,160}?(?:json|object)|function\.arguments[^\n]{0,80}?(?:invalid|malformed|not valid|must be)|(?:invalid|malformed|unparseable|unparsable)[^\n]{0,40}?(?:tool|function)[ _]?call[^\n]{0,40}?arguments|arguments[^\n]{0,60}?(?:is|are) not (?:a )?valid json|(?:failed|unable|could not) to (?:parse|decode)[^\n]{0,60}?(?:tool|function)[^\n]{0,30}?arguments/i;

/** Kill switch: HISTORY_REPAIR_DISABLED=1 ⇒ the turn takes the transient / size lanes as before. */
export function historyRepairDisabled(): boolean {
  const v = String(process.env.HISTORY_REPAIR_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Repairs per run (each one is a single deterministic pass; a model that keeps emitting broken JSON is not looped on). */
export const MAX_HISTORY_REPAIRS_PER_RUN = 3;

/** The statuses a malformed-history rejection arrives with. */
export const MALFORMED_TOOL_HISTORY_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/** Pure: does this failed turn name malformed tool-call arguments in history? */
export function classifyMalformedToolHistory(turn: { errorStatus?: number; providerError?: string; errorMessage?: string }): { status: number; detail: string } | null {
  const status = turn.errorStatus;
  if (typeof status !== 'number' || !MALFORMED_TOOL_HISTORY_STATUSES.has(status)) return null;
  const text = String(turn.providerError || turn.errorMessage || '').replace(/\s+/g, ' ').trim();
  if (!MALFORMED_TOOL_HISTORY_RE.test(text)) return null;
  return { status, detail: text.length > 300 ? `${text.slice(0, 300)}…` : text };
}

/** True when `raw` is what an OpenAI-compatible server accepts as arguments: a JSON OBJECT string (or an object). */
export function isValidToolArguments(raw: unknown): boolean {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return true;
  if (typeof raw !== 'string') return false;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** The valid-JSON replacement for an unparseable arguments payload. Pure. */
export function repairedToolArguments(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  if (!s.trim()) return '{}';
  return JSON.stringify({
    _harness_note: 'these arguments were malformed JSON — the call was rejected and never executed',
    raw_head: s.slice(0, 300),
  });
}

/**
 * Re-serialise every assistant tool_call whose `function.arguments` is not a
 * JSON object. Returns null when nothing needed repair (the caller then
 * leaves the turn to its old lanes). Ids, names, roles and order untouched.
 */
export function repairMalformedToolCallArguments(messages: ReadonlyArray<ContextMessage>): { messages: ContextMessage[]; repaired: number; tools: string[] } | null {
  let repaired = 0;
  const tools: string[] = [];
  const out = messages.map((m) => {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) return m;
    let changed = false;
    const calls = m.tool_calls.map((tc) => {
      if (!tc || !tc.function || isValidToolArguments(tc.function.arguments)) return tc;
      changed = true;
      repaired += 1;
      tools.push(String(tc.function.name ?? 'tool'));
      return { ...tc, function: { ...tc.function, arguments: repairedToolArguments(tc.function.arguments) } };
    });
    return changed ? { ...m, tool_calls: calls } : m;
  });
  return repaired ? { messages: out, repaired, tools } : null;
}
