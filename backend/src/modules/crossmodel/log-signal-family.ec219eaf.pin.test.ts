/**
 * Characterization pins — log-signal family, lead ticket ec219eaf
 * (2026-11-03, lane ec219eaf). NINE sweep auto-filings from ONE signal class
 * ("a warn line the hourly sweep fingerprints"), adjudicated PER MEMBER against
 * the emitting source text rather than the ticket prose.
 *
 * EIGHT of the nine are NOT framework defects at all: each is designed
 * resilience at an emit site — a bounded retry, a breaker, a fallback tier, a
 * seat failover, a dedupe — where the warning IS the visibility record for a
 * condition the platform deliberately absorbs. They are pinned id by id so a
 * future pass cannot "fix" a working guard into silence, and so the sweep's
 * re-filing of the same fingerprint is answered by evidence rather than by
 * another rebuild.
 *
 * The NINTH (6384c6a7) IS a real framework defect — but in the SWEEP, not in
 * the emit site, and it is FIXED by this lane (see that block for the replay).
 *
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED, common to all nine: the sweep's
 * dedupe is a WEEK-key + a stable title, so a designed class that legitimately
 * keeps emitting is bumped again in a later week by design. A pin's job is to
 * make the next filing argue with the emit site, not with the ticket count.
 *
 * Style note: the emit-line assertions read SOURCE TEXT (the same discipline as
 * log-signal-family.4c691bfe / .30dfad06 / .c3bc6ee2 pins) — the warn
 * vocabulary IS the contract the hourly sweep reads, so a reworded warn or a
 * dropped source stamp is a behaviour change worth a red suite. Behavioural
 * assertions drive the SHIPPED pure helpers (never a re-implementation), so a
 * refactor that changes a guard's decision breaks the suite instead of quietly
 * re-documenting it.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: { findMany: jest.fn(async () => []) },
    userFeatureRequest: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'x' })), update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
    crossModelChat: { findMany: jest.fn(async () => []) },
    loopMetric: { findMany: jest.fn(async () => []) },
    pendingConfirmation: { findMany: jest.fn(async () => []) },
    systemSetting: { findUnique: jest.fn(async () => null) },
  },
}));

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => 'OK'),
    incr: jest.fn(async () => 1),
    decr: jest.fn(async () => 0),
    expire: jest.fn(async () => 1),
    del: jest.fn(async () => 1),
    keys: jest.fn(async () => []),
  },
}));

jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { LOG_SIGNAL_SWEEP: 'log_signal_sweep', INFRA_ALERT: 'infra_alert' },
}));

import * as fs from 'fs';
import * as path from 'path';

import { detectSuppressionPromise, logSignalQuietTarget, normalizeLogMessage, parsePromisedWindowMs } from './fleet/log-signal-sweep.service';
import { designedAlarmOfFingerprint } from './feedback/acceptance-metric-defaults';

const BACKEND_SRC = path.resolve(__dirname, '../..');
function read(rel: string): string {
  return fs.readFileSync(path.join(BACKEND_SRC, rel), 'utf8');
}

// ── 73fc96b4 ────────────────────────────────────────────────────────────────
/**
 * 73fc96b4 — `BrightData direct: transient 502 (attempt 1/3) — retrying in
 * <n>ms`. ADJUDICATED DESIGNED OBSERVABILITY: the line is the vendor-transient
 * lane announcing its OWN BOUNDED retry — BD_MAX_ATTEMPTS (3) then
 * `throw err` / return null and the gateway tier answers. It is a progress
 * record, not a fault: scripts/framework-audit ranks this shape
 * 'vendor_transient' at failed_runs=0 (the f170 pin), because none of the
 * emitted attempts ends a run.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: the direct tier meets real vendor
 * 5xx/429 transients continuously across a fleet; each one (correctly) prints
 * its attempt line, so the class re-appears in every sweep window forever.
 */
