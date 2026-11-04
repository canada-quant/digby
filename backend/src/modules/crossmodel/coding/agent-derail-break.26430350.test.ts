// LEGACY SCHEMA REPLAY (coding/tool-scope.ts, owner 2026-09-22): this pin replays
// an incident from before the cause-level fix — when `update_feedback` /
// `update_supervisor_state` were offered under their internal names to every
// coding lane. The breaker / pre-flight mechanics it pins are unchanged. The
// always-visible switches below still restore that era's SCOPE; the era's
// internal NAMES cannot be restored — RSW-1 deleted the disambiguation kill
// switch on 2026-11-02, so those tools are offered as `triage_ticket` /
// `save_supervisor_state` and the name assertions below pin the model-facing
// spelling. An EMITTED internal name still resolves and executes.
// (agent-tool-scope.test.ts pins the new default: renamed, scoped, slip-pruned.)
process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';

/**
 * Replay pin — tickets 26430350 + 65eef459 (mishaps, auto-filed
 * 2026-09-21T22:21:59.791Z / 22:22:46.987Z by the derail breaker; incident
 * session 11056f98-ba44-4a80-af15-81aff06fdf3a "Framework Operator Coding
 * Lane Audit", project crossmodel, run f56e1b12-f4cb-4d39-9f0c-ce3857804192,
 * coding seat kimi-k3).
 *
 * THE INCIDENT: the lane's first-run job was to READ its brief
 * (docs/FRAMEWORK_OPERATOR.md). Instead — mid narration-repetition loop, per
 * the supervisor steer at 22:22:32Z — it emitted update_feedback with the
 * model-authored placeholder ids "__use_read_file__", "__stop__",
 * "__read_file_now__" and update_document with the placeholder fileIds
 * "__stop_misfiring__", "__wrong__", while its own reasoning named read_file.
 * Filed failure texts (verbatim, newest first):
 *   ticket 26430350 (update_feedback, filed at the trip-1 notice):
 *     · {"ok":false,"tool":"update_feedback","reason":"ungrounded_id", … id="__read_file_now__" … "never from narration. If you have no such id, …"}
 *     · {"ok":false, … id="__stop__" … "Your reasoning named read_file — you evidently meant to call read_file; …"}
 *     · {"ok":false, … id="__use_read_file__" … (same intent variant)}
 *   ticket 65eef459 (update_document, filed at the terminal):
 *     · No generated file with id __wrong__ belongs to this user. Call list_files to see the current files.
 *     · No generated file with id __stop_misfiring__ belongs to this user. Call list_files to see the current files.
 * The run ended 22:22:45Z: "[HARNESS] Run ended: repeated wrong-tool
 * derailment (3 episodes; intended tool appears to be read_file)."
 *
 * GUARD ROWS for run f56e1b12 (this lane's get_fleet_telemetry pull of kind
 * guard_strike, asOf 22:46:56Z — chronological):
 *   22:20:35 tool_repeat_break edit_file (trips:1, rounds:1)
 *   22:21:12 tool_repeat_break edit_file (trips:2, rounds:3)
 *   22:21:22 tool_preflight update_feedback ungrounded_id (intended read_file)
 *   22:21:25 tool_derail_reanchor update_feedback (intent_mismatch, read_file)  ← the ONE steer
 *   22:21:32 tool_preflight update_feedback ungrounded_id (intended read_file)
 *   22:21:47 tool_preflight update_feedback ungrounded_id (intended read_file)
 *   22:21:59 tool_preflight update_feedback ungrounded_id (NO intended)         ← the "__read_file_now__" row
 *   22:22:01 tool_derail_break update_feedback (perma:false)                   ← TRIP 1
 *   22:22:23 tool_preflight update_feedback ungrounded_id (intended read_file)
 *   22:22:25 tool_derail_break update_feedback (perma:true)                    ← TRIP 2 (gone for the run)
 *   22:22:45 tool_derail_break update_document (state ended_run, trips:3,
 *              tools [update_feedback, update_document], intended read_file)   ← TERMINAL
 *
 * WHY THE TRIP TIMING IS DETERMINISTIC (the one non-obvious beat): each
 * intent-convicted ungrounded refusal weighs 3 (failure +1, preflight
 * ungrounded +1, intent +1 — agent.ts:3352-3366), which would trip on the
 * FIRST emission. The first four preflight rows produced NO trip because the
 * derail trip check (agent.ts:3395) requires `!withheldTool`, and the SHARED
 * single-slot withheldTool was held by edit_file's identical-call (storm)
 * breaker (agent.ts:3693) until its rounds elapsed — the streak kept
 * accumulating (no reset without a trip, :3405) and TRIP 1 fired the moment
 * the slot cleared. failStreakTexts is unshift-capped at 3 (:3358-3359), so
 * the trip-1 filing carried exactly the three newest envelopes — the first
 * emission's text fell off the buffer, which is why the ticket files three
 * texts from five preflight rows. The one NO-intent row (22:21:59,
 * "__read_file_now__") is the whole-word boundary of detectIntendedTool
 * (tool-preflight.ts:86-130): the placeholder literal contains "read_file"
 * bounded by underscores, which the (?<![A-Za-z0-9_])…(?![A-Za-z0-9_]) mention
 * regex never matches — only the reasoning prose counts.
 *
 * VERDICT (this lane, session 429e6242): MODEL BEHAVIOR on both tickets —
 * the placeholder-emission wrong-tool derail class (f839cede / aff1c189 /
 * ec9d7424 / 155488ff / cea13871 / 1867d6d5 / 89ddfcfe / 60f64ebb / 099bd00a /
 * e70a830a / c35162ee, all adjudicated model-side). Every containment seam
 * fired AS DESIGNED with zero side effects: the ungrounded-id preflight
 * refused every update_feedback placeholder BEFORE execution (no junk ticket
 * mutations), the byte-exact DB ownership gate (tool-executor.ts:774-781)
 * refused every update_document placeholder (no junk document writes), the
 * re-anchor steer fired exactly ONCE, the breaker withheld → perma-withheld →
 * ended the run, and both investigation tickets were auto-filed (deduped per
 * session+tool — "first streak this run" in both descriptions). Nothing in
 * either refusal path changed on 2026-09-21 (git log: the grounding rule is
 * untouched since f356e14a7 2026-09-09; the ownership gate template since
 * 0a413b80a 2026-08-24; the only 09-20 changes are the additive re-anchor /
 * rescue / storm-ladder / FAILURE_MARKERS containment). NO framework change.
 *
 * This pin: (UNIT) the five placeholders are ungrounded against the
 * incident's haystack, the two refusal-envelope variants + the ownership
 * envelope are byte-exact the filed texts, and the whole-word intent
 * boundary; (E2E) the weighted-3 trip on one intent-convicted emission, the
 * withhold → perma → migration → terminal ladder with the exact ender, the
 * three filings newest-first, and ZERO update_feedback executions.
 *
 * Scaffold mirrors agent-derail-break.c35162ee.test.ts (ToolCache document
 * seam) + agent-derail-break.b6ebb710.test.ts (pure-unit envelope pin).
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

// executeCodingTool's signature is (ctx, name, args) — name is c[1] (the
// name-first mock misrouting gotcha recorded in 431518a2).
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document-tool seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES), not executeCodingTool, and is NEVER ungrounded-id
// preflighted (by design — ff091af6). Stub only the executor instance to
// answer tool-executor.ts:774-781's honest ownership refusal. update_feedback
// is deliberately NOT stubbed here: the preflight must refuse every
// placeholder before ANY dispatch seam sees it (asserted below).
const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    return UD_ENVELOPE(String(args?.fileId ?? args?.documentId ?? ''));
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
import {
  detectIntendedTool,
  findUngroundedIdArgs,
  groundingHaystack,
  ungroundedIdRefusal,
} from './tool-preflight';

/** CODING profile (no workspace container in the scaffold): read_file is in
 *  the offered schema (the base toolset is profile.kind-gated, not
 *  workspaceTools-gated — agent.ts:1006-1016) so the intent detector can name
 *  it, exactly as in the incident run. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim placeholder ids + filed texts ───────────────────
// update_feedback (chronological — the ticket files them newest first):
const UF1 = '__use_read_file__'; // 22:21:32Z emission (intent)
const UF2 = '__stop__'; //          22:21:47Z emission (intent)
const UF3 = '__read_file_now__'; // 22:21:59Z emission (NO intent — whole-word boundary)
// update_document (chronological):
const UD1 = '__stop_misfiring__';
const UD2 = '__wrong__';

// The ticket-filed update_feedback envelopes, byte-exact (both variants).
const UF_MSG = (id: string, intent: boolean) =>
  `NOT EXECUTED: update_feedback was called with id="${id}", which is not an id you obtained this run — ` +
  `ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. ` +
  (intent
    ? `Your reasoning named read_file — you evidently meant to call read_file; call it now with its real parameters.`
    : `If you have no such id, you do not need update_feedback right now — call the tool that advances the task instead.`);

/** Reasoning that names read_file as a WHOLE WORD and never names the called
 *  tool — the incident's narration/emission mismatch ("lane's reasoning named
 *  read_file"). */
