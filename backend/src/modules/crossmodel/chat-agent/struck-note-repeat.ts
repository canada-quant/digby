/**
 * STRUCK-NOTE REPEAT — tickets 4c7aebf7 + 9a976d83 (2026-10-21, chat e03452f4, the
 * 'cql-agx-orin64 Supervisor' project-supervisor chat).
 *
 * THE INCIDENT: at 17:12:19Z a machine-wake note claimed it had driven the owner's Mac via
 * computer_task (Tailscale ACL edit applied + saved, verify probe red) and headlined the FUTURE
 * clock "17:25Z". The pre-delivery guard struck the clock — observe-only, so the note was
 * delivered with a trailing annotation, and the in-thread correction row named the clock
 * (ticket 9a976d83: a TRUE POSITIVE, contained pre-delivery). At 17:17:05Z the Fleet Supervisor
 * ordered "STEP 1: camera-read the saved policy JSON and quote it BEFORE any retry". At 17:20:32Z
 * the chat answered with a VERBATIM copy of its struck 17:12 note — same claims, another wrong
 * clock ("17:14Z", in the past this time, so the clock lane had nothing to strike) — and never
 * ran step 1; the owner watching the Mac saw zero cursor movement (ticket 4c7aebf7). Nothing
 * compared a machine note with the chat's previous one, so a re-post of a flagged note was
 * delivered as fresh work.
 *
 * THIS LEAF is the deterministic core of the fix (pure except loadPriorAssistantNote):
 *   (b) detectStruckNoteRepeat — the final note of a machine run is a near-verbatim copy
 *       (≥ REPEAT_SIMILARITY_THRESHOLD of its tokens in order, timestamps normalised) of the
 *       SAME chat's previous assistant note AND that note carries the action verifier's strike
 *       chrome. The chat-agent seam then routes the run through the EXISTING bounded reject-back
 *       re-orchestration ONCE with renderRepeatRejectBackNotice (it names the repeat and the
 *       struck claims); a retry that is still a repeat is delivered AS WRITTEN with
 *       renderRepeatAnnotation trailing it — never a second retry, never a block on the chat.
 *   (a) renderPriorNoteStruckBlock — the NEXT machine turn after a struck note carries a short
 *       [PRIOR NOTE STRUCK] block in its system context: acknowledge the flagged claims and
 *       re-run them with fresh tool calls before writing anything new.
 * A struck note is detected by CONTENT (there is no structured flag on the row — the same rule
 * guard-chrome-redact lives by): the replace-lane / strip+mark banners at position 0, or the
 * observe-only annotation header owning a line — EXCEPT the observe-only action-claims footnote
 * (BRIEFING-UNVERIFIED-FILTER), the gate-flipped lane with measured false positives: a note that
 * carries only that footnote is not struck, so it never costs a reject-back or asks a lane to redo
 * work on a mis-mined claim. A copy of an UNSTRUCK note is never this class
 * (a supervisor's routine identical "nothing moved" note is honest), and a note shorter than
 * REPEAT_MIN_TOKENS is never compared.
 *
 * Round-2 hardening (2026-10-21, both reviews NOT_MERGE_SAFE): a repeat also needs the SAME numbers and
 * hex ids (a multiset — a templated status note whose metrics moved is fresh data, never a copy); a
 * supervisor NO-OP note (platform/supervisor.service classifySupervisorNote — the one classifier, injected by
 * the seam) is never compared; this module's OWN repeat annotation is not a strike (an honest unchanged
 * note cannot keep the chat bounced wake after wake); the prior-note scan reads only the lane's own notes
 * (fleet/supervisor-own-voice isSupervisorOwnVoice + the chat-agent side-row kinds); the annotation states
 * what really happened (sent back / retry failed / could not be sent back). All under the same switches.
 *
 * Round-3 hardening (2026-10-21, both reviews NOT_MERGE_SAFE): (i) the computer_task claim check's
 * annotation (COMPUTER_TASK_ANNOTATION_LEAD) never makes a re-post a repeat — and since round 4 it exists only
 * under COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 and is a strike for the [PRIOR NOTE STRUCK] block only while that
 * opt-in is set (worded for screen claims); (ii) the no-op skip keys on an EXPLICIT no-op marker closing the note
 * (explicitNoopPredicate), never the classifier's ≤200-char fall-through — a short re-post of a struck claim is
 * compared. Known gap, accepted: a note whose LAST line is a no-op marker is skipped even when claims sit above
 * it (a miss in the safe direction — every guard lane still judges its lines).
 *
 * Round-4 hardening (2026-10-21, both round-3 reviews NOT_MERGE_SAFE): (i) a struck note costs AT MOST ONE
 * reject-back, EVER — the round-3 carry-through (which re-propagated the original strike through repeat-annotated
 * rows, so an honest unchanged status bounced on every wake of the 8-row window) is gone, and a note that went
 * through the repeat check as a copy is SPENT (repeatSpent: it carries the repeat annotation, or the seam stamped
 * metadata[REPEAT_LINEAGE_META_KEY] — repeatLineageStamp — on it or on a later copy of it), so neither it nor a
 * further copy of it is ever a repeat target again: an honest unchanged note after one bounce is annotated at most
 * once. The [PRIOR NOTE STRUCK] block still names a spent note's own strike, without the send-back warning; (ii) the
 * repeat reject-back is SKIPPED (annotated instead — repeatRejectBackSkip) when the run fired a replay-unsafe tool
 * (the seam's tool-call-leak classification) — a whole-wake replay never re-runs a send or a desktop action; (iii) an
 * ineligible prior (spent / screen-claims-only) is still MEASURED (`wouldRepeat`), never acted on. Known gap,
 * accepted: a copy whose reject-back never ran (a run stopped before the retry — 'annotated_no_retry' — or a skipped
 * one — 'annotated_replay_unsafe') is spent too, so a third copy after it is not compared (the second copy's
 * annotation already marks it in the thread; at most once, ever, wins over catching it).
 *
 * Round-5 hardening (2026-10-21, both round-4 reviews NOT_MERGE_SAFE): (i) the round-4 'run_backed' skip is REMOVED —
 * a tool result that merely echoes or quotes the struck note (a read of the chat's own messages, the supervisor state,
 * a memory read, a relay quoting the clock or id) is not backing, and telling an echo from evidence needs the
 * evidence-tool classification this leaf does not have; the at-most-once rule bounds a genuine re-post to one bounce.
 * (ii) A replay-unsafe skip whose wake the GUARD's own reject-back cycle re-ran anyway is 'guard_cycle_repeat', worded
 * for what happened (the wake WAS re-run once, so the unsafe call may have run again) — never "it was not sent back".
 * (iii) A stored computer_task claim-check annotation is a [PRIOR NOTE STRUCK] strike only while its opt-in is set AND
 * the check is not off (COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 is the full off switch, as documented).
 *
 * Kill switches: STRUCK_NOTE_REPEAT_DISABLED=1 (no repeat check, no reject-back, no annotation, no lineage stamp)
 * and PRIOR_NOTE_STRUCK_BLOCK_DISABLED=1 (no [PRIOR NOTE STRUCK] block); with both set the run
 * does not read the prior note at all — today's behaviour byte-for-byte.
 */
