'use client';

import { useEffect, useState } from 'react';

type Platform = 'mac' | 'windows' | null;

/** macOS (not an iPad posing as a Mac) or Windows, else null. */
export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/Windows NT/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua) && maxTouchPoints <= 1) return 'mac';
  return null;
}

const DOWNLOADS = {
  mac: { href: '/Digby.dmg', label: 'Download for Mac' },
  windows: { href: '/Digby-Setup.exe', label: 'Download for Windows' },
} as const;

/**
 * The download page's hero button (2026-10-16 site review): server-rendered as
 * the browser link every visitor can use, then — on macOS or Windows — swapped
 * for that platform's installer. Phones keep the browser link (installing is
 * "Add to Home Screen", explained on the page).
 */
export default function PlatformCta({ fallbackHref, fallbackLabel, className, installers = true }: { fallbackHref: string; fallbackLabel: string; className: string; /** false on a self-host: the served installers sign into digby.ai, so keep the browser link. */ installers?: boolean }) {
  const [platform, setPlatform] = useState<Platform>(null);
  useEffect(() => { if (installers) setPlatform(detectPlatform(navigator.userAgent, navigator.maxTouchPoints)); }, [installers]);
  const target = platform ? DOWNLOADS[platform] : { href: fallbackHref, label: fallbackLabel };
  return (
    // A plain <a>: the installer is a file, never an RSC-prefetched route.
    <a href={target.href} className={className} {...(platform ? { download: '' } : {})}>
      {target.label}
      <span aria-hidden="true">{platform ? '↓' : '→'}</span>
    </a>
  );
}
