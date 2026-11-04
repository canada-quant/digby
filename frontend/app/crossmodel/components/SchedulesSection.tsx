'use client';

/**
 * SchedulesSection — the workspace panel's per-chat Schedules TAB (rm9, owner
 * directive 2026-09-02: "schedules should be a tab in chats, not only at the
 * bottom of workspace-enabled things — chats have schedules too, and you need
 * to be able to delete or cancel them without asking").
 *
 * Mounted for BOTH session kinds through the section registry
 * (lib/workspace-sections.ts): CodeSessionView's coding map and page.tsx's
 * pagePanelSections both return `<SchedulesSection chatId={…} />` for the
 * 'schedules' id. It replaces the old display-only schedules block at the
 * bottom of the coding Overview (now a one-line count → tab link,
 * ScheduleCountLine below — one source of truth).
 *
 * Actions run with NO confirmation dialog:
 *   - Cancel  → immediate DELETE (exact cancel_schedule tool semantics
 *     server-side: audit + schedule_disabled event). Because cancel only
 *     persists enabled:false — nothing is destroyed — the row greys with a
 *     short "Cancelled — Undo" affordance (~8s) that PATCHes enabled:true.
 *   - Pause / Resume → PATCH {enabled}. Resume-side cadence rules (stale
 *     nextRunAt recompute, completed/active-cap guards) live server-side;
 *     rule refusals surface here as honest toasts.
 *
 * Hardening: the fetch auto-retries ONCE before declaring an error; an error
 * with previously-loaded rows keeps them visible with a stale note; the error
 * state is a compact row with Retry — the panel never blanks. Rows render
 * defensively (a schedule cancelled mid-fire, or GC'd between refreshes, must
 * not break the list).
 *
 * Testing (repo idiom — ChatFilesSection): the connected wrapper
 * fetches via apiClient and is not SSR-testable; the PURE SchedulesSectionView
 * plus the exported helpers carry the logic and are pinned via
 * react-dom/server in SchedulesSection.test.tsx.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { CalendarClock, ChevronDown, ChevronUp, Loader2, Pause, Play, RefreshCw, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { crossModelApi, type ChatScheduleRow } from '@/lib/api/crossmodel';
import { relativeTime } from '@/lib/relative-time';
import { formatInterval } from '../management/utils';
import { openWorkspaceSection } from './WorkspacePanel';

/** How long the inline "Cancelled — Undo" affordance stays actionable. */
export const UNDO_WINDOW_MS = 8_000;

/** "every 60m" / "once" — the row's cadence pill text. */
export function cadenceLabel(s: Pick<ChatScheduleRow, 'kind' | 'intervalSec'>): string {
  if (s.kind === 'once') return 'once';
  return formatInterval(s.intervalSec) || 'recurring';
}

/** A completed schedule can never resume (server refuses with 409) — hide Resume for it. */
export function isCompleted(s: Pick<ChatScheduleRow, 'kind' | 'runsCount' | 'maxRuns'>): boolean {
  if (s.maxRuns != null && s.runsCount >= s.maxRuns) return true;
  return s.kind === 'once' && s.runsCount >= 1;
}

/**
 * Ticket cd0270c0: one-shot ladder lanes leave a wall of terminal
 * kind:'once' rows behind. A row folds into the Completed accordion only
 * when it is BOTH completed AND stopped — an ENABLED completed row (e.g. a
 * capped recurring that somehow re-armed, or a once row mid disable) stays
 * visible as live until the row actually settles.
 */
export function isFoldedCompleted(s: Pick<ChatScheduleRow, 'kind' | 'runsCount' | 'maxRuns' | 'enabled'>): boolean {
  return !s.enabled && isCompleted(s);
}

/** Split rows for the panel: live/pending rows first, folded completed rows last (cd0270c0).
 *  `keepLive` = ids that must stay in the live list whatever their state — the
 *  post-cancel Undo window (review D1: a fired once-row that was just cancelled
 *  is folded-completed, but its 8s "Cancelled — Undo" affordance must stay on
 *  screen, not inside the collapsed accordion). */
