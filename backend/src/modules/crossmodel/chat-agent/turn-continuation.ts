/**
 * Turn continuation (cohesive-chat wave, 2026-09-28 — owner: "when someone
 * asks for a task … it does it automatically and returns results").
 *
 * A HUMAN turn whose run ends mid-task — the FINAL-TURN deadline / step cap
 * collapsed it with plan steps still open, or the model's closing text hands
 * the rest of the work back as an offer ("say the word and I will search her
 * thread next") or a confirmation prompt ("waiting on your one click — confirm
 * the card") — is NOT finished. Before this module the run simply ended there
 * and nothing moved until the owner complained. Now the harness:
 *   (a) arms a background CONTINUATION of the SAME chat — a one-shot machine
 *       firing through the busy-chat queue (pending_chat_messages source
 *       'schedule' + a PendingSendOrigin.continuation stash; the finishing
 *       run's finally drains it at once), never a new sub-session — capped at
 *       CONTINUATION_MAX_ROUNDS per human ask;
 *   (b) rewrites the closing text deterministically: the handback sentence(s)
 *       go, one line "Still working on this — I will post the result here."
 *       stays (never a question back);
 *   (c) emits / persists the task card (task-events.ts) kind 'continuation';
 *   (d) the continuation posts its answer as a NEW assistant message and the
 *       card flips to done (resultMessageId) — or failed with an honest line.
 * A genuine clarifying question the user must answer (credentials, an
 * ambiguous target, an either/or the model cannot decide) is LEFT ALONE:
 * status waiting_user, no continuation. Machine wakes never auto-continue —
 * they have schedules.
 *
 * An OFFER alone is never a hand-back (review fix 1): the chat doctrine asks
 * the model to END every answer with one proactive offer ("Want me to check
 * this again tomorrow?") and ordinary sign-offs ("let me know if you have
 * questions") look the same — treating them as mid-task would rewrite a
 * COMPLETE answer to "Still working on this" and run work nobody asked for.
 * An offer continues only beside independent evidence that the ask is
 * unfinished: the run's FINAL-TURN deadline fired, a plan written this run
 * still has open steps, or the text itself says the work was cut short
 * (midTaskEvidence — "before tools cut off", "I did not get to …"). A
 * confirmation hand-back ("confirm the card") is the STAGED-tool case: a
 * machine round can never confirm a card, so it is never armed — the card is
 * reported as waiting_user (review fix 2).
 *
 * Everything here is deterministic (regex over the closing sentences + the
 * plan's step states); the two owner transcripts pin it in
 * turn-continuation.test.ts. Kill switches: TURN_CONTINUATION_DISABLED=1
 * (nothing is detected, rewritten or armed), CONTINUATION_MAX_ROUNDS (default
 * 3; 0 = detect + rewrite nothing, arm nothing). Telemetry: loop_metrics
 * `turn_continuation` { chatId, round, reason, outcome }.
 */
import { randomUUID } from 'crypto';
import type { CodingPlan } from '../coding/plan.service';

export const CONTINUATION_LINE = 'Still working on this — I will post the result here.';
export const CONTINUATION_CAP_LINE = 'I have used the automatic continuation budget for this ask — this is where it stands; send a message and I will pick it up from here.';
export const CONTINUATION_FAILED_LINE = 'The background continuation of this task failed before it could finish — send a message and I will pick it up from here.';
/** A round the user STOPPED (review fix 6): never "finished", never a push. */
export const CONTINUATION_STOPPED_LINE = 'Stopped before it finished — send a message to resume.';
/** A round dropped because the user sent a newer message (review fix 5): their turn owns the ask now. */
export const CONTINUATION_SUPERSEDED_LINE = 'Your newer message took over — reply if you still want this finished.';
export const CONTINUATION_RESULT_KIND = 'continuation_result';
export const CONTINUATION_TASK_TITLE = 'Finishing your task';
export const CONTINUATION_MAX_ROUNDS_DEFAULT = 3;
export const CONTINUATION_PROMPT_PREFIX = '[HARNESS CONTINUATION';

