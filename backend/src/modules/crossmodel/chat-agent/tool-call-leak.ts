/**
 * Plain-text tool-call leak detection for the CHAT-AGENT finalize seam
 * (owner report, chat 7dc031fb: "you're also broken trying to call list chats
 * as text output not actually tool calls").
 *
 * The coding loop (coding/agent.ts, `leakRetries`) already catches the
 * STRUCTURAL leak — kimi-k3/DeepSeek native special-token blocks — via
 * `looksLikeAttemptedToolCall` and retries in-loop with a corrective nudge.
 * But kimi-k3 in plain chats ALSO leaks the PROSE form: `list_chats({...})`
 * on its own line, or a fenced tool-call JSON, as the final answer text. That
 * shape carries no native tokens, so the in-loop structural detector never
 * fires and the "call" ships to the owner as the answer.
 *
 * This module is the chat-side detector. It triggers ONLY on tool-SHAPED
 * output naming a tool the chat orchestrator actually has (a line that IS a
 * call, or a tool-call JSON object) — never on prose that merely mentions a
 * tool name ("you can use list_chats to…"), mirroring the coding loop's
 * quote-safety rule (its comment: an honest answer that QUOTES tool markup is
 * not rejected). The retry mechanics live in chat-agent.service.ts.
 *
 * SECOND SHAPE (feedback ab9d96eb, same owner report): the 21:35Z answer that
 * triggered "calling list chats as text output" carried NO call syntax at all
 * — it ENDED with first-person narration ("*(Calling list_chats +
 * get_chat_messages on the TT-RD project session — I'll report…)*"), which
 * the call-shape detector provably misses (verified 2026-09-02 with tsx
 * against the production transcript). looksLikeToolCallNarration below covers
 * it — tail-focused, first-person phrasing-gated, known-tool-name-anchored —
 * and rides the same finalize-seam retry.
 *
 * LEAF module (same pattern as platform/platform-tool-names.ts):
 * chat-agent.service tests mock ../coding/agent wholesale, so this must NOT
 * import CHAT_ORCH_TOOLS from there — the roster is mirrored from the
 * dependency-free name modules instead. A name this mirror misses only means
 * no retry for that call (fail-safe); it can never cause a false trigger.
 */

import { looksLikeAttemptedToolCall } from '../sanitize-model-output';
import { PLATFORM_TOOL_NAMES, PLATFORM_MUTATING_TOOLS } from '../platform/platform-tool-names';
import { INTEGRATION_TOOL_NAMES } from '../coding/integration-tool-schema';

/** Coding-loop parity: matches MAX_LEAK_RETRIES in coding/agent.ts. */
export const MAX_CHAT_LEAK_RETRIES = 2;

/**
 * The coding loop's corrective nudge, verbatim (coding/agent.ts leak retry).
 * In the chat seam it rides runOrchestrator(harnessNotice) — appended to the
 * user turn, the same channel the machine-wake reject-back notice uses.
 */
export const CHAT_LEAK_NUDGE =
  '[HARNESS NOTICE — not typed by the user] Your previous message contained tool-call markup as PLAIN TEXT, so NO tool was executed and nothing changed. Re-issue it through the structured tool-calling API (do not describe the call in prose). If you are actually done, say so plainly with no tool markup.';

// Mirrors CHAT_ORCH_TOOLS in coding/agent.ts (base names + integration +
// platform tools) plus the L3 council extras wired in chat-agent.service.
// Kept as a mirror, not an import — see the leaf note above.
const CHAT_ORCH_BASE_TOOLS = [
  'search_engine', 'scrape_as_markdown', 'fetch_image', 'browser_task', 'computer_task', 'web_pipe', 'youtube_pipe',
  'search_memory', 'search_code_semantic', 'ask_user',
  'create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form',
  'generate_image',
];
// + the lead's call_in (roster 2026-10-06 D-2, chat-agent/call-in.ts) — a leaked call_in line ran nothing.
const COUNCIL_TOOLS = ['dispatch_colleagues', 'send_note', 'spawn_self', 'call_in'];
export const CHAT_LEAK_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...CHAT_ORCH_BASE_TOOLS, ...COUNCIL_TOOLS, ...INTEGRATION_TOOL_NAMES, ...PLATFORM_TOOL_NAMES]
    .map((n) => n.toLowerCase()),
);

