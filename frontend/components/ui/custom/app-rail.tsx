'use client';

/**
 * AppRail — THE drawer/rail shell primitive (UI overhaul Phase 1).
 *
 * Before this, four divergent copies of the same shell existed: the authed
 * sidebar (page.tsx), GuestSidebar, the profile facts panel, and the
 * instances rails (which were simply UNREACHABLE on phones — `hidden
 * md:flex`, no drawer, no open button). One primitive now owns the shell so
 * the surfaces can't drift:
 *
 *   - Desktop (≥ md, the app's ONE drawer/static breakpoint): an in-flow
 *     column at `width` px — or live-resizable when a `resizable` controller
 *     (lib/use-resizable.ts) is passed, in which case the shared
 *     ResizeHandle renders on the rail's inner edge. Closed = width 0 (the
 *     Digby Frontier collapse animates width 340ms; content fades 220ms).
 *   - Mobile (< md): a fixed slide-over drawer with REAL dialog semantics —
 *     role="dialog" + aria-modal while open (viewport known only on the
 *     client, so the role lands after mount via matchMedia), focus moves in
 *     and restores on close, Tab is trapped inside, Esc closes, and a
 *     backdrop click closes. While CLOSED the drawer is `inert` +
 *     aria-hidden — the old copies left the off-screen drawer in the a11y
 *     tree and tab order (the audited Phase-1 bug; file-preview-modal.tsx
 *     was the one in-repo surface that did this right).
 *
 * Layering uses the globals.css z-scale: backdrop z-(--z-overlay-backdrop),
 * drawer z-(--z-overlay). Drawer height/top pin to --app-height/--app-top
 * (the visual-viewport vars mounted by app/crossmodel/layout.tsx).
 *
 * The CONTENT is entirely the caller's — this is a shell, not a chrome kit.
 *
 * Pure pieces (railA11yProps / resolveTrapTarget / railKeyCloses) and the
 * SSR-safe open-state hook (useRailOpen) are exported for the repo's
 * node-environment vitest.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type Dispatch, type ReactNode, type SetStateAction,
} from 'react';
import { cn } from '@/lib/utils';
import { ResizeHandle } from '@/components/ui/custom/resize-handle';
import type { Resizable } from '@/lib/use-resizable';

/** The app-wide drawer/static switch — Tailwind `md`. Every rail AND the
 *  workspace panel collapse at this one width (Phase 1 item 7). */
export const RAIL_BREAKPOINT_PX = 768;

/** Esc is the one close key (matches file-preview-modal / image-lightbox). */
export function railKeyCloses(key: string): boolean {
  return key === 'Escape';
}

export interface RailA11yProps {
  role?: 'dialog';
  'aria-modal'?: boolean;
  'aria-hidden'?: boolean;
  inert?: boolean;
}

/**
 * The dialog-semantics decision table, pure:
 *   closed (any viewport)  → inert + aria-hidden (out of the a11y tree and
 *                            tab order — display:none only covers desktop);
 *   open on mobile         → role="dialog" + aria-modal (a true modal drawer);
 *   open on desktop        → nothing (an in-flow column is not a dialog).
 */
export function railA11yProps(open: boolean, isDesktop: boolean): RailA11yProps {
  if (!open) return { 'aria-hidden': true, inert: true };
  if (!isDesktop) return { role: 'dialog', 'aria-modal': true };
  return {};
}

/**
 * Focus-trap math, pure: given the drawer's focusable elements (DOM order),
 * the currently focused element, and the Tab direction, return the element
 * to force-focus — or null to let the browser move focus naturally.
 * Focus outside the drawer (or on its boundary in the exit direction) wraps
 * back inside.
 */
export function resolveTrapTarget<T>(
  focusables: readonly T[],
  active: T | null | undefined,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const inside = active != null && focusables.includes(active as T);
  if (!inside) return shiftKey ? last : first; // recapture strayed focus
  if (shiftKey) return active === first ? last : null;
  return active === last ? first : null;
}

