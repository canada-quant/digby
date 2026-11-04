'use client';

/**
 * MessageNavigator — kimi-style right-edge tick rail for fast transcript
 * navigation. Every rendered row carrying [data-nav-msg] (the user's own
 * messages — CodeSessionView stamps them) gets a slim tick on the rail,
 * positioned proportionally to the message's place in the scrollable content
 * (minimap mapping: tick% = message-center% of scrollHeight). Desktop: hover a
 * tick to preview the message's first words, click to smooth-scroll it to the
 * top. Mobile (no hover): the same ticks are always visible and tap-to-jump,
 * with a full 44px touch target (the tick VISUAL stays slim) — the preview
 * card is md-gated so a tap can never latch it.
 *
 * Fully DOM-driven: positions come from live rects, re-measured via
 * MutationObserver (rows added/removed) + ResizeObserver (async growth —
 * markdown, highlighting, images, live-run streaming — plus container
 * resizes). No scroll listener: rect-vs-scrollTop math is scroll-independent.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

/** First-words preview for a tick's hover card: whitespace-collapsed, ~64 chars. */
export function navPreview(content: string): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= 64 ? flat : `${flat.slice(0, 63)}…`;
}

export interface NavTick {
  id: string;
  preview: string;
  /** 0..1 — message-center as a fraction of the full scrollHeight. */
  pct: number;
}

/**
 * Drop ticks that would land closer than minGapPx on the rail (a burst of
 * short consecutive messages collapses to one tick) — keep the earlier one.
 * railHeightPx <= 0 (unmeasured) passes everything through.
 */
export function dropCollisions(ticks: NavTick[], railHeightPx: number, minGapPx = 16): NavTick[] {
  if (railHeightPx <= 0 || ticks.length < 2) return ticks;
  const out: NavTick[] = [];
  let lastPx = -Infinity;
  for (const t of ticks) {
    const px = t.pct * railHeightPx;
    if (px - lastPx >= minGapPx) {
      out.push(t);
      lastPx = px;
    }
  }
  return out;
}

/** Shallow compare so observer-driven rescans don't re-render on every fire. */
function sameTicks(a: NavTick[], b: NavTick[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].preview !== b[i].preview || Math.abs(a[i].pct - b[i].pct) > 0.0005) return false;
  }
  return true;
}

type DivRef = { current: HTMLDivElement | null };

export default function MessageNavigator({ scrollerRef, contentRef }: {
  scrollerRef: DivRef;
  contentRef: DivRef;
}) {
  const [ticks, setTicks] = useState<NavTick[]>([]);

  const scan = useCallback(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    // No overflow → everything is visible → nothing to navigate.
    if (scroller.scrollHeight <= scroller.clientHeight + 1) {
      setTicks(prev => (prev.length ? [] : prev));
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const next: NavTick[] = [];
    content.querySelectorAll<HTMLElement>('[data-nav-msg]').forEach(node => {
      const rect = node.getBoundingClientRect();
      const top = rect.top - scrollerRect.top + scroller.scrollTop;
      const pct = (top + rect.height / 2) / scroller.scrollHeight;
      next.push({
        id: node.getAttribute('data-nav-msg') || '',
        preview: node.getAttribute('data-nav-preview') || '',
        pct: Math.min(1, Math.max(0, pct)),
      });
    });
    // The rail spans the scroller's viewport height — filter in its pixels.
    const filtered = dropCollisions(next, scroller.clientHeight);
    setTicks(prev => (sameTicks(prev, filtered) ? prev : filtered));
  }, [scrollerRef, contentRef]);

  // First paint.
  useLayoutEffect(() => { scan(); }, [scan]);

  // Rows added/removed (message send/receive, windowing) + ANY size change
  // (async render growth, live streaming, panel/keyboard/orientation resizes).
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const mo = new MutationObserver(scan);
    mo.observe(content, { childList: true, subtree: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(scan);
      ro.observe(content);
      ro.observe(scroller);
    }
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, [scan, scrollerRef, contentRef]);

  const jump = useCallback((id: string) => {
    const scroller = scrollerRef.current;
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-nav-msg="${CSS.escape(id)}"]`);
    if (!scroller || !row) return;
    const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    // Smooth is safe here: jumping UP breaks the pin via the transcript's own
    // scroll handler (genuine upward move), so the live-stream stick can't
    // fight the flight — the jump-to-latest pill takes over instead.
    scroller.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
  }, [scrollerRef, contentRef]);

  if (!ticks.length) return null;

  return (
    <div className="absolute inset-y-0 right-0 w-2 z-20 pointer-events-none">
      {ticks.map(t => (
        <div key={t.id} className="group/nav absolute right-[2px]" style={{ top: `${t.pct * 100}%` }}>
          <button
            type="button"
            onClick={() => jump(t.id)}
            aria-label={t.preview ? `Jump to your message: ${t.preview}` : 'Jump to your message'}
            // Mobile: a full 44×44px hit area (WCAG touch target — P2 item 2);
            // the tick VISUAL stays slim and hugs the right edge (justify-end +
            // pr keeps its center where the old 14px box put it). Desktop (md+,
            // the app's one mobile breakpoint) keeps the slim pointer target.
            className="pointer-events-auto flex size-11 -translate-y-1/2 items-center justify-end pr-[5px] md:h-[22px] md:w-[10px] md:justify-center md:pr-0">
            <span className="block h-[14px] w-[3px] rounded-full bg-line-2 transition-colors group-hover/nav:bg-ink-3" />
          </button>
          {/* Hover-only preview card — md+ only: on touch, a tap latches
              :hover and the card would stick over the transcript (P2 item 2). */}
          <div className="pointer-events-none absolute right-full top-1/2 mr-1 hidden -translate-y-1/2 md:group-hover/nav:block">
            <div className="max-w-[220px] truncate rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground shadow-md">
              {t.preview}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
