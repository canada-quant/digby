/**
 * Replay pin — ticket 2d1f3b68 (mishap, filed 2026-09-21T06:46:07Z at breaker
 * trip; incident lane 10cb988f-6e80-4d3a-9e59-9e8fc83c93ae "Repository
 * Duplicates and Documentation Update", CanLaw, coding seat kimi-k3, auto,
 * recurring docs-keeper schedule; run 10c8dd60-efcc-42a3-800d-46fb16cd281a =
 * firing 101). Companion auto-file from the SAME run: a2d67416 (the
 * update_feedback streak — pinned by agent-derail-break.a2d67416.test.ts,
 * which replays the full {update_feedback:2, verify_durable:1} trip sequence
 * and the terminal "3 episodes; intended tool appears to be run_command"
 * note). THIS file pins the verify_durable seam itself.
 *
 * THE INCIDENT: the breaker auto-filed '3× tool-failure streak:
 * verify_durable' with THREE IDENTICAL failure texts (newest first):
 *   `{"ok":false,"tool":"verify_durable","reason":"not_found","message":
 *    "No training artifact \"d0597e02\" — register_artifact first."}`  ×3
 * (the resource-tools.ts:277 not-found envelope — no artifact row for the
 * ref). The ticket note records "lane's reasoning named run_command".
 *
 * THE REF: "d0597e02" is NOT a training-artifact id — it is the FEEDBACK
 * TICKET prefix from the docs-keeper prompt's TERMINAL-STOP notice
 * ("feedback ticket(s) that are already CLOSED (status=done): d0597e02" —
 * the evidence-guard mishap closed 2026-09-10, dispatch-bound to another
 * session). The lane conflated two unrelated owner-doctrine flows — the
 * ticket-closing evidence bar (update_feedback) and the artifact durability
 * stamp (verify_durable) — and aimed BOTH at the one prompt-salient hex id.
 * No artifact named d0597e02 was ever registered by this account, so the
 * resource layer's refusal is TRUE.
 *
 * GROUNDING PATH (verified against current source): BOTH verify_durable
 * calls EXECUTED — they reached the resource executor, which proves the
 * pre-flight's grounding check PASSED (verify_durable IS a preflight-covered
 * platform tool — PLATFORM_TOOL_NAMES, pinned below). TWO independent rules
 * ground this ref (either suffices): (1) the id-SHAPE rule — ID_SHAPE_RE
 * /^[0-9a-f]{8}/i (tool-preflight.ts:35) — "d0597e02" is 8 lowercase hex
 * chars, shape-valid with NO haystack occurrence needed; (2) the verbatim-
 * occurrence rule (haystack.includes, tool-preflight.ts:73) — the firing
 * prompt carried "d0597e02" verbatim in the TERMINAL-STOP notice. (Same
 * shape as ce17ef88's "b9cb221b"; there ONLY the shape rule grounded
 * because the session title's "B9cb221b" capital-B occurrence fails the
 * case-sensitive includes.)
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the lane
 * decoder-locked on verify_durable with a shape-valid but never-registered
 * artifact ref captured from the prompt, while its own reasoning named
 * run_command — NOT a deterministic framework defect; every deterministic
 * seam (the shape rule, the occurrence rule, the resource not-found
 * envelope, the intent-mismatch weight, the weighted breaker, the
 * one-round withhold) behaved exactly as designed. Precedent: ce17ef88
 * closed 2026-09-20 as MODEL BEHAVIOR on the identical envelope family.
 * NO platform code change.
 *
 * These tests pin: the grounding path (8-hex shape AND verbatim occurrence;
 * a non-hex contrast staying ungrounded), the resource-tools.ts:277
 * envelope byte-faithful to the filed text, the intent detector convicting
 * run_command from the trip turn's own words, three executed not_found
 * refusals tripping the breaker with the three identical filed texts
 * newest-first and StreakEvidence.intended = 'run_command', one vd trip
 * ALONE being non-terminal (withhold one round, then recovery executes),
 * and the re-anchor firing once on the conviction. Scaffold mirrors
 * agent-derail-break.ce17ef88.test.ts (same mock set; the CODING profile
 * offers run_command natively, so no extraTools stand-in is needed).
 */

jest.setTimeout(60_000);

import fs from 'fs';
import path from 'path';

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

jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: jest.fn().mockImplementation(() => ({
      getOrExecute: jest.fn(async () => 'probe result: ok'),
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
import { looksLikeToolFailure } from './learnings-index.service';
import { findUngroundedIdArgs, detectIntendedTool } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile (no workspace container in the scaffold): run_command is in
 *  the offered schema — the incident's intended tool must be offerable for
 *  the intent-mismatch preflight to name it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 20,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim ref (ticket 2d1f3b68) ───────────────────────────
const CALL_ID = 'd0597e02'; // all three calls — the prompt-salient CLOSED-ticket prefix, NEVER a registered artifact
const RECOVERY_ID = '2d1f3b68'; // 8-hex — shape-valid citation for the recovery call

/** The resource not_found envelope exactly as the breaker counted it —
 *  resource-tools.ts:277 via refuse(): JSON.stringify({ok:false, tool,
 *  reason, message}, null, 1), the message carrying the em-dash verbatim:
 *  `No training artifact "${ref}" — register_artifact first.` */
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

/** The firing-101 prompt excerpt — carries the TERMINAL-STOP notice's
 *  "d0597e02" VERBATIM (unlike ce17ef88's case-mismatched title, this
 *  occurrence ALSO grounds the call id: haystack.includes is case-sensitive
 *  and the bytes match, tool-preflight.ts:73). */
const BRIEF = [
  'DOCS-KEEPER firing 101 — work the 8-step shell checklist.',
  '1. SETUP: date -u; git fetch origin --prune; git ls-remote origin main.',
  '[TERMINAL-STOP — harness-verified at fire time 2026-09-21T06:41:28.026Z] This firing\'s prompt references',
  'feedback ticket(s) that are already CLOSED (status=done): d0597e02 · A verified completion is TERMINAL.',
].join('\n');

/** The conviction turn's own words — per the ticket note "lane's reasoning
 *  named run_command": names ANOTHER offered tool as a whole word and NEVER
 *  the called one, so the REAL detectIntendedTool convicts it (+1 fast-trip,
 *  agent.ts:3363-3366). */
const INTENT_REASONING = 'Shell first: run_command "aws s3 ls s3://canlaw-artifacts/" to confirm the upload landed, then stamp durability.';
/** The first two turns name verify_durable's business, never another tool —
 *  no intent weight: pure +1 failures, which is why the trip lands on call
 *  3 with three texts (and why companion ticket a2d67416's uf filing carries
 *  NO "reasoning named" note). */
const PLAIN_REASONING = 'Retry the durability stamp on artifact d0597e02 — the not_found answer must have been a stale read.';

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-2d1f3b68-test',
  sessionId: 'sess-2d1f3b68',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the checklist now.`,
  emit: jest.fn(),
});

/** A turn calling verify_durable({id:"d0597e02"}) with an explicit reasoning text. */
const durableTurn = (n: number, id: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'verify_durable', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 2d1f3b68 — three shape-grounded not_found refusals on the prompt-salient ticket id read as a "3× verify_durable streak"', () => {
  it('UNIT grounding: the 8-hex shape rule grounds the ref with NO occurrence; the verbatim occurrence in the prompt also grounds; a non-hex contrast stays ungrounded', () => {
    // Occurrence + shape both present (the incident prompt).
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF)).toEqual([]);
    // Shape ALONE grounds — no haystack mention anywhere (the /i flag makes
    // the shape case-insensitive; tool-preflight.ts:35).
    expect(findUngroundedIdArgs({ id: CALL_ID }, 'no mention of the artifact id anywhere')).toEqual([]);
    expect(findUngroundedIdArgs({ id: 'D0597E02' }, 'no mention of the artifact id anywhere')).toEqual([]);
    // The contrast: non-hex and absent — ungrounded (the preflight would
    // refuse BEFORE execution; the incident calls were never this).
    const bad = findUngroundedIdArgs({ id: 'd0597zzz' }, BRIEF);
    expect(bad).toHaveLength(1);
    expect(bad[0].value).toBe('d0597zzz');
    // The shape regex itself is pinned in source.
    expect(readSrc('./tool-preflight.ts')).toContain('ID_SHAPE_RE = /^[0-9a-f]{8}/i');
  });

  it('UNIT envelope: the filed not_found text is failure-shaped and byte-faithful to resource-tools.ts:277', () => {
    expect(looksLikeToolFailure(RESOURCE_ENVELOPE)).toBe(true);
    // Source-byte pin: the template the refusal is built from (em-dash verbatim).
    expect(readSrc('../platform/resource-tools.ts')).toContain('No training artifact "${ref}" — register_artifact first.');
    const offered = ['verify_durable', 'run_command', 'register_artifact'];
    expect(detectIntendedTool(INTENT_REASONING, 'verify_durable', offered)).toBe('run_command');
    expect(detectIntendedTool(PLAIN_REASONING, 'verify_durable', offered)).toBeNull();
    expect(detectIntendedTool('', 'verify_durable', offered)).toBeNull();
  });

  it('END-TO-END: three executed not_found refusals (intent weight only on the last) trip the breaker — three identical filed texts, newest first, intended=run_command, first streak (not perma)', async () => {
    // All three calls are shape-grounded → ALL reach the executor → the
    // injected resource not_found envelope each time. Calls 1-2: +1 failure
    // each (reasoning convicts nothing) = 2; call 3: +1 failure = 3 → +1
    // intent = 4 → TRIP (agent.ts:3395) with THREE texts captured
    // (:3358-3359) and derailIntendedTool set (:3366).
    mockExecuteCodingTool.mockResolvedValue(RESOURCE_ENVELOPE);
    mockRunModelTurn
      .mockResolvedValueOnce(durableTurn(1, CALL_ID, PLAIN_REASONING))  // executes → not_found: streak 1
      .mockResolvedValueOnce(durableTurn(2, CALL_ID, PLAIN_REASONING))  // executes → not_found: streak 2
      .mockResolvedValueOnce(durableTurn(3, CALL_ID, INTENT_REASONING)) // executes → not_found: 3 (+1 intent) → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // All three calls executed — grounding passed on the 8-hex shape.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('verify_durable');
    expect(ev.perma).toBe(false);
    // The intent-mismatch weight is filed as StreakEvidence.intended — the
    // "lane's reasoning named run_command" note is a DETECTED field here.
    expect(ev.intended).toBe('run_command');
    expect(ev.recentFailures).toHaveLength(3);
    for (const text of ev.recentFailures) {
      expect(JSON.parse(text)).toEqual({
        ok: false,
        tool: 'verify_durable',
        reason: 'not_found',
        message: 'No training artifact "d0597e02" — register_artifact first.',
      });
    }
    // The re-anchor steer armed on this run's FIRST intent mismatch (leg b)
    // and injected exactly once (agent.ts:3369-3371 → :3422).
    const reanchors = reanchorMetrics();
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0].meta).toMatchObject({ tool: 'verify_durable', intended: 'run_command', reason: 'intent_mismatch' });
    // The consult receives the same evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    const consultEv = mockConsultCrossCheckerOnStreak.mock.calls[0][0];
    expect(consultEv.recentFailures).toEqual(ev.recentFailures);
    expect(consultEv.intended).toBe('run_command');
    // One vd trip ALONE is NOT terminal ({vd:1}: size 1, total 1) — the run
    // completes normally afterwards (the firing-101 run ended only because
    // update_feedback had already tripped twice — see a2d67416's replay).
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (the lane recovers with a shape-valid citation and keeps working)', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(RESOURCE_ENVELOPE) // call 1 → not_found
      .mockResolvedValueOnce(RESOURCE_ENVELOPE) // call 2 → not_found
      .mockResolvedValueOnce(RESOURCE_ENVELOPE) // call 3 → not_found → TRIP
      .mockResolvedValue('{"ok":true}');
    mockRunModelTurn
      .mockResolvedValueOnce(durableTurn(1, CALL_ID, PLAIN_REASONING))    // count 1
      .mockResolvedValueOnce(durableTurn(2, CALL_ID, PLAIN_REASONING))    // count 2
      .mockResolvedValueOnce(durableTurn(3, CALL_ID, INTENT_REASONING))   // count 3 (+1 intent) → TRIP, withheld next round
      .mockResolvedValueOnce(durableTurn(4, RECOVERY_ID, PLAIN_REASONING)) // refused: tool not offered (withheld)
      .mockResolvedValueOnce(durableTurn(5, RECOVERY_ID, PLAIN_REASONING)) // back on offer → executes (shape-grounded)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // FOUR executions: the three incident not_found refusals + the
    // post-withhold recovery. The withheld round-4 call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(4);
  });

  it('wiring seam: verify_durable stays a preflight-covered platform tool', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('verify_durable');
  });
});
