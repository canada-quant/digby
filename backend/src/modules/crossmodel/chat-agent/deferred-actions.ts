/**
 * Deferred-action receipts (remediation P2 spark G8 — the 2026-09-08 ~21:00Z
 * incident): the supervisor's wake note said the cutover "runs next wake",
 * armed NO once-schedule and sent NO message to the target lane — the deferral
 * lived only in prose, prose gets compacted away, and the cutover never ran
 * while five later sweeps reported "nothing needs the owner".
 *
 * The doctrine already says a deferred action is armed THIS wake as a one-shot
 * schedule (supervisor.service prompt, "A DEFERRED action … is armed THIS
 * wake"). This module is the HARNESS backstop: pure detectors over the final
 * note + the run's tool-call parts, consumed by chat-agent.service's
 * supervisor machine-wake finalize. Gate flip 2026-09-11 (owner: full steam):
 * OBSERVE-ONLY — a deferral idiom with NO armed once-schedule and NO lane
 * message now records loop metric supervisor_deferral_unarmed + a one-line
 * transcript note; it no longer auto-arms the +15 min self-schedule (that
 * arm added +16% supervisor wakes and self-perpetuated on its own STANDING
 * DOWN notes). deferredActionPrompt is retained for forensics/revert; if the
 * arm is ever restored, first tighten DEFERRAL_IDIOM_RE to skip
 * 'standing down'/'executed'/'RESOLVED' lines and dedupe on the prior wake.
 *
 * Ticket fcee0741 (2026-10-06, lane-filed): the metric had eroded to ~100%
 * false positives (58 rows / 48 h) on routine armed-cadence lines — "**Next
 * sweep:** 21:47Z (schedule 53f68b62).", "(firing 14/500, sched d72b394a)",
 * "**Open threads for next sweep:** (1) …". Two exemptions now apply:
 *  (a) a line that itself CITES a schedule id ("schedule|sched <8+ hex>") is an
 *      ARMED deferral — the durable scheduler holds it. The finalize seam
 *      resolves the id against the chat's own schedules (a cited own row that
 *      is DISABLED arms nothing) and otherwise accepts the citation (e.g. a
 *      lane's schedule named by its supervisor);
 *  (b) a bare "next sweep / wake / run" NOUN PHRASE — a label ("Next sweep:",
 *      "Open threads for next sweep:"), a clause-leading announcement with a
 *      time ("next wake 23:43", "Next sweep at 21:47Z") or a markdown heading —
 *      is a cadence announcement, not a deferral. A commitment still counts:
 *      "the swap runs next wake", "my next sweep re-checks …", "I'll … next
 *      sweep:", "will re-check at …", "queued for the next sweep".
 * Kill switch for both: DEFERRAL_CADENCE_EXEMPT_DISABLED=1 (the pre-fcee0741
 * detector, byte-for-byte).
 */

/** Marker leading every auto-armed follow-up prompt (dedupe + forensics). */
export const DEFERRED_ACTION_MARKER = '[deferred-action follow-up — auto-armed by the harness]';

/** Deferral idioms — a commitment to act LATER, in prose. Deliberately narrow:
 *  reporting past work ("verified", "queued at 3pm and completed") must not trip. */
export const DEFERRAL_IDIOM_RE =
  /\b(next (wake|sweep|run)|on the next (wake|sweep|run)|will (verify|check|confirm|re-?check|re-?arm|follow[- ]?up|revisit|swap|cut ?over|dispatch|monitor)|queued for (later|the next)|after the (bench|cap reset|window|deploy|owner)|check(ing)? back (later|tomorrow|in the morning)|re-?arm after|deferred (to|until)|later this (run|day|week)|pending the next)\b/i;

/**
 * First line of the note carrying a deferral idiom (clipped) — the auto-armed
 * schedule quotes it so the woken run knows exactly what it deferred. Null
 * when the note defers nothing. Pure.
 */