export function partitionSchedules(
  rows: readonly ChatScheduleRow[],
  keepLive: ReadonlySet<string> = new Set(),
): { liveRows: ChatScheduleRow[]; completedRows: ChatScheduleRow[] } {
  const liveRows: ChatScheduleRow[] = [];
  const completedRows: ChatScheduleRow[] = [];
  for (const s of rows) (keepLive.has(s.id) || !isFoldedCompleted(s) ? liveRows : completedRows).push(s);
  return { liveRows, completedRows };
}

/** lastStatus colour coding — the same mapping as the Management Schedules tab. */
export function scheduleStatusBadge(lastStatus: string | null) {
  if (!lastStatus) return <Badge variant="secondary" className="text-[10px]">never run</Badge>;
  if (lastStatus.startsWith('error')) return <Badge variant="destructive" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus.startsWith('skipped')) return <Badge variant="warning" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus === 'cancelled' || lastStatus === 'expired' || lastStatus.startsWith('paused')) return <Badge variant="outline" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus === 'started') return <Badge variant="success" className="text-[10px]">started</Badge>;
  return <Badge variant="secondary" className="text-[10px]">{lastStatus}</Badge>;
}

export interface SchedulesSectionViewProps {
  /** null = first load in flight. */
  rows: ChatScheduleRow[] | null;
  /** True after the one automatic retry also failed. */
  loadError: boolean;
  /** False for the chatless fallback mount — no chat, no schedules to fetch. */
  hasChat: boolean;
  /** Schedule id with an in-flight action (buttons disable). */
  busyId: string | null;
  /** Ids inside their post-cancel Undo window. */
  undoIds: ReadonlySet<string>;
  /** Ids whose prompt is expanded past the 2-line clamp. */
  expandedIds: ReadonlySet<string>;
  /** Backend deaf-lane warning from the last cancel (chat left with no enabled schedules). */
  warning: string | null;
  refreshing: boolean;
  /**
   * cd0270c0: completed terminal rows sit behind the "Completed (N)"
   * accordion — collapsed by default; null forces collapsed (SSR initial
   * state) so the panel never opens with a wall of dead rows.
   */
  completedOpen?: boolean | null;
  onToggleCompleted: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  onCancel: (s: ChatScheduleRow) => void;
  onToggleEnabled: (s: ChatScheduleRow) => void;
  onUndo: (s: ChatScheduleRow) => void;
  onToggleExpand: (id: string) => void;
}

export interface ScheduleRowProps {
  s: ChatScheduleRow;
  busy: boolean;
  undoable: boolean;
  expanded: boolean;
  onCancel: (s: ChatScheduleRow) => void;
  onToggleEnabled: (s: ChatScheduleRow) => void;
  onUndo: (s: ChatScheduleRow) => void;
  onToggleExpand: (id: string) => void;
}

/**
 * One schedule card — shared by the live list and the Completed accordion
 * (cd0270c0) so the two lists can never drift apart.
 */
