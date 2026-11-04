/**
 * HAND-BACK DETECTOR — a human ask handed back as a question.
 *
 * The class (owner transcripts, cohesive-chat program): the user asks for a
 * task, the answer ends by handing the work BACK — "say the word and I will
 * search her thread next", "the deck build is staged and waiting on your one
 * click — confirm the card", "shall I go ahead?", "let me know if you want me
 * to continue". The user already asked; nothing continues until they complain.
 * The task-lifecycle doctrine (rule task.lifecycle — core-doctrine.ts and the
 * chat playbook) admits THREE states for a human ask: DONE in the answer,
 * RUNNING with a visible task card, or STAGED on a confirmation card ONLY
 * because the action leaves this chat (a share link, a message to another
 * chat, an autonomy grant — the external-effect tools, which still card on a
 * human turn; the harness envelope itself tells the model to "ask them to
 * confirm … from the pending-action card"). A question is asked only when the
 * model genuinely cannot proceed (credentials, an ambiguous target, a choice
 * only the user can make) and says what it needs.
 *
 * Consumers:
 *   - the finalize LINT in chat-agent.service.ts (observe-only):
 *     one loop_metrics `handback_detected` row per
 *     human-turn final that ends in a hand-back while work remains.
 *   - NOT the continuation branch: chat-agent/turn-continuation.ts
 *     (classifyRunEnd) carries its OWN closing-text classifier with its own
 *     precedence (the user's information first, then confirmation hand-backs,
 *     then offers). The two are independent regex sets and can disagree; this
 *     leaf is the telemetry classifier and never gates anything. A merge that
 *     wants one verdict imports findHandback from that module and deletes the
 *     duplicate sets — until then the lint measures what the continuation
 *     decides from separately.
 *
 * PRECISION CONTRACT (mirrors phantom-tool-claim.ts / tool-call-leak.ts): the
 * detector must never fire on a genuine clarifying question, and it must not
 * fire on the doctrine's own proactive OFFER of a next step ("Want me to check
 * this again tomorrow morning and message you on Telegram?") — an offer after
 * a complete answer is not a hand-back of the asked work, whether or not the
 * run's deadline collapsed it.
 *
 *   STRONG idioms ("say the word", "give me the go-ahead", "shall I
 *   continue", "if you want me to proceed", …) fire only beside INCOMPLETENESS
 *   EVIDENCE — the same gate the soft idioms have always had (ticket
 *   18bce3f9, 2026-10-07): a WORK tool's staged card, step exhaustion, the
 *   deadline collapse WITH a continuation cue ("next", "the rest", "her
 *   thread", …), or the answer itself saying the work was cut short ("before
 *   tools cut off", "I did not get to …"). A bare continuation cue is NOT
 *   evidence ("natural next questions", "the rest of the letter" name a
 *   FRESH next step, not the unfinished half of the asked work) — it only
 *   upgrades a deadline collapse. Before this they fired on their own and the
 *   nightly audit re-filed the doctrine's own proactive offer ("Just say the
 *   word." closing three delivered captions) as a hand-back regression. The
 *   CONFIRM-THE-CARD family ("confirm the card", "waiting on your click",
 *   "staged and waiting", "once you confirm") is strong too — EXCEPT on a run
 *   whose only staged card belongs to an external-effect tool
 *   (HANDBACK_EXTERNAL_EFFECT_TOOLS): there the sentence is the third
 *   lifecycle state stated correctly, not a hand-back, and the family is not
 *   scanned.
 *   SOFT idioms ("shall I …", "want me to …", "would you like me to …", "let
 *   me know if you want me to …") fire only when work is EVIDENTLY left —
 *   the same evidence gate as the strong idioms (since 18bce3f9): the run's
 *   real step count reached the profile's maxSteps, a WORK tool
 *   (start_coding_session, schedule_message, …) sits STAGED behind a
 *   confirmation card in the run's parts, the answer itself says the work
 *   was cut short, or the deadline collapse carries a continuation cue. A
 *   deadline collapse ALONE is not evidence for a soft idiom — a collapsed
 *   run can still end in a complete answer plus an offer.
 *   An offer-shaped sentence about a FUTURE or RECURRING step ("tomorrow",
 *   "again", "next time", "every morning", "message you on Telegram", "a
 *   digest", …) with no continuation cue is the doctrine's offer and never
 *   fires. A segment that reads as a GENUINE need — "I need your …", "which …
 *   do you mean", credentials / a password / 2FA, "cannot proceed without", a
 *   two-option "A or B?" choice — is never a hand-back for the soft idioms.
 *
 * Position: only the CLOSING of the answer is scanned (the last few
 * sentence-ish segments after the follow-ups block, canvas blocks and harness
 * chrome are stripped) — a hand-back is how an answer ENDS. An idiom quoted
 * mid-answer (e.g. the model explaining what it will not say) does not fire.
 *
 * Staged cards are read from tool_result parts by NAME and by the top-level
 * envelope only ({ok:false, needsConfirmation:true} or {ok:false,
 * staged:true} as the harness mints it): a READ tool's result that merely
 * echoes staged rows (get_run_receipts, get_chat_messages, list_*) is never a
 * card. Tool rounds are the agent loop's REAL step count (AgentRunResult
 * .stepsUsed) — parts are pushed per call ([call, result, call, result, …]),
 * so a burst estimate from parts over-counts a batched round and is not used.
 *
 * KNOWN GAPS (accepted — the consumer is telemetry): a hand-back split across
 * two sentences with the idiom in the first evades the closing-window rule
 * only when the last segments are long; a quoted user message can fire; a run
 * that staged BOTH a work-tool card and an external-effect card keeps the
 * confirm family (the work-tool card is the hand-back).
 *
 * PURE LEAF: no imports (config/env process.exit()s at import in jest). The
 * only environment read is the kill switch, read at call time. The
 * external-effect tool set is HARD-LISTED here (the mirror of
 * platform/work-tools.ts EXTERNAL_EFFECT_TOOLS ∪ platform-tools.ts
 * NEVER_AUTONOMOUS_TOOLS); work-tools.test.ts pins the two sets in step once
 * that module lands.
 */

