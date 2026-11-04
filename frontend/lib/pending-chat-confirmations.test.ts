import { describe, it, expect } from 'vitest';
import { selectLiveChatConfirmations, selectLiveChatOwnerQuestions } from './pending-chat-confirmations';
import type { PendingConfirmation } from '@/lib/api/crossmodel';

/** Ticket cbdb4614 — the inline confirm card's chat-scoped selector. */

let seq = 0;
function row(overrides: Partial<PendingConfirmation>): PendingConfirmation {
  seq += 1;
  return {
    chatId: 'chat-a',
    title: 'Chat A',
    kind: 'confirmation',
    id: `cf_${seq}`,
    question: 'Send a message to chat X?',
    options: [],
    ts: 1000 + seq,
    ...overrides,
  };
}

describe('selectLiveChatConfirmations', () => {
  it('selects live staged confirmations for the open chat only', () => {
    const list = [
      row({ chatId: 'chat-b' }), // other chat — excluded
      row({}),                    // included
      row({ kind: 'question' }),  // ask_user renders via its own SSE card
      row({ kind: 'approval' }),  // approvals render via pendingApproval
      row({ kind: 'owner_question' }), // decisions queue, not a confirm card
      row({ expired: true }),     // lapsed trace — non-actionable
      row({ stale: true }),       // Confirm would refuse — rail Dismiss-only
    ];
    const out = selectLiveChatConfirmations(list, 'chat-a');
    expect(out.map((p) => p.id)).toEqual(['cf_2']);
  });

  it('returns [] for chatless/null chat ids (guest mode never stages)', () => {
    const list = [row({})];
    expect(selectLiveChatConfirmations(list, null)).toEqual([]);
    expect(selectLiveChatConfirmations(list, undefined)).toEqual([]);
    expect(selectLiveChatConfirmations(list, '')).toEqual([]);
  });

  it('returns [] for a non-array input (poll fallbacks)', () => {
    expect(selectLiveChatConfirmations(undefined as unknown as PendingConfirmation[], 'chat-a')).toEqual([]);
  });

  it('sorts oldest-first when several are pending on the same chat', () => {
    const list = [row({ ts: 3000 }), row({ ts: 1000 }), row({ ts: 2000 })];
    const out = selectLiveChatConfirmations(list, 'chat-a');
    expect(out.map((p) => p.ts)).toEqual([1000, 2000, 3000]);
  });

  it('does not mutate the input list', () => {
    const list = [row({ ts: 2000 }), row({ ts: 1000 })];
    const before = list.map((p) => p.id);
    selectLiveChatConfirmations(list, 'chat-a');
    expect(list.map((p) => p.id)).toEqual(before);
  });
});

describe('selectLiveChatOwnerQuestions (owner 2026-09-22: answerable in the open chat)', () => {
  const mk = (over: Record<string, unknown>) => ({ chatId: 'a', title: 't', kind: 'owner_question', id: 'x', question: 'q', options: [], ts: 1, ...over }) as any;
  it('selects the open chat\'s owner questions, triaged or not, oldest first; never confirmations', () => {
    const list = [mk({ id: 'q2', ts: 5, triaged: true }), mk({ id: 'q1', ts: 1 }), mk({ id: 'other', chatId: 'b' }), mk({ id: 'c', kind: 'confirmation' })];
    expect(selectLiveChatOwnerQuestions(list, 'a').map((p) => p.id)).toEqual(['q1', 'q2']);
    expect(selectLiveChatOwnerQuestions(list, null)).toEqual([]);
    expect(selectLiveChatOwnerQuestions(undefined as any, 'a')).toEqual([]);
  });
});

// Cohesive chat (2026-09-28, review fixer): a staged `start_coding_session`
// card renders whoever staged it — the `machine` flag never hides a card (a
// hidden card would expire unconfirmed). The server decides what is staged.
describe('staged spawn cards render regardless of the `machine` flag', () => {
  const spawn = (over: Partial<PendingConfirmation>) => row({ tool: 'start_coding_session', question: 'Start coding session: build the deck', ...over });

  it('keeps human-turn, machine-staged and legacy spawn cards alike', () => {
    const list = [spawn({ id: 'human', machine: false }), spawn({ id: 'machine', machine: true }), spawn({ id: 'legacy' }), row({ id: 'send', tool: 'send_chat_message', machine: false })];
    expect(selectLiveChatConfirmations(list, 'chat-a').map((p) => p.id)).toEqual(['human', 'machine', 'legacy', 'send']);
  });
});
