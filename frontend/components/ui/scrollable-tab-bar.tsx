'use client';

/**
 * ScrollableTabBar — ONE tab-strip primitive for page chrome (Account,
 * Management, project settings, Admin sub-nav).
 *
 * The previous copies were `flex overflow-x-auto` with no overflow cue, no
 * keyboard roving tabindex, and 36–40px hit targets. On a 320px phone the
 * Account/Management/project strips silently clip; this one:
 *   - fade edges when content overflows (so "more tabs" is visible)
 *   - snap-aligns tabs and auto-scrolls the active one into view
 *   - role="tablist" + roving tabindex (Arrow/Home/End)
 *   - 44px min hit area on coarse pointers (WCAG 2.5.5)
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export interface ScrollableTab<T extends string = string> {
  id: T;
  label: string;
  icon?: React.ElementType;
  badge?: number;
  disabled?: boolean;
}

/** Pure: which tab index a keyboard event should activate. */
export function nextTabIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

export function ScrollableTabBar<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  size = 'default',
  className,
}: {
  tabs: readonly ScrollableTab<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  size?: 'default' | 'sm';
  className?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const updateOverflow = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const max = scrollWidth - clientWidth;
    setOverflow({
      left: scrollLeft > 2,
      right: max > 2 && scrollLeft < max - 2,
    });
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateOverflow();
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    el.addEventListener('scroll', updateOverflow, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateOverflow);
    };
  }, [updateOverflow, tabs.length]);

  useEffect(() => {
    const node = tabRefs.current.get(value);
    // A JS-specified behavior wins over the reduced-motion CSS — honour it here too.
    const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [value]);

  const enabled = tabs.filter((t) => !t.disabled);
  // Roving tabindex fallback (review 2026-09-14): when `value` matches no
  // tab (e.g. ?tab=admin for a non-admin) the strip must stay reachable —
  // the first enabled tab takes the tab stop instead of nobody.
  const hasActive = enabled.some((t) => t.id === value);
  const fallbackId = hasActive ? null : enabled[0]?.id ?? null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = enabled.findIndex((t) => t.id === value);
    const next = nextTabIndex(Math.max(0, idx), enabled.length, e.key);
    if (next == null) return;
    e.preventDefault();
    const id = enabled[next].id;
    onChange(id);
    tabRefs.current.get(id)?.focus();
  };

  const compact = size === 'sm';

  return (
    <div className={cn('relative min-w-0', className)}>
      <div
        ref={scrollerRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="flex gap-0.5 overflow-x-auto overscroll-x-contain scrollbar-none snap-x snap-mandatory [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === value;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active || tab.id === fallbackId ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => onChange(tab.id)}
              className={cn(
                'relative shrink-0 snap-start inline-flex items-center justify-center gap-1.5 border-b-2 whitespace-nowrap font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'disabled:pointer-events-none disabled:opacity-40',
                compact
                  ? 'min-h-10 px-3 py-2 text-xs [@media(pointer:coarse)]:min-h-11'
                  : 'min-h-11 px-3.5 py-2.5 text-sm',
                active
                  ? 'border-brand-accent text-brand-text'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40',
              )}
            >
              {Icon && <Icon className={cn('shrink-0', compact ? 'size-3.5' : 'size-4')} aria-hidden />}
              {tab.label}
              {tab.badge != null && tab.badge > 0 && (
                <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-send text-send-ink text-[9px] font-bold leading-none">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {overflow.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent"
        />
      )}
      {overflow.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent"
        />
      )}
    </div>
  );
}
