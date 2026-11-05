/**
 * REPLAY TEST — ticket d2cceee3 (mishap, 2026-09-23): "5× success-side
 * wrong-tool loop: write_file on 'GLM-5.3 Deployment on Dual Sparks' —
 * framework or model?" Auto-filed at the breaker trip (owner doctrine
 * 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 28de72e5-46c5-4a90-811d-840184efc106 — the
 * "GLM-5.3 Deployment on Dual Sparks" spark-cluster ops lane; run
 * 528f40cc-9793-46d6-8f83-b96ac7295493, kimi-k3/moonshot, coding profile,
 * machine-triggered): write_file SUCCEEDED 5 consecutive times while the
 * guard's detected "intent" churned — the trip row (guard_strike
 * 'tool_derail_break' 14:43:20.889Z) carries shape 'success_intent',
 * churned:true, intended 'verify'. The auto-file landed under the correct
 * churn title.
 *
 * ADJUDICATION (this lane, 2026-09-23, from the run's own agent_events —
 * 10,582 rows pulled via the read-only SSM probe): FRAMEWORK-SIDE, the
 * first such verdict in the success-side corpus (the five prior siblings
 * 2c98b460 / c737d007 / a1660b1a / ee39f231 / 4994e2f1 / 8da24785 /
 * aa30b46e were all model-side). The lane was FAITHFUL to its calls:
 * every trip-forming turn's narration ends by ANNOUNCING the write in
 * prose — verbatim final sentences: "Write w2_fire.sh + w2_watch.sh now.",
 * "Writing the window-2 machinery while the transfer runs:", "Write the
 * S3+S5 restore fire script now …", "Let me write the prep probe as a FILE
 * (fixing the 252), send it, then start the transfer machinery." — and
 * each write_file wrote a real, distinct ops script
 * (.digby-scratch/att6_*.sh, w2_*.sh). The convicted "intent" was an
 * ordinary ENGLISH VERB living in EARLIER sentences of a long planning
 * monologue: "GPU/ports verify, lock sweep …" / "Mia + S6 verify (quick
 * probe)" / "verify/abort (~3) steps" / "then FULL E serve verify
 * (separate leg …)" — checklist positions, never the action. Window 8862's
 * conviction additionally counted a DOCTRINE QUOTE ("don't run it with
 * run_command (it will block)" — the run_command=1 in the probe counts).
 * The four pinned model-side quadrants are the opposite shape: their
 * narrations name the other tool AS the action ("Now web_pipe…", "Shell
 * first: run_command …", "Now grep the seam names directly …") — the
 * decision sentence itself.
 *
 * THE FRAMEWORK DEFECT (the deterministic seam): detectIntendedTool counted
 * whole-word mentions ANYWHERE in the last 6000 chars of narration, so an
 * offered-tool name used as an English verb in an EARLIER sentence of a
 * long monologue convicted a faithful call. The 7b2a0969 prose acquittal
 * could not save it: natural narration substitutes the artifact noun for
 * the generic token ("Write w2_fire.sh", never "write the file"), so
 * proseMentionsTool('write_file') stays false by design (its exact-token
 * rule is the cea13871 boundary — correct, unchanged). And the c737d007
 * pair-agnostic re-key (e3417bf98) made the churning verb mentions REACH
 * trip-at-5 (the legacy pair key would have self-erased them) — a correct
 * ladder amplified by a noisy detector leg. Both fixes were live at trip
 * time (ancestors of box sha f41e856f2), and the 58e675c9 probe had
 * flagged these very convictions 'preamble_ordered' (the measured-noise
 * class) — the measurement was right, the conviction leg was the defect.
 *
 * THE FIX (this pin): DECISION-ADJACENCY — the CONVICTION leg of
 * detectIntendedTool scans only the narration's FINAL SENTENCE (the
 * decision segment, where the model states the action it is taking);
 * every ACQUITTAL leg (literal self-naming, alias, prose) keeps the WHOLE
 * text. Broad acquittal, narrow conviction — the safe direction for a
 * heuristic net. A faithful announce-final ("Write w2_fire.sh +
 * w2_watch.sh now.") now acquits even when earlier checklist sentences
 * used "verify"/"grep" as verbs; a genuine derailment still convicts
 * because derailed narrations name the wrong tool IN the decision sentence
 * (every pinned model-side incident is single-sentence — verified against
 * every replay fixture in the suite: 2c98b460's MISS_REASONING, c737d007's
 * R_GCM..R_TG, ee39f231's R_WP1..3/R_GREP, 4994e2f1's R1..R4, d73765fc's
 * R_WP, 8da24785's P_BATCH/R_CLOSE, aa30b46e's R_FAIL/R_GLOB/R_READ/
 * R_COMPUTER, 14739e76's incidentNarration, 4af20b7a's sendConvictTurn,
 * 0c0ce759's udTurn, 431518a2's ufTurn/ghostTurn, a2d67416's
 * VD_INTENT_REASONING, 58e675c9's SCHED/PLAN_MISS — all single-sentence,
 * so their convictions stand byte-identical under the scoping).
 *
 * THIS PIN replays the incident's exact shape against the REAL agent loop:
 * write_file succeeds 5× under long monologue narrations whose final
 * sentences ANNOUNCE the write while earlier sentences use offered-tool
 * names as English verbs — and asserts NO trip, NO steer, NO discount rows
 * for the write_file leg (the detector no longer convicts at all), plus
 * the negative legs: a genuine single-sentence derailment still trips
 * (d2cceee3 does not weaken containment), the prose/literal acquittals
 * still hold, and the kill-switch silhouette is unchanged.
 *
 * Scaffold mirrors agent-derail-break.aa30b46e.test.ts: every mismatched
 * write_file call SUCCEEDS ('probe result: ok'); write_file dispatches via
 * executeCodingTool (name-first mock, the 0aecbe92 gotcha); args vary by
 * LETTER-skeleton path (never digit-only) so the exact/digit-collapsed
 * repeat signatures stay blind; no run_command call ever executes (the
 * scaffold's container mock would leak to a real shell). The verb-mention
 * narrations deliberately name offered tools ONLY as verbs in non-final
 * sentences — the incident's exact shape.
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
  __esModule: true, agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// Every write_file call SUCCEEDS ('probe result: ok') — the success-side
// premise (the failure ladder is blind throughout). write_file routes via
// executeCodingTool with the REAL (ctx, name, args) signature — name-first
// mocks silently misroute (the 0aecbe92 scaffold gotcha).
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async () => 'probe result: ok');
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
import { detectIntendedTool, proseMentionsTool, intentMismatchDiscount } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). write_file,
 *  verify, grep, glob, read_file, edit_file are all in the orchestrator's
 *  offered schema (the coding tool set) — so each is convictable when the
 *  FINAL SENTENCE names it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The incident wake, faithful to its haystack: the standing doctrine
 *  names write_file (the "Prefer edit_file … over rewriting a whole file
 *  with write_file" line) — exactly why the wild convictions were
 *  discount-eligible 'preamble_ordered'. */
