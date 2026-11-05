/**
 * EMBED FAILURE ATTRIBUTION (goal 4e432dff) — Fleet directive 501f9e2b,
 * residual limb 2. PINNING TEST.
 *
 * WHAT WAS PROVEN, and why this file exists. In the 2026-11-02 window the
 * platform recorded 88 failed embed attempts and could date/attribute NONE of
 * them: 86 carried no leg at all and 2 were `caller_timeout` with no leg by
 * construction. The contemporaneous bound was external — the LiteLLM gateway's
 * own container log showed 4 713/4 713 embed requests answered 200 — which
 * proved the failure lived on OUR side, in a dimension we simply did not write.
 * On that build (box-c@5d6c8954) the gap is UNRECOVERABLE: nothing at read time
 * can reconstruct which flow attempted a call or which upstream it reached.
 *
 * So the fix is at WRITE time, and the assertions here are the ones that would
 * have caught the gap:
 *   1. every failure cause carries a typed side (`abort`) and, when a response
 *      existed, the leg from the gateway's OWN headers;
 *   2. a caller-side abort — the case that is honestly leg-less — is still
 *      ATTRIBUTED by bucket + abort, because requiring a leg there would make
 *      the zero-unattributed bar unreachable by construction;
 *   3. the emitted metric meta leads with bucket/abort/leg;
 *   4. the 24 h probe counts a PRE-attribution row as unattributed, so a build
 *      that cannot emit the dimension reads as unseen rather than as clean.
 *
 * ⚠ The last one is the bar's own safety property: a zero on a build that
 * cannot emit the dimension is NOT "zero failures" (supervisor steer 19:33Z).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

import {
  describeEmbedFailure,
  classifyEmbedAbort,
  embedAttributionComplete,
  embedGatewaylessMeta,
  isGatewaylessEmbedLane,
  isKnownEmbedBucket,
  legFromAttributionHeaders,
  markEmbedLane,
  readAttributionHeader,
  embedRowsWithRetry,
  EMBED_BUCKETS,
  EMBED_GATEWAYLESS_LANES,
  EMBED_GWLESS_DIRECT,
  type EmbedFailureCause,
} from './embed-failure';
// The emitted-meta builder lives beside the store-path emitter, not in the leaf.
import { embedFailureMetricMeta } from './unified-memory.service';

/** The gateway header names — LiteLLM's ProxyBaseLLMRequestProcessing sends
 *  `x-litellm-model-api-base` (which upstream answered) on a 200 and
 *  `x-litellm-model-id` on an error response; a caller abort sends nothing. */
const headers = (apiBase?: string, modelId?: string, modelName?: string) => ({
  'content-type': 'application/json',
  ...(apiBase ? { 'x-litellm-model-api-base': apiBase } : {}),
  ...(modelId ? { 'x-litellm-model-id': modelId } : {}),
  ...(modelName ? { 'x-litellm-model-name': modelName } : {}),
});

