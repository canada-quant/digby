'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { shouldReloadForChunkError } from '@/lib/chunk-reload';

// App-root error boundary (added with the Next.js 16.3.3 upgrade — 16.2 swapped
// the default 500 page, so we own a branded one instead of relying on it).
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app-error-boundary]', error);
    // Deploy skew (2026-09-14): the blue-green deploy lands box A before box B
    // and the ALB alternates between them for a few minutes — a stale/missing
    // chunk is fixed by exactly one reload, so do it for the user (once; the
    // sessionStorage stamp keeps a truly broken bundle from looping).
    let storage: Storage | null = null;
    try { storage = window.sessionStorage; } catch { storage = null; }
    if (shouldReloadForChunkError(error, storage)) window.location.reload();
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-center">
      <div className="size-12 rounded-2xl overflow-hidden shadow-lg mb-4">
        <Image src="/digbyhat.png" alt="Digby" width={48} height={48} className="w-full h-full object-cover" />
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
