/**
 * Replay pin — ticket e72251c9 (mishap, breaker trip 2026-09-14, session
 * 314cf6ff-1fe7-4766-a977-f51711bc2c7d "Open Feedback Tickets Burn Down",
 * run dfff43de-0987-4fc7-b754-9f71f6387241, auto-filed 02:15:19Z).
 *
 * THE INCIDENT: the burn-down lane had just MERGED the replay tests for the
 * three mishap tickets it was closing — agent-derail-break.00667344.test.ts +
 * agent-derail-break.03e8cd3d.test.ts (commit 107c0f54aa86, 02:09:12Z) and
 * run-evidence-guard.3892de13.test.ts (PR #736, fe263d2dc5a0, 01:40:41Z) —
 * and at ~02:15Z called update_feedback(status=done, evidence.replayTestPath)
 * on all three. The verified-close gate (feedback/closure-evidence.ts)
 * resolves replayTestPath on the INSTANCE filesystem and neither deploy had
 * landed yet (deploys lag ~25 min), so all three calls failed
 * replay_test_missing. Three consecutive failure-shaped platform refusals on
 * one tool tripped the derail breaker: one-round withhold + exactly ONE
 * Redis-NX-deduped investigation ticket (this one) carrying the streak's own
 * texts. The lane's run kept executing and — once the deploy landed — closed
 * 3892de13 at 02:37:08Z with the gate's verified-evidence stamp (its
 * adminNote carries the machine-close evidence line). 00667344/03e8cd3d
 * stayed in_progress awaiting their deploy.
 *
 * ADJUDICATION (this lane, 2026-09-14): MODEL side, framework working AS
 * DESIGNED. Per the 251e9329 attribution rule ("BEFORE calling a tool-failure
 * streak model behavior, diff the refusal text against the tools it names —
 * a broken advertised recovery path is a deterministic framework defect"):
 *   - Every refusal was TRUTHFUL at call time: the cited files were absent
 *     from the instance (merged-but-not-deployed). The gate fails closed BY
 *     DESIGN — "The file must be COMMITTED and present on this instance
 *     before it counts"; a GitHub-API existence check was considered and
 *     rejected in the module header (no repo slug / OAuth token on a feedback
 *     ticket), so instance-presence is the deterministic bar.
 *   - The advertised recovery path WORKS: the same lane closed 3892de13 ~22
 *     min later through the same gate with the same path once the deploy
 *     landed. The model-side error was ORDERING (close before the deploy) and
 *     then re-issuing a deterministic filesystem check twice more within
 *     minutes instead of waiting — the exact iteration class the 6a950136
 *     adjudication already covers (truthful, self-describing failures,
 *     converging lane, proportionate breaker).
 *   - The `^{"ok": false` envelope is a DELIBERATE failure marker
 *     (FAILURE_MARKERS, learnings-index.service.ts) — a real verdict refusal
 *     MUST count toward the breaker. The 1ab1a52b exemption covers ONLY the
 *     confirmation-gate staging shape (needsConfirmation:true), never a
 *     verdict refusal; exempting these would blind the breaker to a lane
 *     genuinely stuck against the gate (00667344's own incident streak —
 *     fabricated "00000000"/"noop" ticket ids — is exactly that lane class).
 * NO platform code change: this pin locks the intended counting (gate verdict
 * refusals ARE failure-shaped; a mid-streak SUCCESS resets; ONE deduped
 * ticket carries the streak's own texts, newest first) while replaying the
 * incident end-to-end through the real agent loop (the REAL
 * looksLikeToolFailure runs; only the model, the tool executor, and the
 * streak consult/filing are mocked). The gate's own verdict logic stays
 * pinned by feedback/closure-evidence.test.ts ("a MISSING file refuses —
 * committed-and-present is the bar").
 *
 * Scaffold mirrors agent-derail-break.6a950136.test.ts (same mock set). The
 * update_feedback double is offered via input.extraTools (agent.ts: per-run
 * extra tools join the offered list, are exempt from the not-offered
 * preflight, and match FIRST at execution) with a scripted execute double —
 * the breaker counts RESULT TEXT, so the replay is exact at the counting
 * seam. The ticket ids are full UUIDs → shape-grounded (tool-preflight
 * ID_SHAPE_RE), so the ungrounded-id preflight does not intercept them —
 * exactly as in the incident run, where the lane held the ids legitimately
 * from its own list_feedback results. The refusal texts are composed with the
 * REAL closeEvidenceContract + the gate's verbatim replay_test_missing
 * template (closure-evidence.ts), so what is counted is byte-identical to
 * what the gate authors.
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
import { looksLikeToolFailure } from './learnings-index.service';
import { closeEvidenceContract } from '../feedback/closure-evidence';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── e72251c9's filed "Failure texts" — the gate's verbatim replay_test_missing
// template + the REAL closeEvidenceContract, in the platform refusal envelope
// (JSON.stringify …,null,1), each truncated at the 1200-char capture slice
// (agent.ts failStreakTexts: String(result||'').slice(0, 1200) — the ticket's
// own capture truncates at ~500; these are the refusals as CAPTURED. The
// cf5f9718 evidence.repo member lengthened closeEvidenceContract past 1200,
// so the slice now bites INSIDE the message tail — the pin models that).
// In CHRONOLOGICAL call order: 3892de13 → 03e8cd3d → 00667344 (the ticket
// lists newest first).
const gateRefusal = (ticketId: string, replayTestPath: string): string =>
  JSON.stringify(
    {
      ok: false,
      tool: 'update_feedback',
      reason: 'replay_test_missing',
      ticketId,
      message:
        `replayTestPath "${replayTestPath}" does not exist under any configured repo root ` +
        `(checked $REPLAY_TEST_ROOT, the backend dir, and its parent; absolute paths and '..' are rejected). ` +
        `The file must be COMMITTED and present on this instance before it counts. ` +
        closeEvidenceContract(ticketId.slice(0, 8), true),
    },
    null,
    1,
  ).slice(0, 1200);

const FAIL_3892DE13 = gateRefusal(
  '3892de13-84b9-4fd1-9820-9eec1c94bfda',
  'backend/src/modules/crossmodel/coding/run-evidence-guard.3892de13.test.ts',
);
const FAIL_03E8CD3D = gateRefusal(
  '03e8cd3d-78b5-47eb-bd38-15506e6b7175',
  'backend/src/modules/crossmodel/coding/agent-derail-break.03e8cd3d.test.ts',
);
const FAIL_00667344 = gateRefusal(
  '00667344-013d-4541-a850-3370ccc1207d',
  'backend/src/modules/crossmodel/coding/agent-derail-break.00667344.test.ts',
);
// The remedy the lane eventually took: once the deploy landed, the SAME close
// succeeded (3892de13 at 02:37:08Z). A success envelope is not failure-shaped.
const CLOSE_OK = JSON.stringify(
  {
    ok: true,
    tool: 'update_feedback',
    ticketId: '3892de13-84b9-4fd1-9820-9eec1c94bfda',
    status: 'done',
    message: 'Ticket updated.',
  },
  null,
  1,
);

/** The update_feedback double: a per-run extra tool (agent.ts extraTools seam) whose execute replays the scripted gate verdicts. */
const mockUpdateFeedbackExec: jest.Mock = jest.fn();
const UPDATE_FEEDBACK_EXTRA_TOOL = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'update_feedback',
      description: 'test double of the update_feedback platform tool',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: (...a: any[]) => mockUpdateFeedbackExec(...a),
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-e72251c9-test',
  sessionId: 'sess-e72251c9',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'close the burned-down tickets',
  extraTools: [UPDATE_FEEDBACK_EXTRA_TOOL],
  emit: jest.fn(),
});

