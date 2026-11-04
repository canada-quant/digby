/**
 * Replay pin — tickets b305c23e + ff48c6f7 + 0aecbe92 (ONE composite incident,
 * session 10cb988f-6e80-4d3a-9e59-9e8fc83c93ae "Repository Duplicates and
 * Documentation Update", project CanLaw, kimi-k3, run 637592bc-3ffe-42c2-
 * b916-49241f4878e3, scheduled firing 95 of 2026-09-20 06:40:41Z).
 *
 * THE INCIDENT (three tickets, one run): the lane derailed SECONDS into a
 * shell-checklist firing (7 plan steps, zero executed) and produced:
 *   · b305c23e (filed 06:42:18Z): '3× tool-failure streak: update_feedback'
 *     with TWO failure texts — the 18086326 machine-mutation gate's
 *     evidence_required envelope for ticket d0597e02, retried identically;
 *   · ff48c6f7 (filed 06:44:15Z): '3× tool-failure streak: update_document'
 *     with TWO failure texts — "No generated file with id d0597e02 / noop
 *     belongs to this user" (the lane fed a TICKET id to the document tool);
 *   · 0aecbe92 (agent-filed 06:54:54Z, priority 2): the umbrella report —
 *     the run ended 06:44:15Z with "[HARNESS] Run ended: repeated wrong-tool
 *     derailment (3 episodes; intended tool appears to be run_command)", and
 *     the supervisor-steered recovery run (06:49:55Z trigger) ended 06:51:02Z
 *     with the SAME note — TWO consecutive runs, zero steps, the live case
 *     for ticket 78f32515's lane-facing breaker notice.
 *
 * EPISODE ARITHMETIC (why the note says 3): update_feedback tripped TWICE
 * (second trip = perma; its filing was swallowed by reflection.ts's 24h
 * (session,tool) NX dedupe — which is why no THIRD ticket exists for this
 * run) + update_document tripped ONCE = derailTripCounts {uf:2, ud:1} →
 * total 3 → run end (agent.ts:3226-3230).
 *
 * WHAT ACTUALLY HAPPENED (adjudication against the lane's live transcript,
 * 2026-09-20): the lane's firing-95 prompt carried a TERMINAL-STOP notice
 * naming CLOSED ticket d0597e02 ("do NOT re-audit, re-close…") — the echo
 * grounded the id (the 00667344 verbatim-occurrence mechanism), so the calls
 * EXECUTED into the dispatch gate and the existence check instead of dying in
 * the pre-flight. No probe intent is documented; the same session ran the
 * identical checklist cleanly ~4h earlier (firing 94, 02:46Z) and again after
 * re-seat. This is the placeholder-emission / cross-tool confusion class
 * (learnings.md 2026-09-20): reasoning names run_command while the emitter
 * produces update_feedback/update_document with fabricated or cross-wired
 * ids. NOT a framework garble — a garble would carry the intended call's
 * real args (a shell command string).
 *
 * VERDICT (the tickets' mandated investigation): MODEL BEHAVIOR. Every
 * deterministic seam behaved as designed; the filed texts diff clean against
 * current framework code:
 *   · the dispatch-gate refusal template is platform-tools.ts:3609 verbatim
 *     (the filed texts truncate mid-word at the filing's 500-char slice,
 *     reflection.ts:118 — this replay pins the FULL envelope);
 *   · "No generated file with id X belongs to this user." is
 *     tool-executor.ts:712/780/875 verbatim, and post-PR-#895 those existence
 *     refusals count as failures for the breaker — by design;
 *   · the weighted arithmetic (+1 refusal, +1 intent fast-trip) and the
 *     2-tools/3-episodes run-end are agent.ts:3171-3230 as built.
 * NO platform code change.
 *
 * Scaffold mirrors agent-derail-break.aff1c189.test.ts +
 * agent-derail-break.718a04a5.test.ts (ToolCache document seam) + the
 * intent-stub seam of agent-derail-break.87d1e421.test.ts.
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

// The platform-tool seam: update_feedback dispatches via executeCodingTool —
// stub it to answer the 18086326 machine-mutation gate's evidence_required
// envelope for the not-dispatched ticket d0597e02 (the REAL gate's output in
// the incident, pinned against platform-tools.ts:3609; the filed ticket texts
// truncate at the filing's 500-char slice, this is the full envelope).
const GATE_ENVELOPE = JSON.stringify(
  {
    ok: false,
    tool: 'update_feedback',
    reason: 'evidence_required',
    ticketId: 'd0597e02',
    message:
      'This machine-triggered run may NOT mutate feedback ticket d0597e02: the ticket is not dispatched to this session ' +
      '(its context.dispatchedTo names another session) and no verifiable evidence was supplied. Dispatch binding is the sanctioned path — ' +
      'a dispatched lane works its OWN tickets (in_progress/adminNote/priority) without the artifact bar; without binding the evidence bar ' +
      'applies to EVERY status, not just done. If the ticket needs triage you cannot evidence, leave it for its dispatched lane or record a file_feedback sighting instead.',
  },
  null,
  1,
);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string) => {
  if (name === 'update_feedback') return GATE_ENVELOPE;
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document-tool seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES), not executeCodingTool. Keep the REAL TOOL_DEFINITIONS
// (the offered-tool list is built from it); stub only the executor instance
// to answer tool-executor.ts's honest existence refusal (712/780/875).
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 12,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim ids ─────────────────────────────────────────────
const TICKET_ID = 'd0597e02'; // the CLOSED ticket the terminal-stop notice named (echo-grounded)
const PLACEHOLDER_ID = 'noop'; // the model-authored placeholder for update_document

/** The firing-95 brief — carries BOTH ids verbatim, mirroring the real run:
 *  the terminal-stop notice named d0597e02 (echo → dispatch-gate execution)
 *  and the lane narrated "noop" before emitting it (echo → existence check).
 *  The grounding preflight therefore PASSES both calls, exactly as filed. */
