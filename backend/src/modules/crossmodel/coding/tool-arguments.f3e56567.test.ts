/**
 * REPLAY — ticket f3e56567 (tool-payload-truncation family).
 *
 * Reported from the Schooltime project supervisor chat (41bd202a), 2026-10-30:
 * two tool surfaces silently delivered MUTATED payloads with NO error to the
 * sender —
 *
 *   1. `send_chat_message` reached the receiver cut at 2,545 chars, then again
 *      at 1,111 on the retry;
 *   2. `todo_update(progressNote)` reported success while the row kept its old
 *      note (progressNote stayed null, updatedAt unchanged on read-back).
 *
 * The reporter's own correlation, which is the lead this file pins: the
 * payloads that mutated carried NON-ASCII glyphs (`>=`, `->`, `×`, `~`), and
 * the "workaround that worked" was short PURE-ASCII sends — "all landed".
 *
 * THE DEFECT THIS FILE PINS (coding-model.ts, the SSE byte reader):
 *
 *     stream.on('data', (chunk: Buffer) => { buffer += chunk.toString(); … })
 *
 * `chunk.toString()` decodes each TCP chunk INDEPENDENTLY. A UTF-8 code point
 * whose bytes straddle a chunk boundary is split into two invalid sequences,
 * and each half decodes to U+FFFD REPLACEMENT CHARACTER. The replacement chars
 * land INSIDE a JSON string literal, so `JSON.parse` still SUCCEEDS and the
 * tool STILL EXECUTES — with silently corrupted content and, for a payload
 * whose glyph sits near a value boundary, a value that no longer matches what
 * the sender wrote. Nothing anywhere reports an error: not the parser, not the
 * slot accumulator, not the tool result. That is exactly the "silent
 * mid-payload cut … that still reports plausible success" the ticket asks us
 * to eliminate.
 *
 * WHY IT IS NOT LENGTH-DRIVEN (and why the ticket's 2,545/1,111 numbers are a
 * symptom, not the mechanism): a split is a function of where the TRANSPORT
 * packetises the stream, which is why the same call mutated at different
 * lengths on two attempts and why shortening the payload "fixed" it — a
 * shorter payload simply has fewer chances to straddle a chunk boundary at a
 * multi-byte glyph. This is the same conclusion the sibling efdb3d31 lane
 * reached from the other side ("the cut is not size-driven at either leg").
 *
 * THE FIX UNDER TEST: decode the stream through a STATEFUL UTF-8 decoder
 * (`StringDecoder`) so a split code point is carried across the chunk
 * boundary and emitted whole, and flush the decoder's remainder at finish().
 * A payload must arrive BYTE-INTACT, or — where a real cut happens — be
 * rejected out loud; never silently mutated.
 *
 * THE 2026-08-30 AUDIT STILL GOVERNS: this changes only how bytes are DECODED.
 * `parseToolArguments` still rejects a genuinely truncated payload; nothing
 * here makes a severed call executable.
 */
import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { TOOL_CALL_FINALIZE: 'tool_call_finalize' },
}));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ resolveRegistryModel: jest.fn() }));

import axios from 'axios';
import { runModelTurn, __resetReasoningEffortLatchForTests, type ProviderConfig } from './coding-model';
import { parseToolArguments } from './tool-arguments';

const mockPost = (axios as any).post as jest.Mock;

const GW: ProviderConfig = {
  url: 'https://llm.cql.ca/v1/chat/completions',
  apiKey: 'sk',
  model: 'api-optimize-xiaomi-mimo-v2.6-pro',
  spec: 'llm-cql:api-optimize-xiaomi-mimo-v2.6-pro',
  label: 'llm-cql (custom endpoint)',
  extra: {},
};

const sse = (delta: any, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const tcLine = (tc: any, finish: string | null = null) => sse({ tool_calls: [tc] }, finish);

/** Drive the reader with RAW BUFFER chunks — the shape the transport really delivers. */
const bufferStreamOf = (buffers: Buffer[]) => ({ data: Readable.from(buffers) });

/** Let the fire-and-forget metric import + write land. */
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  jest.clearAllMocks();
  __resetReasoningEffortLatchForTests();
});