describe('73fc96b4 — BrightData direct transient retry is BOUNDED, designed observability', () => {
  const src = read('modules/crossmodel/brightdata-direct.ts');

  it('the retry warn names the attempt out of a bounded maximum', () => {
    expect(src).toContain('BrightData direct: transient ');
    expect(src).toContain('(attempt ${attempt}/${BD_MAX_ATTEMPTS}) — retrying in ${backoff}ms');
    expect(src).toContain("source: 'brightdata-direct'");
  });

  it('the attempt ceiling is a real constant (3), so a storm cannot be unbounded', () => {
    expect(src).toContain('BD_MAX_ATTEMPTS = 3');
    const m = src.match(/BD_MAX_ATTEMPTS\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(1);
    expect(Number(m![1])).toBeLessThanOrEqual(5);
  });

  it('the loop throws rather than retrying forever (ceiling + overall deadline)', () => {
    expect(src).toContain('if (attempt >= BD_MAX_ATTEMPTS || !isRetryableBdError(err)) throw err;');
    expect(src).toContain('if (Date.now() + backoff >= deadline) throw err;');
  });
});

// ── 58bad98e ────────────────────────────────────────────────────────────────
/**
 * 58bad98e — `unified-memory: semantic leg failed (keyword leg still runs):
 * <cause>`. ADJUDICATED DESIGNED GRACEFUL DEGRADATION: memSearch's embed leg is
 * an OPTIMISATION over the keyword (FTS) leg; the catch sets
 * `timing.embedFailed` and falls THROUGH to the keyword leg, so the search
 * still answers. Silencing it would remove the only per-search record that
 * recall has silently dropped to keyword-only.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: an embed vendor blip degrades many
 * searches across many boxes in the same hours; the class is a vendor-health
 * observation whose volume tracks vendor health, not our code.
 */
describe('58bad98e — the memory semantic leg fails OPEN to the keyword leg (designed)', () => {
  const src = read('modules/crossmodel/memory/unified-memory.service.ts');

  it('the emit site names both the failure and the surviving leg', () => {
    expect(src).toContain('unified-memory: semantic leg failed (keyword leg still runs)');
  });

  it('the catch only stamps embedFailed and continues — it never rethrows', () => {
    const at = src.indexOf('unified-memory: semantic leg failed (keyword leg still runs)');
    expect(at).toBeGreaterThan(0);
    // The catch body ends in the warn; the keyword leg below it still runs.
    const after = src.slice(at, at + 200);
    expect(after).not.toMatch(/throw\s/);
    expect(src).toContain('let ftsRows: any[] = [];');
  });
});

// ── 6e5ea738 ────────────────────────────────────────────────────────────────
/**
 * 6e5ea738 — the SAME semantic-leg class as 58bad98e, filed as its own
 * fingerprint (the cause text varied). ADJUDICATED DESIGNED, and its blast
 * radius is BOUNDED by the embed circuit breaker: after
 * EMBED_BREAKER_THRESHOLD (8) consecutive embed failures the breaker OPENS for
 * EMBED_BREAKER_COOLDOWN_MS, so memSearch skips the doomed HTTP call outright
 * and the keyword leg answers immediately (one loop_metrics transition row per
 * open/reopen/close instead of a per-search warn).
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: the breaker is PROCESS-LOCAL and
 * fail-open — a fresh box or a redeploy starts closed, and a vendor outage
 * longer than the cooldown legitimately re-opens it; each open is the breaker
 * working, not a regression.
 */
describe('6e5ea738 — the embed circuit breaker BOUNDS the semantic-leg degradation', () => {
  const src = read('modules/crossmodel/memory/unified-memory.service.ts');

  it('the breaker threshold and cooldown are real constants', () => {
    expect(src).toContain('EMBED_BREAKER_THRESHOLD');
    expect(src).toContain('const EMBED_BREAKER_THRESHOLD = 8;');
    expect(src).toContain('EMBED_BREAKER_COOLDOWN_MS');
  });

  it('an OPEN breaker skips the call instead of warning per search', () => {
    expect(src).toContain('if (embedBreakerIsOpen()) {');
    expect(src).toContain("timing.embedBreaker = 'open';");
    // ...and the transition is telemetered once, not per search.
    expect(src).toContain('UNIFIED_MEMORY_EMBED_BREAKER');
  });

  it('the breaker is restorable from box env without a deploy (kill switch)', () => {
    expect(src).toContain("process.env.UNIFIED_MEMORY_EMBED_BREAKER_DISABLED === '1'");
  });
});

// ── 889e7bd4 ────────────────────────────────────────────────────────────────
/**
 * 889e7bd4 — `coding agent turn failed: <err.message> (HTTP <n>)`. ADJUDICATED
 * DESIGNED / REAL-BUT-DIAGNOSABLE: a provider turn failure inside the coding
 * loop. It keeps its HTTP status and a bounded provider body, so it is a
 * genuine load/provider error rather than a statusless transport abort — the
 * loop's own lanes (backoff, seat failover, history repair) respond, and this
 * warn is the only per-turn record of WHY a turn did not complete.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: on a fleet running continuous coding
 * sessions, a percentage of provider turns fail every hour; the volume tracks
 * upstream health and cannot be reduced without silencing real failures
 * (the a6d1576d pin already settled that this line must keep its status).
 */
describe('889e7bd4 — coding agent turn failed keeps its status and body (real, diagnosable)', () => {
  const src = read('modules/crossmodel/coding/agent.ts');

  it('the emit line carries the message, the HTTP status and a bounded body', () => {
    expect(src).toContain('coding agent turn failed: ${err.message}');
    expect(src).toContain("${status ? ` (HTTP ${status})` : ''}");
    expect(src).toContain('body: ${bodyText.slice(0, 400)}');
  });

  it('it routes through agentWarn so the row carries session/run/source', () => {
    const at = src.indexOf('coding agent turn failed: ${err.message}');
    expect(at).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, at - 80), at);
    expect(before).toContain('agentWarn(`');
  });
});

