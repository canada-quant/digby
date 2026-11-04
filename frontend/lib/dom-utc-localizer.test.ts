import { describe, it, expect } from 'vitest';
import { insideSkippedElement, localizeTextNode, localizeTitleAttr, type ElementLike, type TextNodeLike } from './dom-utc-localizer';
import { localizeUtcTimes } from './localize-utc-times';

const el = (tagName: string, parentNode: ElementLike | null = null, attrs: Record<string, string> = {}, extra: Partial<ElementLike> = {}): ElementLike => ({
  nodeType: 1, tagName, parentNode,
  getAttribute: (n) => (n in attrs ? attrs[n] : null),
  setAttribute: (n, v) => { attrs[n] = v; },
  ...extra,
});
const text = (nodeValue: string, parentNode: ElementLike | null): TextNodeLike => ({ nodeType: 3, nodeValue, parentNode });

describe('DOM UTC localizer', () => {
  it('rewrites a harness title clock to local time (the owner example)', () => {
    const n = text('crossmodel Supervisor · idle since 17:39Z', el('SPAN', el('DIV')));
    expect(localizeTextNode(n)).toBe(true);
    expect(n.nodeValue).toBe(localizeUtcTimes('crossmodel Supervisor · idle since 17:39Z'));
    expect(n.nodeValue).not.toContain('17:39Z');
    // A second pass is a no-op — our own write never loops.
    expect(localizeTextNode(n)).toBe(false);
  });

  it('never touches code, inputs, editable regions or an opt-out', () => {
    for (const parent of [
      el('CODE', el('P')),
      el('SPAN', el('PRE')),
      el('TEXTAREA'),
      el('DIV', null, {}, { isContentEditable: true }),
      el('SPAN', el('DIV', null, { 'data-no-localize': '' })),
    ]) {
      const n = text('at 17:39Z', parent);
      expect(localizeTextNode(n)).toBe(false);
      expect(n.nodeValue).toBe('at 17:39Z');
      expect(insideSkippedElement(parent)).toBe(true);
    }
  });

  it('leaves text without a zoned clock alone', () => {
    for (const s of ['plain words', 'at 17:39', 'Zoom at 3pm', '']) {
      const n = text(s, el('SPAN'));
      expect(localizeTextNode(n)).toBe(false);
      expect(n.nodeValue).toBe(s);
    }
  });

  it('rewrites a title tooltip', () => {
    const attrs = { title: 'Last run 2026-10-16T17:39:05Z' };
    const e = el('SPAN', el('DIV'), attrs);
    expect(localizeTitleAttr(e)).toBe(true);
    expect(attrs.title).not.toContain('T17:39');
  });
});
