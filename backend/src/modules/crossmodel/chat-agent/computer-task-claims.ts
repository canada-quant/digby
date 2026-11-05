/**
 * COMPUTER_TASK CLAIM CHECK — ticket 4c7aebf7 (2026-10-21, chat e03452f4 — the 'cql-accelerator Supervisor'
 * project-supervisor chat). Part (c) IS BUILT HERE: a computer_task ACTION claim must quote the task result's
 * harness counters inline (refusedRepeats / noChangeStrikes / degenerateFrames / displays / probe), mirroring the
 * [SUB-AGENT NARRATION — unverified] rule already applied to capture / permission claims — a full-control result
 * backs the claim only when the note cites the counters that result carries. Parts (a)+(b) live in
 * chat-agent/struck-note-repeat.ts (commit 4c95f628e).
 *
 * THE INCIDENT: the 17:12:19Z machine-wake note said it drove the owner's Mac via computer_task — "opened the
 * Tailscale admin console → Access controls, applied the ACL edit … and clicked Save — the policy file saved" —
 * while the owner, watching the Mac live, saw zero cursor movement. A machine run while the owner is active is
 * camera-only (the owner-presence gate): the computer_task result's header said OBSERVE-ONLY and the sub-agent's
 * "clicked Save" rode under the [SUB-AGENT NARRATION — UNVERIFIED] label. The supervisor relayed the narration as
 * its own action; the 17:20:32Z re-post repeated it with no computer_task call at all.
 *
 * OBSERVE-ONLY BY DEFAULT (round 4, 2026-10-21 — both round-3 reviews NOT_MERGE_SAFE: the claim miner's false
 * positive rate on real supervisor prose is unmeasured, and the reviewers showed two classes — routine platform
 * verbs in a clause that merely names the Mac / screen / computer_task, and the harness's own requested
 * acknowledgement / retraction lines being mined as new claims, which made the annotation self-perpetuating).
 * The seam records ONE loop_metrics row per verdict (kind computer_task_claim — reason class + counts, never note
 * text) and changes NOTHING: no annotation, no strike, no [PRIOR NOTE STRUCK] feed, no delivery change. Only the
 * opt-in COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1 restores the annotation (renderComputerTaskClaimAnnotation + the
 * guard_strike row + the screen-claims [PRIOR NOTE STRUCK] block). COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 is the
 * full off switch (no check, no row).
 *
 * THIS LEAF (pure — the struck-note leaf's note-body reader aside):
 *   - findScreenInputClaims: NARROW claim detection — a first-person (explicit "I" / "we", or the status-note
 *     implicit subject at sentence start) PAST-TENSE SCREEN-INPUT verb whose OWN CLAUSE (up to a clause break,
 *     before any purpose / topic word — "for", "about", "to fix", "until" … — and outside parentheses) names what
 *     it acted on:
 *       click (clicked / double- / right-clicked): a UI element, a desktop app, a label right after the verb
 *         ("clicked Save", 'clicked "Apply"'), or the device as its place ("on the Mac");
 *       key (pressed / tapped): a key or chord ("pressed Enter", "pressed Cmd+S"), a button / keyboard, or the
 *         device as its place — NEVER a bare capitalised word ("Pressed Spark lane for the numbers" urges a lane);
 *       input (typed / pasted / keyed / dragged / scrolled): an input target (a text / form field, an editor, a
 *         terminal …), a desktop app, or the device as its place — never a link / tab / thread, never "typed up";
 *       select (selected / toggled / ticked / unticked): an on-screen control (a checkbox, a radio button, a
 *         toggle, a drop-down, a menu item) or the device as its place — "Selected the MacBook as the target" is a
 *         setting, never input;
 *       drive (drove): the device itself as the object ("Drove the owner's Mac") or its place.
 *     A DEVICE word (computer_task / computer use, the screen, the desktop, the Mac family — case-sensitive, never
 *     a host name like "example-tailnet-peer") counts only as the HEAD of the verb's object or of an on / in / via /
 *     using / through / with / from phrase: "the computer_task fix", "a Mac agent ticket", "the Mac mini lane",
 *     "the screen-capture lane" are platform nouns the device word only describes. Platform verbs (opened,
 *     applied, saved, edited, entered, submitted, filed, dispatched …) are NEVER claims — they only carry the
 *     implicit first-person subject to a coordinated screen-input verb ("Applied the edit and clicked Save"), and
 *     a verb whose object is a platform artefact (a ticket, PR, session, lane, board, doctrine, build, result
 *     header …) is never input.
 *     Never: a plan ("I will click"), what OTHERS did ("the lane clicked"), narration relayed in quotes or after a
 *     label, a negation / modal / hypothetical ("never clicked", "would have clicked", "if I clicked"), an object
 *     negation ("Clicked nothing on the Mac", "Pressed no keys"), an honest hedge ("attempted, unverified", "could
 *     not confirm"), a past-turn reference ("earlier", "last wake", "my previous note", "the 17:12Z note", "two
 *     hours ago", "on Tuesday"), reported speech ("the note said I clicked …", "the check flagged that I …"), an
 *     acknowledgement / retraction ("Correction: …", "… withdrawn", "That never happened.", "I did not actually
 *     …" — the very line the [PRIOR NOTE STRUCK] block asks for), a line quoting the harness block, a '>' quote,
 *     a table row or a code fence.
 *   - classifyComputerTaskResult / summarizeComputerTaskCalls: the formatter's own banners and header
 *     (tool-executor formatComputerTaskToolResult): observe-only (camera-only, incl. the owner-presence gate),
 *     busy, unavailable, no steps, full control — or unknown (an error envelope; never judged).
 *   - checkComputerTaskClaims: the note claims on-screen input AND (every computer_task call of the run could not
 *     act — observe-only / busy / unavailable / no steps — OR the run made NO computer_task call and the claim
 *     names the device explicitly) ⇒ unbacked. Any full-control call, any unknown result, or any browser_task
 *     call (its local driver drives the Mac too — another lane's job) ⇒ not judged. A note the guard already
 *     replaced / redacted is not judged again.
 *   - computerTaskClaimMetricMeta: the loop_metrics row's meta (counts and the reason class only).
 *   - renderComputerTaskClaimAnnotation (opt-in only): ONE observe-only paragraph under the verifier's annotation
 *     header — guard-chrome-redact strips it from later model context; its claim lines are the annotation-claim
 *     shape (`- [screen input] "…"`), so an owner briefing written from the note marks them "(unverified)"; for
 *     chat-agent/struck-note-repeat it is a strike for the next turn's [PRIOR NOTE STRUCK] block (screen-claims
 *     wording) — only while the opt-in is set — and never makes a re-post a repeat.
 * The chat-agent seam runs it on SUPERVISOR-CLASS MACHINE runs only — never a block, never a reject-back, human
 * turns untouched (gate-flip doctrine 2026-09-11).
 *
 * Round 5 (2026-10-21, both round-4 reviews NOT_MERGE_SAFE): (i) BOUNDED — only the first MINE_MAX_CHARS of a note are
 * mined and a sentence over MINE_SENTENCE_MAX_CHARS is skipped (the reported-speech tests were near-cubic on one long
 * sentence, synchronously on the finalize path); (ii) three cheap false-positive shapes from the shadow data are gone:
 * a platform verb's device place no longer makes a coordinated verb a claim (it only marks a verb that is already a
 * claim on its own clause as a device claim — the leading instrument phrase still counts for every verb); a question
 * ("Clicked Save on the Mac?"), a sentence answered by a bare "No —" reply, and an "Owning the miss:" / "My mistake —"
 * label are never claims; a verb whose own place phrase is a platform artefact (a PR, a lane, a deploy, a ticket …)
 * is platform work unless the device or a named desktop app is in the clause. Declined: changing the bar when every
 * call was camera-only to the no-call branch's device bar — it would drop the relay shape the round-3 tests pin ("I
 * clicked Save in the Tailscale admin console" after a camera-only call, the incident minus the device word); the
 * metric row's deviceClaims count already splits the opt-in readout by device claims.
 */
