'use client';

/**
 * ThinkingAd — the Google Ad Manager (GPT) "Digby-Thinking" slot
 * (/22890879159/digby_think), shown UNDER the status responses while a
 * response/run is streaming. The only mount is the unified session view
 * (CodeSessionView.tsx — all chat surfaces converged on it in the C3
 * convergence); page.tsx still loads gpt.js once at the page root
 * (<Script id="gpt-js">, afterInteractive). The parent surface mounts this
 * only while a generation/run is live, so it is automatically removed when the
 * response finishes — the unmount cleanup destroys the GPT slot, and the next
 * stream defines a fresh one (Google's recommended SPA pattern), so every
 * response requests a new ad and no stale creative survives navigation.
 *
 * Tag constants: the div id + gpt.js loading match the CURRENT Ad Manager tag
 * (2026-08 — re-copy from Ad Manager › Digby-Thinking if the unit is
 * regenerated): div id div-gpt-ad-1787251643252-0, gpt.js loaded once at the
 * page root (page.tsx <Script id="gpt-js">, afterInteractive). The size list
 * is now a deliberate SUBSET of the tag (ticket c43b9cc5, see below).
 *
 * Ticket c43b9cc5 (owner, 2026-09-01): AdX kept BREAKING OUT of the requested
 * sizes ("very large ads even though i only said a few sizes"). The breakout
 * vectors were (a) 'fluid' in the size list — fluid creatives ignore fixed
 * dimensions and size to the container, (b) declared sizes up to 468×60 /
 * 400×480 / 300×600, and (c) SafeFrame rich-media expansion (allowed by
 * default). The fix is request-side first: the slot DECLARES only sizes
 * ≤336×280 — GPT filters creatives to declared sizes, so nothing larger can
 * ever be selected and no rendered creative is ever clipped (staying clear
 * of the ad-modification policy) — plus a SafeFrame expansion lock, with the
 * container's CSS cap as a purely defensive backstop.
 *
 * Ticket 73a56b14 (owner, 2026-09-01): "reserve the size of the container of
 * the ad slot height 336 or maybe 341 so when ad fills it doesn't jump the
 * whole chat upwards so the chat scrolls seamlessly." The slot is an async
 * late-fill: the chat paints, then the creative arrives and shoves everything
 * below it. The container now RESERVES AD_RESERVE_HEIGHT from mount while the
 * fetch is pending (336 ≥ the tallest possible content: 280 creative + ~19px
 * caption + 16px padding ≈ 315, so the fill NEVER exceeds the reservation:
 * nothing above the ad moves — the chat-jump the owner reported is gone),
 * then sizes down to the real creative on slotRenderEnded (a settle that only
 * pulls up elements BELOW the slot) — or drops the reservation when unfilled,
 * so the no-ad case keeps no reserved box (collapseEmptyDivs still handles
 * the slot div itself). Ad-block users (gpt.js never loads, no render event)
 * get the reservation dropped by the AD_RESERVE_TIMEOUT_MS fallback so they
 * never keep a permanent 336px blank box.
 *
 * Audience: every viewer EXCEPT Kids mode (COPPA) — re-added for signed-in
 * users per owner directive 2026-08-19, reversing 3ad882b1's anonymous-only
 * gate. To re-gate, restore `&& !user` at the page.tsx mount (coding sessions
 * already require sign-in, so there is no anonymous case there).
 *
 * Every GPT call is wrapped in try/catch: an ad failure (or an ad blocker
 * killing gpt.js, leaving googletag.cmd an inert array) must NEVER break the
 * chat — pushes just no-op.
 */

import { useEffect, useRef, useState } from 'react';

const GPT_AD_UNIT = '/22890879159/digby_think';
const GPT_AD_DIV = 'div-gpt-ad-1787251643252-0';
/** Hard cap on the ad spot (ticket c43b9cc5): no creative larger than 336×280. */
export const AD_MAX_WIDTH = 336;
export const AD_MAX_HEIGHT = 280;
/**
 * Reserved container height while the slot fetch is PENDING (ticket 73a56b14 —
 * owner: "height 336 or maybe 341"). 336 ≥ the tallest possible filled content
 * (280 creative + ~19px caption + 16px padding ≈ 315), so a late creative fill
 * NEVER pushes the chat: the space was already there.
 */
export const AD_RESERVE_HEIGHT = 336;
/**
 * Ad-blocker / no-event fallback (ticket 73a56b14): when gpt.js never loads
 * (blocker, offline), slotRenderEnded never fires — without this timer the
 * reservation would pin a permanent 336px blank box for blocked users. After
 * the window the reservation drops; a fill past the window re-expands once
 * (rare, and still capped by AD_MAX_*).
 */
export const AD_RESERVE_TIMEOUT_MS = 4000;
/**
 * Declared slot sizes — the REQUEST-side constraint (ticket c43b9cc5): a
 * deliberate ≤336×280 subset of the Ad Manager tag's size list. GPT only
 * selects creatives matching a declared size, so the oversized creatives
 * (468×60 / 400×480 / 300×600 …) can no longer serve, and 'fluid' — the
 * breakout vector that sizes to the container — is gone entirely. With every
 * declared size ≤336px wide, the old viewport sizeMapping is unnecessary.
 */
export const GPT_AD_SIZES: ReadonlyArray<readonly [number, number]> = [
  [336, 280], [300, 250], [300, 100], [320, 160], [320, 100], [320, 50],
];
/**
 * SafeFrame expansion lock (ticket c43b9cc5): rich-media creatives may not
 * expand beyond the slot (overlay or push) — the second breakout vector.
 * Page-level GPT config, applied once before enableServices.
 */
