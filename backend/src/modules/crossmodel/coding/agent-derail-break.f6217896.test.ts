/**
 * REPLAY TEST — ticket f6217896 (mishap, 2026-09-24): "5× success-side
 * wrong-tool loop: read_file on 'Digby's Nightly Self-Improvement Enginee'
 * — framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session b92ef13f-c3f8-487e-8267-767e56543150, run
 * f7667bd2-49e6-47ab-b4f2-3660d0b207d7, glm-5.3/zai, coding profile,
 * user-turn trigger — the 903249e5 schedule-drift design run): the trip
 * landed INSIDE an explorer SUBAGENT (delegate_parallel, title "Map
 * schedule tool surfaces (schema + response rendering)"). The subagent's
 * turn itemized a MULTI-TOOL batch as a checklist — reasoning tail (seq
 * 271–273): "…Let me batch:\n- grep `r.warning|\\.warning` under
 * backend/src/modules/crossmodel/coding\n- read deploy-repo-scope.51ff7e93.test.ts
 * head (1-80)\n- read sched-terminal-stop.test.ts head (1-60) and describe
 * headers via grep\n- read schedule.near-cap.b4d1096c.test.ts head\n- read
 * datetime-block.ts (chat-agent) 1-60\n- read news.service.ts 690-730\n…
 * Let me do the greps and reads in parallel." — and the dispatched batch
 * executed that checklist ITEM-FOR-ITEM: ONE grep (r.warning|\.warning)
 * plus SEVEN read_file calls (deploy-repo-scope.51ff7e93.test.ts,
 * sched-terminal-stop.test.ts, schedule.near-cap.b4d1096c.test.ts,
 * schedule-once-retime.82c13b77.test.ts, datetime-block.ts, news.service.ts,
 * tools.test.ts) — agent_events seq 275–290, every call SUCCEEDING.
 *
 * THE FRAMEWORK DEFECT (adjudicated f6217896, 2026-09-24): the checklist
 * is ONE final sentence (filename dots like ".test.ts" never split it —
 * finalSentence needs [.!?] followed by whitespace), so the conviction leg
 * of detectIntendedToolChannels counted the whole batch plan: whole-word
 * `grep` ×2, the called read_file never named, no "read … file" prose
 * sequence (read_file is 2 tokens; the narration's "read X head" spans
 * beyond the 12-word prose window). Every faithful sibling read_file was
 * convicted of "intending" grep — streaks 1–5 at 13:44:47.734–.753Z, every
 * guard_miss row reason 'preamble_ordered' (the standing-orders haystack
 * matched the SYSTEM PROMPT's own doctrine line "…grep/glob find exact
 * symbols; list_dir/read_file to read…"), re-anchor 13:44:47.757Z, trip
 * 13:44:51.980Z — read_file withheld one round mid-design-run and a mishap
 * auto-filed. An EARLIER batch the same minute proves the shape: seqs
 * 251–259 under narration naming glob+grep emitted grep AND a glob call
 * (seq 253) plus read_file ×6 — the aligned glob/grep calls acquitted
 * THEMSELVES (self-naming) and reset the streak mid-batch, so only the
 * read_file siblings counted (streaks 1–2, intended 'glob').
 *
 * WHY THIS IS NOT THE PINNED MODEL-SIDE CLASS: all four wild quadrants the
 * 4994e2f1 matrix closed (a1660b1a stable+silent, ee39f231 churn+loud,
 * c737d007 churn mechanics, 4994e2f1 stable+loud) name a tool the run NEVER
 * emits — narration-slip decoder locks on SINGLE-tool batches. Here the
 * narrated tool WAS emitted as the batch's own sibling call: the mention is
 * consumed by the call it announced, exactly the class the 7b2a0969 prose
 * self-naming and alias self-naming acquittal legs already handle for the
 * CALLED tool. The batch as a whole did exactly what it said.
 *
 * THE FIX (this ticket): BATCH-SIBLING acquittal in the success-side leg —
 * when the SAME dispatched batch emitted the convicted "intended" tool as
 * its own call, the mention is consumed by that sibling; reset the live
 * streak like an aligned success (classic counting preserved in the
 * measurement-shadow streak), log a guard_miss row reason 'batch_sibling'
 * (bounded at 12, same as the discount probe) so the acquittal volume stays
 * measurable, kill switch DERAIL_BATCH_SIBLING_DISABLED=1. SAME-BATCH ONLY:
 * cross-batch emission never acquits — the ee39f231 pin's grep-emitting
 * precursor turn precedes its read_file mismatches and the steer STILL
 * fires there (decoder-lock containment unchanged).
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop
 * and asserts:
 *   1. REPLAY the incident (mixed batch of 1 grep + 5 read_file under the
 *      itemized-checklist narration): NO re-anchor, NO trip, NO withhold —
 *      and the batch_sibling guard_miss rows log with the shadow streak.
 *   2. CONTAINMENT UNCHANGED (the pure-batch true positive): 5 read_file
 *      from a SINGLE-tool batch under the same grep-naming narration still
 *      steers at 3 and trips at 5 — the decoder-lock class stays contained.
 *   3. CROSS-BATCH NO-ACQUITTAL: a grep call in an EARLIER turn does not
 *      acquit later read_file mismatches (the ee39f231 precursor boundary).
 *   4. KILL SWITCH: DERAIL_BATCH_SIBLING_DISABLED=1 restores the classic
 *      ladder — the incident batch now steers and trips exactly as before.
 *   5. UNIT: the incident premise — the checklist narration convicts
 *      read_file of grep through the REAL detector, and the batch-sibling
 *      shape is distinguishable (dispatchCalls contains the intended tool).
 *
 * Scaffold mirrors agent-derail-break.0625bf62.test.ts: every call SUCCEEDS
 * ('probe result: ok'), read_file args vary by LETTER-skeleton path (never a
 * digit-only delta) so the exact and digit-collapsed repeat signatures stay
 * blind, and no run_command call ever appears (the scaffold's container
 * mock would leak to a real shell).
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
const mockExecuteCodingTool: jest.Mock = jest.fn();
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback seam dispatches via ctx.toolCache — keep the REAL
// TOOL_DEFINITIONS, stub only the executor (same success premise).
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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', TOOL_BATCH_CAP: 'tool_batch_cap' },
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

/** CODING profile (no workspace container in the scaffold). read_file,
 *  grep and glob (TOOL_DEFINITIONS) are all in the orchestrator's offered
 *  schema — so each is convictable when the narration names it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const WAKE = 'TICKET DISPATCH — design the schedule-drift warning; read the cited source regions and report.';

const makeInput = (userMessage: string = WAKE, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-f6217896-test',
  sessionId: 'sess-f6217896',
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

/** The incident's TEST-FILE PATHS (verbatim from the wild batch, seq
 *  275–290) — letter-skeleton varied per index so the exact and
 *  digit-collapsed repeat signatures stay blind. */
