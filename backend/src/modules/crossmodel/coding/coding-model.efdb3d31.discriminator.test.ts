/**
 * REPLAY — ticket efdb3d31, the GATEWAY-OR-OURS discriminator (Fleet Supervisor
 * directive 3b: "name the half — did the gateway never send the bytes, or did we
 * drop them while accumulating?").
 *
 * THE DEFECT THIS PINS. The discriminator compares
 *
 *     receivedBytes   = the bytes the SSE deltas actually handed us
 *     accumulatedBytes = the bytes we managed to put in the slot table
 *
 * and reports `culprit: 'gateway' | 'ours'`. As FIRST landed (2195284dc4), the
 * received-side count sat AFTER `resolveToolCallSlot` — i.e. after the
 * UNRESOLVABLE_SLOT and DUPLICATE_FRAGMENT branches, which are precisely the two
 * places this code DISCARDS bytes the gateway already delivered. Every
 * ours-side drop was therefore invisible: received == accumulated,
 * droppedBytes == 0, and a real drop was labelled 'gateway'. The instrument
 * would have blamed llm-cql for our own data loss and sent the Fleet Supervisor
 * to file a gateway ticket on false evidence.
 *
 * These tests drive the SHIPPED `runModelTurn` over real SSE byte streams and
 * read the durable TOOL_CALL_FINALIZE row, so they pin the verdict the platform
 * actually records — not a helper in isolation.
 */
import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
// Fully mocked (never requireActual): the real service imports config/database →
// config/env, which process.exit(1)s under jest. The recorder is all this seam uses.
jest.mock('../platform/loop-metrics.service', () => ({
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { TOOL_CALL_FINALIZE: 'tool_call_finalize' },
}));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ resolveRegistryModel: jest.fn() }));

import axios from 'axios';
import {
  runModelTurn,
  looksLikeToolCallFrame,
  __resetReasoningEffortLatchForTests,
  type ProviderConfig,
} from './coding-model';
import { argumentFragmentLength, appendArgumentsFragment, unreadArgumentFragmentLength } from './tool-arguments';
import {
  FINALIZE_VERDICT_KEY,
  canonicalMetaJson,
  jsonbCanonicalKeys,
  gatewayOrOurs,
  finalizeVerdictSummary,
} from './tool-call-finalize-meta';

const mockPost = (axios as any).post as jest.Mock;

const GW: ProviderConfig = {
  url: 'https://llm.cql.ca/v1/chat/completions',
  apiKey: 'sk',
  model: 'api-optimize-xiaomi-mimo-v2.6-pro',
  spec: 'llm-cql:api-optimize-xiaomi-mimo-v2.6-pro',
  label: 'llm-cql (custom endpoint)',
  extra: {},
};

