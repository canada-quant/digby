/**
 * ProjectBrief — layer 3 of the layered prompt (prompt-layers.ts): the ONE
 * project-specific block a scaffolded project supervisor (or a lane brief)
 * carries, built from the project's OWN record — never from doctrine. Distinct
 * from fleet/project-brief.service.ts (the owner-facing STATUS card).
 *
 * PURE LEAF: the type + a deterministic renderer. The loader
 * (project-brief.loader.ts) fills it from Prisma / the context store; tests and
 * the composer only need this file. Every field is optional past name + id, is
 * clipped when rendered, and is OMITTED when empty — a brief is never padded,
 * and a project with nothing recorded renders as its name + id alone (the same
 * bytes the pre-brief scaffold interpolated), so the stock-prompt heals see no
 * churn on an empty project. The render is FITTED to PROJECT_BRIEF_BUDGET
 * (review fix 2026-09-27): when the per-field caps still leave the block over
 * budget, the least essential sections are dropped in BRIEF_DROP_ORDER — rows
 * from the tail of a list first — and the block says so (BRIEF_CLIPPED_LINE).
 */

export interface ProjectBriefKpi { title: string; target?: string; unit?: string; receipt?: string }
export interface ProjectBriefGoal { id: string; title: string; status: string; blockedReason?: string | null }
export interface ProjectBriefPremise { key: string; value: number; unit?: string; note?: string; source?: string }
export interface ProjectBriefRepo { url: string; provider?: string | null; defaultBranch?: string | null; githubLabel?: string | null }
export interface ProjectBriefEnvironment { name: string; kind?: string; access?: string }
export interface ProjectBriefBudget { policy: 'pre_approved' | 'envelope' | 'ask'; envelope?: string; note?: string }
export interface ProjectBriefDecision { at?: string; text: string; evidence?: string }

export interface ProjectBrief {
  name: string;
  id: string;
  /** crossmodel_projects.description — the mission in the owner's words. */
  mission?: string | null;
  /** The effective folder-chain system prompt (root→leaf) — the owner's instructions for THIS project. */
  instructions?: string | null;
  kpis?: ProjectBriefKpi[];
  goals?: ProjectBriefGoal[];
  premises?: ProjectBriefPremise[];
  repos?: ProjectBriefRepo[];
  environments?: ProjectBriefEnvironment[];
  budget?: ProjectBriefBudget | null;
  codingModel?: string | null;
  standingDecisions?: ProjectBriefDecision[];
  /** OWNER-DIRECTIVE-FANOUT (2026-10-20): OPEN standing owner-origin rules scoped
   *  'fleet' (the Fleet Supervisor's ledger + this project supervisor's own) —
   *  the owner's words that bind every project, this one included. */
  fleetRules?: ProjectBriefDecision[];
  /** OWNER-PROVENANCE-STRICT (2026-10-20): flagged questions from this project's
   *  chats a SUPERVISOR (standing directives) or a PRESET DEFAULT answered —
   *  revisable rulings, never listed as the owner's standing decisions. */
  supervisorRulings?: ProjectBriefDecision[];
  preferences?: string[];
  contextState?: string | null;
}

/** The project layer's char budget. prompt-layers.ts LAYER_BUDGETS.project
 *  reads it from HERE (this model is the leaf; the composer imports it) and
 *  renderProjectBrief ENFORCES it at render time (review fix 2026-09-27): the
 *  per-field caps below bound each section and the fit loop drops the least
 *  essential sections — row by row from the tail of a list — until the block
 *  fits, so the lint's over_budget rule pins the algorithm instead of being
 *  the only guard. Worst case with every cap filled: ~25k chars before the
 *  loop (12 goals alone can pass 4,800), ≤ 4,000 after it. */
export const PROJECT_BRIEF_BUDGET = 4_000;

/** Render caps (chars / rows) per section — the fit loop bounds the whole. */
export const BRIEF_CAPS = {
  mission: 600,
  instructions: 1_200,
  contextState: 500,
  goals: 12,
  premises: 20,
  kpis: 8,
  repos: 6,
  environments: 8,
  decisions: 10,
  fleetRules: 6,
  supervisorRulings: 6,
  preferences: 8,
  line: 240,
} as const;

export const BRIEF_HEADING = '## This project';

/** The honesty line a clipped brief ends with (counted inside the budget):
 *  the model learns the block is partial and where the full ledger lives. */
export const BRIEF_CLIPPED_LINE = '- (brief clipped to the layer budget — goal_list, list_owner_questions and the [BOARD] block carry the full ledger)';

