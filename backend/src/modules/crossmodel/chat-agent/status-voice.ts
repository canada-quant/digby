/**
 * Digby's STATUS VOICE — every live status line a chat user reads while Digby works (owner 2026-10-04: "enhance the
 * status message of what is going on and make it more user friendly and Digby oriented and on brand").
 *
 * One file, one voice. The rules (keep them when you add a line):
 *   1. Lead with who is working — "Digby", or a seat persona ("the Double Checker") — in the present progressive.
 *   2. Say the REAL target when there is one (the query in quotes, the site, the task) — never canned filler
 *      (owner 2026-08-30) and never "rotating fiction": a line reports what is actually happening.
 *   3. Plain words only. Never a model / vendor / seat-config name, an HTTP code, a tool id, a byte or token count,
 *      an admin path, or pipeline jargon ("synthesizing", "reconciling", "council", "harness", "context", "draft").
 *   4. Calm and warm — "Polite, but powerful". Setbacks read as a quick recovery ("Hit a snag — trying again…"),
 *      never as an error report; the detail goes to the logs.
 *   5. In-progress lines end with "…"; a finished beat ("is done (12s)") does not. Keep the fixed part short
 *      (≲ 60 chars) so the target fits on a phone.
 *   6. The "dig" motif is ours ("Digby is digging in", "Dig deeper") — use it sparingly, never as a pun per line.
 * Keyed lines (compute-policy-wiring PROGRESS_LINES) are mirrored by the web client (frontend/lib/depth-ux.ts) —
 * change both together. Pure leaf — no imports.
 */

const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const quoted = (q: string): string => `“${q}”`;
const secs = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;

