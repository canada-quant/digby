/**
 * Harness-maintained session titles (SESSION_TITLES_TOPOLOGY design, 2026-09-27).
 *
 * WHY: titles were minted ONCE from the first ≤150 chars of message 1 and never
 * refreshed — 47 % of live lanes (7/15, verified 2026-09-27) carried a title
 * that no longer described the work, and every spawned satellite was titled
 * after its parent's last verdict. Nothing recorded WHICH goal a lane holds.
 *
 * CONTRACT: `title = "<goal ≤6 words> · <step ≤6 words>"` (≤ TITLE_MAX_CHARS,
 * separator TITLE_SEP). Both halves are DERIVED, never model prose:
 *   goal half — resolveGoalHalf, first hit wins:
 *               1. the newest in_progress todo ASSIGNED to the lane (T8-13);
 *               2. the charter todo (crossmodel_chats.charterTodoId) while it
 *                  is NOT terminal (done / dropped) (T8-13);
 *               3. a TERMINAL charter todo: the charter goal (charterGoalId →
 *                  project_goals.title; it follows the todo's own goal when
 *                  the charter goal is unset / gone / closed — bindCharter's
 *                  rebind rule) once the lane has MOVED ON past the todo (a
 *                  run of the lane began after the run that closed it — the
 *                  todo's updatedAt for a human close); otherwise — and when no goal
 *                  answers — the closed todo, the record of what the lane did
 *                  (2026-10-21, HARNESS_TITLE_DONE_TODO_SKIP_DISABLED);
 *               4. no charter todo row: the charter goal's title;
 *               5. else the current title's goal half (sticky — spawn-param
 *                  and LLM titles alike; a read failure on step 3 lands here).
 *               HARNESS_TITLE_TODO_HALF_DISABLED=1: the charter goal first,
 *               then the charter todo (skips steps 1–3).
 *   step half — the newest in-progress plan step, else the last mutating
 *               receipt's verb + object ("PR #712 opened"), else the run
 *               status ("running", "idle 3 h", "archived").
 * Word caps are a deterministic clipper (clipWords) — no LLM in the loop once
 * a charter exists. The opening-turn LLM title (run-executor / chat-agent) is
 * the title ONLY until a charter binds; it is stamped titleSource 'llm'.
 *
 * PIN: a human rename sets crossmodel_chats.titlePinned=true (+ titleSource
 * 'user' on coding rows) and every renderer / repair path returns early on it.
 * A lane's rename_chat on ITS OWN chat is a goal-half override, not a pin.
 * Supervisors: the goal half stays the role label ('<project> Supervisor');
 * the step half is the current wake's verb (sweep / hook wake / report-up /
 * idle since HH:MMZ) written at wake start + finalize.
 *
 * RATE LIMIT: ≤ 1 write per TITLE_RENDER_MIN_INTERVAL_MS per chat (in-process
 * map; best-effort across processes — a duplicate write is idempotent) and one
 * 'session_title' frame per write. Telemetry: loop_metrics `title_render`
 * {chatId, source, reason, changed, pinnedSkip}.
 *
 * Fail-open everywhere: a read error / thrown anything ⇒ no write, no throw.
 * Kill switch: HARNESS_TITLE_SPAWN_REQUIRED=0 (start_coding_session title
 * optional again; =1 makes a placeholder title a refusal).
 *
 * RSW-1 (2026-10-30, goal 393f731e): the whole-feature switch
 * HARNESS_TITLES_DISABLED is GONE — it was inert in prod (no compose file
 * forwarded it, 0 hits), so the default branch was the only one that ever ran.
 * The renderer, the supervisor step half and the pin guards are unconditional.
 *
 * LEAF: imports prisma, logger and loop-metrics statically; the plan store and
 * the receipts reader are pulled DYNAMICALLY (coding/* → platform/* cycles).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { LOOP_METRIC_KINDS, recordLoopMetric } from './loop-metrics.service';

// ── Tunables ─────────────────────────────────────────────────────────────────

export const TITLE_SEP = ' · ';
export const TITLE_MAX_CHARS = 80;
export const TITLE_HALF_MAX_WORDS = 6;
/** ≤ 1 write per chat per this window (coalesced); supervisor wake steps use TITLE_SUPERVISOR_MIN_INTERVAL_MS. */
export const TITLE_RENDER_MIN_INTERVAL_MS = 10 * 60_000;
export const TITLE_SUPERVISOR_MIN_INTERVAL_MS = 60_000;
/** Receipts window the step half reads (newest mutating receipt inside it). */
export const TITLE_RECEIPT_WINDOW_MS = 7 * 24 * 3600_000;
export const HARNESS_TITLE_SPAWN_REQUIRED_ENV = 'HARNESS_TITLE_SPAWN_REQUIRED';

export type TitleSource = 'user' | 'spawn-param' | 'harness' | 'llm';
export type TitleRenderReason = 'plan' | 'todo' | 'goal' | 'finalize' | 'bootstrap' | 'archive' | 'restore' | 'spawn' | 'wake' | 'idle' | 'migration';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
const offFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off';
};

export function spawnTitleRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env[HARNESS_TITLE_SPAWN_REQUIRED_ENV]);
}
/** The observe-only title contract is on unless HARNESS_TITLE_SPAWN_REQUIRED=0. */
export function spawnTitleAdvisoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !offFlag(env[HARNESS_TITLE_SPAWN_REQUIRED_ENV]);
}

