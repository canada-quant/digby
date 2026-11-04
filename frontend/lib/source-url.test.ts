/**
 * Tests for lib/source-url.ts (feedback a2063c30 — Sources pills must show the
 * resolved destination, never a search-engine redirect wrapper).
 */

import { describe, it, expect } from 'vitest';
import { resolveSourceUrl, sourceDisplayHost } from './source-url';

describe('resolveSourceUrl', () => {
  it('unwraps a google.com/url?q= redirect wrapper', () => {
    expect(resolveSourceUrl('https://www.google.com/url?q=https://theregister.com/2026/08/01/story&sa=U&ved=2ah'))
      .toBe('https://theregister.com/2026/08/01/story');
  });

  it('unwraps regional google hosts and /link with url= param', () => {
    expect(resolveSourceUrl('https://www.google.co.uk/link?url=https://github.com/org/repo'))
      .toBe('https://github.com/org/repo');
  });

  it('passes through direct URLs unchanged', () => {
    const direct = 'https://docs.example.com/guide?x=1';
    expect(resolveSourceUrl(direct)).toBe(direct);
  });

  it('passes through a google search page that is not a redirect wrapper', () => {
    const search = 'https://www.google.com/search?q=query';
    expect(resolveSourceUrl(search)).toBe(search);
  });

  it('passes through invalid input unchanged', () => {
    expect(resolveSourceUrl('not a url')).toBe('not a url');
  });
});

describe('sourceDisplayHost', () => {
  it('shows the resolved destination host for wrapped legacy URLs', () => {
    expect(sourceDisplayHost('https://www.google.com/url?q=https://www.theregister.com/story'))
      .toBe('theregister.com');
  });

  it('strips a leading www. from direct hosts', () => {
    expect(sourceDisplayHost('https://www.example.com/page')).toBe('example.com');
  });
});
