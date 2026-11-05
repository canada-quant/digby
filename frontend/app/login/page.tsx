'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authApi } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/ui/custom/BrandLogo';
import { useBranding } from '@/app/branding/BrandingProvider';
import { PasswordToggle } from '@/components/ui/password-toggle';
import { reportGoogleAdsSignup } from '@/lib/google-ads';
import { trackVisitEvent } from '@/lib/visitor-analytics';
import { currentFbc, newMetaEventId, reportMetaSignup } from '@/lib/meta-pixel';

type Tab = 'login' | 'signup';

/**
 * Login-panel feature grid (ticket ad9ef768). Every claim below is
 * repo-verifiable: multi-model council + synthesis (chat-agent), user memory
 * with forget-on-command (platform tools), canvas document/code/html/mermaid
 * with share + save, projects + knowledge documents (RAG), coding sessions
 * with their own worktree/branch/PR, schedules + inbound webhooks +
 * sub-sessions, MCP integrations (Gmail/Slack/Asana/GitHub/Google/X) and
 * paired computer use (Mac/PC agents). Keep it that way — no aspirational
 * features on a login page.
 */
const LOGIN_FEATURES: { icon: string; title: string; desc: string; wide?: boolean }[] = [
  { icon: '🧠', title: 'The whole AI council', desc: 'Frontier and open-source models queried in parallel, cross-checked, and blended into one answer.' },
  { icon: '🎭', title: 'Learns who you are', desc: 'Remembers your style, projects and context across sessions — and forgets on command.' },
  { icon: '📋', title: 'Canvas workspace', desc: 'Documents, code, diagrams and HTML live-edit beside the chat — share or save them.' },
  { icon: '📁', title: 'Projects & knowledge', desc: 'Organise chats into projects and upload documents — a private knowledge base that grounds every answer.' },
  { icon: '🚀', title: 'Coding sessions that ship', desc: 'Hand Digby a task: it gets its own worktree and branch, codes, tests, and opens the PR.' },
  { icon: '⏰', title: 'A fleet while you sleep', desc: 'Schedule recurring runs, wake sessions from webhooks, spawn sub-agents that report back.' },
  { icon: '🛠️', title: 'Works inside your tools', wide: true, desc: 'Gmail, Slack, Asana, GitHub, Google Drive and X — read and acted on where the work already lives. Pair a Mac or PC and Digby can drive its screen.' },
];

