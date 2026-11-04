/**
 * "Is this assistant row the supervisor's own reply?" — the ONE predicate the
 * project brief (fleet/project-brief.service.ts), the [OPEN OWNER ASKS] wake
 * block and follow-through detector 3 (platform/owner-asks.ts,
 * fleet/follow-through.service.ts) share (tt-rd audit 2026-09-27). LEAF: it
 * imports only the harness-error-note shapes so the chat-agent run-start path
 * can load it under thin test mocks.
 *
 * A row qualifies when it is owner-origin (no origin stamp, or 'user' — machine
 * wake prompts and harness notes carry another origin) OR carries the
 * harness's `metadata.ownerAskReply` stamp (fixer 2026-09-27, finding
 * upward-chatter-1: the reply of an [OWNER ASK UNANSWERED] re-wake /
 * [FOLLOW-THROUGH] nudge is a HOOK-origin row — chat-agent stamps it only when
 * the wake answered in real text, never on an envelope or a 'WAKE: no-op'
 * close — so an ask answered on a machine wake counts as answered), carries
 * the chat engine's FINALIZE stamp (review C6, 2026-09-24: `metadata.engine
 * === 'agent'` or the per-seat `models` object — harness notices are plain
 * rows with NO metadata), is not a briefing/status card kind, is not a
 * provider-error envelope, and has non-empty, non-harness-error text.
 */

import { isHarnessErrorNote } from '../coding/harness-error-notes';

/** Machine-authored assistant kinds that are never the supervisor's reply. */
export const MACHINE_NOTE_KINDS: ReadonlySet<string> = new Set(['owner_briefing', 'project_status', 'session_status']);

/** The supervisor prompts' no-op close marker (supervisor.service
 *  SUPERVISOR_NOOP_NOTE_RE, mirrored here so the leaf stays import-free): a
 *  machine wake that closes with it did NOT answer an owner ask. */
export const WAKE_NOOP_NOTE_RE = /\b(?:SWEEP|WAKE):\s*no-op\b/i;

/**
 * audit 2026-10-06 T4-9 (others.md F11): a reply that is ONLY the machine
 * no-op close ("WAKE: no-op — nothing moved …", "SWEEP: no-op") did not answer
 * anything — CanLaw's "current progress?" (a89291b4) got exactly that on a
 * human turn and the ask was closed as answered. TRUE when the text OPENS with
 * the no-op marker (after markdown emphasis / quote chrome) and is short (≤ 2
 * non-empty lines, ≤ 600 chars), or (2026-10-22) is made only of the harness's
 * zero-action record lines (isHarnessRecordOnly). A longer reply that merely
 * mentions the marker still counts as a reply. Kill switch
 * OWNER_ASK_NOOP_REPLY_DISABLED=1 (always false — pre-fix behaviour). Pure
 * apart from the env read.
 */
export const NOOP_ONLY_REPLY_MAX_CHARS = 600;
export function ownerAskNoopReplyDisabled(): boolean {
  return process.env.OWNER_ASK_NOOP_REPLY_DISABLED === '1';
}
/**
 * The harness's zero-action record lines (platform/harness-receipts — the neutral 'Harness record: …' line, the
 * 'WAKE: no-op (harness: …' line, the 'Not executed (harness): …' line; mirrored here so the leaf stays
 * import-free). None of them is a word of the model's.
 */
const HARNESS_ZERO_RECORD_LINE_RE = /^(?:Harness record:|WAKE: no-op \(harness:|Not executed \(harness\):)/;
/** SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1|true|on (chat-agent/owner-answer-first followThroughQuietZeroDisabled — same parse). */
function followThroughQuietZeroDisabled(): boolean {
  const v = String(process.env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
/**
 * Follow-through minors review fix (2026-10-22): a reply made ONLY of the harness's zero-action record lines carries
 * no word of the model's — an answer-first follow-through round reduced to the bare 'Harness record: 0 lane actions
 * this wake.' line closed the owner ask (closeAskOnReply, source 'continuation') with a content-free bubble. It is a
 * no-op reply like the bare marker close. Off under SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1. Pure apart from
 * the env read.
 */
function isHarnessRecordOnly(t: string): boolean {
  if (followThroughQuietZeroDisabled()) return false;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => HARNESS_ZERO_RECORD_LINE_RE.test(l));
}
export function isNoopOnlyReply(text: unknown): boolean {
  if (ownerAskNoopReplyDisabled()) return false;
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (isHarnessRecordOnly(t)) return true;
  if (t.length > NOOP_ONLY_REPLY_MAX_CHARS) return false;
  if (!/^[\s*_`>#-]*(?:SWEEP|WAKE):\s*no-op\b/i.test(t)) return false;
  return t.split('\n').filter((l) => l.trim()).length <= 2;
}

/** An owner-typed row: no origin stamp, or the explicit 'user' origin. */
export function isOwnerOrigin(metadata: unknown): boolean {
  const origin = (metadata as any)?.origin;
  return origin == null || origin === 'user';
}

/** The harness stamp on a machine-wake reply that answered an owner ask
 *  (chat-agent finalize, hook-origin wakes carrying ownerAskMessageIds). */
export function isOwnerAskReplyRow(metadata: unknown): boolean {
  return (metadata as any)?.ownerAskReply === true;
}

/** The chat engine's FINALIZE stamp (review C6, 2026-09-24). */
export function hasFinalizeStamp(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const m = metadata as Record<string, unknown>;
  return m.engine === 'agent' || (!!m.models && typeof m.models === 'object');
}

/**
 * build 2026-10-08 A1 (chat-agent/owner-answer-first.ts): an owner answer split at the answer-first deadline whose
 * follow-through task is ARMED is not yet the reply — the ask closes when that task settles (the round's result row
 * qualifies; its finalize closes the ask). Until its card leaves 'running' (or with no card at all) the row is skipped.
 */
export function isPendingAnswerFirstSplit(metadata: unknown): boolean {
  const af = (metadata as any)?.ownerAnswerFirst;
  if (!af || af.armed !== true) return false;
  const status = (metadata as any)?.task?.status;
  return status == null || status === 'running';
}

/** True when a persisted assistant row is the supervisor's own on-turn reply. Pure. */
export function isSupervisorReplyRow(r: { content: string | null; metadata: any }): boolean {
  if (!isOwnerOrigin(r.metadata) && !isOwnerAskReplyRow(r.metadata)) return false;
  if (!hasFinalizeStamp(r.metadata)) return false;
  const kind = r.metadata?.kind;
  if (typeof kind === 'string' && MACHINE_NOTE_KINDS.has(kind)) return false;
  if (r.metadata?.providerError) return false;
  // build 2026-10-08 A1: a split answer whose follow-through still runs, and a follow-through round an owner message
  // preempted (re-queued — it answered nothing), are not the reply.
  if (isPendingAnswerFirstSplit(r.metadata)) return false;
  if (r.metadata?.preempted === true && r.metadata?.kind === 'continuation_result') return false;
  const text = String(r.content ?? '').trim();
  // audit 2026-10-06 T4-9: a bare no-op close never answers an owner ask.
  return text.length > 0 && !isHarnessErrorNote(text) && !isNoopOnlyReply(text);
}
