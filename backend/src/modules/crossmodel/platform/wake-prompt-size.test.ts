/**
 * WAKE-PROMPT SIZE BENCH + RE-BLOAT GUARDRAIL (R&D stream 3, test-bench
 * experiment #1, 2026-09-18).
 *
 * Composition-side measurement of the machine-wake boilerplate every
 * machine-triggered run pays for: the plain-chat preamble
 * (chat-agent/machine-wake.ts machineWakePreamble — prepended at
 * chat-agent.service.ts runChat), the coding-lane firing header
 * (machineFiringHeader), and the two recurring sweep prompts
 * (buildFleetSweepPrompt / buildProjectSupervisorSweepPrompt).
 *
 * Two jobs:
 *  1. BENCH — print the composed size of each wake type (chars + cl100k
 *     tokens) so before/after experiments have a reproducible ruler. Tokens
 *     use js-tiktoken cl100k_base as a REFERENCE tokenizer (the served models
 *     — glm-5.3 / deepseek-flash / kimi-k3 — use different BPEs; the
 *     before/after DELTA is the meaningful figure and is tokenizer-insensitive
 *     to first order). If js-tiktoken is absent the bench still runs,
 *     reporting tokens as n/a — char budgets below never depend on it.
 *  2. GUARDRAIL — assert char budgets (the 2026-09-18 slim baseline + ~12%
 *     headroom) so a future re-bloat is a CI failure, and pin the
 *     load-bearing markers that slimming must never lose (the harness
 *     classifier keys on them: supervisor.service classifySupervisorNote).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  emitScheduleDisabled: jest.fn(async () => undefined),
}));

import { machineWakePreamble, machineFiringHeader } from '../chat-agent/machine-wake';
import { buildFleetSupervisorPrompt, buildFleetSweepPrompt } from './supervisor.service';
import { buildProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } from './project-supervisor.service';
import { rebuildSweepPromptDoctrine } from './sweep-doctrine-rebuild';
import { CORE_STANDING_DIRECTIVES, corePrecedenceRule, CORE_SCOPE_RULE } from './core-doctrine';

/** Reference tokenizer — optional (transitive dep); tokens reported, never asserted. */
function cl100kTokens(text: string): number | null {
  try {
    const { getEncoding } = require('js-tiktoken');
    const enc = getEncoding('cl100k_base');
    return enc.encode(text).length;
  } catch {
    return null;
  }
}

const NOW = new Date('2026-09-18T12:00:00.000Z');

/** The composed wake types, exactly as a firing assembles them (preamble + stored prompt). */
function composedWakeTypes(): Array<{ name: string; text: string }> {
  const preamble = machineWakePreamble(NOW);
  const fleetSlim = buildFleetSweepPrompt();
  const projectSlim = buildProjectSupervisorSweepPrompt({ projectName: 'crossmodel', projectId: 'proj_bench000', fleetSupervisorChatId: 'chat_fleet000' });
  return [
    { name: 'machine-wake preamble (plain-chat schedule/hook envelope)', text: preamble },
    { name: 'coding-lane firing header (schedule)', text: machineFiringHeader('schedule') },
    { name: 'coding-lane firing header (hook)', text: machineFiringHeader('hook') },
    { name: 'fleet sweep stored prompt (buildFleetSweepPrompt)', text: fleetSlim },
    {
      name: 'project sweep stored prompt (buildProjectSupervisorSweepPrompt)',
      text: projectSlim,
    },
    { name: 'fleet sweep FIRING (preamble + stored prompt)', text: preamble + fleetSlim },
    {
      name: 'project sweep FIRING (preamble + stored prompt)',
      text: preamble + projectSlim,
    },
    // Experiment #2 fallback path: when the lane's system prompt LACKS the
    // doctrine the fire-time rebuild inlines it into the firing message —
    // never cheaper than the pre-dedup shape, never doctrine-less. Budgets
    // pin it to ≤ pre-dedup firing size + ~5%.
    {
      name: 'fleet sweep FIRING — doctrine rebuilt inline (fallback)',
      text: preamble + rebuildSweepPromptDoctrine({ prompt: fleetSlim, systemPrompt: null }).prompt,
    },
    {
      name: 'project sweep FIRING — doctrine rebuilt inline (fallback)',
      text: preamble + rebuildSweepPromptDoctrine({ prompt: projectSlim, systemPrompt: null }).prompt,
    },
  ];
}