function LoginContent() {
  const branding = useBranding();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tab, setTab] = useState<Tab>(
    searchParams.get('signup') === 'true' ? 'signup' : 'login'
  );
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Login form
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Signup form
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');
  const [signupName, setSignupName] = useState('');

  // First-party visitor analytics (owner 2026-10-07): which auth form the visitor saw — a funnel step.
  useEffect(() => { trackVisitEvent(tab === 'signup' ? 'signup_view' : 'login_view'); }, [tab]);

  // Redirect back to /crossmodel after success (or wherever they came from)
  const redirectTo = searchParams.get('redirect') || '/';

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim() || !loginPassword) return;
    setFormError(null);
    setIsLoading(true);
    try {
      await authApi.login({ email: loginEmail.trim(), password: loginPassword.trim() });
      // Visitor analytics: the client copy of the login step (the server records it authoritatively too).
      trackVisitEvent('login', undefined, { flush: true });
      toast.success('Welcome back! 👋');
      router.push(redirectTo);
    } catch (error: any) {
      const msg = error.response?.data?.error || error.response?.data?.message || 'Login failed. Check your email and password.';
      setFormError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signupEmail.trim() || !signupPassword) return;

    if (signupPassword.length < 8) {
      setFormError('Password must be at least 8 characters');
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (signupConfirm && signupPassword !== signupConfirm) {
      setFormError("Passwords don't match");
      toast.error("Passwords don't match");
      return;
    }

    setFormError(null);
    setIsLoading(true);
    try {
      // Split name into first/last
      const nameParts = signupName.trim().split(' ');
      const firstName = nameParts[0] || undefined;
      const lastName = nameParts.slice(1).join(' ') || undefined;

      // One Meta event id for the browser pixel AND the server's Conversions API event (deduplicated by Meta).
      const metaEventId = newMetaEventId();
      await authApi.register({
        email: signupEmail.trim(),
        password: signupPassword.trim(),
        firstName,
        lastName,
        metaEventId,
        metaFbc: currentFbc(),
      });
      // Google Ads sign-up conversion (owner 2026-10-04, lib/google-ads.ts) — never blocks or breaks the sign-up.
      reportGoogleAdsSignup();
      // Visitor analytics: the client copy of signup_complete (one row per account — deduped with the server's).
      trackVisitEvent('signup_complete', undefined, { flush: true });
      // Meta Pixel CompleteRegistration (owner 2026-10-07, lib/meta-pixel.ts) — never blocks or breaks the sign-up.
      reportMetaSignup(metaEventId);
      toast.success(`Account created! Welcome to ${branding.name} 🎉`);
      router.push(redirectTo);
    } catch (error: any) {
      const msg = error.response?.data?.error || error.response?.data?.message || 'Sign up failed. Try a different email.';
      setFormError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    // Row shell is overflow-hidden. The RIGHT column is the scroll container
    // (min-h-0 + overflow-y-auto). A previous overflow-y-auto on this row
    // never scrolled: the form column stretched to h-dvh and justify-center
    // clipped the back control above the fold and “Continue without an
    // account” below it on 375×812.
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background relative pwa-viewport-fill">
      {/* Left panel — branding. The panel is overflow-hidden (clips the
          decoration); the CONTENT scrolls in its own h-full container so the
          taller feature grid never clips on short viewports (same idiom as
          the right column: min-h-full + justify-center inside a
          flex-1 min-h-0 scroll wrapper). */}
      {/* Digby Frontier (2026-10-06): the brand gradient lives ONLY inside the
          hat logo now — the panel is a quiet ink field (constant dark in both
          themes, so the white type keeps its contrast). */}
      <div className="hidden lg:flex w-1/2 bg-[oklch(0.205_0_0)] dark:bg-[oklch(0.165_0_0)] flex-col text-white relative overflow-hidden">
        {/* Background decoration (absolute — stays put while content scrolls) */}
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-20 size-64 rounded-full bg-white blur-3xl" />
          <div className="absolute bottom-20 right-20 size-80 rounded-full bg-white blur-3xl" />
        </div>

        <div className="relative z-10 flex-1 min-h-0 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center p-12">
        <div className="max-w-md text-center">
          {/* Logo */}
          <div className="size-24 rounded-3xl overflow-hidden mx-auto mb-8 shadow-2xl border border-white/30">
            <BrandLogo size={96} priority className="w-full h-full object-cover" />
          </div>

          <h1 className="font-serif text-[44px] font-normal tracking-[-0.015em] mb-3">{branding.name}</h1>
          <p className="text-xl text-white/80 mb-2 leading-relaxed">
            {branding.tagline}
          </p>
          <p className="text-sm text-white/60 mb-8 leading-relaxed">
            One question, every frontier model, one blended answer — with long-running coding sessions that ship real PRs.
          </p>

          <Separator className="bg-white/20 mb-8" />

          {/* Feature highlights */}
          <div className="grid grid-cols-2 gap-3 text-left">
            {LOGIN_FEATURES.map(({ icon, title, desc, wide }) => (
              <div
                key={title}
                className={`rounded-xl bg-white/5 border border-white/10 p-3${wide ? ' col-span-2' : ''}`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xl flex-shrink-0" aria-hidden>{icon}</span>
                  <p className="font-semibold text-white text-sm leading-tight">{title}</p>
                </div>
                <p className="text-xs text-white/70 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>

          {/* Trust strip — every claim repo-verifiable (live deployment,
              MIT license + docker-compose.selfhost.yml, backend model lineup) */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-white/50">
            <span>Live at digby.ai</span>
            <span aria-hidden>·</span>
            <span>Self-hostable — MIT licensed</span>
            <span aria-hidden>·</span>
            <span>Frontier &amp; open-source models</span>
          </div>
        </div>
        </div>
        </div>
      </div>

      {/* Right panel — form. Scrolls independently; inner min-h-full +
          justify-center keeps short login centered and lets signup grow. */}
      <div
        id="main"
        tabIndex={-1}
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain outline-none"
      >
        <div className="flex min-h-full flex-col items-center px-6 lg:px-12 pt-[max(1.25rem,env(safe-area-inset-top,0px))] pb-[max(6.5rem,calc(env(safe-area-inset-bottom,0px)+5.5rem))]">
        <div className="w-full max-w-md flex flex-1 flex-col justify-center py-2">
        {/* Back link */}
        <div className="w-full mb-6">
          <button
            type="button"
            onClick={() => router.push('/')}
            aria-label="Back to home"
            className="inline-flex items-center gap-1.5 min-h-11 px-1 -ml-1 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to {branding.name}
          </button>
        </div>

        {/* Mobile logo (hidden on lg) */}
        <div className="lg:hidden flex items-center gap-3 mb-8">
          <div className="size-10 rounded-xl overflow-hidden shadow-md flex-shrink-0">
            <BrandLogo size={40} className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">
              {branding.name}
            </h1>
            <p className="text-[10px] text-muted-foreground">{branding.tagline}</p>
          </div>
        </div>

        {/* Card */}
        <div className="w-full max-w-md">
          <div className="mb-6">
            <h2 className="text-2xl font-bold tracking-tight">
              {tab === 'login' ? 'Welcome back' : 'Create an account'}
            </h2>
            <p className="text-muted-foreground mt-1">
              {tab === 'login'
                ? 'Sign in to save your conversations and AI memory'
                : 'Join to save chats, build AI memory, and more'}
            </p>
          </div>

          {/* Tab switcher */}
          <div className="flex items-center rounded-lg border p-0.5 bg-muted/40 mb-6 w-full">
            {(['login', 'signup'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setTab(t); setFormError(null); }}
                className={cn(
                  'flex-1 min-h-10 py-2 text-sm font-medium rounded-md transition-all',
                  tab === t
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t === 'login' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>

          {/* ── LOGIN FORM ── */}
          {tab === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  placeholder="you@example.com"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onAnimationStart={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    if (val && !loginEmail) setLoginEmail(val);
                  }}
                  required
                  disabled={isLoading}
                  autoComplete="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-invalid={!!formError}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                    <Input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      onAnimationStart={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        if (val && !loginPassword) setLoginPassword(val);
                      }}
                      required
                      disabled={isLoading}
                      autoComplete="current-password"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={!!formError}
                      className="h-11 pr-12"
                    />
                  <PasswordToggle
                    visible={showPassword}
                    onToggle={() => setShowPassword(v => !v)}
                  />
                </div>
              </div>
              {formError && (
                <p role="alert" className="text-sm text-destructive">{formError}</p>
              )}
              <Button
                type="submit"
                disabled={isLoading || !loginEmail.trim() || !loginPassword}
                className="w-full h-11 bg-send text-send-ink hover:opacity-90 border-0 font-semibold mt-2"
              >
                {isLoading ? <><Loader2 className="size-4 mr-2 animate-spin" />Signing in…</> : 'Sign In'}
              </Button>

              <p className="text-center text-sm text-muted-foreground pt-2">
                Don't have an account?{' '}
                <button
                  type="button"
                  onClick={() => setTab('signup')}
                  className="text-ink hover:text-ink-2 font-medium transition-colors"
                >
                  Sign up free
                </button>
              </p>
            </form>
          )}

          {/* ── SIGNUP FORM ── */}
          {tab === 'signup' && (
            <form onSubmit={handleSignup} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="signup-name">Name <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  id="signup-name"
                  type="text"
                  placeholder="Your name"
                  value={signupName}
                  onChange={(e) => setSignupName(e.target.value)}
                  disabled={isLoading}
                  autoComplete="name"
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-email">Email</Label>
                <Input
                  id="signup-email"
                  type="email"
                  placeholder="you@example.com"
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  autoComplete="email"
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-password">Password</Label>
                <div className="relative">
                  <Input
                    id="signup-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="At least 8 characters"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    required
                    minLength={8}
                    disabled={isLoading}
                    autoComplete="new-password"
                    className="h-11 pr-12"
                  />
                  <PasswordToggle
                    visible={showPassword}
                    onToggle={() => setShowPassword(v => !v)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-confirm">Confirm Password</Label>
                <div className="relative">
                  <Input
                    id="signup-confirm"
                    type={showConfirm ? 'text' : 'password'}
                    placeholder="Re-enter password"
                    value={signupConfirm}
                    onChange={(e) => setSignupConfirm(e.target.value)}
                    disabled={isLoading}
                    autoComplete="new-password"
                    className={cn(
                      'h-11 pr-12',
                      signupConfirm && signupPassword !== signupConfirm
                        ? 'border-destructive focus-visible:ring-destructive'
                        : ''
                    )}
                  />
                  <PasswordToggle
                    visible={showConfirm}
                    onToggle={() => setShowConfirm(v => !v)}
                    showLabel="Show confirmation password"
                    hideLabel="Hide confirmation password"
                  />
                </div>
                {signupConfirm && signupPassword !== signupConfirm && (
                  <p role="alert" className="text-xs text-destructive">Passwords don't match</p>
                )}
              </div>
              {formError && tab === 'signup' && (
                <p role="alert" className="text-sm text-destructive">{formError}</p>
              )}

              <Button
                type="submit"
                disabled={
                  isLoading ||
                  !signupEmail.trim() ||
                  !signupPassword ||
                  signupPassword.length < 8 ||
                  (!!signupConfirm && signupPassword !== signupConfirm)
                }
                className="w-full h-11 bg-send text-send-ink hover:opacity-90 border-0 font-semibold mt-2"
              >
                {isLoading ? <><Loader2 className="size-4 mr-2 animate-spin" />Creating account…</> : 'Create Account'}
              </Button>

              <p className="text-center text-xs text-muted-foreground pt-1">
                By signing up, any conversation you've had anonymously will be saved to your account.
              </p>

              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => setTab('login')}
                  className="text-ink hover:text-ink-2 font-medium transition-colors"
                >
                  Sign in
                </button>
              </p>
            </form>
          )}

          {/* Continue anonymously */}
          <div className="mt-6 pt-5 border-t text-center">
            <button
              onClick={() => router.push('/')}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center gap-1.5 mx-auto min-h-11 px-2 touch-manipulation"
            >
              <Zap className="size-3.5 text-warn" />
              Continue without an account
            </button>
          </div>
        </div>
        </div>
        </div>
      </div>

      <footer
        className="fixed bottom-0 left-0 right-0 z-10 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 bg-background/90 backdrop-blur-sm border-t text-xs text-muted-foreground"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0.5rem))' }}
      >
        <span>© {new Date().getFullYear()} {branding.name}</span>
        <span className="text-muted-foreground/30">·</span>
        <Link href="/terms" className="hover:text-foreground transition-colors min-h-11 inline-flex items-center">Terms</Link>
        <span className="text-muted-foreground/30">·</span>
        <Link href="/privacy" className="hover:text-foreground transition-colors min-h-11 inline-flex items-center">Privacy</Link>
        <span className="hidden sm:inline text-muted-foreground/30">·</span>
        <a href="mailto:digby@digby.ai" className="hidden sm:inline-flex hover:text-foreground transition-colors min-h-8 items-center">digby@digby.ai</a>
      </footer>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="size-8 rounded-xl overflow-hidden animate-pulse">
          <BrandLogo size={32} className="w-full h-full object-cover" />
        </div>
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
