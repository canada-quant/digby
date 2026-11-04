/**
 * Replay pin — ticket 0aecbe92 (mishap, filed 2026-09-20T06:54:54Z by the
 * CanLaw supervisor f5c2c1f4; incident lane 10cb988f-6e80-4d3a-9e59-9e8fc83c93ae
 * "Repository Duplicates and Documentation Update", CanLaw, coding seat
 * kimi-k3, auto, recurring docs-keeper schedule).
 *
 * THE INCIDENT: TWO consecutive runs died at run START on the wrong-tool
 * derail terminal state (agent.ts:3226-3233), zero plan steps executed:
 *   1. firing 95 (trigger 06:40:41Z → killed 06:44:15Z): harness note
 *      "Run ended: repeated wrong-tool derailment (3 episodes; intended tool
 *      appears to be run_command)", plan 0/7. Companion auto-files from the
 *      same run (637592bc) pin the emitted tools: b305c23e — update_feedback
 *      evidence_required envelopes on the CLOSED ticket d0597e02, retried
 *      identically ("reasoning named run_command"); ff48c6f7 — update_document
 *      existence refusals with fabricated ids d0597e02 / noop ("reasoning
 *      named run_command"). Every emission was a failure-shaped wrong-tool
 *      call while the narration intended shell work.
 *   2. supervisor-steer run (steer delivered 06:49:45Z naming the correct
 *      tool per step → run 06:49:55Z → killed 06:51:02Z, ~67 s): the SAME
 *      note, 3 episodes, 0/7. A corrective re-prompt did NOT recover the seat.
 * Control: firing 94 (02:40–02:46Z) ran the identical 7-step shell checklist
 * cleanly on the same seat. Same-evening siblings with the identical shape:
 * tt-rd lane ddd26be0 firings 80/81 (killed ~74 s / ~27 s after trigger —
 * platform-task dispatch 2026-09-20) and bench lane 619a1241 firing 88.
 *
 * EPISODE ARITHMETIC (pinned here): the terminal note's "3 episodes" requires
 * trip tallies {X:2, Y:1} — trips on two tools with one tool tripping twice
 * (agent.ts:3227: size ≥ 2 OR total ≥ 3 ends the run at the trip that crosses;
 * a perma-locked tool cannot trip again, agent.ts:3184). The reconstructed
 * sequence below uses the incident's filed envelopes: update_feedback →
 * evidence_required (b305c23e) and update_document → existence refusal
 * (ff48c6f7), each weighted +1 (failure) +1 (intent mismatch — the narration
 * names run_command, agent.ts:3181-3183) = 2 per call.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — kimi-k3
 * wrong-tool substitution with no recovery, same class as 718a04a5 /
 * 8e900af9 / 177a31b7 / 14739e76 / cbc5be24 / 83297404 / d87f1ea0 tonight.
 * Every deterministic seam behaved as designed: run_command stays exempt from
 * BOTH breakers (the model never emitted it), the intent-mismatch preflight
 * named the intended tool, the terminal state ended the run honestly
 * (completed-with-note — never modelErrored), and the continuation path
 * resumed the checklist next firing. NO framework code change. Note the onset
 * regime difference vs 718a04a5 (~213 steps) / 8e900af9 (~55 turns): this
 * shape derails on the FIRST emissions of a run — one substitution class, two
 * onset regimes.
 *
 * These tests pin: the incident envelopes are failure-shaped; the intent
 * preflight names run_command; the {2,1} trip sequence ends the run with the
 * EXACT incident note (3 episodes, intended run_command, next-firing line),
 * completed-with-note semantics, guard-marked part + emit, ended_run
 * telemetry, per-tool auto-filings carrying each incident's exact filed
 * texts, and ZERO shell executions (the 0/7-steps signature); and the
 * steer-run case — an explicit corrective re-prompt derails identically.
 * Scaffold mirrors agent-derail-break.718a04a5.test.ts (same mock set).
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

// update_feedback executes through executeCodingTool; its mutation gate
// (platform-tools.ts:3608-3609) returns the evidence_required refusal for a
// machine-triggered run mutating a ticket it is not dispatched to. Every
// other tool succeeds harmlessly.
const EVIDENCE_REQUIRED = (ticketId: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'evidence_required',
  ticketId,
  message: `This machine-triggered run may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: the ticket is not dispatched to this session (its context.dispatchedTo names another session) and no verifiable evidence was supplied. Dispatch binding is the sanctioned path — a dispatched lane works its OWN tickets (in_progress/adminNote/priority) without the artifact bar; without binding the evidence bar applies to EVERY status, not just done. If the ticket needs triage you cannot evidence, leave it for its dispatched lane or record a file_feedback sighting instead.`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback seam: update_document AND update_feedback both
// dispatch via ctx.toolCache (WEB_TOOL_NAMES = TOOL_DEFINITIONS names,
// agent.ts:304). Keep the REAL TOOL_DEFINITIONS; stub only the executor.
const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return UD_ENVELOPE(id);
  }
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
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
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold): run_command is in
 *  the offered schema — the incident's intended tool must be offerable for
 *  the intent-mismatch preflight to name it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const CLOSED_TICKET = 'd0597e02'; // the docs-keeper prompt's terminal-stop ticket (hex-shaped ⇒ grounded)
const BRIEF = [
  'DOCS-KEEPER firing — work the 7-step shell checklist.',
  '1. SETUP: date -u; git fetch origin --prune; git ls-remote origin main.',
  '[TERMINAL-STOP] feedback ticket d0597e02 is CLOSED (status=done) — do NOT re-audit or mutate it.',
].join('\n');
const STEER = [
  'Supervisor steer: your previous run ended on repeated wrong-tool derailment.',
  'Re-run the checklist now, executing EACH shell step with the correct tool: run_command.',
  'date -u; git fetch origin --prune; git ls-remote origin main.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-0aecbe92-test',
  sessionId: 'sess-0aecbe92',
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

/** A wrong-tool emission: update_feedback against the closed ticket while the
 *  narration announces shell work (the b305c23e shape — "reasoning named
 *  run_command"). */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell first: run_command "git fetch origin --prune && git ls-remote origin main" — the sweep starts now.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: CLOSED_TICKET, status: 'done', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** A wrong-tool emission into the document seam with a fabricated id — the
 *  ff48c6f7 shape. The id stays verbatim in the narration so the grounding
 *  preflight passes (00667344 echo) and the call EXECUTES into the refusal. */
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `run_command cannot touch the digest — refresh the generated file ${id} with the census figures now.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** The firing-95 episode sequence: {update_feedback: 2 trips, update_document:
 *  1 trip} = "3 episodes" — trip 1 (one-round ban), ban-round probe, trip 2
 *  (perma), then the document seam trips the run into the terminal state. */
const wireFiring95 = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1)) // count 2 (failure + intent)
    .mockResolvedValueOnce(ufTurn(2)) // count 4 ⇒ TRIP 1 (one-round ban)
    .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
    .mockResolvedValueOnce(ufTurn(4)) // count 2
    .mockResolvedValueOnce(ufTurn(5)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
    .mockResolvedValueOnce(udTurn(6, CLOSED_TICKET)) // count 2
    .mockResolvedValueOnce(udTurn(7, 'noop')) // count 4 ⇒ TRIP 3 ⇒ TERMINAL
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 0aecbe92 — kimi-k3 wrong-tool derail at run start (run_command never emitted)', () => {
  it('UNIT: both incident envelopes are failure-shaped; the intent preflight names run_command', () => {
    expect(looksLikeToolFailure(EVIDENCE_REQUIRED(CLOSED_TICKET))).toBe(true);
    expect(looksLikeToolFailure(UD_ENVELOPE('noop'))).toBe(true);
    expect(detectIntendedTool(ufTurn(1).reasoning, 'update_feedback', ['run_command', 'update_feedback', 'update_document'])).toBe('run_command');
    expect(detectIntendedTool(udTurn(6, CLOSED_TICKET).reasoning, 'update_document', ['run_command', 'update_feedback', 'update_document'])).toBe('run_command');
    // Sanity: faithful narration (naming the called tool) convicts nothing.
    expect(detectIntendedTool('Calling update_feedback now with the real id.', 'update_feedback', ['run_command', 'update_feedback'])).toBeNull();
  });

  it('REPLAY firing 95: {update_feedback:2, update_document:1} trips end the run with the EXACT incident note — 3 episodes, intended run_command, zero shell executions', async () => {
    wireFiring95();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    // Completed-with-note, never a provider failure.
    expect(result.modelErrored).toBeUndefined();
    const notePart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(notePart).toBeDefined();
    expect(notePart!.marker).toBe('guard');
    const guardEmits = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(guardEmits.some((e) => String(e.text).startsWith('[HARNESS] Run ended'))).toBe(true);

    // Telemetry: the terminal row carries ended_run + the run-level tallies.
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', trips: 3, intended: 'run_command' });

    // The 0/7-steps signature: run_command was never emitted, so no shell work
    // ever executed.
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[0] === 'run_command')).toBe(false);

    // The per-tool auto-filings carry the incident's exact filed envelopes:
    // update_feedback's trip filed the two identical evidence_required texts
    // (b305c23e), update_document's the two existence refusals (ff48c6f7).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ufFiling = filings.find((f) => f.tool === 'update_feedback');
    const udFiling = filings.find((f) => f.tool === 'update_document');
    expect(ufFiling).toBeDefined();
    expect(ufFiling.recentFailures).toEqual([EVIDENCE_REQUIRED(CLOSED_TICKET), EVIDENCE_REQUIRED(CLOSED_TICKET)]);
    expect(udFiling).toBeDefined();
    expect(udFiling.recentFailures).toEqual([UD_ENVELOPE('noop'), UD_ENVELOPE(CLOSED_TICKET)]);
  });

  it('REPLAY the 06:49:45Z supervisor-steer run: an explicit corrective re-prompt derails IDENTICALLY (the seat does not recover in-run)', async () => {
    wireFiring95();
    const input = makeInput(`${STEER}\n${BRIEF}`);
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(result.modelErrored).toBeUndefined();
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ trips: 3, intended: 'run_command' });
  });
});

// ── Post-fix occurrence ledger: d18241b3 (mishap, filed 2026-09-20T10:24:40Z
// by fleet supervisor c0e22e36; a data point consolidated under class ticket
// 22c309f4). tt-rd QB2 lane ddd26be0 (kimi-k3) Firing-83 — the direct sequel
// to the F80/81 run-start kills named above: trigger 08:16:54Z, completed 2/7
// plan steps, harness-killed 09:37:38Z for repeated wrong-tool derailment (3
// episodes; intended tool 'verify', absent from that lane's toolset). The
// MID-RUN onset (step 3, vs the F80/81 first-minute kills) shows firing-start
// TOOL DISCIPLINE preambles suppress the class at firing start but the
// suppression DECAYS mid-run: F82 ran clean end-to-end under the preamble,
// F83 derailed anyway at step 3. PRE-FIX baseline: the kimi-k3 conformance
// fix 8f4c4464 (PR #903, ticket 22c309f4) went live 09:58:48Z — after F83.
// Verdict (adjudication 2026-09-20, lane b92ef13f): MODEL behavior — the
// 2-episode breaker contained all three kills with zero state touched and the
// terminal state ended the run honestly, exactly as these tests pin.
// UPDATE 2026-09-20T11:05Z (Fleet Supervisor steer, verified via get_feedback):
// the re-arm condition has ALREADY fired. 431518a2 (mishap P3, filed
// 10:52:47Z, open — cited read-only; not dispatched to this lane) records the
// first POST-fix kills, ~46-50 min after deploy 35501798401 concluded
// (09:58:48Z): CanLaw e083ff2e killed 10:44:46Z and cec340f2 run 75d8e448
// killed 10:48:31Z (3 episodes, intended search_memory — ~3 min after a
// fully-clean 10:42:36Z self-audit: the SAME mid-run decay shape as F83).
// Those kills ARE the placeholder-batch incidents cited in
// agent-derail-break.718a04a5.test.ts (f218735b = e083ff2e run ad58d5ef;
// e36dff44 + 4f3ecab9 = cec340f2 run 75d8e448), so BOTH surface subclasses
// recur post-fix — further corroborated by lane b92ef13f's own 10:22Z
// close-out run (7 update_document placeholder emissions on its own seat).
// The conformance fix (65k cap + reasoning_content replay) did NOT stop the
// substitution class; d18241b3's ~6h-hold premise is OVERTAKEN, and the
// auto-inject re-anchor decision (platform task 6dc29381) now has real
// post-fix data. Consolidated finding relayed to crossmodel Supervisor
// daee2916 (send_chat_message receipt da92f3fd, 2026-09-20T11:05Z).