/**
 * Consequential tools whose effect leaves the user's own work: another chat,
 * a paired instance, the public web, another account, a bearer, or the
 * account's authority posture. These card on a human turn by contract, and
 * the answer is SUPPOSED to say "not done — confirm it from the card". Mirror
 * of platform/work-tools.ts EXTERNAL_EFFECT_TOOLS ∪ NEVER_AUTONOMOUS_TOOLS.
 */
export const HANDBACK_EXTERNAL_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'send_to_instance', 'dispatch_platform_task',
  'set_chat_autonomy', 'set_chat_instructions',
  'create_share_link', 'share_canvas', 'share_project', 'add_project_member', 'remove_project_member', 'create_chat_webhook',
  'stop_run', 'answer_chat_question', 'approve_request',
]);

/** A READ tool by name: its result can only ECHO staged rows, never be one. */
const READ_TOOL_NAME_RE = /^(?:get|list|search|read|fetch|describe|inspect|show|find|lookup|query|check|view)_/i;

/** Idioms that defer asked-for work regardless of run state (STRONG, general
 *  family — scanned on every run). Each entry is a whole-phrase regex; the
 *  matched text is the recorded phrase. */
export const HANDBACK_STRONG_GENERAL_RES: readonly RegExp[] = [
  /\bsay the word\b/i,
  /\bgive me the (?:go[- ]ahead|green light|nod|word)\b/i,
  /\bwhen(?:ever)? you(?:'re| are) ready,? (?:i|i'll|i will|just|say)\b/i,
  /\bjust (?:say|tell me) (?:so|go|the word|when)\b/i,
  /\b(?:if|whenever|when) you(?:'d like| want|'d prefer) me to (?:continue|proceed|go ahead|keep going|carry on|finish|resume|pick (?:it|this|that) (?:back )?up|take (?:it|this) further|dig (?:in|deeper|further)|go further|run it|kick (?:it|this) off|do (?:it|that|this))\b/i,
  /\blet me know (?:if|when|whether) you(?:'d like| want|'d prefer) me to (?:continue|proceed|go ahead|keep going|carry on|finish|resume|pick (?:it|this|that) (?:back )?up|take (?:it|this) further|dig (?:in|deeper|further)|go further|run it|kick (?:it|this) off|do (?:it|that|this))\b/i,
  /\b(?:shall|should|do you want me to|want me to|would you like me to) (?:i )?(?:continue|proceed|go ahead|keep going|carry on|finish(?: (?:it|this|that|up|the rest))?|resume|pick (?:it|this|that) (?:back )?up|go further|dig (?:in|deeper|further))\b/i,
];

