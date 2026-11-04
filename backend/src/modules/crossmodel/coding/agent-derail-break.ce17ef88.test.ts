/**
 * Replay pin — ticket ce17ef88 (mishap, session 1b30452f-d4eb-4dde-98d0-
 * f63a95e31a65 "Ticket B9cb221b Investigation", run 8079167b-a298-412a-
 * 920c-57a826619120, seat kimi-k3).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * verify_durable' mishap with TWO IDENTICAL failure texts (newest first):
 *   `{"ok":false,"tool":"verify_durable","reason":"not_found","message":
 *    "No training artifact \"b9cb221b\" — register_artifact first."}`  ×2
 * (the resource-tools.ts:277 not-found envelope — no artifact row for the
 * ref). The ticket note records "lane's reasoning named
 * merge_pull_request".
 *
 * RECONSTRUCTED CHRONOLOGY + VERIFIED TRIP MATH (against source bytes @
 * 8e53daeff3): BOTH verify_durable({id:"b9cb221b"}) calls EXECUTED — they
 * reached the resource executor, which proves the pre-flight's grounding
 * check PASSED (verify_durable IS a preflight-covered platform tool,
 * platform-tool-names.ts:185; agent.ts:2964-2976). WHICH rule grounded it:
 * the id-SHAPE rule — ID_SHAPE_RE /^[0-9a-f]{8}/i (tool-preflight.ts:35).
 * "b9cb221b" is 8 lowercase hex chars → shape-valid with NO haystack
 * occurrence needed. The run's context DID carry the ticket title's
 * "B9cb221b" (capital B), but the verbatim-occurrence rule
 * (haystack.includes, tool-preflight.ts:73) is CASE-SENSITIVE — that
 * occurrence does NOT ground the lowercase call id; the shape rule is what
 * grounds it (and the shape rule is itself case-INSENSITIVE — the /i flag;
 * "B9cb221b" would pass too). Unit-pinned below. So each call executed and
 * the resource layer refused truthfully — +1 failure each
 * (agent.ts:3172-3173) = 2. The third weighted point is the
 * INTENT-MISMATCH fast-trip — REAL weighted machinery, not an auto-filer
 * observation: detectIntendedTool (tool-preflight.ts:86-104) runs on EVERY
 * failure-shaped result at agent.ts:3181; a conviction adds +1 and is
 * filed as StreakEvidence.intended (agent.ts:3183, 3277-3282). The lane's
 * reasoning named merge_pull_request — a DIFFERENT offered tool, the
 * called tool never named — so call 1 = +1 failure +1 intent = 2, call 2
 * = +1 failure = 3 → TRIP (3184), exactly two texts captured newest-first
 * (3176-3177). The two calls are identical, but the identical-call loop
 * breaker never enters: it needs the same signature THREE turns running
 * (repeatCount ≥ 2, agent.ts:3308-3310/3339) — the derail breaker trips on
 * the SECOND call. (Had the second turn's reasoning also named
 * merge_pull_request the count would be 4 ≥ 3 — the trip lands on the
 * same call with the same two texts; this replay pins the minimal
 * arithmetic: the intent weight on the FIRST call, a pure failure on the
 * second.)
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the lane
 * decoder-locked on verify_durable with a shape-valid but never-registered
 * artifact ref while its own reasoning named merge_pull_request — NOT a
 * deterministic framework defect; every deterministic seam (the shape
 * rule, the resource not-found envelope, the intent-mismatch weight, the
 * weighted breaker, the one-round withhold) behaved exactly as designed.
 * No shape exemption (ea69c94e doctrine). NO platform code change.
 *
 * These tests pin: the grounding path (case-SENSITIVE occurrence vs
 * case-INSENSITIVE 8-hex shape; a non-hex contrast staying ungrounded),
 * the resource-tools.ts:277 envelope byte-faithful to the filed text
 * (refuse() = {ok:false, tool, reason, message} at resource-tools.ts:
 * 157-159; the em-dash message verbatim), the intent detector convicting
 * merge_pull_request from the trip turn's own words, the two real calls
 * tripping the breaker at weighted count 3 with the two identical filed
 * texts newest-first and StreakEvidence.intended = 'merge_pull_request',
 * both calls reaching the executor, and the first trip withholding the
 * tool for ONE round (not perma). Scaffold mirrors
 * agent-derail-break.ec9d7424.test.ts (same mock set); the
 * merge_pull_request stub-into-extraTools idiom mirrors
 * agent-derail-break.1ee07214.test.ts (per-run extra tools join the
 * offered list, agent.ts:967, so the REAL detectIntendedTool sees
 * merge_pull_request as offered — a coding-profile lane offers the real
 * one; merge_pull_request is a workspace tool, tools.ts:380, not a
 * chat-profile platform tool).
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
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
  buildChatWakeClockNote: jest.fn(() => ""),
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
import { findUngroundedIdArgs, detectIntendedTool } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim ref (ticket ce17ef88) ────────────────────────────
const CALL_ID = 'b9cb221b'; // both calls — a shape-valid artifact ref that was NEVER registered
const RECOVERY_ID = 'ce17ef88'; // 8-hex — shape-valid citation for the recovery call

/** The resource not_found envelope exactly as the breaker counted it —
 *  resource-tools.ts:277 via refuse() (157-159):
 *  JSON.stringify({ok:false, tool, reason, message}, null, 1), the message
 *  carrying the em-dash verbatim: `No training artifact "${ref}" — register_artifact first.` */
