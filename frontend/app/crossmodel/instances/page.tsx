'use client';

/**
 * Connected instances (Digby Edge Phase 4) — landing view. ADMIN-only: the
 * instances API 403s non-admins, and this page redirects them back to the main
 * chat. The left rail is the ConnectedInstancesSection (same component the
 * instance chat view uses); the main area prompts for a selection.
 *
 * UI overhaul Phase 1: the rail rides the shared AppRail shell — on phones it
 * is now a REAL drawer (dialog semantics + backdrop) opened by the floating
 * list button; before this pass the rail was a static column with no mobile
 * affordance at all.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, PanelLeftOpen, Server } from 'lucide-react';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import AppRail, { useRailOpen } from '@/components/ui/custom/app-rail';
import { ConnectedInstancesSection } from '../components/ConnectedInstancesSection';

export default function InstancesPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);
  // Open on desktop (static column), closed on phones until the button opens
  // the drawer — the primitive's SSR-safe default.
  const [railOpen, setRailOpen] = useRailOpen();

  useEffect(() => {
    authApi.getCurrentUser()
      .then(u => {
        if (u.role !== 'ADMIN') router.replace('/');
        else setAllowed(true);
      })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the spinner stays.
        if (isDefinitiveAuthFailure(err)) router.push('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
  }, [router]);

  if (!allowed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-brand-accent" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background overflow-hidden" style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}>
      {/* Left rail — same width/chrome as the main chat sidebar. */}
      <AppRail open={railOpen} onClose={() => setRailOpen(false)} label="Connected instances list">
        <div className="p-2 border-b flex items-center gap-1">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-1.5 rounded-md px-2 py-2 min-h-10 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to chats
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          <ConnectedInstancesSection />
        </div>
      </AppRail>

      <main className="relative flex-1 flex items-center justify-center">
        {/* Mobile: open the instances drawer (below md the rail is a drawer). */}
        <button
          onClick={() => setRailOpen(true)}
          title="Open instances list"
          aria-label="Open instances list"
          className="md:hidden absolute left-3 size-10 inline-flex items-center justify-center rounded-lg border bg-card text-muted-foreground hover:text-foreground transition-colors"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 10px)' }}
        >
          <PanelLeftOpen className="size-4" />
        </button>
        <div className="text-center space-y-3 max-w-sm px-6">
          <Server className="size-10 text-brand-accent/50 mx-auto" />
          <h1 className="text-sm font-semibold">Connected instances</h1>
          <p className="text-xs text-muted-foreground">
            Select a paired instance on the left and expand it to browse its chats — or pair a new self-hosted Digby with the Pair instance button.
          </p>
        </div>
      </main>
    </div>
  );
}
