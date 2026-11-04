'use client';

/**
 * ProjectPulse — the ONE shared "where is this project at" block (owner
 * requirement 2026-09-04: hourly non-technical summary + goal linkage + honest
 * ETA, surfaced under the management-dashboard project titles AND at the
 * project/session level). Pure presentational: it renders a FleetDigest row
 * (GET /fleet/digests — written by the hourly project-digest sweep) and
 * invents nothing:
 *
 *   - the plain-English summary (1–2 line clamp, tap to expand inline);
 *   - a compact chip line: the project-level ETA state (etaSummary) + one chip
 *     per goal ("Goal · 7/18 · ~3d"), honest for blocked / no-movement /
 *     done states — never a fabricated date;
 *   - "as of X ago" from generatedAt (when the summary TEXT was written).
 *
 * Used by: management/DashboardTab.tsx (compact, under each project title),
 * projects/[id]/page.tsx (headed block near the top), and the coding
 * Overview tab via SessionProjectPulse below (owner scoping principle
 * 2026-09-07 — the pulse moved there from the removed global Fleet tab,
 * scoped to the session's own project).
 *
 * digest === null renders an honest "no pulse yet" line (the sweep hasn't
 * bucketed this project yet); interactive bits stopPropagation so the block
 * can live inside clickable table rows.
 */

import { useState } from 'react';
import { relativeTimeLong } from '@/lib/relative-time';
import { Ban, Check, Clock, Moon, PauseCircle, TrendingUp, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fleetApi, type FleetDigest, type FleetDigestEtaSummary, type FleetDigestGoalProgress, type FleetGoalEtaClass } from '@/lib/api/fleet';
import { usePolling } from '@/lib/use-polling';

/** Goal chips shown before the "+N" overflow marker. */
const GOAL_CHIP_CAP = 4;

const ETA_CLASS_META: Record<FleetGoalEtaClass, { icon: React.ElementType; className: string }> = {
  on_pace:         { icon: TrendingUp,    className: 'border-success-accent/50 text-success' },
  no_movement:     { icon: Moon,          className: 'border-border text-muted-foreground' },
  blocked:         { icon: Ban,           className: 'border-destructive/50 text-destructive' },
  // Ticket C1 (2026-09-27): a progress note that LEADS with a hold marker (a
  // fact about the note — "held per note", never an owner-set status) / a
  // pace that overshoots a registered deadline.
  held:            { icon: PauseCircle,   className: 'border-warning/50 text-warning' },
  behind_deadline: { icon: TriangleAlert, className: 'border-destructive/50 text-destructive' },
  done:            { icon: Check,         className: 'border-success-accent/50 text-success' },
  // GOAL-UNPLANNED (2026-10-20): an open goal with nothing open under it — needs a plan.
  unplanned:       { icon: TriangleAlert, className: 'border-warning/50 text-warning' },
};

/** "due in 3d" / "due today" / "3d overdue" from the server-computed daysLeft — display only. */
function deadlineLabel(deadline: { daysLeft: number } | undefined): string | null {
  if (!deadline || !Number.isFinite(deadline.daysLeft)) return null;
  const d = deadline.daysLeft;
  if (d < 0) return `${Math.max(1, Math.round(-d))}d overdue`;
  if (d < 1) return 'due today';
  return `due in ${Math.round(d)}d`;
}

/** "~3d" from the server-computed etaDays — display only, never re-derived. */
function etaDaysLabel(etaDays: number | null): string | null {
  if (etaDays === null || !Number.isFinite(etaDays)) return null;
  return `~${Math.max(1, Math.round(etaDays))}d`;
}

/** The project-level chip text — honest per class (exported for tests). */
export function etaSummaryLabel(eta: FleetDigestEtaSummary): string {
  switch (eta.class) {
    case 'on_pace': {
      const days = etaDaysLabel(eta.etaDays);
      return days ? `On pace · ${days} to go` : 'On pace';
    }
    case 'blocked':
      return eta.blockedCount === 1 ? 'Blocked · 1 task gating' : `Blocked · ${eta.blockedCount} tasks gating`;
    case 'held':
      return 'Held per note';
    case 'behind_deadline': {
      const due = deadlineLabel(eta.deadline);
      return due ? `Behind deadline · ${due}` : 'Behind deadline';
    }
    case 'done':
      return 'Goals done';
    case 'no_movement':
    default:
      return 'No recent movement';
  }
}

/**
 * Stopped-schedule warning chip text (SA0906): the digest's schedule_error
 * attention items are successor-aware on the backend (only genuinely
 * heartbeat-dead lanes / live-erroring schedules survive), so the count here
 * is true positives only. Exported for tests.
 */
export function stoppedScheduleChipLabel(count: number): string {
  return `${count} stopped schedule${count === 1 ? '' : 's'}`;
}

/** One goal's chip text: "7/18" + the honest state suffix (exported for tests). */
export function goalChipLabel(gp: FleetDigestGoalProgress): string {
  const counts = `${gp.todosDone}/${gp.todosTotal}`;
  switch (gp.eta.class) {
    case 'on_pace': {
      const days = etaDaysLabel(gp.eta.etaDays);
      return days ? `${counts} · ${days}` : counts;
    }
    case 'blocked':
      return `${counts} · blocked`;
    case 'held':
      return `${counts} · held per note`;
    case 'behind_deadline': {
      const due = deadlineLabel(gp.eta.deadline);
      return due ? `${counts} · ${due}` : `${counts} · behind deadline`;
    }
    case 'done':
      return `${counts} · done`;
    case 'unplanned':
      return `${counts} · needs a plan`;
    case 'no_movement':
    default:
      return `${counts} · no movement`;
  }
}

