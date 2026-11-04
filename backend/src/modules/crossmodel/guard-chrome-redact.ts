/**
 * Guard-chrome redaction (ticket ac835c00) — CONTEXT-BUILD time ONLY.
 *
 * When the evidence guard (coding lane: run-evidence-guard.renderSuppressedFinal)
 * or the action verifier (plain-chat lane: action-verifier.guardMachineWakeFinalAnswer)
 * replaces a machine run's final answer, the replacement wrapper — banner +
 * BEGIN/END fence + blockquoted original + claim-verification footer — is
 * PERSISTED into crossmodel_messages/coding_messages. Storage must stay
 * byte-identical (audit trail; the guard's own FORGED_MARKER_RES detection reads
 * it; the UI transcript renders it) — one transient exception: after a REDACTED
 * resume, agent.ts's next onCheckpoint write snapshots the live (redacted)
 * messages, so the placeholder replaces the wrapper in that agent_runs.checkpoint
 * row (DbNull'd at finalize; no audit/guard consumer reads it). But when the
 * stored wrapper is reloaded as MODEL CONTEXT it teaches models the exact
 * chrome the guard forbids — two
 * sessions were flagged for forged harness markers within ~11h (b92ef13f run
 * d7aaa3cb, a8976e11 run 232b1454; ticket 9975b1f2).
 *
 * This module is the read-side filter: at the points where stored messages
 * become model input (context.service loadChatContext/loadSessionContext,
 * run-executor's history load + resume checkpoint), guard-wrapped ASSISTANT
 * messages are swapped for a neutral one-line placeholder, and annotate-lane
 * trailing chrome (a verification footer/note appended to a normal answer) is
 * stripped. The run-executor's unfinished-work backstop note ("⏳ HARNESS
 * NOTE:…") is NOT chrome: it persists AFTER everything else (annotate-lane
 * footers and a replace-lane wrapper alike — executor persist order is the
 * footers then the note), so BOTH lanes below treat it as TRANSPARENT — kept
 * intact, chrome blocks before it still strip, and a banner-lane placeholder
 * keeps it riding along (review F1; banner-lane drop fixed in ticket
 * 8292830e). Pure, idempotent, no I/O.
 * There is NO structured DB flag on these
 * messages — content-pattern detection is the only option, and both writers
 * ALWAYS put their banner at content position 0.
 *
 * Kill switch (default ON): GUARD_CHROME_REDACT='0'|'false' → exact passthrough.
 * Checked at call time, matching the codebase's inline env-flag idiom
 * (worker.ts's *_DISABLED === '1' checks).
 */

// The supervisor harness appendix shape (pure leaf; its only import is the import-free executed-actions parser).
import { isHarnessAppendixBlock, supervisorHarnessReceiptsDisabled } from './platform/harness-receipts';
import { stripNoActionToolNote } from './chat-agent/no-action-note';
import { stripUnreadStateNote } from './chat-agent/unread-state-note';

// ── Detection patterns ─────────────────────────────────────────────────────

/**
 * Replace-lane banner prefixes (note the em-dash). Coding lane:
 * "[HARNESS EVIDENCE GUARD — THIS RUN'S FINAL ANSWER WAS REPLACED]" +
 * "--- BEGIN/END UNVERIFIED RUN OUTPUT" fences. Plain-chat lane:
 * "[ACTION VERIFIER — THIS RUN'S FINAL NOTE WAS REPLACED BEFORE DELIVERY]" +
 * "--- BEGIN/END STRUCK NOTE" fences. Matching the PREFIX (not the full
 * banner) also catches future banner variants — anything harness-authored in
 * these two namespaces is forbidden model-context material either way.
 */
const EVIDENCE_GUARD_BANNER_PREFIX = '[HARNESS EVIDENCE GUARD —';
const ACTION_VERIFIER_BANNER_PREFIX = '[ACTION VERIFIER —';

