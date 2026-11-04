/**
 * DepthPill / DepthChipRow render pins (Depth UX, 2026-09-26 — Module C).
 * Same react-dom/server idiom as PatiencePicker.test.tsx (node-environment
 * vitest, no jsdom): the SSR markup is what these pins target; the state
 * machine itself is pinned in lib/depth-ux.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { DepthChipRow, DepthPill } from './DepthPill';
import { ESCALATE_LABEL, SIGNIN_DEEPER_LABEL } from '@/lib/depth-ux';

const MSG = '11111111-1111-4111-8111-111111111111';
const pill = (props: Parameters<typeof DepthPill>[0]) => renderToStaticMarkup(createElement(DepthPill, props));
const chips = (props: Parameters<typeof DepthChipRow>[0]) => renderToStaticMarkup(createElement(DepthChipRow, props));

describe('DepthPill — one pill, four visible states', () => {
  it('null state renders nothing (legacy backend / skipped)', () => {
    expect(pill({ state: null })).toBe('');
  });

  it('a Quick-lane answer renders the quiet Quick pill (fixed copy, no button)', () => {
    const html = pill({ state: { kind: 'quick' } });
    expect(html).toContain('data-depth-pill="quick"');
    expect(html).toContain('Quick answer');
    expect(html).not.toContain('<button');
  });

  it('checking / checked / interrupted carry their fixed copy and data-depth-pill markers', () => {
    expect(pill({ state: { kind: 'checking' } })).toContain('data-depth-pill="checking"');
    expect(pill({ state: { kind: 'checking' } })).toContain('Checking…');
    expect(pill({ state: { kind: 'checked' } })).toContain('data-depth-pill="checked"');
    expect(pill({ state: { kind: 'checked' } })).toContain('Checked ✓');
    const interrupted = pill({ state: { kind: 'interrupted' }, onDigDeeper: () => {} });
    expect(interrupted).toContain('data-depth-pill="interrupted"');
    expect(interrupted).toContain('Check didn’t finish');
    expect(interrupted).toContain('Dig deeper to retry');
    // no retry handler ⇒ no retry link
    expect(pill({ state: { kind: 'interrupted' } })).not.toContain('Dig deeper to retry');
  });

  it('updated counts corrections and offers "what changed" only when there is something to show', () => {
    const two = pill({ state: { kind: 'updated', changed: ['price 12 → 14', 'date'] }, previousContent: 'old', currentContent: 'new' });
    expect(two).toContain('data-depth-pill="updated"');
    expect(two).toContain('Updated');
    expect(two).toContain('2 corrections');
    expect(two).toContain('what changed');
    expect(two).toContain('aria-expanded="false"'); // collapsed until tapped
    const one = pill({ state: { kind: 'updated', changed: ['x'] } });
    expect(one).toContain('1 correction');
    // legacy revision rows: no changed list and no previous content → nothing to expand
    const bare = pill({ state: { kind: 'updated', changed: [] } });
    expect(bare).not.toContain('what changed');
  });

  it('the checker is named by SEAT label, never a vendor', () => {
    const html = pill({ state: { kind: 'checking' }, checkerLabel: 'Double Checker' });
    expect(html).toContain('Double Checker is still working');
    expect(html).not.toMatch(/deepseek|glm|kimi/i);
  });
});

describe('DepthChipRow — the single Dig deeper control', () => {
  it('renders nothing without a chip', () => {
    expect(chips({ chip: null })).toBe('');
  });

  it('escalate chip: label, rung marker, eta + quota hint on the research rung', () => {
    const html = chips({
      chip: { kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'research', etaText: 'as long as it needs' },
      quota: { remaining: 1, limit: 2, allowed: true, authenticated: true },
    });
    expect(html).toContain('data-depth-chip="escalate"');
    expect(html).toContain('data-next-rung="research"');
    expect(html).toContain(ESCALATE_LABEL);
    expect(html).toContain('as long as it needs');
    expect(html).toContain('1/2 deeper looks left today');
    expect(html).not.toContain('disabled=""');
  });

  it('the research rung is disabled when the daily quota is exhausted; verify never is', () => {
    const out = { remaining: 0, limit: 2, allowed: false, authenticated: true };
    expect(chips({ chip: { kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'research' }, quota: out })).toContain('disabled=""');
    expect(chips({ chip: { kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'verify' }, quota: out })).not.toContain('disabled=""');
    // and while a turn streams
    expect(chips({ chip: { kind: 'escalate', label: ESCALATE_LABEL, escalationOf: MSG, nextRung: 'verify' }, disabled: true })).toContain('disabled=""');
  });

  it('guests get the sign-in affordance as a link to the login page', () => {
    const html = chips({ chip: { kind: 'signin_deeper', label: SIGNIN_DEEPER_LABEL } });
    expect(html).toContain('data-depth-chip="signin_deeper"');
    expect(html).toContain('href="/login"');
    expect(html).toContain(SIGNIN_DEEPER_LABEL);
    expect(html).not.toContain(ESCALATE_LABEL);
  });
});
