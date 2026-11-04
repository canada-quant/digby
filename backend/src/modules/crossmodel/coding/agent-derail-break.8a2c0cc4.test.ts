/**
 * REPLAY TEST — ticket 8a2c0cc4 (mishap, auto-filed 2026-10-20T19:53:06Z):
 * "5× success-side wrong-tool loop: edit_file on 'Probe agx-laya
 * chat-completions logprobs' — framework or model?" Auto-filed at the
 * 2c98b460 success-side breaker trip (owner doctrine 2026-09-10: self-heal
 * + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session c087ddaa-354f-4869-9225-4cf40cabf9cf — the
 * agx-laya logprob-probe lane, run f840c067-f882-47b2-919b-5435c6c5c542,
 * glm-5.3/zai, machine-triggered, 19:11:04Z→19:59:33Z, status completed,
 * error null): probe-8a2c0cc4-a.js read the run's 520 agent_events + all
 * 6 guard_strike / 3 guard_miss rows fresh. The run row spans TWO
 * derail episodes and ONE resume seam — the class's first such instance:
 *
 * EPISODE 1 (steer-only containment — the class's first steer-alone
 * recovery): state-doc surgery at 19:37 (aligned), then a short mismatch
 * run whose LIVE reasoning rotated its named intent (meta churned:true,
 * latest intended verify) — re-anchor steer armed at the third counted
 * miss (reanchor metric 19:38:59.279Z, guard_marker seq 203), NO trip.
 * The very next message ("Acknowledged — running the verify chain now
 * with its real parameters…", seq 206) called verify ALIGNED (seq 208,
 * 19:38:59.5Z) — the streak reset, the lane recovered on the steer alone.
 *
 * THE RESUME SEAM: complete @19:48:37.342Z (seq 399) / init @19:48:38.365Z
 * (seq 400) — a deploy restart mid-run (the lane's own ep2 narration:
 * "the third's text was lost to the deploy restart"). The run row was
 * re-claimed: a FRESH agentLoop invocation, and reAnchorUsed is
 * agentLoop-scoped state (agent.ts:2638, outside the while(!done) loop) —
 * so the resumed loop carries its OWN one-per-run re-anchor budget. That
 * is why TWO re-anchor markers fire in one run row, each truthfully
 * saying "(one per run)" — per agentLoop LIFECYCLE, not per run row. A
 * labeling nuance to know when reading guard_marker censuses, not a
 * defect: the resumed loop's replayed transcript carries the marker TEXT
 * as a guard-stamped part, not the steer's role:'user' message, so the
 * fresh loop's model was never structurally told the toolset truth —
 * re-anchoring it again is the designed behavior.
 *
 * EPISODE 2 (the ticket's trip): ONE message (boundary seq 433, 19:53Z)
 * of FIVE edit_file calls (seq 434,437,440,443,446 @ 19:53:02.905–968),
 * ALL SUCCEEDED — applying the two receipt-verifiable reviewer fixes
 * (config.yaml agx-laya stanza comment, learnings.md entry) plus state-doc
 * trims. Re-anchor steer at the third counted miss (reanchor metric
 * 19:53:02.972Z, churned:false, intended list_batch_trains — a PLATFORM
 * tool, the class's first platform-intent instance), trip at the fifth
 * (break metric 19:53:06.402Z, shape success_intent, perma:false,
 * intended list_batch_trains, churned:false). The DW-4 args snapshot
 * (newest-first cap 3) carried only ep2 shapes — the ep1 streak never
 * leaked into ep2's trip (the aligned verify:208 reset it).
 *
 * VERDICT — MODEL BEHAVIOR, GUARD CORRECT (the 601d819e elimination,
 * reproduced for this instance by probe-8a2c0cc4-a.js on the DEPLOYED
 * code, box A, 2026-10-21T02:4xZ):
 * 1. The detector is UNCHANGED since the 601d819e adjudication
 *    (3a40afb66, #1785): git log on tool-preflight.ts and -S
 *    intentMissCount / -S intent_mismatch_success over agent.ts since
 *    3a40afb66 are all empty, and the deployed battery behaves per spec
 *    (arity 5; bare-intent reasoning convicts, glued compound acquits,
 *    called-tool-named acquits, empty acquits, quoted intent convicts).
 * 2. The verbatim-recovered CONTENT channels convict NOTHING (probe:
 *    convicted message 224 chars, ZERO list_batch_trains mentions broad
 *    or standalone, zero edit_file mentions; adjacent aligned message
 *    248 chars, same) and the run persisted ZERO reasoning events (the
 *    hide-thinking wire cut; reasoning replay is kimi-only) — so the
 *    conviction necessarily rode the LIVE reasoning channel: glm-5.3
 *    narrated its planned NEXT step (checking for a boarding batch
 *    train before the merge — exactly what it did at seq 454: "…
 *    list_batch_trains confirms: 0 trains boarding") while edit_file
 *    correctly executed the five review-fix edits. A narration/emission
 *    slip on the model side, on successful, real, intended work.
 * 3. No batch sibling: the dispatched batch was exactly the five
 *    edit_file calls; the run's only list_batch_trains calls are seq 23
 *    (early) and seq 454 (post-trip recovery) — the f6217896
 *    batch-sibling acquittal correctly never fired.
 * 4. The guard stack per design at every rung: ep1 steer@3 churned:true
 *    no trip (steer-alone recovery), ep2 steer@3 + trip@5 with the
 *    truthful SUCCESS shape, one-round withhold only (no perma, no
 *    run-end), the 0625bf62 discount correctly out of scope (edit_file
 *    is a coding tool; the intended platform tool is not the discount's
 *    subject), and the recovery turn called list_batch_trains (seq 454,
 *    19:53:17Z — the grounded next action), then verify (seq 462, Verify
 *    PASSED), update_plan, rebase, push (d13a9508), PR #159 (opened
 *    19:55:13Z, auto-verify green, MERGED 19:58:01Z, squash 207514d8 —
 *    canada-quant/litellm, the session's repo; the earlier PR #158, the
 *    state-doc PR, merged 19:42:36Z c3b9f2c4), final_verdict clean ×2
 *    (19:48:37Z, 19:59:33Z). The lane shipped its remediation clean
 *    despite the mid-batch trip; no owner impact; every edit was real,
 *    intended work.
 *
 * No detector change rides this ticket (per the detector-change rule).
 * Deliverable: this replay pin + scripts/framework-audit/probe-8a2c0cc4-a.js
 * and probe-8a2c0cc4-b.js (the committed forensic probes: per-episode
 * message-boundary CTX grouping, intended-tool occurrence classification,
 * deployed-detector battery, dispatch-batch composition, guard-telemetry
 * census, and the PR-event payload read that pins the two-PR recovery).
 *
 * Scaffold mirrors agent-derail-break.601d819e.test.ts: every mismatched
 * call SUCCEEDS ('probe result: ok'), edit_file args are the wild
 * ep2 shapes (letter-skeleton-varied so the exact and digit-collapsed
 * repeat signatures stay blind), the narration names exactly ONE offered
 * tool as a whole word and never the called edit_file — nor any prose
 * "edit … file" run (proseMentionsTool acquittal) — and args carry no
 * id-shaped keys so no ungrounded-id preflight leg can refuse them.
 * list_batch_trains rides PLATFORM_TOOL_SCHEMA inside CODING_TOOL_SCHEMA
 * (tools.ts:1103), so the scaffold's offeredNames carries it without any
 * grouping dance (an unoffered named tool makes detectIntendedTool return
 * null and silently resets the streak — the c737d007 test-writing gotcha).
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
import { detectIntendedTool, detectIntendedToolChannels, intentMismatchDiscount } from './tool-preflight';

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

/** The incident's wake text (the agx-laya remediation dispatch): names the
 *  remediation work, the pre-merge batch-train check and the verify step —
 *  the narration-slip is the model's own, but the brief makes the
 *  list_batch_trains next-step plan legitimate (that is exactly why the
 *  model narrated it mid-batch). Mentions edit_file NOWHERE (a
 *  preamble_ordered discount would acquit the called tool). */