describe('wake-prompt size bench (R&D stream 3 experiment #1)', () => {
  it('prints the composed size of every wake type (chars + cl100k reference tokens)', () => {
    const rows = composedWakeTypes().map(({ name, text }) => {
      const tokens = cl100kTokens(text);
      return `| ${name} | ${text.length} | ${tokens === null ? 'n/a' : tokens} |`;
    });
    // Informational: the supervisor SYSTEM prompts (unchanged by the slim) —
    // the context the firing message lands in, so the cut can be read as a
    // share of the wake's composed input. No budget: context, not boilerplate.
    const context = [
      ['fleet supervisor system prompt (context, unchanged)', buildFleetSupervisorPrompt()],
      [
        'project supervisor system prompt (context, unchanged)',
        buildProjectSupervisorPrompt({ projectName: 'crossmodel', projectId: 'proj_bench000', fleetSupervisorChatId: 'chat_fleet000' }),
      ],
    ].map(([name, text]) => {
      const tokens = cl100kTokens(text as string);
      return `| ${name} | ${(text as string).length} | ${tokens === null ? 'n/a' : tokens} |`;
    });
    // Informational: the standing-doctrine blocks — embedded VERBATIM in the
    // lanes' system prompts, and (pre experiment #2) duplicated into the sweep
    // stored prompts. Experiment #2 removed them from the firing message;
    // these sizes are the share that was reclaimed per sweep firing.
    const doctrine = [
      ['CORE_STANDING_DIRECTIVES', CORE_STANDING_DIRECTIVES],
      ['corePrecedenceRule(fleet)', corePrecedenceRule('fleet')],
      ['corePrecedenceRule(project)', corePrecedenceRule('project')],
      ['CORE_SCOPE_RULE', CORE_SCOPE_RULE],
    ].map(([name, text]) => {
      const tokens = cl100kTokens(text as string);
      return `| doctrine block: ${name} | ${(text as string).length} | ${tokens === null ? 'n/a' : tokens} |`;
    });
    console.log(`\n| wake type | chars | cl100k tokens |\n|---|---:|---:|\n${rows.join('\n')}\n${context.join('\n')}\n${doctrine.join('\n')}\n`);
    expect(rows.length).toBe(9);
  });

  it('stays under the post-slim char budgets (re-bloat guardrail — every budget sits BELOW its line\'s pre-slim size)', () => {
    // INVARIANT (adversarial review B1, 2026-09-18): each budget is below the
    // line's PRE-SLIM size, so reverting ANY one component's slim is a CI
    // failure; headroom over the post-slim baseline is +2-8%. A deliberate
    // prompt addition trips the budget and bumps it here, with justification,
    // in the same PR — that trip IS the guardrail working.
    // Experiment #1 baselines (2026-09-18): preamble 8304 · headers 1858/1852.
    // Experiment #2 baselines (2026-09-18, doctrine dedup): fleet stored 9167 ·
    // project stored 10519 · fleet firing 14655 · project firing 16007 — the
    // four sweep budgets below sit UNDER those, so a doctrine re-inline revert
    // trips the guardrail. Post-#2 actuals: 4310 / 4270 / 9798 / 9758.
    // Fallback rows (doctrine rebuilt inline at fire time) are pinned to
    // pre-dedup firing actual + ~5%: never cheaper than the old shape, never
    // doctrine-less.
    // 2026-09-26 (framework-awareness pass): +~470 chars on the preamble —
    // rule 9 (PARKED / SKIPPED TURNS ARE BY DESIGN: the decision gate acts in
    // prod for wake_triage / sweep_triage / drain_triage, and a staged call's
    // ok:false {staged, confirmationId} receipt is not evidence) — and +~340
    // chars per sweep prompt (step 5: DECISION-GATE PARKS ARE NOT STALLS).
    // Deliberate additions (AGENTS.md 2026-09-26 "decision gate — first
    // flips"); budgets = actual +4% (preamble 6082; sweeps 5036 / 5011;
    // firings 11118 / 11093; fallbacks 16441 / 17805). Every budget still sits
    // BELOW its line's pre-slim size (8304 / 9167 / 10519 / 14655 / 16007) for
    // the non-fallback rows, so the re-bloat invariant holds.
    const budgets: Record<string, number> = {
      'machine-wake preamble (plain-chat schedule/hook envelope)': 6372,
      // 2026-10-12 (ticket 6d7b379f): +~73 chars per coding-lane header — the
      // CLAIM BAR's fenced-claims type list gains the finish_run vocabulary
      // (commit, schedule_armed, email_sent, state_update) so models calling
      // finish_run as their last tool call stop emitting its type names into a
      // fence that rejected them (live incident: lane b92ef13f firing 22).
      // Deliberate doctrine addition; budgets = actual (1980/1974) +4%.
      // 2026-10-27 (ticket ed728b87): +~287 chars per coding-lane header — the
      // CLAIM BAR's claims-fence contract gains finish_run's scope vocabulary
      // ("scope":"session"/"relayed" — cross-run claims verify against the
      // chat's recent receipt history instead of being struck) so multi-firing
      // lanes stop eating UNVERIFIED strikes for honest earlier-run work
      // (live incident: Schooltime lane 19dd22bc, runs 17353fe8/13dfa651).
      // Deliberate doctrine addition; budgets = actual (2267/2261) +4%.
      'coding-lane firing header (schedule)': 2358,
      'coding-lane firing header (hook)': 2352,
      // 2026-09-25 (operator iteration 14): +~80 chars per sweep prompt — the
      // RECONCILE step now names get_run_receipts / get_session_diff / resolve_id
      // and the STALE-GATE step names cancel_confirmation / dismiss_owner_question
      // (22 audit tools had zero calls after 22 h while every tool with a
      // doctrine row was adopted). Deliberate addition; budgets = actual +4%.
      // 2026-09-25 (WI-B doctrine rows): +114 chars per sweep prompt — step 2
      // names get_supervisor_state (the full durable doc behind the 6000-char
      // [SUPERVISOR STATE] block) and step 5 names schedule_get (read a
      // cadence's STORED prompt when its firings look wrong). Deliberate
      // addition; budgets = actual (4697 / 4672 / 10183 / 10158) +4%.
      // 2026-09-26: +~340 per sweep prompt (step 5 DECISION-GATE PARKS ARE NOT
      // STALLS) — see the dated note above; budgets = actual +4%.
      // 2026-09-27 (tt-rd audit, self-audit churn): +255 chars on the PROJECT
      // sweep prompt only — the DIFF step names the AUDIT CHURN rule (an
      // audit-only firing is a no-op; steer the lane, never escalate). The
      // fleet sweep body is unchanged (the fleet rule rides its SYSTEM prompt
      // §Wake economy). Fixer 2026-09-27: +~70 chars on the same DIFF step (the
      // cadence clause is scoped to MACHINE-armed rows; an owner-armed cadence
      // is reported UP, never edited).
      // 2026-09-27 (wake-cadence, tt-rd audit): +~330 chars fleet / +~375
      // project per sweep prompt — step 5 gains CADENCE vs RUN LENGTH (a cadence
      // shorter than the run is a collision; the harness stretches it), the
      // sweep-backoff sentence and "maxRuns is a runaway bound, not a lifespan";
      // the project sweep's steps 6/7 say a report-up is not an action.
      // 2026-09-27 (tt-rd audit fixer "upward-chatter-directives"): +222 chars
      // on the PROJECT sweep prompt — step 6 (ACT, lanes are the audience) split
      // from 6b (ONLY IF a goal state change or an ask exists, ONE Fleet
      // Supervisor message; a report-up is not an action for step 7). 259 of
      // the tt-rd supervisor's 310 sends went UP; the split is the fix.
      // 2026-09-27 (tt-rd audit, docs-churn-log-3): +~95 chars per sweep prompt —
      // step 2's "cite the artifact" clause now says a docs-only PR is a record,
      // not movement (cite the NUMBER that moved).
      // 2026-09-27 (sup/integration merge of the six tt-rd audit branches):
      // the additions above compose — budgets = the merged actuals +4%
      // (fleet stored 5636 / project stored 6329 / fleet firing 11770 /
      // project firing 12463, measured on the integration branch), all still
      // BELOW the pre-slim sizes (9167 / 10519 / 14655 / 16007), so the
      // re-bloat invariant holds.
      // 2026-09-27 (sup/integration merged ONTO the layered prompts,
      // prompts/layered-brief): the stored sweep bodies are the LAYERED ones
      // (halt / gate-outcome rules cited by id, incidents in the legacy
      // bodies only), carrying the tt-rd additions stated generically —
      // steps 2 / 5 / 6 / 6b / 7 project, steps 2 / 5 fleet. Every row
      // re-measured on the merged tree and pinned at actual +4% (preamble
      // 6126; headers 1833 / 1827; fleet stored 5546 / project stored 6271 /
      // fleet firing 11672 / project firing 12397; fallbacks 17289 / 18968).
      // Every non-fallback row still sits BELOW its pre-slim size
      // (8304 / 9167 / 10519 / 14655 / 16007) — the re-bloat invariant holds.
      'fleet sweep stored prompt (buildFleetSweepPrompt)': 5768,
      'project sweep stored prompt (buildProjectSupervisorSweepPrompt)': 6522,
      'fleet sweep FIRING (preamble + stored prompt)': 12139,
      'project sweep FIRING (preamble + stored prompt)': 12893,
      // 2026-09-18 evening: +~400 chars — the OWNER-WAIT VOCABULARY bullet in
      // STANDING_OWNER_DIRECTIVE_HEADER (owner: "chats say waiting for my
      // response but my inbox is empty"; 192 unbacked owner-wait lines in one
      // supervisor chat in 24 h). Deliberate doctrine addition, sized so the
      // whole doctrine still ends inside the 7000-char compaction-safe head
      // (sweep-doctrine-rebuild.test.ts POST-COMPACTION); these two rows carry
      // the header inline, so their budgets move with it (~+4.5% over the new
      // actuals ≈15130 / 16495).
      // 2026-09-25 (WI-B): +114 per sweep prompt rides these too (actuals 15506 / 16870; +~3.5%).
      // 2026-09-26: the preamble + sweep additions ride these too (actuals
      // 16441 / 17805; +4%). The fallback contract is unchanged — never cheaper
      // than the pre-dedup shape, never doctrine-less — these are upper bounds.
      // 2026-09-27 (sup/integration): the composed tt-rd sweep additions ride
      // both fallback rows, and the misfiled-spawns FILE A SPAWN WHERE ITS
      // REPO IS bullet (STANDING_OWNER_DIRECTIVE_HEADER, +~440 chars) rides
      // the inline-rebuilt doctrine (actuals 17533 / 19175; +4%). Upper
      // bounds only.
      'fleet sweep FIRING — doctrine rebuilt inline (fallback)': 17981,
      'project sweep FIRING — doctrine rebuilt inline (fallback)': 19727,
    };
    for (const { name, text } of composedWakeTypes()) {
      if (!(name in budgets)) throw new Error(`wake-prompt bench row "${name}" has no budget — a renamed/added row must register one (review L2)`);
      if (text.length > budgets[name]) {
        throw new Error(`wake-prompt re-bloat: "${name}" is ${text.length} chars (budget ${budgets[name]}, pre-slim size was higher)`);
      }
    }
  });

  it('keeps every load-bearing marker + taught vocabulary verbatim (slimming must never lose these)', () => {
    const preamble = machineWakePreamble(NOW);
    // Clock-discipline taught label vocabulary (action-verifier exempts EXACTLY
    // this vocabulary — the drift guard above runs the preamble through the
    // detector; teaching different words would convict honest notes).
    for (const label of ['next fire', 'ETA ~', 'future']) expect(preamble).toContain(label);
    // Evidence-rule escape hatch (owner doctrine 2026-09-04) + harness surfaces.
    expect(preamble).toContain('(id not captured)');
    expect(preamble).toContain('UNVERIFIED');
    expect(preamble).toContain('[HARNESS CLOCK]');
    expect(preamble).toContain('PLANNED — NOT EXECUTED');

    const firing = machineFiringHeader('schedule');
    expect(firing.startsWith('[MACHINE-TRIGGERED RUN')).toBe(true); // UI classifier WAKE_PREFIX
    expect(firing).toContain('CLAIM BAR');

    const fleet = buildFleetSweepPrompt();
    expect(fleet.startsWith('Fleet Supervisor sweep')).toBe(true); // SWEEP_PROMPT_OPENER heal key
    expect(fleet).toContain('SWEEP: no-op — nothing moved on any project since last sweep');
    expect(fleet).toContain('ACTIONS TAKEN');

    const project = buildProjectSupervisorSweepPrompt({ projectName: 'crossmodel', projectId: 'p', fleetSupervisorChatId: null });
    expect(project.startsWith('Project Supervisor sweep')).toBe(true); // PROJECT_SWEEP_PROMPT_OPENER heal key
    expect(project).toContain('SWEEP: no-op — nothing moved in crossmodel since last sweep');
    expect(project).toContain('ACTIONS TAKEN');
  });
});
