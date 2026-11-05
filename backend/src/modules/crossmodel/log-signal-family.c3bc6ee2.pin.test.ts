/**
 * Characterization pins — log-signal family, lead ticket 18c277dc
 * (2026-10-31, lane c3bc6ee2). Five sweep auto-filings from ONE signal class
 * ("a warn line the hourly sweep fingerprints"), adjudicated PER MEMBER
 * against live app_error_logs rows rather than the ticket text. None is a
 * standalone framework defect of its own emit site: four are DESIGNED
 * observability and one (c18badad) is a SIBLING of the already-documented
 * efdb3d31 emission-side cut class — its ticket is a rename artifact, not a
 * separate fault and not a cure. This file pins them id by id so a future
 * pass cannot "fix" a working guard into silence, and so the sweep's re-filing
 * of the same fingerprint is answered by evidence instead of another rebuild.
 *
 *  18c277dc — `action-verifier: dropped <n> LLM-extracted args claim(s) with
 *             NO verbatim support in send_chat_message's args`. DESIGNED: the
 *             587e9d64 verbatim-grounding gate dropping a paraphrase-
 *             hallucinated ARGS claim BEFORE the tier chain can convict an
 *             honest note on it. The drop IS the anti-fabrication guard
 *             working; the warn is its designed visibility. Live 42 rows/24h
 *             (24h view 'errors', search "NO verbatim support in
 *             send_chat_message's args", asOf 2026-10-31T01:05:53Z), spread
 *             across many chats, ZERO error-level rows — a per-run
 *             recomputation from
 *             the same window the extractor saw, never a latched suppression
 *             state, so it cannot be "fixed" without relaxing a
 *             fabrication guard. Sibling of the already-pinned fc1fd22f
 *             (note surface) — same gate, other surface.
 *  c18badad — `tool-call stream [...]: finalize diagnosis no_complete_payload —
 *             finishreason=tool_calls …`. SIBLING of efdb3d31 (the
 *             emission-side cut class), NOT a distinct defect and NOT "cured".
 *             Two corrections a first pass of this file got WRONG, recorded so
 *             the next reader does not repeat them:
 *               (a) the fingerprint was not a read artifact. `normalizeLogMessage`
 *                   caps at FINGERPRINT_MAX_LEN = 120 (log-signal-sweep.service.ts),
 *                   and the ticket's own title ends `finishreason=tool_calls` —
 *                   the reason WAS inside the fingerprinted window. The 240-char
 *                   budget PR #2096 fixed is the TELEMETRY-META read surface,
 *                   a different budget from the sweep's fingerprint.
 *               (b) the class is still LIVE: `GATEWAY-OR-OURS … verdict=
 *                   no_complete_payload` reads 121 rows/24h. #2096 RENAMED the
 *                   emit line (so the ticket's literal, and its
 *                   app_error_log_count acceptance metric, now read 0 — that
 *                   zero is a rename, not a cure).
 *             What #2096 (commit 4b58a6f679, ancestor of main) genuinely fixed
 *             is real and worth pinning: finish_reason now rides INSIDE the
 *             2-char `gw` verdict, so a direct meta reader no longer loses it
 *             to the 240-char cut. The DIAGNOSIS itself is unchanged and
 *             correct — this pin asserts the live row still diagnoses
 *             `no_complete_payload` with the cut named, so a future pass cannot
 *             mistake the rename for a repair. The underlying cut is
 *             efdb3d31's documented residual (its close reads: emission-side
 *             bytes, not transport, and a sole cut is out of that fix's scope).
 *  fbd0fb6d — `coding agent [Digby]: lead seat llm-cql (custom endpoint)
 *             (llm-cql:…alibaba-deepseek-v4.1-flash) rejected the turn
 *             (HTTP 524) — this turn on …`. DESIGNED: leadSeatHttpFailure
 *             classifies 5xx as "provider says not now"; 524 is Cloudflare's
 *             ~100 s wall at the gateway, so the lead-seat fallback moves THIS
 *             TURN to another seat and the run survives. Live 64 rows/24h with
 *             ZERO error-level rows and one cooldown-breaker trip (the breaker
 *             is the bounded containment). Same adjudicated class as the
 *             already-pinned 1ece90ad/2737f88d/2c04a365 llm-cql gateway flaps —
 *             this pin adds the 524 status those left implicit.
 *  e6711caf — `Digby Web Search: DIRECT search_engine returned nothing after
 *             <n> ms (serp_json_no_organic) — trying the gateway`. DESIGNED:
 *             the sequential tier-failover path. An empty/organic-less SERP
 *             body (issue #85 keeps empty SERPs non-deterministic) falls
 *             through to the gateway, which answers. Live 20 rows/24h, never
 *             a retry storm (ONE POST, no retry — isRetryableBdError has no
 *             HTTP status to match on this shape). Sibling of the pinned
 *             cb0a7e52 (same emit line, `empty_body` class); this pin replays
 *             the `serp_json_no_organic` class the sweep actually filed.
 *  136d0a40 — `action-verifier: dropped <n> LLM-extracted note claim(s) whose
 *             id shape / verb does not fit their kind (audit 2026-10-08 W1-4)`.
 *             DESIGNED: the id-shape + verb-kind PRECISION gate. A `todo
 *             <id>` or `oq_<id>` read by the extractor as a "ticket" must
 *             never convict — a fabricated-id phantom still does, through the
 *             normal tier chain. Live 17 rows/24h, every row a claim whose
 *             detail carries no kind wording (the two live shapes are replayed
 *             verbatim below). Silencing it would widen the conviction path
 *             back onto mis-kinded ids.
 *
 * Style note: emit-line assertions read source text, the discipline every
 * prior log-signal pin uses (the warn vocabulary IS the contract the hourly
 * sweep reads, so a reworded warn or a dropped source stamp is a behaviour
 * change worth a red suite). Behavioural assertions drive the SHIPPED pure
 * helpers rather than a re-implementation, so a refactor that changes the
 * guard's decision breaks the suite instead of quietly re-documenting it.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: async () => [] },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), keys: jest.fn(async () => []) },
  redis: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), keys: jest.fn(async () => []) },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./platform/supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('./coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import * as fs from 'fs';
import * as path from 'path';

import { computePhantomClaims, gateLlmClaimShapes, groundExtractedClaims, ExtractedClaim } from './platform/action-verifier';
import { leadSeatHttpFailure } from './coding/helper-seat';
import { diagnoseToolCallFinalize } from './coding/tool-arguments';
import { FINALIZE_VERDICT_KEY, finalizeVerdictFields, finalizeVerdictSummary } from './coding/tool-call-finalize-meta';
import { FINGERPRINT_MAX_LEN, normalizeLogMessage } from './fleet/log-signal-sweep.service';
import { TELEMETRY_META_CHARS } from './fleet/fleet-telemetry';
import logger from '../../utils/logger';

const BACKEND_SRC = path.resolve(__dirname, '../..');
function read(rel: string): string {
  return fs.readFileSync(path.join(BACKEND_SRC, rel), 'utf8');
}

const CHAT = 'chat-c3bc6ee2-log-signal-lane';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
});

// ── 18c277dc ────────────────────────────────────────────────────────────────
describe('18c277dc — the args-surface verbatim-grounding drop is designed anti-fabrication visibility', () => {
  /**
   * The prod row: a run whose send_chat_message ARGS narrate one thing while
   * the utility extractor returns a paraphrased claim that appears NOWHERE in
   * those args. groundExtractedClaims must drop it — otherwise the tier chain
   * convicts the honest note on the extractor's invention (the 587e9d64
   * incident class).
   */
  it('REPLAYS the prod shape: an ungrounded ARGS claim is dropped before the tier chain, and the warn IS the fingerprint', async () => {
    const argsNarration = 'I dispatched the reviewer lane and it is still reading the diff.';
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      claims: [{ kind: 'ticket', detail: 'filed ticket 09a03aef and closed it done', id: '09a03aef' }],
    }) as never);

    const comp = await computePhantomClaims({
      chatId: CHAT,
      userId: 'u-1',
      // Sub-floor note: the NOTE lane is skipped, so the run isolates the ARGS
      // lane the fingerprint names.
      finalText: 'Working.',
      parts: [{ type: 'tool_call', name: 'send_chat_message', args: { message: argsNarration } }],
      receipts: [],
      runStartedAt: new Date(),
      machineTriggered: true,
    } as any);

    // (a) The invention never became a claim — no phantom conviction.
    expect(comp.phantoms).toEqual([]);

    // (b) The warn fired with the exact fingerprinted prefix, naming the TOOL
    // whose args were checked (the sweep normalizes this line), at the
    // action-verifier source the sweep keys on.
    const argsWarn = (logger.warn as unknown as jest.Mock).mock.calls
      .find((c: any[]) => String(c[0] ?? '').includes("NO verbatim support in send_chat_message's args"));
    expect(argsWarn).toBeDefined();
    expect(String(argsWarn![0])).toBe(
      "action-verifier: dropped 1 LLM-extracted args claim(s) with NO verbatim support in send_chat_message's args (ticket 587e9d64 grounding lane)",
    );
    expect(argsWarn![1]).toEqual(expect.objectContaining({ source: 'action-verifier', chatId: CHAT }));
  });

  it('the guard is precise: a VERBATIM args claim survives grounding (the drop is never a blanket mute)', () => {
    const source = 'I dispatched the reviewer lane and it is still reading the diff.';
    const verbatim: ExtractedClaim = { kind: 'dispatch', detail: 'dispatched the reviewer lane', id: '' };
    const invented: ExtractedClaim = { kind: 'ticket', detail: 'filed ticket 09a03aef closed done', id: '09a03aef' };
    const out = groundExtractedClaims([verbatim, invented], source);
    expect(out.grounded.map((c) => c.detail)).toEqual(['dispatched the reviewer lane']);
    expect(out.dropped.map((c) => c.detail)).toEqual(['filed ticket 09a03aef closed done']);
  });

  it('the warn stays WARN level and keeps the fingerprint literal — the sweep reads warn+error only', () => {
    const src = read('modules/crossmodel/platform/action-verifier.ts');
    expect(src).toContain('NO verbatim support in ${blob.tool}\'s args (ticket 587e9d64 grounding lane)');
    expect(src).toContain("source: 'action-verifier'");
    // Grounded against the SAME window the extractor saw — parity is the point.
    expect(src).toContain('groundExtractedClaims(found, blob.text.slice(0, NOTE_SLICE))');
  });
});