import prisma from '../../../config/database';
import { UNVERIFIED_FOOTNOTE_HEADER } from '../platform/unverified-claims';
import { isSupervisorOwnVoice } from '../fleet/supervisor-own-voice';

/** STRUCK_NOTE_REPEAT_DISABLED=1 — the repeat check, its reject-back and its annotation are off. */
export function struckNoteRepeatDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRUCK_NOTE_REPEAT_DISABLED === '1';
}

/** PRIOR_NOTE_STRUCK_BLOCK_DISABLED=1 — the next machine turn gets no [PRIOR NOTE STRUCK] block. */
export function priorNoteStruckBlockDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PRIOR_NOTE_STRUCK_BLOCK_DISABLED === '1';
}

/**
 * COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 — the computer_task claim check (chat-agent/computer-task-claims) annotates
 * an unbacked note and its annotation is a [PRIOR NOTE STRUCK] strike. Default OFF (round 4): the check only records
 * its loop_metrics row. Lives here because that leaf imports this one (re-exported there).
 */
export function computerTaskClaimAnnotateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED === '1';
}

/** COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 — the computer_task claim check is off entirely: no check, no row, no annotation,
 *  and (round 5) a stored claim-check annotation is no strike either. Lives here for the same reason (re-exported there). */
export function computerTaskClaimCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPUTER_TASK_CLAIM_CHECK_DISABLED === '1';
}

/** loop_metrics kind — one row per machine turn after a struck note ({ outcome, similarity, priorMessageId, … }). */
export const STRUCK_NOTE_REPEAT_METRIC = 'struck_note_repeat';

/** "≥ 90% the same" — 2·LCS / (n + m) over normalised word tokens. */
export const REPEAT_SIMILARITY_THRESHOLD = 0.9;
/** A note shorter than this many tokens is never compared ("WAKE: no-op" lines repeat honestly). */
export const REPEAT_MIN_TOKENS = 12;
/** Token cap per side for the O(n·m) comparison (≈ a 20 KB note; the head decides the verdict). */
export const REPEAT_MAX_TOKENS = 3000;
/** Assistant rows read to find the previous NOTE (every harness-authored row and error envelope is skipped). */
export const PRIOR_NOTE_SCAN_ROWS = 8;
/** Struck-claim lines carried into the notice / block. */
export const MAX_STRUCK_CLAIM_LINES = 6;
export const STRUCK_CLAIM_LINE_MAX_CHARS = 220;

/** Model-context headers (CHROME RULE: never the verifier's own banners — they enter the model's context). */
export const REPEAT_NOTICE_HEADER = '[HARNESS NOTICE — REPEATED NOTE — not typed by the user]';
export const PRIOR_NOTE_STRUCK_HEADER = '[PRIOR NOTE STRUCK — harness, not typed by the user]';

