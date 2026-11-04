/**
 * Owner 2026-09-16: the sidebar's green dot lights only for a reply to a HUMAN
 * turn — machine-to-machine traffic (hook / schedule / agent wakes, watchdog
 * notes, status cards) never flags a session unread.
 */
import { describe, expect, it } from 'vitest';
import { chatHasUnreadReply, isMessageForUser } from './chat-attention';

const VIEWED = Date.parse('2026-09-16T10:00:00Z');
const later = '2026-09-16T10:05:00Z';

describe('isMessageForUser', () => {
  it('human turns: no origin (legacy UI send) or "user" (owner-anchored send)', () => {
    expect(isMessageForUser(undefined)).toBe(true);
    expect(isMessageForUser(null)).toBe(true);
    expect(isMessageForUser('')).toBe(true);
    expect(isMessageForUser('user')).toBe(true);
  });
  it('machine turns and harness cards are never "for the user"', () => {
    for (const o of ['schedule', 'hook', 'agent', 'machine', 'attention-watchdog', 'owner-inbox', 'project_status', 'session_status', 'shutdown_requeue']) {
      expect(isMessageForUser(o)).toBe(false);
    }
  });
});

describe('chatHasUnreadReply', () => {
  it('lights for an assistant reply to a human turn that is newer than the last view', () => {
    expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: later }, VIEWED)).toBe(true);
    expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: later, lastMessageOrigin: 'user' }, VIEWED)).toBe(true);
  });
  it('stays dark for machine-to-machine replies (the supervisor / scheduled-run case)', () => {
    for (const o of ['hook', 'schedule', 'agent', 'machine']) {
      expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: later, lastMessageOrigin: o }, VIEWED)).toBe(false);
    }
  });
  it('keeps the legacy gates: user rows, missing stamps, never-viewed chats and older replies stay dark', () => {
    expect(chatHasUnreadReply({ lastMessageRole: 'user', lastMessageAt: later }, VIEWED)).toBe(false);
    expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: null }, VIEWED)).toBe(false);
    expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: later }, 0)).toBe(false);
    expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: '2026-09-16T09:00:00Z' }, VIEWED)).toBe(false);
    expect(chatHasUnreadReply({ lastMessageRole: 'assistant', lastMessageAt: 'not-a-date' }, VIEWED)).toBe(false);
  });
});