/** The CONFIRM-THE-CARD family (STRONG) — a hand-back when the staged card
 *  is a WORK tool's; the correct third lifecycle state when the only staged
 *  card belongs to an external-effect tool (then NOT scanned). */
export const HANDBACK_CONFIRM_CARD_RES: readonly RegExp[] = [
  /\bconfirm (?:the|that|this|its|your) (?:card|pending action|pending card|action card|confirmation)\b/i,
  /\bconfirm (?:it|this|that) (?:from|on|in|via) the (?:card|sidebar|pending[- ]action(?:s)? card|management page)\b/i,
  /\bwaiting on your (?:one[- ])?(?:click|tap|confirm(?:ation)?|approval|go[- ]ahead|ok|okay|nod)\b/i,
  /\bstaged and waiting\b/i,
  /\b(?:once|when|after) you (?:confirm|approve|give (?:me )?the (?:go[- ]ahead|green light)|say (?:so|go|yes))\b/i,
];

/** Every strong idiom (general + confirm family) — the list scanned on a run
 *  with no external-effect card. */
export const HANDBACK_STRONG_RES: readonly RegExp[] = [...HANDBACK_STRONG_GENERAL_RES, ...HANDBACK_CONFIRM_CARD_RES];

/** Offer-shaped idioms — a hand-back only when work is evidently left (SOFT). */
export const HANDBACK_SOFT_RES: readonly RegExp[] = [
  /\bshall i\b/i,
  /\bshould i (?:go ahead|proceed|continue|run|search|pull|check|build|start|do)\b/i,
  /\b(?:do you )?want me to\b/i,
  /\bwould you like me to\b/i,
  /\blet me know (?:if|whether|when) you(?:'d like| want)\b/i,
  /\bhappy to (?:\w+ ){0,6}if you(?:'d like| want| say)\b/i,
  /\bi (?:can|could|'ll|will) (?:\w+ ){0,8}if you(?:'d like| want| prefer| say|'d prefer)\b/i,
];

/** A continuation cue inside the same segment: the sentence is about the
 *  REST of the asked work, not a fresh next step. ("next time / next week" is
 *  an offer cue, not a continuation cue.) */
const CONTINUATION_CUE_RE =
  /\b(?:next(?! (?:time|week|month|year|morning|evening))|the rest|remaining|continue|proceed|go[- ]ahead|keep going|carry on|finish|resume|pick (?:it|this|that) (?:back )?up|the other (?:two|three|four|\d+|threads?|files?|items?)|her thread|his thread|their threads?|those threads?)\b/i;

/** The doctrine's own OFFER of a next step: a future or recurring action, a
 *  notification, a digest — exempts a soft idiom that carries no
 *  continuation cue. */
export const HANDBACK_OFFER_CUE_RE =
  /\b(?:tomorrow|tonight|later today|again|next (?:time|week|month|year|morning|evening)|every (?:day|morning|evening|night|week|month|hour)|each (?:day|morning|evening|week|month)|daily|weekly|monthly|hourly|nightly|on telegram|via telegram|by telegram|message you|notify you|ping you|remind you|let you know|a (?:daily |weekly |morning )?digest|a reminder|schedule (?:it|this|that|one)|set (?:up )?a (?:schedule|reminder|feed|digest)|keep (?:an eye on|watching|tracking)|monitor (?:it|this|that)|track (?:it|this|that))\b/i;

/** A GENUINE need: the model cannot proceed without the user. Exempts the
 *  soft idioms (a strong idiom is never a genuine need). */
const GENUINE_NEED_RE =
  /\b(?:i(?:'ll| will)? need (?:your|the|a|an|you to)|i need (?:to know|one thing)|which (?:one|of (?:the|these|those)|account|project|file|folder|chat|version|deck|thread|person|address|email|number|card|repo|branch)\b.{0,60}\bdo you mean|do you mean\b|which do you (?:mean|want|prefer)|credentials?|password|passcode|api key|token|2fa|two[- ]factor|verification code|log(?:ged)? ?in|sign(?:ed)? ?in|can(?:not|'t) proceed without|can(?:not|'t) (?:continue|go further|do (?:this|that)) without|ambiguous|two (?:matches|accounts|people|candidates|options|results)|several (?:matches|accounts|people|candidates)|more than one (?:match|account|person|candidate)|only you can|your call|it(?:'s| is) your (?:decision|choice|call)|before i can (?:proceed|continue|start|do that|go further))\b/i;

/** "A or B?" — a two-option choice question (exempts soft idioms). */
const CHOICE_QUESTION_RE = /\b\w[\w'-]*(?: \w[\w'-]*){0,5} or \w[\w'-]*(?: \w[\w'-]*){0,5}\?/;

/** Mid-task evidence — the answer ITSELF says the asked work was cut short
 *  (ticket 18bce3f9's evidence gate; own copy of turn-continuation.ts's
 *  MID_TASK_* sets — this leaf stays import-free). The cut-off family is
 *  scanned over the WHOLE answer (a run that says its tools were cut off is
 *  incomplete wherever it says so); the unfinished family over the closing
 *  segments only. */
const MID_TASK_CUTOFF_RES: readonly RegExp[] = [
  /\b(before|when|until|because|as) (tools?|the run|time|my (turn|time)|this run|the (time|tool) budget) (cut|ran|were cut|was cut|timed|is|was) (off|out|up)\b/i,
  /\btools? (were |was |got )?cut off\b/i,
  /\bran out of (time|steps|tool calls|budget|turns)\b/i,
  /\b(before|until) i could (finish|complete|get to|do|run|check|search|read)\b/i,
];
const MID_TASK_UNFINISHED_RES: readonly RegExp[] = [
  /\bi (did not|didn't|could not|couldn't|have not|haven't) (yet )?(get to|reach|finish|complete|do|run|check|search|read|pull|open|cover)\b/i,
  /\b(still (need|have) to|left to do|remaining steps?|not (yet )?(done|finished|complete))\b/i,
  /\b(is|are) (still )?(pending|outstanding|unread|undone|unfinished)\b/i,
];

/** The mid-task marker that makes an idiom a hand-back: the cut-off family
 *  anywhere in the answer, the unfinished family in the closing. Pure. */
export function handbackMidTaskEvidence(finalText: string, closing: string): string | null {
  const whole = String(finalText ?? '');
  for (const re of MID_TASK_CUTOFF_RES) { const m = re.exec(whole); if (m) return m[0]; }
  for (const re of MID_TASK_UNFINISHED_RES) { const m = re.exec(String(closing ?? '')); if (m) return m[0]; }
  return null;
}

/** Strip the answer chrome the closing window must not read: the follow-ups
 *  block, canvas blocks and bracketed harness lines. */
export function stripAnswerChrome(text: string): string {
  return String(text || '')
    .replace(/\[FOLLOWUPS\][\s\S]*?\[\/FOLLOWUPS\]/gi, ' ')
    .replace(/\[CANVAS[^\]]*\][\s\S]*?\[\/CANVAS\]/gi, ' ')
    .split('\n')
    .filter((line) => !/^\s*\[/.test(line))
    .join('\n');
}

/** Sentence-ish segments of the CLOSING of an answer — the last `count`
 *  segments (lookbehind split, deterministic). Fragments under 12 chars are
 *  dropped (a bullet marker, a stray emoji line). */
export function closingSegments(text: string, count = 3): string[] {
  const segs = stripAnswerChrome(text)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 12);
  return segs.slice(-count);
}

export interface HandbackStoppedShort {
  /** profile.runDeadlineMs collapsed the run to its FINAL TURN. */
  deadlineHit: boolean;
  /** The agent loop's real step count (stepsUsed) reached the profile's maxSteps. */
  stepsExhausted: boolean;
  /** A WORK tool (start_coding_session, schedule_message, …) sits STAGED
   *  behind a confirmation card in the parts — work the run could have done. */
  stagedCard: boolean;
}

export interface HandbackFinding {
  /** The matched idiom text (what the metric records as `phrase`). */
  phrase: string;
  /** 'strong' = an idiom that only ever defers asked work; 'soft' = an offer
   *  shape that fired because work is evidently left. */
  strength: 'strong' | 'soft';
  /** The closing segment that carried the idiom, clipped for telemetry. */
  excerpt: string;
  /** Why work is evidently left (all false on a strong idiom with a clean run). */
  stoppedShort: HandbackStoppedShort;
  /** The segment carried a continuation cue ("next", "the rest", "finish" …). */
  continuationCue: boolean;
  /** An external-effect tool's confirmation card is staged in the parts (the
   *  confirm-the-card family was not scanned unless a work card is staged too). */
  externalCard: boolean;
}

export interface HandbackInput {
  /** The delivered final answer (chrome is stripped here — pass it raw or clean). */
  finalText?: string;
  /** The run's transcript parts (MessagePart[] shape; any input is tolerated). */
  parts?: unknown;
  /** AgentRunResult.deadlineHit — the deadline collapsed the run to its final turn. */
  deadlineHit?: boolean;
  /** AgentRunResult.stepsUsed — the agent loop's real step (tool-round) count. */
  stepsUsed?: number;
  /** The lead profile's maxSteps (tool rounds). Omit either number = no exhaustion signal. */
  maxSteps?: number;
}

export interface StagedCard {
  /** The tool whose call was staged. */
  tool: string;
  /** The tool is an external-effect tool (cards by contract on a human turn). */
  external: boolean;
}

/**
 * The confirmation cards STAGED in the run's parts: a tool_result part whose
 * NAME is a non-read tool and whose TOP-LEVEL envelope is the harness's
 * staging shape ({ok:false, needsConfirmation:true} or {ok:false,
 * staged:true}). A read tool's result echoing staged rows (get_run_receipts,
 * get_chat_messages, list_*) is never a card; an unparseable result is never
 * a card.
 */
export function stagedCards(parts: unknown): StagedCard[] {
  const out: StagedCard[] = [];
  if (!Array.isArray(parts)) return out;
  for (const p of parts as any[]) {
    if (p?.type !== 'tool_result') continue;
    const tool = typeof p.name === 'string' ? p.name.trim() : '';
    if (!tool || READ_TOOL_NAME_RE.test(tool)) continue;
    const raw = p.result ?? p.text ?? p.content;
    let env: any = raw;
    if (typeof raw === 'string') {
      try { env = JSON.parse(raw); } catch { continue; }
    }
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    if (env.ok !== false) continue;
    if (env.needsConfirmation !== true && env.staged !== true) continue;
    out.push({ tool, external: HANDBACK_EXTERNAL_EFFECT_TOOLS.has(tool) });
  }
  return out;
}

/** True when a WORK tool's confirmation card is staged in the parts (the
 *  stopped-short signal). An external-effect card alone answers false. */
export function hasStagedCard(parts: unknown): boolean {
  return stagedCards(parts).some((c) => !c.external);
}

/** The EARLIEST idiom in the segment (by position, not list order). */
function matchFirst(res: readonly RegExp[], seg: string): string | null {
  let best: { index: number; text: string } | null = null;
  for (const re of res) {
    const m = re.exec(seg);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, text: m[0] };
  }
  return best ? best.text : null;
}