// Document writes and connector WRITES — each a side effect a replay repeats
// AND a result that only acknowledges the write (shared by both sets below).
const DOCUMENT_WRITE_TOOLS = ['create_document', 'update_document', 'fill_pdf_form'] as const;
const CONNECTOR_WRITE_TOOLS = [
  // connector WRITES (Google 2026-09-23; #26 set 2026-09-24) — a replayed send/post fires twice.
  'gmail_send_email', 'gmail_create_draft', 'calendar_create_event', 'docs_create_document', 'docs_append_text', 'sheets_create_spreadsheet', 'sheets_write_values', 'sheets_append_rows', 'drive_upload_file', 'drive_create_folder', 'slides_create_presentation',
  'imessage_send', 'slack_post_message', 'asana_create_task', 'asana_update_task', 'x_post',
  // discord sends (2026-10-05) — same replay-twice class as the #26 connector writes.
  'discord_send_message', 'discord_send_dm',
] as const;

/**
 * Replay safety for the finalize-seam retry: unlike the coding loop's IN-LOOP
 * retry (same conversation, nothing re-executed), the chat seam re-runs the
 * WHOLE orchestration — any mutating side effect (a sent chat message, a
 * schedule write, a document write, a browser action, a dispatched council)
 * would fire twice. Read-only tool calls (searches, list_chats, gmail_search…)
 * replay harmlessly. All INTEGRATION_TOOL_NAMES are read-only by design.
 */
const REPLAY_UNSAFE_TOOLS = new Set<string>([
  ...PLATFORM_MUTATING_TOOLS,
  ...DOCUMENT_WRITE_TOOLS, 'browser_task', 'computer_task', 'dispatch_colleagues',
  // generate_image (2026-09-24): a paid provider call + a GeneratedFile row —
  // a whole-orchestration replay would draw (and bill) twice.
  'generate_image',
  ...CONNECTOR_WRITE_TOOLS,
]);

/**
 * Tools whose RESULT merely acknowledges a write (integration recheck
 * 2026-10-23): platform mutations, document + connector writes and
 * generate_image. Their envelope observes nothing about live state and often
 * echoes the model's own words back, so it is never a grounding READ (the
 * owner-turn live-state check, action-verifier productionStateGroundingTexts).
 * Deliberately NOT the replay-unsafe set: browser_task and computer_task act
 * but also OBSERVE the page / screen, and infra_action kind 'env_probe' is a
 * read-only host probe — all three ground a claim. dispatch_colleagues is a
 * council answer, not an ack, and keeps its grounding too.
 */
const WRITE_ACK_TOOLS = new Set<string>([
  ...PLATFORM_MUTATING_TOOLS,
  ...DOCUMENT_WRITE_TOOLS,
  'generate_image',
  ...CONNECTOR_WRITE_TOOLS,
]);

/** True when a call of `name` (with its `args`) only acknowledges a write — never a read of live state (see WRITE_ACK_TOOLS). */
export function isWriteAckToolName(name: string | null | undefined, args?: unknown): boolean {
  if (!name || !WRITE_ACK_TOOLS.has(name)) return false;
  if (name === 'infra_action' && args && typeof args === 'object' && (args as { kind?: unknown }).kind === 'env_probe') return false;
  return true;
}

/** First executed tool that makes a full re-run unsafe, or null when replay is safe.
 *  `opts.allow` (tt-rd audit 2026-09-27, owner-turn empty retry): names treated as
 *  replay-SAFE for this call only — today `update_supervisor_state`, whose merge is
 *  validated and replay-tolerant: directives/projects/notes upsert by id/name/
 *  replace, and (fixer 2026-09-27, finding upward-chatter-5) a dispatch with the
 *  same kind + id inside DISPATCH_DEDUPE_WINDOW_MS is skipped as 'already
 *  recorded' rather than appended twice; every other mutating tool stays unsafe. */