/**
 * Split a byte stream one byte INTO the multi-byte code point at `atChar` —
 * the exact shape a TCP/gateway packet boundary produces. Throws unless the
 * offset really lands inside a glyph, so the fixture can never silently stop
 * testing the thing it claims to test.
 */
function splitMidGlyph(text: string, atChar: number): [Buffer, Buffer] {
  const bytes = Buffer.from(text, 'utf8');
  // Byte offset of the target char, +1 ⇒ past its LEAD byte, onto a
  // continuation byte (we are inside the code point).
  const boundary = Buffer.byteLength(text.slice(0, atChar), 'utf8') + 1;
  const b = bytes[boundary];
  // 0b10xxxxxx ⇒ this byte is a UTF-8 CONTINUATION byte, i.e. we are inside a glyph.
  if (b === undefined || (b & 0xc0) !== 0x80) {
    throw new Error(`fixture error: offset ${boundary} is not mid-glyph (byte 0x${(b ?? 0).toString(16)})`);
  }
  return [bytes.subarray(0, boundary), bytes.subarray(boundary)];
}

describe('ticket f3e56567 — tool payloads must arrive byte-intact, never silently mutated', () => {
  it('a multi-byte glyph split across a chunk boundary survives into the parsed arguments', async () => {
    // A send_chat_message body carrying the reporter's own glyph class
    // (>=, ->, ×, ~), long enough to be realistic.
    const body = 'STEER: ruling 3 stands — depth >= 2 shards × 4 lanes, p95 -> 60s, ~2 wakes left.';
    const args = JSON.stringify({ chatId: '60dfc8a8', content: body });
    const line = tcLine({ index: 0, id: 'call_A', function: { name: 'send_chat_message', arguments: args } });

    // Cut INSIDE the '×' glyph: the producer that corrupts a naive per-chunk decode.
    const [head, tail] = splitMidGlyph(line, line.indexOf('×'));
    mockPost.mockResolvedValueOnce(bufferStreamOf([head, tail]));

    const turn = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const call = turn.toolCalls.find((t) => t.name === 'send_chat_message');
    expect(call).toBeDefined();

    // THE CLAIM: the arguments the tool will execute are byte-identical to what
    // the model emitted. Before the fix these were `{"chatId":"60dfc8a8",
    // "content":"STEER: … depth >= 2 shards \ufffd\ufffd 4 lanes …"}` — parseable,
    // executable, and WRONG.
    expect(call!.arguments).toBe(args);
    expect(call!.arguments).not.toMatch(/\uFFFD/);

    const parsed = parseToolArguments(call!.arguments);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.content).toBe(body);
      expect(parsed.args.chatId).toBe('60dfc8a8');
    }
  });

  it('a >4KB progressNote with non-ASCII glyphs survives byte-intact (todo_update)', async () => {
    // The ticket's acceptance bar, verbatim: a >2KB todo_update progressNote
    // with non-ASCII glyphs must land byte-intact. Built from repeated glyph
    // runs so several chunk boundaries are likely to land mid-code-point.
    const note = Array.from({ length: 140 }, (_, i) => `step ${i}: ≥2 → ×3 ~ok`).join(' | ');
    expect(note.length).toBeGreaterThan(2000);
    const args = JSON.stringify({ todoId: '355152e6', progressNote: note });
    expect(args.length).toBeGreaterThan(2000);
    const line = tcLine({ index: 0, id: 'call_B', function: { name: 'todo_update', arguments: args } });

    // Deliberately hostile packetisation: many small chunks, several of which
    // must fall inside a multi-byte glyph.
    const bytes = Buffer.from(line, 'utf8');
    const chunks: Buffer[] = [];
    const step = 97; // odd size ⇒ boundaries drift across the glyph positions
    for (let i = 0; i < bytes.length; i += step) chunks.push(bytes.subarray(i, i + step));
    expect(chunks.length).toBeGreaterThan(20);
    mockPost.mockResolvedValueOnce(bufferStreamOf(chunks));

    const turn = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const call = turn.toolCalls.find((t) => t.name === 'todo_update');
    expect(call).toBeDefined();
    expect(call!.arguments).toBe(args);
    expect(call!.arguments).not.toMatch(/\uFFFD/);

    const parsed = parseToolArguments(call!.arguments);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.progressNote).toBe(note);
  });

  it('a SMALL single-write todo_update with one glyph also survives byte-intact', async () => {
    // Fleet Supervisor constrain (192d9087, third sighting): cuts were measured
    // at 499 / 80 / 41 / 19 chars on COMBINED writes and 194 / 41 on SINGLE
    // ones. A "only huge payloads truncate" hypothesis would pass a big-payload
    // test and keep failing in production, so pin a SHORT single write too: one
    // non-ASCII glyph in a ~60-char note.
    const note = 'N6 landed × 4';
    const args = JSON.stringify({ todoId: '355152e6', progressNote: note });
    expect(args.length).toBeLessThan(120);
    const line = tcLine({ index: 0, id: 'call_S', function: { name: 'todo_update', arguments: args } });

    // The single glyph is the split point — the smallest possible corruption.
    const [head, tail] = splitMidGlyph(line, line.indexOf('×'));
    mockPost.mockResolvedValueOnce(bufferStreamOf([head, tail]));

    const turn = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const call = turn.toolCalls.find((t) => t.name === 'todo_update');
    expect(call).toBeDefined();
    expect(call!.arguments).toBe(args);
    expect(call!.arguments).not.toMatch(/\uFFFD/);
    const parsed = parseToolArguments(call!.arguments);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.progressNote).toBe(note);
  });

  it('a >4KB send_chat_message survives byte-intact (the ticket\'s first acceptance arm)', async () => {
    // The ticket's own bar: "a >4KB send_chat_message … must land byte-intact".
    // No test covered this arm — the merged send_chat_message case is ~80 chars,
    // so a regression that only bites at scale would have passed the suite while
    // the reporter kept seeing 2,545/1,111-char seams in production.
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `¶${i}: ruling ≥2 stands — depth → 4 lanes × 3 shards, p95 ~60s, µs-level ±5 ✓ 中文αβγ`,
    );
    const body = paragraphs.join('\n');
    const args = JSON.stringify({ chatId: '60dfc8a8', content: body });
    expect(args.length).toBeGreaterThan(4096);

    const line = tcLine({ index: 0, id: 'call_BIG', function: { name: 'send_chat_message', arguments: args } });

    // Hostile packetisation: 61-byte chunks drift their boundaries across every
    // glyph run, so many chunks land mid-code-point — the real transport shape.
    const bytes = Buffer.from(line, 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 61) chunks.push(bytes.subarray(i, i + 61));
    expect(chunks.length).toBeGreaterThan(100);
    mockPost.mockResolvedValueOnce(bufferStreamOf(chunks));

    const turn = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const call = turn.toolCalls.find((t) => t.name === 'send_chat_message');
    expect(call).toBeDefined();
    // Byte-identical, not merely "about right": the pre-fix reader silently
    // substituted U+FFFD for every split glyph and the call still executed.
    expect(call!.arguments).toBe(args);
    expect(call!.arguments).not.toMatch(/\uFFFD/);
    const parsed = parseToolArguments(call!.arguments);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.content).toBe(body);
      expect(parsed.args.content.length).toBeGreaterThan(4096);
    }
  });

  it('a REAL cut is still rejected out loud — decoding never rescues severed bytes', async () => {
    // The 2026-08-30 audit: a truncated payload must never execute. This pins
    // that the decoder fix cannot be mistaken for a "repair" — bytes that never
    // arrived still fail the parser.
    const args = '{"chatId": "60dfc8a8", "content": "STEER: rulings × 4 — the note stops mid';
    const line = tcLine({ index: 0, id: 'call_C', function: { name: 'send_chat_message', arguments: args } });
    mockPost.mockResolvedValueOnce(bufferStreamOf([Buffer.from(line, 'utf8')]));

    const turn = await runModelTurn(GW, [{ role: 'user', content: 'go' }], undefined, {});
    await settle();

    const call = turn.toolCalls.find((t) => t.name === 'send_chat_message');
    expect(call).toBeDefined();
    const parsed = parseToolArguments(call!.arguments);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.shape).toBe('truncated');
  });
});