const BRIEF = 'Session dispatch: land the agx-laya remediation — apply the two receipt-verifiable reviewer fixes onto a fresh rebase of origin/main, check whether a batch train is boarding before any merge to main, verify the chain, publish through the gated PR flow, and report the landed artifacts.';

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-8a2c0cc4-test',
  sessionId: 'sess-8a2c0cc4',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** The incident narration for EPISODE 2 (the LIVE reasoning channel of the
 *  convicted message — not persisted for zai/glm-5.3, but pinned by the
 *  guard's own strike telemetry: intended list_batch_trains, churned:false,
 *  standalone): the model narrated its planned NEXT step — the pre-merge
 *  batch-train check its own content channel omits — while edit_file
 *  correctly executed the five review-fix edits. Names exactly ONE offered
 *  tool as a whole word, never the called edit_file, and no "edit … file"
 *  prose run. */
const P_NARRATION_E2 = 'Both review fixes are queued for the config stanza and the learnings row; before publishing anything I must check whether a batch train is boarding — call list_batch_trains now to read the live boarding state.';

/** The verbatim-recovered CONTENT channel of the convicted ep2 message
 *  (probe fact: 224 chars of text deltas, ZERO tool mentions under the
 *  broad boundary — not list_batch_trains, not even edit_file). */