// ── c18badad ────────────────────────────────────────────────────────────────
describe('c18badad — the finalize verdict carries finish_reason inside the short key (renamed by PR #2096)', () => {
  /** The live row this ticket fingerprinted: recv==acc, drop=0, buf=0, fr=tool_calls. */
  const liveRow = {
    receivedBytes: 67, accumulatedBytes: 67, droppedBytes: 0,
    fragments: 10, undrainedBufferBytes: 0, finishReason: 'tool_calls',
  };

  it('the 2-char verdict renders fr= and sc= — the two fields the old long tail lost to the read cut', () => {
    const summary = finalizeVerdictSummary({ ...liveRow, streamCompleted: true });
    expect(summary).toBe('gateway recv=67 acc=67 drop=0 frag=10 buf=0 fr=tool_calls sc=1');
    // An ABSENT reason is itself a discriminator value — never omitted.
    expect(finalizeVerdictSummary({ ...liveRow, finishReason: null, streamCompleted: undefined }))
      .toContain('fr=null sc=?');
  });

  it('the verdict rides the 2-char key, so jsonb emits it before every longer key the stamp merge adds', () => {
    expect(FINALIZE_VERDICT_KEY).toBe('gw');
    const fields = finalizeVerdictFields({ ...liveRow, streamCompleted: true });
    expect(fields[FINALIZE_VERDICT_KEY]).toContain('fr=tool_calls');
    expect(fields.culprit).toBe('gateway');
    // The long keys stay for a direct JSON-path reader and must agree.
    expect(fields.finishReason).toBe('tool_calls');
    expect(fields.streamCompleted).toBe(true);
  });

  it('the same live row still diagnoses as no_complete_payload — the CULPRIT naming was never the bug', () => {
    const diag = diagnoseToolCallFinalize(
      { 0: { id: 'c1', name: 'goal_update', args: '{"goalId": "8f0dcd6f", "progressNote": ' } } as any,
      'tool_calls',
    );
    expect(diag.verdict).toBe('no_complete_payload');
    expect(diag.slots).toBe(1);
    expect(diag.named).toBe(1);
    expect(diag.unnamed).toBe(0);
    expect(diag.broken).toHaveLength(1);
    expect(diag.broken[0]).toMatchObject({ name: 'goal_update', len: 39 });
  });

  it('the OLD wording cannot come back — and the rename is asserted as a rename, not a cure', () => {
    // PR #2096 (commit 4b58a6f679) reworded the emit line. That rename is why
    // THIS ticket's literal (and its app_error_log_count acceptance metric)
    // reads 0 today — the class itself is still live at 121 rows/24h under the
    // new wording. Pinning the rename stops a future pass from reading that
    // zero as "fixed".
    const src = read('modules/crossmodel/coding/coding-model.ts');
    expect(src).not.toContain('finalize diagnosis');
    expect(src).toContain('GATEWAY-OR-OURS ${finalizeVerdictSummary');
    expect(src).toContain("source: 'run-model-turn'");
  });

  it('the sweep fingerprints at 120 chars, NOT the 240-char telemetry-meta budget — the two surfaces differ', () => {
    // This is the fact the first pass of this file got wrong. Asserted
    // BEHAVIOURALLY against the shipped normalizer, not by grepping the file:
    // the old database emit line normalizes to a fingerprint that still CARRIES
    // `finishreason=`, and the capped fingerprint stops at 120 chars.
    const oldRow = 'tool-call stream [api-optimize-xiaomi-mimo-v2.6-pro]: finalize diagnosis no_complete_payload — finishReason=tool_calls slots=1 named=1 unnamed=0 broken=0:goal_update:len67:Unexpected end of JSON input discardedComplete=[] claims=none GATEWAY-OR-OURS receivedBytes=67 accumulatedBytes=67 droppedBytes=0 fragments=10 undrainedBufferBytes=0 ⇒ GATEWAY (sent it short)';
    const fp = normalizeLogMessage(oldRow);
    expect(fp.length).toBe(FINGERPRINT_MAX_LEN);
    expect(FINGERPRINT_MAX_LEN).toBe(120);
    expect(FINGERPRINT_MAX_LEN).not.toBe(TELEMETRY_META_CHARS);
    // The discriminator field IS inside the fingerprinted window — which is why
    // this ticket's own title ends `finishreason=tool_calls`. A cut that removed
    // it could not also have printed it.
    expect(fp).toContain('finishreason=');
    expect(fp).toContain('no_complete_payload');
    // The 240-char budget #2096 addressed is a DIFFERENT surface.
    expect(fp.length).toBeLessThan(TELEMETRY_META_CHARS);
  });
});

