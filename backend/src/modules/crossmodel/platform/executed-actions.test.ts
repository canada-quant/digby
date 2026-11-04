/**
 * Pins the executed-action extractor (executed-actions.ts) — the ground truth
 * the phantom-claim verifier compares supervisor notes against. Leaf module,
 * no mocks needed.
 */
import { extractExecutedActions, successfulActions, hasActionClaimKeywords, extractTaskExecutions, parseTaskResult, isTaskDelegationClaimDetail, isTaskDelegationTool } from './executed-actions';

const env = (tool: string, ids: Record<string, string>) => JSON.stringify({ ok: true, tool, ids, message: 'x' });

describe('extractExecutedActions', () => {
  it('returns empty for missing/empty parts', () => {
    expect(extractExecutedActions(undefined)).toEqual([]);
    expect(extractExecutedActions([])).toEqual([]);
  });

  it('pairs a tool_call with its envelope tool_result and extracts ids', () => {
    const parts = [
      { type: 'text', text: 'thinking' },
      { type: 'tool_call', name: 'start_coding_session', args: {} },
      { type: 'tool_result', name: 'start_coding_session', result: env('start_coding_session', { sessionId: 'abc-123' }) },
    ];
    expect(extractExecutedActions(parts)).toEqual([
      { tool: 'start_coding_session', ok: true, staged: false, ids: { sessionId: 'abc-123' } },
    ]);
  });

  it('marks a needsConfirmation result as staged, not executed', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message' },
      { type: 'tool_result', name: 'send_chat_message', result: JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf_1' }) },
    ];
    const [a] = extractExecutedActions(parts);
    expect(a.ok).toBe(false);
    expect(a.staged).toBe(true);
  });

  it('recognizes legacy prose successes (pre-envelope results)', () => {
    const parts = [
      { type: 'tool_call', name: 'start_coding_session' },
      { type: 'tool_result', name: 'start_coding_session', result: 'Started coding session 9f8e7d6c-1111-2222-3333-444455556666 "T" on branch b (base main, model m, permissions auto).' },
      { type: 'tool_call', name: 'schedule_message' },
      { type: 'tool_result', name: 'schedule_message', result: 'Scheduled (recurring, id 0a1b2c3d-9) on chat x. Next run at t.' },
    ];
    const out = extractExecutedActions(parts);
    expect(out[0]).toMatchObject({ ok: true, ids: { sessionId: '9f8e7d6c-1111-2222-3333-444455556666' } });
    expect(out[1]).toMatchObject({ ok: true, ids: { scheduleId: '0a1b2c3d-9' } });
  });

  it('counts an error/refusal result as not executed', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message' },
      { type: 'tool_result', name: 'send_chat_message', result: 'Chat not found: "x" — no chat with that exact id is visible to you.' },
    ];
    const [a] = extractExecutedActions(parts);
    expect(a.ok).toBe(false);
    expect(a.staged).toBe(false);
  });

  it('a call with NO result stays not-executed; untracked tools are ignored', () => {
    const parts = [
      { type: 'tool_call', name: 'start_coding_session' },
      { type: 'tool_call', name: 'list_chats' },
      { type: 'tool_result', name: 'list_chats', result: '[]' },
    ];
    const out = extractExecutedActions(parts);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
  });

  it('pairs same-name calls in order', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message' },
      { type: 'tool_call', name: 'send_chat_message' },
      { type: 'tool_result', name: 'send_chat_message', result: env('send_chat_message', { chatId: 'first' }) },
      { type: 'tool_result', name: 'send_chat_message', result: 'error: nope' },
    ];
    const out = extractExecutedActions(parts);
    expect(out[0]).toMatchObject({ ok: true, ids: { chatId: 'first' } });
    expect(out[1].ok).toBe(false);
  });

  it('lifts the envelope top-level receiptId into ids (ticket 6f01288e — the model is told to cite it; the verifier must be able to resolve it)', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message' },
      {
        type: 'tool_result', name: 'send_chat_message',
        result: JSON.stringify({
          ok: true, tool: 'send_chat_message',
          receiptId: 'd7553cbe-1111-2222-3333-444455556666',
          ids: { chatId: '6f26a274-26f3-485b-971b-8ca357ad7edc' },
          message: 'queued',
        }),
      },
    ];
    const [a] = extractExecutedActions(parts);
    expect(a).toMatchObject({
      ok: true,
      ids: { chatId: '6f26a274-26f3-485b-971b-8ca357ad7edc', receiptId: 'd7553cbe-1111-2222-3333-444455556666' },
    });
  });

  it('successfulActions filters to ok', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message' },
      { type: 'tool_result', name: 'send_chat_message', result: env('send_chat_message', { chatId: 'c1' }) },
      { type: 'tool_call', name: 'schedule_message' },
      { type: 'tool_result', name: 'schedule_message', result: 'schedule_message requires intervalMinutes > 0 (minimum 15).' },
    ];
    expect(successfulActions(parts)).toHaveLength(1);
  });

  it('tracks file_feedback via BOTH prose success shapes — fresh filing and dedup bump (ticket ae085617)', () => {
    const parts = [
      { type: 'tool_call', name: 'file_feedback' },
      { type: 'tool_result', name: 'file_feedback', result: 'Filed feedback ticket 3f09a1bc-aaaa-bbbb-cccc-dddddddddddd (bug_report, priority 3): "T". The triage queue handles it from here — do not follow up on it in this run.' },
      { type: 'tool_call', name: 'file_feedback' },
      { type: 'tool_result', name: 'file_feedback', result: 'Already tracked as ticket 9c8b7a6d-1111-2222-3333-444455556666 ("T", priority 2, seen 4 times) — bumped its priority/occurrence count instead of filing a duplicate.' },
      { type: 'tool_call', name: 'file_feedback' },
      { type: 'tool_result', name: 'file_feedback', result: 'Feedback NOT filed (rate limit reached): cap.' },
    ];
    const out = extractExecutedActions(parts);
    expect(out[0]).toMatchObject({ tool: 'file_feedback', ok: true, ids: { ticketId: '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd' } });
    expect(out[1]).toMatchObject({ ok: true, ids: { ticketId: '9c8b7a6d-1111-2222-3333-444455556666' } });
    expect(out[2]).toMatchObject({ ok: false });
  });
});

