/**
 * Replay pin for ticket f08fcd6f — "Supervisor-wake cross-check lane has no
 * fleet read tools — freshness contract unsatisfiable".
 *
 * Adjudication (2026-09-09): the ticket's literal shape cannot fire on
 * fleet-supervisor machine wakes — the L2 cross-checker is deterministically
 * skipped on machine wakes (`!args.machineWake` gate in chat-agent.service.ts)
 * and the supervisor chat is pinned mode 'thinking'. But the SAME
 * unsatisfiable-contract shape was reachable on two live surfaces, both fixed
 * by appending crossCheckFleetScopeNote() (the ticket's suggested
 * exemption-scoping remedy):
 *
 *  (A) Supervisor chat, non-machine turns: the fleet-supervisor system context
 *      (fleet-citation mandates + the update_supervisor_state duty) rode into
 *      the checker doctrine verbatim — unsatisfiable for a lane whose
 *      cross_checker role grant (roles.ts) has no fleet/platform tools.
 *  (B) deep_research chats, machine wakes: the FRESHNESS CONTRACT baked into
 *      the wake payload reached council colleagues (cross_checker role,
 *      web-only tools) with no exemption — the council lane has no machineWake
 *      gate. (The L2 checker was also skipped on machine wakes at filing time;
 *      since the 2026-09-26 compute-policy gate it can be ADDED behind a
 *      machine wake's answer by a gate act — the gateSpawnedOnMachine
 *      carve-out — which is why the 2026-10-03 FS steer aligned the L2
 *      exemption gate to `isSupervisorChat || args.machineWake`, the same
 *      flag the preamble keys on: pin (E) below.)
 *
 * The wiring pins below are source assertions (the service's doctrine builders
 * are not exported and its import graph is heavy — the repo's readFileSync
 * test idiom): they FAIL on the pre-fix service and PASS with the fix, i.e.
 * they replay the mishap's enabling condition.
 */