export type ContinuationReason =
  | 'offer_to_continue'
  | 'confirmation_handback'
  | 'deadline_unfinished_plan'
  | 'deadline_mid_task'
  | 'unfinished_plan'
  /** build 2026-10-08 A1 (owner-answer-first.ts): an OWNER turn on a supervisor chat was answered at the soft deadline; the rest is the follow-through. */
  | 'answer_first_split';
export type WaitingReason = 'clarifying_question' | 'credentials' | 'ambiguous_target';

export type RunEndVerdict =
  | { kind: 'continue'; reason: ContinuationReason; matched?: string }
  | { kind: 'waiting_user'; reason: WaitingReason; matched?: string }
  | { kind: 'done' };

export function turnContinuationDisabled(): boolean {
  return process.env.TURN_CONTINUATION_DISABLED === '1';
}

/** audit 2026-10-08 W4-1c: CONTINUATION_DEADLINE_CORROBORATION_DISABLED=1 ⇒ a deadline hit alone makes an offer a hand-back again. */
export function deadlineCorroborationDisabled(): boolean {
  return process.env.CONTINUATION_DEADLINE_CORROBORATION_DISABLED === '1';
}

/** CONTINUATION_MAX_ROUNDS, default 3, clamped to [0, 10]; a blank / NaN env reads as the default. */
export function continuationMaxRounds(): number {
  const raw = process.env.CONTINUATION_MAX_ROUNDS;
  if (raw == null || raw.trim() === '') return CONTINUATION_MAX_ROUNDS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CONTINUATION_MAX_ROUNDS_DEFAULT;
  return Math.max(0, Math.min(10, Math.floor(n)));
}

// ── Closing-text patterns ──────────────────────────────────────────────────
// Each list is tested against the CLOSING (the last three sentences of the
// last paragraph) only — an offer buried mid-answer ("I could also check X")
// is prose, not a handback. Order of precedence (classifyRunEnd): the user's
// own information first (credentials → ambiguous target), then the handbacks
// (confirmation → offer), then the plan state, then a plain clarifying question.

const CONTINUE_VERBS = 'continue|proceed|go ahead|keep going|carry on|search|pull|dig|check|run|start|do|look|read|draft|build|finish|fetch|open|scan|send it|write|compile|generate|expand|follow up|investigate|verify';