// ── 8d10c799 ────────────────────────────────────────────────────────────────
/**
 * 8d10c799 — `Digby Web Search: DIRECT <tool> returned nothing after <n> ms
 * (<class>) — trying the gateway`. ADJUDICATED DESIGNED: this is the
 * sequential TIER-FAILOVER announcement. The direct BrightData tier returned an
 * empty/organic-less body, so the call falls through to the gateway tier, which
 * answers. It is the tier boundary being visible, not a failed request.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: a non-deterministic empty SERP body
 * (issue #85) is a property of the vendor's search supply; every such miss is a
 * correct fallover, so the line recurs on every window with real search volume.
 */
describe('8d10c799 — the DIRECT search miss announces its own fallback to the gateway', () => {
  const src = read('modules/crossmodel/mcp-search.ts');

  it('the miss line names the empty DIRECT tier and the gateway handoff', () => {
    expect(src).toContain('returned nothing after');
    expect(src).toContain('trying the gateway');
    expect(src).toContain("source: 'web-search'");
  });

  it('the handoff RETURNS the gateway leg — the request is served, not dropped', () => {
    const at = src.indexOf('returned nothing after');
    expect(at).toBeGreaterThan(0);
    const after = src.slice(at, at + 700);
    expect(after).toContain('return gateway().then((v) => {');
  });
});

// ── e0868c1c ────────────────────────────────────────────────────────────────
/**
 * e0868c1c — `coding agent [<label>]: lead seat <label> (<spec>) rejected the
 * turn (<HTTP <n>>) — this turn on <fallback>`. ADJUDICATED DESIGNED RESILIENCE:
 * leadSeatHttpFailure classifies 429/5xx (and the billing class, stickily) as
 * "provider says not now"; the run rebinds to the fallback seat and RETRIES THE
 * SAME STEP (`continue;`), so the turn survives. The warn is the never-a-silent-
 * swap contract (fe6f0b0b) — exactly one transcript note per run plus the warn.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: the llm-cql gateway flaps (524/502
 * classes already pinned at 1ece90ad / 2737f88d / 2c04a365 / fbd0fb6d); every
 * flap costs one seat failover and prints one line. The failover IS the fix.
 */
describe('e0868c1c — a lead-seat rejection moves THIS TURN to the fallback seat and retries', () => {
  const src = read('modules/crossmodel/coding/agent.ts');

  it('the emit line names the rejected seat, the status, and the seat that answers', () => {
    expect(src).toContain('rejected the turn (${leadHttp})');
    expect(src).toContain("— ${sticky ? 'rest of this run' : 'this turn'} on ${fb.model}");
  });

  it('the failover CONTINUES the loop on the fallback seat (same request, not a dead turn)', () => {
    // ORDER, not proximity: the retry must come AFTER the reject warn and inside
    // the same failover branch (the progress emit + noteSeatFallback sit between
    // them, so a fixed character window would pin the prose, not the behaviour).
    const at = src.indexOf('rejected the turn (${leadHttp})');
    expect(at).toBeGreaterThan(0);
    const cont = src.indexOf('continue; // retry this step on the fallback seat — same request');
    const grant = src.indexOf('grantRetryStep();');
    expect(cont).toBeGreaterThan(at);
    expect(grant).toBeGreaterThan(at);
    expect(cont - at).toBeLessThan(4000); // same branch, not a later unrelated loop
  });
});

