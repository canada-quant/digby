'use client';

/**
 * AppViewportVars — the render-nothing client mount for the viewport hooks
 * (UI overhaul Phase 1). Lives in the /crossmodel LAYOUT so every route under
 * it (main chat, instances, profile, projects, files) gets:
 *  - useAppViewportVars: the pinned --app-height/--app-top vars — previously
 *    only page.tsx set them, while other routes read them and silently fell
 *    back to 100dvh;
 *  - usePwaZoomLock (ticket 013746f4): the installed-app (standalone) viewport
 *    lock — no pinch/double-tap zoom in the Home Screen app, browser tabs
 *    untouched (WCAG 1.4.4 pinch-zoom stays there).
 */

import { useAppViewportVars } from '@/lib/use-app-viewport';
import { usePwaZoomLock } from '@/lib/use-pwa-zoom-lock';

export default function AppViewportVars() {
  useAppViewportVars();
  usePwaZoomLock();
  return null;
}
