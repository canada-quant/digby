/**
 * Claim-verb → tool-class map (ticket f05b38c1) — the PURE, shared core of the
 * receipt-vs-claim verb check. Moved verbatim from unbacked-claim.ts (spec
 * d597ce5d) so BOTH halves of the check read ONE map with no cross-module
 * prisma drag:
 *
 *   • the chat-agent collector (unbacked-claim.ts receiptTripleCandidates /
 *     receiptToolMismatches) — the pre-delivery strike lane, and
 *   • the platform action-verifier's verb-consistency veto — the post-delivery
 *     defense-in-depth that stops a vouching tier from acquitting a claim
 *     whose cited receipt is of the wrong tool class for its own act verb.
 *
 * Re-exported from unbacked-claim.ts for every existing importer.
 */

/**
 * A claim verb (single word, past tense) → the tool names whose receipt backs
 * it. An unmapped verb maps to NO expected class — fail-open (never a false
 * strike; the check cannot know the tool, so it judges nothing).
 */
export const CLAIM_VERB_TOOL_CLASSES: Readonly<Record<string, readonly string[]>> = {
  // filed → file_feedback / triage_ticket
  filed: ['file_feedback', 'triage_ticket'],
  // sent → send_chat_message / notify_user (+ the wider send-class tools)
  sent: ['send_chat_message', 'notify_user', 'send_to_instance', 'imessage_send', 'slack_post_message', 'discord_send_message', 'discord_send_dm', 'x_post', 'gmail_send_email', 'send_email_as_digby', 'stage_upload'],
  // messaged / pinged / notified / steered / relayed / dispatched → the send class
  messaged: ['send_chat_message', 'notify_user', 'send_to_instance', 'imessage_send', 'slack_post_message', 'discord_send_message', 'discord_send_dm', 'x_post', 'gmail_send_email', 'send_email_as_digby'],
  pinged: ['send_chat_message', 'notify_user', 'send_to_instance'],
  notified: ['notify_user', 'send_chat_message'],
  steered: ['send_chat_message', 'send_to_instance'],
  relayed: ['send_chat_message', 'send_to_instance', 'notify_user'],
  dispatched: ['start_coding_session', 'dispatch_platform_task', 'send_chat_message', 'delegate', 'delegate_parallel', 'send_to_instance'],
  // updated → todo_update / goal_update (+ update_schedule / update_feedback); "pinned" is the
  // specimen-05126597 update claim ("pinned at priority 0 with adminNotes")
  updated: ['todo_update', 'goal_update', 'update_schedule', 'update_feedback', 'triage_ticket'],
  pinned: ['todo_update', 'goal_update', 'update_schedule', 'update_feedback', 'triage_ticket'],
  // armed → schedule_message (+ update_schedule: re-arming an EXISTING schedule
  // runs update_schedule, the KIND_TOOLS.schedule parity — review finding B3)
  armed: ['schedule_message', 'update_schedule'],
  scheduled: ['schedule_message', 'update_schedule'],
  // closed → the close class (resolve_feedback / triage_ticket / update_feedback /
  // file filer self-close) + the TODO/GOAL close verbs (todo_update/goal_update —
  // "Closed todo fea78360" citing its todo_update receipt is HONEST fleet
  // vocabulary, the f05b38c1 adjudication's top false-positive shape) + the
  // SCHEDULE close verbs (cancel_schedule/update_schedule — "Closed the stale
  // one-shot schedule X" runs cancel_schedule, the KIND_TOOLS.schedule parity,
  // review finding B3)
  closed: ['resolve_feedback', 'triage_ticket', 'update_feedback', 'file_feedback', 'todo_update', 'goal_update', 'cancel_schedule', 'update_schedule'],
  // retired → the close class (specimen ad60c49d: "Retired both duplicate
  // tickets … via filer self-close" — resolve_feedback never ran ok) + the
  // todo/goal retire verbs (same honesty widening as `closed`) + the schedule
  // retire verbs (cancel/update_schedule — same parity) + archive_chat
  // (ticket 62718124 specimen, chat daee2916 2026-10-18: "Retired the
  // reviewer chat (chat 1b3d4fea … archive_chat 518c6687 ok)" — retiring a
  // STALE CHAT/LANE runs archive_chat, and the noun citation is in-sentence)
  retired: ['resolve_feedback', 'triage_ticket', 'update_feedback', 'todo_update', 'goal_update', 'cancel_schedule', 'update_schedule', 'archive_chat'],
  // archived → archive_chat (ticket 62718124: "archived chat 1b3d4fea" citing
  // its ok archive_chat receipt struck act-grade — the map simply lacked the
  // verb). archive_chat(archived:false) is the restore direction; both
  // directions are the same tool.
  archived: ['archive_chat'],
  // resolved → the close class (specimen ad60c49d's ACTIONS TAKEN bullet:
  // "Resolved duplicate ticket 9c307167 via filer self-close") + todo/goal
  // resolved ("Resolved todo X" via todo_update — honest) + the schedule
  // close verbs (same parity)
  resolved: ['resolve_feedback', 'triage_ticket', 'update_feedback', 'todo_update', 'goal_update', 'cancel_schedule', 'update_schedule'],
  // merged → merge_pull_request
  merged: ['merge_pull_request'],
  // pushed → git_push
  pushed: ['git_push'],
  // withdrew → dismiss_owner_question / cancel_confirmation (specimen: "Withdrew
  // superseded card oq_5dc8861b")
  withdrew: ['dismiss_owner_question', 'cancel_confirmation', 'flag_owner_question'],
  dismissed: ['dismiss_owner_question'],
  flagged: ['flag_owner_question', 'file_feedback'],
  answered: ['answer_owner_question', 'answer_chat_question', 'answer', 'send_chat_message', 'notify_user'],
  // A tool noun cited with an id IS the verb ("start_coding_session → 9e39ec5c"
  // — todo 77c88942 item 3): the noun names the act. Every noun in
  // TOOL_NOUN_RE resolves to itself.
  start_coding_session: ['start_coding_session'],
  send_chat_message: ['send_chat_message'],
  send_to_instance: ['send_to_instance'],
  dispatch_platform_task: ['dispatch_platform_task'],
  delegate_parallel: ['delegate_parallel'],
  delegate: ['delegate', 'delegate_parallel'],
  schedule_message: ['schedule_message'],
  update_schedule: ['update_schedule'],
  flag_owner_question: ['flag_owner_question'],
  file_feedback: ['file_feedback'],
  triage_ticket: ['triage_ticket', 'update_feedback'],
  resolve_feedback: ['resolve_feedback'],
  update_feedback: ['update_feedback', 'triage_ticket'],
  update_supervisor_state: ['update_supervisor_state'],
  store_secret: ['store_secret'],
  stage_upload: ['stage_upload'],
  git_commit: ['git_commit'],
  git_push: ['git_push'],
  open_pull_request: ['open_pull_request'],
  merge_pull_request: ['merge_pull_request'],
  notify_user: ['notify_user'],
  send_email_as_digby: ['send_email_as_digby'],
  gmail_send_email: ['gmail_send_email'],
  dismiss_owner_question: ['dismiss_owner_question'],
  answer_owner_question: ['answer_owner_question'],
  answer_chat_question: ['answer_chat_question'],
  todo_update: ['todo_update'],
  goal_update: ['goal_update'],
  archive_chat: ['archive_chat'],
  goal_premise_set: ['goal_premise_set'],
  goal_create: ['goal_create'],
  goal_list: ['goal_list'],
  todo_create: ['todo_create'],
  todo_get: ['todo_get'],
};

