/**
 * OWNER-DIRECTIVE-FANOUT (2026-10-20) — the [OWNER DIRECTIVES IN FORCE] block.
 *
 * The gap: an owner ruling reached exactly one ledger. owner-questions.ts banks
 * a ruling on the FLEET Supervisor's ledger; a project supervisor's machine
 * wake renders only ITS OWN state doc (chat-agent.service formatStateForWake),
 * its stored brief admitted only rows scoped to its own project (the 'fleet'
 * scope was filtered out), and a coding lane's run start carried no owner
 * directive at all — while the doctrine frames any RELAYED owner words as
 * background. So a standing owner ruling ("no new <resource>, ever") bound the
 * Fleet Supervisor and nobody it supervised.
 *
 * The fix is a harness-READ block, never a relay: every OPEN owner-origin row
 * (the harness stamp 'owner' | 'owner_question' — a supervisor's own merge can
 * never set it; never a kind:'ask' status question) on the ledgers that can
 * bind the target — the Fleet Supervisor's and THIS project's supervisor's
 * (read by chat id, never "the first 50 state rows") — filtered to a STANDING
 * 'fleet' row or a row scoped to THIS project (by name or id; a scopeless row
 * is never cited cross-project), rendered as
 *
 *   [OWNER DIRECTIVES IN FORCE — scope: fleet + <project>]
 *   - [fleet] <text> (abcd1234, 2026-10-12, standing)
 *
 * standing rows first, then the rest newest first, capped at
 * OWNER_DIRECTIVES_BLOCK_CHARS (oldest non-standing rows drop first, then the
 * oldest standing ones; the block says how many it hid). Delivered on project
 * supervisor machine wakes (beside the state doc — rows already on the
 * supervisor's own ledger are excluded, they render there, and so is a copy
 * of one of them on another ledger — a ruling and its mirror share an id)
 * and on coding-lane
 * run starts (project lanes only, the first harness injection of the run).
 * One loop_metrics owner_directive_delivered row per delivery (aggregate:
 * directiveIds / targetChatId / surface — never a row per directive).
 *
 * Review fix (same day): 'fleet' is NOT a fleet-wide marker on its own — it
 * is the scope stamp of EVERY owner message typed into the projectless Fleet
 * Supervisor chat (supervisor-state directiveScopeForChat), project-specific
 * orders included ("halt the canlaw ladder until I say"), and an open owner
 * row never archives. So a 'fleet' row binds every project only when it is
 * STANDING (fleet-wide / permanent wording, or a standing owner-question
 * ruling — the same rule the brief's "Fleet-wide owner rules" uses); a
 * non-standing row binds only the project its scope names.
 *
 * Pure helpers are exported for tests; buildOwnerDirectivesInForceBlock is
 * TOTAL (any failure → empty block) and imports its DB / ledger modules
 * dynamically so this file stays a leaf. Kill switch
 * OWNER_DIRECTIVE_FANOUT_DISABLED=1.
 */

import type { SupervisorDirective, SupervisorStateDoc } from './supervisor-state.service';
import { ownerDirectiveFanoutDisabled } from './owner-authority-switches';

export { ownerDirectiveFanoutDisabled };

/** The whole block's char cap (header + rows + the hidden line). */
export const OWNER_DIRECTIVES_BLOCK_CHARS = 1_200;
/** One row's text cap inside the block. */
export const OWNER_DIRECTIVE_LINE_TEXT_CHARS = 240;
export const OWNER_DIRECTIVES_BLOCK_HEADING = '[OWNER DIRECTIVES IN FORCE';

export type OwnerDirectiveSurface = 'ps_wake' | 'lane_run';

export interface OwnerDirectiveInForce {
  id: string;
  text: string;
  at: string;
  /** The row's scope as stored ('fleet' or the project label). */
  scope: string;
  /** Which scope the row matched for the target. */
  match: 'fleet' | 'project';
  standing: boolean;
  /** The supervisor chat whose ledger holds it. */
  sourceChatId: string;
}