const READ_PATHS = [
  'backend/src/modules/crossmodel/fleet/deploy-repo-scope.51ff7e93.test.ts',
  'backend/src/modules/crossmodel/coding/sched-terminal-stop.test.ts',
  'backend/src/modules/crossmodel/coding/schedule.near-cap.b4d1096c.test.ts',
  'backend/src/modules/crossmodel/coding/schedule-once-retime.82c13b77.test.ts',
  'backend/src/modules/crossmodel/chat-agent/datetime-block.ts',
  'backend/src/modules/crossmodel/news.service.ts',
  'backend/src/modules/crossmodel/coding/tools.test.ts',
];
const readCall = (n: number) => ({
  id: `t${n}`,
  name: 'read_file',
  arguments: JSON.stringify({ path: READ_PATHS[(n - 1) % READ_PATHS.length], start_line: 1, end_line: 80 }),
});

/** THE INCIDENT NARRATION (verbatim shape, seq 271–273): the itemized
 *  multi-tool batch checklist. Names grep ×2 whole-word, NEVER read_file,
 *  and no "read … file" 12-word prose sequence — the exact text that
 *  convicted every faithful sibling read_file in the wild. */
const R_CHECKLIST = [
  'Now the replay-file conventions (describe headers, ticket citations) and the remaining pieces: warning assertions across coding tests, sibling schedule test files, the deploy-repo-scope example, and the timezone rendering helpers.',
  'Let me batch:',
  '- grep `r.warning|\\.warning` under backend/src/modules/crossmodel/coding',
  '- read deploy-repo-scope.51ff7e93.test.ts head (1-80)',
  '- read sched-terminal-stop.test.ts head (1-60) and describe headers via grep',
  '- read schedule.near-cap.b4d1096c.test.ts head',
  '- read schedule-once-retime.82c13b77.test.ts head',
  '- read datetime-block.ts (chat-agent) 1-60',
  '- read news.service.ts 690-730',
  'Let me do the greps and reads in parallel.',
].join('\n');

