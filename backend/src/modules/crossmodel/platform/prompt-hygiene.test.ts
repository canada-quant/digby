/**
 * PROMPT-HYGIENE LINT (CI, 2026-09-27) — every GENERIC prompt block the
 * framework generates is free of project names, incident ids, dated rules,
 * owner-quote markers, model ids and env toggles; every composed prompt keeps
 * its layer budgets and repeats no sentence across layers; the allowlist is
 * unexpired and names no project. See platform/prompt-hygiene.ts for the
 * rules and prompt-hygiene.allow.json for the (dated, reasoned) exceptions.
 *
 * Sources (rendered exactly as the runs see them, DB-free — the same boundary
 * mocks doctrine-coverage.test.ts uses):
 *   - the composed fleet + project supervisor prompts (layers core/facts/role);
 *   - the two stored sweep bodies; the machine-wake preamble + firing headers;
 *   - the hook wake template; the chat playbook + offers + follow-ups blocks;
 *   - the coding orchestrator guidance + every worker role prompt;
 *   - every `description` string in the platform + coding tool schemas;
 *   - the ticket-dispatch brief instructions.
 *
 * PROMPT_HYGIENE_WARN_ONLY=1 downgrades a failure to a printed report (the
 * rollout switch — off in CI).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn() } }));
jest.mock('../coding/schedule.service', () => ({ __esModule: true, emitScheduleDisabled: jest.fn(async () => undefined) }));

import * as fs from 'fs';
import * as path from 'path';
import { lintPromptText, lintComposedPrompt, lintAllowlist, formatFindings, type AllowlistEntry, type HygieneFinding } from './prompt-hygiene';
import { buildFleetSupervisorPrompt, buildFleetSweepPrompt } from './supervisor.service';
import { buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } from './project-supervisor.service';
import { machineWakePreamble, machineFiringHeader } from '../chat-agent/machine-wake';
import { DEFAULT_PROMPT_TEMPLATE, CHILD_RESULT_PROMPT_TEMPLATE } from './hooks.service';
import { platformPlaybookBlock, proactiveOffersBlock, followUpsInstruction } from '../chat-agent/capability-doctrine';
import { orchestratorRoleGuidance, ROLES } from '../coding/roles';
import { coreDoctrine } from './core-doctrine';
import { frameworkFactsBlock } from './framework-facts';
import { fleetSupervisorRoleProfile } from './role-profiles';
import { maximalProjectBrief } from './project-brief.fixtures';

const allowFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt-hygiene.allow.json'), 'utf8')) as { entries: AllowlistEntry[] };
const projectsFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt-hygiene.projects.json'), 'utf8')) as { names: string[] };
const ALLOW = allowFile.entries;
const PROJECTS = projectsFile.names;
const WARN_ONLY = process.env.PROMPT_HYGIENE_WARN_ONLY === '1';

/** The tool-schema source files whose `description:` string literals the lint
 *  reads AS TEXT (importing platform-tools.ts drags the whole platform graph;
 *  the literals are what the model sees either way). */
const TOOL_SCHEMA_FILES = [
  'platform/platform-tools.ts', 'platform/control-tools.ts', 'platform/session-tools.ts', 'platform/ops-tools.ts',
  'platform/coord-tools.ts', 'platform/housekeeping-tools.ts', 'platform/fleet-ops-tools.ts', 'platform/self-service-tools.ts',
  'platform/account-tools.ts', 'platform/resource-tools.ts', 'coding/tools.ts',
];