/**
 * Exact first-line headers of the notes the ANNOTATE lane appends to an
 * answer that stays delivered (applyCompletionClaimGuard notes — the
 * run-executor's `guarded.finalText !== result.finalText` fallback persists
 * original + '\n\n' + note into stored content). The replace lane is covered
 * by the banner prefixes above; these are the shapes that land WITHOUT a
 * banner at position 0. Matching is FIRST-LINE-only — the note body is
 * accepted unchecked, asymmetric with the footers' all-'• ' strictness below
 * (accepted risk, review F3): these headers are harness-specific enough that a
 * model paragraph opening with one verbatim is itself chrome mimicry, and a
 * false strip hides one paragraph rather than teaching the guard's format.
 */
const TRAILING_NOTE_HEADERS: readonly string[] = [
  '[HARNESS EVIDENCE GUARD]',                                    // renderEvidenceGuardNote (guard 1)
  '[HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER]',            // guard 0
  '[HARNESS EVIDENCE GUARD — FORGED RECEIPT CITATION]',          // guard 0b
  '[HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS]',              // guard 3
  '[HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT]',         // guard 4 (renderQuotedOutputNote)
  '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK VERIFIED]',            // claims-block lane (audit #6) — renderClaimsBlockVerifiedNote
  '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]',          // claims-block lane — renderClaimsBlockUnverifiedNote
  '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK MALFORMED]',           // claims-block lane — renderClaimsBlockMalformedNote
  '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]',                 // action-verifier observe-only lane (audit 2026-10-08 W1-4) — renderObserveOnlyAnnotation
];

/**
 * The guard-2/2b verification footers (renderVerificationFooter /
 * renderPushVerificationFooter): an optional '---' separator line, this
 * header, then only '• '-bulleted verdict lines.
 */
const TRAILING_FOOTER_HEADERS: readonly string[] = [
  '🔍 Harness claim verification (verified-at',
  '🔍 Harness push-claim verification (commits API):',
];

/**
 * The unfinished-work backstop note (built at run-executor.ts:786, appended
 * :814 — AFTER any annotate-lane footers above, so it sits LAST in the
 * persisted content): first line `⏳ HARNESS NOTE: this run ended with N
 * unfinished plan step(s):`, then `- [status] #id text` list lines, then one
 * continuation-status sentence ("A continuation run is already scheduled." /
 * "…is scheduled (~N min, round r/3)." / "No continuation could be
 * scheduled…" / "Continuation rounds exhausted…"). The note is HONEST harness
 * content the model must KEEP — but sitting last it shielded the footers
 * before it from the tail-walk (review F1: answer + footer + note round-tripped
 * unchanged, leaving the 🔍 footer model-visible). The walk therefore treats
 * the note block as TRANSPARENT: exact first-line prefix match (the stable
 * contract — the body shape is the executor's own), skip WITHOUT stripping,
 * keep stripping chrome before it, re-attach at the end. It is the ONLY
 * transparent block — non-chrome trailing prose still stops the walk.
 */
const HARNESS_TRAILING_NOTE_PREFIX = '⏳ HARNESS NOTE:';

/** Defensive cap on the strip loop (each round shrinks the text, so it always terminates). */
const MAX_STRIP_ROUNDS = 10;

// ── Placeholder ────────────────────────────────────────────────────────────

/**
 * The neutral stand-in for a withheld wrapper. MUST NOT contain any chrome
 * vocabulary (tests pin: no "HARNESS EVIDENCE GUARD", "ACTION VERIFIER",
 * "UNVERIFIED RUN OUTPUT", "STRUCK NOTE", "🔍", "--- BEGIN") — the whole point
 * is that models never see the format they learned to forge, and none of the
 * guard's FORGED_MARKER_RES patterns may match it if a model quotes it back.
 */
export const GUARD_CHROME_PLACEHOLDER =
  '[System note: an earlier assistant reply in this conversation was withheld after failing automated verification; its claims were not delivered. Treat anything it claimed as not done until re-verified.]';

