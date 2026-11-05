/**
 * REPLAY TEST — ticket 2201d3d6 (mishap, 2026-10-15): "5× success-side
 * wrong-tool loop: read_file on 'Repo-side: adapt litellm config + releas'
 * — framework or model?" Auto-filed at the breaker trip 2026-10-15T20:52:33Z
 * (owner doctrine 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 26be18cc-2b9c-489c-98bb-eb727dbb9252 — the
 * "Repo-side: adapt litellm config + release · Audit main's config + deploy
 * path" lane in the LiteLLM project; run 4dbde611-6ffb-4ceb-92e1-29321d09a6ee,
 * glm-5.3 on the zai seat, coding profile, MACHINE-triggered, spawned from
 * the report-up supervisor). The trip rode a DELEGATE WORKER: subagent_start
 * seq 34 (role explorer, model glm-5.3, "Audit main deploy path + env
 * inventory", background handle bg1-o988) running the delegate brief for the
 * litellm gateway re-target audit.
 *
 * THE STREAK IS ONE WORKER MESSAGE OF SIX read_file CALLS (agent_events,
 * recovered by probes scripts/framework-audit/probe-2201d3d6{,-b}.js on box A
 * via prodq, 2026-10-15 ~21:0xZ; the run itself is still 'running' — the
 * worker COMPLETED its report cleanly, subagent_end seq 243 status done):
 *   · text@69 "50 distinct model_names confirmed (67 model_list entries —
 *     multi-leg groups collapse). Now the deploy path files and systemd
 *     units." — the FAITHFUL content channel, grep-free;
 *   · SIX read_file calls, seq 70,72,74,76,78,80, all dispatched inside
 *     ~45 ms (20:52:33.322→.367): systemd/litellm-gateway.service,
 *     systemd/20-rotator-keys.conf.example,
 *     systemd/10-database-url.conf.example, docker-compose.yml,
 *     systemd/gateway-health-monitor.service,
 *     systemd/gateway-health-monitor.timer — every call a CORRECT audit
 *     read (the deploy-path files the brief asked for) and every one
 *     SUCCEEDED. The ticket's "×5" = the count at the trip; the 6th was
 *     counted and executed (no second trip — the withheldTool gate);
 *   · the ticket's recentArgs (newest-3) are the 5th/6th/4th calls of this
 *     ONE message — the 2547b652 lesson (recentArgs newest-3 + recurring
 *     markers make one batch look like many turns) applied and rejected:
 *     the whole run holds exactly TWO guard_strike rows for the trip
 *     (tool_derail_reanchor 20:52:33.420Z, tool_derail_break 20:52:38.786Z,
 *     5.4 s apart, both out of the ONE message).
 *
 * ADJUDICATION (this lane, 2026-10-15, evidence-led, prod-DB probes
 * probe-2201d3d6{,-b}.js + the committed elimination probe -d): MODEL-SIDE —
 * no deterministic framework/schema/preflight/guard defect caused the streak.
 * 1. ELIMINATION (probe-2201d3d6-d.js, run against the DEPLOYED dist code
 *    on box A): the persisted channels of the convicted message return
 *    intended=null from detectIntendedToolChannels — the content channel is
 *    faithful (names neither grep nor a decision sentence for it), and ZERO
 *    subagent:reasoning events exist in the whole run (live reasoning is
 *    unpersisted for the zai/glm-5.3 provider by design). The conviction
 *    therefore rode the LIVE reasoning channel: the worker narrated a
 *    planned grep sweep ("grep the deploy-path files for AWS assumptions")
 *    while correctly emitting the six read_file audit reads. Positive
 *    controls on the same deployed detector DO convict (a grep-naming final
 *    sentence appended to the same content → intended:"grep"; the same
 *    sentence on the reasoning channel → intended:"grep") and the
 *    022eb482 filename-glue control does NOT convict — the deployed guard
 *    is live, correct, and was NOT the cause.
 * 2. The guard stack behaved per design at every rung: message-scoped
 *    detector input (turn.reasoning + turnText, agent.ts success-side leg)
 *    means all six calls share ONE narration and count 1..6 inside the one
 *    message — steer armed at the 3rd (guard_marker seq 82
 *    "[HARNESS] Re-anchor steer injected: wrong-tool signature on read_file
 *    (reasoning named grep)", 20:52:33.422Z), trip at the 5th
 *    (tool_derail_break shape success_intent, perma:false, churned:false,
 *    intended grep, 20:52:38.786Z), the 6th still executed, one-round
 *    withhold only, no perma, no run-end. read_file is a CODING-scope tool
 *    so the 0625bf62 platform-tool discount correctly never applied; the
 *    batch-sibling acquittal correctly never fired (grep was not in the
 *    batch); the steer told the TRUTH about the SUCCESS shape.
 * 3. THE CONTAINMENT WORKED — the recovery is textbook (the 267ea7b6
 *    shape): the very next worker turn said "Understood — re-issuing the
 *    AWS-assumption sweep with grep directly" and CALLED grep three times
 *    (seq 86,88,90), then "grep worked. Now the monitor script, CI
 *    workflow, and remaining deploy-path files." and continued the audit to
 *    completion — 14 more read_file calls, 11 more grep calls, a full
 *    route/env/deploy-path inventory report, subagent_end status done
 *    (20:57:15Z). The parent run kept going on top of it.
 * 4. THE NEW FAMILY AXIS: this is the first MODEL-SIDE success-side
 *    wrong-tool instance inside a DELEGATE WORKER stream (the
 *    'subagent:'-prefixed event path — agent.ts workerOpts eventPrefix
 *    'subagent:', role explorer via runChatWorker/agentLoop). Reviewer
 *    finding 1 (this ticket): worker-stream trips are not new per se —
 *    f6217896 (2026-09-24, success-side, explorer subagent) and e0d5b63d
 *    (worker stream, failure-side) predate it — but f6217896 was
 *    adjudicated a FRAMEWORK defect (the batch-sibling acquittal gap) and
 *    e0d5b63d is the failure side; no prior pin replays through
 *    runChatWorker. The guard stack covers worker loops exactly as
 *    orchestrator loops (same agentLoop, same detector, same ladder —
 *    pinned below by REPLAYING THROUGH runChatWorker(role 'explorer')),
 *    and the wild instance proves the containment recovers a WORKER
 *    mid-report without losing the audit. Model/trigger axes are NOT new:
 *    glm-5.3 (the 4994e2f1 stable+loud quadrant) and machine-triggered.
 *    Named intent STABLE at grep the whole way (churned:false).
 * No detector change rides this ticket (per the detector-change rule; the
 * 267ea7b6 pin owns the rejected per-(batch,tool) dedup defense and the
 * 8da24785 pin owns per-call counting over turn-scoped narration).
 *
 * THIS PIN replays the incident's exact shape through the REAL WORKER path
 * (runChatWorker, role 'explorer' — the role's toolset carries both
 * read_file and grep, ROLE_TOOLS explorer) and asserts: the narration
 * convicts read_file of intending grep while the content channel convicts
 * nothing; steer at the third cumulative read_file mismatch (churned:false),
 * trip at the fifth — both out of the ONE batch; the trip metric carries
 * the incident's exact meta; the one-round withhold holds (no perma, no
 * run-end); and the modeled recovery turn (grep calls after the ban round,
 * per the wild seq 86-90 recovery) confirms the worker CONTINUES cleanly to
 * its final report. A counting negative pins that an ALIGNED earlier batch
 * (read_file naming read_file) never feeds the streak.
 *
 * Scaffold mirrors agent-derail-break.267ea7b6.test.ts (every mismatched
 * call SUCCEEDS; the narration names exactly ONE offered tool as a whole
 * word and never the called read_file — an unoffered named tool makes
 * detectIntendedTool return null and silently resets the streak, the
 * c737d007 test-writing gotcha; args vary so repeat-signature legs stay
 * blind; no run_command call ever appears).
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({
  __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, _args: any) => 'probe result: ok');
jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: jest.fn().mockImplementation(() => ({
      getOrExecute: (...a: any[]) => mockToolCacheExec(...a),
    })),
  };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', TOOL_BATCH_CAP: 'tool_batch_cap' },
}));

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runChatWorker } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { detectIntendedTool, intentMismatchDiscount } from './tool-preflight';
import { ROLES, toolsForRole } from './roles';

/** CODING profile (no workspace container in the scaffold) — the delegate
 *  worker runs the same CODING_TEST_PROFILE shape as the family pins. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident's worker brief head: an audit brief (no box access, no
 *  writes) — naming NOTHING the guard could misread as ordering the called
 *  read_file. The grep intent in the convicted message was the WORKER's own
 *  live-reasoning plan, not a preamble artifact (the probe-d control:
 *  the same brief + faithful content acquits on persisted channels). */
