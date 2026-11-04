/**
 * ScrollableTabBar — keyboard math + markup pins.
 * Node-environment vitest (no jsdom): nextTabIndex is pure; SSR markup
 * proves tablist/tab roles and the coarse-pointer 44px floor.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { nextTabIndex, ScrollableTabBar } from './scrollable-tab-bar';

describe('nextTabIndex — roving tabindex math', () => {
  it('arrows wrap; Home/End jump; other keys are ignored', () => {
    expect(nextTabIndex(0, 3, 'ArrowRight')).toBe(1);
    expect(nextTabIndex(2, 3, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(0, 3, 'ArrowLeft')).toBe(2);
    expect(nextTabIndex(1, 3, 'ArrowUp')).toBe(0);
    expect(nextTabIndex(1, 3, 'ArrowDown')).toBe(2);
    expect(nextTabIndex(2, 4, 'Home')).toBe(0);
    expect(nextTabIndex(0, 4, 'End')).toBe(3);
    expect(nextTabIndex(1, 3, 'Enter')).toBeNull();
    expect(nextTabIndex(0, 0, 'ArrowRight')).toBeNull();
  });
});

describe('ScrollableTabBar — accessible tablist markup', () => {
  it('renders role=tablist/tab, aria-selected, and the 44px coarse-pointer floor', () => {
    const html = renderToStaticMarkup(
      createElement(ScrollableTabBar, {
        ariaLabel: 'Account sections',
        value: 'profile',
        onChange: () => {},
        tabs: [
          { id: 'profile', label: 'Profile' },
          { id: 'memory', label: 'Memory' },
        ],
      }),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Account sections"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('min-h-11');
    expect(html).toContain('Profile');
    expect(html).toContain('Memory');
  });
});
