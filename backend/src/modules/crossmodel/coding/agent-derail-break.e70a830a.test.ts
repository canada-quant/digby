/**
 * Replay pin — ticket e70a830a (mishap, auto-filed at breaker trip
 * 2026-09-21T07:46:46Z): "3× tool-failure streak: verify_durable on 'node-a
 * Qwen3.8 Speed Mission Successor' — framework or model?". Session
 * ddd26be0-723d-4745-8bb5-be3ff4752d52, run efa65398 (the derail-RESCUE-1
 * continuation of firing-105, triggerKind hook, seat kimi-k3); "lane's
 * reasoning named read_file". Filed texts (newest first, TWO identical):
 *   {
 *    "ok": false,
 *    "tool": "verify_durable",
 *    "reason": "not_found",
 *    "message": "No training artifact \"noop\" — register_artifact first."
 *   }
 *
 * RECURRENCE NOTE: this is the 'noop'-literal verify_durable leg AGAIN —
 * same literal as tickets cea13871/155488ff (lane e083ff2e, pinned in
 * agent-derail-break.155488ff-cea13871.test.ts), different lane/run. The
 * class is the kimi-k3 placeholder/wrong-tool emission family; each
 * occurrence is adjudicated on its own run's evidence.
 *
 * GROUNDING RECONSTRUCTION (rule-level, against tool-preflight.ts bytes):
 * 'noop' is 4 chars — NOT shape-valid (ID_SHAPE_RE /^[0-9a-f]{8}/i needs 8
 * hex, tool-preflight.ts:35), so the two verify_durable emissions could only
 * EXECUTE via a VERBATIM occurrence in the run's haystack
 * (haystack.includes, tool-preflight.ts:73). The live run's context carried
 * it: the first emission of the run was an update_feedback whose OWN id was
 * ungrounded (tool_preflight row 07:45:25) and whose preflight refusal JSON
 * then sat in the run's TOOL messages — the placeholder-echo / cross-tool
 * substring grounding family (afac4aee+769d7278; 'noop' ⊂ a longer literal,
 * the 155488ff+cea13871 seam). Both verify_durable calls therefore reached
 * the resource executor, which refused TRUTHFULLY — no artifact "noop" was
 * ever registered (resource-tools.ts:276-277: resolveArtifact → null ⇒
 * refuse(name,'not_found',…) at resource-tools.ts:157-159).
 *
 * TRIP ARITHMETIC (the "3× streak, 2 texts" filing shape): call 1 = +1
 * failure +1 intent-mismatch fast-trip (the turn's own reasoning named
 * read_file — a DIFFERENT offered tool, the called tool never named;
 * detectIntendedTool, tool-preflight.ts:86-104; agent.ts:3181-3183) = 2;
 * call 2 = +1 failure = 3 ⇒ TRIP at the SECOND emission with the two
 * identical texts captured newest-first (agent.ts:3176-3177, 3184). In the
 * live run this trip was the SECOND distinct tool's first trip ⇒ the run
 * ended honestly (the 155488ff+cea13871 terminal-rule refinement) and the
 * rescue chain continued (rescue-2 fired 07:46:47Z) — the terminal
 * interaction is pinned there and in agent-derail-rescue.6d417d59.test.ts;
 * this file pins the verify_durable LEG in isolation.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — every
 * deterministic seam behaved exactly as designed: the occurrence-grounding
 * rule, the byte-exact truthful not_found envelope, the intent weight, the
 * weighted breaker, the streak filing. NO framework defect, NO code change
 * (same verdict as ce17ef88 / cea13871 / 4af20b7a for this family).
 *
 * These tests pin: 'noop' is NOT shape-valid (occurrence REQUIRED — with the
 * substring-echo case), the resource-tools.ts:277 envelope BYTE-EXACT
 * against the filed text, the intent detector convicting read_file from the
 * trip turn's own words, and the end-to-end two-execution weighted-3 trip
 * filing intended=read_file with two identical texts newest-first.
 * Scaffold mirrors agent-derail-break.ce17ef88.test.ts (same mock set).
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

// ── The incident's verbatim ref (ticket e70a830a) ────────────────────────────
const CALL_ID = 'noop'; // both calls — a placeholder literal, NEVER registered

/** The ticket's filed failure text, transcribed VERBATIM (newest-first ×2). */
const FILED_TEXT = `{
 "ok": false,
 "tool": "verify_durable",
 "reason": "not_found",
 "message": "No training artifact \\"noop\\" — register_artifact first."
}`;

/** The resource not_found envelope as the breaker counted it —
 *  resource-tools.ts:277 via refuse() (157-159):
 *  JSON.stringify({ok:false, tool, reason, message}, null, 1), the message
 *  carrying the em-dash verbatim. */
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

/** The continuation brief — carries a verbatim 'noop' occurrence (the live
 *  run's haystack carried one from the earlier refused-placeholder echo),
 *  which is what GROUNDED the two emissions and let them execute. */
const BRIEF = [
  '[node-a durability watch — derail-rescue continuation]',
  'Check the MOE-PREFILL-3 artifact story. The previous run died emitting the placeholder id "noop" — never re-emit it.',
  'Stamp durability only after a real check this run; never invent an artifact id.',
].join('\n');

