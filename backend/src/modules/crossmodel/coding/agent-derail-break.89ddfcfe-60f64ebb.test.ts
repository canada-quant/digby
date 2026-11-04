/**
 * Replay pin — tickets 89ddfcfe + 60f64ebb (mishaps, auto-filed at breaker
 * trips 2026-09-21T01:34:56Z and 2026-09-21T01:37:22Z). TWO more occurrences
 * of the documented kimi-k3 placeholder-emission wrong-tool derail class
 * (f839cede/aff1c189/ec9d7424 → c35162ee → 54121353/83297404 → d50a6300 →
 * afac4aee+769d7278 → 099bd00a → 0c9f2420), BOTH on the update_document
 * document seam.
 *
 * INCIDENT A (89ddfcfe): session 00f9baab-dd7d-41e9-b031-4b77b43146ca, run
 * fe1ae70b-a61d-4138-a044-3154d2d80a24 — a POST-CLOSE tail loop: the lane had
 * already finished its real adjudication work (plan 9/9: c562f895 + c2b3084d
 * closed; chat archived with zero pending work — get_chat_status
 * 2026-09-21T01:54:58Z) when it emitted THREE update_document calls carrying
 * the placeholder literal fileId "placeholder" while its reasoning named
 * get_feedback. All three drew the executor's existence/ownership refusal
 * (tool-executor.ts:712/780/875), byte-identical ×3. Zero side effects.
 *
 * INCIDENT B (60f64ebb): session cec340f2-f605-4370-b87a-d85b59cb243f, run
 * 9f3f55af-cfcc-4047-a80c-a39b90623217 — the CanLaw "Re-Send Path C Phase 2
 * Kickoff" lane emitted THREE update_document calls with FABRICATED ids,
 * literal drift mid-streak (chronologically noop → x → x; the ticket lists
 * them newest-first: x, x, noop). NO intended-tool conviction (the ticket
 * carries no "reasoning named" line — detectIntendedTool returned null).
 * All three drew the identical executor refusal. THE REAL WORK SURVIVED:
 * the lane kept running its firing-77 teacher-generation plan (3/6 steps
 * completed, coding.status running, schedule enabled with next fire
 * 01:58:31Z — get_chat_status 2026-09-21T01:37:23Z, 1.2s AFTER the filing).
 *
 * VERDICT (both tickets' mandated investigation): MODEL BEHAVIOR, no
 * framework defect, NO code change:
 *   · every filed text diffs byte-clean against the current executor
 *     refusal — deterministic, side-effect-free, with the list_files
 *     recovery line;
 *   · update_document rides the ToolCache/WEB document seam and is NOT in
 *     PLATFORM_TOOL_NAMES BY DESIGN, so the ungrounded-id preflight never
 *     applies — the executor's ownership gate is the deterministic backstop
 *     and it held on all six calls across the two incidents;
 *   · containment fired end-to-end in both: failure-shaped refusals →
 *     3× tool-failure streak trip → harness auto-filed each ticket.
 *
 * NEW FACETS pinned here vs the sibling pins:
 *   · placeholder literals now observed: "__none__", "none", "placeholder",
 *     "noop", and the single character "x";
 *   · the DEGENERATE grounding case: a 1-char value like "x" WAS substring-
 *     grounded by ANY English haystack ("executor", "exists", "next"…) until
 *     the wave/final merge (2026-09-27): findUngroundedIdArgs now grounds a
 *     value only as a WHOLE token (the same fix that stopped "noop" reading
 *     as grounded inside `supervisor_turn_noop`), so "x" is flagged unless
 *     the model read a standalone "x"; the executor gate stays the
 *     deterministic backstop on this seam (update_document is not
 *     preflight-gated at all);
 *   · a streak can DRIFT literals mid-run (noop → x) and the filing's
 *     recentFailures window still accumulates them newest-first;
 *   · a streak can carry NO intent conviction (narration naming nothing
 *     offered) — the breaker trips on the failure streak alone.
 *
 * Scaffold mirrors agent-derail-break.099bd00a.test.ts (#930).
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

// Every coding-executor tool succeeds harmlessly in this replay — the
// incidents' emissions all rode the document seam below; the probes the
// narrations named were NEVER emitted (asserted).
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document-tool seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES), not executeCodingTool. Stub only the executor instance to
// answer tool-executor.ts's honest existence refusal (712/780/875).
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

import { runCodingAgent, WEB_TOOL_NAMES } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { findUngroundedIdArgs } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile: get_feedback (incident A's narration-named tool) is in the
 *  offered schema — the intended tool must be offerable for the intent
 *  conviction to name it (the 0aecbe92 precedent). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incidents' verbatim placeholder literals + filed texts ─────────────
const PH_ID = 'placeholder'; // incident A (ticket 89ddfcfe) — ×3 identical
const X_ID = 'x'; // incident B (ticket 60f64ebb) — the single-character fabrication
const NOOP_ID = 'noop'; // incident B — the streak's first literal (drifted to 'x')
const refusalText = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const PH_TEXT = refusalText(PH_ID);
const X_TEXT = refusalText(X_ID);
const NOOP_TEXT = refusalText(NOOP_ID);

/** A ticket-investigation brief carrying NONE of the placeholder literals
 *  (and no generated-file id), so every update_document emission is an
 *  invention the ownership gate refuses. */