const BRIEF = 'Audit the MAIN branch of the gateway repo: count the distinct routes that will appear in /v1/models, enumerate the complete env var NAMES the gateway needs at runtime, and inventory every AWS assumption in the deploy path. Do NOT modify anything. Report with file:line evidence.';

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-2201d3d6-test',
  sessionId: 'sess-2201d3d6',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test worker.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The incident narration (live reasoning channel only — unpersisted for
 *  zai/glm-5.3): the worker planned a grep sweep of the deploy-path files
 *  while correctly emitting read_file audit reads. It names exactly ONE
 *  offered tool as a whole word and NEVER the called read_file; the named
 *  intent is STABLE at grep (churned:false, the 4994e2f1 stable+loud
 *  glm-5.3 quadrant, now in a worker stream). */
const P_BATCH = 'Route inventory is settled, so next I will grep the deploy-path files for every AWS assumption before writing the report.';
/** The FAITHFUL content channel the wild message carried (text@69) — never
 *  the called tool, never a decision sentence for it (probe-d: the deployed
 *  detector returns intended=null on the persisted channels). */
const C_BATCH = '50 distinct model_names confirmed (67 model_list entries — multi-leg groups collapse). Now the deploy path files and systemd units.';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const AUDIT_READS: string[] = [
  'systemd/litellm-gateway.service',
  'systemd/20-rotator-keys.conf.example',
  'systemd/10-database-url.conf.example',
  'docker-compose.yml',
  'systemd/gateway-health-monitor.service',
  'systemd/gateway-health-monitor.timer',
];
const readCall = (n: number) => {
  const path = AUDIT_READS[(n - 1) % AUDIT_READS.length];
  const suffix = n > AUDIT_READS.length ? `-${WORDS[(n - 1) % WORDS.length]}` : '';
  return {
    id: `t${n}`,
    name: 'read_file',
    arguments: JSON.stringify({ path: `${path}${suffix}` }),
  };
};