/** The grep sibling the batch ALSO emitted (seq 278). */
const grepCall = (n: number) => ({
  id: `g${n}`,
  name: 'grep',
  arguments: JSON.stringify({ pattern: 'r.warning|\\.warning', path: 'backend/src/modules/crossmodel/coding' }),
});

/** THE INCIDENT TURN: one dispatched batch = 1 grep + 5 read_file under the
 *  checklist narration. All succeed. */
const checklistBatchTurn = {
  content: 'Now the replay-file conventions and the timezone helpers.',
  reasoning: R_CHECKLIST,
  toolCalls: [grepCall(1), ...Array.from({ length: 5 }, (_, i) => readCall(i + 1))],
  finishReason: 'tool_calls' as const,
};

/** The PURE-BATCH true positive: the same grep-naming narration minus the
 *  checklist batch shape — 5 read_file from a SINGLE-tool batch (the
 *  4994e2f1 stable-intent class). Must still steer and trip. */
const R_PURE = 'Now grep the sibling test files to collect the warning assertions before writing the drift design.';
const pureReadTurn = (n: number) => ({
  content: '',
  reasoning: R_PURE,
  toolCalls: [readCall(n)],
  finishReason: 'tool_calls' as const,
});

/** CROSS-BATCH boundary: grep emitted in an EARLIER turn — the ee39f231
 *  precursor shape. Must NOT acquit the later read_file mismatches. */
const crossBatchGrepTurn = {
  content: '',
  reasoning: 'First, grep the coding directory for the warning idioms to anchor the search.',
  toolCalls: [grepCall(9)],
  finishReason: 'tool_calls' as const,
};

const FINAL = { content: 'Drift design complete.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const siblingMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'guard_miss' && m?.meta?.seam === 'tool_intent_attribution' && m?.meta?.reason === 'batch_sibling');
const discountMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'guard_miss' && m?.meta?.seam === 'tool_intent_attribution' && m?.meta?.reason !== 'batch_sibling');
/** runModelTurn receives the ONE shared messages array by reference — at
 *  assertion time it holds the full conversation; count steers/notices there. */
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockImplementation(async () => 'probe result: ok');
  delete process.env.DERAIL_INTENT_DISCOUNT_CAP;
});