// ── 2182bf27 ────────────────────────────────────────────────────────────────
/**
 * 2182bf27 — `tool-call stream [<model>]: GATEWAY-OR-OURS … verdict=<v>
 * receivedBytes=… accumulatedBytes=… droppedBytes=…`. ADJUDICATED DESIGNED
 * INSTRUMENT (already formalised as a designed alarm by ticket 1425001e): the
 * line states its OWN drop arithmetic about a condition coding-model.ts does
 * not own — an upstream gateway severing a tool-call stream. It fires whenever
 * the gateway ends a turn short, fix or no fix, which is why the autofiler
 * attaches NO volume acceptance metric to it (designedAlarmOfFingerprint) and
 * flags the row instead.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: the instrument's volume measures
 * UPSTREAM severance frequency, not our code; it cannot fall to zero while the
 * gateway keeps (occasionally) cutting streams — and a zero would mean the
 * instrument died, not that the class was fixed.
 */
describe('2182bf27 — the GATEWAY-OR-OURS finalize line is an INSTRUMENT, not a fault report', () => {
  const src = read('modules/crossmodel/coding/coding-model.ts');

  it('the emit line leads with the verdict and its own byte arithmetic', () => {
    expect(src).toContain('tool-call stream [${provider.model}]: GATEWAY-OR-OURS ');
    expect(src).toContain('${finalizeVerdictSummary(verdictInput)} verdict=${diag.verdict}');
    expect(src).toContain('droppedBytes=${droppedBytes}');
    expect(src).toContain("source: 'run-model-turn'");
  });

  it('the sweep recognises it as a DESIGNED ALARM (so no volume bar is attached)', () => {
    const fp = normalizeLogMessage(
      'tool-call stream [api-optimize-zai-glm-5.3]: GATEWAY-OR-OURS gw=no_complete_payload/finish=tool_calls/claims=2/drop=1810 verdict=no_complete_payload — receivedBytes=1810 accumulatedBytes=0 droppedBytes=1810 fragments=3 undrainedBufferBytes=0 finishReason=tool_calls slots=3 named=2 unnamed=1 broken=none discardedComplete=[] claims=1->[2]',
    );
    expect(designedAlarmOfFingerprint(fp)?.id).toBe('gateway-or-ours');
  });
});

// ── b73049c7 ────────────────────────────────────────────────────────────────
/**
 * b73049c7 — `BrightData direct: <tool> failed: <status> <message> — body:
 * <500 chars>`. ADJUDICATED DESIGNED FAILOVER RECORD: a RAW (non-retryable)
 * direct-tier error. isRetryableBdError deliberately refuses to retry a
 * deterministic shape — notably ECONNABORTED, OUR OWN timeoutMs firing (the
 * target was slow; retrying would triple worst-case latency) — so the line is
 * emitted once and tryDirectBrightData returns null into the gateway tier.
 * The 500-char body is what makes a 403/token/zone outage diagnosable at all.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: a revoked token, a disabled zone or a
 * slow target recurs per request until the OWNER fixes it; the line is the only
 * per-request evidence, and the class cannot be silenced without going blind on
 * the direct tier's health (the 30dfad06 pin's sibling argument).
 */
describe('b73049c7 — a raw direct-tier failure is one bounded record, then the gateway answers', () => {
  const src = read('modules/crossmodel/brightdata-direct.ts');

  it('the emit line carries status, message and a BOUNDED body', () => {
    expect(src).toContain('BrightData direct: ${toolName} failed:');
    expect(src).toContain('${body ? ` — body: ${body}` : \'\'}');
    expect(src).toContain('.slice(0, 500)');
  });

  it('ECONNABORTED is a NON-retry rule inside isRetryableBdError (our timeout, not a transient)', () => {
    const fnAt = src.indexOf('function isRetryableBdError');
    expect(fnAt).toBeGreaterThan(0);
    const body = src.slice(fnAt, fnAt + 400);
    expect(body).toContain("if (err?.code === 'ECONNABORTED') return false;");
    expect(body).toContain('return RETRYABLE_STATUS.has(status);');
  });

  it('the failure returns null into the gateway tier — it never throws to the caller', () => {
    const at = src.indexOf('BrightData direct: ${toolName} failed:');
    expect(at).toBeGreaterThan(0);
    const after = src.slice(at, at + 400);
    expect(after).toContain('return null;');
  });
});

