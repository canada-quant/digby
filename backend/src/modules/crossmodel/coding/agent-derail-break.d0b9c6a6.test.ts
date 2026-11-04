/**
 * Replay pin — ticket d0b9c6a6 (2026-09-19 breaker trip, session 165b5d36, run 406ade87).
 *
 * THE INCIDENT: the breaker auto-filed a "3× tool-failure streak: observe_resource"
 * mishap (title: '…on "Scaffold Inference Container for Nebiu" — framework or
 * model?') with TWO failure texts (newest first):
 *   1. `{ "ok": false, "tool": "observe_resource", "reason": "error",
 *        "message": "No watched resource \"3fe37fe6\" — register_watched_resource
 *        first, or observe one that exists: 719e0a51 \"Owner-started SFT-2
 *        hardware: 4 \", 2a0530fd \"rose-herring-instance-4 single-B\", 6509b367
 *        \"Nebius plum-jaguar-instance-8 (c\" (+1 more) (full list:
 *        get_account_overview → watchedResources)." }` (service-layer refusal)
 *   2. `{ "ok": false, "tool": "observe_resource", "reason": "ungrounded_id",
 *        "rejected": [{ "key": "id", "value": "zz-registry-enumeration-probe" }],
 *        "message": "NOT EXECUTED: observe_resource was called with
 *        id=\"zz-registry-enumeration-probe\", which is not an id you obtained
 *        this run — …" }` (pre-flight refusal, NOT EXECUTED)
 *
 * WHAT ACTUALLY HAPPENED (adjudication against the lane's transcript, 2026-09-19):
 * the inference-scaffold lane runs a 30-min preempt-recovery ladder over its
 * Nebius GPU fleet. Its firing-3/8 audit (msg b88ad0c5) lists the watched
 * registry — f2 = 3fe37fe6. Firing 4/8 TERMINATED f2+f6 against the disk-quota
 * wall and RELEASED their watched rows itself (msg af803edf: "f2/f6 rows
 * released only after rc=0 termination receipts"). Later in run 406ade87 the
 * lane re-stamped its rows from a STALE cached list and called
 * observe_resource on its own self-released 3fe37fe6 — the service answered
 * with the 251e9329 rich refusal naming the LIVE rows (719e0a51 / 2a0530fd /
 * 6509b367, +1 more), i.e. the self-heal enumeration was IN the message. The
 * zz call is a synthetic "registry enumeration probe" id — fabricated, never
 * returned by any tool — which the id-grounding pre-flight refused WITHOUT
 * executing (zz… fails the hex-shape rule and appears nowhere in the run's
 * grounding haystack; the prior error had already named the real enumeration
 * path, get_account_overview → watchedResources).
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — stale-list
 * reuse + a fabricated enumeration-probe id — NOT a deterministic framework
 * defect. All three layers behaved exactly as designed:
 *   · the pre-flight correctly refused an invented id NOT EXECUTED;
 *   · the unknown-id error envelope correctly listed the live registry rows
 *     (the 251e9329 one-round self-heal contract — resources.251e9329.test.ts);
 *   · the breaker counted as designed: the ungrounded fast-trip weight (+1 —
 *     "an invented id is never real work") makes TWO failure-shaped results
 *     read as a "3×" trip. Identical math to ea69c94e; a shape exemption is
 *     WRONG (ungrounded/existence refusals are the breaker's primary
 *     derailment signal — contrast the always-benign needsConfirmation
 *     envelope, ticket 1ab1a52b).
 *
 * These tests replay the exact two-call sequence end-to-end (the REAL
 * pre-flight runs inside the loop for call 1) and pin: the synthetic probe id
 * is ungrounded even with the live-registry listing in context, the
 * self-released row id is grounded by the hex-shape citation contract, the
 * service-layer "released row" throw surfaces as the exact ok:false/error
 * envelope the breaker counted, the trip fires at weighted count 3 with
 * exactly the two real failure texts filed (newest first), and the first trip
 * withholds the tool for ONE round (not perma). Scaffold mirrors
 * agent-derail-break.ea69c94e.test.ts (same mock set).
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

// The unit pin for the service-layer envelope: resource-tools lazily imports
// the service, so the throw is steered from here (a user-turn ctx skips the
// machine receipt gate, isolating the catch→refuse('error') mapping).
const mockObserveResource: jest.Mock = jest.fn();
jest.mock('../platform/resources.service', () => ({
  __esModule: true,
  observeResource: (...a: any[]) => mockObserveResource(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';
import { executeResourceTool } from '../platform/resource-tools';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim ids (ticket d0b9c6a6) ────────────────────────────
const SYNTHETIC_PROBE = 'zz-registry-enumeration-probe'; // invented — call 1
const RELEASED_ROW = '3fe37fe6'; // f2's row — self-released mid-run — call 2
const LIVE_ROW = '719e0a51'; // the SFT-2 row the refusal listed as live

/** The incident's verbatim service-layer message (failure text #1, newest). */
const RELEASED_ROW_MESSAGE =
  `No watched resource "${RELEASED_ROW}" — register_watched_resource first, or observe one that exists: ` +
  `719e0a51 "Owner-started SFT-2 hardware: 4 ", 2a0530fd "rose-herring-instance-4 single-B", ` +
  `6509b367 "Nebius plum-jaguar-instance-8 (c" (+1 more) (full list: get_account_overview → watchedResources).`;

/** The envelope exactly as the breaker counted it (j() pretty-print, indent 1). */
const ERROR_ENVELOPE = JSON.stringify(
  { ok: false, tool: 'observe_resource', reason: 'error', message: RELEASED_ROW_MESSAGE },
  null,
  1,
);