function GoalChip({ gp }: { gp: FleetDigestGoalProgress }) {
  const meta = ETA_CLASS_META[gp.eta.class] ?? ETA_CLASS_META.no_movement;
  return (
    <span
      title={`${gp.title} — ${gp.todosDone} of ${gp.todosTotal} tasks done`}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
        meta.className,
      )}
    >
      <span className="max-w-[9rem] truncate font-medium">{gp.title}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{goalChipLabel(gp)}</span>
    </span>
  );
}

export function ProjectPulse({ digest, compact, title, className }: {
  /** The project's digest row; null = no digest exists yet (honest empty state). */
  digest: FleetDigest | null;
  /** Compact = inline under a table row title (no header, tighter empty copy). */
  compact?: boolean;
  /** Optional block heading (the project-page "Project pulse" label). */
  title?: string;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!digest) {
    return (
      <div className={cn('text-[11px] text-muted-foreground', className)}>
        {compact ? 'No pulse yet.' : 'No pulse yet — the hourly project summary lands after the next sweep.'}
      </div>
    );
  }
  const goalProgress = digest.goalProgress ?? [];
  const etaSummary = digest.etaSummary ?? null;
  const visibleGoals = goalProgress.slice(0, GOAL_CHIP_CAP);
  const moreGoals = goalProgress.length - visibleGoals.length;
  const overallMeta = etaSummary ? ETA_CLASS_META[etaSummary.class] ?? ETA_CLASS_META.no_movement : null;
  const OverallIcon = overallMeta?.icon ?? TrendingUp;
  // Stopped-schedule warning (SA0906): schedule_error attention items are the
  // digest's successor-aware "this lane's cadence needs the owner" signal.
  const stoppedSchedules = (digest.attentionItems ?? []).filter((i) => i.kind === 'schedule_error').length;

  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      {title && (
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
          <Clock className="size-3.5" />
          {title}
        </div>
      )}
      {/* Summary — 2-line clamp, tap to expand inline. stopPropagation: this
          block lives inside clickable dashboard rows (row onClick navigates). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        title={expanded ? 'Collapse the summary' : 'Expand the full summary'}
        className="block w-full cursor-pointer text-left"
      >
        <p className={cn(
          'whitespace-normal text-[11px] font-normal leading-4 text-muted-foreground break-words',
          !expanded && 'line-clamp-2',
        )}>
          {digest.summary}
        </p>
      </button>
      {(etaSummary || visibleGoals.length > 0 || stoppedSchedules > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {stoppedSchedules > 0 && (
            <span
              title="Recurring schedules on this project stopped and will not resume on their own — check the decisions queue."
              className="inline-flex items-center gap-1 rounded-full border border-destructive/50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive"
            >
              <TriangleAlert className="size-2.5" />
              {stoppedScheduleChipLabel(stoppedSchedules)}
            </span>
          )}
          {etaSummary && (
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
              overallMeta?.className,
            )}>
              <OverallIcon className="size-2.5" />
              {etaSummaryLabel(etaSummary)}
            </span>
          )}
          {visibleGoals.map((gp) => <GoalChip key={gp.goalId} gp={gp} />)}
          {moreGoals > 0 && (
            <span className="text-[10px] text-muted-foreground">+{moreGoals} more goals</span>
          )}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/80">
        as of {relativeTimeLong(digest.generatedAt)}
      </p>
    </div>
  );
}

export default ProjectPulse;

// ─── Connected wrapper for the coding Overview tab ───────────────────────────

const PULSE_POLL_MS = 60_000;

/**
 * SessionProjectPulse — the coding Overview tab's Project Pulse (owner scoping
 * principle 2026-09-07: "the sidepanel should only pertain to that chat or
 * project or session"; the block moved here from the removed global Fleet
 * tab). Fetches the ONE digest for the session's own project (GET
 * /fleet/digests) and polls hourly-refreshed data at a light cadence. A failed
 * refresh keeps the last good digest — a transient outage never blanks the
 * block (the FleetPanel-era contract).
 */
export function SessionProjectPulse({ projectId, className }: {
  projectId: string;
  className?: string;
}) {
  const [digest, setDigest] = useState<FleetDigest | null>(null);
  // usePolling (P5): abortable ticks; `key` restarts the poll (fresh
  // immediate fetch) when the session's project changes. A failed/aborted
  // refresh keeps the last good digest (the FleetPanel-era contract).
  usePolling(
    (signal) => fleetApi.getDigests({ signal }),
    {
      intervalMs: PULSE_POLL_MS,
      key: projectId,
      pauseWhenHidden: false, // legacy behavior: the light 60s cadence keeps running hidden
      onData: (r) => setDigest(r.digests.find(d => d.projectId === projectId) ?? null),
    },
  );
  return <ProjectPulse digest={digest} className={className} />;
}