describe('ticket f6217896 — batch-sibling acquittal for the 2c98b460 success-side guard', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, the CHECKLIST narration convicts read_file of grep through the REAL detector, and the pure narration convicts too', () => {
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    const offered = ['run_command', 'read_file', 'grep', 'glob', 'update_plan'];
    // The incident narration names grep whole-word, never read_file — the
    // conviction leg (final sentence = the whole checklist) convicts.
    expect(detectIntendedTool(R_CHECKLIST, 'read_file', offered)).toBe('grep');
    // The pure single-tool narration convicts identically — the DIFFERENCE is
    // only whether the batch emitted the named tool (asserted at the loop
    // level below), which is why the fix lives in agent.ts, not the detector.
    expect(detectIntendedTool(R_PURE, 'read_file', offered)).toBe('grep');
    // A narration that names the called tool acquits (the standing contract).
    expect(detectIntendedTool('read_file the guard block now.', 'read_file', offered)).toBeNull();
  });

  it('REPLAY the incident (mixed batch: 1 grep + 5 read_file under the itemized-checklist narration): NO steer, NO trip, NO withhold — the batch is aligned work and logs batch_sibling rows with the shadow streak', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(checklistBatchTurn)
      .mockResolvedValueOnce(FINAL);
    const input = makeInput(WAKE);
    await runCodingAgent(input);

    // NO containment fired: no re-anchor, no trip, no breaker.
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(steerMessages()).toHaveLength(0);

    // Every faithful sibling read_file logged its batch_sibling acquittal
    // (the grep call itself is self-naming-aligned and logs nothing) — 5 rows,
    // shadow streak 1..5, batch size 6, marker = the consumed sibling grep.
    const sib = siblingMetrics();
    expect(sib).toHaveLength(5);
    expect(sib.every((m) => m.meta.tool === 'read_file' && m.meta.intended === 'grep' && m.meta.marker === 'grep')).toBe(true);
    expect(sib.map((m) => m.meta.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(sib.every((m) => m.meta.batch === 6)).toBe(true);
  });

  it('CONTAINMENT UNCHANGED — the pure single-tool batch under the same grep-naming narration still steers at 3 and trips at 5 (the decoder-lock class stays contained)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(pureReadTurn(1))
      .mockResolvedValueOnce(pureReadTurn(2))
      .mockResolvedValueOnce(pureReadTurn(3))
      .mockResolvedValueOnce(pureReadTurn(4))
      .mockResolvedValueOnce(pureReadTurn(5))
      .mockResolvedValueOnce(FINAL);
    const input = makeInput(WAKE);
    await runCodingAgent(input);

    const ra = reanchorMetrics();
    const br = breakerMetrics();
    expect(ra).toHaveLength(1);
    expect(ra[0].meta).toMatchObject({ tool: 'read_file', intended: 'grep', reason: 'intent_mismatch_success', churned: false });
    expect(br).toHaveLength(1);
    expect(br[0].meta).toMatchObject({ tool: 'read_file', shape: 'success_intent', perma: false, intended: 'grep', churned: false });
    expect(steerMessages()).toHaveLength(1);
    // No sibling acquittals — the batch never emitted grep.
    expect(siblingMetrics()).toHaveLength(0);
  });

  it('CROSS-BATCH NO-ACQUITTAL — a grep emitted in an EARLIER turn does not acquit later read_file mismatches (the ee39f231 precursor boundary)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(crossBatchGrepTurn)   // earlier turn: grep under its own aligned narration
      .mockResolvedValueOnce(pureReadTurn(1))
      .mockResolvedValueOnce(pureReadTurn(2))
      .mockResolvedValueOnce(pureReadTurn(3))
      .mockResolvedValueOnce(pureReadTurn(4))
      .mockResolvedValueOnce(pureReadTurn(5))
      .mockResolvedValueOnce(FINAL);
    const input = makeInput(WAKE);
    await runCodingAgent(input);

    const ra = reanchorMetrics();
    const br = breakerMetrics();
    expect(ra).toHaveLength(1);
    expect(br).toHaveLength(1);
    expect(br[0].meta).toMatchObject({ tool: 'read_file', shape: 'success_intent', intended: 'grep' });
    expect(siblingMetrics()).toHaveLength(0);
    // The earlier grep turn was aligned (self-naming) and never fed the
    // read_file streak: per-tool key isolation held — steer fired only at
    // read_file's third.
    expect(steerMessages()).toHaveLength(1);
  });

  });
