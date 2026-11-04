/**
 * Replay for ticket c42e8099 — the NON-STREAMING seam's fabricated-args hole.
 *
 * THE REPORT (project supervisor, chat daee2916, 2026-10-30T~03:0xZ): "my
 * tool-call payloads are being cut mid-stream tonight (5 cuts on one call
 * shape)", together with the fleet consequence it could verify — todo 89314741
 * in_progress with progressNote null while its executor lane's plan still read
 * 5/5 completed. The reporter's asks were (1) detect truncated/malformed args
 * BEFORE execution and refuse-with-retry rather than partially applying, (2)
 * count truncations per chat as a metric, (3) require the accompanying text on
 * status-only writes.
 *
 * WHAT MEASUREMENT SETTLED (fleet telemetry, kind `tool_call_finalize`, 12h
 * window read at 2026-10-30T03:13:30Z, total 173 rows). The five cuts are REAL
 * and they are in the data — 5 rows on chat daee2916 between 03:00:40Z and
 * 03:02:17Z, each `shape=truncated`, `argLen=64`, each paired with a gateway
 * row reading `recv=64 acc=64 drop=0`. But asks (1) and (2) were ALREADY
 * SHIPPED for that path: every one of the five was REJECTED at dispatch
 * (`seam: 'dispatch_reject'`) — NOTHING executed — and truncated calls are
 * already counted per chat by kind. The ledger flip did not come from a
 * half-applied truncated call either: that turn carried slots=2 named=2 with
 * only slot 1 broken, so the COMPLETE sibling call is what wrote the status.
 *
 * The defect this file pins is therefore the one the report pointed AT without
 * being able to see from a supervisor seat: a SECOND path into execution that
 * had no detector at all. `processToolCalls` (the non-streaming agentic loop
 * used by the Kimi K3 chat pipeline) parsed with
 *
 *     try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
 *
 * which is precisely what the 2026-08-30 harness audit outlawed and what
 * `coding/tool-arguments.ts` documents as the invariant at the streaming seam:
 * a TRUNCATED payload must never execute with fabricated/empty arguments. On
 * this seam a severed body became `{}`, the tool EXECUTED, and the model read a
 * success receipt for a call whose arguments never arrived — the silent
 * partial-apply class the ticket describes, on the one path that lacked the
 * guard.
 *
 * The fix routes this seam through the SAME parser and refusal text the
 * streaming path uses (`parseToolArguments` + `toolArgumentRejection`), so the
 * no-partial-apply guarantee holds on both. These tests replay the ticket's own
 * live cut shape (argLen 64) against the REAL seam.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

/**
 * This ticket's live dispatched shape: `todo_update` cut at exactly 64 chars
 * (`argLen=64`, `recv=64 acc=64 drop=0`). 64 dies INSIDE the todoId uuid of a
 * realistic complete body, so it is the measured cut rather than an invention.
 */
const COMPLETE_BODY =
  '{"todoId": "89314741-4c8f-4f4a-b481-fdd7f892d2b4", "status": "in_progress", "progressNote": "cohort dispositions start now"}';
const LIVE_CUT_LEN = 64;
const LIVE_CUT = COMPLETE_BODY.slice(0, LIVE_CUT_LEN);

const toolCall = (name: string, args: string, id = 'call_1') => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [{ id, type: 'function' as const, function: { name, arguments: args } }],
});

