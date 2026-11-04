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
 * Replay pin — tickets c562f895 + c2b3084d (TWO mishaps auto-filed from the
 * SAME source run: run 023ea76f in session b95e9df6, chat "Kernel
 * Optimization for GLM-5.3 W4A16", coding seat kimi-k3, 2026-09-20
 * 17:57–18:03Z). The run itself was a SPURIOUS hook wake of a lane RETIRED
 * 2026-09-17 under the owner stop ruling — the hook-hygiene defect is
 * separately ticketed as 57154856 and is NOT fixed here; this suite pins the
 * two streaks the woken lane produced before the breaker ended the run.
 *
 * ADJUDICATION (both tickets' mandated INVESTIGATE): MODEL BEHAVIOR — the
 * kimi-k3 placeholder-emission / wrong-tool derail class, the SAME class as
 * the sibling replays agent-derail-break.ec9d7424.test.ts and
 * agent-derail-break.718a04a5.test.ts; occurrences #4/#5 post-27e3a5fd (the
 * 27e3a5fd marker registration is what made the document-seam refusal
 * failure-shaped at all). NOT a deterministic framework defect: every
 * deterministic seam behaved exactly as designed — the ticket-18086326
 * machine-mutation gate refused BOTH phantom update_feedback mutations with
 * the truthful ticket_not_found envelope (nothing was closed), the document
 * seam's existence refusal counted BOTH phantom update_document calls (no
 * file was touched), the intent signal named the tools the lane's own
 * reasoning named, the weighted breaker tripped once per tool, and the
 * terminal state ended the run honestly when the SECOND tool tripped.
 * NO platform code change — this file is the tickets' replay pin.
 *
 * STREAK A — ticket c562f895 (tool update_feedback; identical args
 * id:"placeholder" on BOTH calls; TWO IDENTICAL filed texts, newest first;
 * the lane's reasoning named update_plan):
 *   { "ok": false, "tool": "update_feedback", "reason": "ticket_not_found",
 *     "ticketId": "placeholder", "message": "This machine-triggered run may
 *     NOT mutate feedback ticket placehol: Feedback ticket \"placeholder\"
 *     not found — nothing was closed. Copy the exact id from list_feedback.
 *     If this id was fabricated or mistyped, re-derive a real one from
 *     list_feedback/get_feedback or your dispatch brief before retrying;
 *     nothing was mutated. If the ticket needs triage you cannot evidence,
 *     record a file…" }                       (×2 — filed text truncated)
 * The envelope is CURRENT source, byte-faithful: platform-tools.ts:3674
 * (`This machine-triggered run may NOT mutate feedback ticket
 * ${ticketId.slice(0,8)}: ${verdict.message} If this id was fabricated or
 * mistyped, …` — the d2c2744b ticket_not_found TRUTH variant, "placehol" =
 * "placeholder".slice(0,8)) wrapping closure-evidence.ts:266
 * (`Feedback ticket "${ticketId}" not found — nothing was closed. Copy the
 * exact id from list_feedback.`; the composition is pinned at
 * platform-tools.update-feedback-gate.d2c2744b.test.ts:224).
 *
 * STREAK B — ticket c2b3084d (tool update_document; identical args
 * fileId:"placeholder" on BOTH calls; TWO IDENTICAL filed texts, newest
 * first; the lane's reasoning named get_chat_messages):
 *   No generated file with id placeholder belongs to this user. Call
 *   list_files to see the current files.                        (×2)
 * The envelope is tool-executor.ts:712/780/875 verbatim (read_document /
 * update_document / fill_pdf_form share the one template) and FAILURE-SHAPED
 * since 27e3a5fd: the ^-anchored FAILURE_MARKERS entry at
 * learnings-index.service.ts:384 (/^No generated file with id \S+ belongs to
 * this user\./) — before that registration the 718a04a5 loop read as SUCCESS.
 *
 * TRIP ARITHMETIC (reconstructed from the CURRENT breaker, agent.ts — read,
 * not guessed):
 *   - GROUNDING (why streak A EXECUTED twice instead of dying at the
 *     pre-flight): "placeholder" is NOT id-shaped (ID_SHAPE_RE
 *     /^[0-9a-f]{8}/i, tool-preflight.ts:35 — 'p' is not hex), but it
 *     occurred VERBATIM in the run's haystack (the same 00667344/ec9d7424
 *     bare-word echo mechanism: a transcript pull or doctrine line carried
 *     the word "placeholder" — the verbatim-occurrence rule,
 *     tool-preflight.ts:73, cannot distinguish such a token from a real
 *     citation; the exact carrier row in run 023ea76f is not pinned and is
 *     immaterial — the id is model-authored either way). findUngroundedIdArgs
 *     (agent.ts:3106) returns [] ⇒ no refusal ⇒ BOTH calls execute into the
 *     gate. update_document is not platform-preflighted at all (not in
 *     PLATFORM_TOOL_NAMES; DOC_SEAM_ID_TOOLS agent.ts:360), so streak B's
 *     calls execute into the document seam directly.
 *   - WEIGHTS (agent.ts:3352-3366): each failure-shaped result on the streak
 *     tool is +1 (3354-3355); `preflightUngrounded` is false on every call
 *     here (grounded, 3364); the intent mismatch is +1 (3365-3366) — the
 *     reasoning names update_plan on the update_feedback calls and
 *     get_chat_messages on the update_document calls, never the emitted tool.
 *     So EACH call weighs 2: call 1 = 1+1 = 2 < 3; call 2 = +1 (→3) +1 (→4)
 *     ≥ 3 ⇒ TRIP at the second call (3395), with exactly the two identical
 *     failure texts captured newest-first (3358, unshift, ≤1200 chars — both
 *     envelopes fit whole). Per streak: tallies {update_feedback:1} and
 *     {update_document:1}.
 *   - The identical-call repeat breaker (3563-3564, 3611) NEVER engages: each
 *     identical pair only takes repeatCount to 1; the exact leg needs
 *     repeatCount ≥ 2 (the same signature 3 turns running), and the near leg
 *     resets on failure turns (3575).
 *   - END STATE (3480-3484): derailTripCounts = {update_feedback:1,
 *     update_document:1} ⇒ size 2 ≥ 2 ⇒ TERMINAL ended_run at the
 *     update_document trip; derailTripsTotal = 1+1 = 2 ⇒ the end-note reads
 *     "repeated wrong-tool derailment (2 episodes; intended tool appears to
 *     be get_chat_messages)". A "3 episodes" note would need tallies like
 *     {X:2,Y:1} — two single-tool streaks end at TWO episodes. The first
 *     trip's withhold was the ONE-ROUND ban (3402-3403, perma:false); no
 *     tool ever reached a second trip, so perma never engaged.
 *   - Re-anchor leg (b) (3369-3371) fires EXACTLY once — on the first
 *     update_feedback failure (intent_mismatch, intended update_plan);
 *     reAnchorUsed then suppresses every later steer (3425).
 *
 * These tests pin: both envelopes byte-faithful to CURRENT source (incl. a
 * source-byte pin of the three tool-executor templates, the platform-tools
 * gate template, the closure-evidence verdict, and the ^-anchored
 * FAILURE_MARKERS entry); the update_document envelope failure-shaped with
 * the anchor holding against a mid-string quote; the grounding asymmetry
 * ("placeholder" grounded by the brief's bare word, ungrounded without it);
 * the intent preflight naming update_plan / get_chat_messages; the E2E
 * replay of run 023ea76f — two 2-call streaks, trips {uf:1, ud:1}, terminal
 * ended_run with the EXACT 2-episode note, the two auto-filings carrying the
 * tickets' verbatim texts newest-first, exactly ONE cross-check consult (the
 * terminal branch skips it, 3501-3504), and ZERO side effects (every phantom
 * mutation refused; the narrated tools never even emitted). Scaffold mirrors
 * agent-derail-break.ec9d7424.test.ts + the ToolCache document-seam stub of
 * agent-derail-break.0c0ce759.test.ts (same mock set).
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') {
    // The incident calls (id "placeholder") EXECUTED into the machine-mutation
    // gate's refusal; any other (shape-valid) id is the recovery path below.
    return String(args?.id ?? '') === CALL_ID ? GATE_ENVELOPE : UF_SUCCESS;
  }
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES = TOOL_DEFINITIONS names, agent.ts:304). Keep the REAL
// TOOL_DEFINITIONS; stub only the executor — the incident's existence-refusal
// envelope verbatim (c2b3084d's filed failure texts, tool-executor.ts:780).
const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    return UD_ENVELOPE(String(args?.fileId ?? args?.documentId ?? ''));
  }
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

