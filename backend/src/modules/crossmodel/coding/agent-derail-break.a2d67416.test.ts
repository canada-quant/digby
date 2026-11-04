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
 * Replay pin — ticket a2d67416 (mishap, filed 2026-09-21T06:42:35Z at breaker
 * trip; incident lane 10cb988f-6e80-4d3a-9e59-9e8fc83c93ae "Repository
 * Duplicates and Documentation Update", CanLaw, coding seat kimi-k3, auto,
 * recurring docs-keeper schedule; run 10c8dd60-efcc-42a3-800d-46fb16cd281a =
 * firing 101, triggered 2026-09-21T06:41:28Z, ended 06:41:49Z).
 *
 * THE INCIDENT: the breaker auto-filed '3× tool-failure streak:
 * update_feedback on "Repository Duplicates and Documentation " — framework
 * or model?' with THREE failure texts (newest first):
 *   1. {"ok":false,"tool":"update_feedback","reason":"evidence_required",
 *       "ticketId":"d0597e02","message":"No evidence supplied. Machine-
 *       triggered runs may only close a ticket to done with verifiable
 *       evidence: re-call update_feedback with evidence: { replayTestPath?... 
 *   2. (identical to 1)
 *   3. {"ok":false,...,"reason":"evidence_required","ticketId":"d0597e02",
 *       "message":"This machine-triggered run may NOT mutate feedback ticket
 *       d0597e02: the ticket is not dispatched to this session (its
 *       context.dispatchedTo names another session) and no verifiable
 *       evidence was supplied. Dispatch binding is the sanctioned path — …"}
 * Companion auto-file from the SAME run (2d1f3b68 — pinned by
 * agent-derail-break.2d1f3b68.test.ts): verify_durable not_found ×3 on the
 * same id. Harness end-note (transcript msg 893b4093): "Run ended: repeated
 * wrong-tool derailment (3 episodes; intended tool appears to be
 * run_command)". The lane's own plan step 1 was shell SETUP (date -u; git
 * fetch; git ls-remote) — the run died ~21 s after trigger having executed
 * ZERO plan steps and ZERO shell commands. d0597e02 was salient ONLY from
 * the prompt's TERMINAL-STOP notice ("feedback ticket(s) that are already
 * CLOSED (status=done): d0597e02") — a ticket CLOSED since 2026-09-10 and
 * dispatch-bound to another session (b92ef13f), which the notice explicitly
 * forbade touching. This is the SECOND derail of this exact shape on this
 * lane in ~24 h: ticket 0aecbe92 pinned firing 95 + the supervisor-steer
 * run dying identically on 2026-09-20 (companion auto-files b305c23e /
 * ff48c6f7, same id capture, same intended run_command).
 *
 * THE TWO MESSAGE SHAPES — BOTH CORRECT VERDICTS, byte-diffed against
 * current source (this checkout):
 *   · status=done, no evidence → platform-tools.ts:3671-3672 returns the
 *     verifier's message directly: `No evidence supplied. ${contract}` —
 *     closure-evidence.ts:280 with closeEvidenceContract('d0597e02', true)
 *     (:102-112 — the MISHAP variant: "replayTestPath is REQUIRED"). The
 *     ticket d0597e02 genuinely is closed+foreign-bound and no evidence
 *     object was supplied: the refusal is TRUE.
 *   · status≠done on a non-dispatch-bound ticket → the machine-mutation
 *     gate (ticket 18086326, platform-tools.ts:3655-3666) routes through
 *     verifyMachineCloseEvidence(forClose:false) and wraps the same
 *     verdict in the :3684 not-dispatched narration. Also TRUE.
 *   The lane flailed between a lesser mutation and the close; each shape
 *   refused exactly as designed. NO framework defect.
 *
 * EPISODE ARITHMETIC (pinned here — the learnings gotcha: reconstruct
 * BEFORE mocking): the terminal note's "3 episodes" requires trip tallies
 * {X:2, Y:1} (agent.ts:3480-3484: size ≥ 2 OR total ≥ 3 ends the run at
 * the crossing trip; a perma-locked tool cannot trip again, :3398-3399).
 * Filing metadata fixes the reconstruction: BOTH companion tickets say
 * "first streak this run" (reflection.ts:116 — filed at each tool's FIRST
 * trip), a2d67416 carries NO "reasoning named" note while 2d1f3b68 DOES
 * (StreakEvidence.intended = derailIntendedTool at trip time), and each
 * filing carries THREE texts. A consecutive same-tool block with the
 * intent weight convicting on call 1-2 trips at call 2 with 2 texts
 * (agent.ts:3354+3366 fast-trip) — so the update_feedback block convicted
 * NO intent (its reasoning named no offered tool): +1 per call, trip at
 * call 3 with 3 texts, no intended note. The verify_durable block's
 * conviction landed on its THIRD call: count 2 → +1 failure = 3 → +1
 * intent = 4 → trip with 3 texts AND the intended note. Sequence below:
 *   uf ×3 (trip 1 → one-round withhold, FILE a2d67416) → ban-round plan
 *   touch → uf ×3 (trip 2 → PERMA; dedupe-window refiling) → vd ×3
 *   (trip 1 → FILE 2d1f3b68) → derailTripCounts {update_feedback:2,
 *   verify_durable:1} → total 3 → TERMINAL "3 episodes; intended tool
 *   appears to be run_command".
 * The auto re-anchor steer (ticket 431518a2, merged 616d87937
 * 2026-09-20T12:03Z — ~18.5 h BEFORE this run) arms on the FIRST intent
 * mismatch (leg b, agent.ts:3369-3371) and injects BEFORE the breaker's
 * terminal check (:3422 before :3480) — the harness tried the in-run
 * steer AND ended the run honestly, exactly as designed; the rescue
 * continuation (msg db2e6636) then completed firing 101 cleanly.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — kimi-k3
 * wrong-tool substitution capturing the prompt-salient CLOSED-ticket id,
 * same class as 0aecbe92 / ce17ef88 / 718a04a5 / d87f1ea0. Every
 * deterministic seam behaved as designed: the dispatch-binding gate, the
 * verified-close evidence gate, the resource not-found lookup, the
 * weighted breaker, the one-round withhold → perma ladder, the one-shot
 * re-anchor, the terminal note, the auto-filer. NO framework code change.
 *
 * These tests pin: both update_feedback envelope shapes byte-faithful to
 * their real sources; the {2,1} trip sequence ending the run with the
 * EXACT incident note; per-tool auto-filings carrying the incident's
 * exact filed texts (uf: 2× no-evidence + 1× not-dispatched wrapper,
 * newest first, NO intended note; vd: 3× not_found WITH intended
 * run_command); the re-anchor firing exactly once on the vd conviction;
 * and ZERO run_command executions (the 0/8-steps signature). Scaffold
 * mirrors agent-derail-break.0aecbe92.test.ts (same mock set — same lane,
 * same terminal shape, one firing earlier).
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

// ── The incident's verbatim envelopes (ticket a2d67416 failure texts) ──────
// update_feedback dispatches via ctx.toolCache AND executeCodingTool (the
// document/feedback seam — see 0aecbe92); both seams stubbed with the REAL
// gate's branch discipline (platform-tools.ts:3671-3684): status=done → the
// verifier's message directly; a non-done mutation on a foreign-bound ticket
// → the not-dispatched wrapper around the same verdict.
const TICKET_ID = 'd0597e02'; // the docs-keeper prompt's terminal-stop ticket (closed, foreign-bound)
/** closure-evidence.ts:102-112 — closeEvidenceContract('d0597e02', isMishap=true), verbatim. */
const CONTRACT =
  `Machine-triggered runs may only close a ticket to done with verifiable evidence: re-call triage_ticket with ` + // model-facing spelling (tool-scope.ts, 2026-09-22)
  `evidence: { replayTestPath?: "<repo-relative test file that exists and contains the ticket id prefix '${TICKET_ID}'>", ` +
  `commitSha?: "<7-40 hex sha merged to origin/main>", prUrl?: "https://github.com/<owner>/<repo>/pull/<n>", deployRunId?: "<numeric Actions run id>", ` +
  `repo?: "<owner/name> — the repo the fix lives in (ticket cf5f9718); omit it for a fix in THIS platform repo" }. ` +
  `This is a MISHAP-class ticket: replayTestPath is REQUIRED — commit it first (a test that replays the mishap and cites '${TICKET_ID}'), then close. ` +
  `If you cannot produce the evidence, do NOT close the ticket — leave it in_progress with an adminNote describing the state instead.`;
/** closure-evidence.ts:280 — { ok:false, reason:'evidence_required', message:`No evidence supplied. ${contract}` } */
const NO_EVIDENCE_MESSAGE = `No evidence supplied. ${CONTRACT}`;
/** platform-tools.ts:3684 — the non-done, non-dispatch-bound wrapper (verdict.message embedded). */
const NOT_DISPATCHED_MESSAGE =
  `This machine-triggered run may NOT mutate feedback ticket ${TICKET_ID}: the ticket is not dispatched to this session ` +
  `(its context.dispatchedTo names another session) and no verifiable evidence was supplied. Dispatch binding is the sanctioned path — ` +
  `a dispatched lane works its OWN tickets (in_progress/adminNote/priority) without the artifact bar; without binding the evidence bar ` +
  `applies to EVERY status, not just done. ${NO_EVIDENCE_MESSAGE} If the ticket needs triage you cannot evidence, ` +
  `leave it for its dispatched lane or record a file_feedback sighting instead.`;
const UF_ENVELOPE = (message: string) =>
  JSON.stringify({ ok: false, tool: 'update_feedback', reason: 'evidence_required', ticketId: TICKET_ID, message }, null, 1);
const NO_EVIDENCE = UF_ENVELOPE(NO_EVIDENCE_MESSAGE);
const NOT_DISPATCHED = UF_ENVELOPE(NOT_DISPATCHED_MESSAGE);
/** resource-tools.ts:277 — refuse('verify_durable','not_found', …) via JSON.stringify({ok:false,tool,reason,message}, null, 1). */
const VD_ENVELOPE = JSON.stringify(
  { ok: false, tool: 'verify_durable', reason: 'not_found', message: `No training artifact "${TICKET_ID}" — register_artifact first.` },
  null,
  1,
);

const ufResult = (args: any) => (String(args?.status ?? '') === 'done' ? NO_EVIDENCE : NOT_DISPATCHED);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return ufResult(args);
  if (name === 'verify_durable') return VD_ENVELOPE;
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_feedback') return ufResult(args);
  if (name === 'verify_durable') return VD_ENVELOPE;
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
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool } from './tool-preflight';

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

/** The firing-101 prompt excerpt — the TERMINAL-STOP notice is the ONLY place
 *  d0597e02 was salient (verbatim from transcript msg 05911066). */
const BRIEF = [
  'DOCS-KEEPER firing 101 — work the 8-step shell checklist.',
  '1. SETUP: date -u; git fetch origin --prune; git ls-remote origin main.',
  '[TERMINAL-STOP — harness-verified at fire time 2026-09-21T06:41:28.026Z] This firing\'s prompt references',
  'feedback ticket(s) that are already CLOSED (status=done): d0597e02 · A verified completion is TERMINAL —',
  'do NOT re-audit, re-probe, re-verify, re-merge, re-deploy-check, or re-close that work this firing.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-a2d67416-test',
  sessionId: 'sess-a2d67416',
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

/** Non-convicting narration (names NO offered tool — the update_feedback
 *  block carried no intent weight, which is why its trip took 3 calls and
 *  its filing carries NO "reasoning named" note). */
const UF_REASONING = 'Re-stamp the triage row of the closed ticket d0597e02 so its status reflects this recheck.';
/** A wrong-tool emission: update_feedback against the closed foreign-bound ticket. */
const ufTurn = (n: number, status: 'done' | 'in_progress') => ({
  content: '',
  reasoning: UF_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: TICKET_ID, status, adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const VD_PLAIN_REASONING = 'Retry the durability stamp on artifact d0597e02 — the not_found answer must have been a stale read.';
/** The third verify_durable turn's own words — per companion ticket
 *  2d1f3b68's note "lane's reasoning named run_command": names ANOTHER
 *  offered tool as a whole word and NEVER the called one, so the REAL
 *  detectIntendedTool convicts it (+1 fast-trip, agent.ts:3363-3366). */
const VD_INTENT_REASONING = 'Shell first: run_command "aws s3 ls s3://canlaw-artifacts/" to confirm the upload landed, then stamp durability.';
const vdTurn = (n: number, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: 'verify_durable', arguments: JSON.stringify({ id: TICKET_ID }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** The firing-101 episode sequence: {update_feedback: 2 trips, verify_durable:
 *  1 trip} = "3 episodes" — trip 1 (one-round ban), ban-round plan touch,
 *  trip 2 (perma on update_feedback), then the resource seam trips the run
 *  into the terminal state on the conviction call. */
const wireFiring101 = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1, 'in_progress')) // count 1 — the NOT_DISPATCHED wrapper (oldest filed text)
    .mockResolvedValueOnce(ufTurn(2, 'done'))        // count 2 — NO_EVIDENCE
    .mockResolvedValueOnce(ufTurn(3, 'done'))        // count 3 ⇒ TRIP 1 (one-round ban) → files a2d67416
    .mockResolvedValueOnce(planTurn(4))              // ban round — harmless success
    .mockResolvedValueOnce(ufTurn(5, 'done'))        // count 1
    .mockResolvedValueOnce(ufTurn(6, 'done'))        // count 2
    .mockResolvedValueOnce(ufTurn(7, 'done'))        // count 3 ⇒ TRIP 2 (PERMA on update_feedback)
    .mockResolvedValueOnce(vdTurn(8, VD_PLAIN_REASONING)) // count 1
    .mockResolvedValueOnce(vdTurn(9, VD_PLAIN_REASONING)) // count 2
    .mockResolvedValueOnce(vdTurn(10, VD_INTENT_REASONING)) // count 3 (+1 intent = 4) ⇒ TRIP 3 ⇒ TERMINAL → files 2d1f3b68
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');

const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket a2d67416 — update_feedback streak on the CLOSED foreign ticket d0597e02 (firing 101)', () => {
  it('UNIT: all three incident envelopes are failure-shaped; only the vd conviction reasoning names run_command', () => {
    expect(looksLikeToolFailure(NO_EVIDENCE)).toBe(true);
    expect(looksLikeToolFailure(NOT_DISPATCHED)).toBe(true);
    expect(looksLikeToolFailure(VD_ENVELOPE)).toBe(true);
    const offered = ['run_command', 'update_feedback', 'verify_durable', 'update_plan'];
    expect(detectIntendedTool(UF_REASONING, 'update_feedback', offered)).toBeNull();
    expect(detectIntendedTool(VD_PLAIN_REASONING, 'verify_durable', offered)).toBeNull();
    expect(detectIntendedTool(VD_INTENT_REASONING, 'verify_durable', offered)).toBe('run_command');
  });

  it('UNIT: the filed message shapes are byte-faithful to their real sources (diff vs recent framework changes)', () => {
    // The done-close refusal: closure-evidence.ts:280 + the mishap contract :102-112.
    const ce = readSrc('../feedback/closure-evidence.ts');
    expect(ce).toContain('No evidence supplied. ${contract}');
    expect(ce).toContain("Machine-triggered runs may only close a ticket to done with verifiable evidence: re-call ${modelToolName('update_feedback')} with"); // source spells the model-facing name via tool-scope.ts (2026-09-22)
    expect(ce).toContain('This is a MISHAP-class ticket: replayTestPath is REQUIRED');
    // The not-dispatched wrapper: platform-tools.ts:3684 (and the done branch :3671-3672 returning verdict.message directly).
    const pt = readSrc('../platform/platform-tools.ts');
    expect(pt).toContain('may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: the ticket is not dispatched to this session');
    expect(pt).toContain('Dispatch binding is the sanctioned path');
    // The resource not_found envelope: resource-tools.ts:277 (em-dash verbatim).
    const rt = readSrc('../platform/resource-tools.ts');
    expect(rt).toContain('No training artifact "${ref}" — register_artifact first.');
    // The terminal note template: agent.ts:3484.
    expect(readSrc('./agent.ts')).toContain('Run ended: repeated wrong-tool derailment');
  });

  it('REPLAY firing 101: {update_feedback:2, verify_durable:1} trips end the run with the EXACT incident note — 3 episodes, intended run_command, zero shell executions', async () => {
    wireFiring101();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(10);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    // Completed-with-note, never a provider failure.
    expect(result.modelErrored).toBeUndefined();
    const notePart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(notePart).toBeDefined();
    expect(notePart!.marker).toBe('guard');
    const guardEmits = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(guardEmits.some((e) => String(e.text).startsWith('[HARNESS] Run ended'))).toBe(true);

    // Telemetry: the terminal row carries ended_run + the run-level tallies —
    // verify_durable is the tool whose trip crossed total ≥ 3.
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'verify_durable', trips: 3, intended: 'run_command' });

    // The re-anchor steer fired EXACTLY once — armed on the run's first intent
    // conviction (vd call 3, leg b) and injected before the terminal check.
    const reanchors = reanchorMetrics();
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0].meta).toMatchObject({ tool: 'verify_durable', intended: 'run_command', reason: 'intent_mismatch' });

    // The 0/8-steps signature: run_command was never emitted, so no shell work
    // ever executed (either dispatch seam).
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[0] === 'run_command')).toBe(false);
    expect(mockToolCacheExec.mock.calls.some((c) => c[0] === 'run_command')).toBe(false);

    // The per-tool auto-filings carry the incident's exact filed texts.
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ufFilings = filings.filter((f) => f.tool === 'update_feedback');
    const vdFilings = filings.filter((f) => f.tool === 'verify_durable');
    // update_feedback tripped twice (the perma second trip re-files — the
    // 24 h Redis NX dedupe, reflection.ts:94-104, is what suppresses a second
    // TICKET in production; the breaker still reports the trip).
    expect(ufFilings.length).toBe(2);
    expect(ufFilings[0].perma).toBe(false);
    expect(ufFilings[1].perma).toBe(true);
    // a2d67416 verbatim: newest first — two identical no-evidence done-close
    // refusals, then the not-dispatched wrapper (the 1200-char streak slice,
    // agent.ts:3358).
    expect(ufFilings[0].recentFailures).toHaveLength(3);
    expect(JSON.parse(ufFilings[0].recentFailures[0])).toEqual({
      ok: false, tool: 'update_feedback', reason: 'evidence_required', ticketId: TICKET_ID, message: NO_EVIDENCE_MESSAGE,
    });
    expect(ufFilings[0].recentFailures[1]).toBe(ufFilings[0].recentFailures[0]);
    expect(ufFilings[0].recentFailures[2]).toBe(NOT_DISPATCHED.slice(0, 1200));
    expect(ufFilings[0].recentFailures[2]).toContain('may NOT mutate feedback ticket d0597e02: the ticket is not dispatched to this session');
    // NO "lane's reasoning named" note on the update_feedback ticket — the uf
    // block convicted no intent (derailIntendedTool was still unset → null).
    expect(ufFilings[0].intended).toBeFalsy();
    // 2d1f3b68 verbatim: three identical not_found envelopes + the intended note.
    expect(vdFilings.length).toBe(1);
    expect(vdFilings[0].perma).toBe(false);
    expect(vdFilings[0].intended).toBe('run_command');
    expect(vdFilings[0].recentFailures).toHaveLength(3);
    for (const text of vdFilings[0].recentFailures) {
      expect(JSON.parse(text)).toEqual({
        ok: false, tool: 'verify_durable', reason: 'not_found', message: `No training artifact "${TICKET_ID}" — register_artifact first.`,
      });
    }
    // The consult receives the same evidence objects (the 8579d419 purity
    // contract) — bounded by the per-run reflection budget
    // (REFLECTION_MAX_PER_RUN: 2): the third trip's consult is the one capped
    // out, but its auto-filing above is NOT budget-gated.
    expect(mockConsultCrossCheckerOnStreak.mock.calls.length).toBe(2);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ufFilings[0].recentFailures);
  });
});
