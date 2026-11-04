/**
 * AppRail — the ONE drawer/rail shell primitive (UI overhaul Phase 1).
 *
 * Repo idiom (node-environment vitest, no jsdom): the DIALOG SEMANTICS are
 * pinned through the exported pure pieces (railA11yProps decision table,
 * resolveTrapTarget focus-trap math, railKeyCloses) plus SSR renders of the
 * component's initial markup (react-dom/server — effects never run, so SSR
 * shows the deterministic desktop-default state).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import AppRail, {
  railA11yProps, resolveTrapTarget, railKeyCloses, useRailOpen,
  RAIL_BREAKPOINT_PX,
} from './app-rail';
import type { Resizable } from '@/lib/use-resizable';

describe('railA11yProps — the dialog-semantics decision table', () => {
  it('open mobile drawer = a REAL dialog: role="dialog" + aria-modal', () => {
    expect(railA11yProps(true, false)).toEqual({ role: 'dialog', 'aria-modal': true });
  });

  it('open desktop column = NOT a dialog (in-flow content, no modal claim)', () => {
    expect(railA11yProps(true, true)).toEqual({});
  });

  it('closed (any viewport) = inert + aria-hidden — out of the a11y tree and tab order', () => {
    expect(railA11yProps(false, false)).toEqual({ 'aria-hidden': true, inert: true });
    expect(railA11yProps(false, true)).toEqual({ 'aria-hidden': true, inert: true });
  });
});

describe('railKeyCloses — Esc closes the modal drawer', () => {
  it('Escape closes; other keys do not', () => {
    expect(railKeyCloses('Escape')).toBe(true);
    expect(railKeyCloses('Enter')).toBe(false);
    expect(railKeyCloses('Tab')).toBe(false);
    expect(railKeyCloses('a')).toBe(false);
  });
});

describe('resolveTrapTarget — focus-trap math (Tab cycles inside the drawer)', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' };
  const list = [a, b, c] as const;

  it('Tab on the LAST focusable wraps to the first', () => {
    expect(resolveTrapTarget(list, c, false)).toBe(a);
  });

  it('Shift+Tab on the FIRST focusable wraps to the last', () => {
    expect(resolveTrapTarget(list, a, true)).toBe(c);
  });

  it('mid-list focus is left to the browser (null)', () => {
    expect(resolveTrapTarget(list, b, false)).toBeNull();
    expect(resolveTrapTarget(list, b, true)).toBeNull();
  });

  it('focus that STRAYED outside the drawer is recaptured (first / last by direction)', () => {
    const outside = { id: 'outside' };
    expect(resolveTrapTarget(list, outside, false)).toBe(a);
    expect(resolveTrapTarget(list, outside, true)).toBe(c);
    expect(resolveTrapTarget(list, null, false)).toBe(a);
    expect(resolveTrapTarget(list, undefined, true)).toBe(c);
  });

  it('an empty drawer traps nothing', () => {
    expect(resolveTrapTarget([], null, false)).toBeNull();
  });
});

describe('useRailOpen — hydration-safe open state', () => {
  function Probe({ getInitial }: { getInitial?: () => boolean }) {
    const [open] = useRailOpen(getInitial);
    return createElement('span', null, String(open));
  }

  it('SSR/first render is deterministically OPEN (desktop default) — the initializer is NOT consulted during render', () => {
    // A getInitial that would say "closed" (and would THROW under SSR if it
    // ran, since it touches window) must not affect server markup — it runs
    // in the mount effect only.
    const html = renderToStaticMarkup(createElement(Probe, {
      getInitial: () => { throw new Error('must not run during render'); },
    }));
    expect(html).toContain('true');
  });

  it('the breakpoint constant is md (768) — the app-wide drawer/static switch', () => {
    expect(RAIL_BREAKPOINT_PX).toBe(768);
  });
});

describe('AppRail SSR markup — initial (pre-hydration) state', () => {
  const content = createElement('nav', null, 'RAIL-CONTENT');
  const render = (open: boolean, extra?: object) =>
    renderToStaticMarkup(createElement(AppRail, {
      open, onClose: () => {}, label: 'Test rail', ...extra,
    } as never, content));

  it('CLOSED: the aside is inert + aria-hidden (not just off-screen), slid out, collapsed to width 0 on md+ — and NO backdrop', () => {
    const html = render(false);
    expect(html).toContain('inert=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('-translate-x-full');
    // Digby Frontier (2026-10-06): the desktop column animates its WIDTH
    // (264 → 0, 340ms) instead of display:none; its content fades out.
    expect(html).toContain('md:w-0');
    expect(html).toContain('md:transition-[width,box-shadow] md:duration-[340ms]');
    expect(html).toContain('opacity-0');
    expect(html).toContain('shadow-none');
    expect(html).not.toContain('bg-black/50'); // backdrop only renders while open
  });

  it('OPEN: backdrop on the z scale + slid-in aside; no dialog role in SSR (desktop default — the role lands via matchMedia on mobile)', () => {
    const html = render(true);
    // Frontier skin: raised gradient, right corners rounded, the rail shadow.
    expect(html).toContain('dg-rail-skin');
    expect(html).toContain('rounded-r-[18px]');
    expect(html).toContain('shadow-(--rail-shadow)');
    expect(html).toContain('bg-black/50');
    expect(html).toContain('z-(--z-overlay-backdrop)');
    expect(html).toContain('z-(--z-overlay)');
    expect(html).toContain('translate-x-0');
    expect(html).not.toContain('inert');
    expect(html).not.toContain('role="dialog"'); // SSR assumes desktop; railA11yProps(true,false) covers mobile
    expect(html).toContain('aria-label="Test rail"');
  });

  it('drawer pins to the visual viewport vars (--app-height/--app-top)', () => {
    const html = render(true);
    expect(html).toContain('var(--app-height, 100dvh)');
    expect(html).toContain('var(--app-top, 0px)');
  });

  it('static width prop drives the desktop column via --rail-w', () => {
    const html = render(true, { width: 300 });
    expect(html).toContain('--rail-w:300px');
    expect(html).toContain('md:w-[var(--rail-w)]');
  });

  it('a resizable controller drives the width AND renders the shared handle (md+ visibility)', () => {
    const fake: Resizable = { width: 333, startResize: () => {}, reset: () => {}, nudge: () => {} };
    const html = render(true, { resizable: fake, resizeLabel: 'Resize test rail' });
    expect(html).toContain('--rail-w:333px');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="Resize test rail"');
    expect(html).toContain('hidden md:flex');
  });

  it('no handle without a resizable controller; no handle while closed', () => {
    expect(render(true)).not.toContain('role="separator"');
    const fake: Resizable = { width: 333, startResize: () => {}, reset: () => {}, nudge: () => {} };
    expect(render(false, { resizable: fake })).not.toContain('role="separator"');
  });

  it("side='right' flips the edge: right-0, translate-x-full when closed, inner corners rounded on the left", () => {
    const html = render(false, { side: 'right' });
    expect(html).toContain('right-0');
    expect(html).toContain('rounded-l-[18px]');
    expect(html).not.toMatch(/\bborder-[lr]\b/); // Frontier: no border at all
    expect(html).not.toContain('-translate-x-full');
    expect(html).toContain('translate-x-full');
  });

  it('children render inside the aside untouched (shell, not chrome)', () => {
    expect(render(true)).toContain('RAIL-CONTENT');
  });

  it('landscape safe-area side padding (ticket c0e58120): left rail pads left, right rail pads right, top inset kept', () => {
    const leftHtml = render(true);
    expect(leftHtml).toContain('padding-top:env(safe-area-inset-top, 0px)');
    expect(leftHtml).toContain('padding-left:env(safe-area-inset-left, 0px)');
    expect(leftHtml).not.toContain('padding-right:env(safe-area-inset-right');
    const rightHtml = render(true, { side: 'right' });
    expect(rightHtml).toContain('padding-right:env(safe-area-inset-right, 0px)');
    expect(rightHtml).not.toContain('padding-left:env(safe-area-inset-left');
  });
});
