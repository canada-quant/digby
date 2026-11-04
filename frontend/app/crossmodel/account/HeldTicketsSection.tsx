'use client';

/**
 * Admin → Feedback → "Held tickets" (audit 2026-10-08 W5-1a). Ticket lanes run
 * in auto mode and merge + deploy framework main, so only the owner's own
 * tickets dispatch on their own (7d6b6e09); every other account's ticket — and
 * any harness ticket about another account's chat — is HELD. This panel lists
 * the held tickets (GET /admin/feature-requests/held) and gives each an
 * "Approve for a ticket lane" action (POST …/:id/approve-dispatch — sets
 * context.dispatchApproved, audited server-side); the next drain starts the lane.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Loader2, ShieldCheck, Inbox } from 'lucide-react';
import { featureRequestApi, type HeldTicket } from '@/lib/api/crossmodel';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { relativeTime } from '@/lib/relative-time';

/** What approving does — shown in the confirm dialog. */
export const APPROVE_FOR_LANE_COPY =
  'An approved ticket gets its own ticket lane on the next drain. Ticket lanes run in auto mode: they write the fix, merge it to main and deploy it. Approve only a ticket you have read and want worked that way.';

export function HeldTicketsSection() {
  const [tickets, setTickets] = useState<HeldTicket[]>([]);
  const [ownerResolved, setOwnerResolved] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [degradedError, setDegradedError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<HeldTicket | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await featureRequestApi.adminListHeld();
      setTickets(r.tickets);
      setOwnerResolved(r.ownerResolved);
      setDegraded(r.degraded === true);
      setDegradedError(r.error ?? null);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const approve = useCallback(async (t: HeldTicket) => {
    setBusyId(t.id);
    try {
      await featureRequestApi.adminApproveDispatch(t.id, true);
      toast.success(`Ticket ${t.id.slice(0, 8)} approved — a ticket lane starts it on the next drain.`);
      setTickets((prev) => prev.filter((x) => x.id !== t.id));
    } catch {
      toast.error('Could not approve the ticket — please try again.');
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-brand-accent" />
          <h3 className="text-sm font-semibold">Held tickets</h3>
          {!loading && <Badge variant="secondary" data-testid="held-tickets-count">{tickets.length}</Badge>}
        </div>
        <button onClick={() => { setLoading(true); void load(); }}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <RefreshCw className="size-3.5" /> Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Ticket lanes merge and deploy. Your own tickets and tickets filed by an admin are worked automatically. Tickets
        from other accounts — and framework tickets about their chats — wait here until you approve them.
        {degraded && ` ${degradedError || 'The ticket-lane home could not be resolved, so this list is withheld rather than showing every open ticket.'}`}
        {!degraded && !ownerResolved && ' No ticket-lane home is configured, so nothing dispatches on its own right now.'}
      </p>

      {loading && <div className="flex justify-center py-4"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}
      {!loading && error && <p className="text-xs text-destructive">Could not load held tickets.</p>}
        {!loading && !error && !degraded && tickets.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="held-tickets-empty">
          <Inbox className="size-4" /> Nothing is held.
        </div>
      )}

      {!loading && !error && tickets.length > 0 && (
        <ul className="divide-y">
          {tickets.map((t) => (
            <li key={t.id} className="py-3 flex items-start justify-between gap-3" data-testid="held-ticket-row">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-mono text-muted-foreground">{t.id.slice(0, 8)}</span>
                  <Badge variant="outline">{t.type}</Badge>
                  {t.harness && <Badge variant="outline">framework</Badge>}
                  {t.subjectContentWithheld && <Badge variant="outline">content withheld</Badge>}
                  <span className="text-muted-foreground">{t.user?.email ?? 'no account'} · {relativeTime(t.createdAt)}</span>
                </div>
                <p className="text-sm font-medium break-words">{t.title}</p>
                <p className="text-xs text-muted-foreground line-clamp-3 break-words">{t.description}</p>
              </div>
              <button
                onClick={() => setConfirm(t)}
                disabled={busyId === t.id}
                className="shrink-0 rounded-md border px-2.5 py-1 text-xs hover:bg-hover disabled:opacity-50"
              >
                {busyId === t.id ? <Loader2 className="size-3.5 animate-spin" /> : 'Approve for a ticket lane'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve ticket {confirm?.id.slice(0, 8)} for a ticket lane?</AlertDialogTitle>
            <AlertDialogDescription>{APPROVE_FOR_LANE_COPY}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it held</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const t = confirm; setConfirm(null); if (t) void approve(t); }}>
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
