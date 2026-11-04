import { describe, it, expect } from 'vitest';
import { isPlaceholderChatTitle } from './chat-title';

const MSG = 'can you get all newest trneding post on x.com about AI , new open source models, and agent frameworks this week';

describe('isPlaceholderChatTitle (owner 2026-09-22: the sidebar kept the raw first message)', () => {
  it('the raw question, its 60-char prefix, a truncated "…" title and the stock placeholders are placeholders', () => {
    expect(isPlaceholderChatTitle(MSG.slice(0, 60), MSG)).toBe(true);
    expect(isPlaceholderChatTitle('can you get all newest trneding post on x.com about AI , new…', MSG)).toBe(true);
    expect(isPlaceholderChatTitle('New Chat', MSG)).toBe(true);
    expect(isPlaceholderChatTitle('', MSG)).toBe(true);
    expect(isPlaceholderChatTitle('can you get all newest trneding post', MSG)).toBe(true); // ≥20-char substring of the question
  });
  it('a generated title is not a placeholder', () => {
    expect(isPlaceholderChatTitle('Latest AI Trends and Releases on X', MSG)).toBe(false);
    expect(isPlaceholderChatTitle('Missed CDW Equinox Conference Call Transcript', 'i missed an important conference call at 9am today')).toBe(false);
  });
  it('without a first message only the stock shapes count', () => {
    expect(isPlaceholderChatTitle('Some Real Title', null)).toBe(false);
    expect(isPlaceholderChatTitle('New Conversation', null)).toBe(true);
  });
});
