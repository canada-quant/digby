'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Image from 'next/image';
import { Sparkles, ArrowRight, User2, Database, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { authApi } from '@/lib/auth';

/** Matches the backend's register / change-password floor (auth.validation PASSWORD_MIN_LENGTH). */
export const NEW_PASSWORD_MIN_LENGTH = 8;

export function ProfileTab({ isChild = false, email }: { isChild?: boolean; email?: string }) {
  const router = useRouter();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold mb-1">AI Profile</h2>
        <p className="text-xs text-muted-foreground">
          Teach Digby who you are so every AI response feels tailored to you.
        </p>
      </div>

      {/* Main card */}
      <div className="rounded-xl border bg-gradient-to-br from-hover to-hover p-6">
        <div className="flex items-start gap-4">
          <div className="size-12 rounded-xl overflow-hidden shadow-md flex-shrink-0">
            <Image src="/digbyhat.png" alt="Digby" width={48} height={48} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold mb-1">Profile Interview</h3>
            <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
              Digby conducts a short interview — asking about your name, occupation, location, and interests. Your answers are saved as memory facts and automatically included in every future query.
            </p>
            <Button
              onClick={() => router.push('/profile')}
              className="bg-send text-send-ink hover:opacity-90 border-0 gap-2"
            >
              <Sparkles className="size-4" />
              Open AI Profile
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Info items */}
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          {
            icon: User2,
            title: 'Personalised answers',
            desc: 'Responses reference your background, location, and use case automatically.',
          },
          {
            icon: Database,
            title: 'Persistent memory',
            desc: 'Facts learned during the interview are stored and used in every future query.',
          },
          {
            icon: Sparkles,
            title: '8 key questions',
            desc: 'Digby asks about name, occupation, location, goals, interests, and response style.',
          },
          {
            icon: ArrowRight,
            title: 'Refresh anytime',
            desc: 'Open the AI Profile and keep chatting to consolidate new facts into your profile.',
          },
        ].map(({ icon: Icon, title, desc }) => (
          <div key={title} className="rounded-lg border bg-card p-4 flex gap-3">
            <Icon className="size-4 text-ink mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium mb-0.5">{title}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Digby Kids: a child's password is set by the parent (Account → Kids). */}
      {!isChild && <ChangePasswordSection email={email} />}
    </div>
  );
}

function errorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string; details?: Array<{ message?: string }> } } } | null)?.response?.data;
  return data?.details?.[0]?.message || data?.error || 'Could not change your password. Please try again.';
}

/**
 * Change password (2026-10-12). The server signs out every other device and
 * keeps this browser signed in (authApi.changePassword stores the fresh access
 * token). Fields are cleared after a successful change; after a refusal only
 * the current-password field is cleared so it is re-typed.
 */
export function ChangePasswordSection({ email }: { email?: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const tooShort = next.length > 0 && next.trim().length < NEW_PASSWORD_MIN_LENGTH;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = !saving && current.length > 0 && next.length > 0 && confirm.length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!current) { toast.error('Enter your current password.'); return; }
    if (next.trim().length < NEW_PASSWORD_MIN_LENGTH) {
      toast.error(`Your new password must be at least ${NEW_PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) { toast.error('The new passwords do not match.'); return; }
    if (next.trim() === current.trim()) {
      toast.error('Choose a new password that is different from your current one.');
      return;
    }

    setSaving(true);
    try {
      const result = await authApi.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(
        result?.accessTokensCutOff === false
          ? 'Password changed. Other devices can no longer renew their session and will be signed out when it expires.'
          : 'Password changed. You are still signed in here; other devices have been signed out.',
      );
    } catch (err) {
      setCurrent('');
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-card p-6" data-testid="change-password">
      <div className="flex items-start gap-3 mb-4">
        <KeyRound className="size-4 text-ink mt-0.5 flex-shrink-0" />
        <div>
          <h3 className="text-sm font-semibold mb-0.5">Change password</h3>
          <p className="text-xs text-ink-3 leading-relaxed">
            You stay signed in here. Every other device and browser is signed out.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3 max-w-sm" noValidate>
        {/* Lets password managers attach the new password to the right account. */}
        {email && (
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        )}
        <div className="space-y-1">
          <label htmlFor="current-password" className="text-xs font-medium text-ink-2">Current password</label>
          <Input
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new-password" className="text-xs font-medium text-ink-2">New password</label>
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            minLength={NEW_PASSWORD_MIN_LENGTH}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={tooShort || undefined}
            aria-describedby="new-password-hint"
            disabled={saving}
          />
          <p id="new-password-hint" className={tooShort ? 'text-xs text-destructive' : 'text-xs text-ink-3'}>
            At least {NEW_PASSWORD_MIN_LENGTH} characters.
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor="confirm-new-password" className="text-xs font-medium text-ink-2">Confirm new password</label>
          <Input
            id="confirm-new-password"
            name="confirm-new-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'confirm-new-password-error' : undefined}
            disabled={saving}
          />
          {mismatch && (
            <p id="confirm-new-password-error" className="text-xs text-destructive">The new passwords do not match.</p>
          )}
        </div>
        <Button
          type="submit"
          disabled={!canSubmit}
          className="bg-send text-send-ink hover:opacity-90 border-0 gap-2"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          Change password
        </Button>
      </form>
    </section>
  );
}