export const STATUS = {
  orienting: 'Digby is getting oriented…',
  /** In place of the (now hidden) thinking stream — the model is reasoning before it acts or answers. */
  thinking: 'Digby is thinking it through…',
  lane: {
    quick: 'Quick answer — looking it up…',
    standard: 'Digby is on it — writing your answer…',
    checked: 'Digby is digging in — the Double Checker is researching alongside…',
    research: 'Digby is rallying a research team for a deep dig…',
  },
  // The pulse names what Digby is ACTUALLY doing (2026-10-04 live check: "Still writing — 0:48 so far…" repeated
  // five times while the model was still thinking and not one word had been written).
  heartbeat: {
    thinking: (mm: string) => `Still thinking it through — ${mm} so far…`,
    research: (mm: string) => `Still digging — ${mm} so far…`,
    writing: (mm: string) => `Still writing — ${mm} so far…`,
  },
  // ── Digby's own tool calls (chat-agent/sse-adapter.ts) ──
  tool: {
    memory: (q?: string) => (clip(q, 60) ? `Digby is checking its notes on ${quoted(clip(q, 60))}…` : 'Digby is checking its notes…'),
    research: (q?: string, sources = 0) => (sources > 0
      ? `Digby is reading ${sources} source${sources === 1 ? '' : 's'}…`
      : clip(q, 80) ? `Digby is researching ${quoted(clip(q, 80))}…` : 'Digby is gathering sources…'),
    search: (q?: string) => (clip(q, 80) ? `Digby is searching the web for ${quoted(clip(q, 80))}…` : 'Digby is searching the web…'),
    read: (host?: string) => `Digby is reading ${clip(host, 60) || 'a source page'}…`,
    browse: (task?: string) => (clip(task, 60) ? `Digby is browsing — ${clip(task, 60)}…` : 'Digby is browsing the web…'),
    delegate: (n: number, task?: string) => (n > 1
      ? `Digby is splitting this up — ${n} helpers on it…`
      : clip(task, 60) ? `Digby is handing a piece to a helper — ${clip(task, 60)}…` : 'Digby is bringing in a helper…'),
    other: (detail?: string) => (clip(detail, 80) ? `Digby is working on it — ${clip(detail, 80)}…` : 'Digby is working on it…'),
    /** After a tool result lands (shown only while thinking is hidden — the pause after a result used to show the
     *  thinking stream). */
    afterResult: (toolName: string) => `Digby ${resultPhrase(toolName)}…`,
  },
  // ── The Double Checker (Level 2 / checked lane) ──
  checker: {
    parallelStart: 'Digby and the Double Checker are each researching this — Digby will compare notes at the end…',
    working: (who: string) => `${who} is working on its own answer…`,
    search: (who: string, q?: string) => (clip(q, 60) ? `${who} is searching the web for ${quoted(clip(q, 60))}…` : `${who} is searching the web…`),
    read: (who: string, host?: string) => `${who} is reading ${clip(host, 60) || 'a source'}…`,
    afterResult: (who: string, toolName: string) => `${who} ${resultPhrase(toolName)}…`,
    retry: (who: string) => `${who} is taking another pass…`,
    snag: (who: string) => `${who} hit a snag — trying again…`,
    done: (who: string, ms: number) => `${who} is done (${secs(ms)})`,
    unavailable: 'Answering without the Double Checker this time…',
    answersIn: (n: number) => (n <= 1 ? 'The second opinion is in — Digby is comparing notes…' : `${n} second opinions are in — Digby is comparing notes…`),
    comparing: (n: number) => (n <= 1 ? 'The second opinion is in — Digby is weighing it against its answer…' : `${n} second opinions are in — Digby is weighing them against its answer…`),
    stillChecking: 'Answering now — the Double Checker is still checking and will flag anything it finds…',
    /** The second opinion LANDED after Digby's answer and is being weighed (2026-10-04 live check: this beat used to
     *  reuse the keyed "a second opinion is on its way" line — right after "The second opinion is in"). */
    weighing: 'Answering now — Digby is weighing the second opinion and will update this if it changes anything.',
    stillComparing: 'Answering now — Digby is still comparing notes with the Double Checker and will update this if anything changes…',
  },
  // ── Deep research team (Level 3) ──
  team: {
    unavailable: (who: string) => `${who} isn't available right now — Digby will cover that part.`,
    on: (who: string, mission?: string) => (clip(mission, 70) ? `${who} is on it — ${clip(mission, 70)}…` : `${who} is on it…`),
    snag: (who: string) => `${who} hit a snag — trying again…`,
    done: (who: string, piece: boolean, ms: number) => (piece ? `${who} wrapped up a piece (${secs(ms)})` : `${who} is done (${secs(ms)})`),
    dispatched: (n: number, who: string, mission?: string) => {
      const m = clip(mission, 70);
      return n > 1
        ? `Digby sent ${n} researchers after this${m ? ` — ${m}` : ''}…`
        : `Digby sent ${who} to dig into it${m ? ` — ${m}` : ''}…`;
    },
    slow: (who: string) => `${who} is taking a while — giving it a fresh start…`,
    /** Deep research has no wall clock (2026-10-20): a colleague is restarted only when it STOPPED making progress. */
    stalled: (who: string) => `${who} stopped responding — giving it a fresh start…`,
    /** …or it only kept THINKING — no search, no answer — past the reasoning-only bound (review 2026-10-20). */
    stuckThinking: (who: string) => `${who} got stuck thinking — giving it a fresh start…`,
  },
  // ── A helper Digby called in mid-answer (chat-agent/call-in.ts, roster 2026-10-06 D-2) ──
  callIn: {
    start: (who: string, brief?: string) => (clip(brief, 60) ? `Digby called in ${who} — ${quoted(clip(brief, 60))}…` : `Digby called in ${who} for a second look…`),
    done: (who: string, ms: number) => `Digby has the report from ${who} (${secs(ms)}) — weighing it…`,
    missed: (who: string) => `Digby is carrying on without ${who}…`,
  },
  // ── Recoveries (the detail goes to the logs, never the status line) ──
  recover: {
    noImages: 'Digby can’t look at images right now — answering from your text…',
    emptyReply: 'Taking another run at that…',
    backup: 'Hit a snag — switching to a backup and carrying on…',
    hiccup: 'Fixing a hiccup and trying again…',
    phantomSend: 'Making sure that message actually goes out…',
    recheck: 'Double-checking the details before replying…',
    saveRule: 'Saving that rule for this chat…',
    wrapUp: 'Wrapping up with what Digby has found so far…',
    checks: 'Running checks…',
  },
  // ── Connected-app look-ups before the run (integration-context.ts; keyed by the progress `stage`) ──
  integration: {
    google: 'Checking your Google Workspace…',
    xero: 'Checking your Xero books…',
    slack: 'Checking your Slack…',
    asana: 'Checking your Asana tasks…',
    github: 'Checking your GitHub…',
    x: 'Checking X…',
    xUnavailable: 'X isn’t responding right now — carrying on without it.',
    plaid: 'Checking your bank accounts…',
    imessage: 'Reading your iMessages…',
    appleCalendar: 'Checking your Mac calendar…',
  },
} as const;

