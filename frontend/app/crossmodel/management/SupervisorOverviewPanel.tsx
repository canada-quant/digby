'use client';

/**
 * Supervisor overview panel — the Supervisor Chat tab's side rail (stacked
 * above the chat on mobile): pending owner decisions (GET /confirmations/
 * pending — the fleet's staged actions and asks, answerable inline; ticket
 * 7705fec2: the Management page previously had NO pending-decision surface at
 * all, so cards the supervisor staged were invisible to an owner who lives
 * here), live status (fed by the thread poll — no extra fetch), fleet
 * automation counts (GET /fleet/overview), and the latest machine-activity
 * rows (GET /fleet/log) with a jump into the full Logs tab. Polls on the
 * Dashboard/Logs cadence and pauses while the tab is hidden.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { surfaceConfirmSecret } from '@/lib/confirm-secret';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Gauge, CalendarClock, Inbox, Webhook, Activity, Loader2, BellRing } from 'lucide-react';
import { fleetApi, type FleetOverview, type FleetLogRow } from '@/lib/api/fleet';
import { usePolling, isAbortError } from '@/lib/use-polling';
import { confirmationsApi, type PendingConfirmation } from '@/lib/api/crossmodel';
import { relativeTime } from '@/lib/relative-time';
import { LOG_KIND_BADGE } from './utils';
// Supervisor OFF switch (owner 2026-09-26): the Status card states the
// harness-composed "Fleet supervisor: OFF since … by … — wakes skipped: N".
import { anySwitchOff } from '@/lib/supervisor-switch';

/** Same cadence as the Dashboard + Logs tabs. */
const POLL_MS = 20_000;
/** Compact rail — the Logs tab owns the full paged list. */
const RECENT_ACTIVITY_ROWS = 8;

