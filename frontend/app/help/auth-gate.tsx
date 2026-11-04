'use client';

/**
 * AuthGate — the /help pages use the same client auth guard as the rest of the
 * app (no middleware here; cf. /crossmodel/profile): check the Bearer token
 * after mount, bounce to /login with a redirect back on failure, spinner
 * meanwhile.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';

export function AuthGate({ children, redirectPath }: { children: React.ReactNode; redirectPath: string }) {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi.getCurrentUser()
      .then(() => { if (!cancelled) setAuthed(true); })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the gate keeps its spinner.
        if (isDefinitiveAuthFailure(err)) router.push(`/login?redirect=${encodeURIComponent(redirectPath)}`);
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
    return () => { cancelled = true; };
  }, [router, redirectPath]);

  if (!authed) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <>{children}</>;
}