// presetPlan comes from the real gate module (Module A), whose import graph reaches logger → env; mock the leaves as Module A's suites do.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate', COMPUTE_POLICY: 'compute_policy', UX_TTFT: 'ux_ttft' },
  recordLoopMetric: jest.fn(),
}));
jest.mock('../platform/supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));
import { readFileSync } from 'fs';
import { join } from 'path';
import { crossCheckPlatformScopeRule, crossCheckFleetScopeNote, crossCheckVerifySilenceRule } from './cross-check-scope';
import { shouldSpawnChecker } from './compute-policy-wiring';
import { presetPlan } from '../platform/compute-policy-gate';

const SERVICE_SOURCE = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');

describe('crossCheckFleetScopeNote — exemption content (ticket f08fcd6f)', () => {
  const note = crossCheckFleetScopeNote();

  it('declares the lane has NO fleet tools, naming them', () => {
    expect(note).toContain('NO fleet tools');
    for (const tool of ['list_chats', 'get_chat_messages', 'get_chat_status', 'goal_list', 'todo_list', 'schedule_get', 'save_supervisor_state']) { // model-facing spelling (coding/tool-scope.ts, 2026-09-22)
      expect(note).toContain(tool);
    }
  });

  it('scopes fleet-contract text as addressed to the MAIN lane, not the checker', () => {
    expect(note).toContain('addressed to the MAIN lane');
    expect(note).toContain('Do NOT attempt fleet tool calls');
    expect(note).toContain('Do NOT report fleet state as freshly verified');
  });

  it('replaces fresh-verification with payload-derived citation for fleet state', () => {
    expect(note).toContain('payload-derived');
    expect(note).toContain('UNVERIFIED-by-lane');
  });

  it('cites the ticket for traceability', () => {
    expect(note).toContain('f08fcd6f');
  });
});

describe('lane wiring — the exemption reaches both affected cross_checker lanes (ticket f08fcd6f)', () => {
  it('(A) checker doctrine appends the exemption on supervisor-chat turns AND on machine wakes (FS steer 2026-10-03: gate aligned to the preamble)', () => {
    // The checker doctrine template ends with ctx.systemContext; the exemption
    // is appended when the chat is the fleet supervisor (isSupervisorChat) OR
    // the run is a machine wake (args.machineWake) — the SAME flag the
    // FRESHNESS CONTRACT preamble keys on (chat-agent.service.ts :657). The
    // original PR #646 gate keyed on isSupervisorChat alone, which was correct
    // for every default path (a machine wake never spawns an L2 checker before
    // the 2026-09-22 skip + the machine preset), but left a latent seam: under
    // the stacked non-default flags (COMPUTE_POLICY_MACHINE_ACT_ENABLED=1
    // letting a gate-act plan add a checker behind a machine wake's answer), a
    // NON-supervisor machine-wake checker would receive the freshness
    // contract's "pull everything fresh via tools THIS run" mandate with NO
    // exemption — the exact unsatisfiable-contract shape f08fcd6f closed.
    expect(SERVICE_SOURCE).toContain("${ctx.systemContext}${(isSupervisorChat || args.machineWake) ? `\\n\\n${crossCheckFleetScopeNote()}` : ''}");
  });

  it('(B) council colleague doctrine accepts and appends the exemption on machine wakes', () => {
    expect(SERVICE_SOURCE).toContain('machineWake?: boolean');
    expect(SERVICE_SOURCE).toContain("${args.imageBlock}${args.machineWake ? `\\n\\n${crossCheckFleetScopeNote()}` : ''}");
    // … and the colleague launch threads the run's machineWake flag through.
    expect(SERVICE_SOURCE).toContain('machineWake: args.machineWake');
  });

  it('(E) the L2 exemption gate keys on the SAME flag the freshness preamble keys on (FS steer 2026-10-03)', () => {
    // The seam this closes: machineWakePreamble (:657) prepends the FRESHNESS
    // CONTRACT ("pull everything fresh via tools THIS run") to args.message
    // whenever args.machineWake — and ctx.queryMessage (what the L2 checker
    // receives as its userMessage) derives from that post-preamble message.
    // The exemption must therefore key on args.machineWake too, else a
    // gate-act checker on a non-supervisor machine wake (COMPUTE_POLICY_
    // MACHINE_ACT_ENABLED=1 — default off) gets the contract with no
    // exemption. This pin ties the two call-site shapes together so changing
    // one gate without the other fails here.
    expect(SERVICE_SOURCE).toContain('machineWakePreamble() + (supervisorStateBlock ? `\\n${supervisorStateBlock}\\n` : \'\') + args.message');
    expect(SERVICE_SOURCE).toContain('const queryMessage = args.documentText');
    // … and the L2 checker's userMessage is that same post-preamble query —
    // the contract demonstrably rides into the checker lane.
    expect(SERVICE_SOURCE).toContain('userMessage: queryMessage');
  });

  it('imports the leaf module', () => {
    // Combined import — ce9ee48d added crossCheckArtifactGroundingRule,
    // 31738d9a added crossCheckLaneClockNote, 2026-09-25 added crossCheckPlatformScopeRule,
    // the cohesive-chat doctrine (2026-09-28) added crossCheckVerifySilenceRule.
    expect(SERVICE_SOURCE).toContain("import { crossCheckArtifactGroundingRule, crossCheckFleetScopeNote, crossCheckLaneClockNote, crossCheckPlatformScopeRule, crossCheckVerifySilenceRule } from './cross-check-scope';");
  });

  it('(D) verify-silence rule is injected on EVERY checker turn, after the platform-scope rule (rule evidence.verify-silent, cohesive-chat doctrine)', () => {
    expect(SERVICE_SOURCE).toContain('${crossCheckPlatformScopeRule()}\\n\\n${crossCheckVerifySilenceRule()}');
    const rule = crossCheckVerifySilenceRule();
    expect(rule).toMatch(/could NOT fetch the same evidence/);
    expect(rule).toMatch(/stay SILENT on that finding/);
    expect(rule).toMatch(/never contradict a receipt/);
    expect(rule).toMatch(/"Could not verify" is a valid verdict/);
    // hygiene: no dates, ticket ids or model names in the rule text
    expect(rule).not.toMatch(/\b20\d\d-\d\d-\d\d\b|ticket [0-9a-f]{8}/);
  });

  it('(C) platform-scope rule is injected on EVERY checker turn (false-gap ticket cbe682c0, 2026-09-25)', () => {
    expect(SERVICE_SOURCE).toContain('${crossCheckArtifactGroundingRule()}\\n\\n${crossCheckPlatformScopeRule()}');
    const rule = crossCheckPlatformScopeRule();
    expect(rule).toMatch(/belong to the MAIN assistant/);
    expect(rule).toMatch(/NEVER report a Digby capability as missing/);
    expect(rule).toMatch(/never web-search digby\.ai/);
    expect(rule).toMatch(/file_feedback is ONLY for a harness malfunction/);
  });

  it('leaves the machine-turn L2-checker skip gate intact (no regression of the skip)', () => {
    // The adjudicated-correct gate: machine turns skip the L2 cross-checker —
    // since 2026-09-22 (owner) every machine ORIGIN, not only schedule/webhook
    // firings: machineTurnSkipsChecker covers machineWake + hook/agent origins.
    // Compute policy (2026-09-26): the spawn decision moved from the inline
    // `mode === 'thinking' && !machineTurnSkipsChecker && !checkerSeatProblem`
    // test into the pure shouldSpawnChecker({ plan, machineTurnSkipsChecker, … })
    // and the run spawns on `if (spawnChecker)` — the machine flag still forbids.
    // Owner 2026-09-26 ("default all chats to auto even supervisors"): the ONE
    // carve-out is a checker the compute-policy gate ACTED to add on a machine
    // wake (machineGateSpawnsChecker — source 'gate_act' only, post machine
    // rails; it runs BEHIND the answer, never waited on). A preset / shadow
    // plan on a machine turn still never spawns.
    expect(SERVICE_SOURCE).toContain('shouldSpawnChecker({ plan, machineTurnSkipsChecker: machineTurnSkipsChecker && !gateSpawnedOnMachine, checkerSeatProblem: null, isCouncil: isCouncilMode, ghost: ghostSingleModel })');
    expect(SERVICE_SOURCE).toContain('const gateSpawnedOnMachine = machineGateSpawnsChecker(plan, usesMachineRails);');
    expect(SERVICE_SOURCE).toContain('const usesMachineRails = runIsMachineTriggered && machineTurnSkipsChecker;');
    expect(SERVICE_SOURCE).toContain('const spawnChecker = wantsChecker && !checkerSeatProblem;');
    expect(SERVICE_SOURCE).toContain('if (spawnChecker) {');
    expect(SERVICE_SOURCE).toContain("(args.machineWake === true || (args.messageOrigin != null && args.messageOrigin !== 'user'))");
    expect(shouldSpawnChecker({ plan: presetPlan('thinking'), machineTurnSkipsChecker: true, checkerSeatProblem: null, isCouncil: false })).toBe(false);
    expect(shouldSpawnChecker({ plan: presetPlan('thinking'), machineTurnSkipsChecker: false, checkerSeatProblem: null, isCouncil: false })).toBe(true);
  });
});
