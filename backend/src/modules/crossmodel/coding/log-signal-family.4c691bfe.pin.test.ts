/**
 * Characterization pins — log-signal family, lead ticket 4c691bfe
 * (2026-10-29, lane 08dcbbae). Five members of this eight-member batch are
 * NOT framework defects: each is either designed resilience at an emit site, a
 * vendor-side class the loop is built to absorb, or a defect an earlier PR
 * already fixed. This file pins them id by id so a future pass cannot "fix" a
 * working guard into silence, and so the sweep's re-filing of the same
 * fingerprint is answered by evidence rather than by another rebuild.
 *
 *  081d035d — utilityChat utility-override failure (429) -> built-in chain.
 *             DESIGNED: the override leg is an OPTIMISATION; the built-in
 *             DeepSeek/DashScope chain is the answer path. A 429 is a
 *             non-unreachable rejection, so it warns and falls through
 *             immediately (no 5-min latch: the seat may recover next call).
 *  2737f88d — coding agent lead seat rejected the turn (HTTP 502) -> this turn
 *             on the built-in. DESIGNED: leadSeatHttpFailure classifies 429/5xx
 *             as "provider says not now"; the run survives on the fallback.
 *             Same root cause as the already-pinned 2c04a365/1ece90ad class
 *             (llm-cql gateway 502 flapping).
 *  73fc96b4 — BrightData direct transient 502 (attempt n/3) retrying. DESIGNED:
 *             the retry line is the vendor-transient lane announcing its own
 *             bounded retry; scripts/framework-audit already ranks this shape
 *             'vendor_transient' at failed_runs=0 (f170 pin).
 *  a6d1576d — coding agent turn failed: 400 body "<DataInspectionFailed:
 *             Input text data may contain inappropriate content>". EXTERNAL: the
 *             provider's content inspector refused the prompt. Not a statusless
 *             transport abort, so it keeps its status and is NOT tagged
 *             external (real, diagnosable); the loop's own lanes handle it.
 *  30b856cf — runModelTurn 400 fingerprint [tt-qwen3.8-flash-next] tools=51.
 *             ALREADY FIXED (PR #2061, commit 60247b90, ticket 68167bbf): the
 *             fingerprint was the diagnostic for a trailing system message that
 *             a strict OpenAI-compatible backend rejects. The fix is
 *             system-first normalization + a per-seat latch. This pin replays
 *             the exact rejected body and asserts the classifier fires, the
 *             merge produces ONE leading system message, and the latch means a
 *             seat pays that rejection at most once per process.
 *  ca062c3f — unified-memory embed failed, rows stored keyword-only. DESIGNED:
 *             the memory store is best-effort and DEGRADES (keyword-only) rather
 *             than failing the request; the once-per-cause-per-process dedupe is
 *             real, so N rows across a 24 h window spanning several boxes and
 *             deploys is that dedupe working, not a broken promise. NOTE the
 *             sweep's rule-2 window parse is imprecise on THIS shape (it
 *             harvests the embed TIMEOUT, "timeout of 30000ms exceeded", as if
 *             it were the promised window, so the ticket claims a "1 min"
 *             promise the line never made). That is a sweep-detector imprecision
 *             recorded for the framework backlog — this file is tests-only and
 *             the EMIT SITE is correct, so the member is adjudicated designed
 *             and pinned as such here.
 *
 * Style note: the emit-line assertions read source text, the same discipline as
 * errors-vendor-transient.f170.pin.test.ts — the warn vocabulary IS the contract
 * the hourly sweep reads, so a reworded warn is a behaviour change worth a red
 * suite.
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { leadSeatHttpFailure } from './helper-seat';
import { isSystemOrderRejection, hoistSystemMessages, systemFirstKey } from './system-first';
import { isStatuslessTransportAbort } from './turn-failure-classification';

const BACKEND_SRC = path.resolve(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(BACKEND_SRC, rel), 'utf8');
}

// ── 081d035d ─────────────────────────────────────────────────────────────────
describe('081d035d — utilityChat utility-override failure falls back to the built-in chain (designed)', () => {
  const src = read('utils/utility-llm.ts');

  it('the emit site is the override-leg warn, stamped source utility-override', () => {
    expect(src).toContain('utilityChat: utility role override failed (${status || msg}) — falling back to the built-in chain');
    expect(src).toContain("source: 'utility-override'");
  });

  it('a 429 is NOT classified unreachable — it warns per call instead of latching the seat off', () => {
    // The 5xx/timeout regex is the LATCH gate; a 429 must fall outside it, or a
    // recoverable throttle would silently disable the admin's seat for 5 min.
    const reLine = src.split('\n').find((l) => l.includes('UTILITY_OVERRIDE_UNREACHABLE_RE ='))!;
    expect(reLine).toBeTruthy();
    const body = reLine.slice(reLine.indexOf('=') + 1);
    const re = eval(body.trim().replace(/;$/, '')) as RegExp; // the literal in source
    expect(re.test('Request failed with status code 429')).toBe(false);
    expect(re.test('timeout of 30000ms exceeded')).toBe(true);
    expect(re.test('socket hang up')).toBe(true);
  });

  it('the built-in chain continues past the override leg (the answer path is not the override)', () => {
    // The override block is try/caught and execution FALLS THROUGH to the
    // DeepSeek leg below — the catch never returns/throws.
    const catchIdx = src.indexOf('utilityChat: utility role override failed');
    const after = src.slice(catchIdx, catchIdx + 800);
    expect(after).not.toMatch(/catch[\s\S]{0,200}return\s/);
    expect(src).toContain('deepseekBillingLatched()');
  });
});

// ── 2737f88d ─────────────────────────────────────────────────────────────────
describe('2737f88d — a lead seat HTTP 502 moves THIS TURN to the built-in (designed resilience)', () => {
  it('classifies 5xx as a provider "not now" rejection', () => {
    expect(leadSeatHttpFailure({ errorStatus: 502 })).toBe('HTTP 502');
    expect(leadSeatHttpFailure({ errorStatus: 503 })).toBe('HTTP 503');
    expect(leadSeatHttpFailure({ errorStatus: 504 })).toBe('HTTP 504');
  });

  it('426/400/401/403 keep their own lanes (not silently absorbed by the seat fallback)', () => {
    expect(leadSeatHttpFailure({ errorStatus: 400 })).toBeNull();
    expect(leadSeatHttpFailure({ errorStatus: 401 })).toBeNull();
    expect(leadSeatHttpFailure({ errorStatus: 403 })).toBeNull();
  });

  it('429 is classified too — a throttle is the same "not now" answer', () => {
    expect(leadSeatHttpFailure({ errorStatus: 429 })).toBe('HTTP 429');
  });

  it('billing suspension is its own (sticky) class', () => {
    expect(leadSeatHttpFailure({ errorMessage: 'insufficient balance', errorStatus: 429 })).toBe('billing');
  });

  it('the emit line preserves the fingerprint vocabulary the sweep files', () => {
    const src = read('modules/crossmodel/coding/agent.ts');
    expect(src).toContain('rejected the turn (${leadHttp})');
    expect(src).toContain('— ${sticky ? \'rest of this run\' : \'this turn\'} on ${fb.model}');
  });
});

// ── 73fc96b4 ─────────────────────────────────────────────────────────────────
describe('73fc96b4 — BrightData direct transient retry line is bounded, designed observability', () => {
  const src = read('modules/crossmodel/brightdata-direct.ts');

  it('the retry warn names the attempt out of a BOUNDED maximum', () => {
    expect(src).toContain('BrightData direct: transient ${err.response?.status || err.code || err.message}');
    expect(src).toContain('(attempt ${attempt}/${BD_MAX_ATTEMPTS}) — retrying in ${backoff}ms');
    expect(src).toContain("source: 'brightdata-direct'");
  });

  it('the attempt ceiling is a real constant, so a storm cannot be unbounded', () => {
    const m = src.match(/BD_MAX_ATTEMPTS\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(1);
    expect(Number(m![1])).toBeLessThanOrEqual(5);
  });

  it('an out-of-budget attempt THROWS rather than retrying forever', () => {
    expect(src).toContain('if (Date.now() + backoff >= deadline) throw err;');
    expect(src).toContain('if (attempt >= BD_MAX_ATTEMPTS || !isRetryableBdError(err)) throw err;');
  });
});

// ── a6d1576d ─────────────────────────────────────────────────────────────────
describe('a6d1576d — a provider content-inspection 400 is a real, diagnosable failure (not "external")', () => {
  const PROD = 'request failed with status code 400';

  it('a 400 WITH a drained provider body is NOT a statusless transport abort', () => {
    expect(isStatuslessTransportAbort({
      message: PROD,
      status: 400,
      bodyText: '{"error":{"message":"litellm.BadRequestError: OpenAIException - InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content."}}',
    })).toBe(false);
  });

  it('only the exact status-less "aborted" shape is classified external (the conservative axis)', () => {
    expect(isStatuslessTransportAbort({ message: 'aborted' })).toBe(true);
    // Any status, any body, or any other wording keeps its own lane.
    expect(isStatuslessTransportAbort({ message: 'aborted', status: 502 })).toBe(false);
    expect(isStatuslessTransportAbort({ message: 'aborted', bodyText: '{}' })).toBe(false);
    expect(isStatuslessTransportAbort({ message: 'ECONNRESET' })).toBe(false);
  });

  it('the turn-failure emit line keeps the status and the bounded body the sweep reads', () => {
    const src = read('modules/crossmodel/coding/agent.ts');
    expect(src).toContain('coding agent turn failed: ${err.message}${status ? ` (HTTP ${status})` : \'\'}');
    expect(src).toContain('body: ${bodyText.slice(0, 400)}');
  });
});

// ── ca062c3f ─────────────────────────────────────────────────────────────────
describe('ca062c3f — unified-memory embed failure is designed graceful degradation', () => {
  const src = read('modules/crossmodel/memory/unified-memory.service.ts');

  it('the store DEGRADES to keyword-only instead of failing the call', () => {
    expect(src).toContain('row(s) stored keyword-only');
    // The warn is emitted and the write proceeds — the store never throws here.
    expect(src).toContain('embedFailureNoticed');
    expect(src).toContain('logger.warn(`${line} (logged once per cause per process; counted as unified_memory_embed_failed)`);');
    // ...and the dedupe downgrades later occurrences to debug.
    expect(src).toContain('} else {\n    logger.debug(line);');
  });

  it('the once-per-cause-per-process promise is real: the dedupe key is the CAUSE', () => {
    // One Set keyed by embedFailureKey(cause) — kind + status + provider code.
    expect(src).toContain('const embedFailureNoticed = new Set<string>();');
    expect(src).toContain('const key = embedFailureKey(cause);');
    expect(src).toContain('if (!embedFailureNoticed.has(key)) {');
    expect(src).toContain('embedFailureNoticed.add(key);');
  });

  it('the promise is process-scoped, which is exactly why a 24 h window shows repeats', () => {
    // The line NAMES its own scope ("per process") — so N rows across a day
    // spanning several boxes and deploys is the promise KEPT, not broken.
    expect(src).toContain('once per cause per process');
    expect(src).toContain('export function __resetEmbedFailureNoticeForTests(): void { embedFailureNoticed.clear(); }');
  });

  it('a timeout is named as a timeout cause (the shape the swept rows carry)', () => {
    const leaf = read('modules/crossmodel/memory/embed-failure.ts');
    expect(leaf).toContain("/\\btimeout\\b/i.test(message)");
    expect(leaf).toContain("kind = 'timeout'");
    // The cause key distinguishes it from other failure kinds.
    expect(leaf).toContain('return `${cause.kind}:${cause.status ?? \'-\'}:${cause.code ?? \'-\'}`;');
  });
});
describe('30b856cf — system-first normalization (ALREADY FIXED by PR #2061 / 60247b90, ticket 68167bbf)', () => {
  /** The verbatim rejected body from the swept rows. */
  const PROD_BODY = 'litellm.BadRequestError: OpenAIException - messages[2].role is system; the system message must be firstNo fallback model group found for original model_group=tt-qwen3.8-flash-next. Fallbacks=[{\'api-optimize-zai-glm-5.3\': [\'api-optimize-zai-glm-5.3-flash\']}]';

  it('recognises the exact prod rejection body', () => {
    expect(isSystemOrderRejection(PROD_BODY)).toBe(true);
  });

  it('recognises the other real backend wordings and refuses unrelated 400s', () => {
    expect(isSystemOrderRejection('System message must be at the beginning of the conversation')).toBe(true);
    expect(isSystemOrderRejection('system prompt must be the first message')).toBe(true);
    // Unrelated rejections must NOT be normalized away.
    expect(isSystemOrderRejection('max_tokens is invalid for this model')).toBe(false);
    expect(isSystemOrderRejection('messages parameter is illegal')).toBe(false);
    expect(isSystemOrderRejection('')).toBe(false);
  });

  it('the merge produces ONE leading system message — the shape the strict backend accepts', () => {
    // The exact swept transcript shape: big system, user turn, trailing 265-char
    // system note (the per-turn [HARNESS CLOCK]).
    const messages = [
      { role: 'system', content: 'S'.repeat(49_777) },
      { role: 'user', content: 'U'.repeat(7_526) },
      { role: 'system', content: 'C'.repeat(265) },
    ];
    const hoisted = hoistSystemMessages(messages as any);
    expect(hoisted.changed).toBe(true);
    expect(hoisted.systemCount).toBe(2);
    expect(hoisted.messages).toHaveLength(2); // one system + the user turn
    expect(hoisted.messages[0].role).toBe('system');
    expect(hoisted.messages.filter((m: any) => m.role === 'system')).toHaveLength(1);
    // Content preserved, in document order — recency kept as far as possible.
    expect(hoisted.messages[0].content.endsWith('C'.repeat(265))).toBe(true);
    expect(hoisted.messages[0].content.startsWith('S')).toBe(true);
  });

  it('an already-legal transcript is left untouched (Moonshot prefix caching is not disturbed)', () => {
    const legal = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
    ];
    const hoisted = hoistSystemMessages(legal as any);
    expect(hoisted.changed).toBe(false);
    expect(hoisted.messages).toBe(legal);
  });

  it('the latch is keyed per (endpoint, model) — one seat pays one rejection per process', () => {
    const a = systemFirstKey({ url: 'https://llm-cql.example/v1', model: 'tt-qwen3.8-flash-next' });
    const b = systemFirstKey({ url: 'https://llm-cql.example/v1', model: 'tt-qwen3.8-flash-next' });
    const other = systemFirstKey({ url: 'https://llm-cql.example/v1', model: 'something-else' });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(systemFirstKey(null)).toBe('');
  });
});