/** One SSE data line, exactly as the reader consumes it (trailing \n\n). */
const sse = (delta: any, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

const tcLine = (tc: any, finish: string | null = null) => sse({ tool_calls: [tc] }, finish);

const streamOf = (chunks: string[]) => ({ data: Readable.from(chunks) });

/** Let the fire-and-forget metric import + write land. */
const settle = () => new Promise((r) => setTimeout(r, 60));

const row = () => {
  const call = mockRecordLoopMetric.mock.calls.find(
    (c) => c[0]?.kind === 'tool_call_finalize',
  );
  return call?.[0]?.meta;
};

const HEAD = '{"goalId": "53c7e5f6-4da3-427e-bced-41d';
const FULL = '{"goalId": "53c7e5f6", "progressNote": "N6 landed"}';

beforeEach(() => {
  jest.clearAllMocks();
  __resetReasoningEffortLatchForTests();
});

describe('ticket efdb3d31 — a fragment WE drop must never be blamed on the gateway', () => {
  it('a dropped DUPLICATE re-send reports culprit:ours (was silently "gateway")', async () => {
    // Shape: a COMPLETE goal_update, then the gateway re-sends that exact
    // payload (dropped by the 3b75ba8e duplicate guard), then a second call
    // whose payload is severed. The turn is broken, so a row IS recorded.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL } }),
        // Byte-identical re-send of the same gateway id → DUPLICATE_FRAGMENT.
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL } }),
        tcLine({ index: 1, id: 'call_B', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.verdict).toBe('no_complete_payload'); // slot 1 is severed, slot 0 is fine
    // The duplicate was counted on the RECEIVED side even though it was dropped.
    expect(m.droppedBytes).toBe(FULL.length);
    expect(m.receivedBytes).toBe(FULL.length * 2 + HEAD.length);
    expect(m.accumulatedBytes).toBe(FULL.length + HEAD.length);
    expect(m.culprit).toBe('ours');
    // Buffer drained normally on this shape — the verdict comes from the drop,
    // not from a stray SSE tail.
    expect(m.undrainedBufferBytes).toBe(0);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('a stream that ends on an UNTERMINATED line reports culprit:ours via the buffer probe', async () => {
    // The last data line has no trailing '\n', so the reader keeps it in
    // `buffer` and finish() has never drained it. droppedBytes is 0 here — the
    // bytes were never parsed into a fragment at all — so ONLY the
    // undrainedBufferBytes probe can name this half correctly.
    const tail = tcLine({ index: 0, function: { arguments: ', "progressNote": "N6' } }).replace(/\n+$/, '');
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        tail, // deliberately unterminated — no trailing newline
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.droppedBytes).toBe(0);
    expect(m.undrainedBufferBytes).toBeGreaterThan(0);
    expect(m.culprit).toBe('ours');
  });

  it('a genuinely SHORT gateway payload reports culprit:gateway', async () => {
    // Nothing was dropped and nothing was left in the buffer: the stream simply
    // never carried the rest of the payload. This is the ONE shape that may be
    // escalated as an llm-cql ticket.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.receivedBytes).toBe(HEAD.length);
    expect(m.accumulatedBytes).toBe(HEAD.length);
    expect(m.droppedBytes).toBe(0);
    expect(m.undrainedBufferBytes).toBe(0);
    expect(m.culprit).toBe('gateway');
    expect(m.fragments).toBe(1);
  });
});

describe('ticket efdb3d31 — the received-side count must use the ACCUMULATOR\'s own rule', () => {
  it('an OBJECT fragment counts its JSON text, so droppedBytes cannot go negative', async () => {
    // A gateway may stream `arguments` pre-parsed (review L3 / ticket 5bdbb126).
    // appendArgumentsFragment appends JSON.stringify(obj); counting the object
    // as 0 bytes would make received < accumulated and report phantom loss.
    const obj = { goalId: '53c7e5f6', progressNote: 'N6 landed' };
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: obj } }),
        tcLine({ index: 1, id: 'call_B', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.accumulatedBytes).toBe(JSON.stringify(obj).length + HEAD.length);
    expect(m.receivedBytes).toBe(m.accumulatedBytes);
    // Never negative — the object was counted with the append rule.
    expect(m.droppedBytes).toBe(0);
  });

  it('argumentFragmentLength mirrors appendArgumentsFragment for every fragment shape', () => {
    const shapes: unknown[] = [
      'plain string',
      '',
      { a: 1, b: [2, 3] },
      [1, 2, 3],
      42,
      true,
      null,
      undefined,
    ];
    for (const s of shapes) {
      // The length the counter will add must equal the bytes the accumulator
      // actually grows by — for every shape, including the zero-byte ones.
      expect(argumentFragmentLength(s)).toBe(appendArgumentsFragment('', s).length);
    }
    // A cyclic fragment still surfaces (unparseable) rather than vanishing.
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(argumentFragmentLength(cyclic)).toBe(appendArgumentsFragment('', cyclic).length);
    expect(argumentFragmentLength(cyclic)).toBeGreaterThan(0);
  });
});

