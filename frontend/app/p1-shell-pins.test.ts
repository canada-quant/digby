/**
 * Phase 1 (App Shell) pins — UI overhaul, owner-approved.
 *
 * SOURCE-LEVEL pins (the phase0-ui-pins / c1-convergence-smoke idiom: anchor
 * on stable identifiers, never line numbers) for the eight Phase-1 items:
 *
 *   1. ONE rail primitive (components/ui/custom/app-rail.tsx) — all four
 *      divergent drawer/rail copies migrated (authed sidebar, GuestSidebar,
 *      profile facts panel, both instances rails), instances gained a REAL
 *      mobile drawer + open button (the detail rail was `hidden md:flex` —
 *      unreachable on phones).
 *   2. Z-INDEX SCALE — tokens in globals.css @theme; the audited collision
 *      sites use them (no raw z-30/z-40 ties left there).
 *   3. Visible panel toggle (PanelRight, aria-pressed) in FloatingChrome.
 *   4. --app-height hoisted to the /crossmodel layout (AppViewportVars);
 *      the page-local copy is gone; the panel drawer pins to the vars.
 *   5. Hydration-safe sidebarOpen (useRailOpen — no window/localStorage
 *      reads in a render-time initializer).
 *   6. "Needs your input" rail block collapsed by default.
 *   7. Workspace panel breakpoint aligned to md (was xl).
 *   8. Pinch-zoom re-enabled (no maximumScale:1 / userScalable:false).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const PAGE = read('./crossmodel/page.tsx');
const GUEST = read('./crossmodel/components/GuestSidebar.tsx');
const PROFILE = read('./crossmodel/profile/page.tsx');
const INSTANCES = read('./crossmodel/instances/page.tsx');
const INSTANCE_DETAIL = read('./crossmodel/instances/[instanceId]/page.tsx');
const VIEW = read('./crossmodel/components/CodeSessionView.tsx');
const CHROME = read('./crossmodel/components/FloatingChrome.tsx');
const LAYOUT_CM = read('./crossmodel/layout.tsx');
const LAYOUT_ROOT = read('./layout.tsx');
const GLOBALS = read('./globals.css');
const RAIL = read('../components/ui/custom/app-rail.tsx');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts).
 *  `to` is resolved AFTER `from`, so an earlier stray occurrence can't shrink
 *  the region to nothing. */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b, `region anchor ${JSON.stringify(to)} missing after ${JSON.stringify(from)}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('P1.1 — ALL FOUR rail surfaces ride the ONE AppRail primitive', () => {
  it('authed sidebar (page.tsx): AppRail with the shared resize controller; the hand-rolled aside copy is gone', () => {
    expect(PAGE).toContain("import AppRail, { useRailOpen, RAIL_BREAKPOINT_PX } from '@/components/ui/custom/app-rail';");
    const rail = region(PAGE, '── Sidebar (authenticated only) ──', 'Deep search across all chats');
    expect(rail).toContain('<AppRail');
    expect(rail).toContain('resizable={sidebarRail}');
    expect(rail).toContain('open={sidebarOpen}');
    // The old copied shell (its distinctive class pair) must be gone from the page.
    expect(PAGE).not.toContain('md:w-[var(--chat-rail-w)]');
    expect(PAGE).not.toContain("'fixed inset-y-0 left-0 z-30 w-[280px]");
  });

  it('GuestSidebar: AppRail shell (the self-documented class copy is gone)', () => {
    expect(GUEST).toContain("import AppRail from '@/components/ui/custom/app-rail';");
    expect(GUEST).toContain('<AppRail open={open} onClose={onClose}');
    expect(GUEST).not.toContain('translate-x-full'); // shell classes now live in the primitive
    expect(GUEST).not.toContain('z-30');
  });

  it('profile facts panel: AppRail shell + the SSR-safe open state', () => {
    expect(PROFILE).toContain("import AppRail, { useRailOpen } from '@/components/ui/custom/app-rail';");
    expect(PROFILE).toContain('useRailOpen()');
    expect(PROFILE).toContain('<AppRail');
    expect(PROFILE).not.toContain('md:w-64 lg:w-72'); // the divergent width pair is gone
    expect(PROFILE).not.toContain('-translate-x-full');
  });

  it('instances landing: AppRail + a mobile OPEN button (the rail used to have no phone affordance)', () => {
    expect(INSTANCES).toContain('AppRail');
    expect(INSTANCES).toContain('useRailOpen()');
    expect(INSTANCES).toContain('aria-label="Open instances list"');
    expect(INSTANCES).toContain('md:hidden'); // the opener is a mobile control
    expect(INSTANCES).toContain('setRailOpen(true)');
  });

  it('instance detail: the `hidden md:flex` phone-unreachable rail is GONE — AppRail + header open button', () => {
    expect(INSTANCE_DETAIL).not.toContain('hidden md:flex');
    expect(INSTANCE_DETAIL).toContain('AppRail');
    expect(INSTANCE_DETAIL).toContain('useRailOpen()');
    expect(INSTANCE_DETAIL).toContain('aria-label="Open instances list"');
    expect(INSTANCE_DETAIL).toContain('setRailOpen(true)');
  });

  it('the primitive itself carries the dialog semantics the copies lacked', () => {
    expect(RAIL).toContain("role: 'dialog'");
    expect(RAIL).toContain("'aria-modal': true");
    expect(RAIL).toContain('inert: true');
    expect(RAIL).toContain('resolveTrapTarget'); // focus trap
    expect(RAIL).toContain("key === 'Escape'"); // Esc closes
  });
});

describe('P1.2 — z-index scale tokens', () => {
  it('globals.css declares the six tokens in @theme', () => {
    for (const token of ['--z-raised:', '--z-rail:', '--z-overlay-backdrop:', '--z-overlay:', '--z-modal:', '--z-toast:']) {
      expect(GLOBALS).toContain(token);
    }
  });

  it('the scale is ordered with headroom (raised < rail < backdrop < overlay < modal < toast)', () => {
    const val = (name: string): number => {
      const m = GLOBALS.match(new RegExp(`${name}:\\s*(\\d+)`));
      expect(m, `${name} must be a bare number in globals.css`).not.toBeNull();
      return Number(m![1]);
    };
    const order = ['--z-raised', '--z-rail', '--z-overlay-backdrop', '--z-overlay', '--z-modal', '--z-toast'].map(val);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it('the audited collision sites use tokens — the workspace panel region has no raw z-30/z-40', () => {
    const panel = region(VIEW, 'Right Workspace panel', 'WorkspacePanel onClose={closePanel}');
    expect(panel).toContain('z-(--z-overlay-backdrop)');
    expect(panel).toContain('z-(--z-overlay)');
    expect(panel).not.toContain('z-30');
    expect(panel).not.toContain('z-40');
  });

  it('profile sticky header sits on --z-rail (was a raw z-30 tie with drawers)', () => {
    expect(PROFILE).toContain('sticky top-0 z-(--z-rail)');
    expect(PROFILE).not.toContain('z-30');
  });

  it('FloatingChrome pills ride --z-raised (under backdrops and drawers)', () => {
    expect(CHROME).toContain('z-(--z-raised)');
    expect(CHROME).not.toMatch(/className=[^\n]*\bz-10\b/);
  });

  it('the rail primitive owns its layers via tokens (backdrop + drawer)', () => {
    expect(RAIL).toContain('z-(--z-overlay-backdrop)');
    expect(RAIL).toContain('z-(--z-overlay)');
    expect(RAIL).not.toContain('z-30');
    expect(RAIL).not.toContain('z-40');
  });
});

describe('P1.3 — visible panel toggle (discoverable without ⋯)', () => {
  it('FloatingChrome renders a PanelRight pill with tooltip + aria-pressed reflecting open state', () => {
    expect(CHROME).toContain('PanelRight');
    expect(CHROME).toContain('aria-pressed={!!workspaceOpen}');
    expect(CHROME).toContain("workspaceOpen ? 'Hide side panel' : 'Show side panel'");
    expect(CHROME).toContain('onToggleWorkspace?.()');
  });

  it('the header has NO menus — the PanelRight toggle is the one panel affordance (owner 2026-10-06)', () => {
    expect(CHROME).not.toContain('DropdownMenu');
    expect(CHROME).toContain('aria-pressed={!!workspaceOpen}');
  });
});

describe('P1.4 — --app-height hoisted to the /crossmodel layout', () => {
  it('the layout mounts AppViewportVars (every route + drawer under it gets the vars)', () => {
    expect(LAYOUT_CM).toContain("import AppViewportVars from './AppViewportVars';");
    expect(LAYOUT_CM).toContain('<AppViewportVars />');
  });

  it('the page-local copy is GONE from page.tsx (no setProperty of the vars)', () => {
    expect(PAGE).not.toContain("setProperty('--app-height'");
    expect(PAGE).not.toContain("setProperty('--app-top'");
    expect(PAGE).not.toContain('visualViewport');
  });

  it('the hook sets AND cleans up both vars', () => {
    const hook = read('../lib/use-app-viewport.ts');
    expect(hook).toContain("setProperty('--app-height'");
    expect(hook).toContain("setProperty('--app-top'");
    expect(hook).toContain("removeProperty('--app-height')");
    expect(hook).toContain("removeProperty('--app-top')");
    expect(hook).toContain('visualViewport');
  });

  it('the workspace-panel drawer pins to the vars (it lacked the height/top treatment)', () => {
    const panel = region(VIEW, 'Right Workspace panel', 'WorkspacePanel onClose={closePanel}');
    expect(panel).toContain('max-md:h-[var(--app-height,100dvh)]');
    expect(panel).toContain('max-md:top-[var(--app-top,0px)]');
    expect(panel).toContain("height: 'var(--app-height, 100dvh)'"); // backdrop
  });

  it('instances routes keep reading the vars they now actually receive', () => {
    expect(INSTANCES).toContain('var(--app-height, 100dvh)');
    expect(INSTANCE_DETAIL).toContain('var(--app-height, 100dvh)');
  });
});

describe('P1.5 — hydration-safe sidebarOpen', () => {
  it('page.tsx uses useRailOpen (deterministic SSR default, prefs/viewport in a mount effect)', () => {
    expect(PAGE).toContain('useRailOpen(() => {');
    expect(PAGE).toContain('window.innerWidth >= RAIL_BREAKPOINT_PX');
  });

  it('no render-time initializer reads window/localStorage for sidebarOpen anymore', () => {
    // The old shape: useState(() => { if (typeof window === 'undefined') … innerWidth … })
    expect(PAGE).not.toContain('const [sidebarOpen, setSidebarOpen] = useState(');
    expect(PAGE).not.toMatch(/useState\(\(\) => \{\s*if \(typeof window === 'undefined'\) return true;/);
  });

  it('the hook itself: server/first render says open; the initializer runs post-mount only', () => {
    expect(RAIL).toContain('useState(true); // deterministic SSR/first-render default');
    expect(RAIL).toContain('useIsomorphicLayoutEffect');
  });
});

describe('P1.6 — "needs your input" rail block collapsed by default', () => {
  it('default-collapsed state + aria-expanded toggle row', () => {
    expect(PAGE).toContain('const [needsInputExpanded, setNeedsInputExpanded] = useState(false);');
    expect(PAGE).toContain('aria-expanded={needsInputExpanded}');
  });

  it('the compact row is a dot + live count + chevron; the cards render only behind the toggle', () => {
    // Digby Frontier (2026-10-06): a quiet primary-action row (WarnDot while
    // something needs input) instead of the amber banner block.
    const block = region(PAGE, 'aria-expanded={needsInputExpanded}', '+{pendingOtherItems.length - 3} more');
    expect(PAGE).toContain('<WarnDot />');
    expect(PAGE).toContain('your input');
    expect(block).toContain('{needsInputExpanded && (');
    // Dismiss/Confirm stay INSIDE the expanded state.
    expect(block).toContain('Dismiss');
    expect(block).toContain('Confirm');
  });
});

describe('P1.7 — workspace panel breakpoint aligned to md', () => {
  it('the panel is an in-flow column at md+ and a drawer below (no xl split left)', () => {
    const panel = region(VIEW, 'Right Workspace panel', 'WorkspacePanel onClose={closePanel}');
    // md:relative, NOT md:static (2026-09-09): the absolutely-positioned
    // ResizeHandle anchors to the aside — `static` un-anchored it, so the
    // panel was effectively un-resizable (owner report).
    // Digby Frontier (2026-10-06): the column's WIDTH animates (0 ⇄ the
    // clamped --panel-eff-w derived from --panel-w), so it stays mounted.
    expect(panel).toContain('md:flex md:relative md:inset-auto md:z-(--z-raised)');
    expect(panel).toContain("panelOpen ? 'md:w-[var(--panel-eff-w)] md:shadow-(--panel-shadow)' : 'md:w-0 md:shadow-none'");
    expect(panel).toContain("['--panel-eff-w' as any]: 'min(var(--panel-w),");
    expect(panel).not.toContain('md:static');
    expect(panel).toContain('md:hidden'); // backdrop hides at md+
    expect(panel).toContain('hidden md:flex'); // resize handle shows at md+
    expect(panel).not.toContain('xl:');
  });

  it('no xl: breakpoint remains anywhere in CodeSessionView (one convention)', () => {
    expect(VIEW).not.toContain('xl:');
  });
});

describe('P1.8 — pinch-zoom re-enabled (WCAG 1.4.4)', () => {
  it('the viewport export keeps initialScale but drops maximumScale/userScalable', () => {
    expect(LAYOUT_ROOT).toContain('initialScale: 1');
    expect(LAYOUT_ROOT).not.toContain('maximumScale');
    expect(LAYOUT_ROOT).not.toContain('userScalable');
  });
});

describe('P1.9 — double-tap zoom disabled, pinch-zoom kept (ticket d0624b13)', () => {
  // Owner-question oq_48632205 answer (2026-09-15, supervisor triage under
  // standing directives): middle ground — `touch-action: manipulation` on the
  // app shell kills accidental double-tap zoom; pinch-zoom stays (P1.8).
  it('the html/body base layer clamps touch-action to manipulation', () => {
    const shell = region(GLOBALS, 'html,', '.font-display');
    expect(shell).toContain('touch-action: manipulation');
    // Stricter values on the shell would ALSO kill pinch-zoom — forbidden.
    expect(shell).not.toContain('touch-action: none');
    expect(shell).not.toContain('touch-action: pan');
  });

  it('the viewport keeps pinch-zoom enabled (P1.8 unchanged by this fix)', () => {
    expect(LAYOUT_ROOT).toContain('initialScale: 1');
    expect(LAYOUT_ROOT).not.toContain('maximumScale');
    expect(LAYOUT_ROOT).not.toContain('userScalable');
  });
});
