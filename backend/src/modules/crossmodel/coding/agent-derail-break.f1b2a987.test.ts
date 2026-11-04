/**
 * Replay pin — ticket f1b2a987 (mishap, auto-filed 2026-09-20T14:35:33Z at
 * breaker trip; session b92ef13f-c3f8-487e-8267-767e56543150 "Digby's Nightly
 * Self-Improvement Engineer" — the platform-engineer lane itself, kimi-k3
 * seat; run be23237f-884a-490a-9f1c-5c17d6a4be74; "first streak this run").
 *
 * THE INCIDENT: the run was the 14:24Z ticket-triage firing for bug_report
 * 54a172ac (trigger msg 489e2c08, createdAt 2026-09-20T14:23:24Z). Its plan
 * step #1 was "Re-check ticket 54a172ac status (get_feedback full read) +
 * open queue (list_feedback)" — but the seat EMITTED a family of update_*
 * mutation tools while its narration named list_feedback, and the breaker
 * walked it to the terminal kill. The auto-filed mishap (f1b2a987) carries
 * THREE identical failure texts, newest first:
 *   · Tool update_project failed: Project not found or insufficient permissions
 *   · Tool update_project failed: Project not found or insufficient permissions
 *   · Tool update_project failed: Project not found or insufficient permissions
 *
 * THE FORENSIC RECORD (guard_strike rows, get_fleet_telemetry view 'metrics'
 * kind=guard_strike chatId b92ef13f, pulled fresh 2026-09-20T14:58Z —
 * verbatim seam sequence for run be23237f):
 *   14:25:48.268Z  tool_repeat_break   update_feedback          trips 1
 *   14:26:42.411Z  tool_repeat_break   update_feedback          trips 2
 *   14:26:54.810Z  tool_derail_reanchor update_document  intent_mismatch intended:list_feedback
 *   14:27:37.227Z  tool_derail_break   update_document  perma:false      intended:list_feedback
 *   14:28:08.877Z  tool_repeat_break   update_feedback          trips 3 (rounds=run)
 *   14:28:34.449Z  tool_derail_break   update_document  perma:true       intended:list_feedback
 *   14:29:08→14:32:28Z  tool_repeat_break  update_supervisor_state trips 1,2,3(run)
 *   14:33:04→14:35:17Z  tool_repeat_break  update_schedule        trips 1,2,3(run)
 *   14:35:33.019Z  tool_derail_break   update_project   perma:false state:ended_run
 *                  trips:3 tools:[update_document, update_project] intended:list_feedback
 * Then the harness end-note in the lane transcript (msg d62f8156):
 *   "[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes;
 *    intended tool appears to be list_feedback). The next scheduled firing
 *    starts fresh." — 8 unfinished plan steps.
 *
 * THE DETERMINISM AUDIT (the ticket's mandated INVESTIGATE — diff the failure
 * texts against the framework):
 *   · The 404 text is the EXECUTOR's honest contract, not a guard garble:
 *     platform.service.ts updateProject (line 1609-1611) —
 *     getProjectAccess(projectId, userId) → null/viewer ⇒ AppError(404,
 *     'Project not found or insufficient permissions'); the coding catch-all
 *     renders it `Tool ${name} failed: ${err.message}` verbatim. The lane
 *     acts AS the owner, so a 404 means the id resolved to NO owner-
 *     accessible project: a wrong-FAMILY id (a chat/ticket/run uuid passed
 *     as projectId) or a nonexistent one. Deterministic-correct.
 *   · The calls REACHED the executor: the run's seam sequence carries ZERO
 *     tool_preflight rows for update_project. The id-grounding pre-flight
 *     (tool-preflight.ts findUngroundedIdArgs) is REFERENTIAL grounding —
 *     ID_SHAPE_RE /^[0-9a-f]{8}/i passes any uuid-shaped token and verbatim
 *     haystack presence passes anything else the model legitimately read
 *     (e.g. the literal "chat" from a ticket context's `"projectId":"chat"`).
 *     Family is validated by the executor's typed lookup — the designed
 *     split, not a coverage bug: a wrong-family uuid is indistinguishable
 *     from a real one without a DB round-trip the preflight deliberately
 *     avoids. update_project IS in PLATFORM_TOOL_NAMES (covered tool).
 *   · The filing arithmetic is exact: reflection.ts fileStreakInvestigation
 *     dedups per (sessionId, tool) for 24h — the run's TWO update_document
 *     derail trips (14:27:37, 14:28:34) dedup-HIT against cbc5be24 (the
 *     same session's update_document ticket filed 06:53:21Z, inside the
 *     window), so exactly ONE NEW mishap exists from this run: f1b2a987,
 *     filed at the ended_run trip with the streak's 3 newest texts.
 *
 * ROLLOUT BOUNDARY (post-rollout classification doctrine, 2026-09-20): run
 * start = trigger msg 489e2c08 createdAt 14:23:24Z > the re-anchor wave
 * (616d8793 riding 4714f9df, deploy run 35510720485) conclusion 13:19:19Z —
 * and the steer FIRING at 14:26:54.810Z is itself the proof the serving box
 * ran the re-anchor code. POST-ROLLOUT, self-verifying. Probe-vs-derail
 * NEGATIVE (ea69c94e discipline): the lane was mid real work (ticket
 * 54a172ac triage), not lifecycle negative probes of guard refusals.
 *
 * VERDICT: MODEL BEHAVIOR — the kimi-k3 narration/emission mismatch class
 * (wrong-tool substitution; placeholder-id subclass siblings f839cede /
 * aff1c189 / ec9d7424; update_schedule-family siblings c5ad2e56 / 13b2f286;
 * executor-side sibling bda7f125). Distinctive shape here: NOT a placeholder
 * id — the passed projectId was uuid-shaped/grounded but of the WRONG
 * FAMILY, so the executor's typed 404 (not the preflight) was the
 * containment seam. Every deterministic seam behaved EXACTLY as designed:
 * the referential preflight admitted a shape-valid id; the executor refused
 * it honestly; the auto re-anchor (ticket 431518a2) fired its ONE harness
 * steer on the FIRST intent-mismatch signature BEFORE the first breaker row;
 * the breaker weighted failures, withheld, perma-removed, and ended the run
 * at trips≥3 with the byte-exact harness note; the deduped filing created
 * exactly one new ticket. The steer did NOT recover the seat (expected per
 * adjudication 508c20b8 — the terminal-kill + fresh-firing bound is the
 * containment; this run is also n=2 of the re-anchor→repeat-breaker
 * cross-seam class banked in PR #914, the first TERMINAL one). NO platform
 * code change.
 *
 * These tests pin: (1) a wrong-family uuid / haystack-present token is
 * GROUNDED to the preflight while a narration token is not; (2) the intent
 * detector convicts the incident narration and nothing faithful; (3)
 * updateProject's 404 contract is byte-exact for a wrong-family uuid and
 * for the literal "chat"; (4) END-TO-END the incident's tool sequence walks
 * the breaker to the ended_run kill with the byte-faithful metric envelope,
 * ONE leg-(b) steer recorded BEFORE the first breaker row, ZERO ungrounded
 * preflights, exactly THREE executor update_project calls, and the terminal
 * filing carrying the three identical 404 texts. Scaffold mirrors
 * agent-derail-break.13b2f286.test.ts (same mock set).
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    // updateProject's access check: no project row resolves for the
    // wrong-family ids below ⇒ getProjectAccess returns null ⇒ 404.
    crossModelProject: { findUnique: jest.fn(async () => null) },
    projectMember: { findMany: jest.fn(async () => []) },
  },
}));
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

/** The tool layer stands in for the platform executor: each call RESOLVES the
 *  verbatim failure-shaped text the real catch-all produced in the incident
 *  (`Tool ${name} failed: ${err.message}` — the wrapper contract itself is
 *  pinned by agent-derail-break.8e900af9.test.ts). */
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_project') return 'Tool update_project failed: Project not found or insufficient permissions';
  if (name === 'update_document') {
    return `Tool update_document failed: No generated file with id ${args?.fileId ?? 'x'} belongs to this user. Call list_files to see the current files.`;
  }
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document-tool seam (mirrors agent-derail-break.323093a9.test.ts):
// update_document dispatches via ctx.toolCache (tool-executor.ts
// DOC_TOOL_NAMES), not executeCodingTool. Keep the REAL TOOL_DEFINITIONS
// (the offered-tool list is built from it); stub only the executor instance
// to answer tool-executor.ts's honest existence refusal — bare text, no
// `Tool … failed:` wrapper, exactly the bda7f125 filed shape.
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
  }
  return 'probe result: ok';
});
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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
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
const mockConsultCrossCheckerOnStreak: jest.Mock = jest.fn(async () => null);
const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => undefined);
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: (...a: any[]) => mockConsultCrossCheckerOnStreak(...a),
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { findUngroundedIdArgs, detectIntendedTool } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';
import { updateProject } from '../platform/platform.service';