import * as fs from 'fs';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool, findUngroundedIdArgs } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile: the platform + document tools are in the offered schema —
 *  both intended tools (update_plan, get_chat_messages) must be offerable for
 *  the intent-mismatch weight to name them. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim ids (tickets c562f895 + c2b3084d) ───────────────
const CALL_ID = 'placeholder'; // update_feedback id AND update_document fileId — identical on both calls of each streak
const RECOVERY_ID = 'c562f895'; // 8-hex — shape-valid citation for the recovery call (the ticket's own prefix)

/** The gate envelope exactly as the breaker counted it — CURRENT source:
 *  platform-tools.ts:3674 (ticket_not_found truth variant; ticketId.slice(0,8)
 *  → "placehol") wrapping the closure-evidence.ts:266 not-found verdict. The
 *  filed text truncates mid-string at the ticket's rendering; the breaker's
 *  own 1200-char slice (agent.ts:3358) captures this envelope WHOLE. */
const GATE_ENVELOPE = JSON.stringify(
  {
    ok: false,
    tool: 'update_feedback',
    reason: 'ticket_not_found',
    ticketId: CALL_ID,
    message:
      `This machine-triggered run may NOT mutate feedback ticket ${CALL_ID.slice(0, 8)}: ` +
      `Feedback ticket "${CALL_ID}" not found — nothing was closed. Copy the exact id from list_feedback. ` +
      'If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated. ' +
      'If the ticket needs triage you cannot evidence, record a file_feedback sighting instead.',
  },
  null,
  1,
);