/**
 * The tool classes a cited id's verb expects. Map lookups are case-insensitive
 * ("Resolved"/"resolved"); a citation after a TOOL NOUN expects that tool (the
 * noun names the act); unknown verb/noun → undefined (fail-open).
 */
export function expectedToolsForCitation(verb: string | undefined, noun?: string): readonly string[] | undefined {
  if (noun && Object.prototype.hasOwnProperty.call(CLAIM_VERB_TOOL_CLASSES, noun.toLowerCase())) {
    return CLAIM_VERB_TOOL_CLASSES[noun.toLowerCase()];
  }
  if (!verb) return undefined;
  return CLAIM_VERB_TOOL_CLASSES[verb.toLowerCase()];
}

/** Regex source for a claim verb or a tool noun — both halves build their own RE from this. */
export const CLAIM_VERB_OR_NOUN_SRC = `\\b(${Object.keys(CLAIM_VERB_TOOL_CLASSES).join('|')})\\b`;

/**
 * The LEFTMOST mapped verb/tool-noun token of a text that actually GOVERNS the
 * act: a token preceded by an article/possessive is a participle inside a noun
 * phrase ("the armed schedule fired and sent the report" — the act is `sent`,
 * not `armed`) and is skipped. Returns undefined when nothing maps (fail-open).
 * Pure; shared by the collector (via its own RE) and the verifier veto.
 */