/** What the trap considers focusable (the drawer's interactive content). */
export const RAIL_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// SSR renders no layout effects; swap to useEffect there to silence React's
// server warning (the hook only matters after hydration anyway).
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * useRailOpen — hydration-safe open state for a rail surface.
 *
 * The server (and the first client render — they MUST match) always says
 * OPEN: the deterministic desktop default. The real initial value —
 * viewport width, persisted prefs, whatever `getInitial` reads — lands in a
 * pre-paint layout effect after mount, so phones never flash an open drawer
 * and the markup never mismatches. (This replaces initializers that read
 * window.innerWidth/localStorage during render — a guaranteed server/client
 * divergence, Phase 1 item 5.)
 */
export function useRailOpen(
  getInitial?: () => boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setOpen] = useState(true); // deterministic SSR/first-render default
  const getInitialRef = useRef(getInitial);
  getInitialRef.current = getInitial;
  useIsomorphicLayoutEffect(() => {
    const fn = getInitialRef.current;
    setOpen(fn ? fn() : window.innerWidth >= RAIL_BREAKPOINT_PX);
  }, []);
  return [open, setOpen];
}

export interface AppRailProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the drawer dialog ("Chat sidebar", "Profile facts"…). */
  label: string;
  /** Which screen edge the rail lives on. Default 'left'. */
  side?: 'left' | 'right';
  /** Desktop column width in px when not resizable. Default 264 (Frontier). */
  width?: number;
  /** Live width controller (lib/use-resizable.ts) — renders the shared
   *  ResizeHandle on the rail's inner edge and drives the desktop width. */
  resizable?: Resizable;
  /** Accessible name for the resize handle. Defaults from `label`. */
  resizeLabel?: string;
  /** Extra classes on the <aside> (visual skin — bg/border are defaulted). */
  className?: string;
  /** Extra inline styles merged onto the <aside>. */
  style?: CSSProperties;
  children: ReactNode;
}

