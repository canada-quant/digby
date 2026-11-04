/**
 * Owner briefings (owner 2026-09-04): the plain-English layer over the fleet
 * supervisor's machine wake notes. The wake notes themselves are AUDIT
 * artifacts — written for the evidence guard, full of ids/timestamps/tables —
 * and the owner reported exactly that ("I thought I was going to get actual
 * agent messages in the chat — concise NON-TECHNICAL summaries… Instead I
 * still see 'WAKE — 03:43Z. No-op; chain still gated, no action.'"). This
 * service rewrites a DELIVERED (guard-passed) wake note into the owner's
 * progress update — per the owner's 2026-09-13 spec (review issue 4):
 * "concise current progress related to current goals and ETAs by project
 * level that is non technical and easy to understand" — ONE short line per
 * project that moved (<Project>: what moved → what is next → ETA or "no ETA
 * yet") plus a "Needs you:" line only when a real decision is open — and
 * persists it as a NORMAL assistant message in the supervisor chat (metadata.kind
 * 'owner_briefing'), so it renders as a regular bubble — never folded into
 * the machine-turn accordions — and doubles as the dashboard Fleet-summary
 * card's content (fleet.service getLatestSupervisorWakeNote prefers it).
 *
 * ONE implementation, two callers:
 *   - chat-agent.service finalize — fires after a supervisor machine-wake run
 *     delivers its final note (fire-and-forget);
 *   - fleet.service getLatestSupervisorWakeNote — BOOTSTRAP: when the
 *     dashboard poll finds no briefing in 24h but does hold a clean wake
 *     note, it generates one from that note (and returns the technical
 *     fallback for the current request — the next poll picks the briefing up).
 *
 * Cadence: a Redis NX lock (`fleet:briefing:<chatId>`, 90-minute TTL) caps
 * hook-wake storms at one briefing per ~90min — with the supervisor's 2h
 * sweep as the deterministic heartbeat this yields a steady rhythm. The lock
 * is claimed BEFORE generation and never released early: a failed/skipped
 * generation waits out the window rather than retrying into a storm. Head
 * lines repeat only when changed or past their window, and a fleet briefing
 * that is only the nothing-new line under an empty head is skipped (owner
 * 2026-10-21 — see briefingHeadDedupeDisabled).
 *
 * DETERMINISTIC FIRST, GROUNDED SECOND (review 2026-09-13 issue 4 follow-up):
 * the first live briefing on the per-project prompt (2026-09-13 20:37Z)
 * fabricated project lines ("Kimi K3:", "GLM-5:" — model names the note
 * mentioned only as the owner's model-config asks) and an owner ask the
 * supervisor had never opened; the owner replied "stop asking me so much".
 * So: when the note has parseable per-project sections (bold lines / table —
 * the doctrine shape since 672ff078) the deterministic rendering
 * (renderBriefingFromNote) IS the briefing and the LLM never runs. Only a
 * free-form note reaches utilityChat, and its output passes a GROUNDING GATE
 * (groundBriefingInNote): a `<Project>:` line survives only when its label is
 * in the note (substring of the scrubbed note, or a parsed project name); a
 * "Needs you:" line survives only when the note carries a needs-you marker.
 * All-dropped → fall back to the rendering → else skip. Each posted briefing
 * logs ONE info with { path: 'deterministic'|'llm', droppedUngrounded,
 * droppedNeedsYou } so the two paths are countable.
 *
 * PROJECT SUPERVISORS (Project-supervisor preflight 2026-09-14 — no behaviour
 * change here): a per-project supervisor lane (isProjectSupervisor) reports
 * UP to the fleet chat via send_chat_message, and the fleet prompt tells the
 * fleet chat to fold those reports into its own per-project sections — so a
 * project supervisor's progress reaches this briefing through the fleet note's
 * `**<project>** — …` / table rows exactly like any other project, with the
 * same grounding gate. It is NOT generated from project-lane notes directly
 * (that would post a second briefing stream into the fleet chat); the
 * fleet-independent owner surfaces for project lanes are the Project Pulse
 * "supervisor says" fact (project-digest.service) and the watchdog's
 * meta.projectId note metrics (attention-watchdog.service).
 *
 * FAIL-OPEN everywhere: any error only logs — a briefing must never break a
 * wake finalize or a dashboard read. Defensive output gates on both paths:
 * output still carrying an 8+-hex id or a markdown table pipe is SKIPPED
 * (log, no post) rather than shipping machine artifacts to the owner; LLM
 * output that opens with the vague fleet voice ("Your fleet… / Your
 * assistants… / The fleet…" — the shape the owner complained about three
 * times on 2026-09-13 after ticket ed04c9b2 closed against the wrong surface)
 * is REPLACED by the deterministic rendering, never posted as-is; a false
 * fleet-wide "stopped" claim is repaired against measured liveness.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import type { FleetLivenessSnapshot } from '../platform/supervisor-state.service';
// Supervisor OFF switch (owner 2026-09-26): a briefing posted while a tier is
// switched off opens with the harness-composed status line (no model prose).
import { anySupervisorSwitchOff, getSupervisorSwitchState } from '../platform/supervisor-switch';
// BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20): the action claims the integrity check could
// not verify are marked "(unverified)" (deterministic path) or left out (LLM rewrite path). Pure leaf — no graph.
import {
  UNVERIFIED_MARKER,
  briefingUnverifiedFilterDisabled,
  dedupeUnverifiedClaims,
  extractAnnotationClaims,
  planUnverifiedBriefing,
  type UnverifiedClaim,
} from '../platform/unverified-claims';
// The supervisor harness appendix is never the model's words (review fix 2026-10-20). Pure leaf — no graph.
import { stripTrailingHarnessAppendix, supervisorHarnessReceiptsDisabled } from '../platform/harness-receipts';
import { CARRIED_FORWARD_LABEL } from '../chat-agent/structured-blocks';
import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';

/** "Fleet supervisor: OFF since … by … — wakes skipped: N" for the briefing head; null when both switches are ON. Never throws. */
export async function supervisorSwitchBriefingLine(): Promise<string | null> {
  try {
    if (!(await anySupervisorSwitchOff())) return null;
    const state = await getSupervisorSwitchState();
    return state.line;
  } catch {
    return null;
  }
}

/** 2026-09-27: "<seat> seat X unusable: <reason> — running on Y since <t>
 *  (retried after <t2>)" per seat LATCHED off by a deterministic invalid-request
 *  rejection (loop-metrics listActiveSeatLatches ← coding/seat-invalid-request);
 *  null when none. Harness-stated, never model prose. Never throws. */
export async function seatLatchBriefingLine(): Promise<string | null> {
  try {
    const [{ listActiveSeatLatches }, { seatLatchLine }] = await Promise.all([
      import('../platform/loop-metrics.service'),
      import('../coding/seat-invalid-request'),
    ]);
    const latches = await listActiveSeatLatches();
    return latches.length ? seatLatchLine(latches) : null;
  } catch {
    return null;
  }
}

// Refused self-renewals (review-fixer 2026-09-27, finding B2 follow-up): a
// lane whose renewOnExhaustion successor the governor refused is deaf with a
// 🛑 note in a chat nobody reads when no supervisor consumes the alarm — the
// briefing head carries the harness count so the owner sees it regardless.
import { renewRefusalLine } from '../coding/renew-refusal-surface';

/** "Self-armed watches stopped (last 24 h, harness-measured): N — …" for the briefing head; null when none. Never throws. */
export async function renewRefusalBriefingLine(userId: string | null | undefined): Promise<string | null> {
  try {
    if (!userId) return null;
    return await renewRefusalLine({ scope: 'user', userId });
  } catch {
    return null;
  }
}

/** Rollout self-governance (2026-09-27): "Decision gate (auto-rollout ON): 2 purposes
 *  moved to act …; parked …; ready and waiting for your answer …" — the automaton's
 *  week, harness-stated; null when quiet. Never throws. */
export async function decisionRolloutBriefingLine(): Promise<string | null> {
  try {
    const { rolloutBriefingLine } = await import('../platform/decision-gate-rollout');
    return await rolloutBriefingLine();
  } catch {
    return null;
  }
}