/** The first (intent-convicted) turn's own words — per the ticket note
 *  "lane's reasoning named read_file": names ANOTHER offered tool and NEVER
 *  the called one, so the REAL detectIntendedTool convicts it. */
const INTENT_REASONING =
  'Read the checkpoint manifest first — read_file on the fold doc to ground the artifact id, then the durability stamp.';
/** The second turn's reasoning names the called tool — no intent weight. */
const PLAIN_REASONING =
  'Call verify_durable once more with the same artifact id — the not_found answer must have been a stale read.';

/** Stub so the REAL detectIntendedTool sees read_file as offered (it was a
 *  live offered tool in the lane's coding-profile run); mirrors the
 *  extraTools idiom of agent-derail-break.1ee07214.test.ts / ce17ef88. */
const READ_FILE_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'file bytes'),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-e70a830a-test',
  sessionId: 'sess-e70a830a',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the watch now.`,
  extraTools: [READ_FILE_STUB],
  emit: jest.fn(),
});

/** A turn calling verify_durable({id:"noop"}) with an explicit reasoning text. */
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

describe('replay e70a830a — two occurrence-grounded not_found refusals on the placeholder "noop" + the intent weight read as a "3× verify_durable streak"', () => {
  it('the grounding rule: "noop" is NOT shape-valid (4 chars — ID_SHAPE_RE needs 8 hex), so ONLY a verbatim occurrence grounds it — incl. the cross-tool substring-echo case', () => {
    // No occurrence anywhere ⇒ UNGROUNDED (contrast ce17ef88's shape-valid
    // "b9cb221b", which needed no occurrence at all).
    expect(findUngroundedIdArgs({ id: CALL_ID }, 'no mention of the artifact id anywhere'))
      .toEqual([{ key: 'id', value: 'noop' }]);
    // The brief's verbatim occurrence grounds it (the live run's echo path).
    expect(BRIEF).toContain('noop');
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF)).toEqual([]);
    // The 155488ff+cea13871 substring echo: 'noop' ⊂ 'noop-not-applicable'.
    expect(findUngroundedIdArgs({ id: CALL_ID }, 'the id noop-not-applicable was refused earlier')).toEqual([]);
  });

  it('pins the resource not_found envelope BYTE-EXACT against the ticket’s filed text (resource-tools.ts:277 via refuse() at 157-159; the em-dash message verbatim; the {"ok": false failure shape the breaker counts)', () => {
    expect(RESOURCE_ENVELOPE).toBe(FILED_TEXT);
    expect(JSON.parse(RESOURCE_ENVELOPE)).toEqual({
      ok: false,
      tool: 'verify_durable',
      reason: 'not_found',
      message: 'No training artifact "noop" — register_artifact first.',
    });
    expect(RESOURCE_ENVELOPE).toMatch(/^\{\s*"ok":\s*false/);
  });

  it('the intent-mismatch machinery is REAL: the trip turn’s own words convict read_file against the offered set (detectIntendedTool, tool-preflight.ts:86-104)', () => {
    const offered = ['verify_durable', 'read_file', 'register_artifact'];
    expect(detectIntendedTool(INTENT_REASONING, 'verify_durable', offered)).toBe('read_file');
    expect(detectIntendedTool(PLAIN_REASONING, 'verify_durable', offered)).toBeNull();
    expect(detectIntendedTool('', 'verify_durable', offered)).toBeNull();
  });

  it('END-TO-END: two executed not_found refusals + the intent fast-trip on the first call trip the breaker at weighted count 3 — two identical filed texts, newest first, intended=read_file', async () => {
    // Both calls are occurrence-grounded (BRIEF carries "noop") → BOTH reach
    // the executor → the injected resource not_found envelope each time.
    // Call 1: +1 failure +1 intent = 2; call 2: +1 failure = 3 → TRIP.
    mockExecuteCodingTool.mockResolvedValue(RESOURCE_ENVELOPE);
    mockRunModelTurn
      .mockResolvedValueOnce(durableTurn(1, CALL_ID, INTENT_REASONING)) // executes → not_found: streak 1 + intent 1 = 2
      .mockResolvedValueOnce(durableTurn(2, CALL_ID, PLAIN_REASONING))  // executes → not_found: 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Both calls executed — grounding passed on the verbatim occurrence.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify_durable');
    expect(ev.perma).toBe(false);
    // The intent weight is filed as StreakEvidence.intended — the ticket's
    // "lane's reasoning named read_file" note is a DETECTED field here.
    expect(ev.intended).toBe('read_file');
    expect(ev.recentFailures).toHaveLength(2);
    for (const text of ev.recentFailures) {
      expect(text).toBe(FILED_TEXT);
    }
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    const consultEv = mockConsultCrossCheckerOnStreak.mock.calls[0][0];
    expect(consultEv.recentFailures).toEqual(ev.recentFailures);
    expect(consultEv.intended).toBe('read_file');
  });

  it('wiring seam: verify_durable stays a preflight-covered platform tool', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('verify_durable');
  });
});