const C_CONVICTED_E2 = 'Tree is identical to `origin/main` (0 files differ) — safe to build the remediation on top. Applying the two receipt-verifiable review fixes now (the third\'s text was lost to the deploy restart and will be reported as such):';

/** The verbatim-recovered CONTENT channel of one adjacent aligned ep1
 *  message (probe fact: 248 chars, 19:37:06Z — the state-doc surgery
 *  announcement, single-tool-free, on-task). */
const C_ALIGNED_E1 = 'I\'m on step 7 (final). `tmp/` is gitignored so probe scripts stay out of the repo. Now the state-doc update — the file is over its 6,000-char cap (6,260), so I\'ll make room with surgical trims of superseded detail while adding the new CLOSED entry:';

/** The elimination corpus — exactly the two recovered messages above. */
const C_WILD_WHOLE = C_CONVICTED_E2 + '\n\n' + C_ALIGNED_E1;

/** EPISODE 1's modeled live reasoning (two turns, rotating named intent —
 *  the churned:true telemetry): turn A names git_commit, turn B names
 *  verify. Each names exactly ONE offered tool, never edit_file. */
const P_NARRATION_E1A = 'Two small trims remain in the state doc; once they land I will git_commit the folded result with the unpushed fix on top.';
const P_NARRATION_E1B = 'The state doc is still 61 chars over cap; before committing anything further I will verify the chain and then trim the residue down.';

const TRIMS: Array<[string, string, string]> = [
  ['deploy/config.yaml', '  # decision seat: point it at the legacy leg (no logprob readout).', '  # decision seat: point it at deepseek-v4.1-flash (logprobs+\n  # top_logprobs verified 322–513 ms). 18:29Z api_usage_error (c53ea6a0)\n  # = TypeSafe Jev leg, third-party.'],
  ['.digby/notes/learnings.md', '- Probe note: the decide shape 200s in 78–87 ms but returns CLASS probabilities', '- Probe note: the decide shape 200s in 78.3–86.7 ms (samples 85.0/78.3/81.1) but returns CLASS probabilities'],
  ['.digby/rules/00-current-state.md', '  → our handler by-design 400 guard, 30.7–37.1 ms (same guard\n  message as the gate log rows); decide shape 200 in 78.3–86.7 ms', '  → our handler\'s by-design 400 guard, 30.7–37.1 ms (same guard\n  message as the gate log rows, which truncate at ~200 chars); decide\n  shape 200 in 78.3–86.7 ms returns CLASS'],
  ['.digby/rules/00-current-state.md', '  for the decision seat: point it at the legacy leg (no logprob readout).', '  for the decision seat: point it at deepseek-v4.1-flash (logprobs+\n  top_logprobs verified 322–513 ms). 18:29Z api_usage_error (c53ea6a0)\n  = TypeSafe Jev leg, third-party.'],
  ['deploy/config.yaml', '  # agx-laya: plain chat-completions leg, no extras.', '  # agx-laya: chat-completions leg w/ logprobs+top_logprobs (verified\n  # 322–513 ms); the decide shape is the 400-guard class, not a defect.'],
];
const editCall = (n: number) => {
  const [path, old_string, new_string] = TRIMS[(n - 1) % TRIMS.length];
  return {
    id: `t${n}`,
    name: 'edit_file',
    arguments: JSON.stringify({ path, old_string, new_string }),
  };
};