// ── Pure renderers ───────────────────────────────────────────────────────────

/** Collapse whitespace, strip markdown chrome / trailing punctuation. Pure. */
export function cleanTitleText(text: unknown): string {
  return String(text ?? '')
    .replace(/(^|\s)#+(?=\s)/g, ' ') // markdown headings, never "PR #712"
    .replace(/[`*_>\[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.:;,\-–—\s]+$/g, '')
    .trim();
}

/**
 * audit 2026-10-06 T8-13 (schooltime P3, others F19): a clipped half ended mid-token — "Push hardened recorder to
 * box (base64" — and the hard 80-char cut could split a word; 8 CanLaw lanes bound to todos of ONE goal all read
 * "Gap-fill: bijural terminology, FR point-in-time, FR/EN · …". Now a CLIPPED half drops a trailing word that opens
 * an unclosed bracket, its trailing punctuation and a dangling connector ("to", "on", "the" …); the over-budget cut
 * lands on a word boundary; and a lane bound to a todo takes its goal half from the todo it is working (the
 * distinguishing half). HARNESS_TITLE_WORD_CLIP_DISABLED=1 restores the plain clip/cut;
 * HARNESS_TITLE_TODO_HALF_DISABLED=1 restores the goal-first half.
 */
export function titleWordClipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.HARNESS_TITLE_WORD_CLIP_DISABLED);
}
export function titleTodoHalfDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.HARNESS_TITLE_TODO_HALF_DISABLED);
}
/**
 * 2026-10-21 (probe JWT1021): lane 5f90c628 read "5. Close the JWT pending-IP watch · …" for 5½ days after its
 * charter todo went DONE — the T8-13 todo-first branch returned the charter todo's title whatever its status, before
 * the charter goal was consulted, and bindCharter only rebinds a closed charter todo when a NEW todo is assigned
 * (never, on a standing lane). A TERMINAL charter todo (done / dropped) now yields to the charter goal once the lane
 * has MOVED ON past it (a run of the lane began after the run that closed it — the standing lane kept firing; a human
 * close anchors on the todo's updatedAt). A finished one-shot lane whose last run closed its todo
 * keeps the todo as its subject: T8-13's siblings under one goal stay distinct at finalize and on archive. A read
 * failure keeps the sticky half. The charter itself is a record and is never cleared.
 * HARNESS_TITLE_DONE_TODO_SKIP_DISABLED=1 restores the status-blind order.
 */
export function titleDoneTodoSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.HARNESS_TITLE_DONE_TODO_SKIP_DISABLED);
}
/** goals.service TODO_STATUSES terminal states (P7 N5): done, dropped. Pure. */
export function isTerminalTodoStatus(status: unknown): boolean {
  return status === 'done' || status === 'dropped';
}
const TITLE_DANGLING_CONNECTOR_RE = /^(?:to|the|a|an|and|or|of|for|on|in|at|by|with|from|into|via|vs|as|&)$/i;

/** Tidy the tail of a CLIPPED word list (see titleWordClipDisabled). Pure. */
function tidyClippedTail(words: string[]): string[] {
  const out = [...words];
  const unbalanced = (w: string) => (w.match(/[([{]/g)?.length ?? 0) > (w.match(/[)\]}]/g)?.length ?? 0);
  while (out.length > 1) {
    const last = out[out.length - 1];
    if (unbalanced(last)) { out.pop(); continue; }
    const trimmed = last.replace(/[,;:—–\-/&+]+$/, '');
    if (trimmed !== last) { if (trimmed) { out[out.length - 1] = trimmed; continue; } out.pop(); continue; }
    if (TITLE_DANGLING_CONNECTOR_RE.test(last)) { out.pop(); continue; }
    break;
  }
  return out;
}

/** First `max` words, ellipsis-free (a clipped half simply ends). Pure. */
export function clipWords(text: unknown, max = TITLE_HALF_MAX_WORDS): string {
  const words = cleanTitleText(text).split(' ').filter(Boolean);
  const kept = words.slice(0, Math.max(1, max));
  if (words.length > kept.length && !titleWordClipDisabled()) return tidyClippedTail(kept).join(' ');
  return kept.join(' ');
}

/**
 * audit 2026-10-08 W5-5 (goals.md P3): ticket-lane and reviewer titles lost their SUBJECT — "ticket 954b7910 ·
 * archived", "Adversarial review · archived" (27 of 34 such lanes in 3 days). Two causes:
 *  (1) RATCHET: a lane with no charter re-derives its goal half from its CURRENT title, and an over-budget render
 *      trimmed the GOAL half to make room for a long step — so every long step shaved the goal, the next render read
 *      the shaved goal, and a short step ("archived") never grew it back. A sticky goal half (one re-read from the
 *      title itself) is now never trimmed: the STEP half is cut to fit instead (`keepGoal`).
 *  (2) the 6-word clip counted the "ticket <id8>:" label, leaving 4 words for the subject; a leading id label
 *      ("ticket 954b7910:", "ticket 954b7910 +2:", "Review 59a4407b") no longer counts toward the word budget.
 * HARNESS_TITLE_STICKY_GOAL_DISABLED=1 restores both behaviours.
 */
export function titleStickyGoalDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.HARNESS_TITLE_STICKY_GOAL_DISABLED);
}

/** A leading id LABEL: up to two words then an 8+ hex id with a digit (optionally "+N" and ":"). */
const TITLE_ID_LABEL_RE = /^((?:[A-Za-z][\w-]*\s+){0,2}(?=[0-9a-f]*\d)[0-9a-f]{8,}(?:\s*\+\d+)?:?)\s+(\S.*)$/;

/** clipWords for a GOAL half: a leading id label rides free of the word budget (W5-5). Pure. */
export function clipGoalWords(text: unknown, max = TITLE_HALF_MAX_WORDS): string {
  if (titleStickyGoalDisabled()) return clipWords(text, max);
  const cleaned = cleanTitleText(text);
  const m = TITLE_ID_LABEL_RE.exec(cleaned);
  if (!m) return clipWords(cleaned, max);
  return `${m[1]} ${clipWords(m[2], max)}`.trim();
}

/** Cut a step half to `budget` chars on a word boundary (never mid-word unless one word is too long). Pure. */
function fitStep(step: string, budget: number): string {
  if (step.length <= budget) return step;
  const cut = step.slice(0, budget);
  const atBoundary = /\s/.test(step.charAt(budget));
  const trimmed = atBoundary ? cut : cut.replace(/\s+\S*$/, '');
  const tidy = tidyClippedTail((trimmed || cut).trim().split(' ').filter(Boolean)).join(' ');
  return tidy || cut.trim();
}

/**
 * Render the contract: "<goal> · <step>", ≤ TITLE_MAX_CHARS. A missing step
 * yields the goal half alone. `rawGoal:true` keeps the goal half VERBATIM
 * (whitespace-collapsed only) — the supervisor path, whose goal half is a role
 * LABEL ('<project> Supervisor'): a label is never word-clipped or stripped of
 * `_` / `*` (fixer 2026-09-27; 'my_project Supervisor' stays itself and a
 * 7-word project name keeps its 'Supervisor'). Lane goals stay clipped.
 * `keepGoal:true` (W5-5) — the goal half is STICKY (re-read from the title
 * itself): over budget, the STEP is cut, never the goal. Pure.
 */
export function renderSessionTitle(parts: { goal: unknown; step?: unknown; rawGoal?: boolean; keepGoal?: boolean }): string {
  const goal = parts.rawGoal ? String(parts.goal ?? '').replace(/\s+/g, ' ').trim() : clipGoalWords(parts.goal);
  const step = parts.step == null ? '' : clipWords(parts.step);
  const full = step ? `${goal}${TITLE_SEP}${step}` : goal;
  if (full.length <= TITLE_MAX_CHARS) return full;
  if (parts.keepGoal && !titleStickyGoalDisabled() && step) {
    const stepBudget = TITLE_MAX_CHARS - TITLE_SEP.length - goal.length;
    if (stepBudget >= 8) return `${goal}${TITLE_SEP}${fitStep(step, stepBudget)}`;
    // A goal half too long to leave a readable step: the goal alone (cut on a word boundary below).
    return renderSessionTitle({ goal, rawGoal: true });
  }
  // Over budget: keep the whole step, trim the goal half's words first, then hard-cut.
  if (step) {
    const budget = TITLE_MAX_CHARS - TITLE_SEP.length - step.length;
    if (budget >= 8) return `${goal.slice(0, budget).replace(/\s+\S*$/, '').trim() || goal.slice(0, budget)}${TITLE_SEP}${step}`;
  }
  if (titleWordClipDisabled()) return full.slice(0, TITLE_MAX_CHARS).trim();
  // T8-13: the hard cut lands on a word boundary (a single over-long word is still cut).
  const cut = full.slice(0, TITLE_MAX_CHARS);
  return (full.length > TITLE_MAX_CHARS && /\S/.test(full.charAt(TITLE_MAX_CHARS)) ? cut.replace(/\s+\S*$/, '') || cut : cut).trim();
}

/** Split a stored title into its halves (the LAST separator wins — a goal half may itself contain '·'). Pure. */
export function splitSessionTitle(title: unknown): { goal: string; step: string | null } {
  const t = String(title ?? '').trim();
  const i = t.lastIndexOf(TITLE_SEP);
  if (i <= 0) return { goal: t, step: null };
  return { goal: t.slice(0, i).trim(), step: t.slice(i + TITLE_SEP.length).trim() || null };
}

/**
 * A spawn `title` that names a VERDICT, a REQUEST or scaffolding instead of
 * the deliverable ('Kickoff received', 'Agent message received', 'Self-Audit
 * passes 7 of 8 criteria', 'Untitled session'). Deterministic shapes only —
 * the reason names the rule so the caller can re-stage. Pure.
 */
export function placeholderSpawnTitleReason(title: unknown): string | null {
  const t = cleanTitleText(title);
  if (!t) return 'empty';
  if (t.length <= 3) return 'too short (≤3 chars)';
  const low = t.toLowerCase();
  if (['untitled session', 'new chat', 'new conversation', 'new coding chat', 'coding session', 'session', 'task'].includes(low)) return 'stock placeholder';
  if (/\b(received|acknowledged|noted|kickoff|kick-off|confirmation|inquiry|status check|checking in|follow[- ]?up)\b/i.test(t)) return 'names the request or its acknowledgement, not the deliverable';
  if (/\b(passes|passed|verified|complete[d]?|succeeded|failed|approved)\b/i.test(t) && /\b(\d+ of \d+|criteria|verdict|audit)\b/i.test(t)) return 'names a verdict, not the deliverable';
  if (/^(agent message|scheduled run|hook wake|parent session context)/i.test(t)) return 'echoes the machine header';
  return null;
}

/** Receipt → step half ("PR #712 opened", "todo updated"). Null for reads / unknown tools. Pure. */
export function stepFromReceipt(r: { tool: string; ids?: Record<string, unknown> | null } | null | undefined): string | null {
  if (!r?.tool) return null;
  const ids = (r.ids && typeof r.ids === 'object') ? r.ids as Record<string, unknown> : {};
  const pr = ids.prNumber != null ? `PR #${ids.prNumber}` : null;
  switch (r.tool) {
    case 'open_pull_request': return pr ? `${pr} opened` : 'PR opened';
    case 'merge_pull_request': return pr ? `${pr} merged` : 'PR merged';
    case 'git_push': case 'push_branch': return ids.branch ? `pushed ${String(ids.branch).slice(0, 24)}` : 'branch pushed';
    case 'run_command': return 'command run';
    case 'run_verify': case 'verify': return ids.passed === true ? 'verify passed' : ids.passed === false ? 'verify failed' : 'verify run';
    case 'send_chat_message': return ids.chatId ? `messaged ${String(ids.chatId).slice(0, 8)}` : 'message sent';
    case 'start_coding_session': return ids.sessionId ? `spawned ${String(ids.sessionId).slice(0, 8)}` : 'lane spawned';
    case 'todo_update': return 'todo updated';
    case 'todo_create': return 'todo created';
    case 'goal_update': return 'goal updated';
    case 'goal_create': return 'goal created';
    case 'schedule_message': case 'schedule_self': return 'schedule armed';
    case 'update_schedule': return 'schedule updated';
    case 'cancel_schedule': return 'schedule cancelled';
    case 'file_feedback': return ids.ticketId ? `ticket ${String(ids.ticketId).slice(0, 8)} filed` : 'ticket filed';
    case 'stage_upload': return 'upload staged';
    case 'dispatch_platform_task': return 'task dispatched';
    default: return null;
  }
}

/** Plan → step half: the NEWEST in-progress step (highest id), else null. Pure. */
export function stepFromPlan(plan: { steps?: Array<{ id?: number; text?: string; status?: string }> } | null | undefined): string | null {
  const steps = Array.isArray(plan?.steps) ? plan!.steps! : [];
  const inProgress = steps.filter((s) => s && s.status === 'in_progress' && typeof s.text === 'string' && s.text.trim());
  if (!inProgress.length) return null;
  inProgress.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
  return clipWords(inProgress[0].text);
}

/** Run state → step half. Pure. */
export function stepFromRunState(s: { running?: boolean; archived?: boolean; lastRunStatus?: string | null; lastActivityAt?: Date | null }, now: Date = new Date()): string {
  if (s.archived) return 'archived';
  if (s.running) return 'running';
  if (s.lastRunStatus === 'failed') return 'last run failed';
  const at = s.lastActivityAt instanceof Date ? s.lastActivityAt.getTime() : NaN;
  if (!Number.isFinite(at)) return 'idle';
  const min = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (min < 60) return `idle ${min} m`;
  const h = Math.round(min / 60);
  if (h < 48) return `idle ${h} h`;
  return `idle ${Math.round(h / 24)} d`;
}

/** Supervisor wake verb from the machine message + origin. Pure. */
export function supervisorStepFromWake(input: { message?: string | null; origin?: string | null }): string {
  const m = String(input.message ?? '').trimStart();
  if (/^(fleet|project) supervisor sweep/i.test(m)) return 'sweep';
  if (/\[NO-ADOPTION\]/.test(m)) return 'no-adoption review';
  if (/\[FOLLOW-THROUGH\]/.test(m)) return 'follow-through';
  if (/\[OWNER ASK UNANSWERED\]|\[OPEN OWNER ASKS/.test(m)) return 'answering owner';
  if (/\[INFRA ALERT\]/.test(m)) return 'infra alert';
  if (/\[TOPOLOGY REPORT\]/.test(m)) return 'topology review';
  switch (input.origin) {
    case 'schedule': return 'sweep';
    case 'hook': {
      const lane = /(?:chat|lane|session)\s+([0-9a-f]{8})/i.exec(m);
      return lane ? `hook: lane ${lane[1]}` : 'hook wake';
    }
    case 'agent': return 'report-up';
    case 'user': return 'answering owner';
    default: return 'wake';
  }
}

export function idleSinceStep(now: Date = new Date()): string {
  return `idle since ${now.toISOString().slice(11, 16)}Z`;
}

// ── Rate limiter (in-process, best-effort) ───────────────────────────────────

const lastWriteAt = new Map<string, number>();
export function _resetTitleRateLimitForTests(): void { lastWriteAt.clear(); }
function rateLimited(chatId: string, minIntervalMs: number, now: number): boolean {
  const last = lastWriteAt.get(chatId) ?? 0;
  if (now - last < minIntervalMs) return true;
  return false;
}
function noteWrite(chatId: string, now: number): void {
  lastWriteAt.set(chatId, now);
  if (lastWriteAt.size > 5000) {
    // pathology guard: drop the oldest half
    const entries = [...lastWriteAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, 2500)) lastWriteAt.delete(k);
  }
}

// ── DB-facing renderer ───────────────────────────────────────────────────────

export interface TitleRenderResult {
  changed: boolean;
  title: string | null;
  pinnedSkip?: boolean;
  skipped?: 'rate_limited' | 'no_charter' | 'not_found' | 'error';
}

interface ChatTitleRow {
  id: string; title: string; titlePinned: boolean; titleStep: string | null;
  charterGoalId: string | null; charterTodoId: string | null;
  isSupervisor: boolean; isProjectSupervisor: boolean; archivedAt: Date | null; projectId: string | null;
}

async function readChatTitleRow(chatId: string): Promise<ChatTitleRow | null> {
  const row = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, title: true, titlePinned: true, titleStep: true, charterGoalId: true, charterTodoId: true, isSupervisor: true, isProjectSupervisor: true, archivedAt: true, projectId: true },
  }).catch(() => null);
  return row as ChatTitleRow | null;
}

