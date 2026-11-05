/**
 * Work tools vs external-effect tools — the ONE deterministic rule behind
 * "no permission card for requested work" (cohesive chat experience).
 *
 * A FRESH HUMAN ASK — a real user message anchors the run (ctx.userTurnAt is
 * set), the executor did not classify the trigger as machine, and the run is
 * not a Dig-deeper rung re-running an earlier ask (ctx.escalation) — IS the
 * authorization for the work that message asked for. The tools that START
 * or CONTINUE that work execute directly on such a turn: no staging, no
 * card, the tool result tells the model the work has started and where its
 * progress and result land. Cards stay for genuinely EXTERNAL side effects
 * (public exposure, cross-account access, bearer minting, messages to other
 * chats / paired instances, autonomy grants), for MACHINE turns (schedule
 * firings, hook wakes, agent-sent messages, webhooks), where nothing anchors
 * authorization — the staged envelope for a machine turn is unchanged — and
 * for an escalation rung (the user tapped "Dig deeper" on an answer; the
 * original ask already ran once).
 *
 * Scope per work tool (anything outside the scope falls through to today's
 * ladder — grant / staging — byte-identical):
 *   any               — the tool's own guards (home-project pin, caps, the
 *                       staging-time validation that still runs first) are the
 *                       whole check
 *   own_chat          — the target chat must be THE chat the human typed in
 *   own_chat_schedule — the schedule row must belong to that chat
 *
 * Trust boundary (the rule the header of platform-tools.ts states): on a
 * human turn the model's context also holds tool results — a scraped page,
 * a knowledge-base document, a file body — so text the user did not write can
 * ask for work in the same turn. What bounds that:
 *   · the two CREDENTIAL-spending tools (import_repo, configure_workspace)
 *     execute directly only when the repo URL they name appears in the user's
 *     own message (`repoUrlBoundToTurn`; ctx.userTurnText threaded by the
 *     chat run) — otherwise they fall through to the card;
 *   · a schedule the model arms / edits / cancels on the direct path is
 *     stamped MODEL-AUTHORED (promptSetBy 'machine', initiator 'machine', no
 *     owner-subscription mark), so every cadence / lint / stretch / self-
 *     cancel guard keyed on machine provenance still binds; 'user' / 'owner'
 *     stay reserved for the confirmed re-call (the owner saw the exact
 *     prompt / cadence on the card) and REST;
 *   · the direct path is IDEMPOTENT per ask (`workToolDedupeKey`: chat +
 *     tool + canonical args + the user-turn anchor) — a deploy requeue or
 *     orphan re-fire of the same human turn replays the first envelope
 *     instead of spawning a second session / feed / schedule;
 *   · start_coding_session's `prompt` is the model's own text by design (it
 *     is richer than what the user typed) — accepted residual: the child
 *     runs in the user's own account and project under the same guards a
 *     card-confirmed spawn has (self-merge gates, credential scans,
 *     autonomy ladder); its result posts back into this chat.
 *
 * EXTERNAL_EFFECT_TOOLS is the other half of the table: every consequential
 * tool is in exactly one of the two sets (pinned by work-tools.test.ts), so a
 * new consequential tool must be classified before it ships.
 *
 * Leaf module: node builtins only, safe to import from anywhere.
 * (The inline task card's own TASK_CARD_DISABLED was retired in RSW-1
 * cluster 35 — a card that can render always renders. The card-free direct
 * path's own WORK_TOOLS_NO_CARD_DISABLED was retired the same way — a card
 * that a human turn's own message has already authorized always executes.)
 */

import { createHash } from 'crypto';

export type WorkToolScope = 'any' | 'own_chat' | 'own_chat_schedule';