describe('ticket efdb3d31 — the verdict must SURVIVE the read surface (2026-10-29)', () => {
  /**
   * MEASURED DEFECT, and a CORRECTION to the first attempt at fixing it.
   *
   * These rows are read through a surface that cuts `meta` at
   * TELEMETRY_META_CHARS (240, fleet-telemetry.ts), so a verdict stored after
   * the cut is a verdict nobody can check against its own arithmetic.
   *
   * PR #2087 tried to fix that by writing `culprit` FIRST in the meta object.
   * The deploy proved it a NO-OP. `loop_metrics.meta` is a Prisma `Json` over a
   * Postgres JSONB column (migration 20260902000000_loop_metrics: `"meta" JSONB`)
   * and jsonb canonicalises keys by LENGTH then bytewise — the writer's order is
   * discarded. One live event, two sinks, from the 70cb50de deploy:
   *
   *   warn line: "GATEWAY-OR-OURS culprit=gateway receivedBytes=1810 …"   ← order survived (text log)
   *   meta row : {"label","model","named","slots","broken","claims","culprit",…  ← jsonb's order
   *
   * So these tests assert the CANONICAL order — what the database hands a
   * reader — not what the writer built. Asserting writer order is exactly the
   * mistake that let #2087 pass its tests and fix nothing live.
   */
  const CUT = 240; // TELEMETRY_META_CHARS — the real read-surface cut

  /** What a reader of the stored row actually sees. */
  const asRead = (meta: Record<string, unknown>) => canonicalMetaJson(meta).slice(0, CUT);

  it('a short gateway payload keeps the verdict AND its arithmetic inside the real cut', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    // Canonical order puts the 2-char key FIRST, ahead of label/model/slots.
    expect(jsonbCanonicalKeys(m)[0]).toBe(FINALIZE_VERDICT_KEY);
    const head = asRead(m);
    // One short value carries verdict + every number that justifies it, so a
    // truncation cannot leave a bare verdict behind.
    expect(head).toContain('"gw":"gateway recv=');
    expect(head).toContain('drop=0');
    expect(head).toContain('buf=0');
    // The long keys remain for programmatic readers (JSON paths don't truncate).
    expect(m.culprit).toBe('gateway');
    expect(m.droppedBytes).toBe(0);
    expect(m.undrainedBufferBytes).toBe(0);
  });

  it('an OURS-side drop reads as ours with its non-zero drop inside the cut', async () => {
    // Same duplicate-drop shape as the first test in this file: the gateway
    // re-sent a payload we already hold. If the cut hides the numbers, this row
    // reads as an unexplained verdict — exactly the trap this pins.
    const FULL_LOCAL = '{"goalId": "53c7e5f6", "progressNote": "N6 landed"}';
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL_LOCAL } }),
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL_LOCAL } }),
        tcLine({ index: 1, id: 'call_B', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.culprit).toBe('ours');
    const head = asRead(m);
    expect(head).toContain('"gw":"ours ');
    // The dropped bytes are named in the short value itself, not only in a
    // long key the cut would hide.
    expect(head).not.toContain('"gw":"ours recv=0 ');
    expect(jsonbCanonicalKeys(m)[0]).toBe(FINALIZE_VERDICT_KEY);
  });

  /**
   * MEASURED 2026-10-29T22:05:59Z — the fix ABOVE left the decisive field
   * outside the cut, in BOTH sinks at once.
   *
   * `gw` survived (key length is the lever, and that part worked). But
   * `finish_reason` is what separates the two mechanisms still standing once
   * the arithmetic names `gateway`:
   *
   *   'length'      ⇒ the OUTPUT CAP cut the stream mid-call
   *   'tool_calls'  ⇒ the turn ended cleanly per the provider and STILL arrived
   *                   short ⇒ a transport short-send
   *
   * and it was unreadable on every live row:
   *
   *   meta : jsonb order ends `broken` at ±238 chars on the live value, so
   *          `claims`, `culprit`, `verdict` and the `finishReason` LONG KEY all
   *          fall past 240 — the row could not answer its own question.
   *   warn : the reordered line measured EXACTLY 240 chars and was stored cut
   *          at "…finalize diagnosis no_complete_payl", discarding the
   *          `finishReason=` that sat after the verbose slot detail.
   *
   * So the discriminator rode a key the cut removed. It now travels inside
   * `gw`, which is emitted first and therefore unlosable by construction.
   */
  it('finish_reason survives the read cut — an output-cap cut is distinguishable from a short send', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    // The value the provider actually gave this turn.
    expect(m.finishReason).toBe('tool_calls');

    const head = asRead(m);
    // THE ASSERTION THAT MATTERS: readable INSIDE the 240-char cut, not merely
    // present on the object. This is what failed live and what nothing pinned.
    expect(head).toContain('fr=tool_calls');
    // …and it is inside the short value, so it cannot be separated from the
    // arithmetic that named the half.
    expect(head).toContain('"gw":"gateway recv=');
    expect(head).toContain('drop=0');
    expect(head).toContain('buf=0');
    // Guard the regression directly: the long key alone is NOT good enough.
    expect(head).not.toContain('"finishReason"');
  });

  it('a NULL finish_reason renders fr=null rather than vanishing from the cut', async () => {
    // "The provider told us nothing" is itself a discriminator value, and a
    // silently absent token is ambiguous with a row written before this field
    // existed — which would make an old row look like a new 'length' answer.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, null as any),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(asRead(m)).toContain('fr=null');
  });
});