const OFFER_CUES: RegExp[] = [
  /\bsay the word\b/i,
  /\bjust (say|tell me)( so| the word)?\b/i,
  new RegExp(`\\b(shall|should|can|could|do you want|would you like|want|like) (me to |i )?(also )?(${CONTINUE_VERBS})\\b`, 'i'),
  /\b(let me know|tell me)\b[^.?!\n]{0,80}\b(if|when|whether|once|and) (you|i should|you'?d|to)\b/i,
  /\bnext,? i ('ll|will|can|could|would)\b/i,
  new RegExp(`\\bi ('ll|will|can|could|would|am happy to|am ready to) (${CONTINUE_VERBS})\\b[^.?!\\n]{0,120}\\b(next|if you|once you|when you|whenever you|on your (word|go|say|signal)|as soon as you)\\b`, 'i'),
  /\b(before|when|until|because|as) (tools?|the run|time|my (turn|time)|this run|the (time|tool) budget) (cut|ran|were cut|was cut|timed|is|was) (off|out|up)\b/i,
  /\bgive me the (go(-| )?ahead|word|green light|nod|signal)\b/i,
  /\bon your (go|word|say(-| )?so|signal|command)\b/i,
  /\bready when you are\b/i,
  /\b(if|whenever) you('d| would)? (like|want|prefer),? i (can|will|'ll|could)\b/i,
  /\bwant me to (go on|keep going|continue|proceed|do that|take that on|handle (it|that))\b/i,
  /\bi (can|could|'ll|will) (pick|take) (that|this|it) up\b[^.?!\n]{0,60}\b(if|when|once) you\b/i,
];

const CONFIRMATION_CUES: RegExp[] = [
  /\bconfirm the card\b/i,
  /\bwaiting (on|for) your (one[- ])?(click|tap|confirm(ation)?|approval|go(-| )?ahead|ok|okay)\b/i,
  /\bstaged and waiting\b/i,
  /\b(tap|click|hit|press) (confirm|approve|the card|the button|approve on the card)\b/i,
  /\bawaiting your (confirmation|approval|go(-| )?ahead|click)\b/i,
  /\bonce you (confirm|approve|tap|click)\b/i,
  /\b(needs?|requires?) your (confirmation|approval|one click|click|tap)\b/i,
  /\b(is|are) staged\b[^.?!\n]{0,80}\b(confirm|approve|click|tap)\b/i,
];

/**
 * Independent evidence that the ask is UNFINISHED, read from the text itself
 * (review fix 1). Two families: the cut-off family is scanned over the WHOLE
 * answer (a run that says its tools were cut off is incomplete wherever it
 * says so); the unfinished family over the closing only ("I did not get to
 * her thread"). Never an offer verb — offers are the thing being gated.
 */
const MID_TASK_CUTOFF_CUES: RegExp[] = [
  /\b(before|when|until|because|as) (tools?|the run|time|my (turn|time)|this run|the (time|tool|step) budget|the deadline) (cut|ran|were cut|was cut|timed|is|was|hit) (off|out|up)\b/i,
  /\btools? (were |was |got )?cut off\b/i,
  /\bran out of (time|steps|tool calls|budget|turns)\b/i,
  /\b(the )?(time|step|tool) (budget|limit) (ended|ran out|was reached|is up|hit)\b/i,
  /\b(before|until) i could (finish|complete|get to|do|run|check|search|read)\b/i,
];
const MID_TASK_UNFINISHED_CUES: RegExp[] = [
  /\bi (did not|didn't|could not|couldn't|have not|haven't) (yet )?(get to|reach|finish|complete|do|run|check|search|read|pull|open|cover)\b/i,
  /\b(still (need|have) to|left to do|remaining steps?|not (yet )?(done|finished|complete))\b/i,
  /\b(the rest|what remains|the remaining \w+) (is|are) (still )?(pending|outstanding|to do|undone)\b/i,
];

/** The mid-task marker that makes an offer a hand-back (the cut-off family anywhere in the answer, the unfinished family in the closing), or null. */
export function midTaskEvidence(finalText: string, closing: string): string | null {
  const whole = String(finalText ?? '');
  return firstMatch(MID_TASK_CUTOFF_CUES, whole) ?? (closing ? firstMatch(MID_TASK_UNFINISHED_CUES, closing) : null);
}

const CREDENTIAL_CUES: RegExp[] = [
  /\b(password|passcode|passphrase|credentials?|api key|access token|auth token|2fa|two[- ]factor|verification code|one[- ]time code|login details|sign[- ]in details|otp)\b/i,
];

const AMBIGUOUS_TARGET_CUES: RegExp[] = [
  /\b(which|what)\b[^.?!\n]{0,120}\b(one|ones|account|repo|repository|repositories|project|projects|file|files|thread|threads|person|people|contact|contacts|email|address|target|version|environment|branch|chat|option|format|date|name|folder|table|dataset|model|language|region|currency|team|channel|workspace|sheet|document|deck|slide|spreadsheet|calendar|inbox|mailbox|approach)s?\b[^.?!\n]{0,120}\?/i,
  /\b(do|did) you mean\b/i,
  /\b(could|can|would) you (please )?(clarify|specify|confirm which|tell me which|tell me what|point me (to|at))\b/i,
  /\bwho (do you|should i|do i)\b[^.?!\n]{0,80}\?/i,
  /\b(do you want|would you like|would you prefer|do you prefer|should (i|it be|this be))\b[^.?!\n]{0,120}\bor\b[^.?!\n]{0,120}\?/i,
  /\bwhich (do you|would you|should i)\b/i,
  /\b(need|needs) (you to|your) (choice|decision|pick|input on which)\b/i,
  /\b(i (need|require)|please) (you to )?(tell|give|send|share) me\b[^.?!\n]{0,60}\b(which|what|who|where|the (name|id|address|url|link))\b/i,
];

const CLARIFY_CUES: RegExp[] = [
  /\b(what|which|who|where|when|how many|how much|how should|how would you like)\b[^.?!\n]{0,140}\?/i,
  /\b(can|could|would) you (send|share|paste|provide|upload|give me|attach|forward)\b[^.?!\n]{0,120}\?/i,
  /\bi('ll| will)? need (you to|your|the)\b[^.?!\n]{0,120}\b(before|so that|to) i can\b/i,
];

/** Lower-cases nothing; returns the closing: the last paragraph's last three sentences (≤ 800 chars). */
export function closingText(text: string): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  const sentences = splitSentences(last);
  return sentences.slice(-3).join(' ').slice(-800);
}

/** Sentence split that keeps the terminal punctuation on each sentence. */
export function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  const re = /[^.?!\n]+(?:[.?!]+["')\]]*|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

const firstMatch = (cues: RegExp[], text: string): string | null => {
  for (const re of cues) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
};

export interface RunEndInput {
  /** The final answer text (post-parse, pre-persist). */
  finalText: string;
  /** coding/agent.ts AgentRunResult.deadlineHit — the run's FINAL TURN was forced. */
  deadlineHit?: boolean;
  /** Plan steps still pending / in_progress at the end of the run. */
  unfinishedSteps?: number;
  /** The plan was written THIS run (plan.updatedAt ≥ run start) — a stale plan from an earlier turn never counts. */
  planTouchedThisRun?: boolean;
}

/**
 * The deterministic verdict on how a run ended. Precedence: the user's own
 * information (credentials, an ambiguous target) → a confirmation handback →
 * an offer to continue (ONLY beside incompleteness evidence: the deadline, an
 * open plan written this run, or a mid-task marker in the text — an offer
 * without it is the doctrine's proactive offer / a sign-off ⇒ done) → the
 * deadline over an unfinished plan → an unfinished plan → a plain clarifying
 * question → done.
 */
export function classifyRunEnd(input: RunEndInput): RunEndVerdict {
  const closing = closingText(input.finalText);
  const unfinished = Math.max(0, Math.floor(Number(input.unfinishedSteps) || 0));
  const planOpen = unfinished > 0 && input.planTouchedThisRun === true;
  if (closing) {
    const cred = firstMatch(CREDENTIAL_CUES, closing);
    if (cred && (/\?/.test(closing) || /\b(need|needs|provide|share|send|enter|give|paste|supply)\b/i.test(closing))) {
      return { kind: 'waiting_user', reason: 'credentials', matched: cred };
    }
    const ambiguous = firstMatch(AMBIGUOUS_TARGET_CUES, closing);
    if (ambiguous) return { kind: 'waiting_user', reason: 'ambiguous_target', matched: ambiguous };
    const confirmation = firstMatch(CONFIRMATION_CUES, closing);
    if (confirmation) return { kind: 'continue', reason: 'confirmation_handback', matched: confirmation };
    const offer = firstMatch(OFFER_CUES, closing);
    if (offer) {
      // audit 2026-10-08 W4-1c: the deadline ALONE is no longer evidence — a forced FINAL TURN usually writes a
      // COMPLETE answer (the notice tells the model to deliver and to say plainly what remains), and its proactive
      // offer then read as a hand-back: prod 10-08 16:15Z a finished answer was rewritten to "Still working on this"
      // and the continuation answered a different question, contradicting it. With the deadline hit the offer
      // continues only beside an open plan written this run or a mid-task marker in the text.
      // CONTINUATION_DEADLINE_CORROBORATION_DISABLED=1 restores "deadline alone is evidence".
      const midTask = midTaskEvidence(input.finalText, closing) != null;
      const deadlineCounts = input.deadlineHit === true && (deadlineCorroborationDisabled() || planOpen || midTask);
      const evidence = deadlineCounts || planOpen || midTask;
      if (evidence) return { kind: 'continue', reason: deadlineCounts ? 'deadline_mid_task' : 'offer_to_continue', matched: offer };
    }
  }
  if (planOpen && input.deadlineHit) return { kind: 'continue', reason: 'deadline_unfinished_plan' };
  if (planOpen) return { kind: 'continue', reason: 'unfinished_plan' };
  if (closing) {
    const clarify = firstMatch(CLARIFY_CUES, closing);
    if (clarify) return { kind: 'waiting_user', reason: 'clarifying_question', matched: clarify };
  }
  return { kind: 'done' };
}

const HANDBACK_CUES = [...CONFIRMATION_CUES, ...OFFER_CUES];

/**
 * (b) The deterministic rewrite: drop every sentence of the LAST paragraph
 * that carries a handback cue (an offer / a confirmation prompt) — the rest of
 * the answer (the partial result) stays byte-identical — and append the one
 * continuation line. Never yields a trailing question: a last paragraph that
 * still ends in '?' after the cue sentences are gone is dropped too.
 */
export function rewriteClosingText(finalText: string, line: string = CONTINUATION_LINE): string {
  const trimmed = String(finalText ?? '').trim();
  if (!trimmed) return line;
  const paragraphs = trimmed.split(/\n\s*\n/);
  const lastIdx = paragraphs.length - 1;
  const last = paragraphs[lastIdx].trim();
  if (last === line) return trimmed; // idempotent — already rewritten
  const kept = splitSentences(last).filter((s) => !HANDBACK_CUES.some((re) => re.test(s)));
  let rebuilt = kept.join(' ').trim();
  if (rebuilt && /\?\s*$/.test(rebuilt)) rebuilt = '';
  const head = paragraphs.slice(0, lastIdx).join('\n\n').trim();
  const body = [head, rebuilt].filter(Boolean).join('\n\n').trim();
  return body ? `${body}\n\n${line}` : line;
}

const reasonText: Record<ContinuationReason, string> = {
  offer_to_continue: 'your closing text offered to continue instead of finishing',
  confirmation_handback: 'your closing text waited for the user to confirm a staged action',
  deadline_unfinished_plan: 'the time budget ended the turn with plan steps still open',
  deadline_mid_task: 'the time budget ended the turn while you were mid-task',
  unfinished_plan: 'the turn ended with plan steps still open',
  answer_first_split: 'the harness answered the owner first at the answer deadline and moved the remaining work to this follow-through',
};

export interface ContinuationPromptInput {
  round: number;
  maxRounds: number;
  reason: ContinuationReason;
  /** The human's original ask (the user turn that started the task). */
  askText: string;
  /** The previous answer BEFORE the rewrite — where the model stopped. */
  previousAnswer: string;
  plan?: CodingPlan | null;
  /** The stash the round runs under — its fields ride the marker so a lost Redis stash is recoverable from the row (review fix 4). */
  stash?: Pick<ContinuationRun, 'taskId' | 'ofMessageId' | 'reason' | 'startedAt' | 'askMessageId' | 'answerFirst'>;
  /** build 2026-10-08 A1: a harness note appended to the prompt (the answer-first follow-through brief). */
  extraNote?: string;
}

/**
 * The one-shot machine prompt the continuation round runs on. Carries the
 * round marker (the cap regex), the plan state (open steps), the original ask
 * and the tail of the previous answer — never asks the model to narrate.
 */
export function continuationPrompt(input: ContinuationPromptInput): string {
  const open = (input.plan?.steps ?? []).filter((s) => s.status === 'pending' || s.status === 'in_progress');
  const planLines = open.length
    ? `Open plan steps:\n${open.map((s) => `- [${s.status}] #${s.id} ${s.text}`).join('\n')}`
    : 'No plan steps are recorded — finish the task described below.';
  const ask = String(input.askText ?? '').trim().replace(/\s+/g, ' ').slice(0, 600);
  const tail = String(input.previousAnswer ?? '').trim().replace(/\s+/g, ' ').slice(-700);
  // The marker carries the stash fields (review fix 4): the Redis origin stash
  // is best-effort, and a row whose stash is lost must still drain as a
  // CONTINUATION (never as a machine wake) and settle its card.
  const stashFields = input.stash
    ? ` task=${input.stash.taskId} of=${input.stash.ofMessageId} reason=${input.stash.reason} since=${input.stash.startedAt}${input.stash.askMessageId ? ` ask=${input.stash.askMessageId}` : ''}${input.stash.answerFirst ? ` af=${Math.max(0, Math.floor(Number(input.stash.answerFirst.resumes) || 0))}` : ''}`
    : '';
  return [
    `${CONTINUATION_PROMPT_PREFIX} r${input.round}/${input.maxRounds}${stashFields}] — not typed by the user. Your previous turn on this chat ended before the task was finished (${reasonText[input.reason]}). Nobody is on this turn: the user will NOT answer a question, confirm a card or "say the word". Resume the task you were doing and FINISH it now with tools this run — do not ask for permission, do not offer next steps, do not hand the task back. When done, LEAD with the result (the answer itself, files, links, ids) so a reader who sees only this message receives the work. If something genuinely requires information only the user can give (credentials, an ambiguous choice between named options), stop and ask ONE precise question — nothing else.`,
    planLines,
    ask ? `Original ask: "${ask}"` : '',
    tail ? `Where you stopped: "${tail}"` : '',
    String(input.extraNote ?? '').trim(),
  ].filter(Boolean).join('\n\n');
}

const CONTINUATION_REASONS: ReadonlySet<string> = new Set<ContinuationReason>(['offer_to_continue', 'confirmation_handback', 'deadline_unfinished_plan', 'deadline_mid_task', 'unfinished_plan', 'answer_first_split']);

export interface ParsedContinuationMarker {
  round: number; max: number;
  taskId?: string; ofMessageId?: string; reason?: ContinuationReason; startedAt?: string; askMessageId?: string;
  /** build 2026-10-08 A1: the answer-first resume count (` af=<n>`) — present ⇒ a supervisor follow-through round. */
  answerFirstResumes?: number;
}

/** Round marker parse — the cap holds on the marker even when the stash is lost; the stash fields (when the marker carries them) come back too. */
export function parseContinuationRound(prompt: string): ParsedContinuationMarker | null {
  const m = /\[HARNESS CONTINUATION r(\d+)\/(\d+)([^\]\n]*)\]/.exec(String(prompt ?? ''));
  if (!m) return null;
  const out: ParsedContinuationMarker = { round: Number(m[1]), max: Number(m[2]) };
  const fields = m[3] || '';
  const field = (k: string): string | undefined => { const f = new RegExp(`\\b${k}=(\\S+)`).exec(fields); return f ? f[1] : undefined; };
  const taskId = field('task'); const of = field('of'); const reason = field('reason'); const since = field('since'); const ask = field('ask'); const af = field('af');
  if (taskId) out.taskId = taskId;
  if (of) out.ofMessageId = of;
  if (reason && CONTINUATION_REASONS.has(reason)) out.reason = reason as ContinuationReason;
  if (since && Number.isFinite(new Date(since).getTime())) out.startedAt = since;
  if (ask) out.askMessageId = ask;
  if (af != null && /^\d+$/.test(af)) out.answerFirstResumes = Number(af);
  return out;
}

/**
 * Rebuild the continuation stash from a queued row whose Redis stash is gone
 * (review fix 4): the marker's fields + the prompt's "Original ask" line.
 * null when the row is not a continuation or its marker predates the stash
 * fields — the caller then settles the card by lookup instead of running the
 * prompt as a machine wake.
 */
export function recoverContinuationFromPrompt(prompt: string, fallback: { startedAt: Date }): ContinuationRun | null {
  const m = parseContinuationRound(prompt);
  if (!m || !m.taskId || !m.ofMessageId) return null;
  const askMatch = /Original ask: "([^"\n]*)"/.exec(String(prompt ?? ''));
  return {
    taskId: m.taskId, round: m.round, maxRounds: m.max, reason: m.reason ?? 'unfinished_plan', ofMessageId: m.ofMessageId,
    ...(m.askMessageId ? { askMessageId: m.askMessageId } : {}),
    startedAt: m.startedAt ?? fallback.startedAt.toISOString(),
    askText: (askMatch?.[1] ?? '').slice(0, 600),
    ...(m.answerFirstResumes != null ? { answerFirst: { resumes: m.answerFirstResumes } } : {}),
  };
}

/** True when a queued row is a continuation round (its content carries the marker). */
export function isContinuationPrompt(prompt: string): boolean {
  return String(prompt ?? '').startsWith(CONTINUATION_PROMPT_PREFIX);
}

/** The continuation stash a queued firing carries (PendingSendOrigin.continuation → ChatAgentRunArgs.continuation). */
export interface ContinuationRun {
  taskId: string;
  round: number;
  maxRounds: number;
  reason: ContinuationReason;
  /** The assistant row of the human turn that started the task — the card lives there. */
  ofMessageId: string;
  /** The human's user row (when persisted). */
  askMessageId?: string;
  /** ISO — when round 1 was armed. */
  startedAt: string;
  /** The original ask (≤ 600 chars) — re-threaded each round so the prompt never depends on history depth. */
  askText: string;
  /**
   * build 2026-10-08 A1 (owner-answer-first.ts): set on a SUPERVISOR follow-through — the owner turn was answered at
   * the soft deadline and this task carries the rest. `resumes` = re-queues after an owner message preempted a round
   * (capped); `done` = the answer turn's mutating-call signatures (the duplicate-dispatch accounting); `items` = the
   * answer's "Follow-through:" line. Such a round is never superseded by a newer owner message — it runs after it.
   */
  answerFirst?: { resumes: number; done?: string[]; items?: string | null };
}

/**
 * Whether ANOTHER round may be armed after a continuation round ended with
 * `verdict`. The cap holds (round ≥ maxRounds ⇒ no), ANY confirmation
 * handback is a waiting_user state (a machine run can never confirm a card —
 * re-running would only re-stage it; review fix 2), and anything but a
 * 'continue' verdict stops.
 */
export function nextContinuationRound(prev: ContinuationRun, verdict: RunEndVerdict): { round: number } | { stop: 'cap' | 'waiting_user' | 'done' } {
  if (verdict.kind !== 'continue') return { stop: verdict.kind === 'waiting_user' ? 'waiting_user' : 'done' };
  if (verdict.reason === 'confirmation_handback') return { stop: 'waiting_user' };
  if (prev.round >= prev.maxRounds) return { stop: 'cap' };
  return { round: prev.round + 1 };
}

export interface ArmContinuationInput {
  chatId: string;
  userId: string;
  /** The level the continuation runs at — the human turn's resolved mode. */
  mode: string;
  reason: ContinuationReason;
  askText: string;
  previousAnswer: string;
  plan?: CodingPlan | null;
  ofMessageId: string;
  askMessageId?: string;
  /** Round 1 mints a fresh task; a later round carries the previous stash. */
  prev?: ContinuationRun;
  /** build 2026-10-08 A1: the answer-first stash (round 1 mints it; a later round passes the merged one, else prev's is kept). */
  answerFirst?: ContinuationRun['answerFirst'];
  /** build 2026-10-08 A1: appended to the round's prompt (continuationPrompt extraNote). */
  extraNote?: string;
}

export interface ArmContinuationDeps {
  enqueue: (args: { chatId: string; userId: string; content: string; mode: string; source: 'schedule'; origin: { kind: 'schedule'; continuation: ContinuationRun } }) => Promise<{ id: string }>;
  now?: () => Date;
}

/**
 * (a) Arm the next round: a pending_chat_messages row (source 'schedule')
 * carrying the continuation stash — the finishing run's finally drains it
 * into a machine run of the SAME chat. Returns the stash the round runs
 * under, or null when nothing was armed (disabled / cap 0 / cap reached).
 * The enqueue is the caller's (message-queue.service); a throw propagates so
 * the caller can record outcome 'arm_failed' — never swallowed here.
 */
export async function armTurnContinuation(input: ArmContinuationInput, deps: ArmContinuationDeps): Promise<ContinuationRun | null> {
  if (turnContinuationDisabled()) return null;
  const maxRounds = input.prev?.maxRounds ?? continuationMaxRounds();
  if (maxRounds <= 0) return null;
  const round = input.prev ? input.prev.round + 1 : 1;
  if (round > maxRounds) return null;
  const now = (deps.now ?? (() => new Date()))();
  const stash: ContinuationRun = {
    taskId: input.prev?.taskId ?? randomUUID(),
    round,
    maxRounds,
    reason: input.reason,
    ofMessageId: input.prev?.ofMessageId ?? input.ofMessageId,
    ...(input.prev?.askMessageId ?? input.askMessageId ? { askMessageId: input.prev?.askMessageId ?? input.askMessageId } : {}),
    startedAt: input.prev?.startedAt ?? now.toISOString(),
    askText: (input.prev?.askText ?? input.askText ?? '').slice(0, 600),
    // The caller's answerFirst wins (a later round passes the merged done list); else the previous round's.
    ...((input.answerFirst ?? input.prev?.answerFirst) ? { answerFirst: (input.answerFirst ?? input.prev?.answerFirst)! } : {}),
  };
  const content = continuationPrompt({ round, maxRounds, reason: input.reason, askText: stash.askText, previousAnswer: input.previousAnswer, plan: input.plan, stash, ...(input.extraNote ? { extraNote: input.extraNote } : {}) });
  await deps.enqueue({ chatId: input.chatId, userId: input.userId, content, mode: input.mode, source: 'schedule', origin: { kind: 'schedule', continuation: stash } });
  return stash;
}

/** Plan counters for the task card: completed / total (0/0 without a plan). */
export function planStepCounts(plan: CodingPlan | null | undefined): { done: number; total: number } {
  const steps = plan?.steps ?? [];
  return { done: steps.filter((s) => s.status === 'completed').length, total: steps.length };
}

/** Unfinished (pending / in_progress) step count — the detector's plan input. */
export function planUnfinishedCount(plan: CodingPlan | null | undefined): number {
  return (plan?.steps ?? []).filter((s) => s.status === 'pending' || s.status === 'in_progress').length;
}

/** True when the plan was written at or after `runStartedAtMs` (a stale plan from an earlier turn never re-arms). */
export function planTouchedSince(plan: CodingPlan | null | undefined, runStartedAtMs: number): boolean {
  if (!plan?.updatedAt) return false;
  const t = new Date(plan.updatedAt).getTime();
  return Number.isFinite(t) && t >= runStartedAtMs - 1_000;
}

/** Receipt counters for the task card. */
export function receiptCounts(receipts: ReadonlyArray<{ ok?: boolean }> | null | undefined): { ok: number; total: number } {
  const list = Array.isArray(receipts) ? receipts : [];
  return { ok: list.filter((r) => r && r.ok === true).length, total: list.length };
}