export function leftmostMappedVerbToken(text: string): string | undefined {
  const t = String(text ?? '');
  if (!t) return undefined;
  const re = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'gi');
  for (const m of t.matchAll(re)) {
    const at = m.index ?? 0;
    if (ARTICLE_BEFORE_RE.test(t.slice(Math.max(0, at - 12), at))) continue;
    return m[1];
  }
  return undefined;
}

/**
 * The honest-line class of a claim verb (unbacked-claim's UnbackedClaimClass):
 * what the pre-delivery rewrite replaces the mismatched sentence with.
 * Send verbs → 'send'; close/update/schedule/file/merge/push verbs → 'change'.
 */
export const CLAIM_VERB_ACT_CLASS: Readonly<Record<string, 'send' | 'change' | 'read'>> = {
  ...Object.fromEntries(
    ['sent', 'messaged', 'pinged', 'notified', 'steered', 'relayed', 'dispatched', 'answered',
      'start_coding_session', 'send_chat_message', 'send_to_instance', 'dispatch_platform_task',
      'delegate', 'delegate_parallel', 'notify_user', 'send_email_as_digby', 'gmail_send_email',
      'answer_owner_question', 'answer_chat_question'].map((k) => [k, 'send' as const]),
  ),
  ...Object.fromEntries(
    ['filed', 'updated', 'pinned', 'armed', 'scheduled', 'closed', 'retired', 'resolved', 'merged',
      'pushed', 'withdrew', 'dismissed', 'flagged', 'archived',
      'schedule_message', 'update_schedule', 'flag_owner_question', 'file_feedback', 'triage_ticket',
      'resolve_feedback', 'update_feedback', 'update_supervisor_state', 'store_secret', 'stage_upload',
      'git_commit', 'git_push', 'open_pull_request', 'merge_pull_request', 'dismiss_owner_question',
      'todo_update', 'goal_update', 'goal_premise_set', 'goal_create', 'goal_list', 'todo_create',
      'todo_get', 'archive_chat'].map((k) => [k, 'change' as const]),
  ),
};

/** The honest-line class for a mapped verb; 'change' is the safe default (a mismatched verb is always an act). */
export function claimVerbActClass(verb: string | undefined): 'send' | 'change' | 'read' {
  if (!verb) return 'change';
  return CLAIM_VERB_ACT_CLASS[verb.toLowerCase()] ?? 'change';
}