/** The goal half for a lane (first hit wins):
 *   1. the newest in-progress todo ASSIGNED to the lane — the todo it is working (T8-13);
 *   2. the charter todo while it is not terminal (T8-13: siblings under one goal stay distinguishable);
 *   3. a terminal (done / dropped) charter todo → the charter goal once the lane has moved on past it, else the closed
 *      todo (2026-10-21 — resolveClosedCharterTodoHalf);
 *   4. no charter todo row → the charter goal;
 *   5. the current title's goal half (sticky; also every read failure on step 3).
 *  HARNESS_TITLE_TODO_HALF_DISABLED=1: charter goal → charter todo (steps 1–3 skipped; a goal-read failure with a
 *  terminal todo stays sticky). HARNESS_TITLE_DONE_TODO_SKIP_DISABLED=1: the status-blind order (steps 1–2 → goal →
 *  todo, the todo's status never read). */
export async function resolveGoalHalf(row: Pick<ChatTitleRow, 'id' | 'title' | 'charterGoalId' | 'charterTodoId'>, titleSource: string | null): Promise<string> {
  return (await resolveGoalHalfWithSource(row, titleSource)).goal;
}

/** resolveGoalHalf + whether the half was re-read from the title ITSELF (sticky — W5-5 never trims it). */
export async function resolveGoalHalfWithSource(row: Pick<ChatTitleRow, 'id' | 'title' | 'charterGoalId' | 'charterTodoId'>, titleSource: string | null): Promise<{ goal: string; sticky: boolean }> {
  const fromDb = await resolveGoalHalfFromLedger(row);
  if (fromDb !== null) return { goal: fromDb, sticky: false };
  void titleSource; // spawn-param and llm alike keep the current goal half
  return { goal: clipGoalWords(splitSessionTitle(row.title).goal), sticky: true };
}

