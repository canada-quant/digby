/**
 * ProjectBrief loader — fills project-brief.model.ts from the project's OWN
 * record so a scaffolded project supervisor prompt is built for THAT project:
 *   name / id / mission      crossmodel_projects (name, description)
 *   instructions             the folder chain's effective system prompt (root→leaf)
 *   goals + premises         project_goals (active + blocked, cap 12, CREATION
 *                            order, title + status only; premises JSON) — the
 *                            STABLE view: blockedReason is lane-authored prose
 *                            that changes on every block and rides the [BOARD]
 *                            block live, so it stays out of the stored prompt
 *   repos                    the project row's repo fields
 *   codingModel              the project's merged settings (store [projectId,'settings'])
 *   standingDecisions        OWNER-ORIGIN rows only (review fix 2026-09-27):
 *                            answered owner questions filed from this project's
 *                            chats FIRST, then the project supervisor's state-doc
 *                            directives that carry the harness `origin` stamp
 *                            AND are scoped to this project by name/id (cap 10);
 *                            OWNER-PROVENANCE-STRICT (2026-10-20): an answered
 *                            question whose answeredBy is 'supervisor' /
 *                            'default' is a SUPERVISOR RULING (revisable,
 *                            its own section), never an owner decision
 *   fleetRules               OWNER-DIRECTIVE-FANOUT (2026-10-20): OPEN standing
 *                            owner-origin rows scoped 'fleet' on the Fleet
 *                            Supervisor's ledger + this supervisor's own
 *   environments / budget /  store [projectId,'brief'] (owner-set via
 *   preferences              GET/PUT /projects/:id/brief — see platform routes)
 *   contextState             NOT loaded (review fix): the model-extracted summary
 *                            in store [projectId,'context'] is rewritten after
 *                            every synthesis — it churned the stored prompt on
 *                            every reconcile; the wake reads it live instead
 *
 * FAIL-OPEN PER SOURCE: every read is wrapped; a missing table, a mocked
 * client or a read error drops that field and never throws, so the ensure /
 * heal paths that call this can never fail a wake, and a project with nothing
 * recorded loads as `{name, id}` (renders byte-identical to the old
 * name+id-only scaffold). Cached 60 s per project (the heals run every 15 min;
 * a wake composes once).
 *
 * Import discipline: static imports are prisma-only modules (context-store,
 * folder-inheritance); supervisor-state.service is DYNAMICALLY imported (its
 * graph reaches the dormancy gate + schedule-near-cap).
 */

import prisma from '../../../config/database';
import { storeGet, storePut } from '../memory/context-store';
import { getEffectiveSystemPrompt, getMergedProjectStoreState } from './folder-inheritance';
import { type ProjectBrief, type ProjectBriefBudget, type ProjectBriefEnvironment, BRIEF_CAPS, minimalProjectBrief } from './project-brief.model';
import { ownerDirectiveFanoutDisabled, ownerProvenanceStrictDisabled } from './owner-authority-switches';

export const PROJECT_BRIEF_CACHE_TTL_MS = 60_000;
/** Store namespace + key for the owner-set brief extras. */
export const PROJECT_BRIEF_STORE_KEY = 'brief';
export const PROJECT_BRIEF_EXTRAS_KEY = 'extras';

export interface ProjectBriefExtras {
  environments?: ProjectBriefEnvironment[];
  budget?: ProjectBriefBudget | null;
  preferences?: string[];
  /** Optional owner-written KPI rows until ProjectGoal carries a receipt column. */
  kpis?: ProjectBrief['kpis'];
}

const cache = new Map<string, { at: number; brief: ProjectBrief }>();

export function clearProjectBriefCache(): void { cache.clear(); }

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Read the owner-set extras (environments / budget / preferences / kpis). */
export async function getProjectBriefExtras(projectId: string): Promise<ProjectBriefExtras> {
  const v = await safe(() => storeGet<ProjectBriefExtras>([projectId, PROJECT_BRIEF_STORE_KEY], PROJECT_BRIEF_EXTRAS_KEY));
  return v && typeof v === 'object' ? v : {};
}

