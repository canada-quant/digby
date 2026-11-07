'use client';

/**
 * /verify-email — the page the emailed verification link lands on (Phase 2
 * Cloud, todo ea95fa0b item 3).
 *
 * WHY THIS PAGE HAD TO EXIST: the backend has minted
 * `<publicUrl>/verify-email?token=…` since the leg-1 merge
 * (email-verification.service.ts verificationLinkFor), but no such route existed
 * in the frontend — so every verification email we sent delivered the user to a
 * 404. The token machinery was complete and unreachable; this closes the loop.
 *
 * DESIGN NOTES
 *  - The POST is unauthenticated on purpose (auth.routes mounts /verify-email
 *    before the guard): the link is routinely opened on a phone or in a
 *    different browser than the one that signed up, so requiring a session would
 *    strand exactly the users this feature exists to serve. The token IS the
 *    credential.
 *  - The server's refusal text is shown VERBATIM. Those messages distinguish
 *    "not valid" / "already used" / "expired" and each implies a different next
 *    step for the user; paraphrasing them here would lose that.
 *  - The call fires ONCE per token. A useEffect that re-ran on every render
 *    would burn a single-use token and then report "already used" on a link that
 *    had in fact just succeeded.
 *  - "Resend" is offered only after a failure, and it reports `mailed: false`
 *    honestly (SMTP down) instead of claiming an email arrived.
 *
 * No SiteShell: this is an account-flow page reached from an email, so it is
 * centered and chrome-light rather than part of the marketing surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CheckCircle2, Loader2, MailCheck, XCircle } from 'lucide-react';
import { authApi } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { useBranding } from '@/app/branding/BrandingProvider';

type State =
  | { kind: 'verifying' }
  | { kind: 'verified'; alreadyVerified: boolean }
  | { kind: 'error'; message: string };

function VerifyEmailInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const branding = useBranding();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState<{ mailed: boolean; error?: string } | null>(null);

  // The token is single-use: guard the POST so a re-render cannot consume it
  // twice and turn a success into an "already used" error on the very link that
  // just worked. We cache the PROMISE (not just a "did I start" flag): with
  // reactStrictMode the effect runs mount→unmount→mount, and a plain flag would
  // make the second mount return early and leave the UI stuck on "Verifying…"
  // forever. Reusing the in-flight promise both prevents the duplicate POST and
  // lets the remount render the real outcome.
  const attempt = useRef<{ token: string; promise: Promise<{ alreadyVerified: boolean }> } | null>(null);

  useEffect(() => {
    if (!token) {
      setState({ kind: 'error', message: 'This link is missing its verification token.' });
      return;
    }
    let cancelled = false;
    if (attempt.current?.token !== token) {
      attempt.current = { token, promise: authApi.verifyEmail(token) };
    }
    const promise = attempt.current.promise;

    promise
      .then((result) => {
        if (!cancelled) setState({ kind: 'verified', alreadyVerified: result.alreadyVerified });
      })
      .catch((error: any) => {
        if (cancelled) return;
        // The server's own message is the useful one (it distinguishes invalid /
        // used / expired); the fallback only covers a network-level failure.
        const msg =
          error?.response?.data?.error ||
          error?.response?.data?.message ||
          'We could not verify that link. Please request a new one.';
        setState({ kind: 'error', message: msg });
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleResend = useCallback(async () => {
    setResending(true);
    setResent(null);
    try {
      setResent(await authApi.resendVerification());
    } catch (error: any) {
      // 401 here means the browser has no session — the honest message is
      // "sign in to resend", not a generic failure.
      const status = error?.response?.status;
      setResent({
        mailed: false,
        error:
          status === 401
            ? 'Sign in first, then request a new verification email.'
            : error?.response?.data?.error || 'We could not send that email right now.',
      });
    } finally {
      setResending(false);
    }
  }, []);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-5 py-12 text-ink">
      <div className="w-full max-w-md text-center">
        {state.kind === 'verifying' && (
          <div role="status" aria-live="polite">
            <Loader2 className="mx-auto mb-5 size-8 animate-spin text-muted-foreground" />
            <h1 className="m-0 mb-2 text-2xl font-semibold">Verifying your email…</h1>
            <p className="text-sm text-muted-foreground">This only takes a moment.</p>
          </div>
        )}

        {state.kind === 'verified' && (
          <div role="status" aria-live="polite">
            <CheckCircle2 className="mx-auto mb-5 size-10 text-success" />
            <h1 className="m-0 mb-2 text-2xl font-semibold">
              {state.alreadyVerified ? 'Already verified' : 'Email verified'}
            </h1>
            <p className="mb-6 text-sm text-muted-foreground">
              {state.alreadyVerified
                ? 'This email address was already confirmed — nothing more to do.'
                : `Thanks — your email address is confirmed. Welcome to ${branding.name}.`}
            </p>
            <Button asChild className="h-11 w-full bg-send text-send-ink hover:opacity-90 border-0 font-semibold">
              <Link href="/">Start chatting</Link>
            </Button>
          </div>
        )}

        {state.kind === 'error' && (
          <div role="alert">
            <XCircle className="mx-auto mb-5 size-10 text-destructive" />
            <h1 className="m-0 mb-2 text-2xl font-semibold">That link didn&apos;t work</h1>
            <p className="mb-6 text-sm text-muted-foreground">{state.message}</p>

            <div className="space-y-3">
              <Button
                onClick={handleResend}
                disabled={resending}
                className="h-11 w-full bg-send text-send-ink hover:opacity-90 border-0 font-semibold"
              >
                {resending ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  'Send me a new link'
                )}
              </Button>

              {resent && (
                <p
                  className={
                    resent.mailed
                      ? 'flex items-center justify-center gap-1.5 text-sm text-success'
                      : 'flex items-center justify-center gap-1.5 text-sm text-destructive'
                  }
                >
                  {resent.mailed ? (
                    <>
                      <MailCheck className="size-4" />
                      Sent — check your inbox.
                    </>
                  ) : (
                    resent.error || 'We could not send that email right now.'
                  )}
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                <Link href="/login" className="underline underline-offset-2 hover:text-ink">
                  Back to sign in
                </Link>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * useSearchParams requires a Suspense boundary in the App Router (the page is
 * otherwise a client component that Next cannot statically analyse). The
 * fallback mirrors the verifying state so there is no layout jump.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-background px-5 text-ink">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <VerifyEmailInner />
    </Suspense>
  );
}