import { describe, it, expect } from 'vitest';
import { chatPrefillHref, PREFILL_MAX_CHARS, readPrefill, withoutPrefill } from './chat-prefill';

describe('chat ?q= prefill', () => {
  it('reads and trims q; blank / missing is null', () => {
    expect(readPrefill('?q=%20Hello%20Digby%20')).toBe('Hello Digby');
    expect(readPrefill('?q=')).toBeNull();
    expect(readPrefill('?chatId=x')).toBeNull();
    expect(readPrefill('')).toBeNull();
    expect(readPrefill(undefined)).toBeNull();
  });
  it('keeps newlines, drops control characters, clips long text', () => {
    expect(readPrefill(`?q=${encodeURIComponent('a\u0007b\nc')}`)).toBe('ab\nc');
    expect(readPrefill(`?q=${'x'.repeat(PREFILL_MAX_CHARS + 50)}`)!.length).toBe(PREFILL_MAX_CHARS);
  });
  it('strips only q from the address bar', () => {
    expect(withoutPrefill('/', '?q=hi&utm_source=g')).toBe('/?utm_source=g');
    expect(withoutPrefill('/', '?q=hi')).toBe('/');
    expect(withoutPrefill('/', '?q=hi', '#x')).toBe('/#x');
  });
  it('builds the prompt link the site uses', () => {
    expect(chatPrefillHref('Where is my data stored?')).toBe('/?q=Where+is+my+data+stored%3F');
    expect(readPrefill(chatPrefillHref('Où sont « mes » données ?').slice(1))).toBe('Où sont « mes » données ?');
  });
});