// Literals mirror platform/action-verifier.ts (that module's import chain cannot ride this leaf).
const ACTION_VERIFIER_PREFIX = '[ACTION VERIFIER —';
const STRUCK_FENCE_BEGIN = '--- BEGIN STRUCK NOTE';
const STRUCK_FENCE_END = '--- END STRUCK NOTE';
const REDACTED_LINE_PREFIX = '⛔ [line removed by the action verifier';
/**
 * Assistant rows that are NOT the lane's own note. The positive signal is fleet/supervisor-own-voice
 * isSupervisorOwnVoice (only the chat-agent finalize stamps metadata.engine 'agent' — the watchdog's
 * stuck-note-nudge, report_up_ack, decision-autofiled, verify-starve-notice, deliverable_handoff,
 * background_worker_report and the hook / schedule notices carry no such stamp). These kinds ride the
 * finalize stamp (or could) but are side rows, never the wake's note: the chat-agent side-row set
 * (platform/live-chat-audit SIDE_KINDS) plus the harness kinds supervisor chats carry
 * (platform/supervisor-wake-ledger HARNESS_ASSISTANT_KINDS) — belt-and-braces beside the stamp.
 */
const SIDE_ROW_KINDS: ReadonlySet<string> = new Set([
  'owner_briefing', 'stuck-note-nudge', 'report_up_ack', 'material_gate_ack', 'decision-autofiled',
  'verify-starve-notice', 'watched-resource', 'project_status', 'session_status', 'deeper_findings', 'continuation_result',
  'deliverable_handoff', 'background_worker_report', 'control_note', 'check_addendum', 'council_addendum',
]);
/**
 * The BRIEFING-UNVERIFIED-FILTER footnote (platform/unverified-claims renderUnverifiedClaimsFootnote) shares the
 * annotation header but is the OBSERVE-ONLY action-claims lane — the one the 2026-09-11 gate flip took out of
 * enforcement for its measured false positives (and that guard-chrome-redact counts as zero unverified claims,
 * so a lane never redoes real work on a mis-mined claim). A note carrying only that footnote is NOT struck.
 */
const ACTION_CLAIMS_FOOTNOTE_RE = /could not verify \d+ action claim\(s\) in it/;
/**
 * THIS module's own repeat annotation (renderRepeatAnnotation) — every outcome's wording leads with it. It is
 * NOT a strike (round-2 finding 3b): it judges the note's TEXT against the previous note, not its claims, so an
 * honest unchanged note that followed a struck one must not make the NEXT turn read as "after a strike" too
 * (the chat would keep getting bounced while the state stays unchanged). Only the original strike propagates.
 */
export const REPEAT_ANNOTATION_LEAD = 'This note was delivered as written. It is a near-verbatim copy (';
/**
 * The computer_task claim check's annotation (chat-agent/computer-task-claims renderComputerTaskClaimAnnotation
 * renders with THIS literal — that leaf imports this one) leads with this. It is NEVER a repeat strike — a pattern
 * check with no measured false-positive rate never makes a re-post cost a reject-back (gate-flip doctrine
 * 2026-09-11) — and since round 4 it is a strike for the next turn's [PRIOR NOTE STRUCK] block ONLY while
 * COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 (the opt-in that writes it at all) and — round 5 — the check is not off
 * (COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 ignores the opt-in, as documented).
 */
export const COMPUTER_TASK_ANNOTATION_LEAD = 'This note was delivered as written. It says it acted on the screen this turn (';

export type StruckLane = 'replaced' | 'redacted' | 'annotated';

export interface PriorNote {
  id: string;
  createdAt: Date;
  /** How the verifier struck it (null = not struck) — the [PRIOR NOTE STRUCK] block's read. */
  struck: StruckLane | null;
  /**
   * Does the strike make a near-verbatim re-post of this note a REPEAT (a reject-back)? Every strike except the
   * computer_task claim check's annotation (round 3 — a screen-claims-only note gets the block, never a bounce).
   * Absent (a hand-built PriorNote) reads as true.
   */
  repeatStrike?: boolean;
  /** The model's own words — verifier chrome and anything after it removed. */
  body: string;
  /** The claim lines the verifier named ('- …'), capped. */
  struckClaims: string[];
  /**
   * Round 4: this note already went through the repeat check AS A COPY — it carries this module's repeat annotation,
   * or the seam stamped metadata[REPEAT_LINEAGE_META_KEY] (repeatLineageStamp) on it. Its lineage has had its one
   * reject-back: it is never a repeat target again (its own strike still feeds the [PRIOR NOTE STRUCK] block).
   * Absent (a hand-built PriorNote) reads as false.
   */
  repeatSpent?: boolean;
}

export interface RepeatVerdict {
  repeat: boolean;
  /** 2·LCS/(n+m) on normalised tokens (0 when not computed). */
  similarity: number;
  /**
   * 'noop' — the note is a supervisor no-op (never compared); 'numbers_differ' — at or above the threshold in
   * words, but its numbers / hex ids moved (fresh data on the same template, never a copy);
   * 'prior_screen_claims_only' — the prior note's only strike is the computer_task claim check's (that check never
   * makes a re-post a repeat); 'prior_repeat_spent' — the prior note was itself a copy that went through the
   * repeat check (round 4: one reject-back per struck note, ever). Both ineligible reasons still MEASURE.
   */
  reason: 'repeat' | 'no_prior' | 'prior_not_struck' | 'prior_screen_claims_only' | 'prior_repeat_spent' | 'too_short' | 'noop' | 'below_threshold' | 'numbers_differ';
  /** Ineligible priors only (round 4): would the note have been a repeat? — measured, never acted on. */
  wouldRepeat?: boolean;
}