/** Extract `description: '…'` / `description: "…"` literals (escapes honoured) with their line numbers. */
function descriptionLiterals(file: string): Array<{ source: string; text: string }> {
  const abs = path.join(__dirname, '..', file);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const out: Array<{ source: string; text: string }> = [];
  const re = /description:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[1] ?? m[2] ?? '';
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ source: `${file}:${line}`, text: raw.replace(/\\(['"\\])/g, '$1') });
  }
  return out;
}

function assertClean(findings: HygieneFinding[], label: string): void {
  if (!findings.length) return;
  const msg = `${label}: ${findings.length} prompt-hygiene finding(s)\n${formatFindings(findings)}`;
  if (WARN_ONLY) { console.warn(msg); return; }
  throw new Error(msg);
}

const PROJ = { projectName: 'Example Project', projectId: '00000000-0000-0000-0000-000000000000', fleetSupervisorChatId: '11111111-1111-1111-1111-111111111111' };

describe('prompt hygiene — the allowlist itself', () => {
  it('has no expired row and names no project', () => {
    assertClean(lintAllowlist(ALLOW, PROJECTS), 'allowlist');
  });
  it('the captured project list is non-empty and carries no generic short words', () => {
    expect(PROJECTS.length).toBeGreaterThan(0);
    for (const n of PROJECTS) expect(n.length).toBeGreaterThanOrEqual(3);
  });
});

describe('prompt hygiene — the lint detects what it must', () => {
  it('flags a project name, a ticket id, a dated rule, an owner-quote marker, a model id and an env toggle; passes clean generic text', () => {
    const dirty = [
      '- The CanLaw grant covers spend (ticket 661fb494).',
      '- NEVER re-send a wake (owner 2026-09-26): the gate parked it on 2026-09-26 at 13:02Z.',
      '- Use kimi-k3 for this seat and set INFRA_ACTIONS_ENABLED=1 first.',
    ].join('\n');
    const rules = lintPromptText({ source: 't', text: dirty, projectNames: PROJECTS }).map(f => f.rule);
    for (const r of ['project_name', 'incident_id', 'dated_rule', 'owner_quote_marker', 'model_id', 'env_toggle']) expect(rules).toContain(r);
    const clean = '- Only the owner halts, holds or pauses work, and only in the owner\'s own words (rule halt.owner-words).\n- A parked turn is a decision-gate outcome; the INFRA_ACTIONS_ENABLED switch may be named, never set.';
    expect(lintPromptText({ source: 't', text: clean, projectNames: PROJECTS })).toEqual([]);
    // the facts layer's dated HEADER is allowed, a dated bullet under it is not
    expect(lintPromptText({ source: 'facts', text: '## Harness facts as of 2026-09-27\n- DEPTH: a wake never waits.', datedHeaderAllowed: true })).toEqual([]);
    expect(lintPromptText({ source: 'facts', text: '## Harness facts as of 2026-09-27\n- since 2026-09-26 you must not.', datedHeaderAllowed: true }).map(f => f.rule)).toEqual(['dated_rule']);
    // an allowlisted token passes only while unexpired and only for its sources
    const allow: AllowlistEntry[] = [{ token: 'ticket 661fb494', reason: 'test', expires: '2999-01-01', sources: ['t'] }];
    expect(lintPromptText({ source: 't', text: 'see ticket 661fb494', allow })).toEqual([]);
    expect(lintPromptText({ source: 'other', text: 'see ticket 661fb494', allow }).length).toBe(1);
    expect(lintPromptText({ source: 't', text: 'see ticket 661fb494', allow: [{ ...allow[0], expires: '2000-01-01' }] }).length).toBe(1);
  });
});

describe('prompt hygiene — every generated GENERIC prompt is clean', () => {
  it('the composed supervisor system prompts: generic layers clean, budgets held, no cross-layer duplicate', () => {
    const fleet = buildFleetSupervisorPrompt();
    const project = buildProjectSupervisorPrompt(PROJ);
    // …and with EVERY brief cap filled: the project layer is fitted to its budget at render time, so the
    // over_budget rule holds on the worst-case brief, not only on an empty one (review fix 2026-09-27)
    const projectFull = buildProjectSupervisorPrompt({ ...PROJ, brief: maximalProjectBrief(PROJ.projectName, PROJ.projectId) });
    assertClean(lintComposedPrompt({ source: 'fleet supervisor', text: fleet, projectNames: PROJECTS, allow: ALLOW }), 'fleet supervisor prompt');
    assertClean(lintComposedPrompt({ source: 'project supervisor', text: project, projectNames: PROJECTS, allow: ALLOW }), 'project supervisor prompt');
    assertClean(lintComposedPrompt({ source: 'project supervisor (full brief)', text: projectFull, projectNames: PROJECTS, allow: ALLOW }), 'project supervisor prompt with every brief cap filled');
  });

  it('the core doctrine, the facts block (all purposes act) and the role profile, each alone', () => {
    assertClean(lintPromptText({ source: 'core', text: coreDoctrine('fleet'), layer: 'core', projectNames: PROJECTS, allow: ALLOW }), 'core (fleet)');
    assertClean(lintPromptText({ source: 'core', text: coreDoctrine('project'), layer: 'core', projectNames: PROJECTS, allow: ALLOW }), 'core (project)');
    const facts = frameworkFactsBlock({ actPurposes: ['wake_triage', 'sweep_triage', 'drain_triage', 'imessage_send', 'auto_route', 'supervisor_turn_noop', 'compute_policy', 'wake_effort'] });
    assertClean(lintPromptText({ source: 'facts', text: facts, layer: 'facts', datedHeaderAllowed: true, projectNames: PROJECTS, allow: ALLOW }), 'facts');
    assertClean(lintPromptText({ source: 'fleet supervisor#role', text: fleetSupervisorRoleProfile(), layer: 'role', projectNames: PROJECTS, allow: ALLOW }), 'fleet role profile');
  });

  it('the stored sweep bodies, the machine-wake envelopes, the hook templates', () => {
    const sources = [
      { source: 'fleet sweep', text: buildFleetSweepPrompt() },
      { source: 'project sweep', text: buildProjectSupervisorSweepPrompt(PROJ) },
      { source: 'machine-wake preamble', text: machineWakePreamble(new Date('2026-09-27T12:00:00Z')).replace(/Current time: [^\s—]+/, 'Current time: <now>') },
      { source: 'firing header (schedule)', text: machineFiringHeader('schedule') },
      { source: 'firing header (hook)', text: machineFiringHeader('hook') },
      { source: 'hook template', text: DEFAULT_PROMPT_TEMPLATE },
      { source: 'child result template', text: CHILD_RESULT_PROMPT_TEMPLATE },
    ];
    const findings = sources.flatMap(s => lintPromptText({ ...s, projectNames: PROJECTS, allow: ALLOW }));
    assertClean(findings, 'sweeps / envelopes / hook templates');
  });

  it('the chat playbook, offers and follow-ups blocks (signed-in, anonymous, machine)', () => {
    const ids = { chatId: '0f3c2a1b-1111-2222-3333-444455556666', chatTitle: 'Hygiene', projectId: '9e8d7c6b-1111-2222-3333-444455556666' };
    const sources = [
      { source: 'chat playbook (signed-in supervisor)', text: platformPlaybookBlock({ ...ids, isSupervisor: true, hasUser: true }) },
      { source: 'chat playbook (anonymous)', text: platformPlaybookBlock({ ...ids, isSupervisor: false, hasUser: false }) },
      { source: 'offers (user)', text: proactiveOffersBlock({ hasUser: true }) },
      { source: 'offers (machine)', text: proactiveOffersBlock({ hasUser: true, machine: true }) },
      { source: 'follow-ups (user)', text: followUpsInstruction({ hasUser: true }) },
      { source: 'follow-ups (anon)', text: followUpsInstruction({ hasUser: false }) },
    ];
    const findings = sources.flatMap(s => lintPromptText({ ...s, projectNames: PROJECTS, allow: ALLOW }));
    assertClean(findings, 'chat doctrine blocks');
  });

  it('the coding orchestrator guidance + every worker role prompt', () => {
    const sources = [
      { source: 'coding orchestrator', text: orchestratorRoleGuidance() },
      ...Object.values(ROLES).map(r => ({ source: `coding role ${r.role}`, text: `${r.purpose}\n${r.prompt}` })),
    ];
    const findings = sources.flatMap(s => lintPromptText({ ...s, projectNames: PROJECTS, allow: ALLOW }));
    assertClean(findings, 'coding guidance');
  });

  it('every tool description string (platform + coding schemas) keeps only the behaviour — provenance lives in code comments', () => {
    const sources = TOOL_SCHEMA_FILES.flatMap(descriptionLiterals);
    expect(sources.length).toBeGreaterThan(100);
    // A tool ARGUMENT that takes a built-in model id must enumerate the ids it
    // accepts (set_session_model / update_project / set_chat_mode) — that is a
    // value list, not doctrine; every other rule applies in full.
    const findings = sources.flatMap(s => lintPromptText({ ...s, projectNames: PROJECTS, allow: ALLOW })).filter(f => f.rule !== 'model_id');
    assertClean(findings, 'tool descriptions');
  });
});