describe('the cause names the SIDE and the LEG on every failure (limb 2)', () => {
  test('a provider 5xx names the deployment that refused it', () => {
    const err = Object.assign(new Error('Request failed with status code 503'), {
      response: { status: 503, headers: headers(undefined, 'deploy-uuid-spark') },
    });
    const c = describeEmbedFailure(err);
    expect(c.kind).toBe('http_5xx');
    expect(c.abort).toBe('provider_error');
    // model-id only (LiteLLM's error path passes no api_base) → `id:…`, the full
    // id kept: a 12-char prefix merged two real legs on exactly this path.
    expect(c.leg).toBe('id:deploy-uuid-spark');
  });

  test('a gateway 5xx WITH api_base reports the upstream host', () => {
    const err = Object.assign(new Error('upstream error'), {
      response: { status: 502, headers: headers('https://agx-a.stanne.local:8001/v1', 'deploy-uuid') },
    });
    const c = describeEmbedFailure(err);
    expect(c.leg).toBe('agx-a.stanne.local:8001');
    expect(c.abort).toBe('provider_error');
  });

  test('OUR per-attempt bound is caller_timeout with NO leg — and that is attributed', () => {
    // THE INCIDENT SHAPE: we abort; the gateway goes on to serve and log a 200
    // nobody reads. There is no response, so no leg header exists at any layer.
    const err = Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    const c = describeEmbedFailure(err);
    expect(c.kind).toBe('timeout');
    expect(c.abort).toBe('caller_timeout');
    expect(c.leg).toBeNull();
    // The bar is still reachable: bucket + a typed caller-side abort IS an
    // attribution. Requiring a leg here would be a gate no honest build can pass.
    expect(embedAttributionComplete({ bucket: 'query', abort: 'caller_timeout', leg: null })).toBe(true);
  });

  test('a provider 504 is provider_error, NOT our bound — the ordering that matters', () => {
    // Both arrive with a timeout-shaped message; only a RESPONSE separates them.
    const theirs = Object.assign(new Error('timeout of 8000ms exceeded'), {
      code: 'ECONNABORTED',
      response: { status: 504, headers: headers(undefined, 'deploy-uuid-agx') },
    });
    const c = describeEmbedFailure(theirs);
    expect(c.abort).toBe('provider_error');
    expect(c.leg).toBe('id:deploy-uuid-agx');
    // and ours, same message, no response:
    expect(classifyEmbedAbort(Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }))).toBe('caller_timeout');
  });

  test('a network fault is its own typed side (attributable, no leg required)', () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const c = describeEmbedFailure(err);
    expect(c.kind).toBe('network');
    expect(c.abort).toBe('network');
    expect(embedAttributionComplete({ bucket: 'backfill', abort: 'network' })).toBe(true);
  });

  test('a 2xx with an unusable body is parse_failure', () => {
    const c = describeEmbedFailure(new Error('provider returned no vector'));
    expect(c.abort).toBe('parse_failure');
    // and it is NOT attributed without a leg — a response existed, so a leg was
    // available and its absence is a real gap, not a construction.
    expect(embedAttributionComplete({ bucket: 'query', abort: 'parse_failure' })).toBe(false);
  });
});

describe('the leg reader is the ONE definition both surfaces use', () => {
  test('header lookup is case-insensitive and works on a Headers object', () => {
    expect(readAttributionHeader({ 'X-LiteLLM-Model-Api-Base': 'https://h:1/v1' }, 'x-litellm-model-api-base')).toBe('https://h:1/v1');
    expect(readAttributionHeader(new Headers({ 'x-litellm-model-id': 'uuid' }) as any, 'x-litellm-model-id')).toBe('uuid');
    expect(readAttributionHeader(null, 'x-litellm-model-id')).toBeUndefined();
  });

  test('api_base collapses to its host; a non-URL is reported rather than dropped', () => {
    expect(legFromAttributionHeaders(headers('https://spark-a367.stanne.local:8001/v1/embeddings'))).toBe('spark-a367.stanne.local:8001');
    expect(legFromAttributionHeaders(headers('not-a-url'))).toBe('not-a-url');
    expect(legFromAttributionHeaders(headers(undefined, undefined, 'Qwen3-Embedding-8B'))).toBe('n:Qwen3-Embedding-8B');
    expect(legFromAttributionHeaders({})).toBeNull();
  });

  test('a long model id keeps up to 48 chars so two deployments cannot merge', () => {
    const a = 'Qwen3-Embedding-8B-agx-primary-cluster';
    const b = 'Qwen3-Embedding-8B-spark-a367-cluster';
    expect(legFromAttributionHeaders(headers(undefined, a))).not.toBe(legFromAttributionHeaders(headers(undefined, b)));
  });
});

