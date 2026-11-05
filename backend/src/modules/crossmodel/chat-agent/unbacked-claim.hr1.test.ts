/**
 * HR-1 (todo 76fd0cce, backlog docs/FRAMEWORK_BACKLOG.md "HR-1") — the unbacked
 * claim check judged the DELIVERED attempt's parts only, so a FALSE honest line
 * shipped whenever another attempt of the same turn really acted:
 *
 *   (1) attempt 1 ran `update_supervisor_state`, the zero-tool retry says "I've
 *       updated the supervisor ledger" → the rewrite said "I have not made that
 *       change yet — nothing was changed in this answer." (a change HAD been made)
 *   (2) the unbacked retry really called `send_chat_message` but returned EMPTY
 *       text → attempt 1's claim was rewritten to "I have not sent that message
 *       yet — nothing went out in this answer." (a message HAD gone out)
 *   (3) `READ_TOOL_RE`'s `resolve_` prefix read the MUTATING `resolve_feedback`
 *       as a read, so a TRUE "I've closed your ticket" was rewritten.
 *
 * The pre-existing behaviours these tests PIN are the rounds 3–6 of PR #1878,
 * enumerated in the backlog entry under "Do NOT repeat": class-level backing from
 * every earlier attempt, mid-name connector reads counted as writes, and feeding
 * all attempts' parts into the claim functions (which switched off the zero-tool
 * lanes). Each of those must stay exactly as it was.
 */
const mockPrisma: any = { runToolReceipt: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) } };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  backedClaimClasses, isWriteToolName, priorAttemptToolCalls, turnBackingForClaim, bestTurnBacking,
  turnBackedClaimLine, residualUnbackedClaims, rewriteUnbackedClaims, HONEST_CLAIM_LINES,
} from './unbacked-claim';

const call = (name: string, args: unknown = {}) => ({ type: 'tool_call', name, args });

beforeEach(() => {
  for (const k of ['SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED', 'SUPERVISOR_UNBACKED_CLAIM_REWRITE_DISABLED',
    'SUPERVISOR_UNBACKED_ACTION_RETRY_DISABLED', 'SUPERVISOR_UNBACKED_CLOCK_NARROW_DISABLED']) delete process.env[k];
});

// ── the allow-list ───────────────────────────────────────────────────────────
describe('HR-1 — the write ALLOW-list (never a read-prefix deny-list)', () => {
  it('resolve_feedback (case 3) is a WRITE — READ_TOOL_RE\'s resolve_ prefix used to call it a read', () => {
    expect(isWriteToolName('resolve_feedback')).toBe(true);
    expect(backedClaimClasses([call('resolve_feedback')]).change).toBe(true);
  });

  it('platform mutating tools, connector writes and the document/browser writes back a change', () => {
    for (const n of ['update_supervisor_state', 'todo_update', 'goal_premise_set', 'file_feedback', 'store_secret',
      'gmail_send_email', 'slack_post_message', 'create_document', 'browser_task', 'generate_image']) {
      expect(isWriteToolName(n)).toBe(true);
    }
  });

  it('reads never back a change — including a mid-name connector read and a user-MCP *_search', () => {
    for (const n of ['gmail_get_message', 'github_list_issues', 'slack_get_channel_history', 'mcp_notion_search',
      'mcp_notion_list_issues', 'web_pipe', 'search_memory', 'list_chats', 'get_chat_status', 'resolve_id']) {
      expect(isWriteToolName(n)).toBe(false);
    }
  });

  it('an UNKNOWN name backs NOTHING (the old deny-list let any unrecognised name back a fabricated claim)', () => {
    expect(isWriteToolName('some_future_tool')).toBe(false);
    expect(isWriteToolName('')).toBe(false);
    expect(isWriteToolName(undefined)).toBe(false);
    expect(backedClaimClasses([call('some_future_tool')]).change).toBe(false);
    // still "a tool ran" — the done-opener exemption keeps its own meaning
    expect(backedClaimClasses([call('some_future_tool')]).any).toBe(true);
  });

  it('a user-MCP tool whose own tail is not a read verb counts as a write', () => {
    expect(isWriteToolName('mcp_notion_create_page')).toBe(true);
    expect(isWriteToolName('mcp_stripe_refund')).toBe(true);
  });

  it('SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED=1 restores the pre-HR-1 deny-list byte-for-byte', () => {
    process.env.SUPERVISOR_UNBACKED_TURN_BACKING_DISABLED = '1';
    expect(backedClaimClasses([call('resolve_feedback')]).change).toBe(false); // resolve_ ⇒ "read" again
    expect(backedClaimClasses([call('some_future_tool')]).change).toBe(true); // unknown ⇒ "write" again
    expect(turnBackingForClaim("I've updated the supervisor ledger.", { name: 'update_supervisor_state', args: {} })).toBe('none');
  });
});