/**
 * (ticket f05b38c1) OWN-ACT governance — does a mapped verb token govern a
 * claim as THIS note's own action? Two modes:
 *   ACTIVE (implicit or explicit first person): clause-initial ("Resolved
 *     duplicate ticket 9c307167 …", "- Retired both tickets"), a first-person
 *     subject directly before it ("I steered", "we filed"), or an "re-"
 *     compound at clause start ("re-armed the read-back"). An ACTIVE verb
 *     governs the ids that FOLLOW it in its clause (object position).
 *   PASSIVE-APPOSITION: a be/adverb bridge directly before it ("are pinned",
 *     "is now resolved", "was merged") — the acted-on subject precedes, so it
 *     governs the ids that PRECEDE it in its clause (the 05126597 shape
 *     "The fleet's two duplicates (93292353, 9c307167) are pinned …").
 * A verb with a THIRD-PARTY subject ("PR #75 merged", "todo 9c89ab21 closed
 * by lane cb941a0a", "One-shots armed", "outage resolved") is a REPORT of
 * another actor's work — neither mode, never governed. An article/possessive
 * before the token ("the armed schedule") is a participle in a noun phrase.
 * Pure.
 */
const FIRST_PERSON_BEFORE_RE = /\b(?:I|I've|Ive|we|we've|weve)\s+(?:have\s+|had\s+|already\s+)?$/i;
/** Copular ONLY (are/is/was/were/be/been/being, optionally followed by an adverb): "are pinned", "is now resolved", "was merged". A bare adverb ("now resolved") is a reduced passive STATE report of a third party, never an own-act claim. */
const PASSIVE_BRIDGE_BEFORE_RE = /\b(?:are|is|was|were|be|been|being)\s+(?:(?:now|already|formally|newly)\s+)?$/i;
const ARTICLE_BEFORE_RE = /\b(?:the|a|an|its|their|my|our|his|her|this|that)\s+$/i;
/**
 * (f05b38c1 review B1) A "by <agent>" phrase right after the verb token — a
 * THIRD-PARTY agentive passive ("Merged by the fleet", "was closed by lane
 * cb941a0a", "was retired by the on-call rotation"): another actor performed
 * the act, so the verb never governs this note's own claim — demote to
 * report. First-person agents ("by me/us/myself") stay own-act. The scan is
 * bounded at the next clause separator so a LATER clause's "by" never
 * demotes this verb. Pure. (ticket c7b408ef: exported for the sibling-act
 * scan — a third-party act token must not acquit a fabrication either.)
 */
const AGENTIVE_BY_RE = /\s+by\s+(?!me\b|us\b|myself\b)/i;
export function agentiveByAfterToken(t: string, at: number): boolean {
  const tokM = /^[A-Za-z_-]+/.exec(t.slice(at));
  if (!tokM) return false;
  const rest = t.slice(at + tokM[0].length);
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === '\n' || c === '.' || c === ';' || c === '—' || c === '–' || c === ':') { end = i; break; }
  }
  return AGENTIVE_BY_RE.test(rest.slice(0, end));
}
/** A "re-" compound ("re-armed") — the prefix is part of the verb, so governance is tested from the compound start. */
const RE_PREFIX_RE = /[a-z]+-$/i;

/** Clause start for the token at `at` (separators: . ! ? ; — – : " - " newline; parens do not split). */
function clauseStartBefore(t: string, at: number): number {
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = t[i];
    if (c === '\n') { start = i + 1; break; }
    if (c === ')' || c === '”' || c === '’' || c === '"' || c === ']' || c === '*' || c === '_') continue;
    const two = t.slice(i, i + 2);
    if (c === '.' || c === '!' || c === '?' || c === ';' || c === '—' || c === '–'
      || (c === ':' && !/\d/.test(t[i + 1] ?? '')) || two === ' - ') { start = i + 1; break; }
  }
  return start;
}