// ── fbd0fb6d ────────────────────────────────────────────────────────────────
describe('fbd0fb6d — a lead seat HTTP 524 is a provider "not now", and the turn moves on (designed resilience)', () => {
  it('524 is classified as a rejection (>=500), like the already-pinned 502/503/504', () => {
    expect(leadSeatHttpFailure({ errorStatus: 524 })).toBe('HTTP 524');
    expect(leadSeatHttpFailure({ errorStatus: 502 })).toBe('HTTP 502');
    expect(leadSeatHttpFailure({ errorStatus: 503 })).toBe('HTTP 503');
    expect(leadSeatHttpFailure({ errorStatus: 504 })).toBe('HTTP 504');
  });

  it('a 4xx client error is NOT swallowed by the seat fallback (each keeps its own lane)', () => {
    expect(leadSeatHttpFailure({ errorStatus: 400 })).toBeNull();
    expect(leadSeatHttpFailure({ errorStatus: 401 })).toBeNull();
    expect(leadSeatHttpFailure({ errorStatus: 403 })).toBeNull();
  });

  it('the emit line preserves the fingerprint vocabulary the sweep files', () => {
    const src = read('modules/crossmodel/coding/agent.ts');
    expect(src).toContain('rejected the turn (${leadHttp})');
    expect(src).toContain('— ${sticky ? \'rest of this run\' : \'this turn\'} on ${fb.model}');
  });

  it('the rejection ALSO advances the bounded cooldown breaker — the containment that keeps the class from storming', () => {
    const src = read('modules/crossmodel/coding/agent.ts');
    expect(src).toContain('tripped the cooldown breaker (${trip.strikes} rejections in');
    expect(src).toContain('noteProviderRejection(provider.label)');
  });
});