/** A turn calling update_feedback once to close the given ticket with a replayTestPath (full-UUID id → shape-grounded, as in the incident run). */
const closeTurn = (n: number, ticketId: string, replayTestPath: string) => ({
  content: '',
  reasoning: '',
  toolCalls: [
    {
      id: `t${n}`,
      name: 'update_feedback',
      arguments: JSON.stringify({ id: ticketId, status: 'done', evidence: { replayTestPath } }),
    },
  ],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket e72251c9 — gate verdict refusals are failure-shaped BY DESIGN (breaker as designed)', () => {
  it('the incident replayed: 3 consecutive replay_test_missing refusals trip the breaker once, filing ONE ticket with the streak’s own texts', async () => {
    mockUpdateFeedbackExec
      .mockResolvedValueOnce(FAIL_3892DE13) // streak 1 — merged 01:40:41Z (PR #736), deploy not landed
      .mockResolvedValueOnce(FAIL_03E8CD3D) // streak 2 — merged 02:09:12Z (107c0f54aa86), deploy not landed
      .mockResolvedValueOnce(FAIL_00667344) // streak 3 — same deploy lag → TRIP
      .mockResolvedValue(CLOSE_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(closeTurn(1, '3892de13-84b9-4fd1-9820-9eec1c94bfda', 'backend/src/modules/crossmodel/coding/run-evidence-guard.3892de13.test.ts'))
      .mockResolvedValueOnce(closeTurn(2, '03e8cd3d-78b5-47eb-bd38-15506e6b7175', 'backend/src/modules/crossmodel/coding/agent-derail-break.03e8cd3d.test.ts'))
      .mockResolvedValueOnce(closeTurn(3, '00667344-013d-4541-a850-3370ccc1207d', 'backend/src/modules/crossmodel/coding/agent-derail-break.00667344.test.ts'))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // The breaker tripped and filed the streak for investigation — with the
    // REAL gate-refusal texts, newest first (the 8579d419 capture-at-counting
    // mechanics), tool 'update_feedback'.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.recentFailures).toHaveLength(3);
    expect(ev.recentFailures).toEqual([FAIL_00667344, FAIL_03E8CD3D, FAIL_3892DE13]);
    for (const text of ev.recentFailures) {
      expect(text).toMatch(/^\{\s*"ok":\s*false/);
    }
    // The filed evidence preserves the THREE DISTINCT ticket/path pairs — an
    // investigation lane can see the lane was proceeding down a batch close
    // list against ONE environmental cause (deploy lag), not re-issuing an
    // identical call against an identical refusal.
    expect(ev.recentFailures[2]).toContain('3892de13-84b9-4fd1-9820-9eec1c94bfda');
    expect(ev.recentFailures[2]).toContain('run-evidence-guard.3892de13.test.ts');
    expect(ev.recentFailures[1]).toContain('03e8cd3d-78b5-47eb-bd38-15506e6b7175');
    expect(ev.recentFailures[1]).toContain('agent-derail-break.03e8cd3d.test.ts');
    expect(ev.recentFailures[0]).toContain('00667344-013d-4541-a850-3370ccc1207d');
    expect(ev.recentFailures[0]).toContain('agent-derail-break.00667344.test.ts');
    // The cross-checker consult receives the same pure evidence object.
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ev.recentFailures);
  });

  it('a mid-streak SUCCESS resets the count — no trip, no ticket (the breaker only fires on CONSECUTIVE failures)', async () => {
    mockUpdateFeedbackExec
      .mockResolvedValueOnce(FAIL_3892DE13) // streak 1
      .mockResolvedValueOnce(FAIL_03E8CD3D) // streak 2
      .mockResolvedValueOnce(CLOSE_OK)      // the deploy lands → the SAME close succeeds → streak RESETS
      .mockResolvedValueOnce(FAIL_00667344) // streak 1 (fresh) — never reaches 3
      .mockResolvedValue(CLOSE_OK);
    mockRunModelTurn
      .mockResolvedValueOnce(closeTurn(1, '3892de13-84b9-4fd1-9820-9eec1c94bfda', 'backend/src/modules/crossmodel/coding/run-evidence-guard.3892de13.test.ts'))
      .mockResolvedValueOnce(closeTurn(2, '03e8cd3d-78b5-47eb-bd38-15506e6b7175', 'backend/src/modules/crossmodel/coding/agent-derail-break.03e8cd3d.test.ts'))
      .mockResolvedValueOnce(closeTurn(3, '3892de13-84b9-4fd1-9820-9eec1c94bfda', 'backend/src/modules/crossmodel/coding/run-evidence-guard.3892de13.test.ts'))
      .mockResolvedValueOnce(closeTurn(4, '00667344-013d-4541-a850-3370ccc1207d', 'backend/src/modules/crossmodel/coding/agent-derail-break.00667344.test.ts'))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
    expect(mockConsultCrossCheckerOnStreak).not.toHaveBeenCalled();
  });

  it('attribution evidence (the 251e9329 rule): the filed texts are failure-shaped by the DELIBERATE platform-refusal marker and self-describing', () => {
    // The `^{"ok": false` marker in FAILURE_MARKERS is intentional — a real
    // gate verdict refusal MUST count toward the breaker. The 1ab1a52b
    // exemption covers ONLY the confirmation-gate staging shape
    // (needsConfirmation:true); these texts carry no such field, and
    // exempting verdict refusals would blind the breaker to a lane genuinely
    // stuck against the gate.
    for (const text of [FAIL_3892DE13, FAIL_03E8CD3D, FAIL_00667344]) {
      expect(text).not.toContain('needsConfirmation');
      expect(looksLikeToolFailure(text)).toBe(true);
      // Self-describing per the 251e9329 attribution gate: every text names
      // the exact missing replay path, its ticket id, and the remedy — the
      // advertised recovery path (commit + present on this instance) was
      // real, and the incident lane proved it by closing 3892de13 after the
      // deploy.
      expect(text).toContain('does not exist under any configured repo root');
      expect(text).toContain('The file must be COMMITTED and present on this instance before it counts');
      expect(text).toContain('replayTestPath is REQUIRED');
    }
    expect(FAIL_3892DE13).toContain("'3892de13'");
    expect(FAIL_03E8CD3D).toContain("'03e8cd3d'");
    expect(FAIL_00667344).toContain("'00667344'");
    // …and the remedy the lane eventually took (close AFTER the deploy) is
    // not failure-shaped — a success mid-streak is a genuine reset signal.
    expect(looksLikeToolFailure(CLOSE_OK)).toBe(false);
  });
});
