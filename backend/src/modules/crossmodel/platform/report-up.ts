/**
 * Report-up classification — project supervisor → Fleet Supervisor traffic
 * (tt-rd audit 2026-09-27, finding upward-chatter-directives-1/-2).
 *
 * WHY: over 14 days 259 of the tt-rd project supervisor's 310 send_chat_message
 * calls went UP to the Fleet Supervisor and only 30 to its main lane; fleet-wide
 * 1,817 of 2,845 project-supervisor sends (64 %) targeted the Fleet Supervisor.
 * Each one drained on the Fleet Supervisor as a FULL reasoning turn (946
 * agent-origin turns in 14 d — more than its 828 hook wakes). Most restated
 * ledger state the Fleet Supervisor already reads from goal_list / the [BOARD].
 *
 * This LEAF module (no imports) holds the deterministic reading of a report-up
 * body that both surfaces share:
 *   - platform-tools send_chat_message (observe-only: a `report_up` loop_metrics
 *     row per PS→FS send + an advisory line on the tool result when the body
 *     carries neither a STATE CHANGE nor an ASK; REPORT_UP_ADVISORY_DISABLED=1
 *     keeps the row and drops the line);
 *   - chat-agent drainChatQueue (OPT-IN REPORT_UP_ACK_ONLY_DRAIN=1: a queued
 *     batch made only of status-only report-ups from project supervisors is
 *     ACKED by the harness instead of starting a Fleet Supervisor turn).
 *
 * The markers are the doctrine's own vocabulary (project-supervisor duty 4:
 * WHAT MOVED / STUCK SINCE WHEN / NEEDS FLEET, "moved toward/away") plus the
 * generic ask cues drain-triage already reads. Pure; exported for tests.
 */

/**
 * A goal STATE CHANGE — the doctrine's report-up line kinds, a moved-toward/
 * away phrase, OR (fixer 2026-09-27, finding upward-chatter-3) a DELIVERY /
 * ARTIFACT cue: the literal markers alone read natural goal-delivery bodies
 * ("PR #281 merged to main. Goal G2 delivered.") as status-only — the
 * advisory line landed on legitimate deltas, the statusOnly telemetry that
 * gates REPORT_UP_ACK_ONLY_DRAIN over-counted, and under the opt-in drain a
 * goal-completion report was swallowed without a Fleet Supervisor turn. A body
 * citing an artifact is a delta by the doctrine's own definition:
 *   - a PR / issue number (`PR #281`, `#1098`);
 *   - a delivery / breakage verb (merged, landed, delivered, shipped, finished,
 *     closed, resolved, reverted, rolled back, crashed, broke, passed, failed);
 *   - "done / complete(d)" as a verdict ("is done", "marked complete", "DONE —"),
 *     or on a goal ("Goal G2 … done");
 *   - a LABELLED 8-hex receipt/run id (`msg 871d203b`, `PR`, `run`, `ticket`,
 *     `commit`, `receipt`, `oq`) — a bare lane id ("lane ddd26be0 running") is
 *     NOT an artifact and stays status-only;
 *   - a tok/s DELTA (`5.08 → 7.1 tok/s`) — a bare "unchanged at 5.08 tok/s" is not.
 */
export const REPORT_UP_STATE_CHANGE_RE = new RegExp([
  'WHAT MOVED', 'moved (?:toward|away)', 'STUCK SINCE', 'NEEDS FLEET',
  '\\bregress(?:ed|ion)\\b', '\\bunblocked\\b', '\\bblocked since\\b',
  '\\b(?:PR|MR|issue) ?#?\\d+\\b', '(?:^|\\s)#\\d{2,}\\b',
  '\\b(?:merged|landed|delivered|shipped|finished|closed|resolved|reverted|rolled back|crashed|broke|passed|failed)\\b',
  '\\b(?:is|now|marked|went|got|as) (?:done|complete|completed)\\b', '\\b(?:done|complete[d]?)\\s*[—\\-:(]',
  '\\bgoal\\b[^.\\n]{0,80}\\b(?:done|complete[d]?|delivered|achieved|met|missed)\\b',
  '\\b(?:msg|message|run|ticket|commit|sha|receipt|oq|feedback)[ _#:]*[0-9a-f]{8}\\b',
  '\\d+(?:\\.\\d+)?\\s*(?:→|->|to)\\s*\\d+(?:\\.\\d+)?\\s*tok/s',
].join('|'), 'i');
/** An ASK the fleet must carry — a question, a please, an explicit need. */
export const REPORT_UP_ASK_RE = /\?|\bplease\b|\bneed(?:s)? (?:you|the fleet|a decision|a ruling|an? (?:answer|owner))\b|\bcross-project\b|\bframework (?:issue|defect|bug)\b|\bowner (?:communication|decision|question)\b/i;

export interface ReportUpReading {
  chars: number;
  hasStateChange: boolean;
  hasAsk: boolean;
  /** Neither marker matched — the body restates state the Fleet Supervisor reads from the ledger. */
  statusOnly: boolean;
}

/** Deterministic reading of a report-up body. Pure. */
export function classifyReportUp(text: unknown): ReportUpReading {
  const s = String(text ?? '');
  const hasStateChange = REPORT_UP_STATE_CHANGE_RE.test(s);
  const hasAsk = REPORT_UP_ASK_RE.test(s);
  return { chars: s.length, hasStateChange, hasAsk, statusOnly: !hasStateChange && !hasAsk };
}

/** The advisory appended to a status-only PS→FS send_chat_message result. */
export const REPORT_UP_ADVISORY_LINE =
  'advisory: this message restates state the Fleet Supervisor reads from the ledger — message the lane instead; not counted as an action';

/** OPT-IN (default OFF): the drain acks a status-only project-supervisor batch instead of starting a Fleet Supervisor turn. */
export const REPORT_UP_ACK_ONLY_DRAIN_ENV = 'REPORT_UP_ACK_ONLY_DRAIN';
export function reportUpAckOnlyDrainEnabled(): boolean {
  return process.env[REPORT_UP_ACK_ONLY_DRAIN_ENV] === '1';
}

/** The harness ack row persisted in place of the Fleet Supervisor's turn. */
export const REPORT_UP_ACK_NOTE = '[REPORT-UP ACKED — no ask, no state change; not answered]';
/** metadata.origin of the ack row — NOT one of the supervisor-note origins the watchdog / follow-through scan. */
export const REPORT_UP_ACK_ORIGIN = 'report-up-ack';

/**
 * True when EVERY body in a queued batch is status-only (no ask, no state
 * change). An empty batch is never ack-only. Pure.
 */
export function batchIsStatusOnly(bodies: unknown[]): boolean {
  if (!bodies.length) return false;
  return bodies.every((b) => classifyReportUp(b).statusOnly);
}
