/**
 * INDEPENDENT REVIEW at the pre-finish self-audit (2026-10-01, TB 2.1 audit).
 *
 * Evidence (bench v3e, 5 failed tasks, every trace read end to end): every
 * failing run FINISHED WITH ALL OF ITS OWN CHECKS GREEN. The harness
 * self-audit asked the lead to re-check "its OWN acceptance criteria" — the
 * criteria the lead itself wrote into update_plan — and its v2 prompt says "a
 * criterion a receipt of this run already evidences: CITE that receipt". So
 * the audit re-confirmed the lead's paraphrase of the task with the lead's own
 * probes ("4/4 acceptance criteria verified against this run's tool
 * receipts … nothing re-probed"). What the grader checked was the ORIGINAL
 * text: an exact stdout format (one extra printed line broke its regex), a
 * provided input the task said to use (the lane replaced it), a
 * normalisation the task implied (the lane chose byte-identical). Four of the
 * five runs held the right answer or approach at some point and drifted.
 *
 * Two changes, both at the existing self-audit seam (no new gate, no
 * refusal — the lead still decides):
 *  1. ORIGINAL REQUEST ANCHOR — the self-audit message quotes the original
 *     request and asks the lead to re-derive the requirements from IT, not
 *     from the plan (exact paths, exact output format, inputs it must keep).
 *  2. INDEPENDENT REVIEW — before that message, the harness dispatches ONE
 *     `reviewer` worker (the Reviewer seat, which follows the Double Checker:
 *     a different model than the lead) with the original request only — never
 *     the lead's criteria — to inspect the actual artifacts and report
 *     concrete mismatches. Its report rides the self-audit message as
 *     evidence for the lead to weigh (a finding it can refute with a check,
 *     it refutes in one line).
 *
 * Eligible runs: a top-level coding run in auto mode, a plan with no blocked
 * steps, ≥ 1 work tool call this run (a file write / edit / command), and a
 * request that is a TASK — a human message or an agent dispatch; never a
 * schedule firing (a recurring lane's cadence tick would pay a reviewer every
 * tick). A harness continuation / provider-limit resume reuses the request
 * that started the work (newest non-harness user message in history).
 *
 * Three deterministic cues ride the request block (2026-10-01, second audit
 * pass over mteb-retrieve / video-processing / protein-assembly — each lane
 * WROTE the grader's reading in its own reasoning and then shipped the other):
 *  - OPEN CHOICES: unresolved either/or sentences from the lead's own
 *    reasoning this run ("genuinely ambiguous", "both readings defensible",
 *    "I'll assume") are listed back, to be resolved against the request text;
 *  - GENERALIZATION: a request that implies inputs beyond the visible example
 *    ("all videos", "test videos", "any input") asks for one run on an input
 *    the lane did not tune on;
 *  - NAMED SOURCES: a request that binds a value to a source ("should match
 *    the fasta returned by the pdb API", "found in plasmid.gb") asks for an
 *    exact comparison against that source and a stated deviation.
 * The reviewer brief carries the last two (never the lead's reasoning).
 *
 * Integrity (2026-10-03, TB 2.1 benchmark integrity incident): the brief's
 * old step 3 ("Think like the grader: what would a hidden test assert …")
 * sent one reviewer to GitHub for the task's own tests. Checks are now derived
 * from the request sentence itself, and ANSWER_KEY_INTEGRITY_LINE (never
 * fetch the task's reference solution / hidden tests / grader / oracle / a
 * benchmark copy; stop and report if one turns up) rides both the reviewer
 * brief and the lead's ORIGINAL REQUEST self-audit block. The deterministic,
 * opt-in backstop is answer-key-guard.ts (ANSWER_KEY_GUARD=1).
 *
 * Leaf (one import: the PURE leaf report-clip.ts, for the injection clip —
 * ticket d7e82531; it does no I/O). Kill switch: INDEPENDENT_REVIEW_DISABLED=1
 * (no reviewer).
 */