export function firedReplayUnsafeTool(
  parts: Array<{ type?: string; name?: string }> | undefined | null,
  opts: { allow?: ReadonlyArray<string> } = {},
): string | null {
  const allow = opts.allow?.length ? new Set(opts.allow) : null;
  for (const p of parts || []) {
    if (p?.type === 'tool_call' && p.name && REPLAY_UNSAFE_TOOLS.has(p.name) && !allow?.has(p.name)) return p.name;
  }
  return null;
}

// ── Detection ────────────────────────────────────────────────────────────────

// A line that IS a call and nothing else: `list_chats({"limit": 20})`,
// `functions.list_chats(limit=20);`, optionally wrapped in single backticks.
// The line-anchored shape + args gate keep prose safe: "Use list_chats() to
// see them." has a prose tail; "create_project (see the docs)" fails the
// args-shape gate below.
const CLOSED_CALL_LINE_RE = /^\s*`?(?:functions\.|tools\.|multi_tool_use\.)?([a-z][a-z0-9_]*)\s*\((.*)\)\s*;?`?\s*$/i;
// A line that OPENS a call whose args spill onto later lines: `list_chats({`.
const OPEN_CALL_LINE_RE = /^\s*`?(?:functions\.|tools\.|multi_tool_use\.)?([a-z][a-z0-9_]*)\s*\(\s*[{["']?\s*$/i;

/**
 * Argument shapes a real call carries: empty, a JSON object/array, a single
 * quoted string, a number, or kwargs (`limit=20` / `limit: 20`). Bracket/quote
 * shapes must CLOSE consistently so a prose line whose parenthetical happens
 * to end the line ("list_chats(\"main\") is the one you want (I checked)")
 * never passes — its captured args start with a quote but don't form one
 * quoted string.
 */
function argsLookLikeCall(args: string): boolean {
  const a = args.trim();
  if (a === '') return true;
  if (a.startsWith('{')) return a.endsWith('}');
  if (a.startsWith('[')) return a.endsWith(']');
  if (a.startsWith('"')) return /^"[^"]*"$/.test(a);
  if (a.startsWith("'")) return /^'[^']*'$/.test(a);
  if (/^\d/.test(a)) return /^\d[\d.,\s]*$/.test(a);
  return /^\w+\s*[=:]\s*\S/.test(a); // kwargs
}

// Fenced code blocks (terminated or trailing-open) — their content is checked
// as a tool-call JSON candidate and line-scanned for bare calls.
const FENCE_RE = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
// XML-ish tool-call wrappers some models emit as text: <tool_call>{...}</tool_call>.
const TOOLCALL_EL_RE = /<(tool_call|function_call|toolcall)\b[^>]*>([\s\S]*?)(?:<\/\s*\1\s*>|$)/gi;

/** The known tool named by a tool-call-shaped JSON object, else null. */
function jsonToolCallName(segment: string): string | null {
  const m = segment.match(/"(?:name|tool|tool_name|function)"\s*:\s*"([a-z][a-z0-9_]*)"/i);
  if (!m) return null;
  if (!/"(?:arguments|parameters|params|args|input)"\s*:/i.test(segment)) return null;
  return m[1].toLowerCase();
}

/** Any line in the block that is (or opens) a bare call to a KNOWN tool. */
function lineScanForCall(block: string): boolean {
  for (const line of block.split('\n')) {
    const closed = line.match(CLOSED_CALL_LINE_RE);
    if (closed && CHAT_LEAK_TOOL_NAMES.has(closed[1].toLowerCase()) && argsLookLikeCall(closed[2])) {
      return true;
    }
    const open = line.match(OPEN_CALL_LINE_RE);
    if (open && CHAT_LEAK_TOOL_NAMES.has(open[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * True when the text looks like a tool call EMITTED AS TEXT (so nothing ran):
 *  1. the coding loop's structural detector (native token block / invoke element);
 *  2. a line that is entirely `known_tool({...})` call syntax (or opens one);
 *  3. a tool-call JSON object naming a known tool — fenced, <tool_call>-wrapped,
 *     or a bare `{...}` paragraph.
 * Never fires on prose that merely mentions a tool name.
 */
export function looksLikeLeakedChatToolCall(text: string): boolean {
  if (!text || !text.trim()) return false;
  if (looksLikeAttemptedToolCall(text)) return true;

  // Lift fenced blocks + tool-call elements out as JSON-candidate segments;
  // the remainder is paragraph/line-scanned.
  const segments: string[] = [];
  let rest = text.replace(FENCE_RE, (_m, body) => {
    segments.push(String(body));
    return '\n';
  });
  rest = rest.replace(TOOLCALL_EL_RE, (_m, _tag, body) => {
    segments.push(String(body));
    return '\n';
  });

  for (const seg of segments) {
    const name = jsonToolCallName(seg);
    if (name && CHAT_LEAK_TOOL_NAMES.has(name)) return true;
    if (lineScanForCall(seg)) return true;
  }
  for (const para of rest.split(/\n[ \t]*\n/)) {
    if (para.trimStart().startsWith('{')) {
      const name = jsonToolCallName(para);
      if (name && CHAT_LEAK_TOOL_NAMES.has(name)) return true;
    }
  }
  return lineScanForCall(rest);
}

// ── Prose-narration shape (feedback ab9d96eb — see the module header) ───────

/** Only the answer's TAIL is scanned: the failure shape is "ended by promising
 *  calls it never made" — a mid-answer tool mention stays safe. */
const NARRATION_TAIL_WINDOW = 600;

/** Known-chat-tool alternation, built once: anchoring on a real tool name is
 *  what keeps "Calling all hands on deck" / "I'll use the data to answer" out. */
const NARRATION_TOOL_ALT = [...CHAT_LEAK_TOOL_NAMES]
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const NARRATION_PATTERNS: RegExp[] = [
  // "Calling list_chats + get_chat_messages on/for/to/now …" (the smoking gun,
  // incl. its "*(Calling …)*" markdown-italic wrap). BOUNDARY-GATED (review
  // B1): "Calling" must open a sentence/line/markdown-wrap/em-dash clause —
  // the stage-direction position. Without the gate, honest past-tense reports
  // false-positive: "I got them by calling search_engine on each ticker" /
  // "I found the session by calling list_chats on your account" (both verified
  // FP→fixed with tsx, 2026-09-02).
  new RegExp(`(?:^|[\\n\\r]|[.!?…]\\s+|[*_(\[]+\\s*|—\\s+)Calling\\s+(${NARRATION_TOOL_ALT})(?:\\s*[+,]\\s*(?:and\\s+)?[a-z][a-z0-9_]*)*\\s+(?:on|for|to|now|against)\\b`, 'i'),
  // "Let me / I'll / I will / I'm going to / I need to (now) call|invoke|use|run
  //  (the) send_chat_message tool/on/for/to …"
  new RegExp(`\\b(?:Let me|I'll|I will|I'm going to|I am going to|I need to)\\s+(?:now\\s+)?(?:call|invoke|use|run)\\s+(?:the\\s+)?(${NARRATION_TOOL_ALT})\\s+(?:tool|on|for|to|against)\\b`, 'i'),
  // "Now calling/invoking/running list_chats …"
  new RegExp(`\\b(?:Now|Next),?\\s+(?:calling|invoking|running)\\s+(${NARRATION_TOOL_ALT})\\b`, 'i'),
];

/**
 * True when the answer ENDS by narrating tool invocations as first-person
 * prose — the shape that ships a promise instead of results when the run made
 * no such calls. Tail-focused, first-person-phrased, and anchored on a KNOWN
 * chat tool name, so an honest answer that mentions tools ("you can use
 * list_chats to…", "I tried calling list_chats({…}) but it failed") or uses
 * the verbs loosely ("I'll use the data to…") never matches.
 */
export function looksLikeToolCallNarration(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  const tail = t.slice(-NARRATION_TAIL_WINDOW);
  return NARRATION_PATTERNS.some((re) => re.test(tail));
}