/** How a repeat that is delivered as written got there (renderRepeatAnnotation words each one truthfully). Round 4 adds
 *  the skipped reject-back 'annotated_replay_unsafe' (a replay would repeat a side effect of this run — no re-run at
 *  all); round 5 adds 'guard_cycle_repeat' (the repeat reject-back was skipped as replay-unsafe, but the guard's OWN
 *  reject-back cycle re-ran the wake once anyway and a copy still stands). Round 5 removes 'annotated_run_backed'. */
export type RepeatAnnotatedOutcome = 'still_repeat_annotated' | 'retry_failed' | 'annotated_no_retry' | 'annotated_replay_unsafe' | 'guard_cycle_repeat';

export interface RepeatCheckOptions {
  /**
   * Is this note body a supervisor NO-OP? The seam injects platform/supervisor.service classifySupervisorNote
   * (=== 'supervisor_noop') — the one classifier the no-op telemetry uses; this leaf never re-implements it.
   * A throw reads as "not a no-op".
   */
  isNoop?: (noteBody: string) => boolean;
}

/** The no-op classifier's pieces, injected by the seam (platform/supervisor.service — never re-implemented here). */
export interface NoopMarkers {
  /** classifySupervisorNote. */
  classify: (text: string) => string;
  /** SUPERVISOR_NOOP_NOTE_RE — the explicit 'WAKE: no-op' / 'SWEEP: no-op' marker (the harness no-op line matches it too). */
  noop: RegExp;
  /** SUPERVISOR_ACTION_NOTE_RE — an action-receipt marker (the model-typed block is stripped before the guard; a paraphrase can remain). */
  action: RegExp;
}

/**
 * The repeat check's no-op predicate (round 3): the supervisor classifier says 'supervisor_noop' AND the note's
 * LAST line carries the explicit no-op marker AND no action marker appears. Never the classifier's ≤200-char
 * fall-through: the model-typed ACTIONS TAKEN block is already stripped at the guard seam, so a short fabricated
 * action note would always read as a no-op there and a short re-post of a struck claim would never be compared.
 * Pure (the injected pieces aside).
 */
export function explicitNoopPredicate(m: NoopMarkers): (noteBody: string) => boolean {
  return (noteBody: string): boolean => {
    const text = String(noteBody ?? '').trim();
    if (!text || m.classify(text) !== 'supervisor_noop') return false;
    if (m.action.test(text)) return false;
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return m.noop.test(lines[lines.length - 1] ?? '');
  };
}

/**
 * What one verifier block is: 'strike' (every banner / annotation that strikes the note — the clock lane, the
 * citation / board / miscopy lanes, the replace / strip+mark banners), 'screen_claims' (the computer_task claim
 * check — a strike for the [PRIOR NOTE STRUCK] block, never a repeat strike — round 3), 'repeat' (this module's
 * own repeat annotation — never a strike, round-2 finding 3b) or 'claims_footnote' (the observe-only
 * action-claims footnote — never a strike).
 */
type VerifierBlockKind = 'strike' | 'screen_claims' | 'repeat' | 'claims_footnote';

/** The verifier blocks of a note: every line a verifier header owns, with the paragraph under it, and its kind. Pure. */
function verifierBlocks(text: string): Array<{ start: number; lines: string[]; kind: VerifierBlockKind; strike: boolean }> {
  const lines = text.split('\n');
  const out: Array<{ start: number; lines: string[]; kind: VerifierBlockKind; strike: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith(ACTION_VERIFIER_PREFIX)) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !lines[j].startsWith(STRUCK_FENCE_BEGIN) && !lines[j].trim().startsWith(ACTION_VERIFIER_PREFIX)) j += 1;
    const block = lines.slice(i, j);
    const lead = block[1] ?? '';
    const kind: VerifierBlockKind = ACTION_CLAIMS_FOOTNOTE_RE.test(block.join('\n')) ? 'claims_footnote'
      : lead.startsWith(REPEAT_ANNOTATION_LEAD) ? 'repeat'
      : lead.startsWith(COMPUTER_TASK_ANNOTATION_LEAD) ? 'screen_claims'
      : 'strike';
    out.push({ start: i, lines: block, kind, strike: kind === 'strike' || (kind === 'screen_claims' && computerTaskClaimAnnotateEnabled() && !computerTaskClaimCheckDisabled()) });
    i = j - 1;
  }
  return out;
}

/**
 * Does the note's strike make a near-verbatim re-post a REPEAT? A replace-lane / strip+mark banner at position 0,
 * or an annotation of kind 'strike' owning a line — never the computer_task claim check's alone (round 3). Pure.
 */
export function repeatStrikeOf(content: string | null | undefined): boolean {
  const text = String(content ?? '');
  if (text.trimStart().startsWith(ACTION_VERIFIER_PREFIX)) return true;
  return verifierBlocks(text).some((b) => b.kind === 'strike' && b.lines[0].trim() === UNVERIFIED_FOOTNOTE_HEADER);
}

/** Does the note carry this module's repeat annotation (renderRepeatAnnotation)? Pure. */
export function hasRepeatAnnotation(content: string | null | undefined): boolean {
  return verifierBlocks(String(content ?? '')).some((b) => b.kind === 'repeat');
}

/**
 * How a stored assistant note was struck, by its content (null = not struck): a replace-lane wrapper or a
 * strip+mark notice at position 0, or an observe-only ANNOTATION owning a line (the clock lane, the citation /
 * board / miscopy lanes, the computer_task claim check — that one is not a REPEAT strike, see repeatStrikeOf).
 * The observe-only action-claims footnote and this module's own repeat annotation alone are not a strike. Pure.
 */