export function buildSafeFrameConfig() {
  return { safeFrame: { allowOverlayExpansion: false, allowPushExpansion: false } };
}

export default function ThinkingAd() {
  const slotRef = useRef<any>(null);
  const renderCbRef = useRef<any>(null);
  // 'pending' = fetch in flight → container holds the AD_RESERVE_HEIGHT
  // reservation (ticket 73a56b14); 'filled' = creative rendered; 'empty' =
  // unfilled/blocked → the reservation is dropped (the slot div's own 50px
  // placeholder behavior is unchanged — GPT's collapseEmptyDivs hides it when
  // gpt.js loads).
  const [status, setStatus] = useState<'pending' | 'filled' | 'empty'>('pending');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Set on unmount. If gpt.js hasn't loaded yet our define closure is still
    // sitting in the inert googletag.cmd array — without this guard it would
    // run LATER against an unmounted div, leaking the slot + listener for the
    // page lifetime (and firing an ad request for a non-viewable slot).
    let disposed = false;
    // Ad-blocker fallback (ticket 73a56b14): no slotRenderEnded within the
    // window → drop the reservation so blocked users keep no blank box.
    const reserveTimer = window.setTimeout(() => {
      if (!disposed) setStatus((s) => (s === 'pending' ? 'empty' : s));
    }, AD_RESERVE_TIMEOUT_MS);
    const w = window as any;
    w.googletag = w.googletag || { cmd: [] };
    w.googletag.cmd.push(() => {
      if (disposed) return;
      try {
        const googletag = w.googletag;
        // Reset any stale registration for our (only) slot, then define fresh so a
        // new ad is requested for each response.
        try { googletag.destroySlots(); } catch { /* ignore */ }
        const slot = googletag.defineSlot(GPT_AD_UNIT, GPT_AD_SIZES, GPT_AD_DIV);
        if (!slot) return;
        slot.addService(googletag.pubads());
        slotRef.current = slot;
        // Only show the "Advertisement" caption when a creative actually fills the
        // slot — collapseEmptyDivs removes the empty box but not our label, which
        // otherwise floats above blank space. The same event ends the height
        // reservation (ticket 73a56b14): filled → size to the creative, empty →
        // drop the reservation.
        const onRender = (e: any) => { if (!disposed && e.slot === slot) setStatus(e.isEmpty ? 'empty' : 'filled'); };
        renderCbRef.current = onRender;
        googletag.pubads().addEventListener('slotRenderEnded', onRender);
        if (!w.__digbyGptInit) {
          // SafeFrame expansion lock (ticket c43b9cc5) — page-level config,
          // best-effort on older gpt.js; must land before enableServices.
          try { googletag.setConfig(buildSafeFrameConfig()); } catch { /* ignore */ }
          googletag.pubads().enableSingleRequest();
          googletag.pubads().collapseEmptyDivs(true); // no blank box when unfilled
          googletag.enableServices();
          w.__digbyGptInit = true;
        }
        googletag.display(GPT_AD_DIV);
      } catch { /* ad failures must never break the chat */ }
    });
    return () => {
      disposed = true;
      window.clearTimeout(reserveTimer);
      try {
        const gt = (window as any).googletag;
        if (gt?.cmd && slotRef.current) {
          const slot = slotRef.current;
          const onRender = renderCbRef.current;
          slotRef.current = null;
          renderCbRef.current = null;
          gt.cmd.push(() => {
            try { if (onRender) gt.pubads().removeEventListener('slotRenderEnded', onRender); } catch { /* ignore */ }
            try { gt.destroySlots([slot]); } catch { /* ignore */ }
          });
        }
      } catch { /* ignore */ }
    };
  }, []);
  return (
    // Reserved height while pending (ticket 73a56b14): the space exists BEFORE
    // the async creative arrives, so a fill never pushes the chat; on render the
    // reservation lifts (filled → real creative height ≤ the reservation; empty
    // → collapse). The reservation lives on the OUTER wrapper so it covers the
    // caption + padding too.
    // Centered (owner 2026-10-07: "center the google ads better and the
    // advertisement text"): the column centers the caption and the slot, and
    // the slot centers GPT's iframe inside the 336px cap — a 300px creative
    // used to sit flush left in that box, ~18px off the chat's centre line.
    <div
      className="flex w-full max-w-full flex-col items-center overflow-hidden px-3 sm:px-5 pb-3 pt-1"
      style={status === 'pending' ? { minHeight: AD_RESERVE_HEIGHT } : undefined}
      data-thinking-ad
    >
      {status === 'filled' && <p className="mb-1 w-full text-center text-[10px] text-muted-foreground/40">Advertisement</p>}
      {/* Hard 336×280 cap (ticket c43b9cc5): the trimmed size list already
          prevents any larger creative from serving, so this clip is a purely
          defensive backstop that never engages in practice (no policy-risky
          clipping of a rendered ad). min-height 50 matches the Ad Manager
          body-tag placeholder. GPT injects a block container div holding an
          inline iframe — both are centered here. */}
      <div
        id={GPT_AD_DIV}
        className="mx-auto w-full max-w-full overflow-hidden text-center [&>div]:mx-auto [&_iframe]:mx-auto [&_iframe]:block [&_iframe]:max-w-full"
        style={{ minHeight: 50, maxWidth: AD_MAX_WIDTH, maxHeight: AD_MAX_HEIGHT }}
      />
    </div>
  );
}