/** What a worker is doing with a tool's result, as a verb phrase ("is going through the results"). Pure. */
export function resultPhrase(toolName: string): string {
  const n = String(toolName || '');
  if (n === 'search_engine' || n === 'web_pipe') return 'is going through the results';
  if (n === 'search_memory') return 'is checking what it already knows';
  // "is going through the page", not "is reading the page" — the call line already said "Digby is reading <site>…".
  if (n.startsWith('scrape') || n === 'browser_task') return 'is going through the page';
  if (/search/i.test(n)) return 'is going through what it found';
  return 'is looking over what came back';
}

// ── The agent loop's own progress lines on a CHAT run ──────────────────────────────────────────────────────────
// The chat answer runs on the coding agent loop (coding/agent.ts), whose ~60 progress lines are written for
// operators ("Coding seat X returned 429 — this turn runs on Y", "Tool groups: core + …", "shrank context 412k →
// 180k chars"). On a chat run each stage is mapped to a plain line or dropped. A stage this table does not know
// passes through only when it reads as plain language. Kill switch CHAT_STATUS_FILTER_DISABLED=1.

export function chatStatusFilterDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.CHAT_STATUS_FILTER_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const AGENT_STAGE_LINE: Record<string, string | null> = {
  deadline: STATUS.recover.wrapUp,
  'seat-fallback': STATUS.recover.backup,
  'truncation-recovery': STATUS.recover.emptyReply,
  leak: STATUS.recover.hiccup,
  'zero-tool-gate': STATUS.recover.recheck,
  'evidence-guard': STATUS.recover.recheck,
  verify: STATUS.recover.checks,
  // operator-only beats — nothing a chat user can act on
  container: null, 'tool-groups': null, 'tool-group': null, 'tool-limit': null, 'transcript-repair': null, compact: null,
  reflect: null, 'line-repeat-break': null, 'derail-rescue': null, 'derail-break': null, 'derail-reanchor': null,
  'narr-loop-break': null, 'batch-cap': null, 'volume-break': null, offload: null, 'slip-prune': null,
  'repeat-break': null, loop: null, monitor: null, resume: null, steer: null, 'event-log-degraded': null, truncated: null,
  // F2 frontier council: the subagent_start / _end events already show "Frontier council is on it…" + its card (model ids stay off the status line)
  'reflection-council': null,
};

/** Jargon that must never reach a chat user's status line (rule 3). */
const JARGON_RE = /\b(HTTP|\d{3}\b.*\b(error|status)|model|seat|harness|context|tool[- ]?(call|group|list|limit)|tokens?|chars|guard|steer|re-?anchor|derail|compact|transcript|endpoint|provider|backoff|fallback|BrightData)\b|\[[A-Z_ ]{3,}\]/i;

/** The pipes' own progress copy (coding/web-pipe.ts, coding/youtube-pipe.ts) in Digby's voice. */
function pipeLine(stage: string, message: string): string | null {
  const m = String(message || '');
  let r: RegExpMatchArray | null;
  if ((r = m.match(/^Searching YouTube\s*[—-]\s*(.+)$/i))) return `Digby is searching YouTube for ${quoted(clip(r[1], 70))}…`;
  if ((r = m.match(/^Searching\s*[—-]\s*(.+)$/i))) return STATUS.tool.search(r[1]);
  if ((r = m.match(/^Reading (\d+) source/i))) return STATUS.tool.research('', Number(r[1]));
  if ((r = m.match(/^Ingesting (\d+) video/i))) return `Digby is watching ${r[1]} video${r[1] === '1' ? '' : 's'}…`;
  if (/^(Trying .*transcript|Fetching .*transcript)/i.test(m)) return 'Digby is fetching the video transcript…';
  if (/^Transcribing/i.test(m)) return 'Digby is listening to the video…';
  if (/^Digesting/i.test(m)) return 'Digby is pulling out the key points…';
  return stage === 'youtube_pipe' ? 'Digby is working through the video…' : 'Digby is working through the sources…';
}

/**
 * The status line a chat user sees for an agent-loop `progress` event, or null to drop it. Pure.
 * Unknown stages pass through only when they read as plain language.
 */
export function chatStatusForAgentProgress(stage: unknown, message: unknown): string | null {
  const st = String(stage ?? '');
  const msg = clip(message, 200);
  if (!msg) return null;
  if (st === 'web_pipe' || st === 'youtube_pipe') return pipeLine(st, msg);
  if (Object.prototype.hasOwnProperty.call(AGENT_STAGE_LINE, st)) return AGENT_STAGE_LINE[st];
  return JARGON_RE.test(msg) ? null : msg;
}