/** CODING profile (no workspace container in the scaffold), kimi-k3 — the
 *  incident's seat (telemetry: model kimi-k3, profile coding, moonshot). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim tokens (ticket f1b2a987) ────────────────────────
const NOT_FOUND_TEXT = 'Project not found or insufficient permissions';
const FILED_TEXT = `Tool update_project failed: ${NOT_FOUND_TEXT}`; // the filed text ×3
const INTENDED_TOOL = 'list_feedback'; // the tool the lane's reasoning named
/** Wrong-FAMILY ids the run legitimately carried (all uuid-shaped ⇒ the
 *  referential preflight admits them; the executor's typed lookup is the
 *  family guard and 404s each one): the CanLaw lane's CHAT id, the FEEDBACK
 *  ticket id the run was triaging, and the run's OWN run id. */
const CHAT_ID_AS_PROJECT = 'cec340f2-f605-4370-b87a-d85b59cb243f';
const TICKET_ID_AS_PROJECT = '54a172ac-c8ab-402b-a1e6-60a61d5cdb1a';
const RUN_ID_AS_PROJECT = 'be23237f-884a-490a-9f1c-5c17d6a4be74';
/** Distinct uuid-shaped file ids (the repeat breaker keys on call signature —
 *  the incident's update_document/update_project calls carried no identical
 *  signature and never touched that seam). */