export function ScheduleRow({ s, busy, undoable, expanded, onCancel, onToggleEnabled, onUndo, onToggleExpand }: ScheduleRowProps) {
  const completed = isCompleted(s);
  // Long prompts get the expand affordance; the 160-char floor keeps
  // short prompts (which never clamp) from growing a dead chevron.
  const expandable = (s.prompt?.length ?? 0) > 160;
  return (
    <div
      data-testid="schedule-row"
      className={cn('rounded-md border border-border px-2.5 py-2 space-y-1', (!s.enabled || undoable) && 'opacity-60')}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">{cadenceLabel(s)}</Badge>
        {s.kind === 'recurring' && s.projectedDailyFirings != null && (
          <span
            className={cn('text-[10px]', s.projectedDailyFirings >= s.dailyCapLimit ? 'font-medium text-warn-ink' : 'text-muted-foreground')}
            title={`Cadence math (ticket 2694a581): ~${s.projectedDailyFirings} firings/day against this chat's ${s.dailyCapLimit}/day schedule cap — one-shot schedules and hook wakes share that counter.`}
          >
            ≈{s.projectedDailyFirings}/day{s.projectedDailyFirings >= s.dailyCapLimit ? ' ⚠ cap' : ''}
          </span>
        )}
        {s.kind === 'recurring' && s.clockDriftMinutes != null && s.clockDriftMinutes !== 0 && (
          <span
            className={cn('text-[10px] font-medium text-warn-ink')}
            title={`Clock drift (ticket 903249e5): this ${Math.round((s.intervalSec ?? 0) / 60)}-min cadence is not day-aligned — each firing lands ${Math.abs(s.clockDriftMinutes)} min ${s.clockDriftMinutes < 0 ? 'EARLIER' : 'LATER'} than the last, so the firing time marches around the clock (a "daily" digest will NOT stay at one time of day). For a fixed time of day, use a whole-day cadence (1440 min).${s.projectedNextFirings?.length ? ` Projected next firings: ${s.projectedNextFirings.join(' · ')}.` : ''}`}
          >
            ⚠ drift {s.clockDriftMinutes > 0 ? '+' : ''}{s.clockDriftMinutes}m/firing
          </span>
        )}
        {!s.enabled && !undoable && (
          <Badge variant="secondary" className="text-[10px]">{completed ? 'completed' : 'stopped'}</Badge>
        )}
        {scheduleStatusBadge(s.lastStatus)}
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">
          {s.runsCount}{s.maxRuns != null ? `/${s.maxRuns}` : ''} run{(s.maxRuns ?? s.runsCount) === 1 ? '' : 's'}
        </span>
      </div>

      <div className="flex items-start gap-1">
        <p
          className={cn('flex-1 text-[11px] text-muted-foreground leading-snug', expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2')}
          title={expanded ? undefined : s.prompt}
        >
          {s.prompt}
        </p>
        {expandable && (
          <button
            type="button"
            onClick={() => onToggleExpand(s.id)}
            title={expanded ? 'Collapse prompt' : 'Show full prompt'}
            aria-label={expanded ? 'Collapse prompt' : 'Show full prompt'}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-[10px] text-muted-foreground">
          {s.enabled && <>next {relativeTime(s.nextRunAt)}</>}
          {s.lastFiredAt && <>{s.enabled ? ' · ' : ''}last {relativeTime(s.lastFiredAt)}</>}
          {!s.enabled && !s.lastFiredAt && <>never ran</>}
        </span>

        {undoable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onUndo(s)}
            className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-hover disabled:opacity-40"
          >
            <Undo2 className="size-3" /> Cancelled — Undo
          </button>
        ) : s.enabled ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onToggleEnabled(s)}
              title="Pause this schedule"
              aria-label="Pause schedule"
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onCancel(s)}
              title="Cancel this schedule (stops firing; kept for history)"
              aria-label="Cancel schedule"
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
            >
              <X className="size-3.5" />
            </button>
          </>
        ) : !completed && s.lastStatus?.startsWith('paused') ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onToggleEnabled(s)}
            title="Resume this schedule"
            aria-label="Resume schedule"
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Pure presentational view — all data/handlers arrive as props (SSR-testable). */
export function SchedulesSectionView({
  rows, loadError, hasChat, busyId, undoIds, expandedIds, warning, refreshing,
  completedOpen, onToggleCompleted,
  onRetry, onRefresh, onCancel, onToggleEnabled, onUndo, onToggleExpand,
}: SchedulesSectionViewProps) {
  if (!hasChat) {
    return (
      <div className="h-full overflow-y-auto p-3">
        <p className="text-[11px] text-muted-foreground leading-snug">
          Schedules attach to a chat — send a message first, then ask the agent to run this chat on a cadence.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-2.5">
      <div className="flex items-center gap-1.5">
        <p className="text-[11px] text-muted-foreground leading-snug flex-1">
          Scheduled runs for this chat. Cancel and pause apply immediately — no confirmation.
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh schedules"
          aria-label="Refresh schedules"
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
        >
          <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
        </button>
      </div>

      {/* Honest degraded state: an error with rows still loaded keeps the rows. */}
      {loadError && rows && rows.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive leading-snug">
          Could not refresh — showing the last loaded schedules.{' '}
          <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:opacity-80">Retry</button>
        </div>
      )}

      {/* Deaf-lane honesty from the backend: the chat has NO enabled schedules left. */}
      {warning && (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn-ink leading-snug">
          {warning}
        </div>
      )}

      {loadError && (!rows || rows.length === 0) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive leading-snug">
          Could not load schedules.{' '}
          <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:opacity-80">Retry</button>
        </div>
      ) : !rows ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-8 space-y-2">
          <CalendarClock className="size-5 text-muted-foreground/50 mx-auto" />
          <p className="text-[11px] text-muted-foreground leading-snug px-2">
            No schedules — the agent can create one, or ask it to run this chat on a cadence.
          </p>
        </div>
      ) : (
        (() => {
          // cd0270c0: live/pending rows always expanded; completed terminal
          // rows fold behind the "Completed (N)" accordion at the bottom.
          const { liveRows, completedRows } = partitionSchedules(rows, undoIds);
          return (
            <div className="space-y-2">
              {liveRows.map((s) => (
                <ScheduleRow
                  key={s.id}
                  s={s}
                  busy={busyId === s.id}
                  undoable={undoIds.has(s.id)}
                  expanded={expandedIds.has(s.id)}
                  onCancel={onCancel}
                  onToggleEnabled={onToggleEnabled}
                  onUndo={onUndo}
                  onToggleExpand={onToggleExpand}
                />
              ))}
          {completedRows.length > 0 && (
            <div className="rounded-md border border-dashed border-border" data-testid="completed-accordion">
              <button
                type="button"
                onClick={onToggleCompleted}
                aria-expanded={completedOpen === true}
                aria-controls="completed-schedules-list"
                className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                {completedOpen
                  ? <ChevronUp className="size-3" aria-hidden="true" />
                  : <ChevronDown className="size-3" aria-hidden="true" />}
                Completed ({completedRows.length})
                <span className="text-[10px] text-muted-foreground/70">
                  {completedOpen ? 'hide' : 'show'} finished one-time schedules
                </span>
              </button>
              {completedOpen && (
                <div id="completed-schedules-list" className="space-y-2 px-2.5 pb-2.5 pt-0.5">
                  {completedRows.map((s) => (
                      <ScheduleRow
                        key={s.id}
                        s={s}
                        busy={busyId === s.id}
                        undoable={undoIds.has(s.id)}
                        expanded={expandedIds.has(s.id)}
                        onCancel={onCancel}
                        onToggleEnabled={onToggleEnabled}
                        onUndo={onUndo}
                        onToggleExpand={onToggleExpand}
                      />
                  ))}
                </div>
              )}
            </div>
          )}
            </div>
          );
        })()
      )}
    </div>
  );
}