export function struckLaneOf(content: string | null | undefined): StruckLane | null {
  const text = String(content ?? '');
  const lead = text.trimStart();
  if (lead.startsWith(ACTION_VERIFIER_PREFIX)) return text.includes(STRUCK_FENCE_BEGIN) ? 'replaced' : 'redacted';
  return verifierBlocks(text).some((b) => b.strike && b.lines[0].trim() === UNVERIFIED_FOOTNOTE_HEADER) ? 'annotated' : null;
}

/**
 * The model's own words in a note (stored or about to be delivered): the quoted original of a
 * replace-lane wrapper, the surviving lines of a strip+mark note, or the text up to the first
 * line a verifier header owns (an annotation, and every harness trailer after it). Pure.
 */
export function noteBodyForRepeat(content: string | null | undefined): string {
  const text = String(content ?? '');
  const lane = struckLaneOf(text);
  if (lane === 'replaced') {
    const lines = text.split('\n');
    const begin = lines.findIndex((l) => l.startsWith(STRUCK_FENCE_BEGIN));
    const endRel = lines.slice(begin + 1).findIndex((l) => l.startsWith(STRUCK_FENCE_END));
    const end = endRel < 0 ? lines.length : begin + 1 + endRel;
    return lines.slice(begin + 1, end).map((l) => l.replace(/^> ?/, '')).join('\n').trim();
  }
  let body = text;
  if (lane === 'redacted') {
    const sep = body.indexOf('\n\n');
    body = sep < 0 ? '' : body.slice(sep + 2);
    body = body.split('\n').filter((l) => !l.startsWith(REDACTED_LINE_PREFIX)).join('\n');
  }
  const lines = body.split('\n');
  const cut = lines.findIndex((l) => l.trim().startsWith(ACTION_VERIFIER_PREFIX));
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').replace(/\s+$/, '');
}

/** The '- …' claim lines under every verifier STRIKE block in a note, capped and clipped. Pure. */
export function struckClaimLines(content: string | null | undefined): string[] {
  const out: string[] = [];
  for (const b of verifierBlocks(String(content ?? ''))) {
    if (!b.strike) continue;
    for (const l of b.lines.slice(1)) {
      if (out.length >= MAX_STRUCK_CLAIM_LINES) return out;
      if (!l.startsWith('- ')) continue;
      const clipped = l.length > STRUCK_CLAIM_LINE_MAX_CHARS ? `${l.slice(0, STRUCK_CLAIM_LINE_MAX_CHARS - 1)}…` : l;
      if (!out.includes(clipped)) out.push(clipped);
    }
  }
  return out;
}

// Timestamps normalise to one placeholder token: an ISO stamp, or a clock with an optional
// seconds / am-pm / zone suffix ("17:25Z", "5:14 PM PDT", "17:25:01 UTC").
const ISO_STAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi;
const CLOCK_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?(?:\s*(?:z|utc|gmt|[ecmp][sd]t)\b|z)?/gi;
const TIME_TOKEN = 'tclock';

