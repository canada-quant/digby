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
 * Replay pin — tickets 155488ff + cea13871 (mishaps, auto-filed at breaker
 * trips 2026-09-21T02:26:59Z and 2026-09-21T02:28:23Z). TWO filings from ONE
 * derail run — session e083ff2e-de98-412a-85df-86923572db1d ("Post-CPT
 * Coordination — SFT/GRPO/GSPO + RL loops"), run
 * 559ca88e-ad4d-44df-bd39-3ac33cc00a25, seat kimi-k3 — the documented
 * placeholder-emission wrong-tool derail class (f839cede/aff1c189/ec9d7424 →
 * c35162ee → 54121353/83297404 → d50a6300 → afac4aee+769d7278 → 099bd00a →
 * 0c9f2420 → 89ddfcfe+60f64ebb). Combined pin per the afac4aee+769d7278
 * (#928) one-incident-one-pin precedent.
 *
 * INCIDENT A (155488ff): ONE update_feedback({id:"noop-not-applicable"})
 * emission while the reasoning named search_memory — refused by the
 * coding-loop ungrounded-id PRE-FLIGHT (update_feedback ∈ PLATFORM_TOOL_NAMES),
 * NEVER executed. The ticket carries exactly ONE text — the preflight envelope.
 * Trip arithmetic (pinned in agent-derail-break.afac4aee-769d7278.test.ts):
 * a preflight refusal counts +2 base and the intent conviction adds +1 ⇒
 * weighted 3 ⇒ TRIP at the FIRST emission ⇒ the one-text filing. Zero junk
 * writes — no ticket row was touched.
 *
 * INCIDENT B (cea13871): TWO verify_durable({id:"noop"}) emissions while the
 * reasoning named search_memory (first turn) — both EXECUTED into the
 * resource layer's not-found refusal (resource-tools.ts:277, refuse() shape
 * at 157-159), byte-identical ×2. verify_durable IS a preflight-covered
 * platform tool (platform-tool-names.ts; the ce17ef88 pin) — so why did the
 * calls execute? CROSS-TOOL SUBSTRING ECHO-GROUNDING: the first refusal's
 * JSON sits in the run's tool results, groundingHaystack INCLUDES tool
 * results (tool-preflight.ts:40-53), and haystack.includes is a SUBSTRING
 * check — "noop-not-applicable" contains "noop", so the shorter literal is
 * verbatim-grounded by the OTHER tool's refusal. Trip arithmetic: exec
 * refusal +1 failure +1 intent conviction = 2, then +1 = 3 ⇒ TRIP at the
 * second emission ⇒ the two-text filing (ce17ef88's minimal-arithmetic
 * shape: intent weight on the first call, pure failure on the second).
 *
 * VERDICT (both tickets' mandated investigation): MODEL BEHAVIOR, no
 * framework defect, NO code change — every deterministic seam behaved as
 * designed: the preflight (byte-exact envelope, +2 base, NOT EXECUTED),
 * the cross-tool echo-grounding, the resource not-found gate (byte-exact,
 * side-effect-free), the intent fast-trip, the weighted breaker, the
 * one-round ban. THE LANE'S REAL WORK SURVIVED: the coordinator lane is
 * still running its firing-474 watch (plan 1/5, coding.status running,
 * schedule enabled, next fire 03:23:14Z — get_chat_status
 * 2026-09-21T02:28:23Z, the filing instant).
 *
 * Placeholder literals observed across the family now: "__none__", "none",
 * "placeholder", "noop", "x", "noop-not-applicable".
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

/** The resource layer's not-found envelope, byte-faithful to the filed text
 *  — resource-tools.ts:277 `refuse(name, 'not_found', ...)` (envelope shape
 *  {ok:false, tool, reason, message} at resource-tools.ts:157-159, em-dash
 *  verbatim). Returned by the coding-executor mock for verify_durable calls;
 *  every other tool succeeds harmlessly (the probes the narrations named
 *  were NEVER emitted — asserted). */
const vdNotFound = (ref: string) =>
  [
    '{',
    ' "ok": false,',
    ' "tool": "verify_durable",',
    ' "reason": "not_found",',
    ` "message": "No training artifact \\"${ref}\\" — register_artifact first."`,
    '}',
  ].join('\n');
const mockExecuteCodingTool: jest.Mock = jest.fn(async (ctx: any, name: string, args: any) => {
  if (name === 'verify_durable') return vdNotFound(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
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
import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile: search_memory (both tickets' narration-named tool) is in
 *  the offered schema — the intended tool must be offerable for the intent
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

// ── The incidents' verbatim literals + filed texts ─────────────────────────
const UF_ID = 'noop-not-applicable'; // ticket 155488ff — update_feedback id
const VD_ID = 'noop'; // ticket cea13871 — verify_durable id
/** Ticket 155488ff's ONE filed text, verbatim — the pre-flight refusal for
 *  update_feedback id="noop-not-applicable" with the search_memory recovery
 *  line (built through the REAL ungroundedIdRefusal in the byte-exactness
 *  test below). */
const TICKET_155488FF_TEXT = [
  '{',
  ' "ok": false,',
  ' "tool": "triage_ticket",',
  ' "reason": "ungrounded_id",',
  ' "rejected": [',
  '  {',
  '   "key": "id",',
  '   "value": "noop-not-applicable"',
  '  }',
  ' ],',
  ' "message": "NOT EXECUTED: triage_ticket was called with id=\\"noop-not-applicable\\", which is not an id you obtained this run — ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. Your reasoning named search_memory — you evidently meant to call search_memory; call it now with its real parameters."',
  '}',
].join('\n');
/** Ticket cea13871's filed text, verbatim ×2 (resource-tools.ts:277). */
const TICKET_CEA13871_TEXT = vdNotFound(VD_ID);

/** The coordinator-watch brief — carries NEITHER literal (and no "noop"
 *  substring anywhere), so both first emissions are inventions. */
const BRIEF = [
  '[POST-CPT COORDINATION WATCH — firing 474/500]',
  'PROBES: memory search for the durability census, then the S3 recount;',
  'record observes and the owner-ETA line. No ticket writes this tick.',
].join('\n');

/** Incident A emission: update_feedback carrying the placeholder — the
 *  reasoning names search_memory (whole word, NEVER the called tool), the
 *  ticket's "lane's reasoning named search_memory". */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'search_memory first — the census notes live there; pulling them before any ticket write.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: UF_ID, adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** Incident B emissions: verify_durable carrying "noop". The FIRST names
 *  search_memory (the conviction — the ticket's "reasoning named" line); the
 *  SECOND names nothing offered (ce17ef88's minimal arithmetic: intent
 *  weight on the first call, a pure failure on the second). */
const vdConvictTurn = (n: number) => ({
  content: '',
  reasoning: 'search_memory has the artifact refs — verifying the durable stamps now.',
  toolCalls: [{ id: `t${n}`, name: 'verify_durable', arguments: JSON.stringify({ id: VD_ID }) }],
  finishReason: 'tool_calls',
});
const vdPlainTurn = (n: number) => ({
  content: '',
  reasoning: 'One more durability stamp, then the ETA line.',
  toolCalls: [{ id: `t${n}`, name: 'verify_durable', arguments: JSON.stringify({ id: VD_ID }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-vd-streaks-test',
  sessionId: 'sess-vd-streaks',
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

describe('tickets 155488ff + cea13871 — update_feedback "noop-not-applicable" preflight streak + verify_durable "noop" echo-grounded streak (one run, search_memory narration)', () => {
  it('both literals are ungrounded against the run haystack (non-hex; appear nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: UF_ID }, BRIEF))
      .toEqual([{ key: 'id', value: UF_ID }]);
    expect(findUngroundedIdArgs({ id: VD_ID }, BRIEF))
      .toEqual([{ key: 'id', value: VD_ID }]);
  });

  it('the 155488ff filed text is byte-exact the current ungroundedIdRefusal envelope (update_feedback + intended search_memory) — no framework drift', () => {
    // The production call site renders the MODEL-FACING tool name
    // (agent.ts: ungroundedIdRefusal(modelToolName(tc.name), …)).
    expect(ungroundedIdRefusal('triage_ticket', [{ key: 'id', value: UF_ID }], 'search_memory'))
      .toBe(TICKET_155488FF_TEXT);
  });

  it('the cea13871 filed text is byte-exact the resource not-found envelope format with the bare literal (resource-tools.ts:277 — the deterministic artifact gate, no framework drift)', () => {
    expect(TICKET_CEA13871_TEXT).toContain('"reason": "not_found"');
    expect(TICKET_CEA13871_TEXT).toContain('No training artifact \\"noop\\" — register_artifact first.');
    expect(vdNotFound(VD_ID)).toBe(TICKET_CEA13871_TEXT);
  });

  it('CROSS-TOOL substring echo-grounding: the first refusal\'s JSON contains "noop-not-applicable" ⊃ "noop", so the shorter literal is verbatim-grounded by the OTHER tool\'s refusal — the mechanism behind cea13871\'s executions (zero verify_durable preflight rows)', () => {
    expect(TICKET_155488FF_TEXT).toContain(VD_ID); // "noop" ⊂ "noop-not-applicable"
    expect(findUngroundedIdArgs({ id: VD_ID }, `${BRIEF}\n${TICKET_155488FF_TEXT}`)).toEqual([]);
    // …while the LONGER literal stays ungrounded against a haystack that only
    // carries the shorter one (the echo is directional):
    expect(findUngroundedIdArgs({ id: UF_ID }, `${BRIEF}\n${TICKET_CEA13871_TEXT}`))
      .toEqual([{ key: 'id', value: UF_ID }]);
  });

  it('wiring seam: BOTH tools are platform-gated (the preflight covers verify_durable too — platform-tool-names.ts; the ce17ef88 pin) — incident B\'s executions were grounded, never a preflight bypass', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('verify_durable');
  });

  it('END-TO-END the incident ladder: ONE preflight envelope trips update_feedback at the first emission (+2 base +1 intent = 3); the echo-grounded verify_durable executions trip at the second (+1+1, +1); both filings carry exactly the tickets\' texts with intended search_memory — zero junk writes', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1)) // PREFLIGHT refusal (ungrounded_id) ⇒ weighted 3 ⇒ TRIP 1 (perma:false ban) — the ONLY preflight row; filing 155488ff [ENVELOPE]
      .mockResolvedValueOnce(vdConvictTurn(2)) // echo-grounded via "noop" ⊂ "noop-not-applicable" ⇒ EXECUTES into resource not-found (+1 failure +1 intent = 2)
      .mockResolvedValueOnce(vdPlainTurn(3)) // EXECUTES again (+1 = 3) ⇒ TRIP 1 for verify_durable (perma:false); filing cea13871 [NOT_FOUND, NOT_FOUND]
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput(`${BRIEF}\nRun the watch tick now.`));

    // EXACTLY ONE preflight row — incident A's signature; incident B's calls
    // were echo-grounded and never re-hit the pre-flight.
    const preflight = strikes('tool_preflight').filter((m) => m.meta.reason === 'ungrounded_id');
    expect(preflight).toHaveLength(1);
    expect(preflight[0].meta).toMatchObject({ tool: 'update_feedback', intended: 'search_memory' });
    expect(preflight.filter((m) => m.meta.tool === 'verify_durable')).toHaveLength(0);

    // Both first-streak filings — exactly the two tickets' evidence lists.
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ufFiling = filings.find((f) => f.tool === 'update_feedback');
    const vdFiling = filings.find((f) => f.tool === 'verify_durable');
    expect(ufFiling).toBeDefined();
    expect(ufFiling.recentFailures).toEqual([TICKET_155488FF_TEXT]);
    expect(ufFiling.intended).toBe('search_memory');
    expect(vdFiling).toBeDefined();
    expect(vdFiling.recentFailures).toEqual([TICKET_CEA13871_TEXT, TICKET_CEA13871_TEXT]);
    expect(vdFiling.intended).toBe('search_memory');

    // The perma:false one-round ban on update_feedback; then the run ENDS at
    // incident B's trip — the FIRST TRIP OF THE SECOND DISTINCT TOOL fires
    // the harness ender (refines the afac4aee pin's "(size 2 AND total 3)"
    // parenthetical: there the second tool's trip happened to be total 3;
    // here it is total 2). Exactly the real incident's shape: both filings
    // landed and run 559ca88e ended at 2026-09-21T02:28:23Z (the lane's
    // rescue/schedule then continued the firing-474 watch).
    const breaks = strikes('tool_derail_break');
    expect(breaks.some((m) => m.meta.tool === 'update_feedback' && m.meta.perma === false)).toBe(true);
    expect(breaks.some((m) => m.meta.tool === 'verify_durable' && m.meta.perma === false)).toBe(true);
    const ended = breaks.find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'verify_durable', perma: false, trips: 2, intended: 'search_memory' });
    expect(ended!.meta.tools).toEqual(['update_feedback', 'verify_durable']);

    // Zero junk writes: update_feedback NEVER executed (preflight-refused);
    // verify_durable executed exactly twice with the placeholder ref (the
    // resource gate refused both — no artifact row touched). search_memory
    // was NEVER emitted — the incident signature.
    const ufExecs = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback');
    expect(ufExecs).toHaveLength(0);
    const vdExecs = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'verify_durable');
    expect(vdExecs).toHaveLength(2);
    expect(vdExecs.every((c) => String(c[2]?.id ?? '') === VD_ID)).toBe(true);
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'search_memory')).toBe(false);
    // The run ends on the harness ender at incident B's trip (the model's
    // FINAL turn is never reached) — the real run's clean breaker ending.
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (2 episodes; intended tool appears to be search_memory)');
    expect(result.modelErrored).toBeUndefined();
  });
});