/** THE INCIDENT SHAPE: ALL SIX mismatched read_file calls in ONE worker
 *  batch (the wild guard_strike rows landed 20:52:33.420Z → 20:52:38.786Z,
 *  agent_events seq 70→80), under one stable grep-naming narration with a
 *  FAITHFUL content channel. Steer (3) and trip (5) both fire out of this
 *  single batch — BY DESIGN (the 8da24785 pin owns that assertion; the
 *  267ea7b6 pin owns the rejected per-(batch,tool) dedup defense). */
const readMissBatch = {
  content: C_BATCH,
  reasoning: P_BATCH,
  toolCalls: Array.from({ length: 6 }, (_, i) => readCall(i + 1)),
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild worker's post-steer behavior, seq
 *  85-90): acknowledges the re-anchor, then calls grep — the grounded next
 *  action — three times, exactly as the wild lane did. */
const recoveryGrepTurn = {
  content: 'Understood — re-issuing the AWS-assumption sweep with grep directly.',
  reasoning: 'Now grep the systemd units and compose file for AWS assumptions.',
  toolCalls: [
    { id: 'tg1', name: 'grep', arguments: JSON.stringify({ pattern: 'aws', path: 'systemd' }) },
    { id: 'tg2', name: 'grep', arguments: JSON.stringify({ pattern: 'amazonaws', path: 'docker-compose.yml' }) },
    { id: 'tg3', name: 'grep', arguments: JSON.stringify({ pattern: 'i-0123456789abcdef0', path: '.' }) },
  ],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Audit complete — 50 routes, the full env-var inventory, and the AWS-assumption list are in the report.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

/** An ALIGNED batch for the counting negative: the narration names the
 *  CALLED read_file (an aligned read sweep), so every call acquits and the
 *  streak stays empty. */
const alignedBatch = {
  content: 'Reading the edge config files now.',
  reasoning: 'Read the edge and CI files with read_file to finish the inventory.',
  toolCalls: Array.from({ length: 5 }, (_, i) => readCall(i + 1)),
  finishReason: 'tool_calls' as const,
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 2201d3d6 — glm-5.3 WORKER-stream stable+loud success-side derail: guard correct, containment effective, model behavior', () => {
  it('UNIT (the elimination leg): the incident premise — the live-reasoning narration convicts read_file of intending grep; the FAITHFUL content channel convicts nothing; the discount never applies (read_file is a coding tool, not a platform tool); the batch-sibling acquittal correctly never fires (grep not in the batch)', () => {
    const offered = ['run_command', 'edit_file', 'grep', 'read_file', 'list_dir', 'glob'];
    expect(detectIntendedTool(P_BATCH, 'read_file', offered)).toBe('grep');
    // The faithful content channel convicts nothing on its own — the
    // conviction rode the LIVE reasoning channel (probe-d on the deployed
    // dist returned intended:null for exactly these persisted channels).
    expect(detectIntendedTool(C_BATCH, 'read_file', offered)).toBeNull();
    // read_file is a CODING-scope tool — the 0625bf62 platform-tool discount
    // is out of scope even when the wake text names work (measure-first).
    expect(intentMismatchDiscount('grep', 'read_file', BRIEF)).toBeNull();
    // The explorer role's toolset carries BOTH tools (the wild worker could
    // legitimately have called grep — the slip was narration-only).
    const explorerTools = toolsForRole('explorer', [{ function: { name: 'run_command' } }, { function: { name: 'edit_file' } }, { function: { name: 'grep' } }, { function: { name: 'read_file' } }, { function: { name: 'list_dir' } }, { function: { name: 'glob' } }, { function: { name: 'write_file' } }, { function: { name: 'ast_search' } }, { function: { name: 'search_code_semantic' } }, { function: { name: 'search_memory' } }] as any).map((t: any) => t.function.name);
    expect(explorerTools).toContain('read_file');
    expect(explorerTools).toContain('grep');
    expect(explorerTools).not.toContain('write_file');
    expect(ROLES.explorer.writes).toBe(false);
  });

  it('REPLAY the incident through the WORKER path (runChatWorker role explorer, batch-of-6, STABLE intent grep, coding-tool scope): steer at the third cumulative read_file mismatch, trip at the fifth — both out of ONE batch — one-round withhold only, and the worker RECOVERS on the modeled grep turn and finishes its report', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readMissBatch)     // the incident: 6 mismatches, one batch, all SUCCEED
      .mockResolvedValueOnce(recoveryGrepTurn)  // the ban round: read_file absent from the schema; grep runs (wild seq 86-90)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runChatWorker(input, 'explorer');

    expect(result.finalText).toContain('Audit complete');
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Steer armed at the THIRD cumulative mismatch, out of the one batch ──
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named grep');
    expect(steer).toContain('call grep NOW');
    // The steer tells the TRUTH about the SUCCESS shape (2c98b460 reviewer F1).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'read_file', intended: 'grep', reason: 'intent_mismatch_success', churned: false,
    });

    // ── Trip at the FIFTH, one round only — the incident's exact meta
    //    (tool_derail_break 20:52:38.786Z shape success_intent perma:false
    //    churned:false intended grep) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'read_file', perma: false, intended: 'grep', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The modeled recovery: the post-steer turn calls grep (the grounded
    //    next action), the worker continues and finishes its report clean ──
    const grepDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'grep');
    expect(grepDispatch.length).toBeGreaterThanOrEqual(1);
    // Reviewer finding 2 (this ticket): the wild 6th read_file was counted
    // and EXECUTED (no second trip — the withheldTool gate; the withhold
    // applies to the NEXT round's schema, agent.ts). Pin the dispatch count
    // so a regression that dropped the 6th sibling fails here.
    const readDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'read_file');
    expect(readDispatch).toHaveLength(6);
    // The user-visible notices tell the TRUTH about the success shape: the
    // withhold notice says the last 5 read_file calls SUCCEEDED and names
    // the intended grep — byte-shapes the wild worker received at
    // 20:52:33Z/20:52:38Z (subagent:guard_marker seq 82).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of read_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named grep');
  });

  it('REPLAY the counting NEGATIVE (the one-message proof, worker path): an ALIGNED earlier batch never feeds the streak — five read_file calls whose narration names read_file acquit, so a LATER mismatched batch still starts its count at 1 and trips only at its own fifth', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(alignedBatch)      // aligned: narration names read_file — no count
      .mockResolvedValueOnce(readMissBatch)     // the incident batch
      .mockResolvedValueOnce(recoveryGrepTurn)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runChatWorker(input, 'explorer');

    expect(result.finalText).toContain('Audit complete');
    // Exactly ONE steer and ONE trip for the whole run — the aligned batch
    // contributed nothing (a cross-message misattribution would have tripped
    // at the FIRST batch's own fifth call).
    expect(reanchorMetrics()).toHaveLength(1);
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep', shape: 'success_intent' });
  });
});