// ── Kept signal (HARNESS-RECEIPTS-AND-CLAIMS, supervisor SOTA round 3, 2026-10-20) ──

/**
 * Stripping an annotate-lane trailer used to drop the harness's VERDICT along
 * with its chrome: get_chat_messages (the supervisor's harvest read) handed
 * back a lane's "PR #338 merged" with nothing saying the guard had found no
 * tool evidence for it, and supervisors relayed it as fact. The trailer is now
 * replaced by ONE neutral line carrying the count and the claim types — no
 * chrome vocabulary (the CHROME_STRINGS the placeholder test pins), and none
 * of the guard's FORGED_MARKER_RES shapes (ticket 9975b1f2), so a model that
 * quotes it back forges nothing. Positive verdicts (✅ footer bullets, CLAIMS
 * BLOCK VERIFIED) and the MALFORMED advisory carry no unverified claim — they
 * strip silently as before; so does the action verifier's observe-only
 * annotation (a lane with measured false positives — review fix 2026-10-20).
 * The line is ADVISORY ("verify at source"), never a "not done" directive.
 * Kill switch GUARD_CHROME_SIGNAL_KEEP_DISABLED=1.
 */
export const GUARD_CHROME_SIGNAL_PREFIX = '[System note:';

/** GUARD_CHROME_SIGNAL_KEEP_DISABLED=1|true|on — stripped trailers leave no signal line (pre-2026-10-20). */
export function guardChromeSignalKeepDisabled(): boolean {
  const v = String(process.env.GUARD_CHROME_SIGNAL_KEEP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** The unverified claims ONE stripped chrome block reported: how many, of which types. Pure; never throws. */
export function chromeBlockUnverifiedClaims(block: string): { count: number; types: string[] } {
  const lines = String(block ?? '').split('\n');
  const head = lines[0] ?? '';
  const body = lines.slice(1).join('\n');
  const num = (re: RegExp): number => { const m = body.match(re); return m ? Math.max(0, Number(m[1]) || 0) : 0; };
  if (head === '[HARNESS EVIDENCE GUARD]') {
    // "asserts external completions (pr_merged: 2, commit_pushed: 1) that are UNVERIFIED"
    const m = body.match(/external completions \(([^)]*)\)/);
    const types: string[] = [];
    let count = 0;
    for (const part of (m?.[1] ?? '').split(',')) {
      const kv = part.trim().match(/^([a-z_]+):\s*(\d+)$/);
      if (kv) { types.push(kv[1]); count += Number(kv[2]) || 0; }
    }
    return count ? { count, types } : { count: 1, types: ['completion'] };
  }
  if (head === '[HARNESS EVIDENCE GUARD — FORGED HARNESS MARKER]') return { count: 1, types: ['forged_marker'] };
  if (head === '[HARNESS EVIDENCE GUARD — FORGED RECEIPT CITATION]') {
    const ids = (body.match(/does NOT contain: ([^\n]*?)\.?$/m)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return { count: Math.max(1, ids.length), types: ['receipt_citation'] };
  }
  if (head === '[HARNESS EVIDENCE GUARD — FUTURE-DATED CLAIMS]') return { count: Math.max(1, num(/^(\d+) line\(s\)/m)), types: ['future_dated'] };
  if (head === '[HARNESS EVIDENCE GUARD — UNVERIFIED QUOTED OUTPUT]') return { count: Math.max(1, num(/^(\d+) quoted block\(s\)/m)), types: ['quoted_output'] };
  if (head === '[HARNESS EVIDENCE GUARD — CLAIMS BLOCK UNVERIFIED]') return { count: Math.max(1, num(/asserts (\d+) claim\(s\)/)), types: ['claims_block'] };
  // The action verifier's OBSERVE-ONLY annotation is NOT counted (review fix 2026-10-20): that lane is
  // observe-only BECAUSE of measured false positives (gate flip 2026-09-11 — its citation miner struck
  // real lane messages), and this line reaches the lane's OWN next-run history — a mis-mined annotation
  // must never read as "your merge did not happen" and drive a duplicate push / PR.
  if (head === '[ACTION VERIFIER — OBSERVE-ONLY ANNOTATION]') return { count: 0, types: [] };
  // Verification footers: the bullets that are NOT a ✅ verdict.
  const footerStart = head === '---' ? 1 : 0;
  const footerHead = lines[footerStart] ?? '';
  const footerType = footerHead.startsWith('🔍 Harness claim verification') ? 'pr' : footerHead.startsWith('🔍 Harness push-claim verification') ? 'commit_pushed' : null;
  if (footerType) {
    const bad = lines.slice(footerStart + 1).filter((l) => l.startsWith('• ') && !l.includes('✅')).length;
    return bad ? { count: bad, types: [footerType] } : { count: 0, types: [] };
  }
  return { count: 0, types: [] }; // VERIFIED / MALFORMED / unknown: no unverified claim
}

/** The ONE neutral line a stripped trailer leaves behind ('' when it reported no unverified claim). Pure. */
export function guardChromeSignalLine(blocks: string[]): string {
  let count = 0;
  const types: string[] = [];
  for (const b of blocks) {
    const r = chromeBlockUnverifiedClaims(b);
    count += r.count;
    for (const t of r.types) if (!types.includes(t)) types.push(t);
  }
  if (!count) return '';
  // ADVISORY wording (review fix 2026-10-20): the annotate lanes are observe-only checks, not convictions —
  // the line says what the harness could not match and asks for a check at source, never "treat as not done"
  // (a lane reading its own history must not redo real work on a mis-match).
  return `${GUARD_CHROME_SIGNAL_PREFIX} the harness could not match tool evidence for ${count} claim(s) in this reply (types: ${types.slice(0, 6).join(', ')}); verify them at source before relying on or relaying them.]`;
}

// ── Kill switch ────────────────────────────────────────────────────────────

/** Default ON; disabled when GUARD_CHROME_REDACT is '0' or 'false' (case-insensitive, trimmed). */
export function guardChromeRedactEnabled(): boolean {
  const v = (process.env.GUARD_CHROME_REDACT ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

// ── Internals ──────────────────────────────────────────────────────────────

/**
 * Is this whole paragraph block (no blank lines inside) a harness note/footer?
 * Notes: exact first-line header (the body is harness-authored single lines).
 * Footers: optional '---' lead line, the footer header, then ONLY '• ' bullets
 * — strict so a model quoting a footer inline never gets its prose eaten.
 */
function isGuardChromeBlock(block: string): boolean {
  const lines = block.split('\n');
  if (TRAILING_NOTE_HEADERS.includes(lines[0])) return true;
  const footerStart = lines[0] === '---' ? 1 : 0;
  const header = lines[footerStart];
  if (header && TRAILING_FOOTER_HEADERS.some((h) => header.startsWith(h))) {
    return lines.slice(footerStart + 1).every((l) => l.startsWith('• '));
  }
  return false;
}

/**
 * Is this paragraph the backstop note? First-line prefix only — the block's
 * remaining lines (step list + continuation sentence) ride along, so
 * transparency spans the WHOLE note block. `startsWith` on the block equals
 * "first line starts with" (the prefix contains no newline). Deliberately NOT
 * part of isGuardChromeBlock: the note is never STRIPPED.
 */
function isHarnessTrailingNoteBlock(block: string): boolean {
  return block.startsWith(HARNESS_TRAILING_NOTE_PREFIX);
}

/**
 * HARNESS-RECEIPTS review fix (2026-10-20): the supervisor wake's harness
 * appendix ('ACTIONS TAKEN (harness):' / 'WAKE: no-op (harness: …' /
 * 'WAKE: reported (harness: …' / 'Reported up (harness):' / 'Not executed
 * (harness):' / 'Harness record: …' — platform/harness-receipts) is appended
 * at the chat finalize AFTER every annotate-lane trailer, i.e. on the tail of
 * the persisted note. Like the backstop note it is honest harness content the
 * model must KEEP, so it is TRANSPARENT to the tail walk: without this the
 * walk stopped at it and the claims-lane / evidence-guard chrome before it
 * stayed model-visible (the ticket 9975b1f2 / ac835c00 exposure) and the kept
 * signal line never fired on a supervisor note. The model's own copies of
 * these lines are stripped at the finalize, and chrome only ever follows the
 * model's text, so a transparent tail cannot shield model-placed chrome.
 */
function isTransparentTrailingBlock(block: string): boolean {
  // SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1 (the feature's kill switch) restores the pre-2026-10-20 walk.
  return isHarnessTrailingNoteBlock(block) || (!supervisorHarnessReceiptsDisabled() && isHarnessAppendixBlock(block));
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Redact guard chrome from one ASSISTANT message's content (the role gate
 * lives in redactGuardChromeMessage — callers with a role use that):
 *  0. Detach any trailing backstop notes (⏳ HARNESS NOTE:…) FIRST — the
 *     executor persists the note last in every shape (after annotate-lane
 *     footers AND after a replace-lane wrapper), so it always sits on the
 *     tail, and BOTH lanes re-attach it to their result (review F1; the
 *     banner lane dropping it was ticket 8292830e follow-up 1).
 *  1. Banner at trimmed-position-0 → the WHOLE (note-less) content is a
 *     replace-lane wrapper; swap for the placeholder + re-attached notes.
 *  2. Otherwise strip trailing annotate-lane blocks (note/footer paragraphs
 *     the guard appended to the delivered answer); if nothing but chrome
 *     remains, the placeholder. Footers before a detached note still strip,
 *     and when the remainder collapses to the placeholder the note rides
 *     along after it.
 *  3. Anything else → the input byte-identical (same string reference), one
 *     narrow exception: with a note detached and re-attached, whitespace
 *     AROUND the note normalizes to the executor's own '\n\n' persist shape
 *     (only non-executor shapes — e.g. stray trailing spaces after the note —
 *     ever differ, and only by that whitespace).
 * Idempotent: the placeholder and already-stripped text match no pattern.
 */
export function redactGuardChrome(content: string): string {
  if (!guardChromeRedactEnabled()) return content;
  if (!content) return content;
  // FSN1021 review round 4: the harness's no-action line is never the model's own words, wherever it sits —
  // a KPI reply footer appended after it would stop the trailing walk below. Standalone lines only; content
  // without the line returns as the same string.
  // NOT behind SUPERVISOR_NO_ACTION_NOTE_DISABLED: after a rollback the stored lines must still never reach the model.
  content = stripNoActionToolNote(content);
  // 2026-10-22: the same for the owner-turn unread-state line (chat-agent/unread-state-note.ts) — NOT behind
  // SUPERVISOR_OWNER_STATE_READ_RETRY_DISABLED for the same reason.
  content = stripUnreadStateNote(content);
  if (!content) return content;

  // Step 0 — detach trailing backstop notes BEFORE both lanes. Review F1: they
  // persist after the annotate footers (run-executor.ts:786,:814), so a note on
  // the tail would otherwise stop the strip walk at the first non-chrome block
  // and leave the 🔍 footer model-visible. Ticket 8292830e: the note ALSO
  // persists after a replace-lane wrapper, and running the banner check first
  // dropped it (bare placeholder) — the note is honest harness content the
  // model must KEEP. Kept in original order, re-attached to whatever the lane
  // returns. The note and the supervisor harness appendix (2026-10-20,
  // isTransparentTrailingBlock) are the ONLY transparent blocks — non-chrome
  // trailing prose still stops the walk below (no prose-eating).
  let text = content;
  const transparentNotes: string[] = [];
  for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
    const candidate = text.replace(/\s+$/, '');
    if (!candidate) break;
    const sep = candidate.lastIndexOf('\n\n');
    if (sep === -1) break;
    if (!isTransparentTrailingBlock(candidate.slice(sep + 2))) break;
    transparentNotes.unshift(candidate.slice(sep + 2));
    text = candidate.slice(0, sep);
  }
  // No note matched → text is still the untouched input (the loop only
  // reassigns text after a match), so note-free content flows through
  // byte-identical.
  const reattachNotes = (base: string): string =>
    transparentNotes.length ? `${base}\n\n${transparentNotes.join('\n\n')}` : base;

  // Step 1 — replace lane: banner at trimmed-position-0 of the note-less
  // remainder → swap the whole thing for the placeholder, notes re-attached.
  const leadTrimmed = text.trimStart();
  if (leadTrimmed.startsWith(EVIDENCE_GUARD_BANNER_PREFIX) || leadTrimmed.startsWith(ACTION_VERIFIER_BANNER_PREFIX)) {
    return reattachNotes(GUARD_CHROME_PLACEHOLDER);
  }

  // Step 2 — annotate-lane trailing chrome. Only COMMIT a right-trim when a
  // block actually matched — untouched content returns byte-identical.
  // 2026-10-20 (HARNESS-RECEIPTS-AND-CLAIMS): the stripped blocks are kept
  // aside so their verdict survives as ONE neutral signal line.
  const strippedBlocks: string[] = [];
  for (let round = 0; round < MAX_STRIP_ROUNDS; round++) {
    const candidate = text.replace(/\s+$/, '');
    if (!candidate) text = ''; // whitespace only — never chrome, but never useful either; collapses below
    else if (isGuardChromeBlock(candidate)) { strippedBlocks.unshift(candidate); text = ''; } // the whole remainder is a note/footer
    else {
      const sep = candidate.lastIndexOf('\n\n');
      if (sep === -1) break;
      if (!isGuardChromeBlock(candidate.slice(sep + 2))) break;
      strippedBlocks.unshift(candidate.slice(sep + 2));
      text = candidate.slice(0, sep);
      continue;
    }
    if (!text) return reattachNotes(GUARD_CHROME_PLACEHOLDER);
  }
  const signal = strippedBlocks.length && !guardChromeSignalKeepDisabled() ? guardChromeSignalLine(strippedBlocks) : '';
  return reattachNotes(signal ? `${text}\n\n${signal}` : text);
}

/**
 * Role-gated message redaction: ONLY assistant messages are redacted — a user
 * could paste banner text (and the action-verifier's in-thread correction is a
 * DELIBERATE user-role harness message the next wake must see). Non-string
 * content (multimodal arrays, null tool-call bodies) passes through. Returns
 * the SAME object when nothing changed; a shallow copy with redacted content
 * otherwise — stored row objects are never mutated.
 */
export function redactGuardChromeMessage<T extends { role?: unknown; content?: unknown }>(msg: T): T {
  if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;
  const redacted = redactGuardChrome(msg.content);
  return redacted === msg.content ? msg : { ...msg, content: redacted };
}

/**
 * Checkpoint-transcript redaction (resume path): a run's durable checkpoint
 * snapshots the live transcript — including history loaded BEFORE this filter
 * existed — and agent.ts replays it straight into model context on resume,
 * bypassing the history load. Redact the messages of a resuming checkpoint
 * the same way. Identity-preserving: when no message changed, the SAME
 * checkpoint object comes back (callers/tests relying on reference equality
 * are unaffected); a shallow copy with a new messages array when any did.
 */
export function redactGuardChromeCheckpoint<T extends { messages?: unknown }>(checkpoint: T): T {
  const msgs = checkpoint?.messages;
  if (!Array.isArray(msgs)) return checkpoint;
  let changed = false;
  const redacted = msgs.map((m) => {
    const r = redactGuardChromeMessage(m);
    if (r !== m) changed = true;
    return r;
  });
  return changed ? { ...checkpoint, messages: redacted } : checkpoint;
}