const DOC_FILE_1 = '0ec9a1c2-1111-4000-8000-0000000000d1';
const DOC_FILE_2 = '0ec9a1c2-2222-4000-8000-0000000000d2';
const DOC_FILE_3 = '0ec9a1c2-3333-4000-8000-0000000000d3';
const DOC_FILE_4 = '0ec9a1c2-4444-4000-8000-0000000000d4';

/** The 54a172ac-dispatch brief shape — names list_feedback as the step-1 read
 *  and carries the wrong-family ids the derailed calls reused. */
const BRIEF = [
  '[TICKET BATCH DISPATCH — 1 open feedback tickets, owner-ordered burn-down]',
  `Ticket ${TICKET_ID_AS_PROJECT} | type: bug_report | priority: 2 — CanLaw repetition loop (lane chat ${CHAT_ID_AS_PROJECT}).`,
  'BEFORE building: re-check the ticket status with list_feedback — if it is already done/in_progress citing a PR, do NOT rebuild it.',
  `Run context: this firing is run ${RUN_ID_AS_PROJECT}.`,
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-f1b2a987-test',
  sessionId: 'sess-f1b2a987',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The incident emissions. Intent-convicted turns name list_feedback in the
 *  reasoning and never name the emitted tool; intent-silent turns name no
 *  offered tool at all (the two middle update_project calls — the filed
 *  ticket shows three EXECUTED 404s, so the weighted arithmetic that fits
 *  the record is 1, 2, then 3+intent ⇒ trip on the third with three texts). */
const docTurn = (n: number, fileId: string) => ({
  content: '',
  reasoning: `Step 1: the open queue first — ${INTENDED_TOOL}, status open, then the ticket row.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId, content: 'x' }) }],
  finishReason: 'tool_calls',
});
const projectTurnSilent = (n: number, projectId: string) => ({
  content: '',
  reasoning: 'Retrying the project settings write with the id from the brief.',
  toolCalls: [{ id: `t${n}`, name: 'update_project', arguments: JSON.stringify({ projectId, description: 'x' }) }],
  finishReason: 'tool_calls',
});
const projectTurnIntent = (n: number, projectId: string) => ({
  content: '',
  reasoning: `Step 1 retry: read the open ticket queue — ${INTENDED_TOOL}, status open, then adjudicate.`,
  toolCalls: [{ id: `t${n}`, name: 'update_project', arguments: JSON.stringify({ projectId, description: 'x' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop' };

const metricRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]);
const preflightUngroundedMetrics = () => metricRows().filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.reason === 'ungrounded_id');
const breakerMetrics = () => metricRows().filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => metricRows().filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const metricSeamOrder = () => metricRows().map((m) => m?.meta?.seam);
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const executorCalls = (name: string) => mockExecuteCodingTool.mock.calls.filter((c) => c[1] === name);
const docExecutorCalls = (name: string) => mockToolCacheExec.mock.calls.filter((c) => c[0] === name);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay f1b2a987 — wrong-FAMILY id update_project streak: executor 404 is the honest family guard; breaker walks to ended_run', () => {
  it('the referential preflight ADMITS wrong-family ids (uuid shape / haystack presence) and refuses only narration tokens — family is the executor\u2019s job', () => {
    // uuid-shaped ⇒ grounded by shape, even though it is a CHAT id, not a project.
    expect(findUngroundedIdArgs({ projectId: CHAT_ID_AS_PROJECT }, BRIEF)).toEqual([]);
    // not uuid-shaped but verbatim-present in what the model read (the ticket
    // context's `"projectId": "chat"`) ⇒ grounded by presence.
    expect(findUngroundedIdArgs({ projectId: 'chat' }, '"projectId": "chat"')).toEqual([]);
    // an invented narration token is neither ⇒ refused pre-execution (the
    // 13b2f286 contract would have caught THAT shape; it never fired here).
    expect(findUngroundedIdArgs({ projectId: 'placeholder-project' }, BRIEF))
      .toEqual([{ key: 'projectId', value: 'placeholder-project' }]);
  });

  it('the intent detector convicts the incident narration; faithful narration convicts nothing', () => {
    const offered = ['run_command', 'list_feedback', 'update_project', 'update_document', 'update_plan'];
    expect(detectIntendedTool(projectTurnIntent(1, CHAT_ID_AS_PROJECT).reasoning, 'update_project', offered)).toBe(INTENDED_TOOL);
    expect(detectIntendedTool(docTurn(2, DOC_FILE_1).reasoning, 'update_document', offered)).toBe(INTENDED_TOOL);
    const faithful = 'Updating update_project on the crossmodel folder with the new description now.';
    expect(detectIntendedTool(faithful, 'update_project', offered)).toBeNull();
  });

  it('updateProject\u2019s 404 contract is byte-exact: any id resolving to no owner-accessible project gets the same honest refusal', async () => {
    // a CHAT-family uuid passed as projectId (the incident's shape)…
    await expect(updateProject({ userId: 'u-owner', projectId: CHAT_ID_AS_PROJECT, description: 'x' }))
      .rejects.toMatchObject({ statusCode: 404, message: NOT_FOUND_TEXT });
    // …and the literal "chat" from a ticket context's `"projectId": "chat"`.
    await expect(updateProject({ userId: 'u-owner', projectId: 'chat', description: 'x' }))
      .rejects.toMatchObject({ statusCode: 404, message: NOT_FOUND_TEXT });
  });

  it('END-TO-END (f1b2a987): executor-404 streak walks the breaker to ended_run — ONE pre-breaker steer, ZERO ungrounded preflights, the terminal filing carries the three identical texts', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(docTurn(1, DOC_FILE_1))       // exec fail +intent ⇒ count 2; RE-ANCHOR (leg b) pending
      .mockResolvedValueOnce(docTurn(2, DOC_FILE_2))       // exec fail +intent ⇒ count 4 ⇒ TRIP 1 update_document (perma:false, withheld a round)
      .mockResolvedValueOnce(docTurn(3, DOC_FILE_3))       // WITHHELD ⇒ tool_not_offered refusal (failure-shaped; count 2)
      .mockResolvedValueOnce(docTurn(4, DOC_FILE_4))       // exec fail +intent ⇒ TRIP 2 update_document (perma:true — removed)
      .mockResolvedValueOnce(projectTurnSilent(5, CHAT_ID_AS_PROJECT))   // exec 404, no intent ⇒ count 1
      .mockResolvedValueOnce(projectTurnSilent(6, TICKET_ID_AS_PROJECT)) // exec 404, no intent ⇒ count 2
      .mockResolvedValueOnce(projectTurnIntent(7, RUN_ID_AS_PROJECT))    // exec 404 +intent ⇒ TRIP 3 update_project ⇒ size 2 ⇒ ENDED_RUN
      .mockResolvedValue(FINAL);

    const input = makeInput();
    const result = await runCodingAgent(input);

    // The distinguishing shape vs the placeholder subclass: EVERY call
    // REACHED its executor (uuid-shaped ids pass the preflight) — 3×
    // update_project via the platform seam, 3× update_document via the
    // document (toolCache) seam (turns 1/2/4; turn 3 was the one-round
    // WITHHELD refusal after trip 1) — and the intended read never ran.
    expect(executorCalls('update_project')).toHaveLength(3);
    expect(docExecutorCalls('update_document')).toHaveLength(3);
    expect(executorCalls(INTENDED_TOOL)).toHaveLength(0);
    expect(docExecutorCalls(INTENDED_TOOL)).toHaveLength(0);
    // Zero referential-grounding refusals anywhere in the run.
    expect(preflightUngroundedMetrics()).toHaveLength(0);

    // Exactly ONE harness-attributed steer (leg b intent_mismatch), fired on
    // the FIRST derail signature and recorded BEFORE the first breaker row —
    // the telemetry order 14:26:54.810Z reanchor → 14:27:37.227Z break.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_document', intended: INTENDED_TOOL, reason: 'intent_mismatch' });
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named list_feedback');
    expect(steer).toContain('Your ACTUAL tool list for the rest of this run is exactly:');
    const seams = metricSeamOrder();
    expect(seams.indexOf('tool_derail_reanchor')).toBeGreaterThan(-1);
    expect(seams.indexOf('tool_derail_break')).toBeGreaterThan(seams.indexOf('tool_derail_reanchor'));

    // The breaker walk, byte-faithful to the incident's seam rows: withhold,
    // perma-remove, then the terminal kill with the exact envelope.
    expect(breakerMetrics()).toHaveLength(3);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'update_document', perma: false, intended: INTENDED_TOOL });
    expect(breakerMetrics()[0].meta.state).toBeUndefined();
    expect(breakerMetrics()[1].meta).toMatchObject({ tool: 'update_document', perma: true, intended: INTENDED_TOOL });
    expect(breakerMetrics()[2].meta).toMatchObject({
      state: 'ended_run',
      tool: 'update_project',
      perma: false,
      trips: 3,
      tools: ['update_document', 'update_project'],
      intended: INTENDED_TOOL,
    });

    // The run ends with the byte-exact harness note from the lane transcript
    // (msg d62f8156): "(3 episodes; intended tool appears to be list_feedback)".
    const killPart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes('Run ended: repeated wrong-tool derailment'));
    expect(killPart).toBeDefined();
    expect(killPart!.marker).toBe('guard');
    expect(String(killPart!.text)).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes; intended tool appears to be list_feedback). The next scheduled firing starts fresh.');

    // Attribution: the two non-terminal update_document trips consult + file
    // (in production both dedup-HIT the 24h (session, update_document) key
    // from cbc5be24 filed 06:53:21Z — no new ticket); the terminal
    // update_project trip files WITHOUT a consult (the run is ending) — and
    // THAT filing is f1b2a987: three identical executor 404s, newest first.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(2);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(3);
    expect(mockFileStreakInvestigation.mock.calls[0][0]).toMatchObject({ tool: 'update_document', perma: false });
    expect(mockFileStreakInvestigation.mock.calls[1][0]).toMatchObject({ tool: 'update_document', perma: true });
    const ev = mockFileStreakInvestigation.mock.calls[2][0];
    expect(ev).toMatchObject({ tool: 'update_project', perma: false, intended: INTENDED_TOOL });
    expect(ev.recentFailures).toHaveLength(3);
    expect(ev.recentFailures).toEqual([FILED_TEXT, FILED_TEXT, FILED_TEXT]);
  });

  it('wiring seam: update_project stays a preflight-covered platform tool and the narration-intended read tool stays offered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_project');
    expect(PLATFORM_TOOL_NAMES).toContain(INTENDED_TOOL); // list_feedback — the tool the lane's reasoning named
  });
});