/** Nightly live-chat audit (2026-10-04): "Live-chat audit (last 24 h): N human turns · Quick lane … · replay
 *  agreement … · ⚠ regression tickets …" — admin accounts only (the audit spans every user). `maxAgeMs` bounds
 *  how old the audit row may be (default: the audit module's own 36 h). Never throws. */
export async function liveChatAuditLine(userId: string, maxAgeMs?: number): Promise<string | null> {
  try {
    const { liveChatAuditBriefingLine } = await import('../platform/live-chat-audit');
    return maxAgeMs === undefined ? await liveChatAuditBriefingLine(userId) : await liveChatAuditBriefingLine(userId, new Date(), maxAgeMs);
  } catch {
    return null;
  }
}

/**
 * Fleet-wide head lines belong to the FLEET briefing only (audit 2026-10-06 T8-1 — schooltime F7, spark F10,
 * others F12): the nightly "Live-chat audit (last 24 h)" line (and the decision-gate rollout line, equally
 * fleet-wide) headed 87 of 90 briefings in 48 h — 65 of them in PROJECT-supervisor chats, the same ~17-hour-old
 * row on every one. Now: project scope carries neither, and the fleet briefing carries the audit line only while
 * the nightly row is younger than FLEET_HEAD_AUDIT_FRESH_MS. BRIEFING_FLEET_HEAD_SCOPE_DISABLED=1 restores every
 * head line in every scope with the audit module's 36 h window.
 */
export const FLEET_HEAD_AUDIT_FRESH_MS = 6 * 60 * 60_000;
export function briefingFleetHeadScopeDisabled(): boolean {
  return process.env.BRIEFING_FLEET_HEAD_SCOPE_DISABLED === '1';
}

/** The briefing head: the supervisor-switch line, the seat-latch line, the refused-renewal line, the decision-gate rollout line and the live-chat audit line (each optional), joined. */
export function composeBriefingHead(lines: Array<string | null | undefined>): string | null {
  const kept = lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
  return kept.length ? kept.join('\n') : null;
}

/**
 * Head-line repeat dedupe (owner 2026-10-21 in the Fleet Supervisor chat: "what are these messages over and over
 * again?"). The rollout line describes the whole WEEK and the live-chat audit line the night's row, so the same
 * paragraph headed every fleet briefing (03:40, 07:43 …), and a no-op wake still posted a bare "Nothing new on any
 * project" under it. Now, per supervisor chat, each head line is carried only when what it SAYS changed since it was
 * last POSTED or it was last posted at least its repeat window ago (informational lines 24 h; alarm-class lines —
 * supervisor OFF switch, latched seat, refused renewals — 12 h, and a changed one is never held back). The memory is
 * stamped only after the row lands; an unreadable memory carries every line (today's head). A FLEET briefing that is
 * only the nothing-new line under an empty head is not posted. BRIEFING_HEAD_DEDUPE_DISABLED=1 restores both.
 */
export function briefingHeadDedupeDisabled(): boolean {
  return process.env.BRIEFING_HEAD_DEDUPE_DISABLED === '1';
}
export type BriefingHeadKey = 'switch' | 'latch' | 'refusal' | 'rollout' | 'audit';
export const BRIEFING_HEAD_ALARM_REPEAT_MS = 12 * 60 * 60_000;
export const BRIEFING_HEAD_INFO_REPEAT_MS = 24 * 60 * 60_000;
const HEAD_REPEAT_MS: Record<BriefingHeadKey, number> = {
  switch: BRIEFING_HEAD_ALARM_REPEAT_MS, latch: BRIEFING_HEAD_ALARM_REPEAT_MS, refusal: BRIEFING_HEAD_ALARM_REPEAT_MS,
  rollout: BRIEFING_HEAD_INFO_REPEAT_MS, audit: BRIEFING_HEAD_INFO_REPEAT_MS,
};
/** Outlives the longest repeat window — an expired memory means every line is due again anyway. */
export const BRIEFING_HEAD_MEMORY_TTL_MS = 48 * 60 * 60_000;
export const briefingHeadMemoryKey = (chatId: string) => `fleet:briefing:head:${chatId}`;
export type BriefingHeadMemory = Partial<Record<BriefingHeadKey, { sig: string; at: number }>>;

/** What a head line says for the repeat check: the rollout line's relative ages ("3 h ago", "just now") tick every hour with nothing changed. Pure. */
export function briefingHeadSignature(line: string): string {
  return line.replace(/\b(?:\d+\s*(?:h|d|min)\s+ago|just now)\b/gi, '~').replace(/\s+/g, ' ').trim();
}

export interface BriefingHeadPlan {
  /** The lines to carry, in head order. */
  lines: string[];
  /** key → signature of each carried line (stamped into the memory once the row lands). */
  carried: Partial<Record<BriefingHeadKey, string>>;
  /** Lines left out as unchanged repeats inside their window. */
  suppressed: BriefingHeadKey[];
}

/** Which head lines to carry. `memory` null (store unreadable) carries every line. Pure. */
export function planBriefingHead(
  candidates: ReadonlyArray<readonly [BriefingHeadKey, string | null | undefined]>,
  memory: BriefingHeadMemory | null,
  nowMs: number,
): BriefingHeadPlan {
  const plan: BriefingHeadPlan = { lines: [], carried: {}, suppressed: [] };
  for (const [key, line] of candidates) {
    if (typeof line !== 'string' || !line.trim()) continue;
    const sig = briefingHeadSignature(line);
    const last = memory?.[key];
    const age = last && typeof last.sig === 'string' && Number.isFinite(last.at) ? nowMs - last.at : null;
    if (last && age !== null && last.sig === sig && age >= 0 && age < HEAD_REPEAT_MS[key]) {
      plan.suppressed.push(key);
      continue;
    }
    plan.lines.push(line);
    plan.carried[key] = sig;
  }
  return plan;
}

/** {} when nothing is stored; null when the store cannot be read (fail open: carry every line). Never throws. */
async function readBriefingHeadMemory(chatId: string): Promise<BriefingHeadMemory | null> {
  try {
    const raw = await redisClient.get(briefingHeadMemoryKey(chatId));
    if (raw == null) return {};
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as BriefingHeadMemory : {};
  } catch {
    return null;
  }
}

/** Stamp the carried lines AFTER the row landed. A failed write only means the next briefing carries them again. Never throws. */
async function recordBriefingHeadPosted(chatId: string, memory: BriefingHeadMemory | null, plan: BriefingHeadPlan, nowMs: number): Promise<void> {
  const keys = Object.keys(plan.carried) as BriefingHeadKey[];
  if (!keys.length) return;
  try {
    const next: BriefingHeadMemory = { ...(memory ?? {}) };
    for (const key of keys) next[key] = { sig: plan.carried[key]!, at: nowMs };
    await redisClient.set(briefingHeadMemoryKey(chatId), JSON.stringify(next), { PX: BRIEFING_HEAD_MEMORY_TTL_MS });
  } catch { /* fail open */ }
}

/** metadata.kind stamped on briefing rows — the classifier-exemption marker
 *  (backend fleet.service classifyThreadRows + frontend machine-turn-grouping
 *  both exempt it from machine-noise folding). */
export const OWNER_BRIEFING_KIND = 'owner_briefing';

/** One briefing per ~90min per supervisor chat (hook-wake storm cap). */
export const BRIEFING_LOCK_TTL_MS = 90 * 60 * 1000;

export const briefingLockKey = (chatId: string) => `fleet:briefing:${chatId}`;

/** How much of a long wake note the rewrite prompt sees. */
const NOTE_INPUT_CAP = 6000;

/**
 * Defensive post-generation gate: the briefing failed its one job if it still
 * contains machine artifacts. Flags a markdown table pipe, or an 8+-char hex
 * run containing at least one digit (the fleet-dashboard extractWorkRefs id
 * shape, widened to longer runs — full 32-hex ids flag too; the digit
 * requirement keeps rare all-letter words like 'deadbeef' prose from
 * mattering while catching every realistic random id).
 */
export function briefingLooksMachine(text: string): boolean {
  if (text.includes('|')) return true;
  const hexRuns = text.match(/\b[0-9a-f]{8,}\b/g) ?? [];
  return hexRuns.some((run) => /\d/.test(run));
}