import { UNVERIFIED_FOOTNOTE_HEADER } from '../platform/unverified-claims';
import { COMPUTER_TASK_ANNOTATION_LEAD, computerTaskClaimAnnotateEnabled, computerTaskClaimCheckDisabled, noteBodyForRepeat, struckLaneOf } from './struck-note-repeat';

/** COMPUTER_TASK_CLAIM_CHECK_DISABLED=1 — no check, no row, no annotation, and a stored annotation is no strike (today
 *  byte-for-byte). Both switch readers live in the struck-note leaf (it reads them and this leaf imports it). */
export { computerTaskClaimAnnotateEnabled, computerTaskClaimCheckDisabled };

/** loop_metrics kind — ONE row per verdict worth recording (computerTaskClaimRowWorthy); counts only, never text. */
export const COMPUTER_TASK_CLAIM_METRIC = 'computer_task_claim';
/** guard_strike seam / strike (opt-in annotation only — fleet/strike-adjudication ADJUDICATION_SKIPPED_SEAMS). */
export const COMPUTER_TASK_CLAIM_SEAM = 'machine_wake_computer_task_claim';
export const COMPUTER_TASK_CLAIM_STRIKE = 'computer_task_claim_unbacked';
/** The annotation's claim-line kind (`- [screen input] "…"` — the shape the owner briefing reads back). */
export const SCREEN_INPUT_CLAIM_KIND = 'screen input';

/** Claim lines carried into the annotation. */
export const MAX_CLAIMS = 4;
const SENTENCE_MAX_CHARS = 180;
const PHRASE_MAX_CHARS = 80;
/**
 * Round 5 (round-4 review 1): the miner runs synchronously on the finalize path of every supervisor machine note, and
 * its end-anchored reported-speech tests cost roughly cubic time in one long sentence (a 19 KB single-sentence paragraph
 * took ~1 s). Bounded like the struck-note leaf bounds its comparison: only the first MINE_MAX_CHARS of the note are
 * mined, and a sentence longer than MINE_SENTENCE_MAX_CHARS is skipped whole — both misses in the safe direction (the
 * check is observe-only by default; a status note's claims sit in its head, in short sentences). Ship review (round-4
 * reviews): the per-sentence cost is still super-linear inside the caps (a 20 KB note of 1.5 KB sentences cost ~110 ms
 * warm), so the caps are 8 000 / 600 — the same adversarial shape now costs a few ms.
 */
export const MINE_MAX_CHARS = 8_000;
export const MINE_SENTENCE_MAX_CHARS = 600;

export type ComputerTaskCallClass = 'full_control' | 'observe_only' | 'busy' | 'unavailable' | 'no_steps' | 'unknown';
/** Classes under which no on-screen input could have happened this call. */
export const NO_INPUT_CLASSES: ReadonlySet<ComputerTaskCallClass> = new Set(['observe_only', 'busy', 'unavailable', 'no_steps']);

// Literals mirror tool-executor.ts formatComputerTaskToolResult (source-pinned by the test; that module's import
// chain cannot ride this leaf).
const BUSY_BANNER = '[COMPUTER_TASK — BUSY]';
const UNAVAILABLE_BANNER = '[COMPUTER_TASK — UNAVAILABLE]';
const RESULT_HEADER_RE = /^\[Computer task result — steps: (\d+)([^\n]*)\]/m;
const OBSERVE_ONLY_MARK = ' · OBSERVE-ONLY (';
const NEVER_STARTED = ['No task provided for computer use.', 'Computer use is only available for signed-in users'];

/** One computer_task tool result → its class, from the formatter's banners / header. Pure. */
export function classifyComputerTaskResult(result: unknown): ComputerTaskCallClass {
  const text = typeof result === 'string' ? result.trimStart() : '';
  if (!text) return 'unknown';
  if (text.startsWith(BUSY_BANNER)) return 'busy';
  if (text.startsWith(UNAVAILABLE_BANNER)) return 'unavailable';
  if (NEVER_STARTED.some((s) => text.startsWith(s))) return 'unavailable';
  const header = RESULT_HEADER_RE.exec(text);
  if (!header) return 'unknown';
  if (header[2].includes(OBSERVE_ONLY_MARK)) return 'observe_only';
  if (Number(header[1]) === 0) return 'no_steps';
  return 'full_control';
}

interface PartLike { type?: string; name?: string; result?: unknown; [extra: string]: unknown }

export interface ComputerTaskCallSummary {
  total: number;
  counts: Record<ComputerTaskCallClass, number>;
  /** A browser_task ran this run (its local driver drives the Mac too) — the check stands down. */
  browserTask: boolean;
}

/**
 * The run's computer_task calls by class: tool_result parts named computer_task (a nameless result pairs with the
 * nearest preceding tool_call — reject-back-seed collectToolResults' rule); a call with no result counts unknown. Pure.
 */
export function summarizeComputerTaskCalls(parts: readonly unknown[] | null | undefined): ComputerTaskCallSummary {
  const counts: Record<ComputerTaskCallClass, number> = { full_control: 0, observe_only: 0, busy: 0, unavailable: 0, no_steps: 0, unknown: 0 };
  let calls = 0;
  let results = 0;
  let browserTask = false;
  let lastCallName = '';
  for (const raw of Array.isArray(parts) ? parts : []) {
    const p = raw as PartLike;
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'tool_call') {
      lastCallName = String(p.name ?? '') || lastCallName;
      if (p.name === 'computer_task') calls += 1;
      if (p.name === 'browser_task') browserTask = true;
      continue;
    }
    if (p.type !== 'tool_result') continue;
    const name = String(p.name ?? '') || lastCallName;
    if (name === 'browser_task') browserTask = true;
    if (name !== 'computer_task') continue;
    results += 1;
    counts[classifyComputerTaskResult(p.result)] += 1;
  }
  if (calls > results) counts.unknown += calls - results;
  return { total: Math.max(calls, results), counts, browserTask };
}

/**
 * Did every computer_task call of the run stay input-free (observe-only / busy / unavailable / never started)? True
 * also when the run made none. A full-control call or an unknown result (an error envelope — it may have acted)
 * reads false. The struck-note repeat seam uses it to allow a camera-only computer_task in a replay. Pure.
 */