const BRIEF = [
  '[DOCS-KEEPER firing — shell checklist]',
  '[TERMINAL-STOP — harness-verified at fire time] This firing\'s prompt',
  'references feedback ticket(s) that are already CLOSED (status=done):',
  'd0597e02 · \'Evidence guard: machine run asserted unproven completions\' —',
  'do NOT re-audit, re-probe, or re-close that work; a noop mutation attempt',
  'on it is not evidence. Cite this notice and spend the firing on OPEN work.',
  'Shell steps (git fetch, ls-remote, grep, node --test) go through run_command.',
].join('\n');

/** Stub so the REAL detectIntendedTool sees run_command as offered (it was a
 *  live offered tool in the lane's coding-profile run; the chat test profile
 *  does not offer workspace tools — the extraTools seam, agent.ts:967). */
const RUN_COMMAND_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'shell ok'),
};

/** Intent-convicted turn: reasoning names run_command (whole word, NEVER the
 *  called tool) — the REAL detectIntendedTool convicts (+1 fast-trip,
 *  agent.ts:3181-3183), exactly the tickets' "reasoning named run_command". */
const INTENT_REASONING =
  'Starting the checklist — run_command with date -u and git fetch origin --prune is the first shell step.';
/** Plain turn: reasoning names the called tool — no intent weight. */
const mkTurn = (n: number, tool: string, args: any, intent: boolean) => ({
  content: '',
  reasoning: intent
    ? INTENT_REASONING
    : `${tool} call ${n}: record the bookkeeping for id ${args.id ?? args.fileId}.`,
  toolCalls: [{ id: `t${n}`, name: tool, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'unreachable — the derail breaker must end the run first', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-b305c23e-test',
  sessionId: 'sess-b305c23e',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the checklist now.`,
  emit: jest.fn(),
  extraTools: [RUN_COMMAND_STUB],
});

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay b305c23e + ff48c6f7 + 0aecbe92 — the CanLaw composite derailment (one run, three tickets)', () => {
  it('END-TO-END: the incident\'s exact turn sequence files b305c23e (uf, 2 evidence_required texts), a deduped perma uf trip, and ff48c6f7 (ud, 2 existence texts) — then ends the run at 3 episodes naming run_command', async () => {
    mockRunModelTurn
      // episode arithmetic: t1 +2 (refusal+intent) → t2 +1 = 3 → TRIP1-uf (withhold 1 round, filing b305c23e)
      .mockResolvedValueOnce(mkTurn(1, 'update_feedback', { id: TICKET_ID }, true))
      .mockResolvedValueOnce(mkTurn(2, 'update_feedback', { id: TICKET_ID }, false))
      // t3 ud +2 (uf withheld this round) → t4 uf back: tool switch resets, +2 → t5 +1 = 3 → TRIP2-uf (PERMA; filing deduped in production)
      .mockResolvedValueOnce(mkTurn(3, 'update_document', { fileId: TICKET_ID }, true))
      .mockResolvedValueOnce(mkTurn(4, 'update_feedback', { id: TICKET_ID }, true))
      .mockResolvedValueOnce(mkTurn(5, 'update_feedback', { id: TICKET_ID }, false))
      // t6 ud switch resets, +2 → t7 +1 = 3 → TRIP1-ud (filing ff48c6f7) → trips {uf:2, ud:1} → RUN END at 3 episodes
      .mockResolvedValueOnce(mkTurn(6, 'update_document', { fileId: PLACEHOLDER_ID }, true))
      .mockResolvedValueOnce(mkTurn(7, 'update_document', { fileId: TICKET_ID }, false))
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    // ── b305c23e: the first filing carries EXACTLY the ticket's two evidence_required texts, intended=run_command
    expect(mockFileStreakInvestigation.mock.calls.length).toBeGreaterThanOrEqual(3);
    const ufFirst = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ufFirst.tool).toBe('update_feedback');
    expect(ufFirst.perma).toBe(false);
    expect(ufFirst.intended).toBe('run_command');
    expect(ufFirst.recentFailures).toHaveLength(2);
    for (const text of ufFirst.recentFailures) {
      const env = JSON.parse(text);
      expect(env).toMatchObject({ ok: false, tool: 'update_feedback', reason: 'evidence_required', ticketId: TICKET_ID });
      expect(env.message).toContain('may NOT mutate feedback ticket d0597e02');
      expect(env.message).toContain('not dispatched to this session');
    }

    // ── the second update_feedback trip is PERMA — in production its filing
    // was swallowed by the 24h (session,tool) NX dedupe, which is why run
    // 637592bc produced exactly TWO tickets for THREE episodes.
    const ufSecond = mockFileStreakInvestigation.mock.calls[1][0];
    expect(ufSecond.tool).toBe('update_feedback');
    expect(ufSecond.perma).toBe(true);

    // ── ff48c6f7: the update_document filing carries the ticket's two
    // existence-refusal texts NEWEST-FIRST (chronological: noop, then d0597e02
    // — the lane fed the TICKET id to the document tool last).
    const ud = mockFileStreakInvestigation.mock.calls[2][0];
    expect(ud.tool).toBe('update_document');
    expect(ud.perma).toBe(false);
    expect(ud.intended).toBe('run_command');
    expect(ud.recentFailures).toHaveLength(2);
    expect(ud.recentFailures[0]).toBe(`No generated file with id ${TICKET_ID} belongs to this user. Call list_files to see the current files.`);
    expect(ud.recentFailures[1]).toBe(`No generated file with id ${PLACEHOLDER_ID} belongs to this user. Call list_files to see the current files.`);

    // ── 0aecbe92: the run ends with the verbatim harness note the umbrella
    // ticket quotes — 3 episodes (uf×2 + ud×1), intended run_command.
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes; intended tool appears to be run_command)');
    expect(result.parts.some((p: any) => p.marker === 'guard' && typeof p.text === 'string'
      && p.text.includes('repeated wrong-tool derailment (3 episodes'))).toBe(true);
    // The FINAL turn was never consumed — the breaker ended the run.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
  });

  it('wiring seam: the gate refusal counts as failure-shaped and update_feedback stays preflight-covered', () => {
    // The incident's envelope is the REAL gate's output shape (platform-tools.ts:3609).
    const env = JSON.parse(GATE_ENVELOPE);
    expect(env.reason).toBe('evidence_required');
    expect(env.message).toContain('Dispatch binding is the sanctioned path');
  });
});