/** Normalised word tokens: lowercase, timestamps → one placeholder, markdown/punctuation off. Pure. */
export function repeatTokens(text: string | null | undefined): string[] {
  const t = String(text ?? '').toLowerCase().replace(ISO_STAMP_RE, ` ${TIME_TOKEN} `).replace(CLOCK_RE, ` ${TIME_TOKEN} `);
  return t.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The load-bearing tokens of a note: every token carrying a digit — numbers, metrics, hex ids, versions
 * ("30", "88", "ab12cd34", "orin64"). Timestamps are already the placeholder (no digit), so a new clock alone
 * never makes a note fresh. Pure. */
export function loadBearingTokens(tokens: readonly string[]): string[] {
  return tokens.filter((t) => /\d/.test(t));
}

/**
 * Do two notes carry the SAME numbers and ids — as a MULTISET (order-free, counts matter)? No tolerance, by
 * design: a re-post is the same claims, so a verbatim copy carries every number unchanged (the incident did),
 * while ONE moved metric is a changed observation — a templated status note ("step 1450, loss 0.431,
 * 18.60 tok/s") is fresh data, never a copy. The price of zero tolerance is a copy that edits one number
 * escaping the repeat check — it still gets the [PRIOR NOTE STRUCK] block and every guard lane; the price of
 * any tolerance is bouncing real fresh data (the 2026-09-11 gate-flip class). Pure.
 */
export function sameLoadBearingTokens(a: readonly string[], b: readonly string[]): boolean {
  const x = loadBearingTokens(a).sort();
  const y = loadBearingTokens(b).sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * 2·LCS / (n + m) over two token sequences — the share of both notes that is the same words in
 * the same order. With `floor`, a pair whose lengths alone cap the ratio below it returns that
 * cap (an upper bound, still below the floor) without running the O(n·m) table. Pure.
 */
export function tokenSequenceRatio(a: readonly string[], b: readonly string[], floor = 0): number {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return 1;
  if (!n || !m) return 0;
  const bound = (2 * Math.min(n, m)) / (n + m);
  if (bound < floor) return bound;
  if (n === m && a.every((t, i) => t === b[i])) return 1;
  const ids = new Map<string, number>();
  const intern = (t: string): number => { let v = ids.get(t); if (v === undefined) { v = ids.size + 1; ids.set(t, v); } return v; };
  const ia = Int32Array.from(a, intern);
  const ib = Int32Array.from(b, intern);
  let prev = new Uint16Array(m + 1);
  let cur = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const x = ia[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = x === ib[j - 1] ? prev[j - 1] + 1 : (prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1]);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return (2 * prev[m]) / (n + m);
}

/** Similarity of two notes' model text (chrome off, timestamps normalised, capped). Pure. */
export function repeatSimilarity(a: string, b: string, floor = 0): number {
  return tokenSequenceRatio(
    repeatTokens(noteBodyForRepeat(a)).slice(0, REPEAT_MAX_TOKENS),
    repeatTokens(noteBodyForRepeat(b)).slice(0, REPEAT_MAX_TOKENS),
    floor,
  );
}

/**
 * Is `finalText` a near-verbatim re-post of the chat's previous, STRUCK note? A repeat is at or above the
 * threshold in words (timestamps aside) AND carries the same numbers / hex ids (sameLoadBearingTokens); a
 * supervisor no-op note (opts.isNoop) is never compared — an honest "nothing moved" after a struck note is not
 * a re-post of its claims. Pure (the injected predicate aside).
 */
export function detectStruckNoteRepeat(finalText: string | null | undefined, prior: PriorNote | null | undefined, opts: RepeatCheckOptions = {}): RepeatVerdict {
  if (!prior) return { repeat: false, similarity: 0, reason: 'no_prior' };
  if (!prior.struck) return { repeat: false, similarity: 0, reason: 'prior_not_struck' };
  // Round 4: an INELIGIBLE prior (spent / screen-claims-only) is compared for measurement only — never a repeat.
  const ineligible: RepeatVerdict['reason'] | null = prior.repeatSpent ? 'prior_repeat_spent' : prior.repeatStrike === false ? 'prior_screen_claims_only' : null;
  if (ineligible) {
    const measured = compareWithPrior(finalText, prior, opts);
    return { repeat: false, similarity: measured.similarity, reason: ineligible, wouldRepeat: measured.repeat };
  }
  return compareWithPrior(finalText, prior, opts);
}

/** The repeat comparison itself (the prior's eligibility aside) — detectStruckNoteRepeat's core. Pure. */
function compareWithPrior(finalText: string | null | undefined, prior: PriorNote, opts: RepeatCheckOptions): RepeatVerdict {
  const body = noteBodyForRepeat(finalText);
  const tokens = repeatTokens(body);
  const priorTokens = repeatTokens(prior.body);
  if (tokens.length < REPEAT_MIN_TOKENS || priorTokens.length < REPEAT_MIN_TOKENS) {
    return { repeat: false, similarity: 0, reason: 'too_short' };
  }
  let noop = false;
  try { noop = opts.isNoop?.(body) === true; } catch { noop = false; }
  if (noop) return { repeat: false, similarity: 0, reason: 'noop' };
  const ratio = tokenSequenceRatio(tokens.slice(0, REPEAT_MAX_TOKENS), priorTokens.slice(0, REPEAT_MAX_TOKENS), REPEAT_SIMILARITY_THRESHOLD);
  const similarity = Math.round(ratio * 1000) / 1000;
  if (similarity < REPEAT_SIMILARITY_THRESHOLD) return { repeat: false, similarity, reason: 'below_threshold' };
  if (!sameLoadBearingTokens(tokens, priorTokens)) return { repeat: false, similarity, reason: 'numbers_differ' };
  return { repeat: true, similarity, reason: 'repeat' };
}

/**
 * The assistant-row metadata key the seam stamps on a delivered copy (round 4 — repeatLineageStamp): the row's
 * lineage has had its one repeat reject-back. Read back by priorNoteFromRow (repeatSpent).
 */
export const REPEAT_LINEAGE_META_KEY = 'struckNoteRepeat';
export interface RepeatLineageStamp { spent: true; via: 'repeat' | 'copy_of_spent' }

/**
 * The lineage stamp for the note about to be delivered (round 4), or null: 'repeat' — this turn's note was a repeat
 * and the delivered text is still a copy (every outcome but a clean retry); 'copy_of_spent' — the prior was spent
 * and this note would have been a repeat of it (a further copy inherits the spend, so the chain never re-arms).
 * A screen-claims-only prior never stamps (that lineage never bounces anyway). Pure.
 */
export function repeatLineageStamp(verdict: RepeatVerdict | null | undefined, deliveredIsCopy: boolean): RepeatLineageStamp | null {
  if (!verdict) return null;
  if (verdict.repeat) return deliveredIsCopy ? { spent: true, via: 'repeat' } : null;
  if (verdict.reason === 'prior_repeat_spent' && verdict.wouldRepeat === true) return { spent: true, via: 'copy_of_spent' };
  return null;
}

const lineageSpent = (metadata: unknown): boolean => {
  const stamp = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>)[REPEAT_LINEAGE_META_KEY] : null;
  return !!stamp && typeof stamp === 'object' && (stamp as Record<string, unknown>).spent === true;
};

/** A stored assistant row → PriorNote (null for an empty row). Pure; exported for tests. */
export function priorNoteFromRow(row: { id: string; content: string | null; createdAt: Date; metadata?: unknown }): PriorNote | null {
  const content = String(row?.content ?? '');
  if (!content.trim()) return null;
  return {
    id: String(row.id),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as any),
    struck: struckLaneOf(content),
    repeatStrike: repeatStrikeOf(content),
    repeatSpent: hasRepeatAnnotation(content) || lineageSpent(row.metadata),
    body: noteBodyForRepeat(content),
    struckClaims: struckClaimLines(content),
  };
}