describe('task-delegation lane (ticket 61b9200a — the phantom computer-task claim in chat 0945e820)', () => {
  it('extractTaskExecutions vouches for a computer_task that ran — the incident shape, verbatim header', () => {
    // The real prod shape (chat 0945e820): the task ran 12 steps on the
    // user's Mac and found nothing. The claim ("I ran a computer task to
    // find the PDF") was TRUE — pre-fix no pool entry could vouch for it.
    const parts = [
      { type: 'tool_call', name: 'computer_task', args: { task: 'find the PDF' } },
      { type: 'tool_result', name: 'computer_task', result: '[Computer task result — steps: 12 · mac: connected (MacBook Pro)]\nI was unable to locate the requested PDF file on the Mac.' },
    ];
    const [a] = extractTaskExecutions(parts);
    expect(a).toMatchObject({ tool: 'computer_task', ok: true, ids: { taskTool: 'computer_task', steps: '12' } });
  });

  it('extractTaskExecutions pairs call→result FIFO and leaves an unanswered call NOT executed', () => {
    const parts = [
      { type: 'tool_call', name: 'browser_task', args: { task: 'x' } },
      { type: 'tool_call', name: 'browser_task', args: { task: 'y' } },
      { type: 'tool_result', name: 'browser_task', result: '[Browser agent result — driver: cloud, steps: 4]\nfound it' },
    ];
    const out = extractTaskExecutions(parts);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ok: true, ids: { steps: '4' } });
    expect(out[1]).toMatchObject({ ok: false, ids: {} }); // no result — never ran
  });

  it('steps: 0 (the capability-gate shape) is NOT an execution', () => {
    const parts = [
      { type: 'tool_call', name: 'computer_task' },
      { type: 'tool_result', name: 'computer_task', result: '[COMPUTER_TASK — UNAVAILABLE]\nNo paired Mac is online.\n[Computer task result — steps: 0 · mac: offline]\n' },
    ];
    expect(extractTaskExecutions(parts)).toHaveLength(1);
    expect(extractTaskExecutions(parts)[0]).toMatchObject({ ok: false });
  });

  it('a banner-prepended browser header still parses (read-only session that DID run)', () => {
    const parts = [
      { type: 'tool_call', name: 'browser_task' },
      { type: 'tool_result', name: 'browser_task', result: '[BROWSER_TASK — INTERACTION UNAVAILABLE (hard capability limit)]\nThe cloud driver cannot click/type.\n[Browser agent result — driver: cloud, steps: 3 · why: no local fallback]\nread-only findings here' },
    ];
    const [a] = extractTaskExecutions(parts);
    expect(a).toMatchObject({ tool: 'browser_task', ok: true, ids: { steps: '3' } });
  });

  it('executor error prose (no header) is NOT an execution', () => {
    for (const result of [
      'No task provided for computer use.',
      'The browser agent finished without a result. Answer from the information you already have.',
      'Tool call failed: socket hang up',
      'Computer use is only available for signed-in users (it drives THEIR paired Mac).',
    ]) {
      expect(parseTaskResult('computer_task', result)).toEqual({ ok: false, ids: {} });
    }
  });

  it('extractTaskExecutions never touches the 7 platform tools (disjoint from extractExecutedActions)', () => {
    const parts = [
      { type: 'tool_call', name: 'send_chat_message' },
      { type: 'tool_result', name: 'send_chat_message', result: '{"ok":true,"ids":{"chatId":"c1"}}' },
      { type: 'tool_call', name: 'start_coding_session' },
      { type: 'tool_result', name: 'start_coding_session', result: '{"ok":true,"ids":{"sessionId":"s1"}}' },
    ];
    expect(extractTaskExecutions(parts)).toEqual([]);
    expect(extractExecutedActions(parts)).toHaveLength(2);
  });

  it('isTaskDelegationClaimDetail recognizes the narration idioms the extractor sees', () => {
    expect(isTaskDelegationClaimDetail('I ran a computer task to find the PDF')).toBe(true);
    expect(isTaskDelegationClaimDetail('the browser task did dispatch to your Mac\'s local browser with instructions to go to optcgsim.com')).toBe(true);
    expect(isTaskDelegationClaimDetail('I ran computer use on the Mac to check Mail')).toBe(true);
    expect(isTaskDelegationClaimDetail('a browser agent looked at the page')).toBe(true);
    expect(isTaskDelegationClaimDetail('I dispatched three workers to the fleet lane')).toBe(false);
    expect(isTaskDelegationClaimDetail('Started a coding session for the fix')).toBe(false);
    expect(isTaskDelegationClaimDetail('')).toBe(false);
  });

  it('isTaskDelegationTool covers exactly the two task tools', () => {
    expect(isTaskDelegationTool('computer_task')).toBe(true);
    expect(isTaskDelegationTool('browser_task')).toBe(true);
    expect(isTaskDelegationTool('start_coding_session')).toBe(false);
    expect(isTaskDelegationTool('dispatch_platform_task')).toBe(false);
    expect(isTaskDelegationTool('')).toBe(false);
  });
});

