'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { BrandLogo } from '@/components/ui/custom/BrandLogo';
import { useBranding } from '@/app/branding/BrandingProvider';
import { shouldReloadForChunkError } from '@/lib/chunk-reload';
import { reportBoundaryError } from './ClientErrorReporter';

// App-root error boundary (added with the Next.js 16.3.3 upgrade — 16.2 swapped
// the default 500 page, so we own a branded one instead of relying on it).
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const branding = useBranding();
  useEffect(() => {
    console.error('[app-error-boundary]', error);
    // Deploy skew (2026-09-14): the blue-green deploy lands box A before box B
    // and the ALB alternates between them for a few minutes — a stale/missing
    // chunk is fixed by exactly one reload, so do it for the user (once; the
    // sessionStorage stamp keeps a truly broken bundle from looping).
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { storage = null; }
    const reloaded = shouldReloadForChunkError(error, storage);
    // A React render crash is the one class the global `error` listener cannot
    // see — React catches it into this boundary before it reaches window.onerror.
    // Report it through the same scrubbed path as everything else (ticket
    // d4e643a5) so it reaches app_error_logs and the hourly sweep can file it.
    //
    // EXCEPT chunk-load errors (adversarial review MAJOR 4, 2026-11-06): that
    // class is DESIGNED, self-healing deploy skew — it recurs on every
    // blue-green deploy across several hours, so rule 1 would fire and the
    // sweep would file a "ticket" for a non-defect every single deploy, eating
    // the 5/day filing budget that real client faults need. `reportBoundaryError`
    // drops it (isChunkLoadError); the reload above still heals the user.
    reportBoundaryError(error, { suppressChunkLoad: true });
    if (reloaded) window.location.reload();
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-center">
      <div className="size-12 rounded-2xl overflow-hidden shadow-lg mb-4">
        <BrandLogo size={48} className="w-full h-full object-cover" />
      </div>
      <h2 className="font-bold text-lg mb-1">Something went wrong</h2>
      <p className="text-sm text-muted-foreground mb-4">
        An unexpected error occurred. Try again, or head back to the chat.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" onClick={() => (window.location.href = '/')}>
          Back to chat
        </Button>
      </div>
    </div>
  );
}