/**
 * Is this stored assistant row the lane's own NOTE (round-2 finding 6)? The chat-agent finalize stamp
 * (fleet/supervisor-own-voice isSupervisorOwnVoice — the predicate the project digest quotes "its supervisor
 * says" by), minus provider-error envelopes and the side-row kinds. Every other harness-authored row (the
 * watchdog's nudge, a report-up ack, a decision auto-file, a verify-starve notice …) is skipped, so it can
 * never sit between a struck note and its re-post and hide the strike. Pure.
 */
export function isLaneNoteRow(metadata: unknown): boolean {
  if (!isSupervisorOwnVoice(metadata)) return false;
  const m = metadata as Record<string, unknown>;
  if (m.providerError) return false;
  return !SIDE_ROW_KINDS.has(String(m.kind ?? ''));
}

/**
 * The note the repeat check compares against: the prior note itself when it is struck with a repeat strike and its
 * lineage is not spent (round 4 — no carry-through: one reject-back per struck note, ever), else null. Pure.
 */
export function repeatTargetOf(prior: PriorNote | null | undefined): PriorNote | null {
  if (!prior || !prior.struck || prior.repeatStrike === false || prior.repeatSpent) return null;
  return prior;
}

/**
 * The chat's previous NOTE: the newest assistant row created before `before` (the run's start) that the lane
 * itself wrote (isLaneNoteRow — every harness-authored row and provider-error envelope is skipped). One indexed
 * read (crossmodel_messages (chatId, createdAt)). Fail-open: any error ⇒ null.
 */