describe('hasActionClaimKeywords (the verifier pre-gate — ticket ae085617)', () => {
  it('matches the claim vocabulary: dispatch / sent / scheduled / filed / ticket / queued / session-start', () => {
    expect(hasActionClaimKeywords('I dispatched three workers.')).toBe(true);
    expect(hasActionClaimKeywords('Message sent to the overseer chat.')).toBe(true);
    expect(hasActionClaimKeywords('Scheduled a nightly wake at 02:00Z.')).toBe(true);
    expect(hasActionClaimKeywords("I've filed a ticket for this (id ab12cd34).")).toBe(true);
    expect(hasActionClaimKeywords('Queued the nudge behind the active run.')).toBe(true);
    expect(hasActionClaimKeywords('Started a coding session for the fix.')).toBe(true);
  });

  it('matches the task-delegation idiom (ticket 61b9200a) — the incident note reaches the extractor', () => {
    expect(hasActionClaimKeywords('I ran a computer task to find the PDF — no copy exists on the Mac.')).toBe(true);
    expect(hasActionClaimKeywords('The browser task came back with four steps and a summary.')).toBe(true);
    expect(hasActionClaimKeywords('computer_task returned the Spotlight results above.')).toBe(true);
    expect(hasActionClaimKeywords('I used computer use to check the screen.')).toBe(true);
  });

  it('stays quiet on ordinary answers — no keywords, no LLM call', () => {
    expect(hasActionClaimKeywords('The capital of France is Paris; its population is about 2.1M.')).toBe(false);
    expect(hasActionClaimKeywords('My computer is a laptop and the browser is Safari.')).toBe(false);
    expect(hasActionClaimKeywords('The task you described sounds straightforward.')).toBe(false);
    expect(hasActionClaimKeywords('')).toBe(false);
    expect(hasActionClaimKeywords(null)).toBe(false);
    expect(hasActionClaimKeywords(undefined)).toBe(false);
  });
});