// ── Review 2026-09-13 issue 4: vague-voice gate + deterministic fallback ──────

/** The openers every post-ed04c9b2 briefing carried ("Your fleet is running…",
 *  "Your assistants are…", "The fleet…") — the owner complained three times. */
const VAGUE_OPENER_RE = /^[\s"'*_-]*(your fleet|your assistants|the fleet)\b/i;

/** Review 2026-09-13 issue 4: true when the utility output opens with the
 *  vague fleet voice instead of a per-project progress line. */
export function briefingLooksVague(text: string): boolean {
  return VAGUE_OPENER_RE.test(text.trim());
}

/** Section/headline names that are NOT projects in the supervisor's doctrine
 *  (the vague fleet-voice openers are listed too, so a deterministic rendering
 *  can never open with them — briefingLooksVague is structurally unreachable
 *  on the deterministic path). */
const NON_PROJECT_NAME_RE = /^(fleet|your fleet|the fleet|your assistants|wake|sweep|receipts?|what moved|actions?( taken)?|owner decisions?|deltas?)\b/i;
/** Whole-name section labels (exact match — "Project Phoenix" or "Next.js port" are real projects). */
const SECTION_LABEL_RE = /^(next|status|summary|headline|needs owner|owner)$/i;
const NEEDS_YOU_NAME_RE = /^needs you\b/i;
/** A "Needs you" marker in any doctrine shape, anywhere in the note: an inline
 *  "Needs you: …" / "**Needs you** — …" line, a "## Needs you" section header,
 *  or a whole-line "**Needs you**" header (the plainNeedsYou / NEEDS_YOU_NAME_RE
 *  shapes, line-anchored). The grounding gate lets an LLM "Needs you:" line
 *  through ONLY when this fires — the model never invents an owner ask. */
const NEEDS_YOU_MARKER_RE = /^\s*(?:[-*•]\s+|\d+\.\s+|#{1,3}\s+)?(?:\*\*)?needs you\b/im;
/** Table header / separator cells the renderer must skip. */
const TABLE_SEP_CELL_RE = /^:?-{2,}:?$/;
const TABLE_HEADER_CELL_RE = /^(project|lane|item|name)$/i;
const MAX_RENDERED_PROJECT_LINES = 8;
const MAX_RENDERED_LINE_CHARS = 240;
/** The output shape the rewrite prompt mandates — `<Project>: <body>` (optional
 *  bullet / bold; label ≤ 60 chars, no arrow, and the colon must be followed by
 *  whitespace so "12:30" or "2:04 PM" inside prose never reads as a label). */
const LLM_PROJECT_LINE_RE = /^(?:[-*•]\s+|\d+\.\s+)?\*{0,2}([^:→\n]{1,60}?)\*{0,2}:\s+(.+)$/;

/** Strip the machine artifacts a wake note legitimately carries (owner-nav
 *  links, receipt ids, Z-times, markdown emphasis) so a note-derived line
 *  passes briefingLooksMachine and reads as plain English. */
export function scrubMachineArtifacts(text: string): string {
  const base = (briefingScrubHolesDisabled() ? text : closeIdHoles(text))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                                          // [label](url) → label
    .replace(/\(\s*(?:msg|message|sched(?:ule)?|ticket|pr|run|chat|receipt|commit|sha|id)?\s*#?[0-9a-f]{8,}[^)]*\)/gi, '') // (msg 1a2b3c4d …)
    .replace(/\b(?:msg|message|sched(?:ule)?|ticket|pr|run|chat|receipt|commit|sha|id)\s+#?[0-9a-f]{8,}\b/gi, '')      // msg 1a2b3c4d
    .replace(/\b[0-9a-f]{8,}\b/g, (m) => (/\d/.test(m) ? '' : m))                    // bare ids (digit-bearing hex runs)
    .replace(/\b(?:at|around|by|since|until)\s+\d{1,2}:\d{2}(?::\d{2})?Z\b/gi, '')     // "at 03:43Z" (no dangling "at")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?Z\b/g, '')                                    // bare 03:43Z
    .replace(/\*\*|__|`/g, '')                                                        // emphasis / code marks
    .replace(/[✅⚠️❌]/g, '')
    // Separators left hollow by the id/time removals above (fleet-supervisor
    // assessment 2026-09-15: the 18:18Z briefing read "six worker deaths ( / /
    // + three self-recovered)" and "(its + notes, msgs / )"): drop leading
    // separators after an opener, trailing ones before a closer, and collapse
    // runs of separators between now-empty slots to one.
    .replace(/([([{])\s*(?:[\/,;+·]\s*)+/g, '$1')
    .replace(/\s*(?:[\/,;+·]\s*)+([)\]}])/g, '$1')
    .replace(/(?:\s*[\/,;·]\s*){2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s—–→:,-]+$/g, '')
    .trim();
  const holed = briefingScrubHolesDisabled() ? base : closeQuoteHoles(base);
  return briefingScrubHusksDisabled() ? holed : scrubIdHusks(holed);
}

/**
 * Husks the id removals above leave behind (audit 2026-10-06 T8-4, stanne P3 / others F12): "(todo 57e0fe8d)" lost
 * its id but kept "(todo )" because todo/goal/step/lane… were not in the label list; "per harness TIMING 02:58Z)"
 * kept a space before the closer; "Lane 1a2b3c4d's" became "Lane 's". A paren group holding only id labels and
 * separators goes, a space before a closer goes, and a detached possessive re-attaches.
 * BRIEFING_SCRUB_HUSKS_DISABLED=1 restores the previous output byte-for-byte. Pure.
 */
const HUSK_LABELS = 'todos?|goals?|steps?|lanes?|sessions?|directives?|hooks?|questions?|dispatch(?:es)?|msgs?|messages?|sched(?:ule)?s?|tickets?|prs?|runs?|chats?|receipts?|commits?|shas?|ids?';

/**
 * Holes the deletions below used to leave (audit 2026-10-08 W1-6 — supervisors F9): "todos a62eb6ce +
 * bf3514e9 blocked/external + 511ae1b6 pending" read "todos + blocked/external + pending"; "confirmed on
 * the new build as of 19:44Z." read "as of."; "at the ~17:55Z check" read "at the ~ check"; "Verdict on
 * 7cabb0cc: all 6 claims" read "Verdict on:"; '"0037460b · In-chat · Tests"' read '" · In-chat'. Run
 * BEFORE the deletions: an id LIST after its label becomes a count ("2 todos"), a listed id followed by a
 * word becomes "1", a preposition goes with the id / Zulu time it governs, a "~" goes with its time.
 * BRIEFING_SCRUB_HOLES_DISABLED=1 restores the previous output byte-for-byte. Pure.
 */
export function briefingScrubHolesDisabled(): boolean {
  return process.env.BRIEFING_SCRUB_HOLES_DISABLED === '1';
}
const HOLE_ID = '(?=[0-9a-f]*\\d)[0-9a-f]{8,}(?:-[0-9a-f]{4,12})*';
const LIST_LABEL_PLURAL: Record<string, string> = {
  todo: 'todos', goal: 'goals', ticket: 'tickets', lane: 'lanes', session: 'sessions', chat: 'chats', schedule: 'schedules', sched: 'schedules',
  directive: 'directives', question: 'questions', hook: 'hooks', run: 'runs', pr: 'PRs', msg: 'messages', message: 'messages', step: 'steps',
};
const ID_LIST_RE = new RegExp(`\\b(todo|goal|ticket|lane|session|chat|schedule|sched|directive|question|hook|run|pr|msg|message|step)s?\\s+(${HOLE_ID}(?:\\s*(?:\\+|,|&|/|and)\\s*${HOLE_ID})+)\\b`, 'gi');
// Only after a WORD ("blocked/external + 511ae1b6 pending"), never inside an id run ("1a2b3c4d + 5e6f7a8b notes").
const LISTED_ID_BEFORE_WORD_RE = new RegExp(`(?<![0-9a-f]{8}\\s*)([+&]\\s*)\\b${HOLE_ID}\\b(?=\\s+[a-z])`, 'gi');
const PREP_ID_RE = new RegExp(`\\s*\\b(?:on|for|of|in|to|from|with|about|at|by|re|per)\\s+(?:(?:msg|message|ticket|chat|run|receipt|commit|sha|id|todo|goal|lane|session)\\s+)?#?\\b${HOLE_ID}\\b(?=\\s*[:;,.)\\]]|\\s*$)`, 'gim');
const PREP_ZTIME_RE = /\s*\b(?:at|around|by|since|until|till|as of|from|after|before|through|past|near)\s+~?\d{1,2}:\d{2}(?::\d{2})?Z\b/gi;
export function closeIdHoles(text: string): string {
  return text
    .replace(ID_LIST_RE, (_m, label: string, ids: string) => {
      const n = (ids.match(new RegExp(HOLE_ID, 'gi')) ?? []).length;
      const singular = label.toLowerCase();
      return `${n} ${LIST_LABEL_PLURAL[singular] ?? `${singular}s`}`;
    })
    .replace(LISTED_ID_BEFORE_WORD_RE, '$11')
    .replace(PREP_ID_RE, '')
    .replace(PREP_ZTIME_RE, '')
    .replace(/~\s*\d{1,2}:\d{2}(?::\d{2})?Z\b/g, '');                // "~17:55Z" — the tilde goes with its time
}
/** The post-pass: separators an id removal left right after an OPENING quote or paren. Pure. */
export function closeQuoteHoles(text: string): string {
  return text
    .replace(/(^|[\s:(])(["“])\s*(?:[·\/,;+—–-]\s*)+/g, '$1$2')   // 'lane: "0037460b · In-chat' → 'lane: "In-chat'
    .replace(/\(\s+/g, '(');                                         // "(22:20Z tonight" → "(tonight"
}
const HUSK_GROUP_RE = new RegExp(`\\((?:\\s*(?:${HUSK_LABELS})\\b[\\s,/+·;]*)+\\)`, 'gi');
export function briefingScrubHusksDisabled(): boolean {
  return process.env.BRIEFING_SCRUB_HUSKS_DISABLED === '1';
}
export function scrubIdHusks(text: string): string {
  return text
    .replace(HUSK_GROUP_RE, '')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/(\w)\s+'s\b/g, "$1's")
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s—–→:,-]+$/g, '')
    .trim();
}

interface ParsedNoteProject { name: string; body: string; fromTable: boolean }
interface ParsedNoteSections {
  /** Per-project sections in note order (bold lines replace table rows in place). */
  projects: ParsedNoteProject[];
  /** The first "Needs you" decision text the note carries, scrubbed. */
  needsYou: string | null;
  /** The doctrine's stand-alone 'WAKE/SWEEP: no-op' line is present. */
  noOp: boolean;
}

/**
 * The ONE parser behind the deterministic path. Reads the two shapes the
 * supervisor doctrine (supervisor.service.ts "Status note format", 2026-09-13
 * goal-progress rewrite) emits:
 *   **<project>** — <goal>: what moved → what is next → ETA        (bold lines)
 *   | <project> | <progress toward its goal> | <ETA> |             (table rows)
 * plus a "Needs you" line/section and the stand-alone 'WAKE/SWEEP: no-op'
 * line. Bold lines win over table rows for the same project (they carry more
 * detail). Every name/body is passed through scrubMachineArtifacts.
 */
function parseNoteSections(noteContent: string): ParsedNoteSections {
  const lines = noteContent.split(/\r?\n/);
  const projects = new Map<string, ParsedNoteProject>();
  let needsYou: string | null = null;
  const boldLine = /^\s*(?:[-*•]\s+|\d+\.\s+|#{1,3}\s+)?\*\*([^*\n]{1,80}?)\*\*\s*(?:[—–:-]\s*)?(.*)$/;
  const plainNeedsYou = /^\s*(?:[-*•]\s+|#{1,3}\s+)?(?:\*\*)?needs you(?:\*\*)?\s*[:—–-]\s*(.+)$/i;

  const remember = (rawName: string, rawBody: string, fromTable: boolean) => {
    const name = scrubMachineArtifacts(rawName);
    const body = scrubMachineArtifacts(rawBody);
    if (!name || body.length < 3 || NON_PROJECT_NAME_RE.test(name) || SECTION_LABEL_RE.test(name) || TABLE_HEADER_CELL_RE.test(name) || /^\d+$/.test(name)) return;
    const key = name.toLowerCase();
    const prev = projects.get(key);
    if (prev && !(prev.fromTable && !fromTable)) return; // keep the first bold line; let bold replace a table row
    projects.set(key, { name, body, fromTable }); // set-on-existing keeps the original position
  };

  // Section tracking: a '## Needs you' / whole-line '**Needs you**' header
  // followed by bullets is the doctrine's other "Needs you" shape.
  const sectionHeader = /^\s*(?:#{1,3}\s+(.+?)\s*#*\s*|\*\*([^*\n]{1,80}?)\*\*\s*)$/;
  let inNeedsYouSection = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const h = sectionHeader.exec(line);
    if (h) { inNeedsYouSection = NEEDS_YOU_NAME_RE.test((h[1] ?? h[2] ?? '').trim()); continue; }
    const ny = plainNeedsYou.exec(line);
    if (ny) { needsYou = needsYou ?? scrubMachineArtifacts(ny[1]); continue; }
    if (inNeedsYouSection) {
      const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.+)$/.exec(line);
      if (bullet) { needsYou = needsYou ?? scrubMachineArtifacts(bullet[1]); continue; }
    }
    const b = boldLine.exec(line);
    if (b) {
      if (NEEDS_YOU_NAME_RE.test(b[1].trim())) { needsYou = needsYou ?? scrubMachineArtifacts(b[2]); continue; }
      if (b[2].trim()) remember(b[1], b[2], false);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.length < 2) continue;
      if (cells.every((c) => TABLE_SEP_CELL_RE.test(c) || c === '')) continue;
      if (TABLE_HEADER_CELL_RE.test(cells[0])) continue;
      const [name, progress, eta] = cells;
      const body = eta ? `${progress} → ${eta}` : progress;
      remember(name, body, true);
    }
  }

  return {
    projects: [...projects.values()],
    needsYou,
    noOp: /^\s*(?:\*\*)?(?:WAKE|SWEEP):\s*no-op\b/im.test(noteContent),
  };
}

/** The project names the note's own per-project sections carry (scrubbed, note
 *  order) — the grounding gate's second source of truth beside raw substring. */
export function parseNoteProjectNames(noteContent: string): string[] {
  return parseNoteSections(noteContent).projects.map((p) => p.name);
}

/** True when the note itself carries a "Needs you" marker (any doctrine shape). */
export function noteHasNeedsYouMarker(noteContent: string): boolean {
  return NEEDS_YOU_MARKER_RE.test(noteContent);
}

/**
 * Deterministic rendering of the note's own per-project sections — since the
 * 2026-09-13 deterministic-first change this is the PRIMARY briefing whenever
 * the note has parseable sections (the LLM never runs), and the fallback when
 * the LLM path's output is vague or fully ungrounded. Output is capped at
 * MAX_RENDERED_PROJECT_LINES lines; a note with only the doctrine's no-op line
 * renders as NOTHING_NEW_LINE. Returns null when the note holds nothing
 * renderable — the caller then SKIPS rather than posting the vague sentence.
 */
export function renderBriefingFromNote(noteContent: string): string | null {
  const { projects, needsYou, noOp } = parseNoteSections(noteContent);
  const out: string[] = [];
  for (const p of projects.slice(0, MAX_RENDERED_PROJECT_LINES)) {
    const rendered = `${p.name}: ${p.body}`;
    if (rendered.includes('|')) continue;
    let line = rendered.length > MAX_RENDERED_LINE_CHARS ? `${rendered.slice(0, MAX_RENDERED_LINE_CHARS - 1).trimEnd()}…` : rendered;
    // BRIEFING-UNVERIFIED-FILTER: a truncation never cuts an unverified marker off its line (the marker
    // only exists when planUnverifiedBriefing put it there — every other line is byte-identical).
    if (rendered.includes(UNVERIFIED_MARKER) && !line.includes(UNVERIFIED_MARKER)) {
      line = `${rendered.slice(0, MAX_RENDERED_LINE_CHARS - UNVERIFIED_MARKER.length - 2).trimEnd()}… ${UNVERIFIED_MARKER}`;
    }
    out.push(line);
  }
  if (out.length === 0 && noOp) out.push(NOTHING_NEW_LINE);
  if (needsYou && needsYou.length >= 3 && !needsYou.includes('|')) out.push(`Needs you: ${needsYou}`);
  return out.length > 0 ? out.join('\n') : null;
}

/**
 * BRIEFING-UNVERIFIED-FILTER review fix (2026-10-20): the briefing of a free-form note whose EVERY content
 * line is an unverified claim. Dropping the claims leaves the LLM rewrite nothing but the liveness line, so
 * it answered "Nothing new on any project" (or liveness-only prose) and the owner read that nothing moved —
 * instead of the claim, marked. This renders the MARKED note itself: one line per content line (bullets /
 * headings / emphasis / ids scrubbed like every rendered body, blockquotes and fenced code skipped, a table
 * row never rendered), capped like the per-project rendering, a clipped line keeping its marker. Only lines
 * that carry the marker are kept (any other line had content and would not have reached this path). Null
 * when nothing survives — the caller then skips (the lock holds the window). Pure.
 */
export function renderUnverifiedOnlyBriefing(markedNote: string): string | null {
  const out: string[] = [];
  let inFence = false;
  for (const raw of String(markedNote ?? '').split('\n')) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence || /^\s*>/.test(raw) || raw.includes('|') || !raw.includes(UNVERIFIED_MARKER)) continue;
    const body = scrubMachineArtifacts(raw.replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+|#{1,6}\s+)/, ''));
    if (!/[a-z0-9]/i.test(body.replace(UNVERIFIED_MARKER, ''))) continue;
    let line = body.length > MAX_RENDERED_LINE_CHARS ? `${body.slice(0, MAX_RENDERED_LINE_CHARS - 1).trimEnd()}…` : body;
    if (!line.includes(UNVERIFIED_MARKER)) line = `${body.slice(0, MAX_RENDERED_LINE_CHARS - UNVERIFIED_MARKER.length - 2).trimEnd()}… ${UNVERIFIED_MARKER}`;
    out.push(line);
    if (out.length >= MAX_RENDERED_PROJECT_LINES) break;
  }
  return out.length > 0 ? out.join('\n') : null;
}

/** True when a rendering carries a project line or the nothing-new line — the
 *  deterministic-first condition. A "Needs you:"-only rendering is NOT enough
 *  to skip the LLM (it still serves as that path's fallback). */
export function renderingIsSubstantive(rendered: string | null): boolean {
  return rendered !== null && rendered.split('\n').some((l) => !NEEDS_YOU_NAME_RE.test(l.trim()));
}

export interface GroundedBriefing {
  /** The surviving lines, or null when nothing grounded survived (caller falls back / skips). */
  text: string | null;
  /** How many `<Project>: …` lines the LLM emitted (Needs-you excluded). */
  projectLines: number;
  /** How many of those were dropped as ungrounded in the note. */
  droppedUngrounded: number;
  /** An LLM "Needs you:" line was dropped because the note carries no needs-you marker. */
  droppedNeedsYou: boolean;
}

/**
 * Grounding gate for the LLM path (review 2026-09-13 issue 4 follow-up). The
 * first live briefing on the new prompt fabricated project lines ("Kimi K3:",
 * "GLM-5:" — model names the note mentioned only as the owner's model-config
 * asks) and an owner ask the supervisor had never opened; the owner replied
 * "stop asking me so much". Every `<Project>: <body>` line must be GROUNDED:
 * its label (scrubbed, case-insensitive) appears as a substring of the scrubbed
 * note, or equals a project name parsed from the note's own sections. A
 * "Needs you:" line survives only when the note itself carries a needs-you
 * marker. Prose lines that are not project-shaped (NOTHING_NEW_LINE, free
 * sentences) pass through — the vague/machine/repair gates own those. When
 * every project line is dropped, or nothing survives at all, `text` is null.
 *
 * Known limit (accepted): substring grounding is permissive — a model name the
 * note mentions in prose ("Kimi K3 supervisor") still grounds a "Kimi K3:" line.
 * The deterministic-first path is the real fix for doctrine-shaped notes; this
 * gate only bounds the free-form fallback.
 */
export function groundBriefingInNote(llmText: string, noteContent: string): GroundedBriefing {
  const scrubbedNote = scrubMachineArtifacts(noteContent).toLowerCase();
  const parsedNames = new Set(parseNoteProjectNames(noteContent).map((n) => n.toLowerCase()));
  const hasNeedsYou = noteHasNeedsYouMarker(noteContent);
  const kept: string[] = [];
  let projectLines = 0;
  let droppedUngrounded = 0;
  let droppedNeedsYou = false;
  for (const raw of llmText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LLM_PROJECT_LINE_RE.exec(line);
    if (!m) { kept.push(line); continue; }
    const label = scrubMachineArtifacts(m[1]);
    if (NEEDS_YOU_NAME_RE.test(label)) {
      if (hasNeedsYou) kept.push(line); else droppedNeedsYou = true;
      continue;
    }
    projectLines += 1;
    const key = label.toLowerCase();
    const grounded = key.length > 0 && (parsedNames.has(key) || scrubbedNote.includes(key));
    if (grounded) kept.push(line); else droppedUngrounded += 1;
  }
  const allProjectLinesDropped = projectLines > 0 && droppedUngrounded === projectLines;
  const text = allProjectLinesDropped || kept.length === 0 ? null : kept.join('\n');
  return { text, projectLines, droppedUngrounded, droppedNeedsYou };
}

/** One line of measured fleet state for the rewrite prompt (never contradict it). */
function livenessPromptLine(liveness: FleetLivenessSnapshot): string {
  const age = liveness.lastFiredAt ? casualAge(Date.now() - liveness.lastFiredAt.getTime()) : null;
  return [
    `${liveness.enabledSchedules} schedules are armed`,
    `${liveness.liveRuns} runs are active right now`,
    age ? `last schedule activity was ${age} ago` : 'no schedule has fired yet',
  ].join(', ');
}

/** The owner's spec for this surface, verbatim (2026-09-13) — quoted in the
 *  prompt so the model optimizes for exactly what was asked. */
export const OWNER_BRIEFING_SPEC =
  'concise current progress related to current goals and ETAs by project level that is non technical and easy to understand';

/** The single line the briefing carries when the note reports no movement. */
export const NOTHING_NEW_LINE = 'Nothing new on any project since the last update.';

/** The rewrite prompt — strict, extractive-only (no facts beyond the note).
 *  Grounded on measured fleet liveness when available (tickets 25c5a7c3 /
 *  23880ce0): the note's "one loop stopped" must never come out as "the fleet
 *  is stopped".
 *
 *  Review 2026-09-13 issue 4 (option A): the old "2-4 sentences in second
 *  person about your fleet / your assistants" voice is GONE — it literally
 *  mandated the vague opener the owner complained about. The prompt now asks
 *  for the owner's spec: one goal-progress line per project (what moved → what
 *  is next → ETA or "no ETA yet"), a "Needs you:" line only for a real open
 *  decision, and skips projects with nothing new. */
export function buildBriefingPrompt(noteContent: string, liveness?: FleetLivenessSnapshot | null): Array<{ role: string; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You write the owner\'s progress update from their fleet supervisor\'s latest internal status note. The owner is non-technical, reading on a phone between meetings, and asked for exactly this: "' + OWNER_BRIEFING_SPEC + '".',
        '',
        'OUTPUT SHAPE (follow it exactly):',
        '- One short line per project the note reports movement on, in this form: <Project>: <what moved> → <what is next> → <ETA, or "no ETA yet">',
        '- Name projects the way the owner does (the project name or its goal title as the note states it, e.g. "<project>: <goal>") — never lane ids, chat prefixes or schedule names.',
        '- Skip any project with nothing new since the last note. If the note says nothing moved anywhere, write the single line: ' + NOTHING_NEW_LINE,
        '- End with ONE line "Needs you: <the decision and the options>" ONLY when the note shows a real owner decision is open. Otherwise write no such line at all — never "nothing needs you".',
        '',
        'HARD RULES:',
        '- Use ONLY facts stated in the note. Never add, guess, or embellish anything — including ETAs: when the note gives no honest estimate for a project, write "no ETA yet".',
        '- NEVER claim the whole fleet is stopped, shut down, or that nothing is running. A single stopped loop is one stopped loop, never the fleet. If nothing is executing at this instant, the fleet is IDLE between runs — say "idle", never "stopped".',
        '- No ids, hex strings, ticket or PR numbers, commit shas, or names of internal machinery.',
        '- No timestamps like "03:43Z". Relative time the note states ("later today", "tomorrow evening", "about 2 hours") is fine; otherwise leave time out.',
        '- No markdown: no tables, no headers, no bullet markers, no bold. Plain lines only.',
        '- No jargon: say "checked", "finished", "waiting", "still running" — never "no-op", "gated", "lane", "sweep", "wake", "firing", "green". Project and product names are fine.',
        '- Never open with "Your fleet", "Your assistants" or "The fleet", and never summarize the fleet as a whole — the owner wants per-project progress, not a fleet summary.',
        ...(liveness ? ['', `FLEET LIVENESS (measured right now — always true, never contradict it): ${livenessPromptLine(liveness)}.`] : []),
        '',
        'Reply with ONLY the update lines — no preamble, no sign-off.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `The supervisor's status note:\n\n${noteContent.slice(0, NOTE_INPUT_CAP)}`,
    },
  ];
}

/**
 * Fleet-wide stopped/nothing-running claims. Matches the phrasings the
 * 2026-09-11 incident (25c5a7c3) and the 23880ce0 screenshots surfaced:
 * "The fleet is stopped.", "nothing is running", "everything has stopped".
 * (Review N5: bare "down" is NOT an alternative — "the fleet is down to one
 * active lane" is a legitimate reduced-capacity sentence. Review N6: the
 * widened forms cover the has-stopped / not-running / nothing-active /
 * everything-down / all-lanes-stopped evasions; a false positive only costs a
 * truthful idle-with-context rewording, since the gate fires solely when
 * measured liveness contradicts the claim.)
 */
const FLEET_STOPPED_CLAIM = /\bfleet is (stopped|shut down|halted|offline)\b|\bfleet (is|has been|was|has) (stopped|shut down|halted)\b|\bfleet is not running\b|\bnothing is (currently )?(running|active)\b|\bno (agents|assistants|runs|lanes|loops|schedules) (are |were )?(currently )?(running|active)\b|\beverything (is|has) (stopped|shut down|halted|down|offline)\b|\ball (lanes|loops|schedules) (are|have) (stopped|halted|shut down)\b/i;

/** Casual age phrasing for the owner ("12 minutes", "about 2 hours"). */
function casualAge(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const h = Math.round(min / 60);
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}

/** The deterministic replacement sentence — measured truth, plain English. */
function fleetLivenessSentence(l: FleetLivenessSnapshot): string {
  const age = l.lastFiredAt ? `, and the last activity was ${casualAge(Date.now() - l.lastFiredAt.getTime())} ago` : '';
  const sched = `${l.enabledSchedules} schedule${l.enabledSchedules === 1 ? ' is' : 's are'} armed`;
  if (l.liveRuns > 0) {
    return `Your fleet is active — ${l.liveRuns} run${l.liveRuns === 1 ? ' is' : 's are'} running right now, and ${sched}${age}.`;
  }
  return `Your fleet is idle between runs — ${sched}${age}.`;
}

/**
 * Deterministic post-generation repair gate (tickets 25c5a7c3 / 23880ce0):
 * when the rewrite claims the whole fleet is stopped / nothing is running but
 * measured liveness shows armed schedules or live runs, the claim is FALSE —
 * replace the offending sentence(s) with the measured liveness sentence
 * (first match), dropping any repeats. A truly unarmed fleet (0 schedules,
 * 0 runs) leaves the text alone — the claim may be true then.
 */
export function repairFleetStoppedClaims(
  text: string,
  liveness: FleetLivenessSnapshot | null,
): { text: string; repaired: boolean } {
  if (!liveness || (liveness.enabledSchedules === 0 && liveness.liveRuns === 0)) {
    return { text, repaired: false };
  }
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.some((s) => FLEET_STOPPED_CLAIM.test(s))) return { text, repaired: false };
  const replacement = fleetLivenessSentence(liveness);
  let inserted = false;
  const out: string[] = [];
  for (const s of sentences) {
    if (FLEET_STOPPED_CLAIM.test(s)) {
      if (!inserted) { out.push(replacement); inserted = true; }
      continue; // drop the false claim
    }
    out.push(s);
  }
  const repairedText = out.join(' ').trim();
  return { text: repairedText || `${replacement} Nothing needs your attention.`, repaired: true };
}

export interface OwnerBriefingArgs {
  /** The supervisor chat the briefing lands in. */
  chatId: string;
  /** The owner (lock + logging scope; the chat row already carries ownership). */
  userId: string;
  /** The DELIVERED (guard-passed) wake note text — the briefing's ONLY source. */
  noteContent: string;
  /** The wake note's durable message id, when the caller holds it. */
  sourceNoteId?: string;
  /**
   * BRIEFING-UNVERIFIED-FILTER (2026-10-20): the action claims the integrity check could not verify on
   * this wake (chat-agent finalize — platform/unverified-claims.ts collectUnverifiedClaims). Their lines
   * are marked "(unverified)" on the deterministic path and left out of the LLM rewrite's input. Claims
   * named by an observe-only annotation paragraph embedded in the note are read back too (the dashboard
   * bootstrap caller holds only the stored note). BRIEFING_UNVERIFIED_FILTER_DISABLED=1 ignores both.
   */
  unverifiedClaims?: UnverifiedClaim[];
}

/**
 * Briefing scope (owner 2026-09-14 screenshots — the raw "Nothing new on any
 * project since the last update." line was landing in PROJECT supervisor chats):
 * a project supervisor lane is ONE project, so the fleet-wide nothing-new line
 * is wrong there, and the deterministic hourly project status card
 * (project-status.service, metadata.origin 'project_status') already tells the
 * owner "no change in the last hour". Resolved from the chat row; a lookup
 * failure or an unmocked client means fleet scope (status quo ante).
 */
export type BriefingScope = 'fleet' | 'project';

export async function resolveBriefingScope(chatId: string): Promise<BriefingScope> {
  try {
    const row = await (prisma as any).crossModelChat?.findUnique?.({
      where: { id: chatId },
      select: { isProjectSupervisor: true },
    });
    return row?.isProjectSupervisor === true ? 'project' : 'fleet';
  } catch {
    return 'fleet';
  }
}

/** True when a briefing text is ONLY the fleet-wide nothing-new line. */
export function isNothingNewOnly(text: string): boolean {
  return text.trim() === NOTHING_NEW_LINE;
}

/** The briefing's three views of a wake note (BRIEFING-UNVERIFIED-FILTER, 2026-10-20). */
export interface PreparedBriefingNote {
  /** The note the model wrote (embedded observe-only annotation paragraphs stripped while the filter is on). */
  note: string;
  /** `note` with every located unverified claim marked "(unverified)" — the deterministic rendering's input. */
  markedNote: string;
  /** `note` with every located unverified claim removed — the LLM rewrite's (and its grounding gate's) input. */
  droppedNote: string;
  /** Claims the caller supplied / an embedded annotation named / were located in the note. */
  supplied: number;
  embedded: number;
  located: number;
}

/**
 * Prepare a wake note for the briefing (BRIEFING-UNVERIFIED-FILTER, supervisor SOTA round 3): the
 * owner steers by the briefing, and an action claim the integrity check could not verify (an
 * action-class conviction delivered observe-only, or a dispatch claim on a zero-tool wake) used to
 * reach it as fact. Its line is now MARKED "(unverified)" where the note's own sections are rendered,
 * and LEFT OUT of the note the LLM rewrites (that path could restate it as done). An observe-only
 * annotation paragraph embedded in the note is harness text, never the model's note: its claims are
 * read back and the paragraph is stripped. Unlocated claims change nothing; with
 * BRIEFING_UNVERIFIED_FILTER_DISABLED=1 all three views are the note as given (byte-for-byte the
 * previous input). A stored supervisor note's trailing harness appendix (the dashboard bootstrap caller
 * only holds the stored note) is never the model's words either — it is stripped first
 * (stripTrailingHarnessAppendix; review fix 2026-10-20 — its no-op line read as the model's 'WAKE: no-op'
 * and briefed a free-form note as "Nothing new"); SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1 keeps it. A stored
 * row's carried-forward section stays its LAST paragraph (get_chat_messages keeps a long row's tail for it),
 * so the appendix is stripped from in front of that section and the section kept as it was. Pure.
 */
/** The note without its harness appendix, also when a carried-forward section follows it. Pure. */
function stripStoredHarnessAppendix(text: string): string {
  const at = text.lastIndexOf(`\n\n---\n${CARRIED_FORWARD_LABEL}`);
  if (at < 0) return stripTrailingHarnessAppendix(text);
  return `${stripTrailingHarnessAppendix(text.slice(0, at))}${text.slice(at)}`;
}

export function prepareBriefingNote(noteContent: string, unverifiedClaims?: UnverifiedClaim[] | null): PreparedBriefingNote {
  const given = String(noteContent ?? '');
  const raw = (supervisorHarnessReceiptsDisabled() ? given : stripStoredHarnessAppendix(given)).trim();
  if (briefingUnverifiedFilterDisabled()) {
    return { note: raw, markedNote: raw, droppedNote: raw, supplied: 0, embedded: 0, located: 0 };
  }
  const embedded = extractAnnotationClaims(raw);
  const note = embedded.text.trim();
  const supplied = (unverifiedClaims ?? []).filter((c) => c && typeof c.quote === 'string' && c.quote.trim());
  const claims = dedupeUnverifiedClaims([...supplied, ...embedded.claims]);
  if (!claims.length) return { note, markedNote: note, droppedNote: note, supplied: 0, embedded: 0, located: 0 };
  const plan = planUnverifiedBriefing(note, claims);
  return { note, markedNote: plan.markedNote, droppedNote: plan.droppedNote, supplied: supplied.length, embedded: embedded.claims.length, located: plan.located };
}

/**
 * Generate + persist one owner briefing. Returns true only when a briefing
 * row actually landed. Never throws (fail-open: log + false).
 */
export async function generateOwnerBriefing(args: OwnerBriefingArgs): Promise<boolean> {
  try {
    // BRIEFING-UNVERIFIED-FILTER (2026-10-20): `note` is the model's own note, `markedNote` carries
    // "(unverified)" after each claim the integrity check could not verify (the rendering's input) and
    // `droppedNote` leaves those claims out (the LLM rewrite's input). All three are the note (minus any
    // harness annotation paragraph) when no claim is located; under BRIEFING_UNVERIFIED_FILTER_DISABLED=1
    // all three are the note as given, byte-for-byte.
    const prepared = prepareBriefingNote(args.noteContent || '', args.unverifiedClaims);
    const { note, markedNote, droppedNote } = prepared;
    if (!note) return false;

    // PROJECT-scope no-op wakes never brief (and never claim the lock — a real
    // move minutes later must still be able to brief): the hourly project
    // status card owns "no change", and "on any project" is fleet wording.
    const scope = await resolveBriefingScope(args.chatId);
    const preRendered = renderBriefingFromNote(markedNote);
    if (scope === 'project' && preRendered !== null && isNothingNewOnly(preRendered)) {
      logger.info(`owner-briefing: project-supervisor chat ${args.chatId} reported a no-op wake — no briefing (the hourly project status card carries "no change")`);
      return false;
    }

    // NX lock FIRST — a claim failure means a briefing landed (or was
    // attempted) inside the window; yield silently.
    const claimed = await redisClient
      .set(briefingLockKey(args.chatId), '1', { NX: true, PX: BRIEFING_LOCK_TTL_MS })
      .catch(() => null);
    if (claimed !== 'OK') return false;

    // Measured fleet liveness grounds the rewrite and powers the deterministic
    // repair gate (tickets 25c5a7c3 / 23880ce0: a note about ONE stopped loop
    // reached the owner as "The fleet is stopped."). Best-effort — a telemetry
    // OR module-import failure leaves the rewrite ungrounded (status quo ante:
    // an ungrounded briefing still posts; review N7), never blocked.
    let liveness: FleetLivenessSnapshot | null = null;
    try {
      const { getFleetLivenessSnapshot } = await import('../platform/supervisor-state.service');
      liveness = await getFleetLivenessSnapshot(args.userId);
    } catch { /* ungrounded rewrite — status quo ante */ }

    // Review 2026-09-13 issue 4 follow-up — DETERMINISTIC FIRST: when the note
    // carries parseable per-project sections (the supervisor doctrine since
    // 672ff078 emits bold lines or a table) the rendering IS the briefing and
    // the LLM never runs — the first live briefing on the new prompt fabricated
    // project lines and an owner ask from a noisy note. The LLM path is the
    // fallback for free-form notes only, and its output is grounding-gated.
    const rendered = renderBriefingFromNote(markedNote);
    let briefing: string;
    let path: 'deterministic' | 'llm';
    let droppedUngrounded = 0;
    let droppedNeedsYou = false;
    let unverifiedOnly = false;
    if (rendered !== null && renderingIsSubstantive(rendered)) {
      briefing = rendered;
      path = 'deterministic';
    } else if (prepared.located > 0 && !/[a-z0-9]/i.test(droppedNote)) {
      // BRIEFING-UNVERIFIED-FILTER review fix: every content line of this free-form note is an unverified
      // claim — the LLM would see only the liveness line and could answer "Nothing new on any project".
      // Render the claims themselves, marked; nothing renderable ⇒ skip (the lock holds the window).
      const only = renderUnverifiedOnlyBriefing(markedNote);
      if (!only) {
        logger.info(`owner-briefing: every line of chat ${args.chatId}'s note is an unverified claim and none renders — skipped (lock holds the window)`, { source: 'owner-briefing' });
        return false;
      }
      briefing = only;
      path = 'deterministic';
      unverifiedOnly = true;
    } else {
      path = 'llm';
      // Dynamic import keeps utility-llm out of every importer's module graph
      // (fleet.service statically imports this module for the kind constant).
      const { utilityChat } = await import('../../../utils/utility-llm');
      const raw = await utilityChat(buildBriefingPrompt(droppedNote, liveness), {
        // Review 2026-09-13 issue 4: 400 → 900 — one line per project (up to a
        // handful) plus a Needs-you line no longer fits the 2-4-sentence budget.
        maxTokens: 900,
        temperature: 0.3,
        timeout: 25_000,
        // Never fall back to reasoning_content — leaking "we need to craft…"
        // chain-of-thought into the owner's chat is worse than skipping.
        contentOnly: true,
      });
      const llmText = (raw || '').trim();
      if (!llmText) {
        logger.warn(`owner-briefing: utility returned empty for chat ${args.chatId} — skipped (lock holds the window)`, { source: 'owner-briefing' });
        return false;
      }
      if (briefingLooksVague(llmText)) {
        // Review 2026-09-13 issue 4: the vague fleet voice never reaches the
        // owner again — fall back to the note's own rendering (here at most a
        // Needs-you line, or the deterministic path would have taken it); a
        // note with nothing renderable is skipped (lock holds).
        if (!rendered) {
          logger.warn(`owner-briefing: utility opened with the vague fleet voice ("${llmText.slice(0, 40)}…") for chat ${args.chatId} and the note holds no per-project sections to render — skipped rather than posting the vague sentence`, { source: 'owner-briefing' });
          return false;
        }
        logger.warn(`owner-briefing: utility opened with the vague fleet voice ("${llmText.slice(0, 40)}…") for chat ${args.chatId} — replaced with the deterministic per-project rendering of the note (${rendered.split('\n').length} line(s))`, { source: 'owner-briefing' });
        briefing = rendered;
      } else {
        const grounded = groundBriefingInNote(llmText, droppedNote);
        droppedUngrounded = grounded.droppedUngrounded;
        droppedNeedsYou = grounded.droppedNeedsYou;
        if (grounded.text === null) {
          if (!rendered) {
            logger.warn(`owner-briefing: ${grounded.droppedUngrounded} of ${grounded.projectLines} LLM project line(s) ungrounded in the note${grounded.droppedNeedsYou ? ' (+ an invented Needs-you line)' : ''} for chat ${args.chatId} and the note holds no per-project sections to render — skipped rather than posting fabricated progress`, { source: 'owner-briefing' });
            return false;
          }
          logger.warn(`owner-briefing: ${grounded.droppedUngrounded} of ${grounded.projectLines} LLM project line(s) ungrounded in the note${grounded.droppedNeedsYou ? ' (+ an invented Needs-you line)' : ''} for chat ${args.chatId} — replaced with the deterministic rendering of the note (${rendered.split('\n').length} line(s))`, { source: 'owner-briefing' });
          briefing = rendered;
        } else {
          if (droppedUngrounded > 0 || droppedNeedsYou) {
            logger.warn(`owner-briefing: dropped ${droppedUngrounded} ungrounded LLM project line(s)${droppedNeedsYou ? ' and an invented Needs-you line' : ''} for chat ${args.chatId} — kept the ${grounded.text.split('\n').length} grounded line(s)`, { source: 'owner-briefing' });
          }
          briefing = grounded.text;
        }
      }
    }
    if (briefingLooksMachine(briefing)) {
      logger.warn(`owner-briefing: ${path} output still machine-shaped (hex id or table pipe) for chat ${args.chatId} — skipped rather than posting garbage`, { source: 'owner-briefing' });
      return false;
    }
    if (scope === 'project' && isNothingNewOnly(briefing)) {
      // The LLM path can still answer with the fleet-wide nothing-new line on
      // a free-form no-op note — never post it into a single-project chat.
      logger.info(`owner-briefing: ${path} output for project-supervisor chat ${args.chatId} was the fleet-wide nothing-new line — skipped (lock holds the window)`);
      return false;
    }
    // Deterministic contradiction gate: a fleet-wide stopped/nothing-running
    // claim while schedules are armed (or runs live) is FALSE — replace it
    // with the measured liveness sentence rather than scaring the owner.
    const repair = repairFleetStoppedClaims(briefing, liveness);
    if (repair.repaired) {
      logger.warn(`owner-briefing: repaired a false fleet-stopped claim for chat ${args.chatId} (liveness: ${liveness ? `${liveness.enabledSchedules} armed schedules, ${liveness.liveRuns} live runs` : 'unavailable'}) — the note's "one loop stopped" was about to reach the owner as "the fleet is stopped"`, { source: 'owner-briefing' });
    }
    // Supervisor OFF switch: the harness states the switch, the model never
    // does — prepended verbatim so the owner reads WHY the fleet went quiet.
    // audit 2026-10-06 T8-1: the fleet-wide rollout + live-chat audit lines ride the FLEET briefing only (audit line
    // only while fresh); a project supervisor's briefing is about its one project.
    const fleetHeadScoped = !briefingFleetHeadScopeDisabled();
    const fleetOnlyHeadsOff = fleetHeadScoped && scope !== 'fleet';
    const [switchLine, latchLine, refusalLine, rolloutLine, auditLine] = await Promise.all([
      supervisorSwitchBriefingLine(),
      // 2026-09-27: a seat latched off by a deterministic rejection is stated the
      // same way — the owner reads which seat is unusable and what runs instead.
      seatLatchBriefingLine(),
      // Refused self-renewals (review-fixer 2026-09-27): the harness count of
      // self-armed watches the governor stopped — owner-visible even when no
      // supervisor consumed the alarm (supervisor OFF, goal-less project).
      renewRefusalBriefingLine(args.userId),
      // Rollout self-governance (2026-09-27): the decision-gate automaton's flips /
      // parks / open owner asks of the week are stated by the harness too.
      fleetOnlyHeadsOff ? Promise.resolve(null) : decisionRolloutBriefingLine(),
      // Nightly live-chat audit (2026-10-04): the real-chat health numbers + regression tickets, admins only.
      fleetOnlyHeadsOff ? Promise.resolve(null) : liveChatAuditLine(args.userId, fleetHeadScoped ? FLEET_HEAD_AUDIT_FRESH_MS : undefined),
    ]);
    const candidates = [['switch', switchLine], ['latch', latchLine ? `⚠︎ ${latchLine}` : null], ['refusal', refusalLine], ['rollout', rolloutLine], ['audit', auditLine]] as const;
    // owner 2026-10-21 (head dedupe): a head line repeats only when it changed or its repeat window passed.
    const headDedupe = !briefingHeadDedupeDisabled();
    const headAt = Date.now();
    const headMemory = headDedupe && candidates.some(([, l]) => l) ? await readBriefingHeadMemory(args.chatId) : null;
    const headPlan = headDedupe ? planBriefingHead(candidates, headMemory, headAt) : null;
    const head = composeBriefingHead(headPlan ? headPlan.lines : candidates.map(([, l]) => l));
    if (headDedupe && scope === 'fleet' && !head && isNothingNewOnly(repair.text)) {
      // "Nothing new on any project" under no new head line tells the owner nothing (lock holds the window).
      logger.info(`owner-briefing: fleet supervisor chat ${args.chatId} — nothing new on any project and no new head line${headPlan?.suppressed.length ? ` (repeats held back: ${headPlan.suppressed.join(', ')})` : ''} — no briefing`);
      return false;
    }
    const finalBriefing = head ? `${head}\n\n${repair.text}` : repair.text;

    await prisma.crossModelMessage.create({
      data: {
        chatId: args.chatId,
        role: 'assistant',
        content: finalBriefing,
        // kind marks the row for BOTH classifier exemptions (backend thread
        // noise classifier + frontend machine-turn grouping) and for the
        // dashboard card's briefing preference; sourceNoteId is the audit
        // pointer back to the wake note this was rewritten from.
        metadata: {
          kind: OWNER_BRIEFING_KIND,
          ...(args.sourceNoteId ? { sourceNoteId: args.sourceNoteId } : {}),
        },
      },
    });
    // Head dedupe: what was carried is stamped only now that the row landed.
    if (headPlan) await recordBriefingHeadPosted(args.chatId, headMemory, headPlan, headAt);
    const headSuppressed = headPlan?.suppressed ?? [];
    // ONE info per posted briefing carrying the path + grounding counters as
    // structured fields (winston JSON) so the two paths are countable in logs.
    logger.info(
      `owner-briefing: posted a plain-English briefing to supervisor chat ${args.chatId} (${finalBriefing.length} chars, path=${path}, droppedUngrounded=${droppedUngrounded}, droppedNeedsYou=${droppedNeedsYou}${headSuppressed.length ? `, headSuppressed=${headSuppressed.join(',')}` : ''})`,
      { path, droppedUngrounded, droppedNeedsYou, ...(headSuppressed.length ? { headSuppressed } : {}) },
    );
    // BRIEFING-UNVERIFIED-FILTER: ONE row per posted briefing that was handed unverified claims — how many
    // were located, how many markers the posted text carries, and whether the LLM input left them out.
    if (prepared.supplied + prepared.embedded > 0) {
      const markedInBriefing = finalBriefing.split(UNVERIFIED_MARKER).length - 1;
      void import('../platform/loop-metrics.service')
        .then(({ recordLoopMetric }) => recordLoopMetric({
          kind: LOOP_METRIC_KINDS.BRIEFING_UNVERIFIED_FILTER,
          sessionId: args.chatId,
          value: prepared.located,
          meta: {
            path, scope,
            supplied: prepared.supplied, embedded: prepared.embedded, located: prepared.located,
            markedInBriefing,
            droppedFromLlmInput: path === 'llm' ? prepared.located : 0,
            ...(unverifiedOnly ? { unverifiedOnly: true } : {}),
            ...(args.sourceNoteId ? { sourceNoteId: args.sourceNoteId } : {}),
          },
        }))
        .catch(() => { /* telemetry never blocks */ });
    }
    return true;
  } catch (err: any) {
    logger.warn(`owner-briefing: generation failed (non-fatal — no briefing posted): ${err?.message ?? err}`, { source: 'owner-briefing' });
    return false;
  }
}