/** Merge a patch into the owner-set extras (REST PUT /projects/:id/brief). */
export async function setProjectBriefExtras(projectId: string, patch: ProjectBriefExtras): Promise<ProjectBriefExtras> {
  const current = await getProjectBriefExtras(projectId);
  const next: ProjectBriefExtras = { ...current };
  if (patch.environments !== undefined) {
    next.environments = (Array.isArray(patch.environments) ? patch.environments : [])
      .filter(e => e && typeof e.name === 'string' && e.name.trim())
      .slice(0, 20)
      .map(e => ({ name: e.name.trim().slice(0, 120), ...(e.kind ? { kind: String(e.kind).slice(0, 40) } : {}), ...(e.access ? { access: String(e.access).slice(0, 160) } : {}) }));
  }
  if (patch.budget !== undefined) {
    const b = patch.budget;
    next.budget = b && (b.policy === 'pre_approved' || b.policy === 'envelope' || b.policy === 'ask')
      ? { policy: b.policy, ...(b.envelope ? { envelope: String(b.envelope).slice(0, 80) } : {}), ...(b.note ? { note: String(b.note).slice(0, 160) } : {}) }
      : null;
  }
  if (patch.preferences !== undefined) {
    next.preferences = (Array.isArray(patch.preferences) ? patch.preferences : []).map(p => String(p ?? '').trim()).filter(Boolean).slice(0, 12).map(p => p.slice(0, 240));
  }
  if (patch.kpis !== undefined) {
    next.kpis = (Array.isArray(patch.kpis) ? patch.kpis : []).filter(k => k && typeof k.title === 'string' && k.title.trim()).slice(0, 12)
      .map(k => ({ title: k.title.trim().slice(0, 240), ...(k.target ? { target: String(k.target).slice(0, 60) } : {}), ...(k.unit ? { unit: String(k.unit).slice(0, 20) } : {}), ...(k.receipt ? { receipt: String(k.receipt).slice(0, 160) } : {}) }));
  }
  await storePut([projectId, PROJECT_BRIEF_STORE_KEY], PROJECT_BRIEF_EXTRAS_KEY, next as any);
  cache.delete(projectId);
  return next;
}

function parsePremises(json: unknown): ProjectBrief['premises'] {
  if (!Array.isArray(json)) return [];
  const out: NonNullable<ProjectBrief['premises']> = [];
  for (const p of json) {
    if (!p || typeof p !== 'object') continue;
    const key = str((p as any).key);
    const value = (p as any).value;
    if (!key || typeof value !== 'number' || !Number.isFinite(value)) continue;
    out.push({ key, value, ...(str((p as any).unit) ? { unit: str((p as any).unit)! } : {}), ...(str((p as any).note) ? { note: str((p as any).note)! } : {}), ...(str((p as any).source) ? { source: str((p as any).source)! } : {}) });
  }
  return out;
}

export interface LoadProjectBriefOpts {
  /** The project row when the caller already holds it (saves a read). */
  project?: { id: string; name: string; description?: string | null; repoUrl?: string | null; repoProvider?: string | null; defaultBranch?: string | null; githubLabel?: string | null } | null;
  /** The project supervisor chat id whose state-doc directives are this project's owner decisions. */
  supervisorChatId?: string | null;
  bypassCache?: boolean;
}

/**
 * Load the brief for a project. NEVER throws. Returns the minimal brief when
 * the project cannot be read (caller decides whether that is acceptable).
 */