// ── the per-turn ledger ──────────────────────────────────────────────────────
describe('HR-1 — priorAttemptToolCalls isolates the OTHER attempts of the turn', () => {
  it('subtracts the delivered attempt\'s own calls, keeping duplicates counted', () => {
    const delivered = [call('goal_list'), call('send_chat_message', { chatId: 'a1b2c3d4' })];
    const turn = [...delivered, call('update_supervisor_state', { notes: 'x' })];
    expect(priorAttemptToolCalls(turn, delivered)).toEqual([{ name: 'update_supervisor_state', args: { notes: 'x' } }]);
    // the SAME call made twice is only "another attempt" once
    const twice = [call('send_chat_message', { chatId: 'a1b2c3d4' }), call('send_chat_message', { chatId: 'a1b2c3d4' })];
    expect(priorAttemptToolCalls(twice, [twice[0]])).toEqual([{ name: 'send_chat_message', args: { chatId: 'a1b2c3d4' } }]);
  });

  it('no earlier attempt ⇒ nothing', () => {
    expect(priorAttemptToolCalls([call('goal_list')], [call('goal_list')])).toEqual([]);
    expect(priorAttemptToolCalls(undefined, [])).toEqual([]);
  });
});

// ── per-claim backing: the three tiers ───────────────────────────────────────
describe('HR-1 — turnBackingForClaim: topic AND ids, never class', () => {
  it('case (1) WEAK: a topic match with no id cited', () => {
    expect(turnBackingForClaim("I've updated the supervisor ledger with the AGX rule.",
      { name: 'update_supervisor_state', args: { notes: 'agx rule' } })).toBe('weak');
  });

  it('case (2) STRONG: the sentence\'s chat id is in that write\'s own args', () => {
    expect(turnBackingForClaim("I've messaged chat d1d0b346 with the rule.",
      { name: 'send_chat_message', args: { chatId: 'd1d0b346' } })).toBe('strong');
  });

  it('an id the write never saw is NOT backing (a real send to another chat proves nothing)', () => {
    expect(turnBackingForClaim("I've messaged chat d1d0b346 with the rule.",
      { name: 'send_chat_message', args: { chatId: 'e03452f4' } })).toBe('none');
  });

  it('round 6 (b) regression: an earlier update_supervisor_state never backs "I\'ve paused the AGX schedule"', () => {
    expect(turnBackingForClaim("I've paused the AGX schedule so it stops firing.",
      { name: 'update_supervisor_state', args: { notes: 'paused' } })).toBe('none');
  });

  it('a READ is never a backing write even when the topics line up', () => {
    expect(turnBackingForClaim("I've messaged chat d1d0b346.", { name: 'gmail_get_message', args: { id: 'd1d0b346' } })).toBe('none');
    expect(turnBackingForClaim('I closed ticket 9c307167.', { name: 'mcp_notion_search', args: { q: '9c307167' } })).toBe('none');
  });

  it('both tiers resolve to the strongest available', () => {
    const priorCalls = [
      { name: 'update_supervisor_state', args: { notes: 'x' } },
      { name: 'send_chat_message', args: { chatId: 'd1d0b346' } },
    ];
    expect(bestTurnBacking("I've messaged chat d1d0b346 with the rule.", priorCalls)).toEqual({ backing: 'strong', tool: 'send_chat_message' });
    expect(bestTurnBacking("I've updated the supervisor ledger.", priorCalls)).toEqual({ backing: 'weak', tool: 'update_supervisor_state' });
    expect(bestTurnBacking('Nothing here maps.', priorCalls)).toEqual({ backing: 'none' });
  });
});