const BRIEF = [
  '[MACHINE-TRIGGERED RUN — spark-cluster window-2 frontier: published vLLM stack on S3+S5]',
  'You are the deployment lane: stage the transfer, build the variant, fire the frontier, watch the boot.',
  '- Prefer edit_file (targeted, exact-match edits) over rewriting a whole file with write_file.',
  'Report back with the boot verdict and the WS trajectory.',
].join('\n');

const makeInput = (userMessage: string = BRIEF, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-d2cceee3-test',
  sessionId: 'sess-d2cceee3',
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

// ── The incident narrations (verbatim shapes from run 528f40cc's
//    agent_events; the offered-tool VERBS live in earlier sentences, the
//    final sentence announces the write) ──

/** The trip-forming turn (14:43:16Z, WF seq 9532): the w2_watch.sh planning
 *  monologue. 'verify' appears as an English verb in the watch-design
 *  checklist sentence; the FINAL sentence announces the write. */
const R_TRIP = [
  'w2_watch.sh — success/fail/wedge detection + WS trajectory + on-wedge capture:',
  '- Success: S3:8000/health 200 → then FULL E serve verify (separate leg: models, E markers in logs — DFLASH2-DRAFTER-GROUP or the drafter loaded lines, kv cache size, completion).',
  '- Fail: Exited either node → abort → restore (att6_s35_restore.sh).',
  '- Wedge: 3-gate frozen (logs line-count frozen 12 min AND zero artifact growth AND worker R~99%) → capture attempt: docker cp py-spy into vllm_node + docker exec py-spy dump --pid <worker> (NO --native) ×2 60s apart → then abort → restore.',
  'Given the step budget, the remaining sequence is feasible. Feasible.',
  'Write w2_fire.sh + w2_watch.sh now.',
].join('\n');

/** Streak windows 7384/7737/8060: the same shape with different verbs —
 *  'verify' as an ordinary checklist verb, announce-final. */
const R_POSTCYCLE = [
  'Post-cycle probe v1 (at ~14:06Z, ~3.5 min post-on): tailnet map + per-node ssh + uptime + docker ps -a (top entries) + free. That tells me which nodes are back and what is auto-starting.',
  'The restore matrix needs its readiness gates: GPU/ports verify, lock sweep, then the health-poll legs.',
  'Let me write it and send after a sleep.',
].join('\n');

const R_RESTORE = [
  'The post-cycle restore order is prod first: S3+S5 GLM back serving (never-dark floor), then node-b TP2 on S1+S2, then Mia, then S6.',
  '4. Then node-b restore (att6_node-b-restore.sh — ready; up to ~13 min incl. health poll). 5. Mia + S6 verify (quick probe).',
  'Parallelization: legs 1 and 3 are independent (S3+S5 vs S2). Leg 4 depends on leg 3 (dumps before load). Leg 5 independent anytime.',
  'Write the S3+S5 restore fire script now (adapted from att4_abort_restore.sh), fire it + the S2 harvest as two parallel SSM sends, collect both, then bootwatch + mimo restore.',
].join('\n');

const R_PREP = [
  'The image fabric-pipe is: docker save to a file → http.server on S1 fabric IP → curl from S3+S5 → docker load. Need S1 disk space check + image size.',
  '2. While transferring: build the launcher variant + gates + watchdog/capture kit + poller declaration.',
  '3. Fire when the digest verify is green on both nodes.',
  'Let me write the prep probe as a FILE (fixing the 252), send it, then start the transfer machinery.',
].join('\n');

/** A GENUINE derailment (the negative leg — d2cceee3 must NOT weaken
 *  containment): the narration names the wrong tool IN the decision
 *  sentence, single-sentence shape like every pinned model-side incident. */
const R_DERAIL = 'Now grep the seam names directly to collect the match list for the census.';

const WORDS = ['kilo', 'lima', 'mike', 'november', 'oscar'];
const writeCall = (n: number) => ({
  id: `t${n}`,
  name: 'write_file',
  arguments: JSON.stringify({
    path: `.digby-scratch/w2_${WORDS[(n - 1) % WORDS.length]}_fire.sh`,
    content: `#!/bin/bash\n# W2 FRONTIER FIRE — published stack on S3+S5 (variant ${WORDS[(n - 1) % WORDS.length]})\nset -euo pipefail\n`,
  }),
});
/** Streaks 1–4: solo turns under the four monologue narrations (the wild
 *  rows landed on separate ops phases, not one batch). */
const monologueTurn = (n: number, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [writeCall(n)],
  finishReason: 'tool_calls' as const,
});
/** An ALIGNED success (narration names the called tool): list_files —
 *  never run_command (the scaffold's container mock would leak to a real
 *  shell). */
