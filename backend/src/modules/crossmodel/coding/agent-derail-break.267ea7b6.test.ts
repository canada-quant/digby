/**
 * REPLAY TEST — ticket 267ea7b6 (mishap, 2026-10-09): "5× success-side
 * wrong-tool loop: edit_file on 'File news/announcements into · c9f2f4df(' —
 * framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session c919294b-e3aa-4a2c-baa2-4ab7ce65471e — the
 * deckpose "File site-wide 404s" lane, a DIFFERENT project than crossmodel;
 * run 825051b8-1ee8-498f-a6bb-16c4a0db93b7, cql-litellm:api-alibaba-
 * qwen3.8-max, coding profile, MACHINE-triggered; the run COMPLETED at
 * 2026-10-09T08:41:27.139Z and shipped its PR #83). The lane's reasoning named grep (a verification sweep it
 * had planned) while it correctly emitted a batch of FIVE edit_file doc
 * fixes — docs/agent.md "22→26 implementations", docs/agent.md the three
 * news-agent-tool table rows, docs/news.md "Still pending→All six lanes are
 * now shipped", AGENTS.md the `c9f2f4df` DONE row, README.md the
 * scraper/cron row — every call SUCCEEDING, the named intent STABLE at grep
 * the whole way (no churn). The turns' own content channel was FAITHFUL
 * ("Continuing step 8 — the remaining count fixes…"); the args were correct
 * doc edits that landed. Fleet telemetry (pulled this run via prodq
 * probes): guard_miss seam 'tool_intent_attribution' rows for OTHER turns
 * were all batch_sibling ACQUITTALS (read_file/git_push batches naming
 * grep/verify/search_memory — the f6217896 leg working), no discount rows on
 * the convicted batch (edit_file is a CODING tool — platform-tool scope,
 * correct); guard_strike 'tool_derail_reanchor' 07:35:26.624Z (reason
 * 'intent_mismatch_success', intended 'grep', churned:false) →
 * guard_strike 'tool_derail_break' 07:35:34.894Z (shape 'success_intent',
 * perma:false, churned:false, intended 'grep') — EIGHT seconds apart, both
 * out of the ONE batch, agent_events seq 3752→3764 (guard_marker seq 3767).
 *
 * ADJUDICATION (this lane, 2026-10-09, evidence-led): MODEL-SIDE — no
 * deterministic framework/schema/preflight/guard defect caused the streak.
 * 1. The guard stack behaved per design at every rung: the narration
 *    (reasoning channel, live only — the persisted checkpoint message
 *    idx=103 carried role/content/tool_calls, no reasoning key — the
 *    checkpoint is now GC'd empty, so agent_events is the durable channel)
 *    as a whole word and never the called edit_file, so
 *    detectIntendedToolChannels convicted exactly as built; edit_file is a
 *    coding tool so the 0625bf62 platform-tool discount correctly never
 *    applied; the batch-sibling acquittal (f6217896) correctly never
 *    acquitted — the named tool (grep) was NOT in the batch; the steer told
 *    the truth about the SUCCESS shape; the trip withheld edit_file exactly
 *    one round; the filed text byte-matches the :5749 non-churn template
 *    ("edit_file kept SUCCEEDING while the run's own reasoning named grep —
 *    wrong-tool derailment on successful calls (edit_file→grep ×5
 *    consecutive, ticket 2c98b460)").
 * 2. The CONTAINMENT WORKED — same recovery shape as 8da24785: the next
 *    model turn said "The re-anchor is right that my last action should
 *    have been a verification sweep — I have all the edits applied, so the
 *    grounded next call is `grep`" and CALLED grep (seq 3783), then
 *    continued its close-out with 8 more correct edit_file calls
 *    (seq 3922→4126). One-round withhold, no perma, no run-end; the run kept
 *    shipping (it later pushed and merged its PR #83 — guard_strike
 *    'pr_idempotency_followup' merged:true prState closed prNumber 83).
 * 3. The DISTINGUISHING AXES vs the pinned quadrants (a1660b1a
 *    stable+silent, ee39f231 churn+loud, c737d007 churn mechanics, 4994e2f1
 *    stable+loud glm-5.3, 8da24785 stable+loud kimi-k3 machine-triggered):
 *    this is the stable+loud quadrant on a THIRD model family —
 *    qwen3.8-max — MACHINE-triggered, in a third project. The
 *    narration-word-slip class is now pinned on glm-5.3 (human-turn),
 *    kimi-k3 (machine) and qwen3.8-max (machine): NOT model-specific, NOT
 *    trigger-specific, NOT project-specific.
 * 4. THE DEFENSE PROPOSED AND REJECTED (the valuable negative): this
 *    incident was first misread as a framework defect — "the ladder counts
 *    PER CALL while its evidence is TURN-SCOPED, so one 5-call batch
 *    sharing one narration trips the 5-threshold in 8 seconds." A
 *    per-(batch,tool) dedup gate was implemented (batchIntentCounted set +
 *    DERAIL_BATCH_INTENT_DEDUP_DISABLED kill switch) and its replay DID
 *    suppress this instance — but it made SIX prior pinned TRUE-POSITIVE
 *    replays fail (aa30b46e f6217896 8da24785 ee39f231 d73765fc 4994e2f1 —
 *    23 tests, all green on the reverted baseline), among them 8da24785:
 *    the IDENTICAL shape (5 edit_file mismatches in ONE batch, stable
 *    intent, adjudicated MODEL-SIDE 2026-09-23) whose pin deliberately
 *    asserts "steer (threshold 3) and trip (threshold 5) both fire out of a
 *    single batch" as CORRECT containment that helped the lane recover.
 *    One narrated decision per batch would raise the trip bar from 5 calls
 *    to 5 BATCHES for the single-batch decoder-lock class the guard was
 *    built to contain. Per the detector-change rule (a fix that needs a
 *    real true positive to stop firing must NOT merge), the detector change
 *    was REVERTED; this pin records the class instead.
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts: the narration convicts edit_file of intending grep; steer
 * at the third cumulative edit_file mismatch (churned:false — stable
 * intent, same quadrant as 4994e2f1/8da24785), trip at the fifth — both
 * out of the ONE batch; the trip metric carries the incident's exact
 * meta; the one-round withhold holds (no perma, no run-end); and the
 * modeled recovery turn (grep call after the ban round, per the wild
 * seq-3783 recovery) confirms the run CONTINUES cleanly. No detector
 * change rides this ticket: the guard's per-call counting over turn-scoped
 * narration is BY DESIGN (the 8da24785 pin owns that assertion).
 *
 * Scaffold mirrors agent-derail-break.8da24785.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), edit_file args vary by LETTER-
 * skeleton path (never a digit-only delta) so the exact and digit-collapsed
 * repeat signatures stay blind, and no run_command call ever appears. The
 * narration names exactly ONE offered tool as a whole word and never the
 * called edit_file (an unoffered named tool makes detectIntendedTool
 * return null and silently resets the streak — the c737d007 test-writing
 * gotcha). Args are real doc-fix shapes so no ungrounded-id preflight leg
 * can refuse them.
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

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { detectIntendedTool, intentMismatchDiscount } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident's wake text: doc-status close-out work, naming NOTHING the
 *  guard could misread as ordering the called edit_file (grep is not
 *  pre-computed here — the narration-slip is the model's own, not a
 *  preamble artifact). */