export async function loadProjectBrief(projectId: string, userId: string, opts: LoadProjectBriefOpts = {}): Promise<ProjectBrief> {
  const hit = !opts.bypassCache && cache.get(projectId);
  if (hit && Date.now() - hit.at < PROJECT_BRIEF_CACHE_TTL_MS) return hit.brief;

  const project = opts.project ?? (await safe(() => prisma.crossModelProject.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, repoUrl: true, repoProvider: true, defaultBranch: true, githubLabel: true },
  }))) ?? null;
  if (!project) return minimalProjectBrief('(unknown project)', projectId);

  const brief: ProjectBrief = minimalProjectBrief(project.name, project.id);

  const mission = str(project.description);
  if (mission) brief.mission = mission;

  const instructions = await safe(() => getEffectiveSystemPrompt(projectId));
  if (str(instructions)) brief.instructions = instructions!.trim();

  // Goals — the STABLE view (review fix 2026-09-27): CREATION order (a touch
  // never re-sorts the list), title + status only. `blockedReason` is
  // lane-authored prose (the halt.owner-words contamination class — "waiting
  // on the owner's HALT" would otherwise be baked into the system prompt) and
  // changes on every block; the [BOARD] block renders it live with its
  // blockKind. The stored prompt therefore moves only on a real ledger event
  // (a goal added, finished or flipped active↔blocked), not on every
  // 15-minute reconcile of an active project.
  const goals = await safe(() => prisma.projectGoal.findMany({
    where: { projectId, status: { in: ['active', 'blocked'] } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    take: BRIEF_CAPS.goals,
    select: { id: true, title: true, status: true, premises: true },
  }));
  if (Array.isArray(goals) && goals.length) {
    brief.goals = goals.map(g => ({ id: g.id, title: g.title, status: g.status }));
    const premises = goals.flatMap(g => parsePremises(g.premises) ?? []);
    if (premises.length) brief.premises = premises.slice(0, BRIEF_CAPS.premises);
  }

  if (str(project.repoUrl)) {
    brief.repos = [{ url: project.repoUrl!.trim(), provider: project.repoProvider ?? null, defaultBranch: project.defaultBranch ?? null, githubLabel: project.githubLabel ?? null }];
  }

  const settings = await safe(() => getMergedProjectStoreState<{ codingModel?: unknown }>(projectId, 'settings'));
  if (settings && str(settings.codingModel)) brief.codingModel = str(settings.codingModel);

  const extras = await getProjectBriefExtras(projectId);
  if (extras.environments?.length) brief.environments = extras.environments;
  if (extras.budget) brief.budget = extras.budget;
  if (extras.preferences?.length) brief.preferences = extras.preferences;
  if (extras.kpis?.length) brief.kpis = extras.kpis;

  // Standing decisions — OWNER-ORIGIN ONLY (review fix 2026-09-27). Two
  // sources, in this order:
  //   1. answered owner questions filed from this project's chats (the
  //      ownerQuestion table — owner-origin by construction) — pushed FIRST so
  //      the state-doc rows can never crowd them out of the cap;
  //   2. the project supervisor's state-doc directives that carry the HARNESS
  //      `origin` stamp ('owner' = a message the owner typed into the lane,
  //      'owner_question' = the banked ruling appendAnsweredQuestionDirective
  //      wrote) AND are scoped to THIS project by name or id.
  // A row without the stamp is legacy or supervisor-written —
  // update_supervisor_state lets the model push {text, scope?} rows with no
  // provenance — i.e. exactly the lane-authored "band table" / "owner
  // decision" class rule halt.owner-words exists for, so it is never rendered
  // under the owner-origin label whatever its scope says. Scopeless and
  // 'fleet'-scoped rows are out too: a scopeless directive is never cited
  // cross-project (rule scope.project), and an owner message in THIS lane is
  // always stamped with this project's name. A state-doc row that banks an
  // answered question already listed from the table (evidence 'oq <id>') is
  // skipped so one ruling never renders twice.
  // OWNER-PROVENANCE-STRICT (2026-10-20): only an answer the OWNER gave is an
  // owner decision — answeredBy 'supervisor' (answer_owner_question under the
  // standing directives) and 'default' (the flagger's preset default, auto-
  // applied) are listed as SUPERVISOR RULINGS (revisable). A NULL answeredBy is
  // the owner: the column predates the supervisor / default paths, and the
  // in-chat card path stamps nothing for an owner answer. Kill switch
  // OWNER_PROVENANCE_STRICT_DISABLED=1 lists every answer as before.
  const strictProvenance = !ownerProvenanceStrictDisabled();
  const decisions: NonNullable<ProjectBrief['standingDecisions']> = [];
  const supervisorRulings: NonNullable<ProjectBrief['supervisorRulings']> = [];
  const listedQuestionIds = new Set<string>();
  // Ledger rows listed as this project's standing decisions — the fleet-rules
  // section below skips their ids (a standing ruling's mirror on this
  // supervisor's ledger and the Fleet Supervisor's 'fleet' copy share one).
  const decisionDirectiveIds = new Set<string>();
  const answered = await safe(async () => {
    const chats = await prisma.crossModelChat.findMany({ where: { projectId, userId }, select: { id: true }, take: 200 });
    const ids = chats.map(c => c.id);
    if (!ids.length) return [];
    return prisma.ownerQuestion.findMany({
      where: { userId, status: 'answered', OR: [{ chatId: { in: ids } }, { forChatId: { in: ids } }] },
      orderBy: { resolvedAt: 'desc' },
      take: BRIEF_CAPS.decisions + (strictProvenance ? BRIEF_CAPS.supervisorRulings : 0),
      select: { id: true, question: true, answer: true, chosenOption: true, resolvedAt: true, answeredBy: true },
    });
  });
  for (const q of answered ?? []) {
    const ans = str(q.answer) ?? str(q.chosenOption);
    if (!ans) continue;
    listedQuestionIds.add(String(q.id));
    const by = (q as { answeredBy?: string | null }).answeredBy;
    const at = q.resolvedAt ? q.resolvedAt.toISOString() : undefined;
    if (strictProvenance && (by === 'supervisor' || by === 'default')) {
      supervisorRulings.push({ at, text: `Q: ${String(q.question).slice(0, 120)} → ${by === 'supervisor' ? 'supervisor ruling' : 'preset default'}: ${ans}`, evidence: q.id });
      continue;
    }
    if (decisions.length < BRIEF_CAPS.decisions) decisions.push({ at, text: `Q: ${String(q.question).slice(0, 120)} → A: ${ans}`, evidence: q.id });
  }
  const doc = opts.supervisorChatId
    ? await safe(async () => {
      const { getSupervisorState } = await import('./supervisor-state.service');
      return getSupervisorState(opts.supervisorChatId!);
    })
    : undefined;
  if (opts.supervisorChatId) {
    for (const d of doc?.directives ?? []) {
      if (!d || typeof d.text !== 'string') continue;
      if (d.origin !== 'owner' && d.origin !== 'owner_question') continue; // the harness stamp is required
      if (d.kind === 'ask') continue; // an owner STATUS QUESTION (sup/upward-chatter kind:'ask') is answered, never a standing decision
      const scope = typeof d.scope === 'string' ? d.scope : '';
      if (scope !== project.name && scope !== project.id) continue; // THIS project only — never scopeless / fleet
      if (d.status === 'done' && !d.standing && d.origin !== 'owner_question') continue; // a finished order is not a standing decision
      const evidence = typeof d.evidence === 'string' ? d.evidence : '';
      const bankedId = evidence.match(/^oq\s+(\S+)/)?.[1];
      if (bankedId && [...listedQuestionIds].some(id => id === bankedId || id.startsWith(bankedId))) continue; // already listed from the table
      decisions.push({ at: d.at, text: d.text, ...(evidence ? { evidence } : {}) });
      if (typeof d.id === 'string' && d.id) decisionDirectiveIds.add(d.id);
    }
  }
  if (decisions.length) brief.standingDecisions = decisions.slice(0, BRIEF_CAPS.decisions);
  if (supervisorRulings.length) brief.supervisorRulings = supervisorRulings.slice(0, BRIEF_CAPS.supervisorRulings);

  // Fleet-wide owner rules (OWNER-DIRECTIVE-FANOUT, 2026-10-20): the rows
  // above are THIS project's only, so a standing owner ruling scoped 'fleet'
  // (an owner-question ruling the harness banked on the Fleet Supervisor's
  // ledger, or a fleet-wide owner message) never reached a project prompt.
  // OPEN + standing + scope 'fleet' + the harness owner stamp, never an ask;
  // from the Fleet Supervisor's ledger and this supervisor's own; deduped by
  // id (also against the rows already listed as standing decisions above —
  // review fix: a standing ruling's project mirror and its Fleet copy share
  // the id and rendered in both sections), newest first. Kill switch
  // OWNER_DIRECTIVE_FANOUT_DISABLED=1.
  if (!ownerDirectiveFanoutDisabled()) {
    const fleetDoc = await safe(async () => {
      const fs = await prisma.crossModelChat.findFirst({ where: { userId, isSupervisor: true }, select: { id: true } });
      if (!fs?.id || fs.id === opts.supervisorChatId) return undefined;
      const { getSupervisorState } = await import('./supervisor-state.service');
      return getSupervisorState(fs.id);
    });
    const seen = new Set<string>(decisionDirectiveIds);
    const rules: Array<{ at: string; text: string; id: string }> = [];
    for (const d of [...(fleetDoc?.directives ?? []), ...(doc?.directives ?? [])]) {
      if (!d || typeof d.text !== 'string' || seen.has(d.id)) continue;
      if (d.status !== 'open' || d.standing !== true || d.kind === 'ask') continue;
      if (d.origin !== 'owner' && d.origin !== 'owner_question') continue;
      if (String(d.scope ?? '').trim().toLowerCase() !== 'fleet') continue;
      seen.add(d.id);
      rules.push({ at: String(d.at ?? ''), text: d.text, id: d.id });
    }
    rules.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    if (rules.length) brief.fleetRules = rules.slice(0, BRIEF_CAPS.fleetRules).map(r => ({ ...(r.at ? { at: r.at } : {}), text: r.text, evidence: `directive ${r.id.slice(0, 8)}` }));
  }

  // contextState is deliberately NOT loaded (see the header): the renderer
  // still prints one for callers that pass it (a lane brief), but the stored
  // supervisor brief must only move on owner-set fields and real ledger events.

  cache.set(projectId, { at: Date.now(), brief });
  return brief;
}