/** Requested-work tools → the scope inside which a human turn executes them card-free. */
export const WORK_TOOLS: Readonly<Record<string, WorkToolScope>> = Object.freeze({
  start_coding_session: 'any',
  // (create_feed: 'any' was retired with the feed subsystem, ticket 43c24152,
  //  2026-10-20 — a topic digest is schedule_message on a real chat now.)
  configure_workspace: 'any',
  import_repo: 'any',
  schedule_message: 'own_chat',
  update_schedule: 'own_chat_schedule',
  cancel_schedule: 'own_chat_schedule',
  pause_schedule: 'own_chat_schedule',
  resume_schedule: 'own_chat_schedule',
});

/**
 * Consequential tools whose effect leaves the user's own work: another chat,
 * a paired instance, the public web, another account, a bearer, or the
 * account's authority posture. These card on a human turn exactly as before
 * (the autonomy-grant / supervisor-seat bypasses are unchanged too).
 */
export const EXTERNAL_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'send_to_instance', 'dispatch_platform_task',
  'set_chat_autonomy', 'set_chat_instructions',
  'create_share_link', 'share_canvas', 'share_project', 'add_project_member', 'remove_project_member', 'create_chat_webhook',
  'stop_run', 'answer_chat_question', 'approve_request',
]);

/**
 * Work tools that spend the user's GitHub credential (a clone) plus disk /
 * compute: on the direct path the repo URL must appear in the user's own
 * message (see `repoUrlBoundToTurn`).
 */
export const CREDENTIAL_WORK_TOOLS: ReadonlySet<string> = new Set(['import_repo', 'configure_workspace']);

/** Schedule tools whose direct execution stamps MODEL provenance (see the header). */
export const SCHEDULE_WORK_TOOLS: ReadonlySet<string> = new Set(['schedule_message', 'update_schedule', 'cancel_schedule', 'pause_schedule', 'resume_schedule']);

export function isWorkTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORK_TOOLS, name);
}



/**
 * A HUMAN turn: a real user message anchors this run AND the executor did not
 * classify the trigger as machine. `machineTriggered` matters because an
 * agent-origin send from a user-anchored run threads a userTurnAt onto the
 * target run (run-state.ts persists origin 'agent'), so `userTurnAt` alone
 * over-counts human turns.
 */
export function isHumanTurn(ctx: { userTurnAt?: Date | null; machineTriggered?: boolean }): boolean {
  return !!ctx.userTurnAt && ctx.machineTriggered !== true;
}

/**
 * A FRESH human ask: a human turn that is not a Dig-deeper rung. An
 * escalation re-runs the ORIGINAL user message as a human turn with a NEW
 * anchor (crossmodel.controller escalation path; the deploy requeue re-fires
 * it the same way), so a work tool the first run already executed would run
 * a second time with no click — the rung falls through to the card instead.
 */
export function isFreshHumanAsk(ctx: { userTurnAt?: Date | null; machineTriggered?: boolean; escalation?: boolean }): boolean {
  return isHumanTurn(ctx) && ctx.escalation !== true;
}

/**
 * The scope check for one work tool. `schedules` is the caller's own schedule
 * rows (platform.listSchedules) — read lazily, only for the schedule tools —
 * and any read failure answers false (fail-closed into the card).
 */
export async function workToolInScope(
  name: string,
  args: any,
  ctx: { sessionId: string },
  readSchedules: () => Promise<Array<{ id: string; sessionId: string }>>,
): Promise<boolean> {
  const scope = WORK_TOOLS[name];
  if (!scope) return false;
  if (scope === 'any') return true;
  if (scope === 'own_chat') {
    const target = typeof args?.chatId === 'string' ? args.chatId.trim() : '';
    return !target || target === ctx.sessionId;
  }
  // own_chat_schedule: exact id, or the unique ≥8-char prefix the tools invite.
  const id = String(args?.id ?? '').trim();
  if (!id) return false;
  let rows: Array<{ id: string; sessionId: string }>;
  try { rows = await readSchedules(); } catch { return false; }
  let target = rows.find((r) => r.id === id);
  if (!target && id.length >= 8) {
    const matches = rows.filter((r) => r.id.startsWith(id));
    if (matches.length === 1) target = matches[0];
  }
  return !!target && target.sessionId === ctx.sessionId;
}