// ── e6711caf ────────────────────────────────────────────────────────────────
describe('e6711caf — the DIRECT search_engine organic-less miss falls through to the gateway (designed failover)', () => {
  const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  const mockTryDirect = jest.fn();
  const mockDirectAvailable = jest.fn(() => true);
  const mockMetric = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    mockTryDirect.mockReset();
    mockDirectAvailable.mockReturnValue(true);
    mockMetric.mockReset();
    delete process.env.MCP_DIGBY_TOKEN;
    delete process.env.WEB_HEDGE_DISABLED;
    delete process.env.WEB_HEDGE_MS;
    delete process.env.WEB_DIRECT_ADAPTIVE_MISS_RATE;
    delete process.env.WEB_DIRECT_ADAPTIVE_MIN_SAMPLES;
    delete process.env.WEB_DIRECT_ADAPTIVE_WINDOW;
    delete process.env.WEB_DIRECT_ADAPTIVE_HEDGE_MS;
  });

  function load() {
    jest.doMock('./brightdata-direct', () => ({
      ...jest.requireActual('./brightdata-direct'),
      tryDirectBrightData: (...a: any[]) => mockTryDirect(...a),
      directBrightDataAvailable: () => mockDirectAvailable(),
    }));
    jest.doMock('./platform/loop-metrics.service', () => ({
      __esModule: true,
      recordLoopMetric: (...a: any[]) => mockMetric(...a),
      LOOP_METRIC_KINDS: { WEB_FETCH_PATH: 'web_fetch_path' },
    }));
    jest.doMock('./pdf-extract', () => ({ __esModule: true, extractPdfText: jest.fn() }));
    return require('./mcp-search');
  }

  it('REPLAYS the prod row: the serp_json_no_organic class emits the exact "trying the gateway" warn at warn level', async () => {
    mockTryDirect.mockImplementation((_t: string, _a: any, _ms: any, opts: any) => {
      opts?.onMiss?.({ class: 'serp_json_no_organic' });
      return Promise.resolve(null);
    });
    const { callMcpTool } = load();
    // MCP_DIGBY_TOKEN unset → the gateway tier bails at once; the miss warn
    // still fires BEFORE it — the designed sequential order.
    expect(await callMcpTool('search_engine', { query: 'q' })).toBeNull();
    const lw = require('../../utils/logger').default;
    expect(lw.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Digby Web Search: DIRECT search_engine returned nothing after \d+ ms \(serp_json_no_organic\) — trying the gateway$/),
      expect.objectContaining({ source: 'web-search', tool: 'search_engine' }),
    );
    await flush();
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'web_fetch_path',
      meta: expect.objectContaining({ tool: 'search_engine', winner: 'none', directOutcome: 'empty', directClass: 'serp_json_no_organic' }),
    }));
  });

  it('a hedged miss is INFO, not warn — only the sequential miss costs the user the round trip', () => {
    const src = read('modules/crossmodel/mcp-search.ts');
    expect(src).toContain('if (hedged) logger.info(missLine); else logger.warn(missLine, { source: \'web-search\', tool: toolName });');
  });

  it('the organic-less SERP shape is DETERMINISTIC — one POST, never a retry storm', () => {
    const direct = jest.requireActual('./brightdata-direct');
    expect(direct.classifySerpBody('{"general":{"query":"q"},"results":[]}')).toBe('json_no_organic');
    expect(direct.classifyDirectMiss(new direct.DirectSerpShapeError('json_no_organic')))
      .toEqual({ class: 'serp_json_no_organic', detail: 'json_no_organic' });
  });
});