export function findDeferralLine(finalText: string, clip = 240): string | null {
  for (const raw of String(finalText ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[')) continue; // harness chrome / markers are not the model's commitments
    if (textDefers(line)) return clipLine(line, clip);
  }
  return null;
}

const clipLine = (line: string, clip: number): string => (line.length <= clip ? line : line.slice(0, clip - 1) + '…');

// ── Ticket fcee0741: cadence announcements + cited schedules ─────────────────

/** DEFERRAL_CADENCE_EXEMPT_DISABLED=1 restores the pre-fcee0741 detector (no noun-phrase / cited-schedule exemption). */
export function deferralCadenceExemptDisabled(): boolean {
  return process.env.DEFERRAL_CADENCE_EXEMPT_DISABLED === '1';
}

/** "schedule 53f68b62", "sched d72b394a", "schedule id: 53f68b62", "(schedule `53f68b62-…`)" — group 1 = the hex id (≥ 8). */
const CITED_SCHEDULE_RE = /\bsched(?:ule)?\b[\s:#=`'"(]*(?:id\b[\s:#=`'"]*)?([0-9a-f]{8,})\b/gi;

/** The schedule ids (lowercased 8-char prefixes, deduped, ≤ 3) a line itself cites. Pure. */
export function citedScheduleIds(line: string): string[] {
  const out: string[] = [];
  const re = new RegExp(CITED_SCHEDULE_RE.source, CITED_SCHEDULE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(line ?? '')))) {
    const id = m[1].toLowerCase().slice(0, 8);
    if (!out.includes(id)) out.push(id);
    if (out.length >= 3) break;
  }
  return out;
}

/** The "next wake / sweep / run" occurrences the idiom matches (with an optional leading "on the"). */
const NEXT_CADENCE_SRC = String.raw`\b(?:on the )?next (?:wake|sweep|run)\b`;
/** Label form: the phrase is followed (past markdown closers) by a colon — "Next sweep:", "for next sweep:**". */
const LABEL_AFTER_RE = /^[*_`)\]]*\s*[:：]/;
/** A label's head inside its clause: markdown, then nothing, ONE word ("Watching", "Also"), or ≤ 3 words closed by a
 *  preposition ("Open threads for", "Items due by the") — never a verb phrase ("The swap runs next wake:" stays a commitment). */
const LABEL_HEAD_RE = /^[\s\-*_#>|•·(\[`]*(?:[\p{L}\p{N}'’/&-]+\s+|(?:[\p{L}\p{N}'’/&-]+\s+){0,3}(?:for|on|at|by|before|until|in)\s+(?:(?:the|my|our)\s+)?)?$/iu;
/** Announcement form: a time — "21:47Z", "at 22:00Z", "(23:35Z future)", "~07:45Z", an ISO stamp, "in 2h". */
const TIME_AFTER_RE = /^[*_`)\]]*\s*\(?\s*(?:(?:at|@|is|due|around|~|≈|=)\s*)?~?\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?|\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:Z|UTC|[AP]M))?|in\s+~?\d+\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?))\b/i;
/** …and nothing after the time but a parenthetical / markdown / "future" / a timezone — a verb after it
 *  ("next wake 22:00Z, then the swap runs") keeps the clause a commitment. */
const TIME_TAIL_RE = /^\s*(?:\([^)]*\)|\[[^\]]*\]|[*_`)\]]+|\b(?:future|planned|scheduled|UTC|PDT|PST|EDT|EST)\b|\s)*$/i;
/** All an announcement's clause may hold before the phrase: bullets / markdown / one possessive or article. */
const CLAUSE_LEAD_RE = /^[\s\-*_#>|•·(\[`]*(?:(?:my|our|the|a)\s+)?$/i;
/** A state-until announcement ("idle until next wake 17:54Z") or a lane label ("FO next wake 02:32Z"). */
const STATUS_HEAD_RE = /^[\s\-*_#>|•·(\[`]*(?:(?:idle|asleep|sleeping|parked|waiting|quiet|dormant|paused|scheduled)\s+(?:until|till)|(?:[A-Z0-9]{2,}[A-Za-z0-9_-]{0,14}|[A-Za-z_-]{0,8}\d[A-Za-z0-9_-]{0,14})(?:\s+(?:watch|lane))?)\s+$/;
/** A noun phrase naming what is carried FOR the next pass: "Carried for next sweep", "Items for the next run". */
const FOR_HEAD_RE = /^[\s\-*_#>|•·(\[`]*(?:[\p{L}\p{N}'’/-]+\s+){1,3}for\s+(?:(?:the|my|our)\s+)?$/iu;
/** Another actor's cadence — "the lane's next run", "its next wake", "their next sweep" — is not this chat's deferral. */
const THIRD_PARTY_POSSESSIVE_RE = /(?:^|[\s(*_`])(its|their|[\p{L}\p{N}_-]+['’]s)\s+$/iu;
/** Contractions that look like possessives but carry a commitment ("it's next wake", "that's next sweep's job"). */
const NOT_POSSESSIVE = new Set(["it's", 'it’s', "that's", 'that’s', "what's", 'what’s', "here's", 'here’s', "there's", 'there’s', "who's", 'who’s', "he's", 'he’s', "she's", 'she’s', "let's", 'let’s']);
/** Clause breaks before the phrase (sentence ends, ; : , — – | ( and newlines). */
const CLAUSE_BREAK_CHARS = '.!?;:,—–|(\n';
/** Breaks that open a CELL / parenthetical / line, where a bare phrase is a noun phrase ("| Next sweep |", "(next wake)"). */
const CELL_BREAK_CHARS = '|(\n';
/** A phrase governed by a deferral verb is a commitment, never a label ("queued for the next sweep:"). */
const GOVERNED_BEFORE_RE = /(?:queued for the|pending the)\s+$/i;
/** A first-person commitment in the clause keeps the phrase a deferral ("Next sweep: I'll retire the lane"). */
const FIRST_PERSON_COMMITMENT_RE = /\b(?:I|we)\s+(?:will|shall)\b|\b(?:I|we)['’]ll\b|\b(?:I|we)\s+(?:am|are)\s+going to\b/i;

/** The clause around [start,end): text from the last clause break (and that break, '' = line start) to the next sentence break. */
function clauseAround(text: string, start: number, end: number): { before: string; after: string; breakChar: string } {
  let from = 0;
  let breakChar = '';
  for (let i = start - 1; i >= 0; i--) {
    if (CLAUSE_BREAK_CHARS.includes(text[i])) { from = i + 1; breakChar = text[i]; break; }
  }
  const rest = text.slice(end);
  const stop = rest.search(/[.!?;|\n]|\s[—–]\s/);
  return { before: text.slice(from, start), after: stop === -1 ? rest : rest.slice(0, stop), breakChar };
}

/**
 * Is this "next wake / sweep / run" occurrence a cadence NOUN PHRASE rather
 * than a commitment? Yes for: a markdown heading; the bare phrase as a whole
 * line / table cell / parenthetical ("| Next sweep |"); a short label followed
 * by a colon ("**Next sweep:** 21:47Z", "Open threads for next sweep:");
 * "<what> for next sweep" closing its clause ("Carried for next sweep");
 * another actor's cadence ("the lane's next run"); an announcement whose clause
 * is just a time ("next wake 23:43", "idle until next wake 17:54Z future", "FO
 * next wake 02:32Z"). Never when a deferral verb governs it ("queued for the
 * next sweep") or the clause carries a first-person commitment ("I'll … next
 * sweep"). Everything else — "the swap runs next wake", "my next sweep
 * re-checks …", "triage next sweep", "…, next sweep." — stays a commitment. Pure.
 */
function isCadenceNounPhrase(text: string, start: number, end: number, heading: boolean): boolean {
  if (GOVERNED_BEFORE_RE.test(text.slice(0, start))) return false;
  const clause = clauseAround(text, start, end);
  if (FIRST_PERSON_COMMITMENT_RE.test(`${clause.before} ${clause.after}`)) return false;
  if (heading) return true;
  const lead = CLAUSE_LEAD_RE.test(clause.before);
  const bareAfter = /^[\s*_`)\]]*$/.test(clause.after);
  if (lead && bareAfter && (clause.breakChar === '' || CELL_BREAK_CHARS.includes(clause.breakChar))) return true;
  if (bareAfter && FOR_HEAD_RE.test(clause.before)) return true;
  if (LABEL_AFTER_RE.test(text.slice(end)) && LABEL_HEAD_RE.test(clause.before)) return true;
  const poss = THIRD_PARTY_POSSESSIVE_RE.exec(clause.before);
  if (poss && !NOT_POSSESSIVE.has(poss[1].toLowerCase())) return true;
  if (!lead && !STATUS_HEAD_RE.test(clause.before)) return false;
  const time = TIME_AFTER_RE.exec(clause.after);
  return !!time && TIME_TAIL_RE.test(clause.after.slice(time[0].length));
}

/**
 * Does `text` carry a deferral COMMITMENT? DEFERRAL_IDIOM_RE, after blanking
 * every "next wake/sweep/run" occurrence that is a cadence noun phrase (ticket
 * fcee0741). Under DEFERRAL_CADENCE_EXEMPT_DISABLED=1 it is DEFERRAL_IDIOM_RE
 * alone (the pre-fcee0741 test). Pure.
 */
export function textDefers(text: string): boolean {
  const t = String(text ?? '');
  if (!DEFERRAL_IDIOM_RE.test(t)) return false;
  if (deferralCadenceExemptDisabled()) return true;
  const heading = /^\s*#{1,6}\s/.test(t);
  const re = new RegExp(NEXT_CADENCE_SRC, 'gi');
  let residual = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isCadenceNounPhrase(t, start, end, heading)) continue;
    residual += t.slice(last, start) + ' '.repeat(end - start);
    last = end;
  }
  residual += t.slice(last);
  return DEFERRAL_IDIOM_RE.test(residual);
}