/** Only bullet/bold/quote/whitespace markers (or a bullet number "1." / "2)") between the clause start and the token — an implicit first person. Bare digits are NOT markers ("75 merged" is a count, not a bullet). */
const CLAUSE_LEAD_MARKERS_RE = /^(?:[\s*_>•\-#·\[\]("'‘“)\]]|\d+[.)])*$/;

/** Exported for tests: is the mapped token at `at` (optionally the tail of an "re-"/"pre-"/"un-" compound) an ACTIVE own-act verb? */
export function isOwnActActiveAt(t: string, at: number): boolean {
  let eff = at;
  const m = /\b(?:re|pre|un)-$/i.exec(t.slice(0, at));
  if (m) eff = at - m[0].length; // "re-armed" — the compound starts at the prefix
  // SERIES PARTICIPLE (ticket f05b38c1): a clause-initial verb whose NEXT
  // non-space char after the TOKEN is a comma or semicolon is an item of a
  // status enumeration ("— merged, deployed, regression-pinned, all boxes
  // live (ticket 13dfa16d…)"), not an act head — an act claim always carries
  // its object ("Merged PR #1634", "Resolved duplicate ticket 9c307167"); a
  // verb-first LIST of bare participles is a third-party status summary.
  // Fail toward miss.
  const tokM = /^[A-Za-z_-]+/.exec(t.slice(at));
  const afterTok = tokM ? t.slice(at + tokM[0].length).replace(/^[*_\s]+/, '') : '';
  if (/^(?:[,;])/.test(afterTok)) return false;
  // (f05b38c1 review B1) AGENTIVE PASSIVE: "Merged by the fleet", "closed by
  // lane cb941a0a" — a by-agent right after the verb names the OTHER actor
  // who performed it; the verb never governs this note's own claim.
  if (agentiveByAfterToken(t, at)) return false;
  const before = t.slice(Math.max(0, eff - 24), eff);
  if (FIRST_PERSON_BEFORE_RE.test(before)) return true;
  const clause = t.slice(clauseStartBefore(t, eff), eff);
  return CLAUSE_LEAD_MARKERS_RE.test(clause);
}

/** Exported for tests: is the mapped token at `at` a PASSIVE-APPOSITION own-act verb (be/adverb bridge before it)? */
export function isOwnActPassiveAt(t: string, at: number): boolean {
  const before = t.slice(Math.max(0, at - 24), at);
  if (!PASSIVE_BRIDGE_BEFORE_RE.test(before)) return false;
  // (f05b38c1 review B1) the copular bridge alone is not enough: an agentive
  // by-phrase after the verb ("was closed by lane cb941a0a") names the OTHER
  // actor — a third-party report, never this note's own claim.
  return !agentiveByAfterToken(t, at);
}

/** A clause separator (. ! ? ; — – : " - " newline, paren-depth 0) inside t[from,to) would split governance. */
export function clauseSeparatorBetween(t: string, from: number, to: number): boolean {
  for (let i = Math.max(0, from); i < Math.min(to, t.length); i++) {
    const c = t[i];
    if (c === '\n') return true;
    if (c === ')' || c === '”' || c === '’' || c === '"' || c === ']' || c === '*' || c === '_') continue;
    const two = t.slice(i, i + 2);
    if (c === '.' || c === '!' || c === '?' || c === ';' || c === '—' || c === '–'
      || (c === ':' && !/\d/.test(t[i + 1] ?? '')) || two === ' - ') return true;
  }
  return false;
}

/** A mapped token preceded by an article/possessive is a participle in a noun phrase, never an act. */
export function isParticipleAt(t: string, at: number): boolean {
  return ARTICLE_BEFORE_RE.test(t.slice(Math.max(0, at - 12), at));
}

/**
 * The first mapped verb of a DETAIL that GOVERNS the claim as the note's own
 * act (either mode; participles skipped). undefined when the detail narrates
 * no own-act verb — the verifier's verb-consistency veto then judges nothing
 * (the 5ad80b27 mercy: "re-ran the Gmail sweep … and updated the todo ledger"
 * has `updated` behind "and", a coordination, not an own-act clause head — no
 * governing verb, exoneration stands).
 */
export function governingClaimVerb(detail: string): string | undefined {
  const t = String(detail ?? '');
  if (!t) return undefined;
  const re = new RegExp(CLAIM_VERB_OR_NOUN_SRC, 'gi');
  for (const m of t.matchAll(re)) {
    const at = m.index ?? 0;
    if (isParticipleAt(t, at)) continue; // "the armed schedule"
    if (isOwnActActiveAt(t, at) || isOwnActPassiveAt(t, at)) return m[1];
  }
  return undefined;
}