// ── 136d0a40 ────────────────────────────────────────────────────────────────
describe('136d0a40 — the W1-4 id-shape / verb-kind gate is precision, not a mute', () => {
  it('REPLAYS both live prod shapes: a mis-kinded id is dropped with the kind_verb reason', () => {
    // Row 1 (2026-10-30T21:08:15Z): an `oq_` id read as a "ticket".
    // Row 2 (2026-10-30T22:20:48Z): a `todo` id read as a "ticket".
    const out = gateLlmClaimShapes([
      { kind: 'ticket', detail: 'Dismiss the re-seat card', id: 'oq_7aa1ae56' },
      { kind: 'ticket', detail: 'todo 5d794fd4 - positive-count assertion at both conveyor call sites, WORKED=M and SKIPPED=0', id: '5d794fd4' },
    ]);
    expect(out.kept).toEqual([]);
    expect(out.dropped.map((d) => d.reason)).toEqual(['kind_verb', 'kind_verb']);
  });

  it('a REAL ticket claim worded as one still passes — the gate never suppresses a true conviction', () => {
    const out = gateLlmClaimShapes([
      { kind: 'ticket', detail: 'filed ticket 09a03aef for the truncation class', id: '09a03aef' },
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toEqual([]);
  });

  it('a git sha read as a ticket is dropped by the SHAPE arm when the detail carries git vocabulary', () => {
    const out = gateLlmClaimShapes([
      { kind: 'ticket', detail: 'pushed commit 4b58a6f679 to main', id: '4b58a6f679' },
    ]);
    expect(out.dropped.map((d) => d.reason)).toEqual(['git_sha_shape']);
  });

  it('a sha-shaped id WORDED as its kind with NO git vocabulary is KEPT — it may be a miscopied 8-hex prefix', () => {
    // The documented precision rule (action-verifier.ts GIT_CONTEXT_RE block):
    // a 7/9–40-char contiguous hex id is only read as a sha if the prose uses
    // git vocabulary OR the claim is not worded as its kind. A 7-char id in
    // kind wording ("59a407b" for 59a4407b) stays HERE rather than being
    // silently dropped by the shape arm — and the MISC COPY TIER then recovers
    // it, which is why keeping it is the correct direction: the guard defers to
    // a more precise lane instead of discarding evidence.
    // (A correction-of-a-correction, recorded deliberately: an intermediate
    // revision of this comment claimed stampMiscopiedIds skips short cited ids.
    // It does not — the `actual.length < 8` gate in action-verifier.ts is on
    // the ENVELOPE id, not the cited id, and a short citation is compared
    // against a length-matched prefix window. The repo's own green test proves
    // it: action-verifier.miscopied-id.7ea4819b.test.ts feeds the 7-char
    // '59a407b' and asserts miscopiedFrom = the real id.)
    const out = gateLlmClaimShapes([
      { kind: 'ticket', detail: 'filed ticket 59a407b for the truncation class', id: '59a407b' },
    ]);
    expect(out.dropped).toEqual([]);
    expect(out.kept).toHaveLength(1);
  });

  it('the kept 7-char id is then recovered by the miscopy tier — the precision chain, not a dead end', () => {
    // Pins the collaboration between the two gates so neither is "fixed" in a
    // way that strands the shape: the shape gate keeps it, the miscopy tier
    // stamps the real envelope id it corrupted.
    const src = read('modules/crossmodel/platform/action-verifier.ts');
    // The length gate is on the ENVELOPE id (`actual`), not the cited id.
    expect(src).toContain('if (actual.length < 8) continue;');
    // A short citation is compared against a length-matched prefix window
    // spanning cited.length −1/0/+1 (reviewer Finding A, ticket 7ea4819b).
    expect(src).toContain('actual.slice(0, cited.length + d)');
    expect(src).toContain('.filter((cand) => cand.length >= 8)');
  });

  it('the emit site stays warn, keeps the W1-4 fingerprint literal, and telemeters the drop', () => {
    const src = read('modules/crossmodel/platform/action-verifier.ts');
    expect(src).toContain('whose id shape / verb does not fit their kind (audit 2026-10-08 W1-4)');
    expect(src).toContain("kind: 'action_verifier_claim_shape_drop'");
    expect(src).toContain('recordClaimShapeDrops(chatId, \'note\', noteShape.dropped)');
    expect(src).toContain('recordClaimShapeDrops(chatId, \'args\', argsShape.dropped)');
  });
});