/** Sections in the order they are DROPPED when the render exceeds the budget
 *  (least essential first): the live ledger views go before the owner-set
 *  operating facts, which go before the owner's own words; the identity line
 *  is never dropped. A list section loses rows from its TAIL one at a time
 *  and its header only with its last row, so its first rows — the newest
 *  decisions, the first goals — survive longest. Display order is fixed
 *  (BRIEF_DISPLAY_ORDER) whatever was dropped. */
export const BRIEF_DROP_ORDER = [
  'contextState', 'premises', 'goals', 'supervisorRulings', 'kpis', 'environments', 'preferences', 'decisions', 'fleetRules', 'codingModel', 'repos', 'budget', 'mission', 'instructions',
] as const;
export type BriefSectionKey = (typeof BRIEF_DROP_ORDER)[number];
export const BRIEF_DISPLAY_ORDER: readonly BriefSectionKey[] = [
  'mission', 'instructions', 'goals', 'kpis', 'premises', 'repos', 'environments', 'budget', 'codingModel', 'decisions', 'fleetRules', 'supervisorRulings', 'preferences', 'contextState',
];

export function minimalProjectBrief(name: string, id: string): ProjectBrief {
  return { name, id };
}

function clip(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function clipBlock(s: unknown, max: number): string {
  const t = String(s ?? '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** A rendered section: its lines and how many of them are droppable list rows
 *  (0 for a single-block section such as the mission). */
interface BriefSection { lines: string[]; rows: number }

/**
 * Deterministic render of the brief as the "## This project" block, FITTED to
 * `budget` (default PROJECT_BRIEF_BUDGET). Missing or empty fields produce NO
 * line. The first line is always `Project "<name>" (projectId <id>)` — the
 * scaffold's identity line (the name is only truncated past BRIEF_CAPS.line,
 * never re-spaced, so an ordinary name renders the old scaffold's bytes).
 * When the caps still leave the block over budget, sections are dropped in
 * BRIEF_DROP_ORDER (rows from the tail first) and the block ends with
 * BRIEF_CLIPPED_LINE; a same-input render always yields the same bytes.
 */
export function renderProjectBrief(brief: ProjectBrief, budget: number = PROJECT_BRIEF_BUDGET): string {
  const name = brief.name.length <= BRIEF_CAPS.line ? brief.name : `${brief.name.slice(0, BRIEF_CAPS.line - 1)}…`;
  const identity = [BRIEF_HEADING, `Project "${name}" (projectId ${clip(brief.id, 80)}).`];
  const sections: Partial<Record<BriefSectionKey, BriefSection>> = {};
  const single = (key: BriefSectionKey, line: string) => { sections[key] = { lines: [line], rows: 0 }; };
  const list = (key: BriefSectionKey, header: string, rows: string[]) => { if (rows.length) sections[key] = { lines: [header, ...rows], rows: rows.length }; };

  if (brief.mission && brief.mission.trim()) single('mission', `- Mission: ${clip(brief.mission, BRIEF_CAPS.mission)}`);
  if (brief.instructions && brief.instructions.trim()) {
    single('instructions', `- Owner instructions for this project (they outrank the generic doctrine above wherever they speak to the same thing):\n${clipBlock(brief.instructions, BRIEF_CAPS.instructions)}`);
  }
  const goals = (brief.goals ?? []).filter(g => g && g.title).slice(0, BRIEF_CAPS.goals);
  list('goals', '- Goals (the [BOARD] block is the live ledger):', goals.map(g => {
    const blocked = g.blockedReason ? ` — blocked: ${clip(g.blockedReason, 120)}` : '';
    return `  - [${g.status}] ${clip(g.title, BRIEF_CAPS.line)} (goal ${String(g.id).slice(0, 8)})${blocked}`;
  }));
  const kpis = (brief.kpis ?? []).filter(k => k && k.title).slice(0, BRIEF_CAPS.kpis);
  list('kpis', '- KPIs (compare every result against the REGISTERED value, never a remembered one):', kpis.map(k => {
    const target = k.target ? ` target ${clip(k.target, 60)}${k.unit ? ` ${clip(k.unit, 20)}` : ''}` : '';
    const receipt = k.receipt ? ` — receipt: ${clip(k.receipt, 120)}` : '';
    return `  - ${clip(k.title, BRIEF_CAPS.line)}${target}${receipt}`;
  }));
  const premises = (brief.premises ?? []).filter(p => p && p.key).slice(0, BRIEF_CAPS.premises);
  list('premises', '- Registered premises (goal_premise_set; re-checked against their source):', premises.map(p => {
    const unit = p.unit ? ` ${clip(p.unit, 20)}` : '';
    const src = p.source ? ` — source ${clip(p.source, 100)}` : p.note ? ` — ${clip(p.note, 100)}` : '';
    return `  - ${clip(p.key, 80)} = ${p.value}${unit}${src}`;
  }));
  const repos = (brief.repos ?? []).filter(r => r && r.url).slice(0, BRIEF_CAPS.repos);
  list('repos', '- Repositories:', repos.map(r => {
    const branch = r.defaultBranch ? ` (default branch ${clip(r.defaultBranch, 60)})` : '';
    const label = r.githubLabel ? ` via GitHub account ${clip(r.githubLabel, 60)}` : '';
    return `  - ${clip(r.url, BRIEF_CAPS.line)}${branch}${label}`;
  }));
  const envs = (brief.environments ?? []).filter(e => e && e.name).slice(0, BRIEF_CAPS.environments);
  list('environments', '- Environments this project holds (watched resources; register_watched_resource / observe_resource keep them honest):', envs.map(e =>
    `  - ${clip(e.name, 120)}${e.kind ? ` [${clip(e.kind, 40)}]` : ''}${e.access ? ` — ${clip(e.access, 120)}` : ''}`));
  if (brief.budget) {
    const b = brief.budget;
    const policy = b.policy === 'pre_approved'
      ? 'PRE-APPROVED — spend inside the grant is never an owner question (rule money.grant)'
      : b.policy === 'envelope'
        ? `ENVELOPE ${clip(b.envelope ?? '', 80)} — spend inside it is never an owner question; only exceeding it is`
        : 'ASK — new spend needs an owner answer';
    single('budget', `- Budget: ${policy}${b.note ? ` — ${clip(b.note, 160)}` : ''}`);
  }
  if (brief.codingModel && brief.codingModel.trim()) single('codingModel', `- Coding seat for this project's sessions: ${clip(brief.codingModel, 80)}`);
  const decisions = (brief.standingDecisions ?? []).filter(d => d && d.text).slice(0, BRIEF_CAPS.decisions);
  list('decisions', '- Owner standing decisions (this project, owner-origin — cite them by date when you apply them):', decisions.map(d => {
    const at = d.at ? `${String(d.at).slice(0, 10)}: ` : '';
    const ev = d.evidence ? ` (${clip(d.evidence, 80)})` : '';
    return `  - ${at}${clip(d.text, BRIEF_CAPS.line)}${ev}`;
  }));
  const fleetRules = (brief.fleetRules ?? []).filter(d => d && d.text).slice(0, BRIEF_CAPS.fleetRules);
  list('fleetRules', '- Fleet-wide owner rules (owner-origin, standing — they bind this project too):', fleetRules.map(d => {
    const at = d.at ? `${String(d.at).slice(0, 10)}: ` : '';
    const ev = d.evidence ? ` (${clip(d.evidence, 80)})` : '';
    return `  - ${at}${clip(d.text, BRIEF_CAPS.line)}${ev}`;
  }));
  const rulings = (brief.supervisorRulings ?? []).filter(d => d && d.text).slice(0, BRIEF_CAPS.supervisorRulings);
  list('supervisorRulings', '- Supervisor rulings (revisable — a supervisor or a preset default answered these, not the owner):', rulings.map(d => {
    const at = d.at ? `${String(d.at).slice(0, 10)}: ` : '';
    const ev = d.evidence ? ` (${clip(d.evidence, 80)})` : '';
    return `  - ${at}${clip(d.text, BRIEF_CAPS.line)}${ev}`;
  }));
  const prefs = (brief.preferences ?? []).map(p => clip(p, BRIEF_CAPS.line)).filter(Boolean).slice(0, BRIEF_CAPS.preferences);
  list('preferences', '- Owner preferences for this project (naming, cadence, reporting):', prefs.map(p => `  - ${p}`));
  if (brief.contextState && brief.contextState.trim()) single('contextState', `- Project state summary: ${clip(brief.contextState, BRIEF_CAPS.contextState)}`);

  // Fit loop — see BRIEF_DROP_ORDER. Bounded: every iteration removes a line.
  let clipped = false;
  const render = () => [...identity, ...BRIEF_DISPLAY_ORDER.flatMap(k => sections[k]?.lines ?? []), ...(clipped ? [BRIEF_CLIPPED_LINE] : [])].join('\n');
  let text = render();
  while (text.length > budget) {
    const key = BRIEF_DROP_ORDER.find(k => (sections[k]?.lines.length ?? 0) > 0);
    if (!key) break;
    const s = sections[key]!;
    if (s.rows > 1) { s.lines.pop(); s.rows -= 1; } // a list keeps its header while rows remain
    else { s.lines = []; s.rows = 0; }               // the last row, or a single block: the section goes
    clipped = true;
    text = render();
  }
  // Only the identity line can still be over (an absurd name / id): hard-bound it.
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return text;
}