/** Tool names whose call means the run ARMED a follow-up itself. */
const SCHEDULE_ARM_TOOLS = new Set(['schedule_message', 'schedule_self']);
/** Tool names whose call means the run already engaged the target lane. */
const LANE_MESSAGE_TOOLS = new Set(['send_chat_message', 'send_to_instance', 'start_coding_session']);

type PartLike = { type?: string; name?: string } | null | undefined;

/** True when the run's parts show a schedule arm (any schedule_message/schedule_self call). Pure. */
export function runArmedSchedule(parts: unknown): boolean {
  return Array.isArray(parts)
    && parts.some((p: PartLike) => p?.type === 'tool_call' && SCHEDULE_ARM_TOOLS.has(String(p?.name)));
}

/** True when the run's parts show a message/dispatch to another lane. Pure. */
export function runSentLaneMessage(parts: unknown): boolean {
  return Array.isArray(parts)
    && parts.some((p: PartLike) => p?.type === 'tool_call' && LANE_MESSAGE_TOOLS.has(String(p?.name)));
}

export interface DeferredActionVerdict {
  /** The deferral line that needs a receipt, or null when nothing to do. */
  deferralLine: string | null;
  /** The CLAUSE of that line carrying the deferral idiom (audit 2026-10-06 T8-9) — what the note quotes. */
  deferralClause?: string | null;
  /** Ticket fcee0741: the first deferral line ARMED by its own schedule citation (clipped) — the caller resolves it. */
  citedLine?: string | null;
  /** …and the schedule ids (8-char prefixes) that line cites. */
  citedScheduleIds?: string[];
}

