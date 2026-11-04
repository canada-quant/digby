'use client';

/**
 * Account → Coding → "Fleet notice" (2026-10-12 credential incident).
 *
 * ONE owner-written block every agent working for this user reads until it
 * expires — coding lanes, project / fleet supervisors and chats
 * (backend platform/fleet-notice.ts). Used to tell the whole fleet at once what
 * changed: a retired server, rotated keys, how to reach things now. Secrets are
 * redacted server-side on save; the notice expires (max 90 days).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Megaphone } from 'lucide-react';
import { fleetNoticeApi, FleetNoticeState } from '@/lib/api/fleet-notice';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

export function FleetNoticeSection() {
  const [state, setState] = useState<FleetNoticeState | null>(null);
  const [text, setText] = useState('');
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState<'load' | 'save' | 'clear' | null>('load');
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    fleetNoticeApi.get()
      .then((s) => { if (!alive) return; setState(s); setText(s.notice?.text ?? ''); })
      .catch(() => { if (alive) setLoadError(true); })
      .finally(() => { if (alive) setBusy(null); });
    return () => { alive = false; };
  }, []);

  const maxChars = state?.maxChars ?? 4000;
  const maxDays = state?.maxDays ?? 90;

  const save = async () => {
    setBusy('save');
    try {
      const r = await fleetNoticeApi.set(text, days);
      setState((s) => (s ? { ...s, notice: r.notice, active: true } : s));
      setText(r.notice.text);
      toast.success(r.redacted.length
        ? `Saved — ${r.redacted.length} secret-looking value${r.redacted.length === 1 ? '' : 's'} removed. Never put keys in the notice.`
        : 'Saved — every agent reads it from its next turn.');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not save the notice');
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    try {
      await fleetNoticeApi.clear();
      setState((s) => (s ? { ...s, notice: null, active: false } : s));
      setText('');
      toast.success('Notice cleared');
    } catch {
      toast.error('Could not clear the notice');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-fleet-notice>
      <div className="flex items-center gap-2 mb-1">
        <Megaphone className="size-4 text-brand-accent" />
        <h3 className="text-sm font-semibold">Fleet notice</h3>
        {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>
      <p className="text-xs text-muted-foreground mb-3 leading-snug">
        A message every agent working for you reads on every turn — coding sessions, supervisors and chats — until it
        expires. Use it for facts that change what they should do: a retired server, a new way to reach something,
        what is off limits. It overrides older repo docs and memory. Never put keys or passwords here.
      </p>
      {loadError ? (
        <p className="text-xs text-destructive">Could not load the notice.</p>
      ) : (
        <>
          {state?.notice && (
            <p className="text-xs text-muted-foreground mb-2" data-fleet-notice-status>
              {state.active ? 'In force' : 'Expired'} · set {fmtDate(state.notice.updatedAt)} · until {fmtDate(state.notice.expiresAt)}
              {state.disabled ? ' · injection switched off on the server' : ''}
            </p>
          )}
          <textarea
            className="w-full min-h-40 rounded-md border border-line bg-background p-3 text-sm font-mono"
            value={text}
            maxLength={maxChars}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Server X is retired — never connect to it. The gateway moved to … Keys were rotated; use the GitHub secrets, never files on a server."
            aria-label="Fleet notice text"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-muted-foreground">{text.length}/{maxChars}</span>
            <label className="flex items-center gap-1.5">
              Expires in
              <input
                type="number"
                min={1}
                max={maxDays}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(maxDays, Number(e.target.value) || 1)))}
                className="w-16 rounded-md border border-line bg-background px-2 py-1"
                aria-label="Days until the notice expires"
              />
              days
            </label>
            <div className="ml-auto flex gap-2">
              {state?.notice && (
                <button type="button" onClick={clear} disabled={!!busy} className="rounded-md border border-line px-3 py-1.5 hover:bg-hover disabled:opacity-50">
                  Clear
                </button>
              )}
              <button type="button" onClick={save} disabled={!!busy || !text.trim()} className="rounded-md bg-foreground text-background px-3 py-1.5 disabled:opacity-50">
                Save notice
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