export function SupervisorOverviewPanel({ running, queuedCount, queuedUserCount = 0, onGoLogs }: {
  /** Live busy state, handed down from the thread poll (no extra fetch). */
  running: boolean;
  queuedCount: number;
  /** USER-typed subset of queuedCount (F3, incident 2026-09-04): the Status
   *  card must never say "Idle — waiting for your next message" while the
   *  owner's own send sits queued. Defaults 0 (old backends omit the field). */
  queuedUserCount?: number;
  onGoLogs: () => void;
}) {
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [overviewError, setOverviewError] = useState(false);
  const [logRows, setLogRows] = useState<FleetLogRow[] | null>(null);
  const [logError, setLogError] = useState(false);
  // Pending owner decisions (ticket 7705fec2): staged consequential actions
  // (kind 'confirmation' — Confirm/Cancel inline; they execute the STORED
  // args server-side) plus asks/approvals blocked in their own chats (listed
  // for visibility; answered where they live). Persist until answered.
  const [decisions, setDecisions] = useState<PendingConfirmation[]>([]);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback((signal?: AbortSignal) => {
    fleetApi.getOverview({ signal })
      .then((o) => { if (!mountedRef.current) return; setOverview(o); setOverviewError(false); })
      .catch((err) => { if (mountedRef.current && !isAbortError(err)) setOverviewError(true); });
    fleetApi.getFleetLog({ limit: RECENT_ACTIVITY_ROWS }, { signal })
      .then((p) => { if (!mountedRef.current) return; setLogRows(p.messages); setLogError(false); })
      .catch((err) => { if (mountedRef.current && !isAbortError(err)) setLogError(true); });
    confirmationsApi.getPending({ signal })
      // Expired traces are the sidebar's affordance; this rail lists only what
      // the owner can still act on (live + stale-pending cards, asks, approvals).
      // owner_question entries are excluded HERE — they are answered in the
      // Management → Inbox tab (ticket 7705fec2), not "in that chat".
      .then((list) => { if (mountedRef.current) setDecisions((Array.isArray(list) ? list : []).filter((p) => !p.expired && p.kind !== 'owner_question')); })
      .catch(() => { /* best-effort — keep the last loaded decisions */ });
  }, []);

  /** Confirm/Cancel a staged action inline (one-shot server-side), then re-poll. */
  const resolveDecision = useCallback(async (p: PendingConfirmation, action: 'confirm' | 'cancel') => {
    setResolvingId(p.id);
    try {
      const res = action === 'confirm'
        ? await confirmationsApi.confirmAction(p.id)
        : await confirmationsApi.cancelAction(p.id);
      if (res.success) {
        // A minted secret (create_chat_webhook) rides the result ONCE — show it here or nowhere.
        if (!(action === 'confirm' && surfaceConfirmSecret((res as { result?: string }).result))) toast.success(action === 'confirm' ? 'Action confirmed — running now.' : 'Action dismissed.');
      } else {
        toast.error(
          res.error === 'expired'
            ? 'That staged action is too old to run safely — ask the chat to re-stage it.'
            : res.error === 'already_resolved'
              ? 'Already resolved.'
              : res.error || 'The action failed to run.',
        );
      }
    } catch {
      toast.error('Could not reach the server — try again.');
    }
    if (mountedRef.current) setResolvingId(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // usePolling (P5): abortable ticks (a stale response can never overwrite
  // newer panel data), hidden-tab pause + visible catch-up (DashboardTab pattern).
  usePolling((signal) => refresh(signal), { intervalMs: POLL_MS });

  // `hooks ?? []`: an old backend (deploy skew) omits the field entirely.
  const enabledHooks = (overview?.hooks ?? []).filter((h) => h.enabled).length;
  // Supervisor OFF switch: absent on an old backend / unreadable ⇒ nothing shown.
  const switchState = overview?.supervisorSwitch ?? null;
  const switchedOff = anySwitchOff(switchState);

  return (
    <div className="space-y-3">
      {/* Needs your decision (ticket 7705fec2) — pending owner decisions from
          the WHOLE fleet, persistent until answered or dismissed. Rendered
          FIRST: a decision the owner never sees is the failure class this
          panel exists to kill. Hidden entirely when nothing is pending. */}
      {decisions.length > 0 && (
        <Card className="py-4 border-warn/60">
          <CardHeader className="px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <BellRing className="size-4 text-warn-ink" />
              Needs your decision
              <Badge variant="warning" className="text-[10px] ml-auto">{decisions.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 space-y-2">
            {decisions.map((p) => (
              <div key={`${p.chatId}:${p.id}`} className="rounded-md border border-border px-2.5 py-2 space-y-1">
                <p className="text-xs font-medium truncate" title={p.title}>{p.title || 'Untitled chat'}</p>
                <p className="text-[11px] text-muted-foreground break-words" title={p.question}>{p.question}</p>
                {p.kind === 'confirmation' && p.stale ? (
                  <>
                    <p className="text-[10px] text-warn-ink">
                      Staged too long ago to run safely — ask the chat to re-stage it if still wanted.
                    </p>
                    <div className="flex gap-1.5 pt-0.5">
                      <Button
                        variant="outline" size="sm" className="h-6 px-2 text-[11px]"
                        disabled={resolvingId === p.id}
                        onClick={() => void resolveDecision(p, 'cancel')}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </>
                ) : p.kind === 'confirmation' ? (
                  <div className="flex gap-1.5 pt-0.5">
                    <Button
                      size="sm" className="h-6 px-2 text-[11px] bg-send hover:bg-send/90 text-send-ink"
                      disabled={resolvingId === p.id}
                      onClick={() => void resolveDecision(p, 'confirm')}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="outline" size="sm" className="h-6 px-2 text-[11px]"
                      disabled={resolvingId === p.id}
                      onClick={() => void resolveDecision(p, 'cancel')}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    {p.kind === 'approval' ? 'Approval request' : 'Question'} — answer it in that chat.
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Status — straight from the thread poll. */}
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" />
            Status
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {running
              ? <Badge variant="success" className="text-[10px]">Running</Badge>
              : queuedUserCount > 0
                // F3 (incident 2026-09-04): a chat with the owner's message
                // queued is NOT idle — 12 minutes of silence once hid behind
                // this badge.
                ? <Badge variant="warning" className="text-[10px]">Queued</Badge>
                : <Badge variant="secondary" className="text-[10px]">Idle</Badge>}
            {queuedCount > 0 && <Badge variant="warning" className="text-[10px]">{queuedCount} queued</Badge>}
            {switchedOff && <Badge variant="warning" className="text-[10px]" data-testid="supervisor-switch-off-badge">Switched OFF</Badge>}
          </div>
          {switchedOff && switchState?.line && (
            // Harness-composed by the backend (supervisor-switch.ts) — no model prose.
            <p className="text-[11px] font-medium text-warn-ink" data-testid="supervisor-switch-line">
              {switchState.line}
            </p>
          )}
          {overview?.renewRefusals?.line && (
            // Harness-composed by the backend (coding/renew-refusal-surface.ts):
            // self-armed watches the governor stopped in the last 24 h.
            <p className="text-[11px] font-medium text-warn-ink" data-testid="renew-refusal-line">
              {overview.renewRefusals.line}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            {running && queuedUserCount > 0
              ? 'Working — your message is queued behind the current run.'
              : running
                ? 'Working on a turn right now — watch it live in the chat.'
                : queuedUserCount > 0
                  ? `Answering your message as soon as the current check finishes — ${queuedUserCount} queued.`
                  : 'Waiting for your next message.'}
          </p>
        </CardContent>
      </Card>

      {/* Automation — fleet-wide counts from the overview poll. */}
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" />
            Automation
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {!overview && overviewError ? (
            <p className="text-xs text-destructive">Could not load automation status.</p>
          ) : !overview ? (
            <div className="flex justify-center py-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs">
                <CalendarClock className="size-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Enabled schedules</span>
                <span className="ml-auto font-medium tabular-nums">{overview.counts.enabledSchedules}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Inbox className="size-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Queued messages</span>
                <span className="ml-auto font-medium tabular-nums">{overview.counts.queuedMessages}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <Webhook className="size-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Event hooks</span>
                <span className="ml-auto font-medium tabular-nums">{enabledHooks}</span>
              </div>
              {overviewError && (
                <p className="text-[11px] text-destructive pt-1">
                  Refresh failing — showing the last loaded data.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent activity — the last few raw log rows, compactly. */}
      <Card className="py-4">
        <CardHeader className="px-4 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Recent activity
          </CardTitle>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onGoLogs}>
            View all
          </Button>
        </CardHeader>
        <CardContent className="px-4">
          {!logRows && logError ? (
            <p className="text-xs text-destructive">Could not load recent activity.</p>
          ) : !logRows ? (
            <div className="flex justify-center py-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : logRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No activity yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {logRows.map((r) => {
                const kind = LOG_KIND_BADGE[r.kind] ?? LOG_KIND_BADGE.agent_message;
                return (
                  <div key={r.sourceId} className="py-1.5 first:pt-0 last:pb-0 flex items-start gap-2 text-xs">
                    <span
                      className="text-muted-foreground shrink-0 w-14 pt-0.5 text-[11px]"
                      title={new Date(r.at).toLocaleString()}
                    >
                      {relativeTime(r.at)}
                    </span>
                    <Badge variant={kind.variant} className={`text-[10px] shrink-0 ${kind.className ?? ''}`}>
                      {kind.label}
                    </Badge>
                    <p className="flex-1 min-w-0 text-[11px] line-clamp-2 break-words" title={r.summary}>
                      {r.summary}
                    </p>
                  </div>
                );
              })}
              {logError && (
                <p className="text-[11px] text-destructive pt-1.5">
                  Refresh failing — showing the last loaded activity.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