type CharterTodoRow = { title: string | null; status: string | null; goalId?: string | null; updatedAt?: Date | string | null; doneRunId?: string | null };

function readCharterTodo(id: string): Promise<CharterTodoRow | null> {
  return prisma.projectTodo.findUnique({ where: { id }, select: { title: true, status: true, goalId: true, updatedAt: true, doneRunId: true } }) as Promise<CharterTodoRow | null>;
}

async function resolveGoalHalfFromLedger(row: Pick<ChatTitleRow, 'id' | 'title' | 'charterGoalId' | 'charterTodoId'>): Promise<string | null> {
  if (titleDoneTodoSkipDisabled()) return resolveGoalHalfFromLedgerStatusBlind(row);
  // undefined = not read (or the todo-first read threw); null = read, no row.
  let charterTodo: CharterTodoRow | null | undefined;
  if (!titleTodoHalfDisabled()) {
    try {
      const working = await prisma.projectTodo.findFirst({ where: { assigneeChatId: row.id, status: 'in_progress' }, orderBy: { updatedAt: 'desc' }, select: { title: true } });
      if (working?.title) return clipWords(working.title);
      if (row.charterTodoId) {
        charterTodo = await readCharterTodo(row.charterTodoId);
        if (charterTodo?.title && !isTerminalTodoStatus(charterTodo.status)) return clipWords(charterTodo.title);
      }
    } catch { charterTodo = undefined; /* todo store unavailable — fall through to the goal-first order */ }
    if (charterTodo?.title) return resolveClosedCharterTodoHalf(row, charterTodo); // terminal — a live one returned above
  }
  // Goal-first: HARNESS_TITLE_TODO_HALF_DISABLED=1, a todo store failure above, or no charter todo row.
  let goalReadFailed = false;
  if (row.charterGoalId) {
    const g = await prisma.projectGoal.findUnique({ where: { id: row.charterGoalId }, select: { title: true } }).catch(() => { goalReadFailed = true; return null; });
    if (g?.title) return clipWords(g.title);
  }
  if (row.charterTodoId) {
    const t = charterTodo !== undefined ? charterTodo : await readCharterTodo(row.charterTodoId).catch(() => null);
    if (t?.title) {
      // a transient goal-read failure never resurrects a CLOSED todo over the sticky half
      if (goalReadFailed && isTerminalTodoStatus(t.status)) return null;
      return clipWords(t.title);
    }
  }
  return null;
}