const RESOURCE_ENVELOPE = JSON.stringify(
  {
    ok: false,
    tool: 'verify_durable',
    reason: 'not_found',
    message: `No training artifact "${CALL_ID}" — register_artifact first.`,
  },
  null,
  1,
);

/** The investigation brief — carries the ticket title's "B9cb221b" (capital
 *  B) exactly as the real session title did. That occurrence is NOT a
 *  verbatim ground for the lowercase call id (haystack.includes is
 *  case-sensitive, tool-preflight.ts:73) — the SHAPE rule grounds it. */
const BRIEF = [
  '[Ticket B9cb221b investigation — record-only durability watch]',
  'The lane tracks the durability story of the B9cb221b training artifact.',
  'Stamp durability only after a real check this run; never invent an artifact id.',
].join('\n');

/** The first (intent-convicted) turn's own words — per the ticket note
 *  "lane's reasoning named merge_pull_request": names ANOTHER offered tool
 *  as a whole word and NEVER the called one, so the REAL detectIntendedTool
 *  convicts it (+1 fast-trip, agent.ts:3181-3183). */
const INTENT_REASONING =
  'The training checkpoint is uploaded; once the durability stamp lands I will merge_pull_request to publish the branch.';
/** The second turn's reasoning names verify_durable — no intent weight:
 *  the streak's third point is already banked; this call is a pure +1. */
const PLAIN_REASONING =
  'Call verify_durable once more with the same artifact id — the first not_found answer must have been a stale read.';

/** Stub so the REAL detectIntendedTool sees merge_pull_request as offered — it
 *  was a live offered tool in the lane's (coding-profile) run; the chat test
 *  profile does not offer workspace tools, so the extraTools seam
 *  (agent.ts:967) stands in, mirroring agent-derail-break.1ee07214.test.ts. */