describe('ticket efdb3d31 — streamCompleted must not false-positive on a CLEAN stream', () => {
  /**
   * POST-MERGE REVIEW DEFECT (2026-10-29 — found after #2098 merged, real and
   * reproduced). The line loop only processes COMPLETE lines:
   *
   *     const lines = buffer.split('\n'); buffer = lines.pop() || '';
   *
   * so a final fragment with no trailing newline is parked in `buffer` waiting
   * for a chunk that never comes. A gateway that ends with `data: [DONE]` and NO
   * trailing newline therefore left the sentinel unparsed and a perfectly CLEAN
   * stream read `streamCompleted: false` — a false positive pointing straight at
   * the re-emit lane (an extra full round-trip per turn).
   *
   * These pin BOTH directions, because over-correcting here is just as bad: a
   * genuinely severed stream must still read false, or the lane never fires and
   * the whole remedy is dead code.
   */
  it('reports true when [DONE] arrives WITHOUT a trailing newline (the defect)', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL } }),
        sse({}, 'tool_calls'),
        'data: [DONE]', // deliberately unterminated — the real-world shape
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    expect(r.streamCompleted).toBe(true);
  });

  it('reports true when [DONE] arrives terminated (the normal shape)', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    expect(r.streamCompleted).toBe(true);
  });

  it('reports false when the stream is severed with NO sentinel', async () => {
    // The lane's whole reason to exist. If this ever reads true, the remedy is
    // silently dead.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    expect(r.streamCompleted).toBe(false);
  });

  it('reports false when the tail is severed MID-DELTA and no sentinel follows', async () => {
    // The exact live shape: a truncated arguments fragment in an unterminated
    // final line. The buffer probe must not mistake this for a terminator.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"more',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    expect(r.streamCompleted).toBe(false);
  });
});