/**
 * Step 3 of resolveGoalHalf — a TERMINAL charter todo on the todo-first order (no in-progress todo is assigned to the
 * lane). The charter goal names the lane once it has MOVED ON past the closed todo: a run of THIS lane began after
 * the todo closed. The close is anchored on the run that closed it (project_todos.doneRunId, stamped on a machine
 * close) — a stable instant, so a later progress note on the closed todo (which moves updatedAt) never flips a
 * standing lane back — and a todo another lane closed never counts as this lane's (a verify / re-open lane spawned on
 * a closed todo keeps that todo as its subject). A human close has no doneRunId: the todo's updatedAt is the anchor.
 * Otherwise the closed todo stays the lane's subject: the record of what a finished one-shot lane did, so sibling
 * lanes under one goal stay distinct at finalize and on archive (T8-13). No goal at all → the closed todo (last
 * ledger resort). Any read failure → null (the sticky current half; never a guess, and nothing here reads the
 * current title, so one failed read never becomes a permanent rename).
 */
async function resolveClosedCharterTodoHalf(row: Pick<ChatTitleRow, 'id' | 'title' | 'charterGoalId'>, todo: CharterTodoRow): Promise<string | null> {
  const todoHalf = clipWords(todo.title);
  let goal: { title: string | null } | null;
  try { goal = await readClosedTodoGoal(row.charterGoalId, todo.goalId ?? null); } catch { return null; }
  if (!goal?.title) return todoHalf;
  const goalHalf = clipWords(goal.title);
  if (goalHalf === todoHalf) return goalHalf;
  try {
    return (await laneMovedOnPastTodo(row.id, todo)) ? goalHalf : todoHalf;
  } catch { return null; }
}