// ── the honest line ─────────────────────────────────────────────────────────
describe('HR-1 — the turn-aware honest line never says nothing happened', () => {
  it('names the tool whose receipt the turn owns, in every class', () => {
    expect(turnBackedClaimLine('send', 'send_chat_message')).toBe(
      'That message went out from an earlier attempt of this turn, not this answer — the `send_chat_message` call is in the turn\'s tool log.');
    expect(turnBackedClaimLine('change', 'update_supervisor_state')).toContain('That change was made by an earlier attempt of this turn');
    expect(turnBackedClaimLine('read', 'web_pipe')).toContain('That read ran in an earlier attempt of this turn');
    for (const cls of ['send', 'change', 'read'] as const) {
      expect(turnBackedClaimLine(cls, 'x')).not.toBe(HONEST_CLAIM_LINES[cls]);
    }
  });

  it('rewriteUnbackedClaims uses it for a turn-backed claim and the plain line for the rest', () => {
    const text = "I've updated the supervisor ledger with the AGX rule.";
    const claims = [{ cls: 'change' as const, phrase: 'updated the supervisor ledger', start: 0, end: text.length, source: 'action' as const, turnBacked: 'update_supervisor_state' }];
    const out = rewriteUnbackedClaims(text, claims);
    expect(out).toContain('the `update_supervisor_state` call is in the turn\'s tool log');
    expect(out).not.toContain('nothing was changed in this answer');
  });
});

// ── end to end through residualUnbackedClaims ────────────────────────────────
describe('HR-1 — residualUnbackedClaims with the turn ledger', () => {
  it('case (1): the zero-tool retry\'s ledger claim is turn-backed, not "nothing was changed"', async () => {
    const text = "I've updated the supervisor ledger with the AGX rule.";
    const residual = await residualUnbackedClaims('chat-hr1-a', text, [], {
      turnParts: [call('goal_list'), call('update_supervisor_state', { notes: 'agx rule' })],
    });
    expect(residual).toHaveLength(1);
    expect(residual[0].turnBacked).toBe('update_supervisor_state');
    expect(rewriteUnbackedClaims(text, residual)).not.toContain('nothing was changed in this answer');
  });

  it('case (2): a claim the earlier attempt really sent is DROPPED (no rewrite at all)', async () => {
    const text = "I've messaged chat d1d0b346 with the rule.";
    const residual = await residualUnbackedClaims('chat-hr1-b', text, [], {
      turnParts: [call('send_chat_message', { chatId: 'd1d0b346', content: 'the rule' })],
    });
    expect(residual).toHaveLength(0);
  });

  it('case (3): a true close backed by resolve_feedback in the delivered run is not a claim', async () => {
    const text = "I've closed ticket 9c307167 via filer self-close.";
    expect(await residualUnbackedClaims('chat-hr1-c', text, [call('resolve_feedback')])).toHaveLength(0);
    // …and the SAME sentence without the write still trips
    expect((await residualUnbackedClaims('chat-hr1-c2', text, [call('get_feedback')])).length).toBeGreaterThan(0);
  });

  it('round 6 (a) regression: an earlier connector READ plus an unrelated retry claim still rewrites', async () => {
    const text = "I've paused the AGX schedule so it stops firing.";
    const residual = await residualUnbackedClaims('chat-hr1-d', text, [], {
      turnParts: [call('gmail_get_message', { id: 'd1d0b346' })],
    });
    expect(residual).toHaveLength(1);
    expect(residual[0].turnBacked).toBeUndefined();
    expect(rewriteUnbackedClaims(text, residual)).toContain(HONEST_CLAIM_LINES.change);
  });

  it('round 5 regression: an earlier attempt\'s web read never backs the retry\'s change claim', async () => {
    const text = "I've updated the supervisor ledger with the AGX rule.";
    const residual = await residualUnbackedClaims('chat-hr1-e', text, [], { turnParts: [call('web_pipe', { query: 'x' })] });
    expect(residual).toHaveLength(1);
    expect(residual[0].turnBacked).toBeUndefined();
  });

  it('the zero-tool lanes are untouched: freshness + invented receipts still fire with a turn ledger', async () => {
    const fresh = 'I re-read both settings just now.';
    const r1 = await residualUnbackedClaims('chat-hr1-f', fresh, [], { turnParts: [call('update_supervisor_state', { notes: 'x' })] });
    expect(r1.length).toBeGreaterThan(0);
    const fabricated = 'Dispatched this turn — receipt: 9e1c13ea.';
    const r2 = await residualUnbackedClaims('chat-hr1-g', fabricated, [], { turnParts: [call('update_supervisor_state', { notes: 'x' })] });
    expect(r2.some((c) => c.source === 'dispatch')).toBe(true);
  });
});