import { clipAtBoundary, workerReportCapChars } from './report-clip';

function envOn(name: string): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function independentReviewDisabled(): boolean { return envOn('INDEPENDENT_REVIEW_DISABLED'); }

/** Longest request text quoted back (head + tail kept; the middle is elided with a marker). */
export const ORIGINAL_REQUEST_MAX_CHARS = 8000;

/**
 * Integrity line (2026-10-03, TB 2.1 benchmark integrity incident): the old
 * brief's "Think like the grader: what would a hidden test assert" sent one
 * reviewer to GitHub for the task's own tests. Checks are derived from the
 * request text only; this sentence rides the reviewer brief AND the lead's
 * self-audit ORIGINAL REQUEST block. Files the request itself hands over are
 * not an answer key. The deterministic backstop is answer-key-guard.ts (opt-in).
 */
export const ANSWER_KEY_INTEGRITY_LINE = "INTEGRITY: never search for, fetch or read this task's reference solution, hidden tests, grader, oracle, or any copy of the task from a benchmark repo / dataset / leaderboard site (files the request itself gives you are fine); if one turns up, stop reading it and say so in your report.";

/** Leading chrome of a SCHEDULE / HOOK firing — never a task to review. */
const MACHINE_FIRING_RE = /^\s*\[MACHINE-TRIGGERED RUN/;
/** A harness-authored continuation / resume — the task is the message that started the work. */
const HARNESS_RESUME_RE = /^\s*\[(?:HARNESS (?:CONTINUATION|AUTO-CONTINUE|SELF-AUDIT|NOTICE|NOTE|CLOCK|EVIDENCE GUARD|INJECTION)|RESUME AFTER PROVIDER LIMIT)/;
/** Agent-send provenance header (platform/agent-send-header.ts) — the task follows it. */
const AGENT_SEND_HEADER_RE = /^\s*\[AGENT-SENT MESSAGE — [^\]\n]*\]\s*/;

/** Tools whose call means the run DID work a reviewer can inspect. */
export const REVIEW_WORK_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'delete_file', 'move_file', 'run_command',
]);

/** Work tool calls already in the transcript (a resumed run keeps its count). */
export function countWorkToolCalls(messages: ReadonlyArray<unknown>): number {
  let n = 0;
  for (const m of messages) {
    const msg = m as { role?: unknown; tool_calls?: unknown } | null | undefined;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls as Array<{ function?: { name?: unknown } } | null | undefined>) {
      const name = tc?.function?.name;
      if (typeof name === 'string' && REVIEW_WORK_TOOLS.has(name)) n += 1;
    }
  }
  return n;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Head + tail clip with an explicit elision marker (never silently truncates). */