/** Has this lane run since the charter todo closed? Anchor: the closing run (doneRunId) when there is one — another
 *  lane's closing run means this lane never worked the close — else the todo's updatedAt. Throws on a read failure. */
async function laneMovedOnPastTodo(laneId: string, todo: CharterTodoRow): Promise<boolean> {
  if (todo.doneRunId) {
    const closing = await prisma.agentRun.findUnique({ where: { id: todo.doneRunId }, select: { sessionId: true, createdAt: true } }) as { sessionId: string; createdAt: Date } | null;
    if (closing) {
      if (closing.sessionId !== laneId) return false;
      const later = await prisma.agentRun.findFirst({ where: { sessionId: laneId, id: { not: todo.doneRunId }, createdAt: { gt: closing.createdAt } }, select: { id: true } });
      return !!later;
    }
    // the closing run row is gone (runs are swept) — fall back to the todo's own clock
  }
  const closedAt = todo.updatedAt ? new Date(todo.updatedAt) : null;
  if (!closedAt || !Number.isFinite(closedAt.getTime())) return false;
  const later = await prisma.agentRun.findFirst({ where: { sessionId: laneId, OR: [{ createdAt: { gt: closedAt } }, { startedAt: { gt: closedAt } }] }, select: { id: true } });
  return !!later;
}

/** The goal a closed charter todo defers to — bindCharter's rebind rule: the charter goal, except that it follows the
 *  todo's OWN goal when the charter goal is unset, gone or closed (done / archived). Throws on a read failure. */
async function readClosedTodoGoal(charterGoalId: string | null, todoGoalId: string | null): Promise<{ title: string | null } | null> {
  const charter = charterGoalId ? await prisma.projectGoal.findUnique({ where: { id: charterGoalId }, select: { title: true, status: true } }) : null;
  if (todoGoalId && todoGoalId !== charterGoalId && (!charter?.title || charter.status === 'done' || charter.status === 'archived')) {
    const own = await prisma.projectGoal.findUnique({ where: { id: todoGoalId }, select: { title: true, status: true } });
    if (own?.title) return own;
  }
  return charter?.title ? charter : null;
}

/** The pre-2026-10-21 order, byte-for-byte (HARNESS_TITLE_DONE_TODO_SKIP_DISABLED=1): the charter todo's status is never read. */
async function resolveGoalHalfFromLedgerStatusBlind(row: Pick<ChatTitleRow, 'id' | 'title' | 'charterGoalId' | 'charterTodoId'>): Promise<string | null> {
  if (!titleTodoHalfDisabled()) {
    try {
      const working = await prisma.projectTodo.findFirst({ where: { assigneeChatId: row.id, status: 'in_progress' }, orderBy: { updatedAt: 'desc' }, select: { title: true } });
      if (working?.title) return clipWords(working.title);
      if (row.charterTodoId) {
        const t = await prisma.projectTodo.findUnique({ where: { id: row.charterTodoId }, select: { title: true } });
        if (t?.title) return clipWords(t.title);
      }
    } catch { /* todo store unavailable — fall through to the goal-first order */ }
  }
  if (row.charterGoalId) {
    const g = await prisma.projectGoal.findUnique({ where: { id: row.charterGoalId }, select: { title: true } }).catch(() => null);
    if (g?.title) return clipWords(g.title);
  }
  if (row.charterTodoId) {
    const t = await prisma.projectTodo.findUnique({ where: { id: row.charterTodoId }, select: { title: true } }).catch(() => null);
    if (t?.title) return clipWords(t.title);
  }
  return null;
}