// ── 6384c6a7 ────────────────────────────────────────────────────────────────
/**
 * 6384c6a7 — `unified-memory: embed failed, <n>/<d> row(s) stored keyword-only
 * — timeout (embed attempt timeout after 8000ms …); rows=<n> maxChars=… … ;
 * per-row retry not attempted (logged once per cause per process; counted as
 * unified_memory_embed_failed)`. THE ONE REAL DEFECT IN THIS BATCH, and it was
 * in the SWEEP, not the emit site.
 *
 * ADJUDICATION.SPLIT — the EMIT SITE is correct (and already pinned at
 * 4c691bfe/ca062c3f): the store DEGRADES to keyword-only instead of failing the
 * request, and `embedFailureNoticed` (a Set keyed by embedFailureKey) really
 * does suppress repeats per cause per PROCESS. The sweep's claim — "RULE 2 —
 * broken suppression promise: the message promises 'once per' for 0 min yet 34
 * occurrences landed as close as 0 min apart" — was FALSE: `parsePromisedWindowMs`
 * took the LARGEST duration ANYWHERE in the message, and the only duration here
 * is the embed CLIENT's 8000 ms TIMEOUT BUDGET, ~120 chars away in a different
 * clause. The promise in that line is `once per cause per PROCESS` — a
 * SCOPE-qualified promise, honoured by construction across processes, which a
 * fleet-wide 24 h count can never falsify.
 *
 * THE FIX (this lane, both in fleet/log-signal-sweep.service.ts): (1) a duration
 * counts as a promised window only inside the PROMISE TOKEN's own clause
 * (±PROMISE_ADJACENCY_CHARS, cut at ; ( ) [ ] — – newline); (2) a promise
 * qualified `per process|worker|instance|boot|container|pod` is not a TIME
 * promise at all, so detectSuppressionPromise returns null and rule 1's
 * cross-hour recurrence is the honest signal for that class.
 * WHY RECURRENCE AFTER CLOSE IS EXPECTED: the emit site is unchanged and must
 * keep warning once per cause per process — a 24 h window spanning several
 * boxes and deploys will always show one row per process instance.
 */
describe('6384c6a7 — the embed line\'s promise is process-scoped, and the sweep now says so', () => {
  const src = read('modules/crossmodel/memory/unified-memory.service.ts');

  /** The production app_error_logs row, verbatim from ticket 6384c6a7. */
  const PROD_6384c6a7 =
    'unified-memory: embed failed, 10/10 row(s) stored keyword-only — timeout (embed attempt timeout after 8000ms (batch 1/1, 2 attempt(s))); rows=10 maxChars=3500 source=orchestrator scope=session; per-row retry not attempted (logged once per cause per process; counted as unified_memory_embed_failed)';

  it('the emit site DEGRADES and states its own scope in the log line', () => {
    expect(src).toContain('row(s) stored keyword-only');
    expect(src).toContain('logged once per cause per process');
    expect(src).toContain('embedFailureNoticed');
  });

  it('the once-per-cause-per-PROCESS dedupe is real (a Set keyed by the cause)', () => {
    expect(src).toContain('const embedFailureNoticed = new Set<string>();');
    expect(src).toContain('const key = embedFailureKey(cause);');
    expect(src).toContain('if (!embedFailureNoticed.has(key)) {');
    // ...and the repeat is downgraded to debug, never warn.
    expect(src).toContain('} else {\n    logger.debug(line);');
  });

  it('THE FIX: the sweep no longer harvests the 8000ms embed timeout as a promised window', () => {
    expect(parsePromisedWindowMs(PROD_6384c6a7)).toBeNull();
  });

  it('THE FIX: the scope-qualified promise is rejected outright (rule 1 still covers the class)', () => {
    expect(detectSuppressionPromise(PROD_6384c6a7)).toBeNull();
    // A parsed window would have dropped the quiet target to 1 (rule 2 at 2
    // repeats); with the promise nulled it is the plain rule-1 floor minus one
    // and the unparsed/rule-1 legs decide — detection is not weakened.
    expect(logSignalQuietTarget({ exampleMessage: PROD_6384c6a7 })).toBe(2);
  });

  it('the fingerprint the sweep files still binds to this emit site', () => {
    // NOTE: normalizeLogMessage caps at FINGERPRINT_MAX_LEN (120), so only the
    // HEAD of the line can be asserted here — the scope clause sits past the cap.
    const fp = normalizeLogMessage(PROD_6384c6a7);
    expect(fp).toContain('unified-memory: embed failed');
    expect(fp).toContain('<n>/<n> row(s) stored keyword-only');
    expect(fp.length).toBeLessThanOrEqual(120);
  });

  it('a SUBJECT-scoped promise is NOT nulled by this fix (it keeps the 3-repeat branch)', () => {
    // Deliberately narrow: per session/chat/subject/browser/key are legitimate
    // once-per-subject dedupes, not process scopes.
    for (const scope of ['session', 'chat', 'subject', 'browser', 'key']) {
      expect(detectSuppressionPromise(`once per ${scope} alert`)).not.toBeNull();
    }
  });
});