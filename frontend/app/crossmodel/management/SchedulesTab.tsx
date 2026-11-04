'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CalendarClock, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import { fleetApi, type FleetScheduleRow } from '@/lib/api/fleet';
import { usePolling, isAbortError } from '@/lib/use-polling';
import { relativeTime } from '@/lib/relative-time';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { formatInterval } from './utils';

/** Auto-refresh cadence — matches the Dashboard and Logs tabs. */
const POLL_MS = 20_000;

/**
 * lastStatus colour coding: started → ok (emerald), skipped:* → amber,
 * error:* → red, cancelled/expired/never-run → muted.
 */
function statusBadge(lastStatus: string | null) {
  if (!lastStatus) return <Badge variant="secondary" className="text-[10px]">never run</Badge>;
  if (lastStatus.startsWith('error')) return <Badge variant="destructive" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus.startsWith('skipped')) return <Badge variant="warning" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus === 'cancelled' || lastStatus === 'expired') return <Badge variant="outline" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus === 'started') return <Badge variant="success" className="text-[10px]">started</Badge>;
  return <Badge variant="secondary" className="text-[10px]">{lastStatus}</Badge>;
}

export function SchedulesTab() {
  const router = useRouter();
  const [schedules, setSchedules] = useState<FleetScheduleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [confirmSchedule, setConfirmSchedule] = useState<{ id: string; snippet: string } | null>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    setRefreshing(true);
    fleetApi.getSchedules({ signal })
      .then((data) => { setSchedules(data.schedules); setError(null); })
      .catch((err) => { if (!isAbortError(err)) setError('Could not load schedules.'); })
      .finally(() => setRefreshing(false));
  }, []);

  // usePolling (P5): abortable ticks (a slow response can never overwrite a
  // newer list), hidden-tab pause + visible catch-up, focus catch-up.
  usePolling((signal) => refresh(signal), { intervalMs: POLL_MS, refreshOnFocus: true });

  /** Runs after the AlertDialog confirm: audited backend cancel → refresh. */
  const cancelSchedule = async (id: string) => {
    setCancellingId(id);
    try {
      await fleetApi.cancelSchedule(id);
      toast.success('Schedule cancelled.');
      refresh();
    } catch {
      toast.error('Could not cancel the schedule.');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Every scheduled automation across your chats — enabled first, then by next firing.
          Updates automatically.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs shrink-0"
          disabled={refreshing}
          onClick={() => refresh()}
        >
          <RefreshCw className={`size-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Loaded-with-error: keep the last known rows visible, but say so. */}
      {error && schedules && schedules.length > 0 && (
        <p className="text-xs text-destructive">{error} Showing the last loaded schedules.</p>
      )}

      {!schedules ? (
        error ? (
          <div className="text-center py-10 space-y-3">
            <p className="text-xs text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => refresh()}>Retry</Button>
          </div>
        ) : (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )
      ) : schedules.length === 0 ? (
        <Empty className="py-10 border-none">
          <EmptyHeader>
            <EmptyMedia>
              <CalendarClock className="size-6 text-muted-foreground/50" />
            </EmptyMedia>
            <EmptyDescription className="text-xs">
              No schedules yet — ask Digby in any chat to check something on a cadence
              (e.g. &ldquo;every morning, summarize my fleet&rdquo;) and it will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div
              key={s.id}
              className={`flex items-start gap-3 rounded-md border border-border px-3 py-2 ${s.enabled ? '' : 'opacity-60'}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => router.push(`/?chatId=${s.chatId}`)}
                    className="text-xs font-medium truncate hover:text-brand-text hover:underline"
                    title="Open this chat"
                  >
                    {s.chatTitle || 'Deleted chat'}
                  </button>
                  <Badge variant="outline" className="text-[10px]">
                    {s.kind === 'once' ? 'once' : formatInterval(s.intervalSec) || 'recurring'}
                  </Badge>
                  {s.kind === 'recurring' && s.projectedDailyFirings != null && (
                    <span
                      className={`text-[10px] ${s.projectedDailyFirings >= 48 ? 'font-medium text-warn-ink' : 'text-muted-foreground'}`}
                      title={`Cadence math (ticket 2694a581): ~${s.projectedDailyFirings} firings/day — the default schedule cap is 48/day per chat (a per-chat grant may raise it). One-shot schedules and hook wakes share that counter.`}
                    >
                      ≈{s.projectedDailyFirings}/day{s.projectedDailyFirings >= 48 ? ' ⚠' : ''}
                    </span>
                  )}
                  {s.kind === 'recurring' && s.clockDriftMinutes != null && s.clockDriftMinutes !== 0 && (
                    <span
                      className="text-[10px] font-medium text-warn-ink"
                      title={`Clock drift (ticket 903249e5): this ${Math.round((s.intervalSec ?? 0) / 60)}-min cadence is not day-aligned — each firing lands ${Math.abs(s.clockDriftMinutes)} min ${s.clockDriftMinutes < 0 ? 'EARLIER' : 'LATER'} than the last, so the firing time marches around the clock (a "daily" digest will NOT stay at one time of day). For a fixed time of day, use a whole-day cadence (1440 min).${s.projectedNextFirings?.length ? ` Projected next firings: ${s.projectedNextFirings.join(' · ')}.` : ''}`}
                    >
                      ⚠ drift {s.clockDriftMinutes > 0 ? '+' : ''}{s.clockDriftMinutes}m/firing
                    </span>
                  )}
                  {!s.enabled && <Badge variant="secondary" className="text-[10px]">disabled</Badge>}
                  {statusBadge(s.lastStatus)}
                </div>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5" title={s.promptSnippet}>
                  {s.promptSnippet}
                </p>
              </div>
              <div className="text-[11px] text-muted-foreground text-right shrink-0">
                {s.enabled && <div>next {s.nextRunAt ? relativeTime(s.nextRunAt) : '—'}</div>}
                <div className="text-[10px]">
                  {s.runsCount}{s.maxRuns != null ? `/${s.maxRuns}` : ''} run{(s.maxRuns ?? s.runsCount) === 1 ? '' : 's'}
                  {s.lastFiredAt ? ` · last ${relativeTime(s.lastFiredAt)}` : ''}
                </div>
              </div>
              {s.enabled && (
                <button
                  type="button"
                  title="Cancel this schedule (stops firing; kept for history)"
                  aria-label="Cancel schedule"
                  disabled={cancellingId === s.id}
                  onClick={() => setConfirmSchedule({ id: s.id, snippet: s.promptSnippet })}
                  className="shrink-0 self-center rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
                >
                  {cancellingId === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Schedule-cancel confirm — the app's dialog pattern, not window.confirm
          (which is unstylable and blocks the poll loop). */}
      <AlertDialog
        open={confirmSchedule !== null}
        onOpenChange={(open) => { if (!open) setConfirmSchedule(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{confirmSchedule?.snippet}&rdquo; — it will stop firing (the row is kept for history).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep schedule</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => { if (confirmSchedule) cancelSchedule(confirmSchedule.id); }}
            >
              Cancel schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
