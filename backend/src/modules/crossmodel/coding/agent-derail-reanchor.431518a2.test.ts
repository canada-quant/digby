/**
 * Replay pin — ticket 431518a2 (mishap, filed 2026-09-20T10:52:47Z by the
 * crossmodel supervisor c0e22e36; incident lanes CanLaw cec340f2 "Re-Send
 * Path C Phase 2 Kickoff" (run 10:45:05Z → harness-killed 10:48:31Z) and
 * e083ff2e "Post-CPT Coordination" (ended 10:44:46Z), coding seat kimi-k3).
 *
 * THE INCIDENT (REGRESSION, not baseline): the 8f4c4464 kimi-k3 conformance
 * fix (deploy run 35501798401 SUCCESS 09:58:48Z, fleet-live on all four box
 * processes) closed the placeholder/truncation subclass, but the WRONG-TOOL
 * SUBSTITUTION subclass recurred ~45 min POST-fix. cec340f2 died with
 * "repeated wrong-tool derailment (3 episodes; intended tool appears to be
 * search_memory)" three minutes AFTER producing a fully-clean second-pass
 * self-audit at 10:42:36Z — the decay is MID-RUN, not firing-start (tt-rd's
 * pre-fix F83, ticket d18241b3, showed the same: preamble suppression holds
 * ~2 clean steps, then decays). Conclusion (tt-rd supervisor + Fleet
 * Supervisor + the ticket, independently): firing-start preambles are
 * structurally insufficient; the intervention must fire MID-RUN.
 *
 * THE FIX (this pin): the auto-inject RE-ANCHOR (early-steer) in agent.ts.
 * The FIRST derail-class signature in a live run injects ONE harness-
 * attributed steer — naming the intended tool, restating the session's
 * ACTUAL offered toolset — BEFORE the derail breaker would have to
 * terminate. Bounded: exactly ONE per run; every later occurrence flows
 * through the UNCHANGED breaker path (withhold → perma → terminal —
 * agent.ts trip thresholds intact, the PR #898 '3 episodes' arithmetic
 * reproduced below verbatim).
 *
 * TRIGGER BOUNDARY (settled with the incident measurements, documented in
 * the PR body): fire on
 *   (a) a tool_not_offered preflight refusal for a GENUINELY nonexistent
 *       name (hint === undefined — NOT the breaker-withheld sub-case the
 *       breaker's own notice covers, NOT the account-not-loaded
 *       progressive-disclosure nudge); or
 *   (b) an intended-vs-emitted mismatch — detectIntendedTool names a
 *       DIFFERENT offered tool on a failure-shaped result (the derail
 *       detector's own derailIntendedTool signal; cec340f2 narrated
 *       search_memory while emitting update_document/update_feedback); or
 *   (c) a placeholder-emission STREAK — the SECOND invented-id signal in
 *       the run (supervisor steer 2026-09-20T11:37Z + the nightly lane's
 *       consolidated post-fix finding: update_document 'noop'/'none',
 *       update_feedback 'nonexistent' streaks recur post-8f4c4464 with the
 *       same mid-run decay shape and the same terminal outcome). Sources:
 *       ungrounded-id preflight refusals (platform tools) AND failure-shaped
 *       document-seam results whose id args fail the same grounding check
 *       (document tools EXECUTE — they are not platform-preflighted; the
 *       grounding haystack excludes the call's own result because the
 *       refusal envelope echoes the invented id back). The FIRST bare
 *       invented-id call is ordinary working containment (the 0c0ce759
 *       close) and never triggers.
 *
 * ADJUDICATION OF RECORD (lane 508c20b8, 2026-09-20T11:44Z, folded in per
 * the supervisor steer): BOTH incident runs STARTED post-rollout (e083ff2e
 * ad58d5ef 10:41:08Z, cec340f2 75d8e448 10:45:51Z — 40+ min after the
 * ~10:01Z worst-case regression window) ⇒ POST-FIX occurrences, MODEL
 * behavior; the kills are replay-pinned on main by PR #908 (merge sha
 * 740fe816) as f218735b (e083ff2e) + e36dff44/4f3ecab9 (cec340f2); the
 * breaker contained both, zero state touched; RECOVERY OBSERVED — cec340f2
 * firing 58 (msg 6c02c59f @11:24:10Z) ran clean. PRIOR EVIDENCE the design
 * respects: explicit corrective re-prompts did NOT recover this seat class
 * in-run (the 0aecbe92 replay; the 10cb988f 06:49Z steer run derailed
 * identically ~67 s later) — so efficacy is gated on the post-deploy
 * wrong-tool kill count (get_fleet_telemetry, derail class), which carries
 * the weight of the 431518a2 close. d18241b3 is the same class (pre-fix
 * tt-rd F83) and is closed with this same evidence.
 *
 * These tests pin: ONE steer per run on each trigger leg with the exact
 * harness attribution (message prefix + guard part + progress stage +
 * telemetry seam); the one-per-run bound across a full terminal episode
 * sequence (PR #898's {update_feedback:2, update_document:1} = "3
 * episodes" arithmetic reproduced UNCHANGED); recovery (steer → correct
 * tool → clean finish, breaker never trips); and the two no-fire boundary
 * shapes (bare ungrounded refusal; re-call of a breaker-withheld tool).
 * Scaffold mirrors agent-derail-break.0aecbe92.test.ts (same mock set).
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
// other tool succeeds harmlessly. mockExecuteCodingTool's real signature is
// (ctx, name, args) — name-first mocks silently misroute (the 0aecbe92
// scaffold gotcha).
const EVIDENCE_REQUIRED = (ticketId: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'evidence_required',
  ticketId,
  message: `This machine-triggered run may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: the ticket is not dispatched to this session (its context.dispatchedTo names another session) and no verifiable evidence was supplied.`,
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
 *  the intent-mismatch detector to name it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const CLOSED_TICKET = 'd0597e02'; // hex-shaped ⇒ grounded, so the call EXECUTES into the refusal
const BRIEF = [
  'DOCS-KEEPER firing — work the 7-step shell checklist.',
  '1. SETUP: date -u; git fetch origin --prune; git ls-remote origin main.',
  '[TERMINAL-STOP] feedback ticket d0597e02 is CLOSED (status=done) — do NOT re-audit or mutate it.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-431518a2-test',
  sessionId: 'sess-431518a2',
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

/** The cec340f2 shape: update_feedback against the closed ticket while the
 *  narration announces shell work — failure + intent mismatch (leg b). */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell first: run_command "git fetch origin --prune && git ls-remote origin main" — the sweep starts now.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: CLOSED_TICKET, status: 'done', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** The ddd26be0-F83 shape: a GENUINELY nonexistent tool name (never in the
 *  schema) while the narration names a real one (leg a). */
const ghostTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell first: run_command "git fetch origin --prune && git ls-remote origin main" — the sweep starts now.',
  toolCalls: [{ id: `t${n}`, name: 'refresh_digest', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls',
});
/** A FAITHFUL update_feedback call on the grounded closed ticket (narration
 *  names the called tool): a plain failure loop, no derail signal. */
const faithfulUfTurn = (n: number) => ({
  content: '',
  reasoning: 'Rechecking update_feedback on the closed ticket to confirm its status one more time.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: CLOSED_TICKET, status: 'done', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** A BARE ungrounded-id refusal shape: placeholder id, but the narration
 *  faithfully names update_feedback — containment working (0c0ce759), never
 *  a re-anchor trigger on its OWN (leg (c) needs the STREAK). */
const ungroundedUfTurn = (n: number) => ({
  content: '',
  reasoning: 'Closing out update_feedback on the placeholder ticket with the audit note now.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: 'PLACEHOLDER_TICKET', status: 'done', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** A FAITHFUL placeholder emission into the document seam (narration names
 *  update_document itself): document tools EXECUTE (not platform-
 *  preflighted), so the invented id is seen off the failure result — leg
 *  (c) source 2. */
const faithfulUdTurn = (n: number, id: string) => ({
  content: '',
  reasoning: 'Refreshing update_document on the digest file with the reconciled census figures now.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** A wrong-tool emission into the document seam with the id verbatim in the
 *  narration (grounding passes; the call EXECUTES into the refusal). */
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `run_command cannot touch the digest — refresh the generated file ${id} with the census figures now.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 431518a2 — auto re-anchor (early-steer) for the kimi-k3 wrong-tool derail class', () => {
  it('UNIT: the trigger boundary — intent mismatch convicts the incident narration; faithful narration convicts nothing', () => {
    expect(looksLikeToolFailure(EVIDENCE_REQUIRED(CLOSED_TICKET))).toBe(true);
    const offered = ['run_command', 'update_feedback', 'update_document'];
    // cec340f2 / ddd26be0-F83 shape: narration names a DIFFERENT offered tool.
    expect(detectIntendedTool(ufTurn(1).reasoning, 'update_feedback', offered)).toBe('run_command');
    expect(detectIntendedTool(ghostTurn(1).reasoning, 'refresh_digest', offered)).toBe('run_command');
    // Bare ungrounded refusal shape: narration names the CALLED tool ⇒ no
    // intent mismatch ⇒ no re-anchor (containment, the 0c0ce759 close).
    expect(detectIntendedTool(ungroundedUfTurn(1).reasoning, 'update_feedback', offered)).toBeNull();
    expect(detectIntendedTool(faithfulUfTurn(1).reasoning, 'update_feedback', offered)).toBeNull();
  });

  it('REPLAY leg (b) + recovery: the FIRST intent-mismatch injects exactly ONE harness-attributed steer and the run finishes CLEAN — the breaker never trips', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1)) // failure + intent ⇒ steer (count 2 < 3, no trip)
      .mockResolvedValueOnce(planTurn(2)) // the steered recovery: a real offered tool succeeds
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    expect(result.finalText).toContain('Checklist done.');
    expect(result.modelErrored).toBeUndefined();

    // Exactly ONE steer, harness-attributed, naming the intended tool and
    // restating the toolset.
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named run_command');
    expect(steer).toContain('call run_command NOW');
    expect(steer).toContain('Your ACTUAL tool list for the rest of this run is exactly:');
    expect(steer).toContain('run_command');

    // Attribution surfaces: guard-marked transcript part, progress stage,
    // telemetry seam.
    const part = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes('Re-anchor steer injected'));
    expect(part).toBeDefined();
    expect(part!.marker).toBe('guard');
    expect(part!.text).toContain('update_feedback');
    expect(part!.text).toContain('reasoning named run_command');
    const stages = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'progress').map((c) => c[1]?.stage);
    expect(stages).toContain('derail-reanchor');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_feedback', intended: 'run_command', reason: 'intent_mismatch' });

    // The breaker NEVER engaged: no withhold/perma/terminal rows, no filings.
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });

  it('REPLAY leg (a): a GENUINELY nonexistent tool name injects the same ONE steer (reason tool_not_offered) and the run recovers', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ghostTurn(1)) // tool_not_offered refusal + intent ⇒ steer
      .mockResolvedValueOnce(planTurn(2))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('no tool named refresh_digest exists in this session');
    expect(steer).toContain('call run_command NOW');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'refresh_digest', intended: 'run_command', reason: 'tool_not_offered' });
    expect(breakerMetrics()).toHaveLength(0);
  });

  it('REPLAY the one-per-run bound across PR #898\'s terminal sequence: {update_feedback:2, update_document:1} trips end the run with the EXACT incident note — the steer fired ONCE and changed nothing', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1)) // steer HERE (count 2)
      .mockResolvedValueOnce(ufTurn(2)) // count 4 ⇒ TRIP 1 (one-round ban) — NO second steer
      .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
      .mockResolvedValueOnce(ufTurn(4)) // count 2
      .mockResolvedValueOnce(ufTurn(5)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
      .mockResolvedValueOnce(udTurn(6, CLOSED_TICKET)) // count 2
      .mockResolvedValueOnce(udTurn(7, 'noop')) // count 4 ⇒ TRIP 3 ⇒ TERMINAL
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The terminal path is PR #898's, UNCHANGED: same 7 turns, same note.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    expect(result.modelErrored).toBeUndefined();
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', trips: 3, intended: 'run_command' });

    // The steer fired EXACTLY ONCE across the whole derailment — every later
    // derail signature proceeded through the breaker only.
    expect(steerMessages()).toHaveLength(1);
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_feedback', intended: 'run_command', reason: 'intent_mismatch' });
    // The guard-marked re-anchor part precedes the terminal note.
    const raIdx = result.parts.findIndex((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes('Re-anchor steer injected'));
    const endIdx = result.parts.findIndex((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(raIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(raIdx);
  });

  it('BOUNDARY: a BARE ungrounded-id refusal (faithful narration — the 0c0ce759 containment shape) NEVER fires the steer', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ungroundedUfTurn(1)) // ungrounded refusal, NO intent mismatch
      .mockResolvedValueOnce(planTurn(2))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0); // count 2 < 3 — no trip either
  });

  it('BOUNDARY: re-calling a breaker-WITHHELD tool NEVER fires the steer (the breaker notice already covers it)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(faithfulUfTurn(1)) // faithful failures: +1 each, no intent
      .mockResolvedValueOnce(faithfulUfTurn(2))
      .mockResolvedValueOnce(faithfulUfTurn(3)) // count 3 ⇒ TRIP 1 (one-round ban)
      .mockResolvedValueOnce(faithfulUfTurn(4)) // withheld ⇒ tool_not_offered with the withheld hint
      .mockResolvedValueOnce(planTurn(5))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(0);
    expect(reanchorMetrics()).toHaveLength(0);
    // The breaker itself worked exactly as before: one withhold trip.
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'update_feedback', perma: false });
  });

  it('REPLAY leg (c) cross-tool: a faithful placeholder refusal (source 1) then a faithful update_document placeholder (source 2) = the STREAK signature — ONE steer, no breaker trip', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ungroundedUfTurn(1)) // source 1, tally 1 — NO steer (ordinary containment)
      .mockResolvedValueOnce(faithfulUdTurn(2, 'noop')) // source 2, tally 2 ⇒ STEER
      .mockResolvedValueOnce(planTurn(3))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('invented entity id ("noop")');
    expect(steer).toContain('invented-id refusal #2 this run');
    expect(steer).toContain('Entity ids come ONLY from real tool results this run');
    expect(steer).toContain('Your ACTUAL tool list for the rest of this run is exactly:');
    const part = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.includes('Re-anchor steer injected'));
    expect(part).toBeDefined();
    expect(part!.text).toContain('placeholder-id streak on update_document');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_document', reason: 'placeholder_streak', count: 2 });
    expect(breakerMetrics()).toHaveLength(0); // cross-tool streak: per-tool tallies stay below the trip
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });

  it('REPLAY leg (c) doc-seam only: TWO faithful update_document placeholders fire the steer on the SECOND (the first is ordinary containment)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(faithfulUdTurn(1, 'noop')) // tally 1 — NO steer
      .mockResolvedValueOnce(faithfulUdTurn(2, 'zzz_missing_file')) // tally 2 ⇒ STEER
      .mockResolvedValueOnce(planTurn(3))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    expect(steerMessages()).toHaveLength(1);
    expect(String(steerMessages()[0].content)).toContain('invented entity id ("zzz_missing_file")');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'update_document', reason: 'placeholder_streak', count: 2 });
    expect(breakerMetrics()).toHaveLength(0); // two faithful failures: per-tool count 2 < 3
  });
});
