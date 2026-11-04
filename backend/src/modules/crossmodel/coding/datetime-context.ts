/**
 * Coding-session datetime context (owner feedback 2026-08-20: "in all coding
 * sessions, report timestamps default to Zulu").
 *
 * The coding container runs in UTC and the agent prompt carried NO time context
 * at all, so every timestamp a coding agent wrote for the user came out Zulu.
 * Chat solved the same problem the model-facing way (chat-context
 * buildDateTimeBlock): hand the model the user's local time plus an explicit
 * rule, instead of trying to rewrite prose timestamps in the UI after the fact
 * (fragile — report timestamps live inside model-generated markdown). This
 * module reuses that shared block and adds the coding-specific rule:
 *
 *   - user-DIRECTED timestamps (chat replies, run reports, summaries, PR/issue
 *     bodies) render BOTH clocks — the user's timezone (owner:
 *     America/Vancouver) first, the UTC instant in parentheses (ticket
 *     63698528: "show time as both z and user");
 *   - machine-to-machine content (hook payloads, log lines, schedule prompts,
 *     audit trails, file names) stays UTC / ISO-8601.
 */

import prisma from '../../../config/database';
import { buildDateTimeBlock } from '../chat-agent/chat-context';

/** Validate an IANA timezone string (Intl throws on garbage like "Not/AZone"). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The session owner's IANA timezone from user-memory facts — the same source
 * weather/news/calendar use — or undefined when unset/invalid/unreadable
 * (callers then fall back to UTC-only context). A memory read must never
 * break a run, so every failure mode collapses to undefined.
 */
export async function loadUserTimezone(userId: string): Promise<string | undefined> {
  try {
    const mem = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
    const tz = String((mem?.facts as Record<string, unknown> | null)?.timezone || '').trim();
    return tz && isValidTimezone(tz) ? tz : undefined;
  } catch {
    return undefined;
  }
}

// Owner convention (ticket 63698528 — "aren't you always supposed to show time
// as both z and user?"): user-directed timestamps render BOTH clocks, local
// first with the UTC instant in parentheses.
//
// Clock discipline (ticket 63e9a3cb): the block below is built ONCE per run
// attempt, so on a long run it goes stale — and lanes then ESTIMATE "now" as
// block-time + guessed elapsed, systematically overshooting the true clock
// (two independent lanes were struck by the evidence guard within 30 min on
// 2026-08-28 for ~+10m future-dated "re-verified at …" clocks). The agent loop
// pushes a fresh [HARNESS CLOCK] note before every model call — that note (or
// a tool-printed clock) is the ONLY honest source of "now".
const CLOCK_DISCIPLINE =
  'For a CURRENT-time ("now") citation, use the latest [HARNESS CLOCK] note (refreshed every turn) or a tool-printed clock verbatim — NEVER estimate "now" by adding elapsed minutes to the block above; it is run-start time and goes stale mid-run.';

const userTsRule = (tz: string) =>
  `Timestamp rule: timestamps written FOR THE USER (chat replies, run reports, summaries, PR/issue bodies) render BOTH clocks — the USER LOCAL time above (${tz}) first, with the UTC instant in parentheses, e.g. "10:30 PM PDT (05:30Z)" — never a bare Zulu-only or local-only timestamp; when citing any stored UTC instant to the user (a past run, a deploy, a log timestamp), convert it to ${tz} for the local half (mind DST — the offset above is today's). Machine-to-machine content (hook payloads, log lines, schedule prompts, audit trails, file names) stays UTC / ISO-8601 only. ${CLOCK_DISCIPLINE}`;

const UTC_TS_RULE =
  'Timestamp rule: the user\'s timezone is not known — use UTC (ISO-8601) everywhere, and label times "UTC" when writing for the user. Machine-to-machine content (hook payloads, log lines, schedule prompts) stays UTC. ' + CLOCK_DISCIPLINE;

/**
 * The [CURRENT DATE & TIME] block for coding agents: the shared UTC + optional
 * user-local rendering, plus the user-vs-machine timestamp rule. An invalid tz
 * degrades to the UTC-only block (same as chat).
 */
export function buildCodingDateTimeBlock(userTimezone?: string): string {
  const tz = userTimezone && isValidTimezone(userTimezone) ? userTimezone : undefined;
  return buildDateTimeBlock(tz, tz ? userTsRule(tz) : UTC_TS_RULE);
}

/**
 * The per-turn [HARNESS CLOCK] note (ticket 63e9a3cb). The [CURRENT DATE & TIME]
 * block is built once per run attempt and goes stale on a long run; the agent
 * loop pushes this one-liner before every model call and splices it out after
 * (the plan-reminder transient pattern — system-role is safe precisely because
 * it never persists mid-conversation). It is the always-fresh "now" the
 * CLOCK_DISCIPLINE rule points at, so the lane never has to estimate elapsed
 * time. Keep it ONE line: it costs tokens on every turn.
 *
 * The prefix MUST stay '[HARNESS CLOCK' — transient-messages.ts, the checkpoint
 * writer, and history replay all strip these notes by that exact prefix.
 */
function buildClockNote(userTimezone: string | undefined, runStartLabel: string): string {
  const now = new Date();
  const iso = now.toISOString();
  const tz = userTimezone && isValidTimezone(userTimezone) ? userTimezone : undefined;
  let local = '';
  if (tz) {
    try {
      const time = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: tz, hour12: true, timeZoneName: 'short',
      });
      const date = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
      local = ` / ${time} ${date} (${tz})`;
    } catch {
      // Invalid timezone string — UTC-only note
    }
  }
  return `[HARNESS CLOCK — not typed by the user] Current time: ${iso}${local}. Cite THIS (or a tool-printed clock) as "now" — ${runStartLabel} is run-start time; never add estimated elapsed minutes to it.`;
}

/** Coding-lane variant: the stale reference is the [CURRENT DATE & TIME] block. */
export function buildCodingClockNote(userTimezone?: string): string {
  return buildClockNote(userTimezone, 'the [CURRENT DATE & TIME] block');
}

/**
 * Chat-lane machine-wake variant (ticket ad325229, 2026-09-16): a fleet
 * message-wake lane whose ONLY clock was its ~6-min-stale wake stamp estimated
 * "now" as wake + guessed elapsed and headlined a phantom "19:21Z" against a
 * real 19:16:34Z clock (struck pre-delivery — the identical overshoot shape
 * 63e9a3cb killed on coding lanes). The agent loop now pushes this note every
 * turn on top-level machine-triggered chat runs; its stale reference is the
 * machine-wake line (chat lanes carry no [CURRENT DATE & TIME] block).
 */
export function buildChatWakeClockNote(userTimezone?: string): string {
  return buildClockNote(userTimezone, 'the machine-wake line');
}