describe('efdb3d31 — instrumentation added 2026-10-30 (the parse-fail blind spot + the guard\'s own inputs)', () => {
  // Local copy: the sibling describe-scoped helper is not visible out here, and
  // the CUT must be the REAL read surface, not a re-picked number.
  const READ_CUT = 240; // TELEMETRY_META_CHARS
  const asRead = (meta: Record<string, unknown>) => canonicalMetaJson(meta).slice(0, READ_CUT);
  /**
   * THE HOLE THIS CLOSES, measured. `receivedBytes` is the sum of
   * `function.arguments` lengths on deltas we PARSED, so `recv == acc` was only
   * ever as trustworthy as "no frame failed to parse" — and nothing recorded
   * that. A `data:` line our JSON reader rejected discarded whatever bytes it
   * carried while the arithmetic still read perfect, which is one of the three
   * hypotheses the Fleet asked this lane to separate.
   *
   * The live llm-cql path ALSO streams legitimate raw-text tokens through that
   * same catch branch, so the count alone cannot tell the two apart. `sc`/`pc`
   * are the discriminators: a parse-failed frame that CONTAINS a tool_calls
   * marker is corruption; a bare text token is the documented fallback.
   */
  it('a parse-failed frame carrying tool_calls bytes is COUNTED and named in the short value', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        // A frame that would not parse, carrying tool-call bytes — the shape
        // that used to vanish without trace.
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"goalId',
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    // Counted on the durable row …
    expect(m.parseFailLines).toBe(1);
    expect(m.parseFailToolCalls).toBe(1);
    // … AND readable inside the 240-char cut, which is the only surface that
    // matters (the long keys sit past it on a real row).
    const head = asRead(m);
    expect(head).toContain('pf=1');
    expect(head).toContain('pb=');
    expect(head).toContain('pc=1');
  });

  it('a raw-text token (the legitimate llm.cql fallback) counts as a frame but NOT as tool bytes', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        'data: just some prose\n\n',
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.parseFailLines).toBe(1);
    // The distinction that keeps this from firing on every healthy raw-text turn.
    expect(m.parseFailToolCalls).toBe(0);
  });

  it('a CLEAN turn writes no pf token at all — the unreadable common case stays short', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    // Guarantees the new tokens cannot push `fr=`/`sc=` past the cut on the
    // overwhelmingly common turn.
    expect(asRead(m)).not.toContain('pf=');
    expect(m.parseFailLines).toBeUndefined();
  });

  it('records the transport verdict (sc) and the per-slot assembly trace on EVERY row', async () => {
    // The two facts that made the guard unfalsifiable for a day: nothing stored
    // `streamCompleted`, so "the guard never fired" could not be read as "the
    // sentinel arrives" without an inference the Fleet got wrong once already.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: '"more' } }),
        tcLine({ index: 1, id: 'call_B', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    // sc=1: the sentinel DID arrive. This is the value that proves the old
    // guard's `=== false` precondition could never hold on this path.
    expect(asRead(m)).toContain('sc=1');
    expect(m.streamCompleted).toBe(true);
    // Assembly trace: slot 0 took two fragments, slot 1 took one, and no delta
    // lacked an index — so a cut here is NOT a bucket-routing loss.
    expect(m.sl).toBe('0:2,1:1');
    expect(m.ni).toBe(0);
  });

  it('counts deltas that arrive with NO usable index (the bucket-routing blind spot)', async () => {
    // resolveToolCallSlot routes an index-less fragment to "the call being
    // streamed". If a gateway renumbers or omits `index` mid-call, bytes land
    // in the wrong bucket and the slot table alone cannot say so.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        tcLine({ id: 'call_A', function: { arguments: '"more' } }), // no index
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.ni).toBe(1);
  });

  it('does NOT count an empty keepalive `data:` line as a parse failure (review D3)', async () => {
    // `data: ` with an empty payload reaches the catch branch only because
    // `JSON.parse('')` throws. Counting it made a CLEAN turn read `pf=1 pb=0`
    // — a token that names nothing and dilutes the discriminator this field
    // exists for.
    mockPost.mockResolvedValueOnce(
      streamOf([
        'data: \n\n', // keepalive — benign
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        'data: \n\n', // and again
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.parseFailLines).toBeUndefined();
    expect(asRead(m)).not.toContain('pf=');
  });

  it('does NOT count prose that merely mentions the word "function" (review D4)', async () => {
    // The first cut tested the bare substring `"function"`, which fires on
    // ordinary raw-text prose. That mislabels a benign token as a corrupted
    // tool-call frame — the opposite of what the discriminator is for.
    mockPost.mockResolvedValueOnce(
      streamOf([
        'data: the "function" key was not set yet\n\n',
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    // It IS a rejected frame (prose is not JSON) …
    expect(m.parseFailLines).toBe(1);
    // … but it carries no tool-call SHAPE, so it must not be counted as one.
    expect(m.parseFailToolCalls).toBe(0);
  });

  it('looksLikeToolCallFrame requires a JSON key, and still fires on a frame cut mid-structure', () => {
    // Positive arms: a mangled tool-call chunk still shows the key it was cut
    // after — that is precisely the evidence wanted (valid JSON NOT required).
    expect(looksLikeToolCallFrame('{"choices":[{"delta":{"tool_calls":[{"index":0')).toBe(true);
    expect(looksLikeToolCallFrame('{"index":0,"function":{"arguments":"{"goalId')).toBe(true);
    expect(looksLikeToolCallFrame('{"function": {"name": "goal_update"')).toBe(true);
    // Negative arms: prose naming the quoted word, and a bare word without the
    // quote+colon a JSON key requires.
    expect(looksLikeToolCallFrame('the "function" key was not set yet')).toBe(false);
    expect(looksLikeToolCallFrame('function calls are neat')).toBe(false);
    expect(looksLikeToolCallFrame('{"other": 1,')).toBe(false);
  });
});

/**
 * CRITERION 1 (added 2026-10-30 after audit): the per-fragment arithmetic must
 * ride the TURN, not only the sibling finalize row.
 *
 * The declared acceptance is "…emitted on every dispatch_reject". Before this,
 * `runModelTurn` wrote the arithmetic ONLY to the `tool_call_finalize` row, so a
 * REJECTED call's own row carried `argLen` — a dispatched length with no gateway
 * side to compare against — and could not say whether those bytes ever arrived.
 * These assertions pin the value that now flows to the reject seam.
 */
describe('ticket efdb3d31 criterion 1 — the fragment arithmetic rides the turn', () => {
  it('returns streamTrace on a severed turn so a dispatch_reject can state whether its bytes arrived', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});

    expect(r.streamTrace).toBeDefined();
    // Every byte the gateway handed us landed in the slot: the payload the
    // gateway SENT was already short, which is exactly what the reject row must
    // be able to state on its own.
    expect(r.streamTrace!.receivedBytes).toBe(HEAD.length);
    expect(r.streamTrace!.accumulatedBytes).toBe(HEAD.length);
    expect(r.streamTrace!.droppedBytes).toBe(0);
    expect(r.streamTrace!.fragments).toBe(1);
    expect(r.streamTrace!.undrainedBufferBytes).toBe(0);
    // Index handling visible: one routed delta into slot 0, none index-less.
    expect(r.streamTrace!.assemblyTrace).toBe('0:1');
    expect(r.streamTrace!.deltasWithoutIndex).toBe(0);
  });

  it('counts a dropped duplicate on the received side, so the reject row cannot read a false zero', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL } }),
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: FULL } }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});

    expect(r.streamTrace).toBeDefined();
    expect(r.streamTrace!.receivedBytes).toBe(FULL.length * 2);
    expect(r.streamTrace!.accumulatedBytes).toBe(FULL.length);
    expect(r.streamTrace!.droppedBytes).toBe(FULL.length);
  });

  // ── firing 6 CORRECTION (independent review) ──────────────────────────────
  // Recording a counter the blame-seam reader cannot reach is the same as not
  // recording it. A cut turn is REJECTED — the reject row is the row an analyst
  // reads — so `sk=`/`ml=`/`pf=` have to ride `streamTrace`, not just the
  // finalize row that is only written when the turn got that far.
  it('carries the frame-reader counters onto the REJECT side of the seam', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        // A line with no `data:` prefix — discarded before any counter ran,
        // until firing 6.
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"y"}}]}}]}\n',
        // A `data:` frame that cannot parse AND carries tool-call bytes.
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"goalId',
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});

    expect(r.streamTrace).toBeDefined();
    // The skip and the parse-fail both reach the row that decides blame.
    expect(r.streamTrace!.skippedRawLines).toBe(1);
    expect(r.streamTrace!.skippedRawBytes).toBeGreaterThan(0);
    expect(r.streamTrace!.parseFailToolCalls).toBe(1);
    expect(r.streamTrace!.parseFailLines).toBe(1);
  });
});

