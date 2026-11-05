import { minimalMessages, minimalEvent, minimalParts, minimalText, minimalToolArgs, minimalChatDto, agentSenderTitle, classifyUserRow } from './minimal-view';
import { filterSseChunk, wrapSseResponse } from './minimal-sse';
import { resolveViewMode, resolveViewModeForRequest, isAdminViewer, __resetViewModeCacheForTests } from './view-mode';

jest.mock('../memory/context-store', () => {
  const rows = new Map<string, any>();
  return {
    storeGet: jest.fn(async (ns: string[], key: string) => rows.get(`${ns.join(':')}/${key}`) ?? null),
    storePut: jest.fn(async (ns: string[], key: string, value: any) => { rows.set(`${ns.join(':')}/${key}`, value); }),
  };
});

// Shared Redis (every backend box reads the same key) — an in-memory stand-in.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://test';
const mockRedis = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => mockRedis.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mockRedis.set(k, v); return 'OK'; }),
  },
}));

describe('minimal view — rows', () => {
  it('hides a machine wake and the turn it opens, keeps the human turn', () => {
    const rows = [
      { id: '1', role: 'user', content: 'hi' },
      { id: '2', role: 'assistant', content: 'hello' },
      { id: '3', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]\nsweep' },
      { id: '4', role: 'assistant', content: 'Sweep: nothing moved.' },
      { id: '5', role: 'user', content: 'thanks' },
      { id: '6', role: 'assistant', content: 'any time' },
    ];
    const out: any[] = minimalMessages(rows);
    expect(out).toHaveLength(6);
    expect(out.map(r => r.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(out[2].metadata.minimal.hidden).toBe(true);
    expect(out[2].content).toBe('');
    expect(out[3].metadata.minimal.hidden).toBe(true);
    expect(out[5].content).toBe('any time');
  });

  it('turns an inter-agent message into a one-line note and hides the reply', () => {
    const out: any[] = minimalMessages([
      { id: 'a', role: 'user', content: '[AGENT-SENT MESSAGE — from chat "Hyperstack 8xA100" (abcd1234), another Digby agent, NOT the owner.]\n\nimage works', metadata: { origin: 'agent' } },
      { id: 'b', role: 'assistant', content: 'noted' },
    ]);
    expect(out[0].metadata.minimal).toEqual({ note: 'message_from', label: 'Hyperstack 8xA100' });
    expect(out[1].metadata.minimal.hidden).toBe(true);
  });

  it('keeps owner-facing rows inside a machine turn', () => {
    const out: any[] = minimalMessages([
      { id: 'w', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]', metadata: { origin: 'schedule' } },
      { id: 'h', role: 'assistant', content: 'Here is your file', metadata: { kind: 'deliverable_handoff' } },
      { id: 'w2', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]', metadata: { origin: 'schedule', scheduleOwnerArmed: true } },
      { id: 'd', role: 'assistant', content: 'Your morning digest' },
    ]);
    expect(out[1].content).toBe('Here is your file');
    expect(out[3].content).toBe('Your morning digest');
    expect(out[0].metadata.minimal.hidden).toBe(true);
  });

  it('a background continuation of the person\'s own ask stays visible; a lane continuation does not', () => {
    const out: any[] = minimalMessages([
      { id: 'u', role: 'user', content: 'build the deck' },
      { id: 'a', role: 'assistant', content: 'Still working on this — I will post the result here.' },
      { id: 'c', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]\n[HARNESS CONTINUATION r1/3] finish', metadata: { origin: 'schedule' } },
      { id: 'r', role: 'assistant', content: 'Here is the deck.' },
      { id: 'w', role: 'user', content: '[MACHINE-TRIGGERED RUN — hook]', metadata: { origin: 'hook' } },
      { id: 'x', role: 'assistant', content: 'lane note' },
      { id: 'c2', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]\n[HARNESS CONTINUATION r1/3]', metadata: { origin: 'schedule' } },
      { id: 'r2', role: 'assistant', content: 'lane continuation' },
    ]);
    expect(out[2].metadata.minimal.hidden).toBe(true);
    expect(out[3].content).toBe('Here is the deck.');
    expect(out[5].metadata.minimal.hidden).toBe(true);
    expect(out[7].metadata.minimal.hidden).toBe(true);
  });

  it('a watch the person accepted: its findings show, its quiet runs do not', () => {
    const out: any[] = minimalMessages([
      { id: 'w1', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]\ncheck inbox', metadata: { origin: 'schedule', scheduleOwnerArmed: true } },
      { id: 'q', role: 'assistant', content: 'Nothing new.', metadata: { kind: 'owner_digest' } },
      { id: 'w2', role: 'user', content: '[MACHINE-TRIGGERED RUN — schedule]\ncheck inbox', metadata: { origin: 'schedule', scheduleOwnerArmed: true } },
      { id: 'f', role: 'assistant', content: 'Danielle replied: the hearing moved to Nov 3.', metadata: { kind: 'owner_digest' } },
    ]);
    expect(out[1].metadata.minimal.hidden).toBe(true);
    expect(out[3].content).toBe('Danielle replied: the hearing moved to Nov 3.');
  });

  it('reads flattened origin fields (fleet thread rows)', () => {
    const out: any[] = minimalMessages([
      { id: 'w', role: 'user', content: 'wake body', origin: 'hook' },
      { id: 'r', role: 'assistant', content: 'done', origin: 'hook' },
    ]);
    expect(out[0].minimal.hidden).toBe(true);
    expect(out[1].minimal.hidden).toBe(true);
  });

  it('strips harness chrome, models and spend from a kept answer', () => {
    const out: any[] = minimalMessages([
      { id: '1', role: 'user', content: 'do it' },
      {
        id: '2', role: 'assistant',
        content: 'Done.\n\n✓ Auto-verify passed (typecheck, lint).',
        metadata: { modelUsed: 'glm-5.3', spendUsd: 1.2, followUps: ['x'] },
        parts: [
          { type: 'reasoning', text: 'secret thoughts' },
          { type: 'tool_call', name: 'run_command', args: { command: 'npm test', env: { TOKEN: 'x' } } },
          { type: 'tool_result', name: 'run_command', result: 'PASS 120 tests' },
          { type: 'tool_call', name: 'update_plan', args: { steps: [] } },
          { type: 'text', text: '[HARNESS EVIDENCE GUARD] blah', marker: 'guard' },
          { type: 'subagent', title: 'worker' },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]);
    const a = out[1];
    expect(a.content).toBe('Done.');
    expect(a.metadata).toEqual({ followUps: ['x'] });
    expect(a.parts).toEqual([
      { type: 'tool_call', name: 'run_command', args: { command: 'npm test' } },
      { type: 'tool_result', name: 'run_command', result: '' },
      { type: 'text', text: 'Done.' },
    ]);
  });
});

describe('minimal view — pieces', () => {
  it('a replaced final reads as withdrawn', () => {
    expect(minimalText('[HARNESS EVIDENCE GUARD — THIS RUN\'S FINAL ANSWER WAS REPLACED]\n--- BEGIN')).toBe('This update was withdrawn.');
  });
  it('tool args keep one short label', () => {
    expect(minimalToolArgs({ path: 'src/a.ts', content: 'x'.repeat(9999) })).toEqual({ path: 'src/a.ts' });
    expect(minimalToolArgs('{"query":"weather"}')).toEqual({ query: 'weather' });
    expect(minimalToolArgs({ body: 'x' })).toEqual({});
    expect(minimalToolArgs({ prompt: 'Name: Counsel email watch\nCheck Gmail for…', kind: 'recurring' })).toEqual({ name: 'Counsel email watch' });
    expect(minimalToolArgs({ command: 'a'.repeat(400) }).command.length).toBeLessThanOrEqual(160);
  });
  it('task cards lose steps, receipts, spend and ETA', () => {
    const [p]: any = minimalParts([{ type: 'task', task: { taskId: 't', title: 'Deck', status: 'running', steps: { done: 2, total: 5 }, receipts: { ok: 3, total: 3 }, spendUsd: 4.2, etaText: '5 min' } }]);
    expect(p.task).toEqual({ taskId: 't', title: 'Deck', status: 'running', steps: { done: 0, total: 0 }, receipts: { ok: 0, total: 0 }, spendUsd: 0 });
  });
  it('sender title parses', () => {
    expect(agentSenderTitle('[AGENT-SENT MESSAGE — from chat "Lane A" (1234abcd), x]')).toBe('Lane A');
    expect(agentSenderTitle('hello')).toBeUndefined();
    // The harness step half ("· idle since 17:39Z") is the sender's stale state — the note names the sender only.
    expect(agentSenderTitle('[AGENT-SENT MESSAGE — from chat "crossmodel Supervisor · idle since 17:39Z" (1234abcd), x]')).toBe('crossmodel Supervisor');
  });
  it('depth keeps only what the client reads — never the team line with model ids (prod check 2026-10-16)', () => {
    const [, a]: any[] = minimalMessages([
      { id: 'u', role: 'user', content: 'q' },
      { id: 'a', role: 'assistant', content: 'x', metadata: { depth: {
        plan: { preset: 'single_thinking', lane: 'quick', spawnChecker: false },
        team: { line: 'Standard · glm-5.3', members: [{ role: 'lead', model: 'glm-5.3' }] },
        facts: { leadToolCalls: 0 }, budget: { checker: false }, turnPlan: { lane: 'quick' },
      } } },
    ]);
    expect(a.metadata.depth).toEqual({ plan: { preset: 'single_thinking', lane: 'quick', spawnChecker: false } });
    expect(JSON.stringify(a.metadata)).not.toContain('glm');
  });

  it('supervisor DTO drops doctrine prompt and lead seat', () => {
    const dto: any = minimalChatDto({ id: 'c', isSupervisor: true, systemPrompt: 'doctrine', leadModel: 'glm', messages: [] });
    expect(dto.systemPrompt).toBeUndefined();
    expect(dto.leadModel).toBeUndefined();
    const plain: any = minimalChatDto({ id: 'c', systemPrompt: 'be brief', messages: [] });
    expect(plain.systemPrompt).toBe('be brief');
  });
});

describe('minimal view — events', () => {
  it('drops machinery events and reduces tool events', () => {
    expect(minimalEvent('guard_marker', { text: 'x' })).toBeNull();
    expect(minimalEvent('context', { usage: {} })).toBeNull();
    expect(minimalEvent('verify_result', {})).toBeNull();
    expect(minimalEvent('tool_call', { name: 'read_file', args: { path: 'a.ts', offset: 3 } })).toEqual({ type: 'tool_call', data: { name: 'read_file', args: { path: 'a.ts' } } });
    expect(minimalEvent('tool_result', { name: 'read_file', result: 'secret' })).toEqual({ type: 'tool_result', data: { name: 'read_file', result: '' } });
    expect(minimalEvent('init', { sessionId: 's', model: 'glm', modelSource: 'seat' })).toEqual({ type: 'init', data: { sessionId: 's' } });
    expect(minimalEvent('progress', { message: 'Working' })).toEqual({ type: 'progress', data: { message: 'Working' } });
    expect(minimalEvent('model-response', { model: 'x', response: 'draft', persona: 'Double Checker' })).toBeNull();
    expect(minimalEvent('agent-activity', { kind: 'sub_start', label: 'Double Checker' })).toBeNull();
    expect(minimalEvent('agent-activity', { kind: 'tool', label: 'Digby', name: 'search_engine', detail: 'weather' })).toEqual({ type: 'agent-activity', data: { kind: 'tool', label: 'Digby', name: 'search_engine', detail: 'weather' } });
  });
  it('filters the complete payload', () => {
    const out: any = minimalEvent('complete', { finalText: 'ok\n\n✓ Auto-verify passed (lint).', parts: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'ok' }], models: { a: 1 } });
    expect(out.data.finalText).toBe('ok');
    expect(out.data.parts).toEqual([{ type: 'text', text: 'ok' }]);
    expect(out.data.models).toEqual({ a: {} });
  });
});

describe('minimal view — SSE seam', () => {
  it('filters frames and drops empty writes', () => {
    expect(filterSseChunk(': hb\n\n')).toBe(': hb\n\n');
    expect(filterSseChunk(`data: ${JSON.stringify({ type: 'guard_marker', data: {} })}\n\n`)).toBeNull();
    const kept = filterSseChunk(`id: r:3\ndata: ${JSON.stringify({ type: 'tool_result', data: { name: 'x', result: 'big' }, ts: 't' })}\n\n`);
    expect(kept).toBe(`id: r:3\ndata: ${JSON.stringify({ type: 'tool_result', data: { name: 'x', result: '' }, ts: 't' })}\n\n`);
  });
  it('wraps only for minimal viewers', () => {
    const written: string[] = [];
    const res = { write: (c: string) => { written.push(c); return true; }, writableEnded: false };
    expect(wrapSseResponse(res, 'full')).toBe(res);
    const w = wrapSseResponse(res, 'minimal');
    w.write(`data: ${JSON.stringify({ type: 'context', data: {} })}\n\n`);
    w.write(`data: ${JSON.stringify({ type: 'text', data: { delta: 'hi' } })}\n\n`);
    expect(written).toHaveLength(1);
    expect(w.writableEnded).toBe(false);
  });
});

describe('view mode resolution', () => {
  const env = process.env.MINIMAL_VIEW_DISABLED;
  afterEach(() => { process.env.MINIMAL_VIEW_DISABLED = env; __resetViewModeCacheForTests(); });
  it('users are minimal, admins full by default, the switch restores full for all', async () => {
    delete process.env.MINIMAL_VIEW_DISABLED;
    expect(await resolveViewMode({ id: 'u', role: 'USER', email: 'a@b.c' })).toBe('minimal');
    expect(await resolveViewMode(null)).toBe('minimal');
    expect(await resolveViewMode({ id: 'admin1', role: 'ADMIN' })).toBe('full');
    expect(isAdminViewer({ role: 'USER', email: 'example-user@example.com' })).toBe(true);
    // Self-host 2026-10-20: the owner-email fallback is PRODUCTION-only — on any other instance kind
    // (open registration) that address is an ordinary user; the ADMIN role is the only admin there.
    const prevKind = process.env.DIGBY_INSTANCE;
    process.env.DIGBY_INSTANCE = 'selfhost';
    try {
      expect(isAdminViewer({ role: 'USER', email: 'example-user@example.com' })).toBe(false);
      expect(isAdminViewer({ role: 'ADMIN', email: 'anyone@example.com' })).toBe(true);
    } finally {
      if (prevKind !== undefined) process.env.DIGBY_INSTANCE = prevKind; else delete process.env.DIGBY_INSTANCE;
    }
    process.env.MINIMAL_VIEW_DISABLED = '1';
    expect(await resolveViewMode({ id: 'u', role: 'USER' })).toBe('full');
  });
  it('the verification account may ask for the full view per request; nobody else can', async () => {
    delete process.env.MINIMAL_VIEW_DISABLED;
    const bot = { id: 'b', role: 'USER', email: 'claudebot@digby.ai' };
    expect(await resolveViewModeForRequest({ user: bot, headers: {} })).toBe('minimal');
    expect(await resolveViewModeForRequest({ user: bot, headers: { 'x-digby-view': 'full' } })).toBe('full');
    expect(await resolveViewModeForRequest({ user: bot, headers: {}, query: { view: 'full' } })).toBe('full');
    const user = { id: 'u', role: 'USER', email: 'someone@example.com' };
    expect(await resolveViewModeForRequest({ user, headers: { 'x-digby-view': 'full' }, query: { view: 'full' } })).toBe('minimal');
    expect(await resolveViewModeForRequest({ headers: { 'x-digby-view': 'full' } })).toBe('minimal');
    const prev = process.env.VIEW_MODE_DEBUG_EMAILS;
    process.env.VIEW_MODE_DEBUG_EMAILS = '';
    try { expect(await resolveViewModeForRequest({ user: bot, headers: { 'x-digby-view': 'full' } })).toBe('minimal'); }
    finally { if (prev === undefined) delete process.env.VIEW_MODE_DEBUG_EMAILS; else process.env.VIEW_MODE_DEBUG_EMAILS = prev; }
  });

  it('an admin with Debug mode off is minimal', async () => {
    delete process.env.MINIMAL_VIEW_DISABLED;
    const { setDebugMode } = await import('./view-mode');
    await setDebugMode('admin2', false);
    expect(await resolveViewMode({ id: 'admin2', role: 'ADMIN' })).toBe('minimal');
  });

  it('a Debug flip on one box is seen at once by every other box (no per-process cache)', async () => {
    delete process.env.MINIMAL_VIEW_DISABLED;
    const { setDebugMode } = await import('./view-mode');
    await setDebugMode('admin3', false);
    expect(await resolveViewMode({ id: 'admin3', role: 'ADMIN' })).toBe('minimal');
    // Another box turns it back on (writes the shared key) — this process must not serve a stale 'minimal'.
    mockRedis.set('view:debug:admin3', '1');
    expect(await resolveViewMode({ id: 'admin3', role: 'ADMIN' })).toBe('full');
    // A cold Redis falls back to the store (and re-primes the key).
    mockRedis.delete('view:debug:admin3');
    expect(await resolveViewMode({ id: 'admin3', role: 'ADMIN' })).toBe('minimal');
    expect(mockRedis.get('view:debug:admin3')).toBe('0');
  });
});

/**
 * ============================================================================
 * DETECTOR-RECALL REPLAY — ticket 739e8191
 * ============================================================================
 * This change relaxes a RECALL predicate (wakeIsOwnerFacing, which decides
 * whether a minimum viewer sees the reply at all), so these cases re-assert
 * the PRIOR true positives still fire. Owner report (chat 99e63f86): "you dont
 * see to communicate with the user/human after you get a message from a sub
 * session ie...you should then relay to me whatever message was sent back from
 * the subsession … ie the agent has finished the work and everything is done".
 * md() already flattened childResult but NOTHING consumed it, so a delivered
 * sub-session result was hidden from the minimal view.
 */
describe('minimal view — delivered sub-session results (ticket 739e8191)', () => {
  const wake = (id: string, metadata: any, content = '[MACHINE-TRIGGERED RUN — EVENT HOOK FIRED]\nwake') =>
    ({ id, role: 'user', content, metadata });

  it('keeps the reply of a child-result wake — the owner is waiting on that delivery', () => {
    const out = minimalMessages([
      wake('k1', { origin: 'hook', childResult: true }),
      { id: 'k2', role: 'assistant', content: 'The lane finished — the last fix landed.' },
    ] as any);
    expect((out[1] as any).minimal).toBeUndefined();
    expect(out[1].content).toContain('last fix landed');
  });

  it('DETECTOR-RECALL REPLAY: an unarmed machine wake reply is STILL a hidden stub', () => {
    const out = minimalMessages([
      wake('w1', { origin: 'hook' }),
      { id: 'w2', role: 'assistant', content: 'Status: nominal, nothing to do.' },
    ] as any);
    expect((out[1] as any).minimal?.hidden).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY: a quiet "nothing new" watch reply is STILL hidden', () => {
    const out = minimalMessages([
      wake('q1', { origin: 'hook', childResult: true }),
      { id: 'q2', role: 'assistant', content: 'Nothing new.' },
    ] as any);
    expect((out[1] as any).minimal?.hidden).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY: a non-child [AGENT-SENT MESSAGE] relay is STILL an agent stub', () => {
    const row = {
      id: 's1', role: 'user',
      content: '[AGENT-SENT MESSAGE — from chat "other lane" (sibling3) in project "p", another Digby agent, NOT the owner.]\nhello',
      metadata: { origin: 'agent', sourceChatId: 'sibling-3' },
    };
    expect(classifyUserRow(row as any)).toBe('agent');
    const out = minimalMessages([row, { id: 's2', role: 'assistant', content: 'Acknowledged.' }] as any);
    expect((out[0] as any).minimal?.note).toBe('message_from');
  });
});

/**
 * Ticket 739e8191 — REVIEW MAJOR regression pin.
 *
 * Real assistant rows are STAMPED with the turn's own machine origin
 * (chat-agent.service.ts ~:7806, run-executor.ts ~:973), so `isMachineAssistant`
 * is true BY CONSTRUCTION on the reply. The first cut of this fix set
 * `turnOwnerFacing` but still gated on `!isMachineAssistant(row)`, which
 * re-hid the very reply it was meant to surface. This fixture carries the
 * stamp — which the earlier fixture omitted, hiding the bug.
 */
describe('minimal view — child-result reply carrying its OWN machine origin stamp', () => {
  it('the child relay flattens the marker and the STAMPED reply is still kept', () => {
    const out = minimalMessages([
      // The fleet thread flattens `childResult` onto the relay row (top level).
      { id: 'r1', role: 'user', childResult: true, origin: 'agent',
        content: '[AGENT-SENT MESSAGE — from chat "lane" (child9) in project "p", another Digby agent, NOT the owner.]\nfinished',
        metadata: { origin: 'agent', sourceChatId: 'child-9' } },
      // REAL shape: the reply inherits the turn origin, so it IS machine-stamped.
      { id: 'r2', role: 'assistant', origin: 'agent',
        content: 'The lane finished — here is what it delivered.',
        metadata: { origin: 'agent', sourceChatId: 'child-9' } },
    ] as any);
    expect((out[1] as any).minimal).toBeUndefined(); // NOT stubbed
    expect(out[1].content).toContain('here is what it delivered');
  });

  it('DETECTOR-RECALL REPLAY: an agent-stamped reply in a turn WITHOUT the marker stays hidden', () => {
    const out = minimalMessages([
      { id: 'n1', role: 'user', content: '[AGENT-SENT MESSAGE — from chat "other" (sibl3), another Digby agent, NOT the owner.]\nhi',
        metadata: { origin: 'agent', sourceChatId: 'sibling-3' } },
      { id: 'n2', role: 'assistant', content: 'Acknowledged.', metadata: { origin: 'agent' } },
    ] as any);
    expect((out[1] as any).minimal?.hidden).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY: a quiet "nothing new" reply in a marked turn is STILL hidden', () => {
    const out = minimalMessages([
      { id: 'q1', role: 'user', childResult: true, metadata: { origin: 'hook', childResult: true }, content: '[MACHINE-TRIGGERED RUN — EVENT HOOK FIRED]\nwake' },
      { id: 'q2', role: 'assistant', metadata: { origin: 'hook' }, content: 'Nothing new.' },
    ] as any);
    expect((out[1] as any).minimal?.hidden).toBe(true);
  });
});