/** The ladder brief carried the live registry listing — the zz id is absent
 *  from it, so call 1 is UNGROUNDED even with the real rows in context. */
const BRIEF = [
  '[Ladder cadence — watched registry stamp]',
  `Live rows per the last overview: ${LIVE_ROW} "Owner-started SFT-2 hardware",`,
  '2a0530fd "rose-herring-instance-4 single-B", 6509b367 "Nebius plum-jaguar-instance-8".',
  'Stamp every serving node with observe_resource per doctrine.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-d0b9c6a6-test',
  sessionId: 'sess-d0b9c6a6',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nStamp the watched rows now (ladder cadence).`,
  emit: jest.fn(),
});

/** A turn calling observe_resource — reasoning NAMES the called tool so the
 *  intent-mismatch fast-trip stays out of the replay (as in the real run: no
 *  'intended' appears in either filed failure text). */
const observeTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `observe_resource call ${n}: stamp the watched row ${id} per the ladder doctrine.`,
  toolCalls: [{ id: `t${n}`, name: 'observe_resource', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Stamps done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay d0b9c6a6 — stale row id + a synthetic enumeration probe read as a "3× observe_resource streak"', () => {
  it('the synthetic probe id is ungrounded even with the live-registry listing in context (zz fails the hex shape; absent from the haystack)', () => {
    expect(findUngroundedIdArgs({ id: SYNTHETIC_PROBE }, BRIEF))
      .toEqual([{ key: 'id', value: SYNTHETIC_PROBE }]);
  });

  it('the self-released row id IS grounded — an 8-hex prefix passes the citation-contract shape rule (the run also had it in earlier receipts)', () => {
    expect(findUngroundedIdArgs({ id: RELEASED_ROW }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ id: LIVE_ROW }, '')).toEqual([]);
  });

  it('replays the exact refusal envelope from failure text #2 (ungrounded_id, NOT EXECUTED, the rejected arg)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('observe_resource', [{ key: 'id', value: SYNTHETIC_PROBE }], null),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'observe_resource',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: SYNTHETIC_PROBE }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain(
      'If you have no such id, you do not need observe_resource right now — call the tool that advances the task instead.',
    );
  });

  it('the service-layer "released row" throw surfaces as the exact ok:false/error envelope the breaker counted (failure text #1)', async () => {
    mockObserveResource.mockRejectedValueOnce(new Error(RELEASED_ROW_MESSAGE));
    const res = JSON.parse(await executeResourceTool(
      { userId: 'u1', sessionId: 'sess-d0b9c6a6', userTurnAt: new Date() } as any,
      'observe_resource',
      { id: RELEASED_ROW },
    ));
    expect(res).toMatchObject({ ok: false, tool: 'observe_resource', reason: 'error' });
    // The 251e9329 self-heal contract rode the filed evidence intact: the live
    // rows + the enumeration path are IN the message the lane received.
    expect(res.message).toContain(`No watched resource "${RELEASED_ROW}" — register_watched_resource first, or observe one that exists:`);
    expect(res.message).toContain('719e0a51 "Owner-started SFT-2 hardware: 4 "');
    expect(res.message).toContain('get_account_overview → watchedResources');
  });

  it('END-TO-END: the two real calls trip the breaker at weighted count 3 (ungrounded fast-trip +1) with exactly the two filed texts, newest first', async () => {
    // Call 1 hits the REAL pre-flight in the loop (never reaches executeCodingTool);
    // call 2 is grounded by hex shape and executes → the released-row error envelope.
    mockExecuteCodingTool.mockResolvedValueOnce(ERROR_ENVELOPE).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(observeTurn(1, SYNTHETIC_PROBE)) // pre-flight refusal: streak 1 + fast-trip 1 = 2
      .mockResolvedValueOnce(observeTurn(2, RELEASED_ROW))    // service error: streak 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Call 1 was refused BEFORE execution — the tool layer saw only call 2.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);

    // The auto-filed investigation carries EXACTLY the incident's two texts,
    // newest first — and the "3×" in its title is the weighted count, not
    // three failures.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('observe_resource');
    expect(ev.recentFailures).toHaveLength(2);
    const filedError = JSON.parse(ev.recentFailures[0]);
    expect(filedError).toMatchObject({ ok: false, tool: 'observe_resource', reason: 'error' });
    expect(filedError.message).toContain(`No watched resource "${RELEASED_ROW}" — register_watched_resource first`);
    expect(filedError.message).toContain('719e0a51'); // the live-registry listing rode the filed evidence
    const filedEnvelope = JSON.parse(ev.recentFailures[1]);
    expect(filedEnvelope).toMatchObject({
      ok: false, tool: 'observe_resource', reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: SYNTHETIC_PROBE }],
    });
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane self-heals to a LIVE row and keeps working)', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(ERROR_ENVELOPE).mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(observeTurn(1, SYNTHETIC_PROBE)) // count 2
      .mockResolvedValueOnce(observeTurn(2, RELEASED_ROW))    // count 3 → TRIP, withheld for the next model round
      .mockResolvedValueOnce(observeTurn(3, LIVE_ROW))        // refused: tool not offered (withheld)
      .mockResolvedValueOnce(observeTurn(4, LIVE_ROW))        // back on offer → executes (self-healed stamp)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly TWO executions: the tripping call and the post-withhold recovery
    // call. The withheld round-3 call never reached the tool (toolNotOffered).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
  });

  it('wiring seam: observe_resource stays a preflight-covered platform tool and the refusal’s enumeration path stays offered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('observe_resource');
    expect(PLATFORM_TOOL_NAMES).toContain('get_account_overview'); // the refusal's recovery path stays offered
  });
});