export async function loadPriorAssistantNote(chatId: string, before: Date): Promise<PriorNote | null> {
  try {
    const rows = await prisma.crossModelMessage.findMany({
      where: { chatId, role: 'assistant', createdAt: { lt: before } },
      orderBy: { createdAt: 'desc' },
      take: PRIOR_NOTE_SCAN_ROWS,
      select: { id: true, content: true, metadata: true, createdAt: true },
    });
    for (const row of (rows ?? []) as Array<{ id: string; content: string | null; createdAt: Date; metadata?: unknown }>) {
      if (!isLaneNoteRow(row?.metadata)) continue;
      const prior = priorNoteFromRow(row);
      if (prior) return prior;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Round 4: when the repeat reject-back is skipped (annotated instead) ─────────

/** Why the repeat reject-back is skipped: a whole-wake replay could repeat a side effect of this run (round 5: the only reason). */
export type RepeatSkip = { reason: 'replay_unsafe'; tool: string };

/**
 * Round 4: skip the repeat reject-back (the note is annotated instead) when `replayUnsafeTool` is set — the seam's
 * tool-call-leak classification: a whole-wake replay would fire that call (a send, a desktop action) a second time.
 * Round 5 (both round-4 reviews, major): the round-4 'run_backed' skip is GONE. It read a struck clock / id appearing
 * in ANY tool result of the run as backing, but the likeliest place a struck item shows up is an ECHO of the struck
 * note itself — a get_chat_messages read of the supervisor's own chat, its get_supervisor_state notes, a memory read,
 * a relay quoting the clock — which is no evidence at all; telling an echo from backing needs the evidence-tool
 * classification this leaf does not have. Tool results never skip the one reject-back; the at-most-once rule already
 * bounds the cost of a genuine re-post to one bounce. Pure.
 */
export function repeatRejectBackSkip(input: { replayUnsafeTool: string | null | undefined }): RepeatSkip | null {
  if (input.replayUnsafeTool) return { reason: 'replay_unsafe', tool: String(input.replayUnsafeTool) };
  return null;
}

/**
 * The guard's rejectBackNotice closes with this sentence (platform/action-verifier.ts — mirrored literal, pinned by
 * the leaf test against that file's source). When the repeat notice rides the same retry it asks for ONE line on
 * what the previous note got wrong, so the folded guard notice drops the contradicting sentence (round-2 nit 7).
 */
export const REJECT_BACK_NO_MENTION_SENTENCE = ' Do not mention this check in the note.';

/** The guard's reject-back notice minus REJECT_BACK_NO_MENTION_SENTENCE (unchanged when it carries none). Pure. */
export function withoutNoMentionSentence(notice: string): string {
  return String(notice ?? '').split(REJECT_BACK_NO_MENTION_SENTENCE).join('');
}

const pct = (s: number): string => `${Math.round(s * 100)}%`;
const quotedClaims = (prior: PriorNote): string[] => prior.struckClaims.map((l) => `> ${l}`);
/** Which note a repeat copied; `you` = the model-facing notice. */
const copiedNote = (prior: PriorNote, you: boolean): string => `${you ? 'your previous note in this chat' : "this chat's previous note"} (posted ${prior.createdAt.toISOString()})`;

/**
 * The reject-back notice (model context — the retry's user turn). Names the repeat, the
 * similarity, the struck note's time and every struck claim, '> '-quoted so a clock the retry
 * echoes stays in the guard's quoted-void exemption. Pure.
 */
export function renderRepeatRejectBackNotice(verdict: RepeatVerdict, prior: PriorNote): string {
  const claims = quotedClaims(prior);
  return [
    `${REPEAT_NOTICE_HEADER} Your answer was NOT posted: it is a near-verbatim copy (${pct(verdict.similarity)} the same, timestamps aside) of ${copiedNote(prior, true)}, and the integrity check had flagged that note. Re-posting it is not new work.`,
    ...(claims.length ? ['Flagged in that note:', ...claims] : ['That note was flagged by the integrity check (its claims were not verified).']),
    'Do the work this turn instead. If a message in this chat asked for a specific first step (a read, a camera check, a quote of what is on screen before any retry), do THAT step first with a real tool call and quote its result. Re-run every flagged claim with a fresh tool call and cite the fresh result, or write it as "attempted, unverified". Then write a NEW note: one line on what the previous note got wrong, then what this turn verified. Copy every clock from a clock printed THIS run.',
  ].join('\n');
}

/** What really happened to a repeat that is delivered as written — one truthful clause per outcome (round-2 finding 5). */
const REPEAT_OUTCOME_CLAUSE: Record<RepeatAnnotatedOutcome, string> = {
  still_repeat_annotated: 'it was sent back once, and the retry came back as the same copy',
  retry_failed: 'it was sent back once, but the retry produced no usable answer, so this original is delivered',
  annotated_no_retry: 'it could not be sent back (the run was stopped before a retry could run)',
  annotated_replay_unsafe: 'it was not sent back, because this run already made a call that must not run twice ({tool})',
  // Round 5: the repeat reject-back was skipped (replay-unsafe), but the guard's OWN reject-back cycle re-ran the wake
  // anyway — say so (a retry that failed and one that came back as a copy both leave a copy standing).
  guard_cycle_repeat: 'the integrity check re-ran this wake once for its own findings, even though this run had already made a call that must not run twice ({tool}) — that call may have run again — and the note that stands is still the same copy',
};

/**
 * The trailing annotation on a repeat delivered as written (never a second retry) — worded for what really
 * happened (`outcome`). ONE paragraph under the verifier's observe-only header, so guard-chrome-redact strips
 * it from later model context; it leads with REPEAT_ANNOTATION_LEAD, so a later read does NOT count it as a
 * strike (only the original strike propagates). No clock tokens (the stamp is a dated ISO). Pure.
 */
export function renderRepeatAnnotation(verdict: RepeatVerdict, prior: PriorNote, outcome: RepeatAnnotatedOutcome = 'still_repeat_annotated', detail: { tool?: string } = {}): string {
  const clause = (REPEAT_OUTCOME_CLAUSE[outcome] ?? REPEAT_OUTCOME_CLAUSE.still_repeat_annotated).replace('{tool}', detail.tool || 'a side-effecting tool');
  const lead = `${REPEAT_ANNOTATION_LEAD}${pct(verdict.similarity)} the same, timestamps aside) of ${copiedNote(prior, false)}, which the integrity check had flagged; ${clause}.`;
  return [
    UNVERIFIED_FOOTNOTE_HEADER,
    lead,
    ...prior.struckClaims.slice(0, MAX_STRUCK_CLAIM_LINES),
    'Treat its claims as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
  ].join('\n');
}

/**
 * (a) The next machine turn's [PRIOR NOTE STRUCK] block (system context) — '' when the prior
 * note was not struck. Short by construction (≤ 6 clipped claim lines). A note struck ONLY by the computer_task
 * claim check (round 3) gets screen-claims wording: never restate those lines as done, observe with computer_task
 * if the step is still needed — and explicitly NOT "re-run every claim" (a mis-mined ticket / session line must
 * never drive a duplicate). Pure.
 */
export function renderPriorNoteStruckBlock(prior: PriorNote | null | undefined): string {
  if (!prior?.struck) return '';
  const claims = quotedClaims(prior);
  if (prior.repeatStrike === false) {
    return [
      `${PRIOR_NOTE_STRUCK_HEADER} Your previous note in this chat (posted ${prior.createdAt.toISOString()}) said it acted on the screen, but no computer_task result of that run could act (no call, or every call observe-only / busy / unavailable)${claims.length ? ':' : '.'}`,
      ...claims,
      'This turn: acknowledge that in one line and never restate those lines as done. If that on-screen step is still needed, run computer_task and quote its result header (a machine run while the owner is active is camera-only — observe, never claim input), or write it as "attempted, unverified". This notice is about those on-screen lines only — do not redo other work (tickets, sessions, messages) because of it.',
    ].join('\n');
  }
  return [
    `${PRIOR_NOTE_STRUCK_HEADER} Your previous note in this chat (posted ${prior.createdAt.toISOString()}) was flagged by the integrity check${claims.length ? ':' : ' (its claims were not verified).'}`,
    ...claims,
    `This turn: acknowledge that in one line, then re-run each flagged claim with a fresh tool call and cite the fresh result (or mark it "attempted, unverified"). If a message in this chat asked for a specific first step, do that step first. ${prior.repeatSpent ? 'Never re-post the previous note.' : 'Never re-post the previous note — a near-verbatim copy is sent back.'}`,
  ].join('\n');
}
