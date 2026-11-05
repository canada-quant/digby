"use client";

import { useEffect, useRef, useState } from "react";
import { useBranding } from "@/app/branding/BrandingProvider";

const DISMISSED_KEY = "pwa-install-dismissed";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function PWAInstallPrompt() {
  const branding = useBranding();
  const [visible, setVisible] = useState(false);
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Never prompt inside the installed app itself.
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (isStandalone) return;

    // Don't show on iOS — iOS doesn't support beforeinstallprompt
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) return;

    // Check if dismissed within the last 30 days
    const dismissed = localStorage.getItem(DISMISSED_KEY);
    if (dismissed) {
      const dismissedAt = parseInt(dismissed, 10);
      if (Date.now() - dismissedAt < THIRTY_DAYS_MS) return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setVisible(true);
    };

    const handleAppInstalled = () => {
      setVisible(false);
      deferredPrompt.current = null;
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt.current) return;
    await deferredPrompt.current.prompt();
    const { outcome } = await deferredPrompt.current.userChoice;
    // prompt() is single-use — the deferred event is spent either way, so
    // always hide and clear. Dismissing the NATIVE sheet counts as a
    // dismissal too (same snooze as our own ✕), otherwise the banner sits
    // there wired to a dead prompt.
    setVisible(false);
    deferredPrompt.current = null;
    if (outcome === "dismissed") {
      localStorage.setItem(DISMISSED_KEY, Date.now().toString());
    }
  };

  const handleDismiss = () => {
    setVisible(false);
    localStorage.setItem(DISMISSED_KEY, Date.now().toString());
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label={`Install ${branding.name}`}
      className="fixed left-1/2 z-(--z-rail) flex w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-2xl"
      style={{ bottom: 'calc(7.25rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <img
        src={branding.assets.icon192}
        alt=""
        width={32}
        height={32}
        className="shrink-0 rounded-lg"
      />
      <p className="flex-1 text-sm text-card-foreground">
        Install {branding.name} for the best experience
      </p>
      <button
        type="button"
        onClick={handleInstall}
        className="shrink-0 rounded-lg bg-brand px-3 min-h-11 py-1.5 text-xs font-semibold text-brand-foreground transition-colors hover:bg-brand-hover active:bg-brand-hover touch-manipulation"
      >
        Install
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss install prompt"
        className="shrink-0 inline-flex items-center justify-center size-7 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 rounded-md text-muted-foreground transition-colors hover:text-foreground touch-manipulation"
      >
        <span className="sr-only">Dismiss install prompt</span>
        ✕
      </button>
    </div>
  );
}