export function computerTaskCallsInputFree(parts: readonly unknown[] | null | undefined): boolean {
  const s = summarizeComputerTaskCalls(parts);
  return s.counts.full_control === 0 && s.counts.unknown === 0;
}

// ── Claim detection ───────────────────────────────────────────────────────────

type VerbTier = 'click' | 'key' | 'input' | 'select' | 'drive' | 'subject';
/**
 * The verb tiers (see the module doc). 'subject' = PLATFORM verbs: never a claim, they only carry the implicit
 * first-person subject to a coordinated screen-input verb ("Applied the ACL edit and clicked Save").
 */
const VERB_TIERS: ReadonlyArray<[VerbTier, readonly string[]]> = [
  ['click', ['double-clicked', 'right-clicked', 'clicked']],
  ['key', ['pressed', 'tapped']],
  ['input', ['typed', 'pasted', 'keyed', 'dragged', 'scrolled']],
  ['select', ['selected', 'toggled', 'ticked', 'unticked']],
  ['drive', ['drove']],
  ['subject', ['opened', 'applied', 'saved', 'edited', 'entered', 'submitted', 'filled', 'filed', 'dispatched', 'launched', 'navigated', 'reviewed', 'verified', 'confirmed', 'checked', 'read', 'ran', 'set', 'updated', 'changed', 'corrected', 'switched', 'logged', 'signed']],
];
const TIER_OF: ReadonlyMap<string, VerbTier> = new Map(VERB_TIERS.flatMap(([tier, verbs]) => verbs.map((v) => [v, tier] as [string, VerbTier])));
const VERB_ALT = VERB_TIERS.flatMap(([, verbs]) => verbs).map((v) => v.replace(/\s+/g, '\\s+')).join('|');
/** Explicit first person: "I clicked", "we then pressed", "I've typed", "I just pasted". */
const EXPLICIT_FIRST_PERSON_RE = new RegExp(String.raw`\b(?:I|[Ww]e)(?:'ve|'d|\s+have|\s+had)?(?:\s+(?:then|just|also|already|successfully|finally|now|first|manually|actually))*\s+(${VERB_ALT})\b`);
/** Implicit status-note subject at sentence start: "Clicked Save …", "Then pasted …". */
const IMPLICIT_START_RE = new RegExp(String.raw`^(?:(?:then|and|also|next|finally|so|just|successfully)\s+)?(${VERB_ALT})\b`, 'i');
/** A later verb COORDINATED with the first-person verb (same subject): "applied the edit and clicked Save", ", then pasted". */
const COORDINATED_VERB_RE = new RegExp(String.raw`(?:,\s*(?:and\s+|then\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+)(${VERB_ALT})\b`, 'gi');