describe('the attribution RULE (one predicate, used by emitters AND the probe)', () => {
  test('an unknown/absent bucket is never attributed', () => {
    expect(embedAttributionComplete({ bucket: 'unknown', leg: 'id:x', abort: 'provider_error' })).toBe(false);
    expect(embedAttributionComplete({ leg: 'id:x', abort: 'provider_error' })).toBe(false);
    expect(embedAttributionComplete(null)).toBe(false);
  });

  test('the closed bucket set refuses a free-form label', () => {
    expect(isKnownEmbedBucket('store')).toBe(true);
    expect(isKnownEmbedBucket('query')).toBe(true);
    expect(isKnownEmbedBucket('backfill')).toBe(true);
    expect(isKnownEmbedBucket('ingest')).toBe(true);
    expect(isKnownEmbedBucket('unknown')).toBe(false);
    expect(isKnownEmbedBucket('some-flow-I-just-invented')).toBe(false);
    expect(EMBED_BUCKETS).toContain('user_facts');
  });

  test('a bucket + leg is attributed; a bucket + a provider error with no leg is not', () => {
    expect(embedAttributionComplete({ bucket: 'store', leg: 'agx-a:8001', abort: 'provider_error' })).toBe(true);
    expect(embedAttributionComplete({ bucket: 'store', abort: 'provider_error', leg: null })).toBe(false);
  });
});

