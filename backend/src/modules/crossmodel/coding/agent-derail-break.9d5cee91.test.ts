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
 * Replay pin — tickets 9d5cee91 + fcc8bebe (mishaps, auto-filed 2026-09-20
 * 10:00:29Z / 10:02:45Z at breaker trip; incident lane 26bd5857-5fe1-4de6-
 * 9c83-f5601037e326 "Adversarial Review: Refute, Don't Confir", crossmodel,
 * coding seat kimi-k3, machine run a324be0a-3e36-4cad-bb52-9234c4bb8b29 —
 * the adversarial-reviewer sub-session for the dd3a19fa EventHook-provenance
 * fix, dispatched 09:53:16Z).
 *
 * THE INCIDENT: the reviewer run died ~9 minutes in on the wrong-tool derail
 * terminal state (agent.ts:3252-3290): harness note "Run ended: repeated
 * wrong-tool derailment (3 episodes; intended tool appears to be run_command)"
 * (transcript msg 0aeeccc4). Companion auto-files from the same run pin the
 * emitted tools:
 *   · 9d5cee91 — update_feedback refused NOT-EXECUTED by the grounding
 *     preflight for id "noop-probe-avoid" ("lane's reasoning named verify";
 *     ONE filed text — the streak hit 3 on the FIRST call: +1 failure-shaped
 *     +1 ungrounded +1 intent mismatch, agent.ts:3196-3208).
 *   · fcc8bebe — update_document existence refusals with fabricated file ids
 *     dd3a19fa (the TICKET-under-review prefix, mistaken for a generated-file
 *     id) and not-a-file ("lane's reasoning named run_command"; TWO filed
 *     texts — +1 failure +1 intent per call trips on the second).
 * guard_strike telemetry for run a324be0a (fresh read 2026-09-20 ~10:29Z):
 *   10:00:25 tool_preflight  update_feedback ungrounded_id intended:verify
 *   10:00:31 tool_derail_break update_feedback perma:false intended:verify  (TRIP 1)
 *   10:01:48 tool_derail_break update_feedback perma:true  (TRIP 2 — NO
 *            intended field: the repeat calls' reasoning named no other tool,
 *            so +1 failure only ⇒ three more calls to the second trip)
 *   10:02:45 tool_derail_break update_document perma:false state:ended_run
 *            tools:[update_feedback,update_document] trips:3 intended:run_command
 *   ⇒ trip tallies {update_feedback:2, update_document:1} = "3 episodes";
 *   the terminal note names run_command (the LAST intent mismatch, from the
 *   update_document streak — agent.ts:3253, derailIntendedTool ≠ the notice
 *   tool). The NEXT run (continuation r1, 10:02:58Z) completed cleanly with
 *   the full second-pass audit + SHIP verdict (msg 038d8f06).
 *
 * DEPLOY-BASELINE NOTE: the run started 09:53:51Z on the pre-22c309f4-fix
 * code line (the kimi-k3 conformance fix 8f4c4464's deploy completed
 * ~09:58:48Z per ticket d18241b3's filing lane) — a PRE-fix-baseline
 * occurrence of the consolidated kimi-k3 wrong-tool class.
 *
 * VERDICT (the tickets' mandated investigation): MODEL BEHAVIOR — kimi-k3
 * wrong-tool substitution with model-authored placeholder ids, the
 * placeholder-emission dispatch-loop class (f839cede / aff1c189 / ec9d7424)
 * and the same-morning wrong-tool cluster (0aecbe92 / b305c23e / 718a04a5 /
 * 8e900af9 / d87f1ea0). Every deterministic seam behaved AS DESIGNED: the
 * grounding preflight refused the invented id WITHOUT executing and named
 * the intended tool (verify); the document existence refusals are
 * failure-shaped by design (718a04a5, 27e3a5fd) and correctly counted; the
 * breaker withheld → perma-locked → ended the run honestly
 * (completed-with-note, never modelErrored) and filed one investigation
 * ticket per tool. NO shape exemption, NO framework code change (ea69c94e /
 * d0b9c6a6 disposition: ungrounded/existence refusals are the breaker's
 * primary derailment signal).
 *
 * These tests pin: the incident envelopes are failure-shaped; the preflight
 * refusal for "noop-probe-avoid" is the EXACT filed text (built by the REAL
 * ungroundedIdRefusal); the reconstructed {uf:2, ud:1} trip sequence ends
 * the run with the EXACT incident note (3 episodes, intended run_command);
 * the per-tool auto-filings carry the incidents' exact filed texts; the
 * ended_run telemetry row matches the incident's; and update_document's
 * calls EXECUTE (not a platform tool — no grounding preflight) into the
 * existence refusal. Scaffold mirrors agent-derail-break.0aecbe92.test.ts.
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

// The grounded REPEAT update_feedback calls execute into the tool's own
// (failure-shaped) not-found refusal. The exact wording is NOT pinned by any
// filed evidence (only the first streak's preflight envelope was filed, in
// 9d5cee91) — the shape is what the breaker counts, so any `{"ok": false`
// envelope replays the arithmetic faithfully.
const UF_TOOL_REFUSAL = (id: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'not_found',
  message: `Tool update_feedback failed: no feedback ticket with id "${id}" exists for this user.`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return UF_TOOL_REFUSAL(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document/feedback seam: update_document AND update_feedback both
// dispatch via ctx.toolCache (WEB_TOOL_NAMES = TOOL_DEFINITIONS names,
// agent.ts:304). Keep the REAL TOOL_DEFINITIONS; stub only the executor.
const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return UD_ENVELOPE(id);
  }
  if (name === 'update_feedback') return UF_TOOL_REFUSAL(String(args?.id ?? ''));
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
import { detectIntendedTool, findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile (no workspace container in the scaffold): run_command and
 *  verify are in the offered schema — the incident's intended tools must be
 *  offerable for the intent-mismatch preflight to name them. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident's placeholder id (9d5cee91's rejected value). */
const PLACEHOLDER = 'noop-probe-avoid';
/** The two fabricated update_document file ids (fcc8bebe, newest first). */
const UD_ID_NEWEST = 'dd3a19fa'; // the TICKET-under-review prefix — 8 hex chars, so SHAPE-grounded
const UD_ID_FIRST = 'not-a-file';

const BRIEF = [
  'ADVERSARIAL REVIEW — refute, don\'t confirm. Branch digby/session-d0edfc91 at sha',
  '4f0ecb321006160dc32a4956ef46dfb9e8d05ca6, the fix for feedback ticket dd3a19fa',
  '(EventHook provenance + machine-run hook guards). Run the checklist: fresh shell',
  'probes, typecheck, the full jest suite, then a SHIP/BLOCK verdict.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-9d5cee91-test',
  sessionId: 'sess-9d5cee91',
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

/** TRIP-1 call: the placeholder id is nowhere in any system/user/tool message,
 *  so the REAL grounding preflight refuses NOT-EXECUTED (+1 ungrounded); the
 *  narration names verify and never update_feedback (+1 intent). */
const ufUngroundedTurn = (n: number) => ({
  content: '',
  reasoning: 'Verify the branch state first — verify the sha, then the diff audit can proceed.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: PLACEHOLDER, status: 'done', adminNote: 'recheck complete' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** TRIP-2 calls: the same placeholder id is now grounded (it sits verbatim in
 *  the trip-1 preflight refusal, a tool result — groundingHaystack covers
 *  tool results), so the call EXECUTES into the tool's not-found refusal.
 *  The narration names the CALLED tool, so no intent mismatch fires (the
 *  incident's 10:01:48 perma strike carries NO intended field) — +1 failure
 *  only, three calls to the second trip. */
const ufRetryTurn = (n: number) => ({
  content: '',
  reasoning: 'Retrying update_feedback with the same id — the ticket mutation must land before the verdict.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: PLACEHOLDER, status: 'done', adminNote: 'recheck complete' }) }],
  finishReason: 'tool_calls',
});
/** The document-seam emissions with the fabricated ids (fcc8bebe): the
 *  narration names run_command (+1 intent) and never update_document. */
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `run_command cannot refresh the generated digest — writing the reconciled figures into file ${id} now.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Review done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** The run-a324be0a episode sequence reconstructed from the guard_strike
 *  telemetry: {update_feedback: 2 trips, update_document: 1 trip} =
 *  "3 episodes" — the ungrounded first call trips immediately (+1 failure
 *  +1 ungrounded +1 intent), the ban round intervenes, three grounded
 *  retries reach the perma trip (+1 failure each, no intent), then the
 *  document seam trips the run into the terminal state (+1 failure +1
 *  intent ×2). */
const wireIncident = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufUngroundedTurn(1)) // 3 ⇒ TRIP 1 (one-round ban) — files 9d5cee91's envelope
    .mockResolvedValueOnce(planTurn(2)) // ban round — harmless success
    .mockResolvedValueOnce(ufRetryTurn(3)) // count 1 (grounded now — executes, no intent)
    .mockResolvedValueOnce(ufRetryTurn(4)) // count 2
    .mockResolvedValueOnce(ufRetryTurn(5)) // count 3 ⇒ TRIP 2 (perma on update_feedback)
    .mockResolvedValueOnce(udTurn(6, UD_ID_FIRST)) // count 2 (failure + intent run_command)
    .mockResolvedValueOnce(udTurn(7, UD_ID_NEWEST)) // count 4 ⇒ TRIP 1 on update_document ⇒ TERMINAL
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('tickets 9d5cee91 + fcc8bebe — kimi-k3 wrong-tool derail of the adversarial-reviewer lane (run a324be0a)', () => {
  it('UNIT: the incident envelopes are failure-shaped; the preflight names verify/run_command; dd3a19fa is shape-grounded', () => {
    const preflightEnvelope = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: PLACEHOLDER }], 'verify');
    // The REAL builder reproduces 9d5cee91's filed text verbatim.
    expect(preflightEnvelope).toContain('"reason": "ungrounded_id"');
    expect(preflightEnvelope).toContain('"value": "noop-probe-avoid"');
    expect(preflightEnvelope).toContain('Your reasoning named verify — you evidently meant to call verify; call it now with its real parameters.');
    expect(looksLikeToolFailure(preflightEnvelope)).toBe(true);
    expect(looksLikeToolFailure(UD_ENVELOPE(UD_ID_FIRST))).toBe(true);
    expect(looksLikeToolFailure(UD_ENVELOPE(UD_ID_NEWEST))).toBe(true);
    expect(looksLikeToolFailure(UF_TOOL_REFUSAL(PLACEHOLDER))).toBe(true);
    // Intent attribution, per seam.
    expect(detectIntendedTool(ufUngroundedTurn(1).reasoning, 'update_feedback', ['run_command', 'verify', 'update_feedback', 'update_document'])).toBe('verify');
    expect(detectIntendedTool(ufRetryTurn(3).reasoning, 'update_feedback', ['run_command', 'verify', 'update_feedback', 'update_document'])).toBeNull();
    expect(detectIntendedTool(udTurn(6, UD_ID_FIRST).reasoning, 'update_document', ['run_command', 'verify', 'update_feedback', 'update_document'])).toBe('run_command');
    // Grounding mechanics: the placeholder starts ungrounded and becomes
    // grounded once a tool result carries it; dd3a19fa (the ticket prefix) is
    // SHAPE-grounded — 8 hex chars — regardless of the haystack (the
    // preflight validates occurrence/shape, never EXISTENCE — 718a04a5).
    expect(findUngroundedIdArgs({ id: PLACEHOLDER }, 'no placeholder here')).toEqual([{ key: 'id', value: PLACEHOLDER }]);
    expect(findUngroundedIdArgs({ id: PLACEHOLDER }, `refusal echoing ${PLACEHOLDER} verbatim`)).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: UD_ID_NEWEST }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: UD_ID_FIRST }, '')).toEqual([{ key: 'fileId', value: UD_ID_FIRST }]);
    // …which is why update_document is NOT preflight-checked at all (not a
    // platform tool): the fabricated file ids EXECUTE into the harmless
    // existence refusal, exactly as filed in fcc8bebe.
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
  });

  it('REPLAY run a324be0a: {update_feedback:2, update_document:1} trips end the run with the EXACT incident note and per-tool filings', async () => {
    wireIncident();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
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

    // Telemetry mirrors the incident's guard_strike rows: the ungrounded
    // preflight strike, trip 1 (intended verify), the perma trip (NO
    // intended), and the ended_run row with the run-level tallies.
    const preflightStrikes = mockRecordLoopMetric.mock.calls.map((c) => c[0])
      .filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.reason === 'ungrounded_id');
    expect(preflightStrikes.some((m) => m.meta.tool === 'update_feedback' && m.meta.intended === 'verify')).toBe(true);
    const ufTrip1 = breakerMetrics().find((m) => m.meta.tool === 'update_feedback' && m.meta.perma === false);
    expect(ufTrip1).toBeDefined();
    expect(ufTrip1!.meta.intended).toBe('verify');
    const ufTrip2 = breakerMetrics().find((m) => m.meta.tool === 'update_feedback' && m.meta.perma === true);
    expect(ufTrip2).toBeDefined();
    expect(ufTrip2!.meta.intended).toBeUndefined();
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', trips: 3, intended: 'run_command' });
    expect(ended!.meta.tools).toEqual(['update_feedback', 'update_document']);

    // run_command was never emitted, so no shell work ever executed.
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'run_command')).toBe(false);
    expect(mockToolCacheExec.mock.calls.some((c) => c[0] === 'run_command')).toBe(false);

    // The per-tool auto-filings carry the incidents' exact filed texts:
    // 9d5cee91 — the FIRST update_feedback streak filed the single REAL
    // preflight envelope (newest-first array of one), intended verify.
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ufFilings = filings.filter((f) => f.tool === 'update_feedback');
    expect(ufFilings.length).toBe(2); // trip 1 + the perma trip (the ticket's "first streak this run" keeps trip 1)
    expect(ufFilings[0].recentFailures).toEqual([
      ungroundedIdRefusal('triage_ticket', [{ key: 'id', value: PLACEHOLDER }], 'verify'), // model-facing name at the production call site
    ]);
    expect(ufFilings[0].intended).toBe('verify');
    expect(ufFilings[1].recentFailures).toEqual([UF_TOOL_REFUSAL(PLACEHOLDER), UF_TOOL_REFUSAL(PLACEHOLDER), UF_TOOL_REFUSAL(PLACEHOLDER)]);
    // fcc8bebe — the terminal update_document filing carries the two existence
    // refusals NEWEST-FIRST (dd3a19fa was the second emission), intended
    // run_command.
    const udFiling = filings.find((f) => f.tool === 'update_document');
    expect(udFiling).toBeDefined();
    expect(udFiling.recentFailures).toEqual([UD_ENVELOPE(UD_ID_NEWEST), UD_ENVELOPE(UD_ID_FIRST)]);
    expect(udFiling.intended).toBe('run_command');
  });
});