const MERGE_PR_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'merge_pull_request',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'merge ok'),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-ce17ef88-test',
  sessionId: 'sess-ce17ef88',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the watch now.`,
  extraTools: [MERGE_PR_STUB],
  emit: jest.fn(),
});

/** A turn calling verify_durable({id:"b9cb221b"}) with an explicit reasoning text. */
const durableTurn = (n: number, id: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'verify_durable', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Watch recorded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay ce17ef88 — two shape-grounded not_found refusals + the intent-mismatch weight read as a "3× verify_durable streak"', () => {
  it('the grounding path: the title’s capital-B occurrence does NOT verbatim-ground the lowercase id (case-sensitive, tool-preflight.ts:73) — the case-INSENSITIVE 8-hex SHAPE rule does (tool-preflight.ts:35)', () => {
    expect(BRIEF).toContain('B9cb221b'); // the session title's capital-B form
    expect(BRIEF.includes(CALL_ID)).toBe(false); // NOT a verbatim occurrence of "b9cb221b"
    // Grounded anyway — the 8-hex shape rule needs no occurrence at all.
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF)).toEqual([]);
    expect(findUngroundedIdArgs({ id: CALL_ID }, 'no mention of the artifact id anywhere')).toEqual([]);
    // The shape rule itself is case-insensitive (/i) — the capital-B form passes too.
    expect(findUngroundedIdArgs({ id: 'B9cb221b' }, 'no mention of the artifact id anywhere')).toEqual([]);
    // Contrast: 8th char non-hex and absent from the haystack → ungrounded.
    expect(findUngroundedIdArgs({ id: 'b9cb22zz' }, BRIEF))
      .toEqual([{ key: 'id', value: 'b9cb22zz' }]);
  });

  it('pins the resource not_found envelope byte-faithful to the filed texts (resource-tools.ts:277 via refuse() at 157-159; the em-dash message verbatim; the {"ok": false failure shape the breaker counts)', () => {
    const env = JSON.parse(RESOURCE_ENVELOPE);
    expect(env).toEqual({
      ok: false,
      tool: 'verify_durable',
      reason: 'not_found',
      message: 'No training artifact "b9cb221b" — register_artifact first.',
    });
    // The structured {"ok": false head is the failure shape looksLikeToolFailure
    // matches (learnings-index.service.ts:364) — the streak breaker sees it.
    expect(RESOURCE_ENVELOPE).toMatch(/^\{\s*"ok":\s*false/);
  });

  it('the intent-mismatch machinery is REAL: the trip turn’s own words convict merge_pull_request against the offered set (detectIntendedTool, tool-preflight.ts:86-104)', () => {
    const offered = ['verify_durable', 'merge_pull_request', 'register_artifact'];
    expect(detectIntendedTool(INTENT_REASONING, 'verify_durable', offered)).toBe('merge_pull_request');
    // Naming the called tool (or nothing) never convicts.
    expect(detectIntendedTool(PLAIN_REASONING, 'verify_durable', offered)).toBeNull();
    expect(detectIntendedTool('', 'verify_durable', offered)).toBeNull();
  });

  it('END-TO-END: two executed not_found refusals + the intent fast-trip on the first call trip the breaker at weighted count 3 — two identical filed texts, newest first, intended=merge_pull_request', async () => {
    // Both calls are shape-grounded → BOTH reach the executor → the injected
    // resource not_found envelope each time. Call 1: +1 failure +1 intent
    // (reasoning names merge_pull_request) = 2; call 2: +1 failure = 3 → TRIP.
    // The identical-call breaker never enters — it needs the same signature
    // THREE turns running (agent.ts:3339); the derail breaker trips on call 2.
    mockExecuteCodingTool.mockResolvedValue(RESOURCE_ENVELOPE);
    mockRunModelTurn
      .mockResolvedValueOnce(durableTurn(1, CALL_ID, INTENT_REASONING)) // executes → not_found: streak 1 + intent 1 = 2
      .mockResolvedValueOnce(durableTurn(2, CALL_ID, PLAIN_REASONING))  // executes → not_found: 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Both calls executed — grounding passed on the 8-hex shape.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify_durable');
    expect(ev.perma).toBe(false);
    // The intent-mismatch weight is filed as StreakEvidence.intended — the
    // "lane's reasoning named merge_pull_request" note is a DETECTED field here.
    expect(ev.intended).toBe('merge_pull_request');
    expect(ev.recentFailures).toHaveLength(2);
    for (const text of ev.recentFailures) {
      expect(JSON.parse(text)).toEqual({
        ok: false,
        tool: 'verify_durable',
        reason: 'not_found',
        message: 'No training artifact "b9cb221b" — register_artifact first.',
      });
    }
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    const consultEv = mockConsultCrossCheckerOnStreak.mock.calls[0][0];
    expect(consultEv.recentFailures).toEqual(ev.recentFailures);
    expect(consultEv.intended).toBe('merge_pull_request');
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(RESOURCE_ENVELOPE) // call 1 → not_found
      .mockResolvedValueOnce(RESOURCE_ENVELOPE) // call 2 → not_found → TRIP
      .mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(durableTurn(1, CALL_ID, INTENT_REASONING))   // count 2 (intent fast-trip)
      .mockResolvedValueOnce(durableTurn(2, CALL_ID, PLAIN_REASONING))    // count 3 → TRIP, withheld next round
      .mockResolvedValueOnce(durableTurn(3, RECOVERY_ID, PLAIN_REASONING)) // refused: tool not offered (withheld)
      .mockResolvedValueOnce(durableTurn(4, RECOVERY_ID, PLAIN_REASONING)) // back on offer → executes (shape-grounded)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // THREE executions: the two incident not_found refusals + the
    // post-withhold recovery. The withheld round-3 call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
  });

  it('wiring seam: verify_durable stays a preflight-covered platform tool', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('verify_durable');
  });
});