describe('the GATEWAYLESS carve-out (supervisor ruling 2026-11-04, option (a))', () => {
  // THE RESIDUAL THIS CLOSES. The 2026-11-04 window read 6 unattributed rows,
  // ALL one shape: `store|provider_error|NO-LEG` (row-shape probe, SSM
  // 8768380f). The Embeddings seat had no override, so embeds went DIRECT to
  // dashscope-intl — no LiteLLM hop, so no `x-litellm-*` header can ever exist
  // on a failure there. Demanding a leg made bar 0 unreachable by construction,
  // which is the same structural argument `caller_timeout`/`network` already get.
  //
  // WHAT MUST NOT REGRESS is the opposite shape: a GATEWAYED lane whose gateway
  // dropped its headers produces the SAME `leg: null`, and exonerating that row
  // would delete the very defect this KPI exists to catch. The carve-out
  // therefore needs a POSITIVE fact (`gwless:'direct'`), never an absence.

  test('(i) a provider_error on a PROVEN gatewayless lane IS attributed', () => {
    // The exact residual shape, plus the transport's own assertion.
    expect(embedAttributionComplete({
      bucket: 'store', abort: 'provider_error', leg: null, gwless: EMBED_GWLESS_DIRECT,
    })).toBe(true);
  });

  test('(i-b) but a legless provider_error with NO gatewayless proof stays UNATTRIBUTED', () => {
    // THE SAFETY PROPERTY. Absence of a leg is not proof of a direct lane: a
    // gatewayed lane that failed to emit headers looks identical, and that is
    // the defect the KPI exists to find.
    expect(embedAttributionComplete({ bucket: 'store', abort: 'provider_error', leg: null })).toBe(false);
    // An unrecognized/absent gwless value never exonerates either.
    expect(embedAttributionComplete({ bucket: 'store', abort: 'provider_error', leg: null, gwless: 'maybe' })).toBe(false);
    expect(embedAttributionComplete({ bucket: 'store', abort: 'provider_error', leg: null, gwless: undefined })).toBe(false);
  });

  test('(i-c) the carve-out still demands a TYPED abort', () => {
    // bucket + destination with no outcome is not an attribution.
    expect(embedAttributionComplete({ bucket: 'store', abort: 'unknown', leg: null, gwless: EMBED_GWLESS_DIRECT })).toBe(false);
    expect(embedAttributionComplete({ bucket: 'store', leg: null, gwless: EMBED_GWLESS_DIRECT })).toBe(false);
  });

  test('(ii) the caller_timeout carve-out is UNCHANGED — still caller_timeout', () => {
    // A caller abort has no response at any layer; it was already attributed
    // and must not depend on the new key at all.
    const err = Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    const c = describeEmbedFailure(markEmbedLane(err, 'dashscope'));
    expect(c.abort).toBe('caller_timeout');
    expect(c.leg).toBeNull();
    expect(embedAttributionComplete({ bucket: 'query', abort: c.abort, leg: c.leg })).toBe(true);
    // and a network fault likewise, untouched.
    expect(embedAttributionComplete({ bucket: 'backfill', abort: 'network' })).toBe(true);
  });

  test('(iii) a GATEWAYED provider_error is still attributed BY ITS LEG', () => {
    // The existing path must not narrow: gateway headers win regardless of lane.
    const err = Object.assign(new Error('Request failed with status code 503'), {
      response: { status: 503, headers: headers(undefined, 'deploy-uuid-spark') },
    });
    const c = describeEmbedFailure(err);
    expect(c.leg).toBe('id:deploy-uuid-spark');
    expect(c.abort).toBe('provider_error');
    expect(embedAttributionComplete({ bucket: 'store', abort: c.abort, leg: c.leg })).toBe(true);
    // A lane label of `custom`/`pinned` may sit behind a gateway, so it never
    // gets the carve-out even with a typed abort.
    expect(embedAttributionComplete({ bucket: 'store', abort: 'provider_error', leg: null, lane: 'custom' })).toBe(false);
    expect(embedAttributionComplete({ bucket: 'store', abort: 'provider_error', leg: null, lane: 'pinned' })).toBe(false);
  });

  test('the lane is stamped by the transport and never inferred at read time', () => {
    // markEmbedLane attaches the URL owner's knowledge to the error itself.
    const err: any = Object.assign(new Error('boom'), { response: { status: 400, headers: {} } });
    expect(describeEmbedFailure(err).lane).toBe('unknown'); // unstamped ⇒ never gatewayless
    markEmbedLane(err, 'dashscope');
    const c = describeEmbedFailure(err);
    expect(c.lane).toBe('dashscope');
    expect(embedGatewaylessMeta(c.lane)).toEqual({ gwless: EMBED_GWLESS_DIRECT });
    // An operator endpoint asserts nothing, so the row keeps needing its leg.
    expect(embedGatewaylessMeta('custom')).toEqual({});
    expect(embedGatewaylessMeta('pinned')).toEqual({});
    expect(embedGatewaylessMeta(undefined)).toEqual({});
  });

  test('only a hard-coded-URL lane may claim gatewayless', () => {
    // Adding a lane here is a CLAIM about the transport. A registered endpoint
    // is configured through the Endpoints registry and may be a LiteLLM base
    // URL, so it must never qualify.
    expect(isGatewaylessEmbedLane('dashscope')).toBe(true);
    expect(isGatewaylessEmbedLane('custom')).toBe(false);
    expect(isGatewaylessEmbedLane('pinned')).toBe(false);
    expect(isGatewaylessEmbedLane('unknown')).toBe(false);
    expect(EMBED_GATEWAYLESS_LANES).toEqual(['dashscope']);
  });

  test('the EMITTED store-path meta carries gwless only on a proven lane', async () => {
    // Drive the real producer: a direct-lane 400 (the residual's exact cause).
    const providerErr = markEmbedLane(Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, headers: {}, data: { error: { code: 'InternalError.Algo', message: 'Embedding_pipeline_Error' } } },
    }), 'dashscope');
    const r = await embedRowsWithRetry(['a'], async () => { throw providerErr; });
    const cause = r.cause as EmbedFailureCause;
    expect(cause.abort).toBe('provider_error');
    expect(cause.leg).toBeNull();
    const meta = embedFailureMetricMeta(cause, { rows: 1, maxChars: 10, source: 'test', scopeType: 'session', bucket: 'store' }, r);
    expect(meta.gwless).toBe(EMBED_GWLESS_DIRECT);
    // …and the emitted meta is what the rule reads, so the row is attributed.
    expect(embedAttributionComplete(meta as Record<string, unknown>)).toBe(true);
  });
});

describe('the EMITTED metric meta carries the dimension (the write-time fix)', () => {
  test('a real failure row produced by embedRowsWithRetry is fully attributed', async () => {
    // Drive the ACTUAL producer rather than hand-building a cause: a 503 with
    // the gateway's model-id header, then assert on the cause the retry engine
    // reports — the object every emitter writes from.
    const providerErr = Object.assign(new Error('Request failed with status code 503'), {
      response: { status: 503, headers: headers(undefined, 'deploy-uuid-spark') },
    });
    const r = await embedRowsWithRetry(['a'], async () => { throw providerErr; });
    expect(r.cause).not.toBeNull();
    const cause = r.cause as EmbedFailureCause;
    expect(cause.abort).toBe('provider_error');
    expect(cause.leg).toBe('id:deploy-uuid-spark');
  });
});