describe('replay c42e8099 — a severed payload never executes on the non-streaming seam', () => {
  const { processToolCalls } = require('./tool-executor');

  /** A cache whose execute is a spy — "did the tool run at all?" is the question. */
  const spyCache = () => {
    const getOrExecute = jest.fn(async (_name: string, _args: Record<string, any>) => 'TOOL RAN');
    return { cache: { getOrExecute } as any, getOrExecute };
  };

  it('the ticket live cut (todo_update @ 64 chars) is refused and the tool NEVER runs', async () => {
    const { cache, getOrExecute } = spyCache();
    const out = await processToolCalls(toolCall('todo_update', LIVE_CUT), cache);

    // THE regression: pre-fix this called getOrExecute with `{}` — a mutating
    // tool executed with fabricated args and answered success.
    expect(getOrExecute).not.toHaveBeenCalled();

    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg).toBeTruthy();
    expect(toolMsg.tool_call_id).toBe('call_1');
    // The model is told, in the SAME contract the streaming path ships: nothing
    // executed, the cut was transport, re-emit rather than shrink.
    expect(toolMsg.content).toContain('[tool call rejected]');
    expect(toolMsg.content).toContain('todo_update');
    expect(toolMsg.content).toContain('NOTHING was executed');
    expect(toolMsg.content).toContain('TRUNCATED IN TRANSIT');
    // The measured length travels with the refusal, so the next occurrence is
    // diagnosable from the transcript alone (the reporter had no shell).
    expect(toolMsg.content).toContain(String(LIVE_CUT_LEN));
  });

  it('an EMPTY arguments string stays a zero-arg call — the documented boundary, NOT a detector miss', async () => {
    // Deliberately pinned so nobody "fixes" this into a refusal later. An empty
    // `arguments` string is how OpenAI-compatible APIs encode a call that takes
    // NO arguments (`list_chats`, `todo_list` with defaults); `parseToolArguments`
    // documents it as `{ ok: true, args: {} }` for exactly that reason. A payload
    // severed to zero bytes is indistinguishable from that legitimate shape at
    // this seam, so refusing here would break every zero-arg tool to catch a
    // case this seam cannot see. The STRUCTURAL cut detection that CAN see it
    // lives up-stream (the streaming seam's depth/quote classifier), which is
    // where the ticket's five cuts were in fact caught.
    const { cache, getOrExecute } = spyCache();
    await processToolCalls(toolCall('todo_list', ''), cache);
    expect(getOrExecute).toHaveBeenCalledTimes(1);
    expect(getOrExecute).toHaveBeenCalledWith('todo_list', {});
  });

  it('a MALFORMED payload (complete but not JSON) is refused too', async () => {
    const { cache, getOrExecute } = spyCache();
    const out = await processToolCalls(toolCall('todo_update', '{"todoId": "abc",}'), cache);
    expect(getOrExecute).not.toHaveBeenCalled();
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content).toContain('NOTHING was executed');
    expect(toolMsg.content).toContain('todo_update');
  });

  it('a non-object payload (a bare array) is refused — args must be an object', async () => {
    const { cache, getOrExecute } = spyCache();
    const out = await processToolCalls(toolCall('todo_update', '["89314741"]'), cache);
    expect(getOrExecute).not.toHaveBeenCalled();
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content).toContain('NOTHING was executed');
  });

  it('a COMPLETE payload still executes, with its REAL args (no over-correction)', async () => {
    // The guard must be a detector, not a wall: the sibling complete call in the
    // reporter's own turn is exactly what legitimately wrote the ledger.
    const { cache, getOrExecute } = spyCache();
    const out = await processToolCalls(toolCall('todo_update', COMPLETE_BODY), cache);
    expect(getOrExecute).toHaveBeenCalledTimes(1);
    expect(getOrExecute).toHaveBeenCalledWith('todo_update', {
      todoId: '89314741-4c8f-4f4a-b481-fdd7f892d2b4',
      status: 'in_progress',
      progressNote: 'cohort dispositions start now',
    });
    const toolMsg = out.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content).toBe('TOOL RAN');
    expect(toolMsg.content).not.toContain('rejected');
  });

  it('a gateway-supplied object survives (the lossless `object` repair still runs)', async () => {
    // parseToolArguments accepts an already-parsed object: a gateway that hands
    // us `{}` for a legitimately argument-less tool must not be refused.
    const { cache, getOrExecute } = spyCache();
    const msg = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: 'call_9', type: 'function' as const, function: { name: 'list_chats', arguments: { page: 2 } as any } }],
    };
    await processToolCalls(msg, cache);
    expect(getOrExecute).toHaveBeenCalledWith('list_chats', { page: 2 });
  });

  it('one broken call does not suppress its COMPLETE sibling in the same turn', async () => {
    // The reporter's turn had slots=2, named=2, only slot 1 broken. The sibling
    // must still run — refusing the whole turn would have been the wrong repair.
    const { cache, getOrExecute } = spyCache();
    const msg = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        { id: 'call_bad', type: 'function' as const, function: { name: 'todo_update', arguments: LIVE_CUT } },
        { id: 'call_good', type: 'function' as const, function: { name: 'todo_get', arguments: '{"todoId":"89314741"}' } },
      ],
    };
    const out = await processToolCalls(msg, cache);
    expect(getOrExecute).toHaveBeenCalledTimes(1);
    expect(getOrExecute).toHaveBeenCalledWith('todo_get', { todoId: '89314741' });

    const tools = out.filter((m: any) => m.role === 'tool') as any[];
    expect(tools).toHaveLength(2);
    expect(tools[0].tool_call_id).toBe('call_bad');
    expect(tools[0].content).toContain('NOTHING was executed');
    expect(tools[1].tool_call_id).toBe('call_good');
    expect(tools[1].content).toBe('TOOL RAN');
  });
});