export function clipRequest(text: string, max = ORIGINAL_REQUEST_MAX_CHARS): string {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${t.slice(0, head)}\n[… ${t.length - max} chars of the request elided …]\n${t.slice(t.length - tail)}`;
}

export type OriginalRequest = { text: string; source: 'message' | 'history'; dispatched: boolean };

/**
 * The request this run's work answers, or null when there is none to review
 * (a schedule firing, an empty message, a history with only harness rows).
 * The agent-send provenance header is stripped (the reviewer gets the task,
 * not the plumbing); `dispatched` records that it was there.
 */
export function originalRequest(
  userMessage: string | null | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }> | null | undefined,
): OriginalRequest | null {
  const pick = (raw: string, source: OriginalRequest['source']): OriginalRequest | null => {
    if (!raw || MACHINE_FIRING_RE.test(raw) || HARNESS_RESUME_RE.test(raw)) return null;
    const dispatched = AGENT_SEND_HEADER_RE.test(raw);
    const text = raw.replace(AGENT_SEND_HEADER_RE, '').trim();
    if (text.length < 20) return null;
    return { text, source, dispatched };
  };
  const msg = String(userMessage ?? '');
  if (MACHINE_FIRING_RE.test(msg)) return null;
  if (!HARNESS_RESUME_RE.test(msg)) return pick(msg, 'message');
  const rows = Array.isArray(history) ? history : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.role !== 'user') continue;
    const raw = contentText(row.content);
    if (MACHINE_FIRING_RE.test(raw)) return null; // the work started from a firing — not a task to review
    const got = pick(raw, 'history');
    if (got) return got;
  }
  return null;
}


// ── Deterministic cues (see header) ─────────────────────────────────────────

/** Sentences that record an UNRESOLVED choice between readings of the task. */
const OPEN_CHOICE_RE = /\b(?:genuinely ambiguous|(?:is|are|seems?|looks?) ambiguous|ambiguit(?:y|ies)|(?:either|both) (?:readings?|interpretations?|options?|approaches?|choices?) (?:(?:is|are|would be|seems?) )?(?:defensible|plausible|valid|reasonable|acceptable|fine)|two (?:possible |valid |plausible )?(?:readings|interpretations)|coin[- ]?flip|judg(?:e)?ment call|could (?:mean|be read as) either|(?:unclear|not (?:clear|sure)) whether|the (?:task|spec|request|instructions?) (?:doesn'?t|does not|don'?t|do not) (?:say|specify|state|mention)|not specified|I'?ll assume|I will assume|assuming (?:that )?the (?:task|grader|test|spec))/i;

/** Max sentences the ledger keeps (newest unique win). */
export const OPEN_CHOICE_MAX = 6;
const OPEN_CHOICE_SENTENCE_MAX = 240;

/** Unresolved-choice sentences in one reasoning / content block (pure). */
export function extractOpenChoices(text: string): string[] {
  const t = String(text ?? '');
  if (!t || !OPEN_CHOICE_RE.test(t)) return [];
  const out: string[] = [];
  for (const raw of t.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.replace(/\s+/g, ' ').trim();
    if (sentence.length < 12 || !OPEN_CHOICE_RE.test(sentence)) continue;
    out.push(sentence.length > OPEN_CHOICE_SENTENCE_MAX ? `${sentence.slice(0, OPEN_CHOICE_SENTENCE_MAX - 1)}…` : sentence);
  }
  return out;
}

/** Push into a bounded, de-duplicated run ledger (newest kept). Mutates and returns `ledger`. */
export function addOpenChoices(ledger: string[], text: string): string[] {
  for (const s of extractOpenChoices(text)) {
    const i = ledger.indexOf(s);
    if (i >= 0) ledger.splice(i, 1);
    ledger.push(s);
  }
  while (ledger.length > OPEN_CHOICE_MAX) ledger.shift();
  return ledger;
}

/** The request implies inputs beyond the visible example. */
const GENERALIZE_RE = /\b(?:(?:all|any|other|hidden|unseen|different|new|arbitrary|future|additional|test|held[- ]?out)\s+(?:\w+\s+){0,2}(?:videos?|images?|inputs?|files?|datasets?|cases?|examples?|documents?|logs?|samples?|boards?|positions?|queries?|sequences?|clips?|frames?)|(?:will|may|might) be (?:tested|evaluated|run|graded) (?:on|with|against)|should (?:also )?work (?:for|on|with) (?:any|other|all|arbitrary|different)|generali[sz]e)\b/i;

/** The request binds a value to an authoritative source. */
const SOURCE_RE = /\b(?:(?:should|must) (?:exactly )?match (?:the |that |what )?[^.\n]{0,80}|(?:returned|provided|given|listed|found) (?:by|in|from) (?:the )?[^.\n]{0,60}|(?:according to|as (?:specified|defined|given) (?:in|by)) (?:the )?[^.\n]{0,60}|(?:reuse|use) the (?:\w+ ){0,3}(?:found|given|provided|listed) in [^.\n]{0,60})/gi;

export type RequestCues = { generalize: string | null; sources: string[] };

/** Deterministic cues read from the request text (pure). */
export function requestCues(text: string): RequestCues {
  const t = String(text ?? '');
  const g = t.match(GENERALIZE_RE);
  const sources: string[] = [];
  for (const m of t.matchAll(SOURCE_RE)) {
    const phrase = m[0].replace(/\s+/g, ' ').trim().replace(/[,;:]+$/, '');
    if (phrase.length >= 12 && !sources.includes(phrase)) sources.push(phrase);
    if (sources.length >= 4) break;
  }
  return { generalize: g ? g[0].replace(/\s+/g, ' ').trim() : null, sources };
}

function generalizeClause(phrase: string): string {
  return `GENERALIZATION: the request implies inputs beyond the one you can see ("${phrase}"). A deliverable tuned on one example must also run on an input you did not tune on — make one now (a trimmed / padded / perturbed / re-encoded copy of the example, or a second synthetic case) and run it; a heuristic added only to make the example pass is the first suspect if it breaks.`;
}

function sourcesClause(sources: string[]): string {
  return `NAMED SOURCES: the request binds values to sources (${sources.map((p) => `"${p}"`).join('; ')}). For each, read / fetch that source now and compare the shipped value against it EXACTLY (string-equal, not "equivalent" or "the cleaner version"); a value you deliberately took from elsewhere is a deviation — follow the source the request names, or state the deviation plainly in your final.`;
}

/** Pure eligibility predicate for the reviewer dispatch (see header). */
export function shouldRunIndependentReview(o: {
  request: OriginalRequest | null;
  topLevel: boolean;
  codingProfile: boolean;
  autoMode: boolean;
  canDelegate: boolean;
  blockedSteps: number;
  workToolCalls: number;
}): { run: boolean; reason: string } {
  if (independentReviewDisabled()) return { run: false, reason: 'disabled' };
  if (!o.topLevel || !o.codingProfile || !o.autoMode) return { run: false, reason: 'not_top_level_coding_auto' };
  if (!o.canDelegate) return { run: false, reason: 'no_delegate' };
  if (!o.request) return { run: false, reason: 'no_task_request' };
  if (o.blockedSteps > 0) return { run: false, reason: 'blocked_steps' };
  if (o.workToolCalls < 1) return { run: false, reason: 'no_work' };
  return { run: true, reason: 'eligible' };
}

/**
 * The reviewer worker's brief. Deliberately carries the ORIGINAL request and
 * NOT the lead's plan, criteria or summary — an independent re-derivation is
 * the point. The deliverable list the lead's plan names is passed only as
 * "where to look" (paths), never as what to check.
 */
export function independentReviewBrief(request: OriginalRequest, lookAt: string[] = []): string {
  const paths = lookAt.filter(Boolean).slice(0, 12);
  return [
    'INDEPENDENT REVIEW — you did not do this work; another model did. Your job: decide whether the ACTUAL artifacts satisfy the ORIGINAL REQUEST below exactly as written — strictly and literally, from the request text alone.',
    ANSWER_KEY_INTEGRITY_LINE,
    '',
    'ORIGINAL REQUEST (verbatim):',
    '<<<',
    clipRequest(request.text),
    '>>>',
    '',
    'How to review:',
    '1. From the request text ALONE, list every checkable requirement: exact file paths and names, exact output / stdout format (character for character — an extra line, prefix, banner or log line on stdout is a defect when a format is specified), required behaviour on the inputs the request names, files or inputs the request provides or says to keep / not modify (replacing or regenerating a PROVIDED input is a defect), required dependencies / versions, and anything the request forbids.',
    '2. Check each one against the REAL artifacts with read-only commands (run_command with absolute paths — the request says where the task files live; your file tools only see the session worktree). RUN the deliverable the way the request implies it will be used and compare its real output to the requirement. Read files; never modify, create, delete or move anything; never install packages system-wide.',
    '3. Derive each check from the request sentence itself: what exactly does it demand (path, format, behaviour, input), and what observable output proves it? Probe the edge the request implies (other inputs, a fresh process, a different working directory) with ONE cheap check each.',
    'When a requirement depends on what an IMAGE shows (a board, a chart, a screenshot, a diagram), LOOK at it with view_image(path, question) and ask a precise question — never trust a pixel heuristic or the worker\'s own reading.',
    ...(() => {
      const c = requestCues(request.text);
      const lines: string[] = [];
      if (c.sources.length) lines.push(`4. The request binds values to named sources (${c.sources.map((p) => `"${p}"`).join('; ')}): fetch / read each source yourself and compare the shipped value against it exactly — any difference is a FAIL unless the request allows it.`);
      if (c.generalize) lines.push(`${c.sources.length ? '5' : '4'}. The request implies other inputs ("${c.generalize}"): run the deliverable on at least one input it was not tuned on (a perturbed / trimmed copy of the example in a temp dir — never overwrite the original) and report what happens.`);
      return lines;
    })(),
    paths.length ? `Artifacts the worker says it produced (where to look — NOT what to check): ${paths.join(', ')}` : '',
    '',
    'Report: one line per requirement — PASS / FAIL / UNVERIFIED, the requirement quoted from the request, and the evidence (command + the exact output you saw). A requirement you could not check is UNVERIFIED, never FAIL. End with a short list of the concrete defects to fix, the most serious mismatch with the request first, or "no defects found".',
  ].filter((l) => l !== '').join('\n');
}

/** Refusal shapes the delegate path returns instead of a worker report. */
const DELEGATE_REFUSAL_RE = /^(?:Delegation budget reached|Cannot run the |Unknown role|Role "|Delegation is not available|\[DELEGATION REFUSED|\[WORKER FAILED)/;

/** True when the delegate call returned a real worker report (not a refusal / empty). */
export function isUsableReviewReport(report: unknown): report is string {
  return typeof report === 'string' && report.trim().length > 0 && !DELEGATE_REFUSAL_RE.test(report.trim());
}

/** The ORIGINAL REQUEST block appended to the harness self-audit message. */
export function originalRequestAuditBlock(request: OriginalRequest, opts: { openChoices?: string[] } = {}): string {
  const lines = [
    '',
    'ORIGINAL REQUEST — the source of truth. Your plan\'s acceptance criteria are YOUR paraphrase of it and may have drifted; audit against THIS text:',
    '<<<',
    clipRequest(request.text),
    '>>>',
    'Re-derive the requirements from the request text itself: every exact path, every exact output format (character for character — no extra stdout lines, banners or logging unless asked), every input it provides or tells you to keep (a provided input you replaced, regenerated or edited is a defect — restore it), and every behaviour it names. Check each against the real artifacts now; a receipt counts only if it checked the requirement exactly as the request states it.',
    ANSWER_KEY_INTEGRITY_LINE,
  ];
  const c = requestCues(request.text);
  if (c.sources.length) lines.push(sourcesClause(c.sources));
  if (c.generalize) lines.push(generalizeClause(c.generalize));
  const choices = (opts.openChoices ?? []).filter(Boolean).slice(-OPEN_CHOICE_MAX);
  if (choices.length) {
    lines.push('OPEN CHOICES you wrote down this run — resolve each against the request text, not domain taste; when both readings are defensible, ship the most LITERAL reading of the request (or satisfy both) and say which you shipped:');
    for (const ch of choices) lines.push(`- "${ch}"`);
  }
  return lines.join('\n');
}

// ── audit 2026-10-06 T7-5: the review never REPLACES the lead's answer ───────
//
// stanne.md #3: a human "why?" was answered at 19:32; the self-audit + the
// independent reviewer then ran 39 min and the run's final — the persisted
// message, the hook digest, the hand-off — became "All five criteria verified
// — four with this-run receipts…". When the review round changes nothing
// (agent.ts: no mutating call, no plan update since the review was granted)
// the pre-review answer is the final and the round's own final rides as ONE
// line. Kill switch INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED=1.

export function reviewKeepAnswerDisabled(): boolean { return envOn('INDEPENDENT_REVIEW_KEEP_ANSWER_DISABLED'); }

/** Longest review line appended under the kept answer. */
export const REVIEW_LINE_MAX_CHARS = 240;

/** First sentence of a block of prose, markdown chrome stripped, ≤ max chars (pure). */
function firstSentence(text: string, max = REVIEW_LINE_MAX_CHARS): string {
  const flat = String(text ?? '')
    .split('\n').map((l) => l.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+|>\s*)/, '').trim()).filter(Boolean).join(' ')
    .replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.{12,}?[.!?])(\s|$)/);
  const head = (m ? m[1] : flat).trim();
  return head.length > max ? `${head.slice(0, max - 1).trimEnd()}…` : head;
}

/** The kept pre-review answer + ONE line naming the review outcome (pure). */
export function keptAnswerWithReviewLine(answer: string, reviewRoundFinal: string, fails: number): string {
  const outcome = fails > 0 ? `${fails} possible issue${fails === 1 ? '' : 's'} raised and weighed` : 'no defects found';
  const said = firstSentence(reviewRoundFinal);
  return `${answer.trimEnd()}\n\n_Independent review (a second model checked this against your original request): ${outcome}${said ? ` — ${said}` : ''}_`;
}

// ── Injection clip (ticket d7e82531): never sever the review mid-payload ─────
//
// Evidence (prod 2026-11-05, coding lane 98f43520): the harness injected its
// independent review into the pre-finish audit message and the lane received
// only the first FOUR of the reviewer's defects — the payload ended mid-defect-4
// with a bare "[… review report clipped …]". The lane disclosed it honestly
// ("any findings beyond the four I saw never reached me") and shipped only what
// it could see; the findings past the cut were silently LOST to the lane that
// was supposed to act on them. A lane less careful would have treated the four
// it saw as the whole review.
//
// Two defects compounded:
//  1. the cap here (6,000) was TIGHTER than the worker-report carrier cap
//     (12,000, report-clip.ts). The carrier had already clipped the verdict at
//     a boundary and appended its "(… N more chars — the FULL report is in
//     <path> — read_file it for the rest)" tail, which is the ONLY route to the
//     whole review. Slicing the carrier's head again DELETED that pointer, so
//     the lane could not have fetched the rest even if it had wanted to.
//  2. the cut was a raw `slice()` — mid-word, mid-finding — and its marker
//     stated neither how much was missing nor where to get it.
//
// Now: a report within WORKER_REPORT_CAP_CHARS is delivered WHOLE (no second
// clip at all); past that, the block keeps a HEAD and a TAIL (a reviewer puts
// its severity/verdict line last — a head-only cut loses exactly the sentence
// that says "defect 4 is blocking"), cut at a boundary, with a carried-forward
// recovery pointer and an explicit PARTIAL instruction. Pure — this module
// imports only the pure leaf report-clip.ts (no I/O).

/**
 * Default inline cap for the review block: NEVER tighter than the worker-report
 * carrier cap (report-clip.ts), read per call. A fixed number here would
 * re-create ticket d7e82531 the moment an operator raises
 * WORKER_REPORT_CAP_CHARS — the injection would clip a verdict the carrier had
 * already delivered whole. Pure.
 */
export function reviewFindingsCapChars(env: Record<string, string | undefined> = process.env): number {
  return Math.max(REVIEW_FINDINGS_MAX_CHARS, workerReportCapChars(env));
}

/** Documented floor of the injection cap (the carrier cap's own default). */
export const REVIEW_FINDINGS_MAX_CHARS = 12_000;

/** Marker prefix for a clipped review block (telemetry + honesty checks). */
export const REVIEW_PARTIAL_MARKER = 'independent review report clipped';

/**
 * The `(… N more chars — <how to read the rest>)` tail report-clip.ts appends.
 * It is the ONLY pointer to the durable full report, so it is carried forward
 * verbatim instead of being re-clipped away. END-ANCHORED: only a tail that
 * actually terminates the text is ours to peel (review finding B4).
 */
const CARRIED_CLIP_TAIL_RE = /\n\n\(… (\d+) more chars — ([^)]*)\)\s*$/;

/** A worktree path inside a carried tail — the lane can `read_file` it. */
const RECOVERY_PATH_RE = /((?:\.digby\/session\/)[^\s,;)]+)/;

export interface ReviewFindingsOpts {
  maxChars?: number;
  /** Worktree-relative path of the durable full report, when the caller knows it. */
  reportPath?: string;
  /**
   * Chars the CARRIER already dropped before this text reached us (the delegate
   * seam hands back `buildWorkerSummary`'s clipped text; the seam knows
   * `fullText.length - summary.length`). Non-zero forces PARTIAL even when this
   * function itself keeps everything it was given — otherwise the block would
   * present a carrier-clipped verdict as complete (review finding B2).
   */
  omittedBefore?: number;
}

/** The reviewer's findings, framed for the lead (evidence to weigh, not orders). */
export function reviewFindingsBlock(report: string, maxCharsOrOpts: number | ReviewFindingsOpts = reviewFindingsCapChars()): string {
  const opts: ReviewFindingsOpts = typeof maxCharsOrOpts === 'number' ? { maxChars: maxCharsOrOpts } : maxCharsOrOpts;
  const maxChars = Math.max(200, Math.floor(opts.maxChars ?? reviewFindingsCapChars()));
  const raw = String(report ?? '');

  // Defect 1 (above): a FIRST clip may already have run on this text. Peel its
  // tail off the body and rebuild it below — re-clipping the head alone is what
  // destroyed the recovery pointer. The tail is ANCHORED to the end of the
  // string: a reviewer that merely QUOTES an earlier worker's clip tail must not
  // have that quotation deleted, and its stale path must not be offered as this
  // review's recovery route (review finding B4).
  let body = raw;
  let carriedOmitted = Math.max(0, Math.floor(Number(opts.omittedBefore) || 0));
  let carriedHow = '';
  const carried = CARRIED_CLIP_TAIL_RE.exec(raw);
  if (carried) {
    carriedOmitted += Number(carried[1]) || 0;
    carriedHow = String(carried[2] || '').trim();
    body = raw.slice(0, carried.index);
  }

  let delivered = body;
  let omitted = carriedOmitted;
  if (body.length > maxChars) {
    // Defect 2 (above): boundary-aware HEAD + TAIL, never a mid-word slice, and
    // never a head-only cut that drops the closing verdict line.
    const headCap = Math.floor(maxChars * 0.7);
    const tailCap = maxChars - headCap;
    const head = clipAtBoundary(body, headCap);
    let tailText = body.slice(body.length - tailCap);
    // Prefer starting the tail on its own line so it reads as a finding, not a fragment.
    const nl = tailText.indexOf('\n');
    if (nl >= 0 && nl <= 200) tailText = tailText.slice(nl + 1);
    tailText = tailText.replace(/^\s+/, '');
    omitted = carriedOmitted + Math.max(0, body.length - head.text.length - tailText.length);
    delivered = `${head.text}\n\n[… ${omitted} chars NOT delivered here — the review resumes below …]\n\n${tailText}`;
  }

  let out = delivered.trim();
  if (omitted > 0) {
    const path = opts.reportPath || (RECOVERY_PATH_RE.exec(carriedHow)?.[1] ?? '');
    const recovery = path
      ? `the FULL report is in ${path} — read_file it for the rest`
      : 'no durable copy of the full report exists — re-check the artifact areas the findings below name, and say in your final that the review was PARTIAL';
    out += `\n\n[… ${REVIEW_PARTIAL_MARKER} — treat the findings above and below as PARTIAL, not complete: ${omitted} chars of this review were not delivered to you. ${recovery}]`;
  }

  return [
    '',
    'INDEPENDENT REVIEW (a different model checked your artifacts against the original request, without seeing your plan):',
    '<<<',
    out,
    '>>>',
    'Weigh each FAIL: if it is real, fix it now (reopen the step via update_plan); if you can refute it, run the one check that refutes it and say so in one line. UNVERIFIED items are not defects. Do not undo a correct solution to satisfy a wrong finding.',
  ].join('\n');
}

/** True when the rendered block was clipped (the lane must treat it as PARTIAL). */
export function reviewFindingsBlockIsPartial(block: string): boolean {
  return String(block ?? '').includes(REVIEW_PARTIAL_MARKER);
}

// ── audit 2026-10-08 W2-13 (sota.md #6): skip the SAME-MODEL self-audit when the
// cross-family reviewer already ran this round. The run got both a same-model
// re-verification round (the Jev self_audit purpose reads anti-predictive,
// accuracy 0.07) and a different-model reviewer whose findings rode the same
// message; evaluators favour their own generations, the reviewer does not. When
// the reviewer returned a usable report AND it is a different model family from
// the lead, the lead is asked only to act on the reviewer's FAIL / UNVERIFIED
// items — no second re-verify pass of its own. Same-family (or unknown) review,
// no report, or the kill switch SELF_AUDIT_REVIEWER_SKIP_DISABLED=1 keep the
// self-audit exactly as before.

export function selfAuditReviewerSkipDisabled(): boolean { return envOn('SELF_AUDIT_REVIEWER_SKIP_DISABLED'); }

const MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/glm/i, 'glm'], [/kimi|moonshot/i, 'kimi'], [/deepseek/i, 'deepseek'], [/qwen|qwq/i, 'qwen'],
  [/mimo/i, 'mimo'], [/gpt|openai|(?:^|[^a-z0-9])o[1-9](?:[^a-z0-9]|$)/i, 'openai'], [/claude|anthropic/i, 'anthropic'],
  [/grok|xai/i, 'xai'], [/gemini|gemma/i, 'google'], [/llama/i, 'llama'], [/mistral|mixtral/i, 'mistral'],
];

/** The vendor family a model id / seat spec belongs to ('<label>:<modelId>' specs read the model id), or null. Pure. */
export function modelFamilyOf(model: string | null | undefined): string | null {
  const raw = String(model ?? '').trim();
  if (!raw) return null;
  const id = raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
  for (const [re, fam] of MODEL_FAMILIES) if (re.test(id)) return fam;
  return null;
}

/** True only when BOTH families are known and differ. Pure. */
export function reviewerIsCrossFamily(reviewModel: string | null | undefined, leadModel: string | null | undefined): boolean {
  const a = modelFamilyOf(reviewModel);
  const b = modelFamilyOf(leadModel);
  return !!a && !!b && a !== b;
}

/** The round message when the cross-family review replaces the same-model self-audit. Pure. */
export function reviewerReplacesAuditMessage(reviewModel: string, auditExtra: string): string {
  return `[HARNESS INDEPENDENT REVIEW — not typed by the user] A different model (${reviewModel}) has reviewed this run's artifacts against the original request; its findings are below. The same-model self-audit round is SKIPPED because this cross-family review already ran — do NOT re-verify what it marks PASS. For each FAIL or UNVERIFIED item it reports: fix it now (reopen the step via update_plan) or run the ONE check that refutes it and say so in one line. If it reports nothing to fix, give your final summary now (deliverable first).${auditExtra}`;
}
