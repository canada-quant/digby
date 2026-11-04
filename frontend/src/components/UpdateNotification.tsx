'use client';

import { useEffect, useRef } from 'react';
import { SW_RELOAD_EVENT } from '@/lib/sw-update-draft';
import { SW_RELOAD_AT_KEY, SW_VERSION_KEY, shouldReloadForSwVersion, versionToStore } from '@/lib/sw-version';

/**
 * Silent SW update handler.
 * When the service worker signals a new version is available, automatically
 * reload the page after 1 second — no toast, no confetti, no user interaction.
 *
 * P5 correctness pass (three defects fixed):
 *  - the `updatefound` listener sat on the LONG-LIVED registration and was
 *    never removed — every mount leaked one; it is now removed on cleanup;
 *  - the 3-minute update-check interval was armed inside the async
 *    `serviceWorker.ready.then(...)`: an unmount while `ready` was pending ran
 *    the cleanup FIRST (interval ref still null), then the promise resolved
 *    and armed an interval nothing could ever clear. The `disposed` flag now
 *    bails before arming, and the pending reload timeout is cleared too;
 *  - `location.reload()` unconditionally DISCARDED any in-progress chat draft.
 *    Right before reloading we now dispatch SW_RELOAD_EVENT so every mounted
 *    composer stashes its non-empty draft to sessionStorage
 *    (ChatComposerTextarea restores it on the post-reload mount).
 *
 * Rollout ping-pong (owner recording 2026-10-07, "macOS keeps refreshing"):
 * mid-deploy the ALB serves /sw.js from both boxes, and "different from the
 * stored version" reloaded on every alternation (~2.5 s loop). Now only a
 * STRICTLY NEWER version reloads, the stored version never goes down, and
 * automatic reloads are at most one per SW_RELOAD_MIN_GAP_MS (lib/sw-version).
 */
export function UpdateNotification() {
  const reloadScheduledRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let disposed = false;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let registration: ServiceWorkerRegistration | null = null;

    const scheduleReload = () => {
      if (reloadScheduledRef.current || disposed) return;
      reloadScheduledRef.current = true;
      reloadTimer = setTimeout(() => {
        // Tell SW to skip waiting so the new version takes over on reload
        navigator.serviceWorker.ready.then((reg) => {
          if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }).catch(() => {});
        // Store current version so reload doesn't loop; stamp the reload
        // clock so a second automatic reload within the gap is skipped.
        try {
          localStorage.setItem(SW_VERSION_KEY, 'reloading');
          localStorage.setItem(SW_RELOAD_AT_KEY, String(Date.now()));
        } catch { /* storage blocked — the version rule still holds */ }
        // Let mounted composers stash an in-progress draft (sessionStorage)
        // before the page is discarded — restored on the post-reload mount.
        try { window.dispatchEvent(new Event(SW_RELOAD_EVENT)); } catch { /* never block the update */ }
        window.location.reload();
      }, 1000);
    };

    // Only reload if we KNOW there's actually a new version.
    // Never reload on SW_UPDATED alone — that fires on every SW activation,
    // including first visit, causing a reload loop on mobile.
    const scheduleReloadIfNewVersion = (version: string) => {
      let lastKnown: string | null = null;
      let lastReloadAt: number | null = null;
      try {
        lastKnown = localStorage.getItem(SW_VERSION_KEY);
        const at = Number(localStorage.getItem(SW_RELOAD_AT_KEY));
        lastReloadAt = Number.isFinite(at) && at > 0 ? at : null;
      } catch { /* storage blocked → never auto-reload */ return; }
      if (shouldReloadForSwVersion({ lastKnown, incoming: version, lastReloadAt, now: Date.now() })) {
        scheduleReload();
      }
      try { localStorage.setItem(SW_VERSION_KEY, versionToStore(lastKnown, version)); } catch { /* ignore */ }
    };

    // Method 1: postMessage from SW (fires when SW updates while page is open)
    // Do NOT auto-reload here — version check below handles it safely
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SW_UPDATED') {
        // Just acknowledge — version check loop will detect the change and reload once
      }
    };

    // Listen for new SW being found (updatefound event)
    const onUpdateFound = () => {
      const newWorker = registration?.installing;
      if (!newWorker) return;
      let skipWaitingRequested = false;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && !skipWaitingRequested) {
          skipWaitingRequested = true;
          // Check version before reloading — only reload if version actually changed
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => {
            if (e.data?.type === 'SW_VERSION') scheduleReloadIfNewVersion(e.data.version);
          };
          newWorker.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
        }
      });
    };

    navigator.serviceWorker.addEventListener('message', handleMessage);

    navigator.serviceWorker.ready.then((reg) => {
      // Unmounted while `ready` was pending: cleanup already ran, so arming
      // the interval / registration listener here would leak them forever.
      if (disposed) return;
      registration = reg;

      // Force SW update check now
      reg.update().catch(() => {});

      // Periodic SW update check — every 3 minutes while tab is open
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = setInterval(() => {
        reg.update().catch(() => {});
      }, 3 * 60 * 1000);

      reg.addEventListener('updatefound', onUpdateFound);

      if (!reg.active) return;
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (e.data?.type === 'SW_VERSION') scheduleReloadIfNewVersion(e.data.version);
      };
      reg.active.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    }).catch(() => {});

    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener('message', handleMessage);
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (reloadTimer) clearTimeout(reloadTimer);
      registration?.removeEventListener('updatefound', onUpdateFound);
    };
  }, []);

  // No UI — completely silent
  return null;
}