function normScope(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** An OPEN owner-origin ORDER the fan-out may cite (never an ask, never a supervisor / default row). Pure. */
export function isFanoutCandidate(d: SupervisorDirective | null | undefined): d is SupervisorDirective {
  return !!d && typeof d.text === 'string' && !!d.text.trim()
    && d.status === 'open' && d.kind !== 'ask'
    && (d.origin === 'owner' || d.origin === 'owner_question');
}

/**
 * Does a row's scope bind the target? 'fleet' → 'fleet' (the selection then
 * also requires the row to be STANDING — fleetRowBindsEveryProject); the
 * project's name or id (case / whitespace-insensitive; the stamp is the
 * project name clipped to 60 chars) when a project is given; a scopeless row
 * never. Pure.
 */
export function scopeMatchesTarget(scope: unknown, target: { projectName?: string | null; projectId?: string | null }): 'fleet' | 'project' | null {
  const s = normScope(scope);
  if (!s) return null;
  if (s === 'fleet') return 'fleet';
  const name = normScope(target.projectName).slice(0, 60);
  const id = normScope(target.projectId);
  if ((name && s === name) || (id && s === id)) return 'project';
  return null;
}

/**
 * A 'fleet'-scoped row binds every project only when it is STANDING. 'fleet'
 * is the default scope stamp of any owner message typed into the projectless
 * Fleet Supervisor chat — a non-standing one there is an operational order
 * the Fleet Supervisor routes (often naming ONE project), never a rule for
 * every lane. A standing owner-question ruling is always scoped 'fleet'
 * (appendOwnerRulingDirective) and a non-standing one carries the asking
 * project's scope, so rulings route correctly under the same rule. Pure.
 */
export function fleetRowBindsEveryProject(d: Pick<SupervisorDirective, 'standing'>): boolean {
  return d.standing === true;
}

/**
 * Select the directives in force for a target from the owner's supervisor
 * docs. Rows on `excludeChatId`'s ledger are skipped (the supervisor's own
 * wake renders them already) and SEED the dedupe, so a copy of one of them on
 * another ledger (a ruling and its project mirror share an id; the owner typed
 * the same words twice) is not rendered a second time; one directive
 * appearing on several other ledgers renders once — the FIRST doc in `docs`
 * order wins, so callers list the Fleet Supervisor's ledger first. A 'fleet'
 * row is admitted only when standing (fleetRowBindsEveryProject). Pure.
 */
export function selectOwnerDirectivesInForce(
  docs: Array<{ chatId: string; doc: Pick<SupervisorStateDoc, 'directives'> | null | undefined }>,
  target: { projectName?: string | null; projectId?: string | null; excludeChatId?: string | null },
): OwnerDirectiveInForce[] {
  const out: OwnerDirectiveInForce[] = [];
  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  const textKeyOf = (d: SupervisorDirective) => d.text.replace(/\s+/g, ' ').trim().toLowerCase();
  // The excluded (own) ledger renders in the supervisor's state doc already —
  // its in-force rows seed the dedupe so their copies elsewhere stay out too.
  if (target.excludeChatId) {
    for (const { chatId, doc } of docs) {
      if (chatId !== target.excludeChatId) continue;
      for (const d of doc?.directives ?? []) {
        if (!isFanoutCandidate(d)) continue;
        seenIds.add(d.id);
        seenText.add(textKeyOf(d));
      }
    }
  }
  for (const { chatId, doc } of docs) {
    if (!chatId || (target.excludeChatId && chatId === target.excludeChatId)) continue;
    for (const d of doc?.directives ?? []) {
      if (!isFanoutCandidate(d)) continue;
      const match = scopeMatchesTarget(d.scope, target);
      if (!match) continue;
      if (match === 'fleet' && !fleetRowBindsEveryProject(d)) continue; // a non-standing Fleet Supervisor chat order is not fleet-wide
      const textKey = textKeyOf(d);
      if (seenIds.has(d.id) || seenText.has(textKey)) continue;
      seenIds.add(d.id);
      seenText.add(textKey);
      out.push({ id: d.id, text: d.text, at: d.at, scope: String(d.scope ?? ''), match, standing: d.standing === true, sourceChatId: chatId });
    }
  }
  return out;
}

function atMs(at: string): number {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

function clipText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** One rendered row: scope tag, the text, id8, date (and 'standing'). Pure. */
export function renderOwnerDirectiveLine(d: OwnerDirectiveInForce, projectLabel?: string | null): string {
  const tag = d.match === 'fleet' ? 'fleet' : clipText(projectLabel || d.scope || 'project', 40);
  const date = d.at ? String(d.at).slice(0, 10) : '';
  return `- [${tag}] ${clipText(d.text, OWNER_DIRECTIVE_LINE_TEXT_CHARS)} (${String(d.id).slice(0, 8)}${date ? `, ${date}` : ''}${d.standing ? ', standing' : ''})`;
}

/**
 * Render the block for a target. Standing rows first, then the rest, each
 * newest first; while the block is over `maxChars` the OLDEST non-standing
 * row drops, then the oldest standing one (never below one row), and the
 * block names how many it hid. '' when there is nothing in force. Pure.
 */
export function renderOwnerDirectivesInForceBlock(
  rows: OwnerDirectiveInForce[],
  opts: { projectName?: string | null; maxChars?: number } = {},
): { block: string; shown: OwnerDirectiveInForce[]; hidden: number } {
  if (!rows.length) return { block: '', shown: [], hidden: 0 };
  const maxChars = opts.maxChars ?? OWNER_DIRECTIVES_BLOCK_CHARS;
  const projectLabel = opts.projectName ? clipText(opts.projectName, 40) : '';
  const header = `${OWNER_DIRECTIVES_BLOCK_HEADING} — scope: fleet${projectLabel ? ` + ${projectLabel}` : ''}]\n`
    + 'The owner\'s own ledgered words, read by the harness from the supervisor ledgers (owner-origin rows only — never a relay or a paraphrase). They BIND this work; the tag says where each one applies ([fleet] = a standing fleet-wide owner rule; a project tag = an order for that project). A conflicting steer, todo or schedule prompt never narrows one — report the tension instead.';
  const byNewest = (a: OwnerDirectiveInForce, b: OwnerDirectiveInForce) => atMs(b.at) - atMs(a.at);
  const shown = [...rows.filter((r) => r.standing).sort(byNewest), ...rows.filter((r) => !r.standing).sort(byNewest)];
  let hidden = 0;
  const render = () => [
    header,
    ...shown.map((r) => renderOwnerDirectiveLine(r, projectLabel)),
    ...(hidden ? [`- (+${hidden} older owner directive${hidden === 1 ? '' : 's'} in force not shown — the supervisor ledgers hold them)`] : []),
  ].join('\n');
  let text = render();
  while (text.length > maxChars && shown.length > 1) {
    // Oldest non-standing first (the tail of the non-standing run), then the oldest standing.
    let idx = -1;
    for (let i = shown.length - 1; i >= 0; i--) { if (!shown[i].standing) { idx = i; break; } }
    if (idx < 0) idx = shown.length - 1;
    shown.splice(idx, 1);
    hidden += 1;
    text = render();
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return { block: text, shown, hidden };
}

/** Fire-and-forget owner_directive_delivered — ONE aggregate row per delivery. */
export function recordOwnerDirectiveDelivered(input: { targetChatId: string; surface: OwnerDirectiveSurface; shown: OwnerDirectiveInForce[]; hidden: number; runId?: string }): void {
  if (!input.shown.length) return;
  void import('./loop-metrics.service')
    .then((m) => m.recordLoopMetric({
      kind: 'owner_directive_delivered',
      sessionId: input.targetChatId,
      ...(input.runId ? { runId: input.runId } : {}),
      value: input.shown.length,
      meta: {
        directiveIds: input.shown.slice(0, 12).map((d) => String(d.id).slice(0, 12)),
        targetChatId: input.targetChatId.slice(0, 8),
        surface: input.surface,
        fleet: input.shown.filter((d) => d.match === 'fleet').length,
        project: input.shown.filter((d) => d.match === 'project').length,
        hidden: input.hidden,
      },
    }))
    .catch(() => { /* telemetry never blocks */ });
}

/**
 * Build the block for an owner + project (null = fleet scope only). Reads,
 * BY CHAT ID, the ledgers that can hold a row binding the target — the Fleet
 * Supervisor's (listed first) and this project's live supervisor chats' (a
 * 'fleet' row is only ever stamped in the projectless Fleet Supervisor chat
 * or by a ruling banked there; a project row is stamped in that project's
 * supervisor chat or banked on the Fleet Supervisor's) — never an unordered
 * "first 50 supervisor_states of the owner", which could miss the Fleet
 * Supervisor's ledger on a large account. Resolves the project's name,
 * selects and renders. TOTAL: disabled / no rows / any failure → { block: '' }.
 */
export async function buildOwnerDirectivesInForceBlock(
  userId: string,
  projectId: string | null,
  opts: { excludeChatId?: string | null; projectName?: string | null; maxChars?: number } = {},
): Promise<{ block: string; shown: OwnerDirectiveInForce[]; hidden: number }> {
  const none = { block: '', shown: [] as OwnerDirectiveInForce[], hidden: 0 };
  if (ownerDirectiveFanoutDisabled() || !userId) return none;
  try {
    const prisma: any = (await import('../../../config/database')).default;
    // The same Fleet Supervisor lookup the ledger writers use (owner-questions fleetSupervisorLedgerTarget).
    const fleet = await prisma.crossModelChat.findFirst({ where: { userId, isSupervisor: true }, select: { id: true } }).catch(() => null);
    const fleetId: string | null = typeof fleet?.id === 'string' ? fleet.id : null;
    const projectSups: unknown = projectId
      ? await prisma.crossModelChat.findMany({
        where: { userId, projectId, isProjectSupervisor: true, archivedAt: null },
        select: { id: true }, orderBy: { createdAt: 'asc' }, take: 5,
      }).catch(() => [])
      : [];
    // The excluded (own) ledger is read too — it seeds the dedupe, never renders.
    const chatIds = [...new Set([fleetId, ...(Array.isArray(projectSups) ? projectSups.map((c: any) => c?.id) : []), opts.excludeChatId]
      .filter((x): x is string => typeof x === 'string' && !!x))];
    if (!chatIds.length) return none;
    const rows: Array<{ chatId: string; state: unknown }> = await prisma.supervisorState.findMany({
      where: { userId, chatId: { in: chatIds } }, select: { chatId: true, state: true },
    });
    if (!Array.isArray(rows) || !rows.length) return none;
    let projectName = opts.projectName ?? null;
    if (projectId && !projectName) {
      const project = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { name: true } }).catch(() => null);
      projectName = typeof project?.name === 'string' ? project.name : null;
    }
    const { parseSupervisorStateDoc, archiveStaleDirectives } = await import('./supervisor-state.service');
    const docs = rows
      .map((r) => ({ chatId: String(r.chatId), doc: archiveStaleDirectives(parseSupervisorStateDoc(r.state)).doc }))
      .sort((a, b) => Number(b.chatId === fleetId) - Number(a.chatId === fleetId));
    const selected = selectOwnerDirectivesInForce(docs, { projectName, projectId, excludeChatId: opts.excludeChatId ?? null });
    return renderOwnerDirectivesInForceBlock(selected, { projectName, maxChars: opts.maxChars });
  } catch {
    return none;
  }
}