const BRIEF = 'Close out the news work: correct every doc the /v1/news go-live invalidated, then verify with the site suite.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-267ea7b6-test',
  sessionId: 'sess-267ea7b6',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The incident narration: the live reasoning channel planned a grep
 *  verification sweep while edit_file correctly executed the doc fixes —
 *  it names exactly ONE offered tool as a whole word and NEVER the called
 *  edit_file. Named intent STABLE at grep (churned:false, the stable+loud
 *  quadrant on a third model family). */
const P_BATCH = 'All six lanes are shipped, so before the close-out I will grep the doc set for any remaining stale-status rows the go-live invalidated.';
/** The faithful content channel the wild turn carried (checkpoint msg
 *  idx=103) — never the called tool, never a decision sentence for it. */
const C_BATCH = 'Continuing step 8 — the remaining count fixes across the doc set.';

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const DOC_EDITS: Array<[string, string, string]> = [
  ['docs/agent.md', 'the 22 implementations', 'the 26 implementations'],
  ['docs/news.md', 'Still pending: the agent tools', 'All six lanes are now shipped: the agent tools'],
  ['AGENTS.md', 'the agent tools pending', 'the agent tools DONE'],
  ['README.md', 'scraper shipped', 'scraper shipped on a daily rule'],
  ['docs/deployment.md', 'UPDATE 2026-10-08/09', 'UPDATE 2026-10-09'],
];
const editCall = (n: number) => {
  const [path, old_string, new_string] = DOC_EDITS[(n - 1) % DOC_EDITS.length];
  return {
    id: `t${n}`,
    name: 'edit_file',
    arguments: JSON.stringify({ path: `${path.slice(0, -3)}-${WORDS[(n - 1) % WORDS.length]}.md`, old_string, new_string }),
  };
};