/** THE INCIDENT SHAPE — EPISODE 2: ONE message of FIVE edit_file calls
 *  (wild seq 434..446, all SUCCEEDED) under the list_batch_trains-naming
 *  live reasoning with a list_batch_trains-free content channel. Steer
 *  arms at call 3, trip at call 5; the in-flight batch fully executes. */
const convictedBatchTurn = {
  content: C_CONVICTED_E2,
  reasoning: P_NARRATION_E2,
  toolCalls: Array.from({ length: 5 }, (_v, i) => editCall(i + 1)),
  finishReason: 'tool_calls' as const,
};

/** EPISODE 1, turn A (wild 19:38:41Z): ONE mismatched edit under the
 *  git_commit-naming live reasoning (count 1). */
const ep1TurnA = {
  content: 'Still 61 over — two small trims, then fold into the unpushed commit:',
  reasoning: P_NARRATION_E1A,
  toolCalls: [editCall(3)],
  finishReason: 'tool_calls' as const,
};

/** EPISODE 1, turn B (wild 19:38:59Z): TWO more mismatched edits under
 *  the verify-naming live reasoning (counts 2 and 3 → the steer arms,
 *  churned:true — the named intent rotated git_commit → verify). */
const ep1TurnB = {
  content: 'Trimming the two superseded lines now, then the chain check before the gated publish:',
  reasoning: P_NARRATION_E1B,
  toolCalls: [editCall(4), editCall(5)],
  finishReason: 'tool_calls' as const,
};

/** EPISODE 1's recovery turn (wild seq 206/208, 19:38:59.5Z): acknowledges
 *  the steer, then calls verify ALIGNED — the streak resets, no trip. */