const alignedTurn = (n: number) => ({
  content: '',
  reasoning: 'Now list_files to check which census fixtures the builder emitted before the final report.',
  toolCalls: [{ id: `t${n}`, name: 'list_files', arguments: JSON.stringify({}) }],
  finishReason: 'tool_calls' as const,
});
/** The genuine-derailment leg: write_file emitted under a decision sentence
 *  naming grep (single-sentence — the pinned incident shape). */
const derailTurn = (n: number) => ({
  content: '',
  reasoning: R_DERAIL,
  toolCalls: [writeCall(n)],
  finishReason: 'tool_calls' as const,
});
const FINAL = { content: 'Frontier watch handed off.', reasoning: '', toolCalls: [], finishReason: 'stop' as const };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const discountMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'guard_miss' && m?.meta?.seam === 'tool_intent_attribution');
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const steerMessages = () => (conversation() || []).filter(
  (m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('RE-ANCHOR (one per run)'),
);
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));
const offeredAtCall = (k: number) => new Set<string>(((mockRunModelTurn.mock.calls[k]?.[2] ?? []) as Array<{ function?: { name?: string } }>).map((t) => t?.function?.name as string).filter(Boolean));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket d2cceee3 — decision-adjacency: a faithful announce-final monologue with verb mentions in EARLIER sentences no longer convicts (framework-side FP)', () => {
  it('UNIT: the incident premise — every trip-forming narration contains the convicted verb ONLY outside the final sentence, the prose acquittal never fires, and the discount probe still classifies the wild shape', () => {
    const offered = ['write_file', 'edit_file', 'read_file', 'grep', 'glob', 'list_files', 'verify', 'run_command', 'list_dir', 'search_code_semantic'];
    // PRE-FIX behavior (the defect): the verb-anywhere count convicted.
    // POST-FIX behavior: the final sentence announces the write and names
    // NO offered tool ⇒ no conviction at all.
    for (const r of [R_TRIP, R_POSTCYCLE, R_RESTORE, R_PREP]) {
      // The verb IS in the narration (the whole-text premise holds —
      // countMentions sees it) …
      expect(/(?<![A-Za-z0-9_])verify(?![A-Za-z0-9_])/.test(r) || /(?<![A-Za-z0-9_])grep(?![A-Za-z0-9_])/.test(r)).toBe(true);
      // … but the detector no longer convicts on it.
      expect(detectIntendedTool(r, 'write_file', offered)).toBeNull();
    }
    // The announce-final sentence is exactly the incident's shape.
    expect(R_TRIP.trim().endsWith('Write w2_fire.sh + w2_watch.sh now.')).toBe(true);
    // The 7b2a0969 prose acquittal never fires on the incident shapes
    // ("Write w2_fire.sh" substitutes the artifact noun — the exact-token
    // rule is the cea13871 boundary, deliberately unchanged).
    expect(proseMentionsTool(R_TRIP, 'write_file')).toBe(false);
    // The standing orders name write_file ⇒ the WILD shape was
    // discount-eligible (preamble_ordered) — the discount probe is
    // unchanged; what changed is the conviction leg that feeds it.
    expect(intentMismatchDiscount('verify', 'write_file', BRIEF)).toMatchObject({ reason: 'preamble_ordered', marker: 'write_file' });
    // A GENUINE decision-sentence derailment still convicts — the
    // containment is NOT weakened (the single-sentence pinned shape).
    expect(detectIntendedTool(R_DERAIL, 'write_file', offered)).toBe('grep');
  });

  it('REPLAY the incident: write_file ×5 SUCCEEDING under faithful announce-final monologues — NO trip, NO steer, NO wrong-tool withhold (the false positive is gone)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(monologueTurn(1, R_POSTCYCLE)) // 14:03Z — the wild window-8862 shape
      .mockResolvedValueOnce(monologueTurn(2, R_RESTORE))   // 14:10Z
      .mockResolvedValueOnce(monologueTurn(3, R_TRIP))      // 14:15Z-shape monologue
      .mockResolvedValueOnce(monologueTurn(4, R_PREP))      // 14:41Z
      .mockResolvedValueOnce(monologueTurn(5, R_TRIP))      // 14:43:16Z — the wild trip turn
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 10 });
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Frontier watch handed off.');
    expect(result.modelErrored).toBeUndefined();
    expect(result.finalText).not.toContain('Run ended: repeated wrong-tool derailment');

    // NO trip: the success_intent breaker never fired for write_file.
    expect(breakerMetrics().filter((m) => m.meta.tool === 'write_file')).toHaveLength(0);
    // NO steer: the intent_mismatch_success re-anchor never armed.
    expect(reanchorMetrics().filter((m) => m.meta.reason === 'intent_mismatch_success')).toHaveLength(0);
    expect(steerMessages()).toHaveLength(0);
    // NO discount rows for the write_file leg either — the conviction leg
    // that fed the probe no longer fires on these narrations.
    expect(discountMetrics().filter((m) => m.meta.tool === 'write_file')).toHaveLength(0);
    // The tool stays offered throughout — no withhold round.
    expect(offeredAtCall(0).has('write_file')).toBe(true);
    expect(offeredAtCall(4).has('write_file')).toBe(true);
    expect(offeredAtCall(5).has('write_file')).toBe(true);
    // No mishap filing: the evidence channel never saw a streak.
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
    expect(userTexts().some((t) => t.includes('all SUCCEEDED'))).toBe(false);
  });

  it('NEGATIVE (containment preserved): a GENUINE decision-sentence derailment still trips at the fifth mismatch — d2cceee3 weakens nothing', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn(1))
      .mockResolvedValueOnce(derailTurn(2))
      .mockResolvedValueOnce(derailTurn(3))  // steer-at-3 arms (one per run)
      .mockResolvedValueOnce(derailTurn(4))
      .mockResolvedValueOnce(derailTurn(5))  // trip-at-5
      .mockResolvedValueOnce(alignedTurn(6)) // ban round
      .mockResolvedValue(FINAL);
    const input = makeInput(BRIEF, { ...CODING_TEST_PROFILE, maxSteps: 12 });
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Frontier watch handed off.');
    // The steer fired at the third mismatch (the one-per-run re-anchor).
    expect(steerMessages()).toHaveLength(1);
    expect(reanchorMetrics().filter((m) => m.meta.reason === 'intent_mismatch_success')).toHaveLength(1);
    // The trip fired at the fifth, carrying the truthful success shape.
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'write_file', perma: false, intended: 'grep', churned: false });
    // One-round withhold: write_file absent exactly one model round.
    expect(offeredAtCall(5).has('write_file')).toBe(false);
    expect(offeredAtCall(6).has('write_file')).toBe(true);
    // The incident's own notice shape renders truthfully.
    expect(userTexts().some((t) => t.includes('Your last 5 calls of write_file all SUCCEEDED'))).toBe(true);
  });

  it('UNIT (final-sentence boundaries): trailing terminator, interior terminator, no terminator, and a path-like token (w2_fire.sh) do not split wrongly', () => {
    const offered = ['write_file', 'grep', 'verify', 'list_files'];
    // Single sentence ending in a period: whole sentence is the decision —
    // conviction stands (the pinned-incident semantics).
    expect(detectIntendedTool('Now grep the seam names directly to collect the match list.', 'write_file', offered)).toBe('grep');
    // A trailing fragment after the final terminator is too short to
    // convict (guard: <4 chars).
    expect(detectIntendedTool('Now grep the seam names for the match list. ok', 'write_file', offered)).toBeNull();
    // Path-like dots do NOT split (w2_fire.sh stays one token — the
    // incident's exact announce sentence).
    expect(detectIntendedTool('Planning done for this phase. Write w2_fire.sh + w2_watch.sh now.', 'write_file', offered)).toBeNull();
    // The verb in the EARLIER sentence only — the incident's shape.
    expect(detectIntendedTool('First, verify the digest gates. Write w2_fire.sh + w2_watch.sh now.', 'write_file', offered)).toBeNull();
    // …but the verb IN the final sentence still convicts (adjacency works
    // both ways — a decision-sentence verb is a real signal).
    expect(detectIntendedTool('First, verify the digest gates. Now verify the boot health directly.', 'write_file', offered)).toBe('verify');
  });
});