// The DEVICE as a noun-phrase HEAD (round 4). Case-sensitive on purpose: the Mac family needs its capital M (never
// "MAC address", never a host name like "example-tailnet-peer"); the other words allow a capital first letter.
const DETERMINERS = String.raw`(?:(?:[Tt]he|[Aa]n?|[Hh]is|[Hh]er|[Tt]heir|[Mm]y|[Oo]ur|[Yy]our|[A-Za-z][\w-]*['’]s)\s+)*`;
const DEVICE_NOUN = String.raw`(?:[Cc]omputer[_ -]?(?:task|use)(?:\s+(?:tool|session|call|sub-?agent))?|[Ss]creen|[Dd]esktop|MacBook(?:\s+(?:Pro|Air))?|iMac|Mac(?:\s+(?:mini|Studio|Pro))?)`;
/** What may follow a device HEAD: the clause end, punctuation, or a function word — never another noun. */
const DEVICE_FOLLOW = String.raw`(?=\s*$|\s*[,;:.!?)\]—–]|\s+-\s|\s+(?:via|using|with|through|to|for|this|that|and|then|again|now|today|without|while|before|after|so|but|at|in|on|from|as|by|itself|directly|live)\b)`;
const DEVICE_OBJECT_RE = new RegExp(String.raw`^\s*${DETERMINERS}${DEVICE_NOUN}${DEVICE_FOLLOW}`);
const DEVICE_PLACE_RE = new RegExp(String.raw`(?:^|\s)(?:[Oo]n|[Ii]n|[Ii]nto|[Vv]ia|[Uu]sing|[Tt]hrough|[Ww]ith|[Ff]rom|[Ii]nside|[Ww]ithin)\s+${DETERMINERS}${DEVICE_NOUN}${DEVICE_FOLLOW}`);
/** The verb's direct object ends at the first preposition / coordinator. */
const OBJECT_END_RE = /\s(?:on|in|into|onto|at|via|using|with|through|from|to|for|of|as|by|under|over|inside|within|across|and|then|but)\b/i;
/** A direct object that names a platform artefact is never screen input ("clicked the PR link", "typed the ticket"). */
const PLATFORM_ARTIFACT_RE = /\b(?:tickets?|PRs?|pull requests?|sessions?|lanes?|threads?|boards?|todos?|doctrines?|commits?|builds?|deploys?|deployments?|premises?|seats?|notes?|logs?|canar(?:y|ies)|fix(?:es)?|directives?|instructions?|schedules?|goals?|receipts?|headers?|results?|messages?|reports?|postmortems?|scripts?|configs?|configurations?|issues?|branch(?:es)?|patch(?:es)?|numbers|ETAs?|questions?)\b/i;
/** Desktop apps / surfaces (click and input tiers). */
const DESKTOP_APP_RE = /\b(?:System (?:Settings|Preferences)|Finder|Safari|Chrome|Terminal|menu bar|address bar|URL bar)\b/i;
/** UI elements a click lands on (click tier). */
const CLICK_TARGET_RE = /\b(?:buttons?|checkbox(?:es)?|check box(?:es)?|toggles?|radio buttons?|(?:text|input|form|search|password) ?(?:fields?|box(?:es)?)|drop-?downs?|dialogs?|modals?|pop-?ups?|menus?|icons?|tabs?|links?|sidebar)\b/i;
/** What typing / pasting / dragging lands in (input tier) — never a link / tab / thread. */
const INPUT_TARGET_RE = /\b(?:(?:text|input|form|search|password) ?(?:fields?|box(?:es)?)|editor|terminal|prompt box|keyboard|dialogs?|modals?)\b/i;
/** On-screen controls a select / toggle lands on (select tier). */
const SELECT_TARGET_RE = /\b(?:checkbox(?:es)?|check box(?:es)?|radio buttons?|toggles?|drop-?downs?|menu items?|options? (?:in|from) the (?:menu|drop-?down|list))\b/i;
/** Key-tier objects: a key / chord / quoted label right after the verb, or a button / key / keyboard in the clause. */
const KEY_RIGHT_AFTER_RE = /^\s*(?:the\s+)?(?:\u0001|⌘|(?:cmd|command|ctrl|control|option|opt|alt|shift|fn)\s*[+-]\s*\S|(?:enter|return|esc(?:ape)?|tab|space(?:bar)?|delete|backspace|f(?:1[0-2]|[1-9]))\b|(?:up|down|left|right)\s+arrow\b|arrow\s+keys?\b)/i;
const KEY_TARGET_RE = /\b(?:buttons?|keyboard|keystrokes?)\b|\bkeys?\s*$/i;
/** Click-tier label right after the verb: a quoted label, or a capitalised word ("clicked Save", "clicked on the Apply"). */
const CLICK_LABEL_RE = /^\s*(?:on\s+)?(?:the\s+)?(?:\u0001|⌘|[A-Z][\w+-]*)/;
/** An object negation right after the verb: "Clicked nothing", "Pressed no keys", "Typed none of …". */
const OBJECT_NEGATION_RE = /^\s*(?:(?:on|in|into|at)\s+)?(?:nothing|none|no|not|zero|neither|nor|never)\b/i;
/** "Typed up the postmortem" / "keyed up" — authored, never input. */
const PHRASAL_AUTHORED_RE = /^\s*up\b/i;
/** An honest hedge anywhere in the sentence ("Clicked Save — attempted, unverified"). */
const HEDGE_RE = /\b(?:attempted|unverified|unconfirmed)\b|\bnot\s+(?:yet\s+)?(?:verified|confirmed)\b|\bno input\b/i;
/** A failed / negated result in the verb's own tail up to the next ';' ("Clicked Save but could not confirm it"). */
const NEGATED_RESULT_RE = /\b(?:did|could|can|was|were)\s*(?:not|n['’]t)\b|\bcannot\b|\bunable\b/i;
/** Where the verb's own clause ends: a purpose / topic / subordinate word ("for the bug", "to fix", "until …"). */
const CLAUSE_CUT_RE = /\s(?:for|about|regarding|because|since|so|until|unless|while|after|before|when|once|fixing|that|which|who|whose|where|per|as|than|whether)\b|\sto\s+(?!(?:the|a|an|my|his|her|their|our|its|this|that|these|those|each|every|all|it|them)\b)[a-z]/i;
/**
 * The sentence is about a prior turn (never "this turn") — round 4 adds a note referenced by possessive or clock
 * ("my previous note", "the 17:12Z note") and explicit time markers ("two hours ago", "on Tuesday", "in the 16:40Z
 * session"). An inline "at 16:40Z" alone is NOT one: it does not say which turn, and the incident shape could carry it.
 */
const PAST_TURN_RE = new RegExp([
  String.raw`\b(?:earlier|previously|yesterday)\b`,
  String.raw`\blast (?:wake|turn|run|note|sweep|session|night|time)\b`,
  String.raw`\bprior (?:wake|turn|run|note|sweep)\b`,
  String.raw`\bbefore this (?:wake|turn|run)\b`,
  String.raw`\b(?:the|an?|my|our|that|this chat['’]s)\s+(?:earlier|previous|prior|last|original|first|struck)\s+(?:wake|turn|run|note|sweep|message|post|update|report)\b`,
  String.raw`\b(?:the|my|our|that)\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z|UTC)?(?:['’]s)?\s+(?:note|message|post|update|wake|report|session|run|sweep)\b`,
  String.raw`\b(?:\d+|a|an|one|two|three|four|five|six|several|a few|few)\s+(?:min(?:ute)?s?|hours?|hrs?|days?)\s+ago\b`,
  String.raw`\bon\s+(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b`,
  String.raw`\b(?:in|during)\s+the\s+\d{1,2}:\d{2}\S*\s+(?:session|wake|run|sweep|note)\b`,
].join('|'), 'i');
/**
 * An acknowledgement / retraction (round 4 — the line the [PRIOR NOTE STRUCK] block itself asks for): a withdrawal
 * word in the sentence or in the NEXT one ("… withdrawn", "That never happened."), or a sentence led by an
 * acknowledgement label ("Correction:", "Retraction —", "Acknowledged:").
 */
const RETRACTION_RE = /\b(?:withdrawn|withdraw|retract(?:ed|ion)?|erratum|never happened|did(?:\s+not|n['’]t)\s+(?:actually\s+)?happen|(?:was|were)(?:\s+not|n['’]t)\s+(?:actually\s+)?(?:done|applied|saved|clicked|typed|pressed|pasted)|nothing was (?:applied|saved|clicked|typed|pressed|pasted|changed|done)|is (?:false|wrong|incorrect|untrue)|not actually|did(?:\s+not|n['’]t)\s+actually)\b/i;
const ACK_LABEL_RE = /^\W*(?:acknowledg\w*|correction|corrected|retraction|erratum|withdrawn|retracted|owning (?:it|that|up|the (?:miss|mistake|error)|my (?:miss|mistake|error))|my (?:miss|mistake|error|bad)|mea culpa)\s*[:—–-]/i;
/** An interrogative sentence (round 5): a question about input ("Clicked Save on the Mac?") never reports it. */
const QUESTION_END_RE = /\?[\s*_)\]"”’']*$/;
/** A question ABOUT the input, not a report followed by a question (ship review): the '?' must close the verb's own
 *  clause — a claim joined to a trailing question by ';' ':' '—' '–' ("…clicked Save; should I re-run the probe?",
 *  "…and clicked Save — want me to re-run it?") is still a report and still mined. Pure. */
function isInputQuestion(s: string): boolean {
  if (!QUESTION_END_RE.test(s)) return false;
  return !/[;:—–]/.test(s.replace(QUESTION_END_RE, ''));
}
/** A bare "No —" / "No," / "No." reply leading the NEXT sentence withdraws this one (round 5 — the question-form
 *  acknowledgement "Clicked Save on the Mac? No — the run was camera-only."). "No other changes." / "No-op …" are not. */
const NO_REPLY_RE = /^\W*no\b(?:\s*[,—–:;.!]|\s+-(?:\s|$)|\s*$)/i;
/** The harness's own words (a line quoting the [PRIOR NOTE STRUCK] block / an annotation claim line). */
const HARNESS_ECHO_RE = /\[screen input\]|PRIOR NOTE STRUCK|\[ACTION VERIFIER|\bintegrity check\b/i;
/** A hypothetical right before the explicit subject ("if I clicked …", "unless we typed …"). Negations and modals
 *  never match EXPLICIT_FIRST_PERSON_RE in the first place: only adverbs may sit between the subject and the verb. */
const HYPOTHETICAL_PRE_RE = /\b(?:if|unless|whether|once)\s*$/i;
/** Reported speech before the explicit subject: "spark lane reported: I clicked …", "the owner says — I typed …". */
const REPORTED_PRE_RE = /\b(?:says?|said|reports?|reported|writes?|wrote|repl(?:y|ies|ied)|quot(?:e|es|ed)|lane|session|worker|sub-?agent|owner|user)\b[^.]*[:—–]\s*$/i;
/** Reported speech whatever punctuation follows (round 4): "the note said I …", "the check flagged that I …",
 *  "the 17:12Z note's claim that I …". */
const REPORTED_VERB_PRE_RE = /\b(?:said|says|claimed|claims|claiming|claim|stated|states|flagged|flags|reported|reports|asserted|asserts|wrote|writes|read|reads)\s+(?:that\s+)?$/i;
/** Status-note label prefixes that are not a subject ("Step 1:", "Done —"). */
const LABEL_PREFIX_RE = /^(?:step\s*\d+|done|action|actions|update|result|status|progress|now|then)\s*[:—–-]\s*/i;
/** A leading "Via computer_task," / "Using the Mac:" phrase before the claim (the instrument). */
const LEADING_PREP_RE = /^(?:via|using|with|through|on)\s+[^,:]{1,60}[,:]\s*/i;
/** An explicit subject's pre-verb instrument phrase ("Via computer_task I toggled …"). */
const INSTRUMENT_PRE_RE = /^\s*(?:via|using|with|through|on|in)\b/i;
/** A quoted span (removed before mining; a placeholder stays so "clicked "Apply"" still reads as a label). */
const QUOTED_RE = /"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g;
const QUOTE_MARK = '\u0001';

export interface ScreenInputClaim {
  /** The verb and the start of its clause, clipped (telemetry excerpts — opt-in annotation only). */
  phrase: string;
  /** The sentence it rides, clipped (what the opt-in annotation quotes). */
  sentence: string;
  /** The device is the verb's object or place (computer_task / the Mac / the screen) — the no-call verdict's bar. */
  device: boolean;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const stripQuoted = (s: string): string => s.replace(QUOTED_RE, ` ${QUOTE_MARK} `);

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line || line.startsWith('>') || line.startsWith('|')) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z*_✅✔•([])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/** Leading list / emphasis / emoji chrome and label prefixes off a sentence; the instrument phrase is returned apart. */
function stripLead(s: string): { lead: string; instrument: string } {
  let t = s.replace(/^(?:[-*+•·]\s+|\d+[.)]\s+|#+\s+)/, '').replace(/^(?:\*\*|__)/, '').replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '');
  t = t.replace(LABEL_PREFIX_RE, '');
  const prep = LEADING_PREP_RE.exec(t);
  const instrument = prep ? prep[0] : '';
  if (prep) t = t.slice(prep[0].length);
  return { lead: t.replace(/^(?:\*\*|__)/, '').trim(), instrument };
}

/**
 * The verb's OWN clause (what the cue tests read): from the verb to the first clause break, parentheticals out,
 * cut before a purpose / topic / subordinate word. `parens` = the parenthetical text (only an explicit "via
 * computer_task" there counts — "Clicked Save (via computer_task)"). Pure.
 */
function verbClause(fromVerb: string): { clause: string; parens: string } {
  const head = fromVerb.split(/[,;:—–|]|\s-\s|\s→\s/)[0];
  const parens = (head.match(/\([^)]*\)?/g) ?? []).map((p) => p.replace(/^\(|\)$/g, '')).join(' , ');
  let clause = head.replace(/\([^)]*\)?/g, ' ').replace(/\s+/g, ' ');
  const cut = CLAUSE_CUT_RE.exec(clause);
  if (cut) clause = clause.slice(0, cut.index);
  return { clause: clause.trim().replace(/[.!?]+$/, ''), parens };
}

/** Is the device the HEAD of the object (`object`) or of a place / instrument phrase (`place`) in `t`? Pure. */
function deviceRoles(afterVerb: string): { object: boolean; place: boolean } {
  return { object: DEVICE_OBJECT_RE.test(afterVerb), place: DEVICE_PLACE_RE.test(afterVerb) };
}

/** Does the verb's clause name what a verb of `tier` acted on? (`afterVerb` = the clause text after the verb.) Pure. */
function tierCue(tier: VerbTier, clause: string, afterVerb: string, devObject: boolean, devPlace: boolean): boolean {
  switch (tier) {
    case 'click': return devPlace || CLICK_LABEL_RE.test(afterVerb) || CLICK_TARGET_RE.test(clause) || DESKTOP_APP_RE.test(clause);
    case 'key': return devPlace || KEY_RIGHT_AFTER_RE.test(afterVerb) || KEY_TARGET_RE.test(clause);
    case 'input': return devPlace || INPUT_TARGET_RE.test(clause) || DESKTOP_APP_RE.test(clause);
    case 'select': return devPlace || SELECT_TARGET_RE.test(clause);
    case 'drive': return devObject || devPlace;
    default: return false; // 'subject' — platform verbs are never a claim
  }
}

interface JudgedVerb { phrase: string; device: boolean; devicePlace: boolean }

/**
 * A place phrase that puts the verb on a PLATFORM artefact (round 5): "Clicked Merge on PR #1301", "Pressed Enter on the
 * deploy dispatch", "Typed into the terminal of the coding lane" — platform work in screen words, never input. Narrower
 * than PLATFORM_ARTIFACT_RE on purpose: a "config editor", a "message box", a "results page" or a "terminal session" can
 * be on the screen. Never applied when the device itself is the verb's object / place or a desktop app is named.
 */
const PLATFORM_PLACE_RE = /\b(?:tickets?|PRs?|pull requests?|lanes?|threads?|boards?|todos?|commits?|builds?|deploys?|deployments?|dispatch(?:es)?|schedules?|goals?|receipts?|branch(?:es)?|repos?|repositories)\b/i;
/** A desktop app NAMED in the clause keeps the place on the screen ("Clicked Approve on PR #1301 in Safari") — case-sensitive
 *  app names, so "the terminal of the coding lane" is a lane, while "in Terminal" is the app. */
const DESKTOP_APP_NAME_RE = /\b(?:System (?:Settings|Preferences)|Finder|Safari|Chrome|Terminal)\b|\b(?:menu bar|address bar|URL bar)\b/;

/**
 * The device context a verb inherits from the rest of its sentence: `instrument` — a leading "Via computer_task," /
 * "Using the Mac:" phrase, the means of EVERY verb of the sentence (it satisfies a verb's cue); `scene` — the first
 * verb's own device place (a coordinated verb shares its subject's scene: "Applied the edit on the Mac and clicked
 * Save"). Round 5 (round-4 review 1): the scene only marks a verb that is ALREADY a claim on its own clause as a device
 * claim — it never makes one ("Reviewed the camera read from the Mac and toggled the decision gate to shadow").
 */
interface VerbContext { instrument: boolean; scene: boolean }

/**
 * One first-person verb occurrence judged on its own clause: object negation, negated result, platform-artefact
 * object or place, its tier's cue (`fromVerb` starts AT the verb; `ctx` = the device context, see VerbContext). The
 * claim (phrase '' = the verb is first-person but not a claim), or null (never a claim and stops the sentence). Pure.
 */
function judgeVerb(verb: string, fromVerb: string, ctx: VerbContext): JudgedVerb | null {
  const tier = TIER_OF.get(verb.toLowerCase().replace(/\s+/g, ' '));
  if (!tier) return null;
  const tail = fromVerb.slice(verb.length);
  if (OBJECT_NEGATION_RE.test(tail)) return null;
  if (NEGATED_RESULT_RE.test(fromVerb.split(';')[0])) return null;
  const { clause, parens } = verbClause(fromVerb);
  const afterVerb = clause.slice(Math.min(verb.length, clause.length));
  const roles = deviceRoles(afterVerb);
  const parenPlace = DEVICE_PLACE_RE.test(` ${parens}`);
  const devicePlace = roles.place || parenPlace;
  const device = roles.object || devicePlace || ctx.instrument || ctx.scene;
  const none: JudgedVerb = { phrase: '', device, devicePlace };
  if (tier === 'subject') return none;
  if (tier === 'input' && PHRASAL_AUTHORED_RE.test(afterVerb)) return none;
  const padded = ` ${afterVerb}`;
  const objectEnd = OBJECT_END_RE.exec(padded);
  const object = (objectEnd ? padded.slice(0, objectEnd.index) : padded).trim();
  if (PLATFORM_ARTIFACT_RE.test(object)) return none;
  // Round 5: the verb's own place phrase (up to the next coordinator) on a platform artefact is platform work.
  const place = objectEnd ? padded.slice(objectEnd.index).split(/\s(?:and|then|but)\b/i)[0] : '';
  if (place && !roles.object && !devicePlace && !DESKTOP_APP_NAME_RE.test(clause) && PLATFORM_PLACE_RE.test(place)) return none;
  if (!tierCue(tier, clause, afterVerb, roles.object, devicePlace || ctx.instrument)) return none;
  return { phrase: clip(clause.replace(new RegExp(QUOTE_MARK, 'g'), '"…"'), PHRASE_MAX_CHARS), device, devicePlace };
}

/** Is a sentence the model's own report of input THIS turn at all (the sentence-level filters)? Pure. */
function sentenceExcluded(s: string, next: string): boolean {
  if (PAST_TURN_RE.test(s) || HEDGE_RE.test(s) || HARNESS_ECHO_RE.test(s)) return true;
  if (ACK_LABEL_RE.test(s) || RETRACTION_RE.test(s) || isInputQuestion(s)) return true;
  // A retraction in the NEXT sentence withdraws this one ("… clicked Save on the Mac. That never happened."), and so
  // does a bare "No —" reply (round 5: "Clicked Save on the Mac? No — the run was camera-only.").
  return !!next && (RETRACTION_RE.test(next) || NO_REPLY_RE.test(next));
}

/** Every explicit first-person verb in a sentence ("I clicked", "we then pressed") — a global twin of the single-match regex. */
const EXPLICIT_FIRST_PERSON_ALL_RE = new RegExp(EXPLICIT_FIRST_PERSON_RE.source, 'g');

interface VerbCandidate { verb: string; fromVerb: string; instrument: string }

/**
 * The sentence's first-person verbs to judge, in order: the implicit status-note subject at its start, then every
 * explicit "I / we <verb>" (each with its own hypothetical / reported-speech check) — so a platform verb first
 * ("I read the policy, then I clicked Save on the Mac") never hides a later explicit input claim. Pure.
 */
function verbCandidates(s: string): VerbCandidate[] {
  const out: VerbCandidate[] = [];
  const { lead, instrument: leadInstrument } = stripLead(s);
  const implicit = IMPLICIT_START_RE.exec(lead);
  if (implicit) out.push({ verb: implicit[1], fromVerb: lead.slice(implicit.index + implicit[0].length - implicit[1].length), instrument: leadInstrument });
  for (const explicit of s.matchAll(EXPLICIT_FIRST_PERSON_ALL_RE)) {
    const at = explicit.index ?? 0;
    const pre = s.slice(0, at);
    if (HYPOTHETICAL_PRE_RE.test(pre.slice(-16))) continue;
    if (REPORTED_PRE_RE.test(pre) || REPORTED_VERB_PRE_RE.test(pre)) continue; // another speaker's words relayed unquoted
    out.push({ verb: explicit[1], fromVerb: s.slice(at + explicit[0].length - explicit[1].length), instrument: INSTRUMENT_PRE_RE.test(pre) ? pre : '' });
  }
  return out;
}

/** One candidate verb (and the verbs coordinated with it) → the claim, or null. Pure. */
function claimFromCandidate(c: VerbCandidate): JudgedVerb | null {
  // The instrument phrase ("Via computer_task,") is a device place for every verb of the sentence.
  const instrumentDevice = !!c.instrument && DEVICE_PLACE_RE.test(` ${c.instrument.replace(/[,:]\s*$/, '')}`);
  const first = judgeVerb(c.verb, c.fromVerb, { instrument: instrumentDevice, scene: false });
  if (!first) return null;
  if (first.phrase) return first;
  const ctx: VerbContext = { instrument: instrumentDevice, scene: first.devicePlace };
  for (const m of c.fromVerb.slice(c.verb.length).matchAll(COORDINATED_VERB_RE)) {
    const at = c.verb.length + (m.index ?? 0) + m[0].length - m[1].length;
    const next = judgeVerb(m[1], c.fromVerb.slice(at), ctx);
    if (!next) return null;
    if (next.phrase) return next;
  }
  return null;
}

/**
 * The note's first-person past-tense on-screen INPUT claims — one per sentence: a first-person verb (the implicit
 * status-note subject, or an explicit "I / we"), else a verb COORDINATED with it in the same sentence ("Applied the
 * ACL edit and clicked Save" — the second verb shares the subject), each judged on its own clause (narrow by design;
 * see the module doc for the verb tiers and what never counts). Pure.
 */
export function findScreenInputClaims(text: string | null | undefined): ScreenInputClaim[] {
  const out: ScreenInputClaim[] = [];
  const sentences = sentencesOf(String(text ?? '').slice(0, MINE_MAX_CHARS));
  for (let k = 0; k < sentences.length; k++) {
    const sentence = sentences[k];
    if (sentence.length > MINE_SENTENCE_MAX_CHARS) continue; // round 5: bounded — never mined
    const s = stripQuoted(sentence);
    if (sentenceExcluded(s, stripQuoted((sentences[k + 1] ?? '').slice(0, MINE_SENTENCE_MAX_CHARS)))) continue;
    for (const candidate of verbCandidates(s)) {
      const claim = claimFromCandidate(candidate);
      if (!claim) continue;
      out.push({ phrase: claim.phrase, sentence: clip(sentence, SENTENCE_MAX_CHARS), device: claim.device });
      break;
    }
  }
  return out;
}

// ── Part (c): the harness-counter QUOTE requirement ───────────────────────────
/**
 * TICKET 4c7aebf7 PART (c) — a computer_task ACTION claim must quote the task result's harness counters INLINE,
 * mirroring the [SUB-AGENT NARRATION — unverified] rule already applied to capture / permission claims.
 *
 * WHY: the incident's result header carried `harness: refusedRepeats=0 noChangeStrikes=0 degenerateFrames=0
 * displays=1` — harness FACTS about whether input landed — and the 17:12:19Z note relayed the sub-agent's
 * narration ("clicked Save", "the policy file saved") as its own action with none of those numbers. A claim that
 * quotes the counters can be checked against the header by whoever reads it; one that does not is the same
 * unsourced narration under a different label. `backed` therefore now requires the QUOTE, not just a full-control
 * result.
 *
 * The counters a result carries are exactly tool-executor formatComputerTaskToolResult's header segment — the
 * source-pinned literals below. The quote bar is the counters THAT RESULT carries: refusedRepeats /
 * noChangeStrikes / degenerateFrames / displays always (when a harness line exists at all), probe only when the
 * session ran probes. A value of any shape counts (`displays=unknown` is quoted as written) — this leaf asks only
 * whether the note cites the counter, never whether the numbers match (a mismatch is a different, harder judgment).
 * A full-control result with NO harness line at all cannot be counter-quoted, so its claim is unbacked too
 * (reason 'counters_unavailable') — the honest report of such a run is that it has no counters to cite.
 */
export interface HarnessCounterQuote {
  refusedRepeats: number;
  noChangeStrikes: number;
  degenerateFrames: number;
  /** Numeric display count, or null when the header stamped `displays=unknown`. */
  displays: number | null;
  /** Probes run (null = the header carried no probe segment — the session ran none). */
  probesRun: number | null;
  probesPassed: number | null;
  inputProven: boolean;
}

/** The counters this leaf asks a note to quote, in the header's own order. */
export type RequiredCounter = 'refusedRepeats' | 'noChangeStrikes' | 'degenerateFrames' | 'displays' | 'probe';
/** Always present on a harness line (tool-executor's formatComputerTaskToolResult). */
export const CORE_COUNTERS: readonly RequiredCounter[] = ['refusedRepeats', 'noChangeStrikes', 'degenerateFrames', 'displays'];

const HARNESS_SEGMENT_RE = /·\s*harness:\s*([^\]\n]*)/;
const counterNum = (seg: string, name: string): number | null => {
  const m = new RegExp(String.raw`\b${name}=(\d+)`).exec(seg);
  return m ? Number(m[1]) : null;
};

/**
 * The harness counters a computer_task RESULT text carries (its header's ` · harness: …` segment), or null when it
 * carries none (a result with no harness line). Pure.
 */
export function parseHarnessCounters(result: unknown): HarnessCounterQuote | null {
  const text = typeof result === 'string' ? result : '';
  const seg = HARNESS_SEGMENT_RE.exec(text);
  if (!seg) return null;
  const s = seg[1];
  const refusedRepeats = counterNum(s, 'refusedRepeats');
  const noChangeStrikes = counterNum(s, 'noChangeStrikes');
  const degenerateFrames = counterNum(s, 'degenerateFrames');
  if (refusedRepeats === null || noChangeStrikes === null || degenerateFrames === null) return null;
  const displaysRaw = /\bdisplays=(\d+|unknown|none)/.exec(s);
  const probe = /\bprobe=(\d+)\/(\d+)/.exec(s);
  return {
    refusedRepeats,
    noChangeStrikes,
    degenerateFrames,
    displays: displaysRaw && /^\d+$/.test(displaysRaw[1]) ? Number(displaysRaw[1]) : null,
    probesRun: probe ? Number(probe[2]) : null,
    probesPassed: probe ? Number(probe[1]) : null,
    inputProven: /\binput-proven\b/.test(s),
  };
}

/**
 * The counters the note must quote for THIS result: the core four, plus probe when the session ran probes. Pure.
 */
export function requiredCounters(c: HarnessCounterQuote): RequiredCounter[] {
  return c.probesRun === null || c.probesRun === 0 ? [...CORE_COUNTERS] : [...CORE_COUNTERS, 'probe'];
}

/**
 * A counter cited with a value in the note's own words — `refusedRepeats=0`, `noChangeStrikes: 0`,
 * `refused repeats 0`, `probe=1/1`, `displays=unknown`. Deliberately shape-agnostic about the VALUE: part (c) asks
 * whether the counter is quoted, never whether it agrees with the header. Pure.
 */
const COUNTER_QUOTE_RES: Record<RequiredCounter, RegExp> = {
  refusedRepeats: /\brefused[ _-]?repeats\b\s*(?:=|:|is|was|of|at)?\s*\d/i,
  noChangeStrikes: /\bno[ _-]?change[ _-]?strikes\b\s*(?:=|:|is|was|of|at)?\s*\d/i,
  degenerateFrames: /\bdegenerate[ _-]?frames\b\s*(?:=|:|is|was|of|at)?\s*\d/i,
  displays: /\bdisplays\b\s*(?:=|:|is|was|of|at)?\s*(?:\d+|unknown|none)\b/i,
  probe: /\bprobes?(?:[ _-]?run)?\b\s*(?:=|:|is|was|of|at)?\s*\d+\s*\/\s*\d+/i,
};
/** An explicit "no harness counters" citation is a QUOTE too (the honest report of a counter-less result). */
const COUNTERS_ABSENT_RE = /\bno harness counters\b|\bharness counters (?:are|were) (?:absent|unavailable|not stamped)\b|\bheader carries no (?:harness )?counters\b/i;

/**
 * The required counters the note does NOT quote (empty = the note quotes every one). `counters === null` (the
 * result carries no harness line) is never "missing" — that case is the verdict's 'counters_unavailable'. Pure.
 */
export function missingCounterQuotes(noteText: string | null | undefined, counters: HarnessCounterQuote | null): RequiredCounter[] {
  if (!counters) return [];
  const text = String(noteText ?? '');
  if (COUNTERS_ABSENT_RE.test(text)) return [];
  return requiredCounters(counters).filter((k) => !COUNTER_QUOTE_RES[k].test(text));
}

/**
 * The harness counters of this run's FIRST full-control computer_task result (the call that could act), or null
 * when there is none / it carries no harness line. Pure.
 */
export function runHarnessCounters(parts: readonly unknown[] | null | undefined): HarnessCounterQuote | null {
  let lastCallName = '';
  for (const raw of Array.isArray(parts) ? parts : []) {
    const p = raw as PartLike;
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'tool_call') { lastCallName = String(p.name ?? '') || lastCallName; continue; }
    if (p.type !== 'tool_result') continue;
    if ((String(p.name ?? '') || lastCallName) !== 'computer_task') continue;
    if (classifyComputerTaskResult(p.result) !== 'full_control') continue;
    return parseHarnessCounters(p.result);
  }
  return null;
}

// ── The verdict ───────────────────────────────────────────────────────────────

export interface ComputerTaskClaimVerdict {
  unbacked: boolean;
  /**
   * 'no_device_claim' — the run made no computer_task call and no claim names the device as its object / place:
   * never judged (a click on "the Save button" with no device may be another surface entirely).
   * Part (c) splits the old 'backed': a full-control call backs the claim ONLY when the note quotes that result's
   * harness counters ('backed'); a full-control call whose counters the note does not quote is
   * 'counters_not_quoted', and one whose result carried no harness line at all is 'counters_unavailable'.
   */
  reason: 'no_claims' | 'backed' | 'no_computer_task_call' | 'no_device_claim' | 'no_input_possible' | 'browser_task_ran' | 'unknown_result' | 'struck_note' | 'counters_not_quoted' | 'counters_unavailable';
  /** The claims the verdict rests on (capped at MAX_CLAIMS; a no-call verdict lists the device claims only). */
  claims: ScreenInputClaim[];
  /** Every claim the miner found (uncapped count). */
  found: number;
  calls: Record<ComputerTaskCallClass, number>;
  totalCalls: number;
  /** Part (c): the counter(s) this run's full-control result carries and the note does NOT quote. */
  missingQuotes?: RequiredCounter[];
  /** Part (c): the counters the run's full-control result carried (for the annotation's ask). */
  counters?: HarnessCounterQuote | null;
}

/**
 * Does `finalText` claim on-screen input this run's computer_task results cannot back? Judged on the model's own
 * words (verifier chrome off); a note the guard replaced / redacted is not judged again. Pure.
 */
export function checkComputerTaskClaims(finalText: string | null | undefined, parts: readonly unknown[] | null | undefined): ComputerTaskClaimVerdict {
  const summary = summarizeComputerTaskCalls(parts);
  const base = { claims: [] as ScreenInputClaim[], found: 0, calls: summary.counts, totalCalls: summary.total };
  const lane = struckLaneOf(finalText);
  if (lane === 'replaced' || lane === 'redacted') return { ...base, unbacked: false, reason: 'struck_note' };
  const all = findScreenInputClaims(noteBodyForRepeat(finalText));
  if (!all.length) return { ...base, unbacked: false, reason: 'no_claims' };
  const withClaims = { ...base, found: all.length, claims: all.slice(0, MAX_CLAIMS) };
  if (summary.browserTask) return { ...withClaims, unbacked: false, reason: 'browser_task_ran' };
  if (summary.total === 0) {
    // No computer_task call at all: only a claim that names the device says it drove the screen THIS turn.
    const deviceClaims = all.filter((c) => c.device).slice(0, MAX_CLAIMS);
    if (!deviceClaims.length) return { ...withClaims, unbacked: false, reason: 'no_device_claim' };
    return { ...withClaims, claims: deviceClaims, unbacked: true, reason: 'no_computer_task_call' };
  }
  if (summary.counts.full_control > 0) {
    // TICKET 4c7aebf7 PART (c): a call that COULD act backs the claim only when the note quotes that result's own
    // harness counters inline. The quote is what makes the claim checkable against the header; without it the note
    // is the sub-agent's narration wearing the caller's voice — the incident exactly.
    const counters = runHarnessCounters(parts);
    if (!counters) {
      // The result carries no harness line, so nothing can be quoted. A note that SAYS SO is the honest report and
      // stands; one that states the action as done with no such disclosure cannot be checked at all.
      const body = noteBodyForRepeat(finalText);
      if (COUNTERS_ABSENT_RE.test(body)) return { ...withClaims, unbacked: false, reason: 'backed', missingQuotes: [], counters: null };
      return { ...withClaims, unbacked: true, reason: 'counters_unavailable', counters: null };
    }
    const missingQuotes = missingCounterQuotes(noteBodyForRepeat(finalText), counters);
    if (missingQuotes.length) return { ...withClaims, unbacked: true, reason: 'counters_not_quoted', missingQuotes, counters };
    return { ...withClaims, unbacked: false, reason: 'backed', missingQuotes: [], counters };
  }
  if (summary.counts.unknown > 0) return { ...withClaims, unbacked: false, reason: 'unknown_result' };
  // Every call is in NO_INPUT_CLASSES (observe-only / busy / unavailable / no steps): no input was possible this run.
  return { ...withClaims, unbacked: true, reason: 'no_input_possible' };
}

/** Is a verdict worth a loop_metrics row? Anything but the empty case (no claim found AND no computer_task call). Pure. */
export function computerTaskClaimRowWorthy(v: ComputerTaskClaimVerdict): boolean {
  return v.found > 0 || v.totalCalls > 0;
}

/**
 * The computer_task_claim loop_metrics row's meta — the verdict's reason class and counts, NEVER note text (round 4:
 * the shadow data that measures the false-positive rate before any annotation is armed). Pure.
 */
export function computerTaskClaimMetricMeta(v: ComputerTaskClaimVerdict, opts: { annotated: boolean }): Record<string, unknown> {
  return {
    unbacked: v.unbacked,
    reason: v.reason,
    found: v.found,
    claims: v.claims.length,
    deviceClaims: v.claims.filter((c) => c.device).length,
    totalCalls: v.totalCalls,
    calls: Object.fromEntries(Object.entries(v.calls).filter(([, n]) => n > 0)),
    mode: computerTaskClaimAnnotateEnabled() ? 'annotate' : 'observe',
    annotated: opts.annotated,
    // Part (c): how many of the counters this run's full-control result carries the note failed to quote — the
    // shadow number that measures the quote gap before any requirement is armed. Absent when not judged that way.
    ...(v.reason === 'counters_not_quoted' ? { missingQuotes: (v.missingQuotes ?? []).length } : {}),
  };
}

const CLASS_WORDS: Partial<Record<ComputerTaskCallClass, string>> = {
  observe_only: 'observe-only (camera only — no input was possible)',
  busy: 'busy (another session held the device)',
  unavailable: 'unavailable',
  no_steps: 'never started (0 steps)',
};

/** The counters a note must quote, said the way the result header renders them (part (c)). */
const COUNTER_WORDS: Record<RequiredCounter, string> = {
  refusedRepeats: 'refusedRepeats',
  noChangeStrikes: 'noChangeStrikes',
  degenerateFrames: 'degenerateFrames',
  displays: 'displays',
  probe: 'probe',
};

/**
 * The OPT-IN observe-only annotation (COMPUTER_TASK_CLAIM_ANNOTATE_ENABLED=1; the clock lane's shape): ONE paragraph
 * under the verifier's annotation header — guard-chrome-redact strips it from later model context. It leads with
 * COMPUTER_TASK_ANNOTATION_LEAD (the struck-note leaf reads it as a screen-claims strike while the opt-in is set:
 * the next turn's [PRIOR NOTE STRUCK] block, never a repeat bounce), and its claim lines are the annotation-claim
 * shape `- [screen input] "<sentence>"`, so an owner briefing written from the note marks them "(unverified)". No
 * clock tokens of its own. Part (c) adds the two counter-quote reasons: the note names the action but not the
 * harness counters that would let a reader check it. Pure.
 */
export function renderComputerTaskClaimAnnotation(v: ComputerTaskClaimVerdict): string {
  const why = v.reason === 'no_computer_task_call'
    ? 'this run made no computer_task call, so nothing on the screen was driven this turn'
    : v.reason === 'counters_not_quoted'
      ? `this run's computer_task result carries harness counters the note does not quote inline (${(v.missingQuotes ?? []).map((k) => COUNTER_WORDS[k]).join(', ')}), so nothing lets a reader check that the input registered`
      : v.reason === 'counters_unavailable'
        ? "this run's computer_task result carries no harness counters at all, so no on-screen action can be checked against the harness"
        : `every computer_task call this run could not act on the screen: ${(Object.keys(CLASS_WORDS) as ComputerTaskCallClass[]).filter((k) => v.calls[k] > 0).map((k) => `${v.calls[k]} ${CLASS_WORDS[k]}`).join(', ')}`;
  const remedy = v.reason === 'counters_not_quoted' || v.reason === 'counters_unavailable'
    ? 'Treat those lines as unverified until a note quotes the computer_task result header\'s harness counters (refusedRepeats / noChangeStrikes / degenerateFrames / displays / probe) inline; nothing above was removed or changed.'
    : 'Treat those lines as unverified until a computer_task result that could act (not observe-only) confirms them; nothing above was removed or changed.';
  return [
    UNVERIFIED_FOOTNOTE_HEADER,
    `${COMPUTER_TASK_ANNOTATION_LEAD}${v.claims.length} line(s)), but ${why}:`,
    ...v.claims.map((c) => `- [${SCREEN_INPUT_CLAIM_KIND}] "${c.sentence}"`),
    remedy,
  ].join('\n');
}