/** The step half for a lane: in-progress plan step → newest mutating receipt → run state. */
export async function resolveStepHalf(chatId: string, opts: { archived: boolean; now?: Date }): Promise<string> {
  const now = opts.now ?? new Date();
  if (opts.archived) return 'archived';
  try {
    const { getPlan } = await import('../coding/plan.service');
    const plan = await getPlan(chatId);
    const fromPlan = stepFromPlan(plan);
    if (fromPlan) return fromPlan;
  } catch { /* plan store unavailable — fall through */ }
  try {
    const { getRecentChatReceipts } = await import('../coding/run-receipts.service');
    const receipts = await getRecentChatReceipts(chatId, TITLE_RECEIPT_WINDOW_MS);
    for (let i = receipts.length - 1; i >= 0; i--) {
      const s = stepFromReceipt(receipts[i]);
      if (s) return s;
    }
  } catch { /* receipts unavailable */ }
  let running = false; let lastRunStatus: string | null = null; let lastActivityAt: Date | null = null;
  try {
    const last = await prisma.agentRun.findFirst({ where: { sessionId: chatId }, orderBy: { createdAt: 'desc' }, select: { status: true, finishedAt: true, startedAt: true, createdAt: true } });
    if (last) {
      running = last.status === 'running' || last.status === 'queued';
      lastRunStatus = last.status;
      lastActivityAt = last.finishedAt ?? last.startedAt ?? last.createdAt;
    }
  } catch { /* fall through */ }
  return stepFromRunState({ running, lastRunStatus, lastActivityAt }, now);
}

async function writeTitle(chatId: string, title: string, step: string | null, source: TitleSource, isCoding: boolean): Promise<void> {
  await prisma.crossModelChat.update({ where: { id: chatId }, data: { title, titleStep: step } });
  if (isCoding) {
    await (prisma as any).chatCodingState.update({ where: { id: chatId }, data: { title, titleSource: source } }).catch(() => {});
  }
}

/**
 * Render + write a LANE's title from its charter. No-op (no write, no row)
 * when: the switch is off, the chat is pinned, the chat has no charter and no
 * sticky spawn title (the LLM bootstrap title stands), or the rate limit
 * holds. Never throws.
 */
export async function refreshSessionTitle(chatId: string, reason: TitleRenderReason, opts: { emit?: (type: string, data: any) => void; now?: Date; force?: boolean } = {}): Promise<TitleRenderResult> {
  const now = opts.now ?? new Date();
  try {
    const row = await readChatTitleRow(chatId);
    if (!row) return { changed: false, title: null, skipped: 'not_found' };
    if (row.titlePinned) {
      recordTitleRender({ chatId, source: 'user', reason, changed: false, pinnedSkip: true });
      return { changed: false, title: row.title, pinnedSkip: true };
    }
    if (row.isSupervisor || row.isProjectSupervisor) return { changed: false, title: row.title, skipped: 'no_charter' };
    const coding = await (prisma as any).chatCodingState.findUnique({ where: { id: chatId }, select: { titleSource: true } }).catch(() => null) as { titleSource: string | null } | null;
    const titleSource = coding?.titleSource ?? null;
    const hasCharter = !!(row.charterGoalId || row.charterTodoId);
    if (!hasCharter && titleSource !== 'spawn-param' && titleSource !== 'harness') return { changed: false, title: row.title, skipped: 'no_charter' };
    if (!opts.force && rateLimited(chatId, TITLE_RENDER_MIN_INTERVAL_MS, now.getTime())) return { changed: false, title: row.title, skipped: 'rate_limited' };
    const { goal, sticky } = await resolveGoalHalfWithSource(row, titleSource);
    const step = await resolveStepHalf(chatId, { archived: !!row.archivedAt || reason === 'archive', now });
    const title = renderSessionTitle({ goal, step, keepGoal: sticky });
    noteWrite(chatId, now.getTime());
    if (title === row.title && step === row.titleStep) {
      recordTitleRender({ chatId, source: 'harness', reason, changed: false });
      return { changed: false, title };
    }
    // spawn-param stays the provenance of the GOAL half; the step half still refreshes.
    const source: TitleSource = titleSource === 'spawn-param' ? 'spawn-param' : 'harness';
    await writeTitle(chatId, title, step, source, !!coding);
    recordTitleRender({ chatId, source, reason, changed: true });
    try { opts.emit?.('session_title', { chatId, title, goal, step, pinned: false }); } catch { /* emit is best-effort */ }
    return { changed: true, title };
  } catch (err: any) {
    logger.warn(`session-titles: refresh skipped for ${chatId} (${reason}): ${err?.message ?? err}`);
    return { changed: false, title: null, skipped: 'error' };
  }
}

/**
 * Bind a lane's CHARTER (first bind wins; a later call only fills a still-null
 * field) and refresh the title. Never throws; a bind on a pinned / supervisor
 * row records the charter but never writes the title.
 */