const ep1RecoveryTurn = {
  content: 'Acknowledged — running the verify chain now with its real parameters, then finishing the commit → gated push → PR.',
  reasoning: 'Running the verify chain with its real parameters now, as the notice asked.',
  toolCalls: [{ id: 'tv1', name: 'verify', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
};

/** EPISODE 2's recovery turn (wild seq 454, 19:53:17Z): the post-trip
 *  round — edit_file sits out its one-round ban, and the lane calls
 *  list_batch_trains, the grounded next action its reasoning had named. */
const recoveryLbtTurn = {
  content: '`list_batch_trains` confirms the boarding state before the gated publish; then the size check, verify, commit → rebase → publish:',
  reasoning: 'Checking for a boarding batch train first, as intended for this stage of the publish.',
  toolCalls: [{ id: 'tl1', name: 'list_batch_trains', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
};

const FINAL = { content: 'Remediation landed: both review fixes applied, chain green, PR merged through the gated flow.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

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

describe('ticket 8a2c0cc4 — success-side wrong-tool trip on glm-5.3, PLATFORM-tool intent (list_batch_trains), two episodes + a resume seam: model behavior, guard correct', () => {
  it('UNIT (the elimination leg): the verbatim-recovered CONTENT channels convict NOTHING — the conviction necessarily rode the LIVE reasoning channel, and the platform-tool intended name is no discount subject', () => {
    const offered = ['run_command', 'edit_file', 'verify', 'read_file', 'grep', 'write_file', 'glob', 'list_batch_trains', 'git_commit'];
    // The whole recovered span (probe fact: both episodes' text deltas that
    // the ticket's args window covers) as one content channel — every
    // per-message subset is contained in it, so zero mentions here means
    // zero in each message's own channel too.
    expect(detectIntendedToolChannels('', C_WILD_WHOLE, 'edit_file', offered)).toBeNull();
    // The faithful per-message content channels convict nothing standalone.
    expect(detectIntendedTool(C_CONVICTED_E2, 'edit_file', offered)).toBeNull();
    expect(detectIntendedTool(C_ALIGNED_E1, 'edit_file', offered)).toBeNull();
    // The modeled live-reasoning narration DOES convict — the only channel
    // that can have carried the standalone `list_batch_trains` the strike
    // meta named.
    expect(detectIntendedTool(P_NARRATION_E2, 'edit_file', offered)).toBe('list_batch_trains');
    expect(detectIntendedToolChannels(P_NARRATION_E2, C_CONVICTED_E2, 'edit_file', offered)).toBe('list_batch_trains');
    // edit_file is a CODING tool — the 0625bf62 platform-tool discount is
    // out of scope even when the wake text names the platform intent's
    // work (measure-first); the brief never orders edit_file.
    expect(intentMismatchDiscount('list_batch_trains', 'edit_file', BRIEF)).toBeNull();
  });

  it('REPLAY episode 2 (the ticket\'s trip: ONE message of FIVE mismatched edit_file calls, STABLE platform intent list_batch_trains): steer at the third call, trip at the fifth, all five still execute, one-round withhold only, and the run RECOVERS on the modeled list_batch_trains turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(convictedBatchTurn) // wild seq 433–446: 5 mismatches, one message, all SUCCEED
      .mockResolvedValueOnce(recoveryLbtTurn)    // the ban round: edit_file absent; list_batch_trains runs (wild seq 454)
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Remediation landed: both review fixes applied, chain green, PR merged through the gated flow.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // ── Steer armed at the THIRD cumulative mismatch, deferred to message
    //    end (wild reanchor metric 19:53:02.972Z, guard_marker seq 449) ──
    expect(steerMessages()).toHaveLength(1);
    const steer = String(steerMessages()[0].content);
    expect(steer).toContain('[HARNESS NOTICE — not typed by the user] RE-ANCHOR (one per run)');
    expect(steer).toContain('your own reasoning named list_batch_trains');
    expect(steer).toContain('call list_batch_trains NOW');
    // The steer tells the TRUTH about the SUCCESS shape (2c98b460 reviewer F1).
    expect(steer).toContain('it SUCCEEDED');
    expect(steer).not.toContain('and it failed');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'edit_file', intended: 'list_batch_trains', reason: 'intent_mismatch_success', churned: false,
    });

    // ── Trip at the FIFTH cumulative mismatch, one round only — the
    //    incident's exact meta (break 19:53:06.402Z) ──
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'list_batch_trains', churned: false, shape: 'success_intent',
    });
    expect(breakerMetrics()).toHaveLength(1); // one-round withhold only — no perma, no run-end

    // ── The whole in-flight batch executed despite the trip (the withhold
    //    applies to the NEXT round's schema, not the batch) — wild calls
    //    434..446 all succeeded 19:53:02.905–968Z ──
    const editDispatches = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file');
    expect(editDispatches.length).toBe(5);

    // ── The modeled recovery: the post-trip turn calls list_batch_trains
    //    (a PLATFORM tool — rides executeCodingTool's platform branch), the
    //    run continues and finishes clean (wild seq 454 → PR #159 merged) ──
    const lbtDispatch = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'list_batch_trains');
    expect(lbtDispatch.length).toBeGreaterThanOrEqual(1);
    // The user-visible notices tell the TRUTH about the success shape: the
    // withhold notice says the last 5 edit_file calls SUCCEEDED — the
    // byte-shape the wild lane received at 19:53:06Z (agent.ts:6317).
    const withholdNotice = userTexts().find((t) => t.includes('temporarily removed from your tool list'));
    expect(withholdNotice).toBeDefined();
    expect(withholdNotice).toContain('Your last 5 calls of edit_file all SUCCEEDED');
  });

  it('REPLAY episode 1 + the resume seam (the class\'s first steer-ALONE containment and first two-episode run row): a rotating-intent streak arms the steer WITHOUT tripping, the aligned verify turn resets it, and a RESUMED agentLoop carries its own one-per-run re-anchor budget', async () => {
    // ── Episode 1: one agentLoop invocation — counts 1 (turn A,
    //    git_commit-named), 2 and 3 (turn B, verify-named) → the steer
    //    arms at the THIRD with churned:true (the named intent rotated);
    //    the recovery turn's ALIGNED verify call resets the streak — NO
    //    trip (wild: reanchor 19:38:59.279Z churned:true intended verify,
    //    zero tool_derail_break rows before 19:48Z, verify:208 aligned). ──
    mockRunModelTurn
      .mockResolvedValueOnce(ep1TurnA)        // count 1 (git_commit named)
      .mockResolvedValueOnce(ep1TurnB)        // counts 2, 3 (verify named) → steer, churned:true
      .mockResolvedValueOnce(ep1RecoveryTurn) // ALIGNED verify — the streak resets (wild seq 206/208)
      .mockResolvedValue(FINAL);
    const r1 = await runCodingAgent(makeInput());
    expect(r1.modelErrored).toBeUndefined();
    expect(r1.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'edit_file', intended: 'verify', reason: 'intent_mismatch_success', churned: true,
    });
    expect(breakerMetrics()).toHaveLength(0); // steer-ALONE containment: the peak was 3, never 5
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'edit_file').length).toBe(3);
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'verify').length).toBe(1);

    // ── The resume seam (wild complete @19:48:37Z / init @19:48:38Z, the
    //    deploy restart): a SECOND agentLoop invocation on the same run
    //    row starts with FRESH loop-scoped latch state — its own
    //    one-per-run re-anchor budget. Episode 2 then proceeds exactly as
    //    the standalone replay: steer@3 (churned:false) + trip@5. Two
    //    guard_markers in one run row is the designed per-LOOP shape, not
    //    a latch leak (agent.ts:2638 declares reAnchorUsed per agentLoop). ──
    jest.clearAllMocks();
    mockRunModelTurn
      .mockResolvedValueOnce(convictedBatchTurn) // ep2: counts 1..5, stable list_batch_trains
      .mockResolvedValueOnce(recoveryLbtTurn)
      .mockResolvedValue(FINAL);
    const r2 = await runCodingAgent(makeInput());
    expect(r2.modelErrored).toBeUndefined();
    expect(steerMessages()).toHaveLength(1); // the resumed loop's OWN steer — exactly one within it
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({
      tool: 'edit_file', intended: 'list_batch_trains', reason: 'intent_mismatch_success', churned: false,
    });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({
      tool: 'edit_file', perma: false, intended: 'list_batch_trains', churned: false, shape: 'success_intent',
    });
  });

  it('THRESHOLD (the 2c98b460 precedent shape, platform-intent variant): TWO mismatched edit_file successes never arm the steer, THREE arm it without tripping, FOUR still do not trip — the ep1 wild peak was exactly three, and it stayed un-tripped', async () => {
    const nCallTurn = (n: number) => ({ ...convictedBatchTurn, toolCalls: Array.from({ length: n }, (_v, i) => editCall(i + 1)) });

    // TWO mismatches: below the steer threshold — no reanchor, no break.
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(2)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(reanchorMetrics()).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);

    // THREE mismatches (the ep1 wild peak): the steer arms, the breaker
    // NEVER engages — the run finishes clean without a recovery turn.
    jest.clearAllMocks();
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(3)).mockResolvedValue(FINAL);
    const r3 = await runCodingAgent(makeInput());
    expect(r3.modelErrored).toBeUndefined();
    expect(r3.finalText).not.toContain('Run ended: repeated wrong-tool derailment');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ tool: 'edit_file', intended: 'list_batch_trains', reason: 'intent_mismatch_success' });
    expect(breakerMetrics()).toHaveLength(0);

    // FOUR mismatches: still no trip — one steer only (a steer@2/trip@4
    // regression trips here).
    jest.clearAllMocks();
    mockRunModelTurn.mockResolvedValueOnce(nCallTurn(4)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(reanchorMetrics()).toHaveLength(1);
    expect(breakerMetrics()).toHaveLength(0);
  });
});