/** Connected wrapper: fetch (auto-retry once), actions with no confirmation, Undo window. */
export default function SchedulesSection({ chatId }: { chatId: string | null }) {
  const [rows, setRows] = useState<ChatScheduleRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [undoIds, setUndoIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [warning, setWarning] = useState<string | null>(null);
  // cd0270c0: the Completed accordion starts COLLAPSED every mount — the
  // panel must never open on a wall of dead rows.
  const [completedOpen, setCompletedOpen] = useState(false);
  // Undo timers by schedule id — cleared on unmount / on undo.
  const undoTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const staleRef = useRef(false);

  const load = useCallback(async (opts?: { retry?: boolean }) => {
    if (!chatId) return;
    setRefreshing(true);
    try {
      const next = await crossModelApi.listChatSchedules(chatId);
      if (staleRef.current) return;
      setRows(next);
      setLoadError(false);
    } catch {
      if (staleRef.current) return;
      if (!opts?.retry) {
        // Hardening: one quiet automatic retry before declaring an error.
        setTimeout(() => { if (!staleRef.current) void load({ retry: true }); }, 700);
        return;
      }
      setLoadError(true); // rows (if any) stay visible — the view says they're stale
    } finally {
      if (!staleRef.current) setRefreshing(false);
    }
  }, [chatId]);

  // Fetch on tab open (the panel mounts only the ACTIVE section's node, so
  // mount === tab open) and on chat switch.
  useEffect(() => {
    staleRef.current = false;
    setRows(null);
    setLoadError(false);
    setWarning(null);
    void load();
    const timers = undoTimersRef.current;
    return () => {
      staleRef.current = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [load]);

  const clearUndo = useCallback((id: string) => {
    const t = undoTimersRef.current.get(id);
    if (t) clearTimeout(t);
    undoTimersRef.current.delete(id);
    setUndoIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  }, []);

  const onCancel = useCallback(async (s: ChatScheduleRow) => {
    if (!chatId) return;
    setBusyId(s.id);
    try {
      const res = await crossModelApi.cancelChatSchedule(chatId, s.id);
      if (staleRef.current) return;
      setWarning(res.warning ?? null);
      // Arm the Undo window BEFORE the refetch so the affordance never flickers.
      setUndoIds(prev => new Set(prev).add(s.id));
      undoTimersRef.current.set(s.id, setTimeout(() => { if (!staleRef.current) clearUndo(s.id); }, UNDO_WINDOW_MS));
      void load({ retry: true });
    } catch {
      if (!staleRef.current) toast.error('Could not cancel the schedule.');
      void load({ retry: true }); // it may have vanished mid-fire — resync either way
    } finally {
      if (!staleRef.current) setBusyId(null);
    }
  }, [chatId, load, clearUndo]);

  const onUndo = useCallback(async (s: ChatScheduleRow) => {
    if (!chatId) return;
    setBusyId(s.id);
    try {
      await crossModelApi.setChatScheduleEnabled(chatId, s.id, true);
      if (staleRef.current) return;
      clearUndo(s.id);
      setWarning(null); // the lane is armed again
      toast.success('Schedule restored.');
      void load({ retry: true });
    } catch {
      if (!staleRef.current) toast.error('Could not restore the schedule.');
    } finally {
      if (!staleRef.current) setBusyId(null);
    }
  }, [chatId, load, clearUndo]);

  const onToggleEnabled = useCallback(async (s: ChatScheduleRow) => {
    if (!chatId) return;
    setBusyId(s.id);
    try {
      await crossModelApi.setChatScheduleEnabled(chatId, s.id, !s.enabled);
      if (staleRef.current) return;
      void load({ retry: true });
    } catch (err: unknown) {
      if (!staleRef.current) {
        // Server-side cadence-rule refusals (completed / active cap) carry an
        // honest message — surface it instead of a generic failure.
        const msg = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
        toast.error(msg?.message || msg?.error || `Could not ${s.enabled ? 'pause' : 'resume'} the schedule.`);
        void load({ retry: true });
      }
    } finally {
      if (!staleRef.current) setBusyId(null);
    }
  }, [chatId, load]);

  const onToggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  return (
    <SchedulesSectionView
      rows={rows}
      loadError={loadError}
      hasChat={!!chatId}
      busyId={busyId}
      undoIds={undoIds}
      expandedIds={expandedIds}
      warning={warning}
      refreshing={refreshing}
      completedOpen={completedOpen}
      onToggleCompleted={() => setCompletedOpen(o => !o)}
      onRetry={() => void load({ retry: true })}
      onRefresh={() => void load({ retry: true })}
      onCancel={(s) => void onCancel(s)}
      onToggleEnabled={(s) => void onToggleEnabled(s)}
      onUndo={(s) => void onUndo(s)}
      onToggleExpand={onToggleExpand}
    />
  );
}

/**
 * One-line Overview pointer (rm9 consolidation): the coding Overview used to
 * render its own display-only schedules block — now the tab owns the rows and
 * Overview links to it, so there is exactly ONE source of truth. Count fetch
 * is best-effort: on error the link renders without a count (never blank,
 * never blocks the Overview).
 */
export function ScheduleCountLine({ chatId }: { chatId: string }) {
  const [enabledCount, setEnabledCount] = useState<number | null>(null);
  useEffect(() => {
    let stale = false;
    crossModelApi.listChatSchedules(chatId)
      .then(rows => { if (!stale) setEnabledCount(rows.filter(r => r.enabled).length); })
      .catch(() => { /* count is decorative — the link still works */ });
    return () => { stale = true; };
  }, [chatId]);
  return (
    <section className="space-y-2">
      <h3 className="text-[12px] font-medium text-ink-3 flex items-center gap-1.5">
        <CalendarClock className="size-3.5 text-ink-3" /> Schedules
      </h3>
      <button
        type="button"
        onClick={() => openWorkspaceSection('schedules')}
        className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 decoration-muted-foreground/40"
      >
        {enabledCount === null
          ? 'Open the Schedules tab'
          : `${enabledCount} active schedule${enabledCount === 1 ? '' : 's'} → Schedules tab`}
      </button>
    </section>
  );
}