export async function bindCharter(chatId: string, charter: { goalId?: string | null; todoId?: string | null }, opts: { emit?: (type: string, data: any) => void; reason?: TitleRenderReason } = {}): Promise<{ bound: boolean }> {
  try {
    const row = await readChatTitleRow(chatId);
    if (!row || row.isSupervisor || row.isProjectSupervisor) return { bound: false };
    const data: Record<string, string> = {};
    if (!row.charterGoalId && charter.goalId) data.charterGoalId = charter.goalId;
    if (!row.charterTodoId && charter.todoId) data.charterTodoId = charter.todoId;
    // audit 2026-10-08 W5-5 (goals.md P3, known since 10-06): "first bind wins" left lanes chartered to todos DONE for
    // days (0037460b → 576ebb05 done 10-05 while working three other todos) — the charter feeds auto-promote and the
    // title. A charter whose todo is done / dropped / gone REBINDS to the newly assigned todo; its goal follows when
    // the old charter goal is closed / gone. HARNESS_CHARTER_REBIND_DISABLED=1 restores first-bind-wins.
    else if (row.charterTodoId && charter.todoId && charter.todoId !== row.charterTodoId && !onFlag(process.env.HARNESS_CHARTER_REBIND_DISABLED)) {
      const cur = await prisma.projectTodo.findUnique({ where: { id: row.charterTodoId }, select: { status: true } }).catch(() => undefined);
      if (cur === null || (cur && isTerminalTodoStatus(cur.status))) {
        data.charterTodoId = charter.todoId;
        const nt = await prisma.projectTodo.findUnique({ where: { id: charter.todoId }, select: { goalId: true } }).catch(() => null);
        const nextGoal = charter.goalId || nt?.goalId || null;
        if (nextGoal && nextGoal !== row.charterGoalId) {
          const g = row.charterGoalId ? await prisma.projectGoal.findUnique({ where: { id: row.charterGoalId }, select: { status: true } }).catch(() => undefined) : null;
          if (!row.charterGoalId || g === null || (g && (g.status === 'done' || g.status === 'archived'))) data.charterGoalId = nextGoal;
        }
        try {
          recordLoopMetric({ kind: 'charter_rebind', sessionId: chatId, meta: { from: row.charterTodoId, to: charter.todoId, fromStatus: cur?.status ?? 'gone', goalRebound: !!data.charterGoalId } });
        } catch { /* telemetry never blocks */ }
      }
    }
    if (!row.charterGoalId && !charter.goalId && charter.todoId) {
      // derive the goal from the todo
      const t = await prisma.projectTodo.findUnique({ where: { id: charter.todoId }, select: { goalId: true } }).catch(() => null);
      if (t?.goalId) data.charterGoalId = t.goalId;
    }
    if (!Object.keys(data).length) return { bound: false };
    await prisma.crossModelChat.update({ where: { id: chatId }, data });
    void refreshSessionTitle(chatId, opts.reason ?? 'todo', { emit: opts.emit, force: true });
    return { bound: true };
  } catch (err: any) {
    logger.warn(`session-titles: charter bind skipped for ${chatId}: ${err?.message ?? err}`);
    return { bound: false };
  }
}

/**
 * Supervisor STEP half ("CanLaw Supervisor · sweep"): the goal half is the
 * role label (the healer keeps it); only the step half moves. Pinned rows are
 * honoured. Never throws.
 */
export async function setSupervisorStep(chatId: string, step: string, opts: { emit?: (type: string, data: any) => void; now?: Date; reason?: TitleRenderReason } = {}): Promise<TitleRenderResult> {
  const now = opts.now ?? new Date();
  try {
    const row = await readChatTitleRow(chatId);
    if (!row) return { changed: false, title: null, skipped: 'not_found' };
    if (!(row.isSupervisor || row.isProjectSupervisor)) return { changed: false, title: row.title, skipped: 'no_charter' };
    if (row.titlePinned) return { changed: false, title: row.title, pinnedSkip: true };
    if (rateLimited(chatId, TITLE_SUPERVISOR_MIN_INTERVAL_MS, now.getTime())) return { changed: false, title: row.title, skipped: 'rate_limited' };
    const goal = splitSessionTitle(row.title).goal;
    const title = renderSessionTitle({ goal, step, rawGoal: true });
    noteWrite(chatId, now.getTime());
    if (title === row.title) return { changed: false, title };
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { title, titleStep: clipWords(step) } });
    recordTitleRender({ chatId, source: 'harness', reason: opts.reason ?? 'wake', changed: true });
    try { opts.emit?.('session_title', { chatId, title, goal, step: clipWords(step), pinned: false }); } catch { /* best-effort */ }
    return { changed: true, title };
  } catch (err: any) {
    logger.warn(`session-titles: supervisor step skipped for ${chatId}: ${err?.message ?? err}`);
    return { changed: false, title: null, skipped: 'error' };
  }
}

/**
 * The supervisor title HEAL (ensureFleetSupervisor / ensureProjectSupervisor;
 * fixer 2026-09-27): returns the title the row should carry, or null when no
 * write is due. Honours the human pin, keeps the harness's step half ONLY when
 * the goal half already IS the label (a drifted title heals to the bare
 * label), and never word-clips the label. Pure.
 */
export function healSupervisorTitle(row: { title: string; titlePinned?: boolean | null }, label: string): string | null {
  if (row.titlePinned === true) return null;
  const current = String(row.title ?? '');
  const { goal, step } = splitSessionTitle(current);
  const healed = renderSessionTitle({ goal: label, step: goal === label ? step : null, rawGoal: true });
  return healed === current ? null : healed;
}

/** Is the chat's title pinned by a human rename? Read used by the bootstrap / repair guards. Never throws (false on error). */
export async function isTitlePinned(chatId: string): Promise<boolean> {
  try {
    const row = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { titlePinned: true } });
    return row?.titlePinned === true;
  } catch { return false; }
}

function recordTitleRender(meta: { chatId: string; source: TitleSource; reason: TitleRenderReason; changed: boolean; pinnedSkip?: boolean }): void {
  try {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.TITLE_RENDER, sessionId: meta.chatId, meta: { ...meta } });
  } catch { /* telemetry never blocks */ }
}
