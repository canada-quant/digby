/**
 * 2026-10-22 (owner's Fleet Supervisor chat, 21:13Z + 21:46Z) — the owner-turn LIVE-STATE READ check, its
 * harness line and the retry notice, as a pure leaf (no DB, no logger) so the history redactor
 * (guard-chrome-redact.ts) can strip the line without loading the chat-agent graph.
 *
 * The incident: on two OWNER turns the Fleet Supervisor answered "is X deployed / running on cluster Y" and
 * "was the memory issue fixed" with ZERO tool calls — from memory — and the answers were stale or wrong; the
 * owner had to push back twice. The supervisor doctrine already says a serving / deployed / running / banked
 * sentence cites a THIS-TURN read or says "not read this wake" (platform/core-doctrine.ts Evidence rules), and
 * the harness OBSERVES that on machine wakes (action-verifier.ts findUnreadProductionStateClaims, seam
 * machine_wake_production_state). Nothing checked OWNER turns.
 *
 * The decision (when to re-run, when the line applies) lives in chat-agent.service.ts and reuses the
 * machine-wake matcher and its grounding discipline (memory reads, the own state doc and a read of the
 * supervisor's own chat never ground a production sentence). This leaf owns only the words.
 * Kill switch SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED=1 (the retry, the line and the copy strips; the
 * model-history strip of a stored line is deliberately NOT behind it — after a rollback the stored lines must
 * still never reach the model as its own words).
 */
import { stripHarnessLine, hasHarnessLine, insertHarnessLine, endsInsideOpenFence, stripNoActionToolNote } from './no-action-note';
import { parseFollowUps, stripAnswerMarkup } from '../langgraph/pipeline-utils';

/** The one honest line a supervisor owner answer carries when it still states live status no read of the turn grounds. */
export const UNREAD_STATE_NOTE = 'Harness check: this answer states live status that was not read in this turn — treat it as unverified.';

export const OWNER_STATE_READ_RETRY_DISABLED_ENV = 'SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED';

export function ownerStateReadRetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OWNER_STATE_READ_RETRY_DISABLED_ENV] === '1';
}

/** The text with every STANDALONE copy of the line removed (quotations, code and blockquotes are the model's own words — kept). */
export function stripUnreadStateNote(text: string): string {
  return stripHarnessLine(text, UNREAD_STATE_NOTE);
}

/** True when the text carries the line as a standalone line (the harness's shape). */
export function hasUnreadStateNote(text: string): boolean {
  return hasHarnessLine(text, UNREAD_STATE_NOTE);
}

/**
 * Pure: the PROSE of an owner answer the live-state matcher judges (2026-10-22 review) — the harness's own lines
 * (this one and the FSN1021 no-action note) and the answer chrome ([FOLLOWUPS] chips, [CANVAS] blocks) removed.
 * A follow-up chip ("Is GLM-5.3 still serving on spark-2?", "What's running in production?") is an offer to the
 * owner, never a claim of state; the matcher's own owner-turn option (action-verifier.ts ownerTurnClaimUnits)
 * drops the questions, offers and restated asks left in the prose.
 */
export function unreadStateClaimProse(text: string): string {
  return stripAnswerMarkup(stripNoActionToolNote(stripUnreadStateNote(String(text ?? ''))));
}

/** Puts the line at the end of the prose: before a [FOLLOWUPS] block, else after the last paragraph; unchanged inside an open fence. */
export function insertUnreadStateNote(text: string): string {
  return insertHarnessLine(text, UNREAD_STATE_NOTE);
}

/**
 * Pure: the delivered text with the line inserted (a model copy is dropped first — only the harness writes
 * it), or null when it cannot be placed honestly: an empty text, a text ending inside an open code fence, or
 * a placement the finalize's own parsers would swallow into a follow-up chip (a tapped chip would send the
 * harness line back as the owner's words) — the no-action note's round-8 rule. The caller decides WHETHER
 * the line applies; this decides only where it goes.
 */
export function unreadStateNoteText(text: string): string | null {
  const t = stripUnreadStateNote(String(text ?? ''));
  if (!t.trim() || endsInsideOpenFence(t)) return null;
  const out = insertUnreadStateNote(t);
  if (out === t) return null;
  const parsed = parseFollowUps(out);
  if (!hasUnreadStateNote(stripAnswerMarkup(out)) || parsed.followUps.some((f) => f.includes(UNREAD_STATE_NOTE.slice(0, 40)))) return null;
  return out;
}

/**
 * Pure: the transcript parts carrying the noted text — the parts render OVER content, so the line must sit in
 * the same spot in both. When the LAST text part is the delivered answer (the agent loop pushes one text part
 * per model turn), only that part is replaced and every earlier part is kept; otherwise the text parts collapse
 * to one part holding the noted text (the no-action note's shape — content and parts can never disagree).
 */
export function withUnreadStateNoteParts<P extends { type?: string; text?: unknown }>(parts: readonly P[], delivered: string, noted: string): Array<P | { type: 'text'; text: string }> {
  let last = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]?.type === 'text' && typeof parts[i].text === 'string') { last = i; break; }
  }
  if (last >= 0 && String(parts[last].text).trim() === String(delivered ?? '').trim()) {
    return parts.map((p, i) => (i === last ? { ...p, text: noted } : p));
  }
  return [...parts.filter((p) => p?.type !== 'text'), { type: 'text' as const, text: noted }];
}

/** The reads that can ground a live-state sentence on a supervisor chat (it has no shell — box facts reach it only through these). */
export const LIVE_STATE_READ_TOOLS: readonly string[] = Object.freeze(['get_chat_status', 'get_chat_messages', 'get_run_receipts', 'get_fleet_telemetry']);

/**
 * The harness check appended to the ONE re-run: names the unread sentences (≤ 3, ≤ 160 chars each) and
 * gives the model the two honest exits — read the live state now and answer from the RESULTS, or keep the
 * answer and say in the same sentence that it was not read this turn ("not read this turn" is a phrase the
 * matcher's disclaimer rule recognises, so an honest answer is never judged again).
 */
export function unreadStateNotice(sentences: readonly string[]): string {
  const quoted = [...new Set(sentences.map((s) => String(s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))]
    .slice(0, 3)
    .map((s) => `"${s.replace(/"/g, "'").slice(0, 160)}"`)
    .join(', ');
  return `[HARNESS CHECK — LIVE STATE NOT READ: your previous answer states live status (${quoted || 'what is deployed, serving or running'}), `
    + 'but no tool call in that answer read it, so it comes from memory or earlier context and may be stale. '
    + `Either read the live state NOW (${LIVE_STATE_READ_TOOLS.join(' / ')} on the lane or resource the owner asked about) and answer from their RESULTS, quoting what they returned, `
    + 'or keep your answer but say in the same sentence that it was not read this turn and how old the source is. '
    + 'Never state what is deployed, serving, running or fixed as current unless a read in THIS answer shows it.]';
}