const INTENT_REASONING =
  'I need the operator brief before anything else — read_file on docs/FRAMEWORK_OPERATOR.md, then one step at a time.';

const ufTurn = (n: number, id: string) => ({
  content: '',
  reasoning: INTENT_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id, status: 'done', adminNote: 'closing the streak ticket' }) }],
  finishReason: 'tool_calls',
});
const udTurn = (n: number, fileId: string) => ({
  content: '',
  reasoning: INTENT_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId, content: 'rewritten digest' }) }],
  finishReason: 'tool_calls',
});
const readFileTurn = (n: number) => ({
  content: '',
  reasoning: 'Reading the brief document now.',
  toolCalls: [{ id: `t${n}`, name: 'read_file', arguments: JSON.stringify({ path: 'docs/FRAMEWORK_OPERATOR.md' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-26430350-test',
  sessionId: 'sess-26430350',
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
const steerMessages = () =>
  ((mockRunModelTurn.mock.calls[0]?.[1] as any[]) ?? [])
    .filter((m: any) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

// ── UNIT: the grounding rule + the byte-exact envelopes ─────────────────────
describe('tickets 26430350 + 65eef459 — unit: grounding + byte-exact refusal texts', () => {
  // A realistic incident haystack: the Framework Operator brief + a REAL
  // ticket id from a prior list_feedback result. None of the five placeholder
  // literals occurs anywhere in it.
  const INCIDENT_BRIEF = [
    'You are the Framework Operator — the standing coding lane that audits and repairs',
    "Digby's own framework, owned by the Fleet Supervisor.",
    'Read docs/FRAMEWORK_OPERATOR.md and scripts/framework-audit/README.md first;',
    'they are your brief and your instruments. Prove production reach, then work',
    'the checklist one step at a time and report each result.',
  ].join('\n');
  const REAL_TICKET_ID = '26430350-ee4d-4f2a-a382-9e0c0b294213'; // the incident's own ticket — id-shaped
  const HAYSTACK = groundingHaystack([
    { role: 'user', content: INCIDENT_BRIEF },
    { role: 'tool', content: `{"tickets":[{"id":"${REAL_TICKET_ID}","status":"in_progress"}]}` },
  ]);

  it('all five emitted placeholders are ungrounded against the incident haystack (neither id-shaped nor anywhere the model read)', () => {
    for (const value of [UF1, UF2, UF3]) {
      expect(findUngroundedIdArgs({ id: value }, HAYSTACK)).toEqual([{ key: 'id', value }]);
    }
    for (const value of [UD1, UD2]) {
      expect(findUngroundedIdArgs({ fileId: value }, HAYSTACK)).toEqual([{ key: 'fileId', value }]);
    }
  });

  it('the model could not have self-grounded: assistant-role narration is excluded from the haystack', () => {
    const withNarration = groundingHaystack([
      { role: 'user', content: INCIDENT_BRIEF },
      { role: 'assistant', content: `Calling update_feedback with id ${UF2} to close this out.` },
    ]);
    expect(findUngroundedIdArgs({ id: UF2 }, withNarration)).toEqual([{ key: 'id', value: UF2 }]);
  });

  it('the correct call WAS available: a real ticket id is grounded (id-shape leg + verbatim leg)', () => {
    expect(findUngroundedIdArgs({ id: REAL_TICKET_ID }, '')).toEqual([]); // shape leg, empty haystack
    expect(findUngroundedIdArgs({ id: REAL_TICKET_ID }, HAYSTACK)).toEqual([]); // verbatim leg
  });

  it('replays the two filed update_feedback envelope variants BYTE-EXACT (intent + no-intent)', () => {
    const cases: Array<[string, string | null]> = [
      [UF1, 'read_file'],
      [UF2, 'read_file'],
      [UF3, null], // the 22:21:59Z row carried no intended tool
    ];
    for (const [value, intended] of cases) {
      const refusal = JSON.parse(ungroundedIdRefusal('update_feedback', [{ key: 'id', value }], intended));
      expect(refusal).toEqual({
        ok: false,
        tool: 'update_feedback',
        reason: 'ungrounded_id',
        rejected: [{ key: 'id', value }],
        message: UF_MSG(value, intended === 'read_file'),
      });
    }
  });

  it('intent detection: the incident reasoning convicts read_file; the "__read_file_now__" literal does NOT (whole-word boundary — the mechanism behind the one NO-intent row)', () => {
    const offered = new Set(['read_file', 'edit_file', 'run_command', 'update_feedback', 'update_document', 'list_files', 'get_feedback', 'list_feedback']);
    expect(detectIntendedTool(INTENT_REASONING, 'update_feedback', offered)).toBe('read_file');
    // The placeholder literal contains "read_file" bounded by underscores —
    // never a whole-word mention (tool-preflight.ts:122-125).
    expect(detectIntendedTool('Retrying with __read_file_now__ as the id.', 'update_feedback', offered)).toBeNull();
  });

  it('the two filed update_document texts are byte-exact the executor ownership-refusal format (the deterministic DB gate — no framework defect)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: UD1, content: 'x' })).toBe(UD_ENVELOPE(UD1));
    expect(await mockToolCacheExec('update_document', { fileId: UD2, content: 'x' })).toBe(UD_ENVELOPE(UD2));
  });
});

// ── E2E: the incident ladder ────────────────────────────────────────────────
describe('ticket 26430350 + 65eef459 — END-TO-END the placeholder ladder across both seams', () => {
  it('update_feedback placeholders never execute (weighted-3 trip per intent-convicted emission: ban → perma), the lock migrates to update_document (executes into the ownership gate), and the run ends with the EXACT incident ender + three newest-first filings', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1, UF1)) // preflight refusal: +1 failure +1 ungrounded +1 intent = 3 → TRIP 1 (one-round ban); the ONE re-anchor steer fires
      .mockResolvedValueOnce(readFileTurn(2)) // the steered recovery: the intended tool succeeds (ban round)
      .mockResolvedValueOnce(ufTurn(3, UF2)) // +3 → TRIP 2 ⇒ update_feedback PERMA-withheld
      .mockResolvedValueOnce(udTurn(4, UD1)) // executes → ownership refusal: +1 failure +1 intent = 2
      .mockResolvedValueOnce(udTurn(5, UD2)) // executes → ownership refusal: +2 = 4 → TRIP 1 on update_document ⇒ 2 tools ⇒ TERMINAL
      .mockResolvedValue(FINAL);

    const input = makeInput('Framework Operator first run: read the brief documents and work the checklist.');
    const result = await runCodingAgent(input);

    // The exact incident ender (transcript row 11a0c8d9, 22:22:45Z).
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).toContain(
      '[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes; intended tool appears to be read_file). The next scheduled firing starts fresh.',
    );

    // ZERO update_feedback executions on ANY dispatch seam — every placeholder
    // died in the preflight (the incident's containment held).
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback')).toHaveLength(0);
    expect(mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_feedback')).toHaveLength(0);
    // The intended tool WAS callable and succeeded (the recovery the steer demanded).
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'read_file')).toHaveLength(1);
    // update_document placeholders EXECUTED into the ownership gate (never
    // preflight-gated, by design) — exactly the two incident calls.
    const udCalls = mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document');
    expect(udCalls.map((c) => c[1]?.fileId)).toEqual([UD1, UD2]);

    // Telemetry: 2 preflight refusals, ONE re-anchor steer, the trip ladder,
    // and the ended_run row — the incident's guard-row signature.
    const preflight = strikes('tool_preflight');
    expect(preflight).toHaveLength(2);
    for (const m of preflight) {
      expect(m.meta).toMatchObject({ tool: 'update_feedback', reason: 'ungrounded_id', intended: 'read_file' });
    }
    const reanchor = strikes('tool_derail_reanchor');
    expect(reanchor).toHaveLength(1);
    expect(reanchor[0].meta).toMatchObject({ tool: 'update_feedback', intended: 'read_file', reason: 'intent_mismatch' });
    expect(steerMessages()).toHaveLength(1);
    expect(String(steerMessages()[0].content)).toContain('call read_file NOW');

    const breaks = strikes('tool_derail_break');
    expect(breaks.find((m) => m.meta.perma === false && !m.meta.state)?.meta).toMatchObject({ tool: 'update_feedback', intended: 'read_file' });
    expect(breaks.find((m) => m.meta.perma === true)?.meta).toMatchObject({ tool: 'update_feedback', intended: 'read_file' });
    const ended = breaks.find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({
      tool: 'update_document',
      perma: false,
      trips: 3,
      tools: ['update_feedback', 'update_document'],
      intended: 'read_file',
    });

    // The attribution filings: trip 1 (update_feedback, one text), trip 2
    // (update_feedback, perma — NX-deduped against ticket 26430350 in
    // production), and the terminal (update_document — ticket 65eef459 — with
    // exactly the two filed texts, NEWEST FIRST).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    expect(filings).toHaveLength(3);
    expect(filings[0]).toMatchObject({ tool: 'update_feedback', perma: false, intended: 'read_file' });
    expect(filings[0].recentFailures).toHaveLength(1);
    expect(filings[0].recentFailures[0]).toContain(UF1);
    expect(filings[0].recentFailures[0]).toContain('ungrounded_id');
    expect(filings[1]).toMatchObject({ tool: 'update_feedback', perma: true, intended: 'read_file' });
    expect(filings[1].recentFailures[0]).toContain(UF2);
    expect(filings[2]).toMatchObject({ tool: 'update_document', perma: false, intended: 'read_file' });
    expect(filings[2].recentFailures).toEqual([UD_ENVELOPE(UD2), UD_ENVELOPE(UD1)]);
  });
});