/**
 * Find a hand-back in the closing of a final answer. Returns the first hit
 * (deterministic — closing segments in order) or null.
 *
 * Pure and total: any input shape returns a finding or null — never throws.
 */
export function findHandback(input: HandbackInput | null | undefined): HandbackFinding | null {
  try {
    if (!input) return null;
    const finalText = typeof input.finalText === 'string' ? input.finalText : '';
    if (!finalText.trim()) return null;
    const cards = stagedCards(input.parts);
    const stagedWork = cards.some((c) => !c.external);
    const externalCard = cards.some((c) => c.external);
    const stepsKnown =
      typeof input.stepsUsed === 'number' && Number.isFinite(input.stepsUsed) &&
      typeof input.maxSteps === 'number' && Number.isFinite(input.maxSteps) && input.maxSteps > 0;
    const stoppedShort: HandbackStoppedShort = {
      deadlineHit: input.deadlineHit === true,
      stepsExhausted: stepsKnown ? (input.stepsUsed as number) >= (input.maxSteps as number) : false,
      stagedCard: stagedWork,
    };
    // A deadline collapse alone is not evidence for a SOFT idiom (a collapsed
    // run can still end in a complete answer plus an offer) — it needs a cue.
    const hardEvidence = stoppedShort.stepsExhausted || stoppedShort.stagedCard;
    // The confirm-the-card family is the correct third lifecycle state when
    // the only staged card belongs to an external-effect tool.
    const strongRes = externalCard && !stagedWork ? HANDBACK_STRONG_GENERAL_RES : HANDBACK_STRONG_RES;

    // The evidence gate (ticket 18bce3f9, 2026-10-07): an idiom fires only
    // beside INCOMPLETENESS EVIDENCE — a WORK tool's staged card (the model
    // asked for a permission the harness never demanded), step exhaustion (the
    // loop hit maxSteps), the deadline collapse WITH a continuation cue, or
    // the answer ITSELF saying the work was cut short (mid-task evidence —
    // "I pulled the threads before tools cut off this run", "I did not get
    // to her thread"). Before this, STRONG idioms fired on their own and SOFT
    // idioms on a bare continuation cue: 13 of 14 live rows over 48 h were
    // the doctrine's own offer after a complete answer ("Just say the word."
    // closing three delivered captions; "Want me to dig deeper into any of
    // this?"; "Want me to draft the rest of the letter, or tailor this one?"
    // — "the rest" of a letter the user never asked to be written) with
    // deadlineHit=stepsExhausted=stagedCard=false — the detector was
    // re-filing its own precision contract ("must not fire on the doctrine's
    // own proactive OFFER") as a nightly regression. The gate mirrors
    // turn-continuation.ts classifyRunEnd, which gates the same idiom
    // families behind deadline / open-plan / cut-off evidence and never armed
    // a continuation on any of those rows. A continuation cue ALONE is not
    // evidence — "next questions" / "the rest of the letter" name a FRESH
    // next step, not the unfinished half of the asked work; the cue only
    // upgrades a deadline collapse into evidence.
    const segs = closingSegments(finalText);
    const closing = segs.join(' ');
    const midTask = handbackMidTaskEvidence(finalText, closing);

    for (const seg of segs) {
      const strong = matchFirst(strongRes, seg);
      const continuationCue = CONTINUATION_CUE_RE.test(seg);
      const deadlineCue = stoppedShort.deadlineHit && continuationCue;
      const evidence = hardEvidence || deadlineCue || midTask != null;
      if (strong) {
        if (evidence) {
          return { phrase: strong, strength: 'strong', excerpt: seg.slice(0, 200), stoppedShort, continuationCue, externalCard };
        }
        continue;
      }
      const soft = matchFirst(HANDBACK_SOFT_RES, seg);
      if (!soft) continue;
      // A real question, not a hand-back: a stated need, or an "A or B?" choice
      // that is not about continuing the asked work ("search her thread next,
      // or leave it?" keeps its continuation cue and stays a hand-back).
      if (GENUINE_NEED_RE.test(seg)) continue;
      if (CHOICE_QUESTION_RE.test(seg) && !continuationCue) continue;
      // The doctrine's own offer of a future / recurring next step.
      if (HANDBACK_OFFER_CUE_RE.test(seg) && !continuationCue) continue;
      if (evidence) {
        return { phrase: soft, strength: 'soft', excerpt: seg.slice(0, 200), stoppedShort, continuationCue, externalCard };
      }
    }
    return null;
  } catch {
    return null; // a detector must never break the finalize path
  }
}