export default function AppRail({
  open, onClose, label, side = 'left', width = 264,
  resizable, resizeLabel, className, style, children,
}: AppRailProps) {
  const asideRef = useRef<HTMLElement>(null);
  // Viewport mode is client knowledge — SSR assumes desktop (in-flow column,
  // no dialog role) and matchMedia corrects + tracks it after mount.
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${RAIL_BREAKPOINT_PX}px)`);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const modal = open && !isDesktop;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Dialog behavior while the drawer is modal: move focus in (restore on
  // close), Esc closes, Tab cycles inside. html/body already never scroll
  // (globals.css), so no scroll lock is needed.
  useEffect(() => {
    if (!modal) return;
    const node = asideRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (railKeyCloses(e.key)) {
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && node) {
        const focusables = Array.from(node.querySelectorAll<HTMLElement>(RAIL_FOCUSABLE_SELECTOR));
        const target = resolveTrapTarget(
          focusables,
          document.activeElement as HTMLElement | null,
          e.shiftKey,
        );
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [modal]);

  const handleBackdrop = useCallback(() => onCloseRef.current(), []);

  const railWidth = resizable ? resizable.width : width;
  const isLeft = side === 'left';

  const handle = resizable && open && (
    <ResizeHandle
      onPointerDown={resizable.startResize}
      onReset={resizable.reset}
      onNudge={resizable.nudge}
      label={resizeLabel ?? `Resize ${label.toLowerCase()}`}
      className="hidden md:flex"
    />
  );

  return (
    <>
      {/* Mobile backdrop — tap to close. Pinned to the visual viewport. */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-(--z-overlay-backdrop) md:hidden"
          style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}
          onClick={handleBackdrop}
          aria-hidden="true"
        />
      )}

      {/* Right-side rails put the handle BEFORE the aside so it sits on the
          inner (left) edge; left-side rails put it after. */}
      {!isLeft && handle}

      <aside
        ref={asideRef}
        tabIndex={-1}
        aria-label={label}
        data-rail-open={open ? 'true' : 'false'}
        {...railA11yProps(open, isDesktop)}
        style={{
          ['--rail-w' as string]: `${railWidth}px`,
          paddingTop: 'env(safe-area-inset-top, 0px)',
          // Dynamic Island / notch in LANDSCAPE (ticket c0e58120): the island
          // eats ~59px of the side edge — without the side inset the rail's
          // controls (close X, search, rows) render under it, untappable.
          // env() is 0 on notch-free devices/orientations, so this mirrors the
          // paddingTop inset above as a no-op everywhere else.
          ...(isLeft
            ? { paddingLeft: 'env(safe-area-inset-left, 0px)' }
            : { paddingRight: 'env(safe-area-inset-right, 0px)' }),
          height: 'var(--app-height, 100dvh)',
          top: 'var(--app-top, 0px)',
          ...style,
        }}
        className={cn(
          // Digby Frontier skin (2026-10-06): raised gradient column, NO
          // border, only the inner corners rounded, and a soft one-sided
          // shadow that falls onto the main column (none while closed).
          'dg-rail-skin flex flex-col outline-none overflow-hidden',
          isLeft ? 'rounded-r-[18px]' : 'rounded-l-[18px]',
          open ? (isLeft ? 'shadow-(--rail-shadow)' : 'shadow-(--panel-shadow)') : 'shadow-none',
          // Mobile: fixed slide-over drawer — overflow-hidden clips content.
          'fixed inset-y-0 z-(--z-overlay) w-[280px] transition-[translate,box-shadow] duration-200 ease-in-out',
          isLeft ? 'left-0' : 'right-0',
          open ? 'translate-x-0' : (isLeft ? '-translate-x-full' : 'translate-x-full'),
          // Desktop (md+): an in-flow column whose WIDTH animates open/closed
          // (264px → 0, 340ms ease-out). It stays mounted while closed (inert +
          // aria-hidden) so the collapse can animate; it sits one layer above
          // the main column so its shadow falls on the chat.
          // md:h-auto! + self-stretch: in-flow, the column takes its ROW's
          // height (the drawer's --app-height pin is a mobile concern — on a
          // page with a footer under the row it overflowed into it).
          // md:min-h-0 (2026-10-20): the column is bounded by its row, never by
          // its content — the inner scroller below sizes by flex, not by a
          // percentage of an auto-height stretched item (WebKit-sensitive).
          'md:relative md:inset-auto md:flex-shrink-0 md:z-(--z-raised) md:translate-x-0 md:h-auto! md:min-h-0 md:self-stretch',
          'md:transition-[width,box-shadow] md:duration-[340ms] md:ease-(--ease-out)',
          open ? 'md:w-[var(--rail-w)]' : 'md:w-0',
          // A live drag must track the pointer 1:1 — no width easing.
          resizable?.resizing && 'md:transition-none',
          className,
        )}
      >
        {/* Inner content keeps the full rail width while the column collapses
            (no reflow mid-animation) and fades 1 → 0 over 220ms. flex-1 +
            min-h-0 rather than h-full (2026-10-20, sidebar "can't scroll"
            report from the Mac app): the aside is a flex column, so the inner
            wrapper takes its height by FLEX sizing — a percentage height
            against a stretched auto-height flex item is the one construct in
            this chain whose resolution is engine-sensitive (fine in Chromium,
            the suspect in WebKit). */}
        <div
          data-slot="rail-inner"
          className={cn(
            'flex flex-1 min-h-0 w-full flex-col transition-opacity duration-[220ms] md:w-[var(--rail-w)] md:flex-shrink-0',
            open ? 'opacity-100' : 'opacity-0',
          )}
        >
          {children}
        </div>
      </aside>

      {isLeft && handle}
    </>
  );
}