/**
 * efdb3d31 (2026-10-30) — THE LAST WAY `recv` UNDERCOUNTS (firing 3).
 *
 * The discriminator's rule is `received > accumulated ⇒ ours`, and BOTH sides
 * count ONE path: `function.arguments`. A gateway that ships the same payload
 * under a different path contributes to neither side, so the row reads
 * `recv=N acc=N drop=0` and the verdict says **gateway** — a false vendor blame
 * for a defect of ours. `unreadArgBytes` counts those bytes and VOIDS the
 * verdict, so the arithmetic can never hand out a 'gateway' it did not earn.
 */
describe('ticket efdb3d31 — an unread argument shape must void the gateway verdict', () => {
  it('counts bytes carried on a path the accumulator cannot read, and only then', () => {
    // The path the accumulator reads: nothing is unread.
    expect(unreadArgumentFragmentLength({ function: { arguments: '{"a":1}' } })).toBe(0);
    // A name-only delta (the opening fragment): legitimately zero, NOT unread.
    expect(unreadArgumentFragmentLength({ function: { name: 'goal_update' } })).toBe(0);
    expect(unreadArgumentFragmentLength({})).toBe(0);
    expect(unreadArgumentFragmentLength(null)).toBe(0);
    // Shapes we cannot reach — these are the bytes that would vanish silently.
    expect(unreadArgumentFragmentLength({ function_call: { arguments: '{"a":1}' } })).toBe(7);
    expect(unreadArgumentFragmentLength({ arguments: '{"a":1}' })).toBe(7);
  });

  it('a clean byte arithmetic reading gateway is voided the moment bytes went uncounted', () => {
    // received === accumulated, nothing buffered: the arithmetic alone says
    // 'gateway' — and that is exactly the false ticket this rule forbids.
    expect(gatewayOrOurs({ droppedBytes: 0, undrainedBufferBytes: 0 })).toBe('gateway');
    expect(gatewayOrOurs({ droppedBytes: 0, undrainedBufferBytes: 0, unreadArgBytes: 7 })).toBe('ours');
    // An existing ours-side signal still wins on its own.
    expect(gatewayOrOurs({ droppedBytes: 5, undrainedBufferBytes: 0, unreadArgBytes: 0 })).toBe('ours');
  });

  it('renders ur= only when non-zero, inside the short value that survives the read cut', () => {
    const base = {
      droppedBytes: 0, undrainedBufferBytes: 0,
      receivedBytes: 39, accumulatedBytes: 39, fragments: 6,
      finishReason: 'tool_calls', streamCompleted: true,
    };
    const clean = finalizeVerdictSummary(base);
    expect(clean).toContain('gateway');
    expect(clean).not.toContain('ur=');

    const voided = finalizeVerdictSummary({ ...base, unreadArgBytes: 57 });
    // The verdict and the reason it was voided travel together by construction.
    expect(voided).toContain('ours');
    expect(voided).toContain('ur=57');
  });

  it('a live turn whose payload rides function_call.arguments records ours, not gateway', async () => {
    // `function.name` is present (so the call is NOT filtered out), but its
    // arguments never touch the path the accumulator reads. Arithmetic alone
    // would read recv=0 acc=0 drop=0 and blame llm-cql.
    mockPost.mockResolvedValueOnce(
      streamOf([
        sse({ tool_calls: [{ index: 0, id: 'call_L', function: { name: 'goal_update' }, function_call: { arguments: FULL } }] }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    const r = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    // The trap: these three numbers alone say "the gateway sent it short".
    expect(m.droppedBytes).toBe(0);
    expect(m.receivedBytes).toBe(0);
    expect(m.accumulatedBytes).toBe(0);
    // The void, so nobody files a vendor ticket off an uncounted stream.
    expect(m.culprit).toBe('ours');
    expect(m.unreadArgBytes).toBe(FULL.length);
    expect(m[FINALIZE_VERDICT_KEY]).toContain(`ur=${FULL.length}`);
    expect(r.streamTrace!.unreadArgBytes).toBe(FULL.length);
  });
});

describe('efdb3d31 firing 6 — the frame-reader blind spot (a line without `data:`)', () => {
  // WHY THIS EXISTS. `receivedBytes` is a sum over `data:` frames the reader
  // PARSED. A line that does not start with `data:` was dropped at the loop
  // head, before any counter ran, so payload on such a line entered NEITHER
  // side of recv-vs-acc — and the row still read `drop=0`, handing the verdict
  // to the gateway off a stream the measurement never fully saw. The 2026-10-30
  // matched-size A/B (direct vs proxied, both legs intact to 36 KB) is what made
  // this the last live explanation left on OUR side, so it had to be countable.
  const READ_CUT = 240; // TELEMETRY_META_CHARS — the real read surface
  const asRead = (meta: Record<string, unknown>) => canonicalMetaJson(meta).slice(0, READ_CUT);

  it('a bare payload line is COUNTED and voids the gateway verdict', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        // No `data:` prefix — the shape the reader used to discard unread.
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"x"}}]}}]}\n',
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.skippedRawLines).toBe(1);
    expect(m.skippedRawBytes).toBeGreaterThan(0);
    // The arithmetic alone would have said 'gateway'; the uncounted line voids it.
    expect(m.droppedBytes).toBe(0);
    expect(m.culprit).toBe('ours');
    expect(asRead(m)).toContain('sk=1');
    expect(asRead(m)).toContain('sb=');
  });

  it('legitimate SSE (blank separators, `:` keepalives) is NOT counted — the clean turn stays clean', async () => {
    mockPost.mockResolvedValueOnce(
      streamOf([
        ': keepalive\n\n',
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        ': another keepalive\n\n',
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    // Without the prefix allow-list this would read 'ours' on every healthy
    // gateway that sends spec-standard `:` comments.
    expect(m.skippedRawLines).toBeUndefined();
    expect(m.culprit).toBe('gateway');
    expect(asRead(m)).not.toContain('sk=');
  });

  it('counts an event split across several `data:` lines (ml), which the reader cannot join', async () => {
    // The SSE spec joins multi-line `data:` payloads with "\n". This reader
    // parses each line as its own JSON document, so a spec-compliant split
    // frame fails to parse BY CONSTRUCTION — the count makes the shape visible
    // instead of leaving it to inference.
    mockPost.mockResolvedValueOnce(
      streamOf([
        tcLine({ index: 0, id: 'call_A', function: { name: 'goal_update', arguments: HEAD } }),
        'data: {"choices":[{"delta":{"content":"a"},\n' +
          'data: "finish_reason":null}]}\n\n',
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    );

    await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const m = row();
    expect(m).toBeDefined();
    expect(m.multilineDataEvents).toBe(1);
    expect(asRead(m)).toContain('ml=1');
  });

  it('the void rule is pure and independent of the byte arithmetic', () => {
    expect(gatewayOrOurs({ droppedBytes: 0, undrainedBufferBytes: 0 })).toBe('gateway');
    expect(gatewayOrOurs({ droppedBytes: 0, undrainedBufferBytes: 0, skippedRawLines: 1 })).toBe('ours');
    // A zero count must not void anything — absence means clean, not unknown.
    expect(gatewayOrOurs({ droppedBytes: 0, undrainedBufferBytes: 0, skippedRawLines: 0 })).toBe('gateway');
  });

  // ── CORRECTION (firing 6, independent review) ─────────────────────────────
  // The first cut of this instrumentation DOCUMENTED blind spot (b) as closed
  // ("pf/pb/pc did NOT void a gateway verdict ... Both closed") while the code
  // only ever added `ur=`/`skippedRawLines`. A doc claiming a guard it never
  // shipped is the same class of defect as the stale present-tense prose that
  // manufactured the FS gate-widening ask. These pin the REAL rule.
  it('a parse-failed frame carrying TOOL-CALL bytes voids the verdict (pc), a raw-text token does not', () => {
    const clean = { droppedBytes: 0, undrainedBufferBytes: 0 };
    // pc>0 ⇒ tool-call bytes were rejected at our frame boundary and so never
    // entered receivedBytes: the arithmetic cannot speak for them.
    expect(gatewayOrOurs({ ...clean, parseFailToolCalls: 1 })).toBe('ours');
    // The legitimate llm.cql raw-text fallback: the frame failed to parse but
    // carried NO tool-call structure. Voiding here would blame US for a healthy
    // content stream on every turn — a false 'ours', equally a lie.
    expect(gatewayOrOurs({ ...clean, parseFailToolCalls: 0 })).toBe('gateway');
    expect(gatewayOrOurs({ ...clean, parseFailLines: 1, parseFailToolCalls: 0 })).toBe('gateway');
  });

  it('a payload split across data: lines voids ONLY when its frames also failed to parse', () => {
    const clean = { droppedBytes: 0, undrainedBufferBytes: 0 };
    // Split AND unparseable ⇒ bytes plausibly lost between the lines.
    expect(gatewayOrOurs({ ...clean, parseFailLines: 1, multilineDataEvents: 1 })).toBe('ours');
    // Split but every line parsed ⇒ nothing was lost; voiding would invent a
    // false 'ours', the mirror-image of the false 'gateway' this rule prevents.
    expect(gatewayOrOurs({ ...clean, multilineDataEvents: 2 })).toBe('gateway');
  });

  it('renders sk=/ml= only when non-zero, so the common row keeps its bytes', () => {
    const base = {
      droppedBytes: 0, undrainedBufferBytes: 0,
      receivedBytes: 39, accumulatedBytes: 39, fragments: 6,
      finishReason: 'tool_calls', streamCompleted: true,
    };
    const clean = finalizeVerdictSummary(base);
    expect(clean).not.toContain('sk=');
    expect(clean).not.toContain('ml=');

    const skipped = finalizeVerdictSummary({ ...base, skippedRawLines: 2, skippedRawBytes: 88 });
    expect(skipped).toContain('ours');
    expect(skipped).toContain('sk=2 sb=88');

    const multi = finalizeVerdictSummary({ ...base, multilineDataEvents: 3 });
    expect(multi).toContain('ml=3');
  });
});
