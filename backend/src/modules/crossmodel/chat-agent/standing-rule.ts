/**
 * UNSAVED STANDING CHAT RULE (ticket ccd634fb — nightly query suite 2026-10-06,
 * case 03-platform-chat-instructions).
 *
 * "for the rest of this chat, always answer in exactly one sentence" → the lead
 * answered "Noted — every answer from here on will be exactly one sentence." with
 * NO tool call (glm-5.3, 0 steps): set_chat_instructions was in its tool list and
 * the playbook names it, but the rule was never saved. It holds only while the
 * user's message sits inside the history window — a long chat trims it (the
 * thread-state summary keeps facts, not formatting rules) and every later turn
 * silently drops the rule the answer promised to keep.
 *
 * The chat lane now re-runs such a turn ONCE with a harness note (the same
 * bounded pattern as the unbacked-claim retry): a HUMAN turn on a signed-in,
 * non-supervisor chat whose message carries a standing-rule cue for this chat,
 * where the run made no set_chat_instructions / remember_fact call and fired no
 * replay-unsafe (mutating) tool — so a replay cannot double any side effect. The
 * model keeps its judgment: the note says to answer normally when the message is
 * not a standing rule, and a durable preference for ALL chats goes to
 * remember_fact instead.
 *
 * Pure leaf (no imports). Kill switch CHAT_RULE_UNSAVED_RETRY_DISABLED=1.
 */

export function standingRuleRetryDisabled(): boolean {
  return process.env.CHAT_RULE_UNSAVED_RETRY_DISABLED === '1';
}

/** A message longer than this is a task, not a standing rule (a story that says "from now on" is not one). */
export const STANDING_RULE_MAX_CHARS = 400;

/** A scope that on its own says "this outlives this answer": for the rest of this chat, from now on, … */
const STRONG_SCOPE_RE = /\bfor the (?:rest|remainder) of (?:the|this|our) (?:chat|conversation|thread|session)\b|\bthroughout (?:this|our) (?:chat|conversation|thread)\b|\bfrom (?:now|here) on(?: out)?\b|\bgoing forward\b|\buntil I say otherwise\b/i;

/** "in this chat, always …" — the chat scope counts only when a directive OPENS the clause after it. */
const WEAK_SCOPE_RE = /\b(?:in|for) (?:this|our) (?:chat|conversation|thread)\b[,:]?\s*(?:please\s+)?(?:always|never|only|answer|reply|respond|use|keep|stop|avoid|don'?t|do not|write|speak|talk|be|call me|no)\b/i;

/** A directive to Digby about HOW to answer (not a fact about the user). */
const DIRECTIVE_RE = /\b(?:always|never|only|answer|answers|reply|replies|respond|responses|write|speak|talk|use|keep|stop|avoid|don'?t|do not|format|call me|be (?:more|less|brief|concise|formal|casual)|no (?:emojis?|bullet|markdown|jargon))\b/i;

/** "from now on I'm vegetarian" / "going forward my address is …" — a fact about the user (remember_fact territory). */
const USER_FACT_AFTER_SCOPE_RE = /\b(?:from (?:now|here) on|going forward)[,:]?\s+(?:I(?:'m| am| will|'ll| have|'ve)|my|we(?:'re| are)?)\b/i;

/**
 * The cue phrase when `message` reads as a standing rule for this chat, else null. Pure.
 * A short message with a strong scope ("for the rest of this chat", "from now on") plus a directive
 * word anywhere, or "in this chat," opened by a directive; never a first-person fact right after
 * "from now on" ("from now on I'm vegetarian" is remember_fact territory).
 */
export function standingChatRuleCue(message: string | null | undefined): string | null {
  const m = String(message ?? '').trim();
  if (!m || m.length > STANDING_RULE_MAX_CHARS) return null;
  const weak = WEAK_SCOPE_RE.exec(m);
  if (weak) return weak[0];
  const strong = STRONG_SCOPE_RE.exec(m);
  if (!strong || !DIRECTIVE_RE.test(m)) return null;
  if (USER_FACT_AFTER_SCOPE_RE.test(m) && !/\byou\b/i.test(m)) return null;
  return strong[0];
}

/** Tools whose call means the rule was saved somewhere (this chat's instructions, or the user's memory). */
export const RULE_SAVING_TOOLS: ReadonlySet<string> = new Set(['set_chat_instructions', 'remember_fact', 'set_preferences', 'update_project']);

/**
 * The cue when this finished turn left a standing rule UNSAVED, else null. Pure.
 * `unsafeTool` = the run's first replay-unsafe (mutating) tool, from the caller
 * (tool-call-leak.ts firedReplayUnsafeTool) — any side effect stands the retry down.
 */
export function unsavedStandingRule(input: {
  message: string | null | undefined;
  finalText: string | null | undefined;
  parts: Array<{ type?: string; name?: string }> | null | undefined;
  unsafeTool: string | null;
}): string | null {
  if (!String(input.finalText ?? '').trim()) return null;
  if (input.unsafeTool) return null;
  if ((input.parts ?? []).some((p) => p?.type === 'tool_call' && !!p.name && RULE_SAVING_TOOLS.has(p.name))) return null;
  return standingChatRuleCue(input.message);
}

/** The harness note the re-run carries (rides the final user turn). */
export function standingRuleNotice(cue: string): string {
  return `[HARNESS CHECK — STANDING RULE NOT SAVED: the user's message sets a rule for this chat ("${cue.slice(0, 60)}…"), `
    + 'but your answer only acknowledged it — nothing saved it, so it is lost once this chat outgrows its history window. '
    + 'If it is a rule for THIS chat, call set_chat_instructions now (call get_chat_instructions first and EXTEND any existing text — the call replaces it), '
    + 'then answer the message in one short line that confirms it is saved, following the rule. '
    + 'If it is a lasting preference for ALL their chats, use remember_fact instead. '
    + 'If the message is not a standing rule at all, just answer it normally.]';
}
