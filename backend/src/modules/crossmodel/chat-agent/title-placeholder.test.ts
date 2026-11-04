import { placeholderTitle, isStaleChatTitle } from './title-placeholder';

// Ticket 26385762: ONE canonical placeholder definition shared (by mirror)
// with the frontend pre-seed — the two ends previously matched only by two
// accidents (untrimmed slice+ellipsis vs trimmed substring without).
describe('title-placeholder', () => {
  it('placeholderTitle mirrors the frontend pre-seed formula exactly (slice 60 + …)', () => {
    expect(placeholderTitle('short question')).toBe('short question');
    expect(placeholderTitle('y'.repeat(60))).toBe('y'.repeat(60)); // exactly 60 → no ellipsis
    expect(placeholderTitle('x'.repeat(61))).toBe('x'.repeat(60) + '…');
    // Untrimmed by design — the frontend does not trim either.
    expect(placeholderTitle('  padded  ')).toBe('  padded  ');
  });

  it('isStaleChatTitle recognizes the placeholder shape of the CURRENT message', () => {
    const msg = 'z'.repeat(70);
    expect(isStaleChatTitle(placeholderTitle(msg), msg)).toBe(true);
    expect(isStaleChatTitle('the question', 'the question')).toBe(true);
  });

  it('keeps the legacy stale shapes', () => {
    expect(isStaleChatTitle('Some truncated title…', 'q')).toBe(true);
    expect(isStaleChatTitle('New Chat', 'q')).toBe(true);
    expect(isStaleChatTitle('New Conversation', 'q')).toBe(true);
    expect(isStaleChatTitle('ab', 'q')).toBe(true);
    expect(isStaleChatTitle('what is the Investigators order', 'what is the Investigators order of books?')).toBe(true);
  });

  it('does not flag proper generated titles', () => {
    expect(isStaleChatTitle('A Proper Title', 'the question')).toBe(false);
    expect(isStaleChatTitle('InvestiGators Book Order', 'what is the book order?')).toBe(false);
    expect(isStaleChatTitle('New chat', 'the question')).toBe(false); // lowercase c — not the stock placeholder
  });
});