/**
 * audit 2026-10-06 T8-9 (schooltime F8, others F17): the observe-only note fired 191 times in 7 days, mostly false —
 * (a) "next sweep 08:19Z backstops" while the chat HAS an enabled recurring sweep (the deferral is armed: that sweep
 * wakes it), yet the note told the model to "arm a schedule_message yourself"; (b) it quoted the line HEAD ("Fresh
 * probe at 22:56Z…"), not the deferral clause. Now the caller suppresses the note (telemetry kind
 * supervisor_deferral_covered instead) when an enabled recurring schedule exists on the chat, and quotes the clause.
 * DEFERRAL_NOTE_PRECISION_DISABLED=1 restores the line-head quote and the note regardless of schedules.
 */
export function deferralNotePrecisionDisabled(): boolean {
  return process.env.DEFERRAL_NOTE_PRECISION_DISABLED === '1';
}

/** The clause of `line` that carries the deferral idiom (sentence / ';' / dash / pipe boundaries), clipped. Pure. */
export function findDeferralClause(line: string, clip = 160): string | null {
  const text = String(line ?? '').trim();
  if (!text) return null;
  const clauses = text.split(/(?<=[.!?;])\s+|\s+[—–]\s+|\s+-\s+|\s*\|\s*/).map((c) => c.trim()).filter(Boolean);
  // fcee0741: prefer the clause carrying a COMMITMENT over a cadence label in the same line.
  const hit = clauses.find((c) => textDefers(c)) ?? clauses.find((c) => DEFERRAL_IDIOM_RE.test(c)) ?? null;
  if (!hit) return null;
  return hit.length <= clip ? hit : hit.slice(0, clip - 1) + '…';
}

