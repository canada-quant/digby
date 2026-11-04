/**
 * Replay pin — ticket 099bd00a (mishap, auto-filed at breaker trip
 * 2026-09-21T00:57:16Z; session 539d8432-551e-47a7-9a65-4835d6a33a01, run
 * 1255636b-9765-4404-9c48-fb5629f646f2; "first streak this run").
 *
 * THE INCIDENT: the lane was working its own dispatched placeholder-derail
 * adjudication ("Ticket afac4aee addf 41f7 804b" per the ticket-row title) —
 * the job that turn was a fleet-telemetry PROBE (the ticket records "lane's
 * reasoning named get_fleet_telemetry"). Instead the decoder locked onto the
 * wrong-tool family and the run produced THREE update_document emissions
 * carrying the bare placeholder fileId "none", each EXECUTING into the
 * document executor's deterministic existence/ownership refusal
 * (tool-executor.ts:712/780/875). The ticket's three filed failure texts
 * (newest first) are byte-identical:
 *   · No generated file with id none belongs to this user. Call list_files
 *     to see the current files.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the
 * documented kimi-k3 placeholder-emission wrong-tool derail class
 * (f839cede/aff1c189/ec9d7424 → c35162ee → 54121353/83297404 → d50a6300 →
 * afac4aee+769d7278), NOT a framework defect:
 *   · the filed texts diff byte-clean against the current executor refusal
 *     format — deterministic, side-effect-free (no generated file mutated),
 *     each carrying the list_files recovery line;
 *   · update_document rides the ToolCache/WEB document seam and is NOT in
 *     PLATFORM_TOOL_NAMES BY DESIGN, so the coding loop's ungrounded-id
 *     preflight (agent.ts tool_preflight) never applies to it — the
 *     executor's ownership gate is the deterministic backstop and it held on
 *     all three calls (the afac4aee-769d7278 pin's seam split, same design);
 *   · the containment chain fired as designed: failure-shaped refusals →
 *     the 3× tool-failure streak trip → this very ticket auto-filed by the
 *     harness (source agent-harness).
 * NO platform code change.
 *
 * NEW vs the afac4aee+769d7278 pin (#928): the SAME bare literal 'none' on
 * the document leg, but (a) the streak here is SINGLE-TOOL — three
 * update_document emissions, no update_feedback leg — and (b) the intended
 * tool the narration named is get_fleet_telemetry (a fleet-telemetry PROBE),
 * not run_command. Pin that variant: the e2e ladder below runs the
 * document-seam executions, expects ONE streak filing carrying the byte-exact
 * refusals with intended get_fleet_telemetry, ZERO tool_preflight rows (the
 * document seam is never preflight-gated), and zero junk document writes.
 *
 * Scaffold mirrors agent-derail-break.afac4aee-769d7278.test.ts (#928).
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
// incident's emissions all rode the document seam below; the probe the
// narration named (get_fleet_telemetry) was NEVER emitted (asserted).
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

/** CODING profile (the incident lane's profile): get_fleet_telemetry is in
 *  the offered schema — the incident's intended tool must be offerable for
 *  the intent conviction to name it (the 0aecbe92 precedent). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim placeholder literal + filed text ───────────────
const UD_ID = 'none'; // the BARE literal (non-hex, 4 chars) carried as fileId on every emission
const EXISTENCE_TEXT =
  'No generated file with id none belongs to this user. Call list_files to see the current files.';

/** The lane's job that turn (per the ticket-row title "Ticket afac4aee addf
 *  41f7 804b"): adjudication probes on its dispatched mishap. The brief
 *  carries NEITHER the placeholder literal NOR any generated-file id, so
 *  every update_document('none') emission is an invention the ownership gate
 *  refuses. */
const BRIEF = [
  '[TICKET afac4aee — adjudication watch]',
  'PROBE: pull the lane guard rows with get_fleet_telemetry, then record the',
  'attribution. No document writes are part of this job.',
].join('\n');

/** A wrong-tool update_document emission carrying the BARE 'none' literal as
 *  fileId — update_document is NOT platform-gated, so the call EXECUTES into
 *  the ownership gate (the 099bd00a refusal). The reasoning names
 *  get_fleet_telemetry (whole word, never the called tool) — the ticket's
 *  "lane's reasoning named get_fleet_telemetry". */