const BRIEF = [
  '[TICKET WATCH — adjudication firing]',
  'PROBE: pull the ticket row with get_feedback, then record the',
  'attribution. No document writes are part of this job.',
].join('\n');

/** Incident A emission: update_document carrying the "placeholder" literal —
 *  the reasoning names get_feedback (whole word, never the called tool), the
 *  ticket's "lane's reasoning named get_feedback". */
const udPhTurn = (n: number) => ({
  content: '',
  reasoning: 'get_feedback is the read that settles the ticket state — pulling the row now before any write.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: PH_ID, content: 'adjudication note' }) }],
  finishReason: 'tool_calls',
});
/** Incident B emissions: fabricated ids with narration naming NOTHING offered
 *  (the ticket carries no "reasoning named" line — no intent conviction). */
const udNoopTurn = (n: number) => ({
  content: '',
  reasoning: 'Refreshing the reconciled digest now — the figures are final.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: NOOP_ID, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const udXTurn = (n: number) => ({
  content: '',
  reasoning: 'Writing the final summary file in one go.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: X_ID, content: 'final summary' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-doc-streaks-test',
  sessionId: 'sess-doc-streaks',
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

const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('tickets 89ddfcfe + 60f64ebb — update_document placeholder streaks ("placeholder" ×3; fabricated "noop"/"x" with mid-streak drift)', () => {
  it('the multi-char literals are ungrounded against the run haystack (non-hex; appear nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ fileId: PH_ID }, BRIEF))
      .toEqual([{ key: 'fileId', value: PH_ID }]);
    expect(findUngroundedIdArgs({ fileId: NOOP_ID }, BRIEF))
      .toEqual([{ key: 'fileId', value: NOOP_ID }]);
  });

  it('the DEGENERATE case: a 1-char literal ("x") is grounded only as a WHOLE token since the wave/final merge (2026-09-27) — "executor"/"exists"/"next" no longer ground it; a standalone "x" the model read still does; the executor ownership gate remains the backstop on this seam', () => {
    // An x-free haystack flags it (proves the mechanism, not the shape):
    expect(findUngroundedIdArgs({ fileId: X_ID }, 'Pull the ticket row; record the attribution.'))
      .toEqual([{ key: 'fileId', value: X_ID }]);
    // A realistic haystack carries "x" only INSIDE words ("executor", "exists",
    // "next") — glued inside an identifier is not a verbatim read ⇒ flagged.
    const REALISTIC = 'the executor probe exists; check the next step';
    expect(REALISTIC).toContain(X_ID);
    expect(findUngroundedIdArgs({ fileId: X_ID }, REALISTIC)).toEqual([{ key: 'fileId', value: X_ID }]);
    // The literal as its own token (the model actually read "x") is grounded.
    expect(findUngroundedIdArgs({ fileId: X_ID }, 'axis x = 1; the executor exists')).toEqual([]);
  });

  it('both tickets\' filed texts are byte-exact the executor existence-refusal format with their literals (the deterministic ownership gate — no framework drift)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: PH_ID })).toBe(PH_TEXT);
    expect(await mockToolCacheExec('update_document', { fileId: X_ID })).toBe(X_TEXT);
    expect(await mockToolCacheExec('update_document', { fileId: NOOP_ID })).toBe(NOOP_TEXT);
  });

  it('wiring seam: update_document rides the ToolCache/WEB document seam (NEVER the platform list, so the ungrounded-id pre-flight does not gate it — the ownership gate is the designed backstop)', () => {
    expect(WEB_TOOL_NAMES.has('update_document')).toBe(true);
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
  });

  it('END-TO-END incident A (89ddfcfe): the straight-sequence ladder — two executions draw the byte-exact "placeholder" refusals, the first derail trip files ONE streak report (intended get_feedback), and the one-round ban withholds the third emission — zero junk writes', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(udPhTurn(1)) // EXECUTES → refusal 1
      .mockResolvedValueOnce(udPhTurn(2)) // EXECUTES → refusal 2 ⇒ TRIP 1 (one-round ban) ⇒ the auto-filing
      .mockResolvedValueOnce(udPhTurn(3)) // WITHHELD by the one-round ban (tool_not_offered)
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput(`${BRIEF}\nRun the adjudication tick now.`));

    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const udFilings = filings.filter((f) => f.tool === 'update_document');
    expect(udFilings).toHaveLength(1);
    expect(udFilings[0].recentFailures).toEqual([PH_TEXT, PH_TEXT]);
    expect(udFilings[0].intended).toBe('get_feedback');

    const breaks = strikes('tool_derail_break');
    expect(breaks.some((m) => m.meta.tool === 'update_document' && m.meta.perma === false && m.meta.intended === 'get_feedback')).toBe(true);

    const preflight = strikes('tool_preflight');
    expect(preflight.filter((m) => m.meta.reason === 'ungrounded_id')).toHaveLength(0);
    expect(preflight.filter((m) => m.meta.reason === 'tool_not_offered' && m.meta.tool === 'update_document')).toHaveLength(1);

    const docExecs = mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document');
    expect(docExecs).toHaveLength(2);
    expect(docExecs.every((c) => String(c[1]?.fileId ?? '') === PH_ID)).toBe(true);
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'get_feedback')).toBe(false);
    expect(result.finalText).toBe('Tick closed.');
    expect(result.modelErrored).toBeUndefined();
  });

  it('END-TO-END incident B (60f64ebb): literal DRIFT mid-streak (noop → x → x) with NO intent conviction — the filing\'s recentFailures window accumulates all three byte-exact refusals newest-first, exactly the ticket\'s texts', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(udNoopTurn(1)) // EXECUTES → refusal (noop) — the streak's first literal
      .mockResolvedValueOnce(planTurn(2)) // a succeeding turn between failures (the real run's interleave)
      .mockResolvedValueOnce(udXTurn(3)) // EXECUTES → refusal (x) — drifted literal
      .mockResolvedValueOnce(udXTurn(4)) // EXECUTES → refusal (x) ⇒ TRIP 1 ⇒ the auto-filing
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput(`${BRIEF}\nRun the kickoff tick now.`));

    // ONE filing ("first streak this run") carrying all three refusal texts
    // newest-first — the ticket's exact evidence list (x, x, noop).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const udFilings = filings.filter((f) => f.tool === 'update_document');
    expect(udFilings).toHaveLength(1);
    expect(udFilings[0].recentFailures).toEqual([X_TEXT, X_TEXT, NOOP_TEXT]);
    // NO intent conviction: the narration named nothing offered — the ticket
    // carries no "reasoning named" line; the breaker tripped on the failure
    // streak alone.
    expect(udFilings[0].intended ?? null).toBeNull();

    // Three executions, ids in emission order noop → x → x; no generated file
    // was mutated (the mock answers refusals only).
    const docExecs = mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document');
    expect(docExecs.map((c) => String(c[1]?.fileId ?? ''))).toEqual([NOOP_ID, X_ID, X_ID]);
    expect(strikes('tool_preflight').filter((m) => m.meta.reason === 'ungrounded_id')).toHaveLength(0);
    expect(result.modelErrored).toBeUndefined();
  });
});
