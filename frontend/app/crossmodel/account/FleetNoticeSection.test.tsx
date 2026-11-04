/**
 * Account → Coding → Fleet notice (2026-10-12): the editor renders its explainer, the text box and the expiry input.
 * react-dom/server idiom (node-environment vitest, no jsdom) — the first paint is the loading state.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

vi.mock('@/lib/api/fleet-notice', () => ({ fleetNoticeApi: { get: vi.fn(() => new Promise(() => {})), set: vi.fn(), clear: vi.fn() } }));

import { FleetNoticeSection } from './FleetNoticeSection';

describe('FleetNoticeSection', () => {
  it('explains what the notice does and offers a text box + expiry', () => {
    const html = renderToStaticMarkup(createElement(FleetNoticeSection));
    expect(html).toContain('data-fleet-notice');
    expect(html).toContain('Fleet notice');
    expect(html).toContain('every agent working for you reads on every turn');
    expect(html).toContain('Never put keys or passwords here');
    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="Days until the notice expires"');
  });
});