/**
 * Should the harness auto-arm a deferred-action follow-up for this finalized
 * supervisor machine wake? Yes iff the note carries a deferral idiom AND the
 * run neither armed a schedule nor messaged/dispatched a lane. Pure.
 */
export function detectUnarmedDeferral(finalText: string, parts: unknown): DeferredActionVerdict {
  if (deferralCadenceExemptDisabled()) {
    const line = findDeferralLine(finalText);
    if (!line) return { deferralLine: null };
    if (runArmedSchedule(parts) || runSentLaneMessage(parts)) return { deferralLine: null };
    return { deferralLine: line, deferralClause: findDeferralClause(line) };
  }
  // Ticket fcee0741: cadence noun phrases are not deferrals (textDefers), and a
  // line citing a schedule id is ARMED by that citation — keep scanning for an
  // uncited commitment; report the first cited line so the caller can resolve it.
  let cited: { line: string; ids: string[] } | null = null;
  let unarmed: string | null = null;
  for (const raw of String(finalText ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('[')) continue; // harness chrome / markers are not the model's commitments
    if (!textDefers(line)) continue;
    const ids = citedScheduleIds(line);
    if (ids.length) { if (!cited) cited = { line: clipLine(line, 240), ids }; continue; }
    unarmed = line;
    break;
  }
  if (!unarmed && !cited) return { deferralLine: null };
  if (runArmedSchedule(parts) || runSentLaneMessage(parts)) return { deferralLine: null };
  const citedPart = cited ? { citedLine: cited.line, citedScheduleIds: cited.ids } : {};
  if (!unarmed) return { deferralLine: null, ...citedPart };
  // The clause is found on the UNCLIPPED line — an idiom past char 240 still names its own clause.
  return { deferralLine: clipLine(unarmed, 240), deferralClause: findDeferralClause(unarmed), ...citedPart };
}

/** The auto-armed one-shot's prompt — quotes the deferred commitment. */
export function deferredActionPrompt(deferralLine: string): string {
  return (
    `${DEFERRED_ACTION_MARKER}\n` +
    `Your previous wake note DEFERRED an action but armed no schedule and messaged no lane — the commitment existed only as prose: "${deferralLine}"\n` +
    `Execute that deferred action NOW (cite the returned ids), or explicitly stand down on it in one line ('STANDING DOWN: <what> — <why>'). Do not re-defer it to prose again — arm a schedule_message if it genuinely must wait.`
  );
}