const udTurn = (n: number) => ({
  content: '',
  reasoning: 'get_fleet_telemetry is the read that settles the guard-row question — pulling the metrics view now before any write.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: UD_ID, content: 'adjudication note' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch that consumes the
 *  one-round withhold so the NEXT document emission executes again. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-099bd00a-test',
  sessionId: 'sess-099bd00a',
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

describe('ticket 099bd00a — 3× update_document "none" placeholder streak while the narration named get_fleet_telemetry', () => {
  it('the bare literal is ungrounded against the run haystack (non-hex; appears nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ fileId: UD_ID }, BRIEF))
      .toEqual([{ key: 'fileId', value: UD_ID }]);
  });

  it('the ticket\'s filed texts are byte-exact the executor existence-refusal format with the bare literal (the deterministic ownership gate — no framework drift)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: UD_ID })).toBe(EXISTENCE_TEXT);
  });

  it('wiring seam: update_document rides the ToolCache/WEB document seam (NEVER the platform list, so the ungrounded-id pre-flight does not gate it — the ownership gate is the designed backstop)', () => {
    expect(WEB_TOOL_NAMES.has('update_document')).toBe(true);
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
  });

  it('END-TO-END the straight-sequence ladder: two executions draw the byte-exact refusals, the first derail trip files ONE streak report (intended get_fleet_telemetry), and the one-round ban withholds the third emission — zero junk writes', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(udTurn(1)) // EXECUTES → refusal 1 (its 'none' echo joins the haystack)
      .mockResolvedValueOnce(udTurn(2)) // EXECUTES → refusal 2 ⇒ TRIP 1 (one-round ban) ⇒ the auto-filing
      .mockResolvedValueOnce(udTurn(3)) // WITHHELD by the one-round ban (tool_not_offered) — never reaches the executor
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput(`${BRIEF}\nRun the adjudication tick now.`));

    // ONE fileStreakInvestigation call ("first streak this run") carrying the
    // byte-exact executor refusals (newest first), with the intent conviction
    // naming the probe the reasoning promised.
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const udFilings = filings.filter((f) => f.tool === 'update_document');
    expect(udFilings).toHaveLength(1);
    expect(udFilings[0].recentFailures).toEqual([EXISTENCE_TEXT, EXISTENCE_TEXT]);
    expect(udFilings[0].intended).toBe('get_fleet_telemetry');

    // The derail row: the first trip on the tool is the one-round ban (perma:false).
    const breaks = strikes('tool_derail_break');
    expect(breaks.some((m) => m.meta.tool === 'update_document' && m.meta.perma === false && m.meta.intended === 'get_fleet_telemetry')).toBe(true);

    // Preflight: ZERO ungrounded_id rows (the document seam is never
    // preflight-gated) and exactly ONE tool_not_offered row — the ban
    // withholding the third emission.
    const preflight = strikes('tool_preflight');
    expect(preflight.filter((m) => m.meta.reason === 'ungrounded_id')).toHaveLength(0);
    expect(preflight.filter((m) => m.meta.reason === 'tool_not_offered' && m.meta.tool === 'update_document')).toHaveLength(1);

    // Two executions, both into the ownership gate with the placeholder; no
    // generated file was mutated (the mock answers refusals only) and
    // get_fleet_telemetry was NEVER emitted — the wrong-tool signature.
    const docExecs = mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document');
    expect(docExecs).toHaveLength(2);
    expect(docExecs.every((c) => String(c[1]?.fileId ?? '') === UD_ID)).toBe(true);
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'get_fleet_telemetry')).toBe(false);
    expect(result.finalText).toBe('Tick closed.'); // the first trip bans one round; it does NOT end the run
    expect(result.modelErrored).toBeUndefined();
  });

  it('the incident\'s THIRD identical text: once the one-round ban is consumed, the next emission EXECUTES and draws the byte-identical refusal — the 3-text filing shape the ticket records', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(udTurn(1)) // EXECUTES → refusal 1
      .mockResolvedValueOnce(udTurn(2)) // EXECUTES → refusal 2 ⇒ TRIP 1 (ban) ⇒ filing
      .mockResolvedValueOnce(planTurn(3)) // the ban round consumed by a harmless success
      .mockResolvedValueOnce(udTurn(4)) // EXECUTES → refusal 3, byte-identical (the ticket's third text)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput(`${BRIEF}\nRun the adjudication tick now.`));

    const docIdx = mockToolCacheExec.mock.calls
      .map((c, i) => (c[0] === 'update_document' ? i : -1))
      .filter((i) => i >= 0);
    expect(docIdx).toHaveLength(3);
    expect(docIdx.every((i) => String(mockToolCacheExec.mock.calls[i][1]?.fileId ?? '') === UD_ID)).toBe(true);
    for (const i of docIdx) {
      expect(mockToolCacheExec.mock.results[i].type).toBe('return');
      await expect(mockToolCacheExec.mock.results[i].value).resolves.toBe(EXISTENCE_TEXT);
    }
    // Still exactly ONE first-streak filing for the run (deduped per run).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]).filter((f) => f.tool === 'update_document');
    expect(filings).toHaveLength(1);
  });
});