/** THE INCIDENT SHAPE: ALL FIVE mismatched edit_file calls in ONE tool
 *  batch (the wild guard_strike rows landed 07:35:26.624Z → 07:35:34.894Z,
 *  agent_events seq 3752→3764), under one stable grep-naming narration with
 *  a FAITHFUL content channel. Steer (3) and trip (5) both fire out of this
 *  single batch — BY DESIGN (the 8da24785 pin owns that assertion). */
const editMissBatch = {
  content: C_BATCH,
  reasoning: P_BATCH,
  toolCalls: Array.from({ length: 5 }, (_, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};

/** The MODELED RECOVERY turn (the wild lane's post-steer behavior, seq
 *  3773-3783): acknowledges the re-anchor, then calls grep — the grounded
 *  next action — as a single aligned call. */
const recoveryGrepTurn = {
  content: 'The re-anchor is right — all the edits are applied, so the grounded next call is a verification sweep.',
  reasoning: 'Now grep the doc set for any remaining stale-status rows.',
  toolCalls: [{ id: 'tg1', name: 'grep', arguments: JSON.stringify({ pattern: 'pending', path: 'docs' }) }],
  finishReason: 'tool_calls' as const,
};
const FINAL = { content: 'Close-out complete — every corrected doc committed.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket 267ea7b6 — third-model stable+loud success-side derail: guard correct, containment effective, model behavior', () => {
  it('UNIT: the incident premise — the narration convicts edit_file of intending grep; the discount correctly never applies (coding-tool scope); the batch-sibling acquittal correctly never fires (grep not in the batch)', () => {
    const offered = ['run_command', 'edit_file', 'grep', 'read_file', 'list_files'];
    expect(detectIntendedTool(P_BATCH, 'edit_file', offered)).toBe('grep');
    // The faithful content channel convicts nothing on its own.
    expect(detectIntendedTool(C_BATCH, 'edit_file', offered)).toBeNull();
    // edit_file is a CODING tool — the 0625bf62 platform-tool discount is
    // out of scope even when the wake text names work (measure-first).
    expect(intentMismatchDiscount('grep', 'edit_file', BRIEF)).toBeNull();
  });

  it('REPLAY the incident (batch-of-5, STABLE intent, measure LOUD, coding-tool scope): steer at the third cumulative edit_file mismatch (intended grep, churned:false), trip at the fifth — both out of ONE batch — one-round withhold only, and the run RECOVERS on the modeled grep turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(editMissBatch)      // the incident: 5 mismatches, one batch, all SUCCEED
      .mockResolvedValueOnce(recoveryGrepTurn)   // the ban round: edit_file absent from the schema; grep runs (wild seq 3783)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Close-out complete — every corrected doc committed.');
    expect(result.modelErrored).toBeUndefined();
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
      tool: 'edit_file', intended: 'grep', reason: 'intent_mismatch_success', churned: false,
    });

    // ── Trip at the FIFTH, one round only — the incident's exact meta ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'grep', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The modeled recovery: the post-steer turn calls grep (the grounded
    //    next action), the run continues and finishes clean ──
    const grepDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'grep');
    expect(grepDispatch.length).toBeGreaterThanOrEqual(1);
    // The user-visible notices tell the TRUTH about the success shape:
    // the withhold notice says the last 5 edit_file calls SUCCEEDED and
    // names the intended grep — byte-shapes the wild lane received at
    // 07:35:26Z/07:35:34Z (guard_marker seq 3767).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of edit_file all SUCCEEDED');
    expect(withholdNotice).toContain('Your own reasoning named grep');
  });

  it('REPLAY the adjudication NEGATIVE (the rejected defense): per-(batch,tool) dedup is NOT the framework behavior — the five same-batch siblings each count, exactly as 8da24785 pinned (this records WHY the proposed dedup was reverted: it suppresses a pinned true positive)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(editMissBatch)
      .mockResolvedValueOnce(recoveryGrepTurn)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    await runCodingAgent(input);

    // The count reached 5 INSIDE the one batch (steer + trip both fired) —
    // per-call counting over turn-scoped narration is the pinned design
    // (8da24785: "steer (threshold 3) and trip (threshold 5) both fire out
    // of a single batch"). If this ever fails, a dedup landed without its
    // detector-recall replays — see the ticket header, section 4.
    expect(reanchorMetrics()).toHaveLength(1);
    expect(breakerMetrics().some((m) => m.meta?.shape === 'success_intent' && m.meta?.tool === 'edit_file')).toBe(true);
  });
});