/** A shape-valid recovery close SUCCEEDS — used only by the withhold test. */
const UF_SUCCESS = `Updated feedback ticket ${RECOVERY_ID}-aaaa-bbbb-cccc-dddddddddddd: status=in_progress, priority=3, adminNote set.`;

/** The spurious-wake brief — carries the bare word "placeholder" in its own
 *  doctrine line (as the real run's haystack did: transcript pulls and claim
 *  doctrine are full of it), so BOTH update_feedback calls are GROUNDED and
 *  execute into the gate — the ec9d7424 bare-word mechanism. */
const BRIEF = [
  '[Hook wake — Kernel Optimization for GLM-5.3 W4A16]',
  'The kernel-optimization lane was retired 2026-09-17 under the owner stop ruling.',
  'Verify no restart is warranted, then record the wake outcome on the bookkeeping ticket.',
  'Never mutate platform state from narration; never pass a placeholder id —',
  'ids come from a prior tool result, the brief, or the user.',
].join('\n');

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-c562f895-test',
  sessionId: 'sess-b95e9df6',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the wake check now.`,
  emit: jest.fn(),
});

/** STREAK A turn: update_feedback({id:"placeholder"}) while the reasoning
 *  names update_plan and NEVER the emitted tool — the c562f895 shape
 *  ("lane's reasoning named update_plan"). The intent weight (+1) enters
 *  through agent.ts:3365 on every such call. */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'update_plan first — mark the retired-lane checkpoint step blocked, then record the wake bookkeeping.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: CALL_ID }) }],
  finishReason: 'tool_calls',
});
/** STREAK B turn: update_document({fileId:"placeholder"}) while the
 *  reasoning names get_chat_messages — the c2b3084d shape. The doc-seam call
 *  EXECUTES (no platform preflight) into the existence refusal. */
const udTurn = (n: number) => ({
  content: '',
  reasoning: 'get_chat_messages next — pull the retired lane transcript before touching the checkpoint document.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: CALL_ID, content: 'wake outcome' }) }],
  finishReason: 'tool_calls',
});
/** A faithful recovery turn: the reasoning names the called tool (no intent
 *  weight) and the id is shape-valid (grounded by ID_SHAPE_RE). */
const ufRecoveryTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `update_feedback with the real ticket id ${id} now — record the wake outcome on the dispatched ticket.`,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id, status: 'in_progress', adminNote: 'wake resolved' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Wake recorded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** Run 023ea76f's emission sequence: the two identical update_feedback calls
 *  (trip 1 — one-round ban), then the two identical update_document calls
 *  (trip 2 — a SECOND tool tripping ends the run). */
const wireIncident = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1)) // grounded → executes → gate refusal: count 1 +1 intent = 2
    .mockResolvedValueOnce(ufTurn(2)) // count 3 +1 intent = 4 ⇒ TRIP {update_feedback:1} — one-round withhold
    .mockResolvedValueOnce(udTurn(3)) // existence refusal: count 1 +1 intent = 2
    .mockResolvedValueOnce(udTurn(4)) // count 3 +1 intent = 4 ⇒ TRIP {update_document:1} ⇒ size 2 ⇒ TERMINAL
    .mockResolvedValue(FINAL);        // never reached
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay c562f895 + c2b3084d — one spurious hook wake, two identical-args placeholder streaks (update_feedback gate + update_document seam), run ended at 2 episodes', () => {
  it('BYTE-FAITHFUL: the update_document envelope is tool-executor.ts verbatim (712/780/875 share one template) and FAILURE-SHAPED via the ^-anchored FAILURE_MARKERS entry (learnings-index.service.ts:384)', () => {
    // The filed text, byte for byte.
    expect(UD_ENVELOPE(CALL_ID)).toBe('No generated file with id placeholder belongs to this user. Call list_files to see the current files.');
    // Source pin: the template sits at exactly the three document-tool sites.
    const src = readSrc('../tool-executor.ts');
    expect(src.match(/No generated file with id \$\{fileId\} belongs to this user\. Call list_files to see the current files\./g)).toHaveLength(3);
    // Failure-shaped — the 27e3a5fd registration is what counted streak B at all.
    expect(looksLikeToolFailure(UD_ENVELOPE(CALL_ID))).toBe(true);
    // …and ^-anchored: a file QUOTING the envelope mid-string is never failure-shaped.
    expect(looksLikeToolFailure(`excerpt: ${UD_ENVELOPE(CALL_ID)}`)).toBe(false);
    const lidx = readSrc('./learnings-index.service.ts');
    expect(lidx).toContain('/^No generated file with id \\S+ belongs to this user\\./');
  });

  it('BYTE-FAITHFUL: the update_feedback gate envelope is platform-tools.ts:3674 (ticket_not_found truth variant) wrapping closure-evidence.ts:266 — "placehol" = ticketId.slice(0,8)', () => {
    const env = JSON.parse(GATE_ENVELOPE);
    expect(env).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ticket_not_found',
      ticketId: CALL_ID,
    });
    // The filed text head, verbatim: gate prefix + the not-found verdict.
    expect(env.message).toContain('may NOT mutate feedback ticket placehol: Feedback ticket "placeholder" not found — nothing was closed. Copy the exact id from list_feedback.');
    expect(env.message).toContain('If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated.');
    // The d2c2744b truth variant: NO fabricated dispatch state for a missing row.
    expect(env.message).not.toContain('not dispatched to this session');
    // Failure-shaped (the structured-refusal marker) — that is what fed streak A.
    expect(looksLikeToolFailure(GATE_ENVELOPE)).toBe(true);
    // Source pins: the gate template and the verdict text are CURRENT source.
    expect(readSrc('../platform/platform-tools.ts')).toContain('may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: ${verdict.message} If this id was fabricated or mistyped, re-derive a real one from list_feedback/get_feedback or your dispatch brief before retrying; nothing was mutated.');
    expect(readSrc('../feedback/closure-evidence.ts')).toContain('Feedback ticket "${opts.ticketId}" not found — nothing was closed. Copy the exact id from list_feedback.');
  });

  it('GROUNDING: "placeholder" is not id-shaped, but the brief\'s bare-word occurrence GROUNDS it (the ec9d7424/00667344 verbatim-occurrence rule) — that is why both update_feedback calls EXECUTED into the gate instead of dying at the pre-flight', () => {
    expect(/^[0-9a-f]{8}/i.test(CALL_ID)).toBe(false); // 'p' is not hex → occurrence rule decides
    expect(BRIEF.includes(CALL_ID)).toBe(true); // the doctrine line's bare word
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF)).toEqual([]); // grounded → executes
    // Without the occurrence the SAME arg is an invented id — the refusal shape
    // these filed envelopes are NOT (both filed texts are GATE envelopes).
    expect(findUngroundedIdArgs({ id: CALL_ID }, 'a brief with no such token'))
      .toEqual([{ key: 'id', value: CALL_ID }]);
  });

  it('INTENT: the preflight names update_plan on the update_feedback reasoning and get_chat_messages on the update_document reasoning — never the emitted tool (the +1 weight on every incident call)', () => {
    const offered = ['get_chat_messages', 'update_feedback', 'update_document', 'update_plan', 'run_command'];
    expect(detectIntendedTool(ufTurn(1).reasoning, 'update_feedback', offered)).toBe('update_plan');
    expect(detectIntendedTool(udTurn(3).reasoning, 'update_document', offered)).toBe('get_chat_messages');
    // Sanity: faithful narration (the recovery turn) convicts nothing.
    expect(detectIntendedTool(ufRecoveryTurn(5, RECOVERY_ID).reasoning, 'update_feedback', offered)).toBeNull();
  });

  it('END-TO-END run 023ea76f: two 2-call identical streaks trip {update_feedback:1, update_document:1} — the run ENDS with the exact 2-episode note, both filings carry the verbatim texts, ZERO side effects', async () => {
    wireIncident();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (2 episodes');
    expect(result.finalText).toContain('intended tool appears to be get_chat_messages');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    // Completed-with-note, never a provider failure.
    expect(result.modelErrored).toBeUndefined();
    const notePart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(notePart).toBeDefined();
    expect(notePart!.marker).toBe('guard');
    const guardEmits = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(guardEmits.some((e) => String(e.text).startsWith('[HARNESS] Run ended'))).toBe(true);

    // Telemetry: the FIRST trip is the non-terminal one-round withhold on
    // update_feedback (perma:false, intent named); the SECOND trip ends the run.
    const first = breakerMetrics().find((m) => m.meta.state !== 'ended_run');
    expect(first).toBeDefined();
    expect(first!.meta).toMatchObject({ tool: 'update_feedback', perma: false, intended: 'update_plan' });
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', perma: false, trips: 2, intended: 'get_chat_messages' });
    expect(ended!.meta.tools).toEqual(expect.arrayContaining(['update_feedback', 'update_document']));
    // No tool ever reached a second trip — perma NEVER engaged this run.
    expect(breakerMetrics().every((m) => m.meta.perma !== true)).toBe(true);
    // Exactly ONE re-anchor steer (leg b, on the first update_feedback failure).
    const reanchors = mockRecordLoopMetric.mock.calls.map((c) => c[0]?.meta).filter((m) => m?.seam === 'tool_derail_reanchor');
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0]).toMatchObject({ tool: 'update_feedback', intended: 'update_plan', reason: 'intent_mismatch' });
    // The identical-call repeat breaker never engaged (each pair: repeatCount 1).
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0]?.meta?.seam === 'tool_repeat_break')).toBe(false);

    // BOTH update_feedback calls EXECUTED into the gate (grounded by the bare
    // word) — and BOTH update_document calls executed into the document seam.
    const ufExecs = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback');
    expect(ufExecs).toHaveLength(2);
    expect(ufExecs.every((c) => c[2]?.id === CALL_ID)).toBe(true);
    const udCalls = mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document');
    expect(udCalls).toHaveLength(2);
    expect(udCalls.every((c) => c[1]?.fileId === CALL_ID)).toBe(true);

    // ZERO SIDE EFFECTS (pin 5): every phantom mutation was REFUSED — the only
    // update_feedback results this run were the gate envelope (nothing closed,
    // nothing mutated), and the narrated-intended tools were never even EMITTED.
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'update_plan')).toBe(false);
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'get_chat_messages')).toBe(false);
    expect(mockToolCacheExec.mock.calls.some((c) => c[0] === 'get_chat_messages')).toBe(false);

    // The TWO auto-filings carry the tickets' verbatim texts, newest first.
    // Filing order is trip order: the non-terminal update_feedback trip files
    // first (with the consult), the terminal update_document trip files second
    // (the run-end branch — the consult is SKIPPED there, agent.ts:3501-3504).
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(2);
    const ufFiling = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ufFiling.tool).toBe('update_feedback');
    expect(ufFiling.perma).toBe(false);
    expect(ufFiling.intended).toBe('update_plan');
    expect(ufFiling.recentFailures).toEqual([GATE_ENVELOPE, GATE_ENVELOPE]);
    const udFiling = mockFileStreakInvestigation.mock.calls[1][0];
    expect(udFiling.tool).toBe('update_document');
    expect(udFiling.perma).toBe(false);
    expect(udFiling.intended).toBe('get_chat_messages');
    expect(udFiling.recentFailures).toEqual([UD_ENVELOPE(CALL_ID), UD_ENVELOPE(CALL_ID)]);
    // Exactly ONE cross-check consult, on the non-terminal trip, with the same
    // evidence object (the 8579d419 purity contract).
    expect(mockConsultCrossCheckerOnStreak).toHaveBeenCalledTimes(1);
    expect(mockConsultCrossCheckerOnStreak.mock.calls[0][0].recentFailures).toEqual(ufFiling.recentFailures);
  });

  it('withhold semantics: the FIRST trip is the ONE-ROUND ban (perma stays out) — a same-tool call the very next round is refused tool_not_offered WITHOUT executing, and the round after the tool is back and EXECUTES', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1))                    // count 2
      .mockResolvedValueOnce(ufTurn(2))                    // count 4 ⇒ TRIP 1 — withheld for the next model round
      .mockResolvedValueOnce(ufRecoveryTurn(3, CALL_ID))   // withheld ⇒ tool_not_offered refusal (never executes)
      .mockResolvedValueOnce(ufRecoveryTurn(4, RECOVERY_ID)) // back on offer ⇒ executes ⇒ SUCCESS (streak ends)
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput());

    expect(mockRunModelTurn).toHaveBeenCalledTimes(5);
    // One trip total, non-terminal; perma never engaged; the run did NOT end.
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'update_feedback', perma: false, intended: 'update_plan' });
    expect(breakerMetrics()[0].meta.state).toBeUndefined();
    expect(result.finalText).toContain('Wake recorded.');
    // Exactly ONE withheld-round refusal — the ban lasts exactly one round.
    const notOffered = mockRecordLoopMetric.mock.calls
      .map((c) => c[0]?.meta)
      .filter((m) => m?.seam === 'tool_preflight' && m?.reason === 'tool_not_offered' && m?.tool === 'update_feedback');
    expect(notOffered).toHaveLength(1);
    // Executions: the two grounded incident calls + the recovery call. The
    // withheld round-3 call never reached the tool.
    const ufExecs = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback');
    expect(ufExecs).toHaveLength(3);
    expect(ufExecs[2][2]?.id).toBe(RECOVERY_ID);
    // One filing (the trip), carrying the two incident texts.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
  });

  it('wiring seam: update_feedback + get_chat_messages stay preflight-covered platform tools, while update_document is NOT one (it dispatches through the ToolCache document seam — why streak B executed without a grounding preflight)', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('get_chat_messages');
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
  });
});