/** Lower-cased "host/path" of a git URL: no scheme, no `www.`, no trailing `.git` / `/`. */
export function normalizeRepoUrl(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * The repo URL a credential-spending work tool names must be in the user's
 * OWN message for the direct path: a scraped page or a knowledge document in
 * the same turn can name a repo, the user's message cannot be forged by it.
 * No repoUrl (configure_workspace's Digby-owned local repo) binds trivially;
 * no turn text (a hand-built context, a surface that does not thread it)
 * answers false — the card is the fallback, never a refusal.
 */
export function repoUrlBoundToTurn(args: any, userTurnText: string | undefined | null): boolean {
  const url = normalizeRepoUrl(args?.repoUrl);
  if (!url) return true;
  if (typeof userTurnText !== 'string' || !userTurnText) return false;
  const text = userTurnText.toLowerCase();
  if (text.includes(url)) return true;
  // The owner/repo tail alone ("import a/b from github") also binds when the
  // user's message names the host too.
  const parts = url.split('/');
  if (parts.length >= 3) {
    const tail = parts.slice(-2).join('/');
    const host = parts[0];
    if (text.includes(tail) && text.includes(host)) return true;
  }
  return false;
}

/** Idempotency window for the direct path: one human ask, one execution. */
export const WORK_TOOL_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
/** A claim with no result after this long is treated as abandoned (a process died mid-call). */
export const WORK_TOOL_CLAIM_STALE_MS = 5 * 60 * 1000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => k !== 'confirmationId' && !k.startsWith('_')).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * The dedupe key for one direct execution: chat + tool + canonical args
 * (sorted keys, the confirmationId / `_`-prefixed harness fields dropped) +
 * the user-turn anchor (the persisted user row's createdAt — stable across a
 * deploy requeue / orphan re-fire of the same turn). 32 hex chars.
 */
export function workToolDedupeKey(input: { sessionId: string; tool: string; args: unknown; userTurnAt: Date }): string {
  const anchor = input.userTurnAt instanceof Date && Number.isFinite(input.userTurnAt.getTime()) ? input.userTurnAt.toISOString() : String(input.userTurnAt);
  return createHash('sha256').update(`${input.sessionId}\n${input.tool}\n${canonical(input.args)}\n${anchor}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Whether the inline task card (chat-agent/task-events.ts) exists in this
 * build — the note names the card only when a card can actually render;
 * otherwise it says the progress and the result are posted in this chat,
 * which is true either way. The presence probe is a resolve, not an import:
 * this leaf pulls nothing in.
 */
export function taskCardAvailable(): boolean {
  try {
    require.resolve('../chat-agent/task-events');
    return true;
  } catch {
    return false;
  }
}

/**
 * The one-line note appended to a work tool's result when it executed
 * directly on a human turn — so the model never narrates a click that is
 * not pending. `opts.taskCard` names the card only when one renders.
 */
export function workToolDirectNote(name: string, opts: { taskCard?: boolean; idle?: boolean } = {}): string {
  const taskCard = opts.taskCard ?? taskCardAvailable();
  const base = 'Executed directly on the user\'s own ask — NO confirmation card exists or is pending, so never say it is waiting on their click or confirmation.';
  const where = taskCard ? 'its progress shows on the task card in this chat' : 'its progress and the result are posted in this chat';
  if (name === 'start_coding_session' && opts.idle) {
    // audit 2026-10-06 T5-2 (ticket 2bae9728): a session with no prompt and no
    // charter has no run — "the work has started" was the stanne #2 lie.
    return `${base} The session was created IDLE (no prompt and no goalId/todoId) — tell the user in one line that it is created and idle, and that nothing runs until it gets a prompt or a todo; never say the work has started.`;
  }
  if (name === 'start_coding_session') {
    return `${base} Tell the user in one line that the work has started (name it), that ${where}, and that the result is posted here when it lands — do not poll for it and do not ask them to confirm anything.`;
  }
  if (name === 'configure_workspace' || name === 'import_repo') {
    return `${base} Tell the user the workspace is being set up and that ${where}.`;
  }
  if (name === 'schedule_message') {
    return `${base} Tell the user it is set up and that each result is posted in this chat as a message${taskCard ? ' under the same task card' : ''}.`;
  }
  return `${base} Report what changed in one line.`;
}

/**
 * Append the direct-execution note to a tool result. Every work tool answers
 * a JSON result envelope on success ({ok:true, tool, ids, message, …}) — the
 * note rides `message` and the shape is kept, so receipt parsing is
 * unchanged. Anything else (a refusal string, an ok:false envelope, a
 * malformed body) is returned untouched: the note must never claim an
 * execution that did not happen.
 */
/**
 * audit 2026-10-06 T5-2: a start_coding_session envelope (string or parsed)
 * for a session created IDLE — the executor stamps ids.firstPrompt 'none'
 * when neither a prompt nor a goalId/todoId charter rode the spawn (absent
 * under SPAWN_CHARTER_FIRST_PROMPT_DISABLED=1, so the old notes return).
 */
export function spawnEnvelopeIsIdle(envelope: unknown): boolean {
  try {
    const parsed = typeof envelope === 'string' ? JSON.parse(envelope.trimStart()) : envelope;
    return !!parsed && typeof parsed === 'object' && (parsed as any).ok === true && (parsed as any).ids?.firstPrompt === 'none';
  } catch {
    return typeof envelope === 'string' && /"firstPrompt":\s*"none"/.test(envelope);
  }
}

export function appendWorkToolDirectNote(name: string, result: string, opts: { taskCard?: boolean; idle?: boolean } = {}): string {
  if (typeof result !== 'string' || !result) return result;
  const trimmed = result.trimStart();
  if (!trimmed.startsWith('{')) return result;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok !== true) return result;
    const note = workToolDirectNote(name, { ...opts, idle: opts.idle ?? spawnEnvelopeIsIdle(parsed) });
    parsed.message = typeof parsed.message === 'string' && parsed.message ? `${parsed.message} ${note}` : note;
    return JSON.stringify(parsed);
  } catch {
    return result;
  }
}

/** True when a tool result is the ok:true JSON envelope (the only shape the dedupe records). */
export function isOkEnvelope(result: string): boolean {
  if (typeof result !== 'string') return false;
  const t = result.trimStart();
  if (!t.startsWith('{')) return false;
  try { const p = JSON.parse(t); return !!p && typeof p === 'object' && !Array.isArray(p) && p.ok === true; } catch { return false; }
}

/**
 * The replay of a first envelope for the SAME ask: the stored ok:true result
 * with a `deduplicated` marker and a message that says the work was already
 * started on this ask — never a second execution, never a refusal.
 */
export function workToolReplayEnvelope(name: string, firstResult: string, firstAt: string): string {
  try {
    const parsed = JSON.parse(firstResult.trimStart());
    if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) return firstResult;
    const ids = parsed.ids && typeof parsed.ids === 'object' ? Object.values(parsed.ids).filter((v) => typeof v === 'string').join(', ') : '';
    parsed.deduplicated = { firstAt };
    parsed.message = `Already started on this same ask at ${firstAt}${ids ? ` (${ids})` : ''} — this call executed NOTHING new; the earlier result stands. Report it once; do not call ${name} again for this ask.`;
    return JSON.stringify(parsed);
  } catch {
    return firstResult;
  }
}

/** True when a dedupe claim is too old to count (window) or abandoned (no result after the stale bound). */
export function workToolClaimExpired(claim: { at?: unknown; result?: unknown } | null | undefined, now = Date.now()): boolean {
  if (!claim || typeof claim !== 'object') return true;
  const at = typeof claim.at === 'string' ? Date.parse(claim.at) : NaN;
  if (!Number.isFinite(at)) return true;
  if (now - at > WORK_TOOL_DEDUPE_WINDOW_MS) return true;
  if (typeof claim.result !== 'string' && now - at > WORK_TOOL_CLAIM_STALE_MS) return true;
  return false;
}
