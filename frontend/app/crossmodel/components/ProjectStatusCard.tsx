'use client';

/**
 * ProjectStatusCard — the per-project supervisor's status row (SHARED
 * CONTRACT 2026-09-14: an assistant row with metadata { origin:
 * 'project_status', kind: 'project_status', generatedAt, since, status: {
 * projectName, headline, workingOn[], doneSince[], blocked[], next[], goals,
 * todos, lanesRunning, ownerItems } } and a plain-language Markdown body).
 *
 * Renders: headline, then compact "Working on / Done in the last hour /
 * Blocked or needs you / Next" lists (empty sections hidden), a small
 * counters row (goals active/done/blocked · todos in progress/pending/
 * blocked · lanes running/scheduled · owner items — zero-only groups hidden),
 * and the generatedAt timestamp. metadata.status wins field-by-field; the
 * Markdown body fills gaps (lib/machine-wake.ts normalizeProjectStatus). No
 * ids, no jargon — the contract's body is already plain language.
 *
 * 2026-09-24 (owner complaints, canlegal-bench supervisor chat):
 *   · "Lanes 3 running" while nothing ran → the counter says "running" only
 *     for lanesRunning > 0 and adds "N scheduled" (metadata.status
 *     .lanesScheduled; older rows are reconciled against the timing lanes).
 *   · "Three work sessions are still running … but no active work item" →
 *     an empty Working on is synthesized from the RUNNING timing lanes
 *     ("Running: <title> (<age>)") so the section never contradicts the
 *     counters (the backend does this too; the client keeps older rows honest).
 *   · eight "no change in the last hour" cards overnight → a row stamped
 *     metadata.unchanged renders the COMPACT variant: headline + one muted
 *     "No change since … · checked N times · next check ~…" line, and never
 *     the sections / brief / You-asked — a CHANGED SET OF ASKS IS A REAL
 *     CHANGE (the backend inserts a full card when the asks fingerprint
 *     moves), so stubs carry no asks. The one signal a stub keeps is the
 *     owner question: the headline's "; N item(s) waiting on you" clause as
 *     sent and the "Needs you" counter (review C12). The stub headline's
 *     "since HH:MMZ" clock is anchored on the streak start (quietSince), not
 *     the card time, so it reads the right day after UTC midnight (C19).
 *   · "→ no record yet" under every ask for 12+ hours although each was
 *     answered in chat within minutes → 'answered' renders "answered in chat",
 *     'unknown' renders "not tracked", resolved asks carry a check mark,
 *     unresolved asks sort first, and a one-line explainer says what the
 *     list is.
 *
 * Semantic tokens only; the grid stacks to one column on phones.
 */

import { useState, type ReactNode } from 'react';
import { ChevronRight, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  normalizeProjectStatus, normalizeProjectBrief, normalizeProjectStatusQuiet, normalizeProjectUpdate, visibleAsks, isUnresolvedAsk,
  type ProjectStatusData, type ProjectTimingData, type ProjectTimingLaneData, type ProjectBriefAskData,
  type ProjectUpdateData, type ProjectUpdateState,
} from '@/lib/machine-wake';
import { formatMessageTime } from '@/lib/format-message-time';
import { localizeUtcTimes } from '@/lib/localize-utc-times';

// ── Timing strip (owner 2026-09-17: "what is going on / how much longer") ────
// Every number here was MEASURED by the backend at card time (run ages, last
// heartbeat, next wakes, the fractions lanes reported, the rate between two
// cards). The card never computes an estimate of its own and the model never
// types one — when there is nothing countable the strip says so.

export function formatDurationMin(min: number): string {
  if (!Number.isFinite(min) || min < 1) return '<1m';
  if (min < 60) return `${Math.floor(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

export function formatEtaMin(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return 'count complete';
  if (min < 60) return `≈ ${Math.ceil(min)} min at this pace`;
  if (min < 24 * 60) return `≈ ${Math.round((min / 60) * 10) / 10} h at this pace`;
  return `≈ ${Math.round((min / 1440) * 10) / 10} d at this pace`;
}

const pctOf = (done: number, total: number): number => (total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0);
const fmtN = (n: number): string => n.toLocaleString('en-US');

function ProgressBar({ done, total, tone, label }: { done: number; total: number; tone: string; label: string }) {
  const p = pctOf(done, total);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p}
      className="h-1.5 w-full min-w-0 overflow-hidden rounded-full bg-muted"
    >
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${p}%` }} />
    </div>
  );
}

function laneMeta(l: ProjectTimingLaneData): string {
  if (l.state === 'running') {
    const parts = [`running ${formatDurationMin(l.runningForMin ?? 0)}`];
    if (typeof l.lastActivityMin === 'number') parts.push(l.lastActivityMin < 1 ? 'active now' : `active ${formatDurationMin(l.lastActivityMin)} ago`);
    return parts.join(' · ');
  }
  const wake = l.nextWakeAt ? formatMessageTime(l.nextWakeAt) : null;
  return wake ? `next wake ${wake}` : 'scheduled';
}

export function TimingStrip({ timing, generatedAt }: { timing: ProjectTimingData; generatedAt?: string }) {
  const lanes = timing.lanes.slice(0, 4);
  const goals = timing.goals.slice(0, 4);
  const nextCheck = timing.nextCheckAt ? formatMessageTime(timing.nextCheckAt) : null;
  const nextStatus = timing.nextStatusAt ? formatMessageTime(timing.nextStatusAt) : null;
  // Review C17 (2026-09-24): the backend's no-estimate sentence may carry a
  // harness clock ("next wake 14:30Z") — it reads in the viewer's zone like
  // every other clock on the card, anchored on the card time.
  const noEstimate = timing.noEstimateReason ? localizeUtcTimes(timing.noEstimateReason, { anchor: generatedAt }) : undefined;
  const closures = timing.closures.length;
  const dots = Math.min(closures, 12);
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-2" data-status-timing>
      <div className="mb-1 text-[12px] font-medium text-ink-3">Where things stand</div>
      {lanes.length > 0 && (
        <ul className="space-y-1.5">
          {lanes.map((l, i) => {
            const p = l.progress;
            return (
              <li key={`${l.chatId ?? l.title}-${i}`} className="min-w-0" data-timing-lane data-lane-state={l.state}>
                <div className="flex items-baseline gap-1.5 text-[11px]">
                  <span className={cn('mt-[0.35em] size-1.5 shrink-0 self-start rounded-full', l.state === 'running' ? 'bg-info' : 'bg-muted-foreground/50')} aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-foreground/80">{l.title}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground">{laneMeta(l)}</span>
                </div>
                {p && (
                  <div className="mt-0.5 flex items-center gap-2 pl-3">
                    <ProgressBar done={p.done} total={p.total} tone={p.stalled ? 'bg-warning' : 'bg-info'} label={p.label ? `${p.label}: ${p.done} of ${p.total}` : `${p.done} of ${p.total}`} />
                    <span className="shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">
                      {fmtN(p.done)} of {fmtN(p.total)} · {pctOf(p.done, p.total)}%
                    </span>
                  </div>
                )}
                {(l.eta || p?.stalled) && (
                  <div className={cn('pl-3 text-[10.5px]', p?.stalled && !l.eta ? 'text-warning' : 'text-muted-foreground')} data-timing-eta>
                    {l.eta ? `${formatEtaMin(l.eta.minutes)}${l.eta.minutes > 0 ? ' · low confidence' : ''}` : 'No movement since the last update'}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {goals.length > 0 && (
        <ul className={cn('space-y-1', lanes.length > 0 && 'mt-2 border-t border-border/50 pt-1.5')}>
          {goals.map((g, i) => (
            <li key={`${g.id ?? g.title}-${i}`} className="min-w-0" data-timing-goal>
              <div className="flex items-baseline gap-2 text-[11px]">
                <span className="min-w-0 truncate text-foreground/80">{g.title}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{g.done} of {g.total} to-dos</span>
              </div>
              <ProgressBar done={g.done} total={g.total} tone="bg-success-accent" label={`${g.title}: ${g.done} of ${g.total} to-dos done`} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground" data-timing-footer>
        {closures > 0 && (
          <span className="inline-flex items-center gap-1.5" title={`${closures} finished since the last update`}>
            <span className="inline-flex items-center gap-0.5" aria-hidden="true">
              {Array.from({ length: dots }, (_, i) => <span key={i} className="size-1.5 rounded-full bg-success-accent" />)}
              {closures > dots && <span className="pl-0.5">+{closures - dots}</span>}
            </span>
            {closures} finished
          </span>
        )}
        {nextCheck && <span>Next check {nextCheck}</span>}
        {nextStatus && <span>Next update ~{nextStatus}</span>}
      </div>
      {noEstimate && (
        <div className="mt-1 text-[10.5px] italic text-muted-foreground/80" data-timing-note>{noEstimate}</div>
      )}
    </div>
  );
}

interface SectionSpec {
  key: 'workingOn' | 'doneSince' | 'blocked' | 'next';
  label: string;
  tone: string;
  dot: string;
}

const SECTIONS: SectionSpec[] = [
  { key: 'workingOn', label: 'Working on', tone: 'text-foreground', dot: 'bg-info' },
  { key: 'doneSince', label: 'Done in the last hour', tone: 'text-foreground', dot: 'bg-success-accent' },
  { key: 'blocked', label: 'Blocked or needs you', tone: 'text-warning', dot: 'bg-warning' },
  { key: 'next', label: 'Next', tone: 'text-foreground', dot: 'bg-muted-foreground/50' },
];

/** "3 active · 1 done · 2 blocked" — zero parts omitted; '' when all zero/absent. */
function counterText(parts: Array<[string, number | undefined]>): string {
  return parts.filter(([, n]) => typeof n === 'number' && n > 0).map(([label, n]) => `${n} ${label}`).join(' · ');
}

export function prsCounterText(prs: ProjectStatusData['prs']): string | null {
  if (!prs) return null;
  const opened = typeof prs.opened === 'number' && prs.opened > 0 ? prs.opened : 0;
  const parts: string[] = [];
  if (opened > 0) parts.push(`${opened} opened`);
  if (typeof prs.merged === 'number' && prs.merged > 0) parts.push(`${prs.merged} merged`);
  if (typeof prs.docsOnly === 'number' && prs.docsOnly > 0) parts.push(`${prs.docsOnly} docs-only`);
  return parts.length ? parts.join(' · ') : null;
}

export function statusCounters(d: ProjectStatusData): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  // Session-card counters (origin session_status, 2026-09-15): plan progress,
  // runs in the window, pull requests, spend — zero-valued groups hidden.
  if (d.plan && typeof d.plan.total === 'number' && d.plan.total > 0) {
    const blockedSteps = typeof d.plan.blocked === 'number' && d.plan.blocked > 0 ? ` · ${d.plan.blocked} blocked` : '';
    out.push({ label: 'Plan', text: `${d.plan.done ?? 0} of ${d.plan.total} steps${blockedSteps}` });
  }
  const runs = counterText([['finished', d.runs?.completed], ['failed', d.runs?.failed], ['running', d.runs?.running]]);
  if (runs) out.push({ label: 'Runs', text: runs });
  // PRs (docs-churn deferred piece, 2026-09-28): opened · merged · docs-only —
  // a lane whose PRs are all docs-only reads "3 opened · 3 docs-only", never as
  // three units of work. Zero-valued parts hidden; the merged count renders
  // even when nothing was opened in the window (a merge of an older PR).
  const prsText = prsCounterText(d.prs);
  if (prsText) out.push({ label: 'PRs', text: prsText });
  if (typeof d.spendUsd === 'number' && d.spendUsd > 0) out.push({ label: 'Spend', text: `$${d.spendUsd.toFixed(2)}` });
  const goals = counterText([['active', d.goals?.active], ['done', d.goals?.done], ['blocked', d.goals?.blocked]]);
  if (goals) out.push({ label: 'Goals', text: goals });
  const todos = counterText([
    ['in progress', d.todos?.inProgress], ['pending', d.todos?.pending], ['blocked', d.todos?.blocked], ['done', d.todos?.doneSince],
  ]);
  if (todos) out.push({ label: 'To-dos', text: todos });
  // 2026-09-24: "running" only for a RUNNING agent_run; a lane that merely
  // holds an enabled schedule reads "scheduled" ("Lanes 3 scheduled" when none
  // run — never "3 running").
  const lanes = counterText([['running', d.lanesRunning], ['scheduled', d.lanesScheduled]]);
  if (lanes) out.push({ label: 'Lanes', text: lanes });
  if (typeof d.ownerItems === 'number' && d.ownerItems > 0) {
    out.push({ label: 'Needs you', text: `${d.ownerItems} item${d.ownerItems === 1 ? '' : 's'}` });
  }
  return out;
}

/**
 * 2026-09-24 ("Three work sessions are still running … but no active work
 * item"): when the wire's workingOn is empty but timing lanes are RUNNING,
 * the section is synthesized from those lanes so it never contradicts the
 * counters. Ages are the backend's measured runningForMin — never estimated
 * here. Empty when nothing runs.
 */
export function runningLaneLines(timing: ProjectTimingData | undefined): string[] {
  if (!timing) return [];
  return timing.lanes
    .filter((l) => l.state === 'running')
    .map((l) => (typeof l.runningForMin === 'number' ? `Running: ${l.title} (${formatDurationMin(l.runningForMin)})` : `Running: ${l.title}`));
}

// 2026-09-24 (owner: "→ no record yet" for 12+ hours on asks the supervisor
// had answered in chat within minutes): 'answered' = the supervisor's own
// reply; 'unknown' = nothing in the inputs tracks it — never "no record yet".
const ASK_LABEL: Record<ProjectBriefAskData['status'], string> = { done: 'done', answered: 'answered in chat', in_progress: 'in progress', open: 'open', unknown: 'not tracked' };
const ASK_TONE: Record<ProjectBriefAskData['status'], string> = { done: 'text-success-accent', answered: 'text-success-accent', in_progress: 'text-info', open: 'text-warning', unknown: 'text-muted-foreground' };
const ASK_EXPLAINER = 'Your recent messages to this supervisor and what became of each (ledger, board, or its reply).';

/** "No change since 8:21 AM · checked 6 times · next check ~3:35 PM" — the
 *  compact stub's one muted line; parts the row lacks are omitted. */
export function quietLine(q: { quietSince?: string; quietChecks?: number }, nextCheckAt?: string): string {
  const parts: string[] = [];
  const since = q.quietSince ? formatMessageTime(q.quietSince) : null;
  if (since) parts.push(`No change since ${since}`);
  if (typeof q.quietChecks === 'number' && q.quietChecks > 0) parts.push(`checked ${q.quietChecks} time${q.quietChecks === 1 ? '' : 's'}`);
  const next = nextCheckAt ? formatMessageTime(nextCheckAt) : null;
  if (next) parts.push(`next check ~${next}`);
  return parts.join(' · ') || 'No change since the last update';
}

/** "Sep 21, 9:52 PM" in the viewer's zone; the raw stamp when unparseable. */
export function formatAskTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try { return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso; }
}

// ── At-a-glance update (owner 2026-09-29) ───────────────────────────────────
// The digby-benchmarks recording: the same headline every hour, a paraphrase
// with contradicting counts, six re-annotated "You asked" rows — and the owner
// still asking "where are things at?". When the row carries metadata.update
// the card LEADS with four answers: one state pill, one summary line (the work
// and its count), what changed since the last update, what needs the owner in
// their own words — then the next check. Everything the card showed before
// (the model paragraph, lanes, goals, sections, the full request log,
// counters) moves behind a collapsed "Details". Superseded cards (a newer
// status row exists in the chat) render as ONE line that expands in place.

const STATE_PILL_CLS: Record<ProjectUpdateState, string> = {
  needs_you: 'border-warning/50 bg-warning/10 text-warning',
  blocked: 'border-destructive/40 bg-destructive/10 text-destructive',
  stalled: 'border-warning/50 bg-warning/10 text-warning',
  working: 'border-info/40 bg-info/10 text-info',
  idle: 'border-border bg-muted text-muted-foreground',
  done: 'border-success-border bg-success-soft text-success-strong',
  no_goals: 'border-border bg-muted text-muted-foreground',
};

export function StatePill({ update, className }: { update: Pick<ProjectUpdateData, 'state' | 'stateLabel'>; className?: string }) {
  return (
    <span
      data-update-state={update.state}
      className={cn('inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10.5px] font-semibold leading-4', STATE_PILL_CLS[update.state], className)}
    >
      {update.stateLabel}
    </span>
  );
}

/** "3 changes" / "no change" — the one-line (superseded) card's tail. Pure. */
export function changeCountText(u: Pick<ProjectUpdateData, 'changes'>): string {
  const n = u.changes.filter((c) => !/^…and \d+ more/.test(c)).length;
  const more = u.changes.find((c) => /^…and (\d+) more/.test(c));
  const extra = more ? Number(/^…and (\d+)/.exec(more)?.[1] ?? 0) : 0;
  const total = n + extra;
  return total === 0 ? 'no change' : `${total} change${total === 1 ? '' : 's'}`;
}

/** "Next check 11:03 PM · Next update ~12:07 AM" — parts the row lacks omitted. */
export function nextLine(update: Pick<ProjectUpdateData, 'nextCheckAt'>, nextStatusAt?: string): string {
  const parts: string[] = [];
  const check = update.nextCheckAt ? formatMessageTime(update.nextCheckAt) : null;
  if (check) parts.push(`Next check ${check}`);
  const status = nextStatusAt ? formatMessageTime(nextStatusAt) : null;
  if (status) parts.push(`Next update ~${status}`);
  return parts.join(' · ');
}

function UpdateList({ label, items, tone, dot, empty }: { label: string; items: string[]; tone?: string; dot: string; empty: string }) {
  return (
    <div className="min-w-0">
      <div className={cn('mb-0.5 text-[12px] font-medium', tone ?? 'text-muted-foreground/80')}>{label}</div>
      {items.length ? (
        <ul className="space-y-0.5">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-1.5 leading-relaxed text-foreground [overflow-wrap:anywhere]">
              <span className={cn('mt-[0.45em] size-1.5 shrink-0 rounded-full', dot)} aria-hidden="true" />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

/** The four-answer block the card leads with. */
export function UpdateSummary({ update, nextStatusAt, quietText }: { update: ProjectUpdateData; nextStatusAt?: string; quietText?: string }) {
  const p = update.progress;
  const next = nextLine(update, nextStatusAt);
  const moreAsks = update.needsYouCount - update.needsYou.length;
  const needsYou = update.needsYou.map((q) => `“${q}”`);
  if (moreAsks > 0) needsYou.push(`…and ${moreAsks} more question${moreAsks === 1 ? '' : 's'} in your Inbox`);
  if (!needsYou.length && update.needsYouCount > 0) needsYou.push(`${update.needsYouCount} question${update.needsYouCount === 1 ? '' : 's'} waiting in your Inbox`);
  return (
    <div data-project-update>
      <div className="flex min-w-0 items-start gap-2">
        <StatePill update={update} className="mt-0.5" />
        <div className="min-w-0 text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-update-summary>{update.summary}</div>
      </div>
      {p && (
        <div className="mt-1.5 flex items-center gap-2" data-update-progress>
          <ProgressBar done={p.done} total={p.total} tone={update.state === 'stalled' ? 'bg-warning' : 'bg-info'} label={p.label ? `${p.label}: ${p.done} of ${p.total}` : `${p.done} of ${p.total}`} />
          <span className="shrink-0 whitespace-nowrap text-[10.5px] tabular-nums text-muted-foreground">{fmtN(p.done)} of {fmtN(p.total)} · {pctOf(p.done, p.total)}%</span>
        </div>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <UpdateList label="Since the last update" items={update.changes} dot="bg-success-accent" empty={quietText ?? 'No change since the last update.'} />
        <UpdateList label="Needs you" items={needsYou} tone={needsYou.length ? 'text-warning' : undefined} dot="bg-warning" empty="Nothing needs you." />
      </div>
      {next && <div className="mt-1.5 text-[10.5px] text-muted-foreground" data-update-next>{next}</div>}
    </div>
  );
}

function DetailsToggle({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 border-t border-border/60 pt-1.5" data-update-details>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

function AskRow({ a }: { a: ProjectBriefAskData }) {
  return (
    <li className="leading-relaxed [overflow-wrap:anywhere]" data-ask-status={a.status}>
      <span className="text-muted-foreground">{formatAskTime(a.at)}</span>
      <span className="text-muted-foreground"> — </span>
      <span className="text-foreground">“{a.text.length > 110 ? `${a.text.slice(0, 109)}…` : a.text}”</span>
      <span className="text-muted-foreground"> → </span>
      <span className={cn('font-medium', ASK_TONE[a.status])}>
        {!isUnresolvedAsk(a.status) && <span aria-hidden="true">✓ </span>}
        {ASK_LABEL[a.status]}
      </span>
      {a.note && <span className="text-muted-foreground">: {a.note}</span>}
    </li>
  );
}

/** "Your requests": the still-open ones, then the answered / done ones behind
 *  one more click (they repeated on every hourly card). */
function AsksList({ open, answered }: { open: ProjectBriefAskData[]; answered: ProjectBriefAskData[] }) {
  const [showDone, setShowDone] = useState(false);
  const openShown = visibleAsks(open, 6);
  const doneShown = visibleAsks(answered, 6);
  return (
    <div className="mt-2 min-w-0" data-project-brief-asks>
      <div className="mb-0.5 text-[12px] font-medium text-ink-3">Your requests</div>
      {openShown.length > 0 ? (
        <ul className="space-y-1">{openShown.map((a, i) => <AskRow key={`${a.at}-${i}`} a={a} />)}</ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">Nothing you asked for is still open.</p>
      )}
      {doneShown.length > 0 && (
        <>
          <button type="button" onClick={() => setShowDone((v) => !v)} className="mt-1 text-[10.5px] text-muted-foreground underline-offset-2 hover:underline" data-asks-toggle>
            {showDone ? 'Hide answered' : `Show ${doneShown.length} answered`}
          </button>
          {showDone && <ul className="mt-1 space-y-1">{doneShown.map((a, i) => <AskRow key={`${a.at}-d${i}`} a={a} />)}</ul>}
        </>
      )}
    </div>
  );
}

/** "Details — summary, lanes and goals · 2 open requests of yours" — what the fold holds. */
export function detailsLabel(parts: { hasBrief: boolean; hasTiming: boolean; openAsks: number; asks: number }): string {
  const bits: string[] = [];
  if (parts.hasBrief) bits.push('summary');
  if (parts.hasTiming) bits.push('lanes and goals');
  const head = bits.length ? `Details — ${bits.join(', ')}` : 'Details';
  if (parts.openAsks > 0) return `${head} · ${parts.openAsks} open request${parts.openAsks === 1 ? '' : 's'} of yours`;
  if (parts.asks > 0) return `${head} · your recent requests`;
  return head;
}

export default function ProjectStatusCard({
  content,
  status,
  brief: briefRaw,
  generatedAt,
  timeLabel,
  variant = 'project',
  unchanged,
  quietSince,
  quietChecks,
  update: updateRaw,
  superseded,
}: {
  content: string;
  /** metadata.status (the SHARED CONTRACT object) — optional; the body fills gaps. */
  status?: unknown;
  /** metadata.brief (owner 2026-09-22): the plain-language brief + "You asked" ledger. */
  brief?: unknown;
  /** metadata.generatedAt ISO stamp. */
  generatedAt?: string;
  /** Pre-formatted time (wins over generatedAt when given). */
  timeLabel?: string;
  /** 'session' renders the per-coding-session card (owner ask 2026-09-15):
   *  "Session status · <title>" with plan/runs/PR counters; same body shape. */
  variant?: 'project' | 'session';
  /** metadata.unchanged (2026-09-24): true on the "no change" stub ⇒ the
   *  COMPACT variant (headline + one muted line + the "Needs you" counter when
   *  an owner question is open; no sections / brief / asks). */
  unchanged?: boolean;
  /** metadata.quietSince — ISO: when the status last changed (stubs only). */
  quietSince?: string;
  /** metadata.quietChecks — hourly checks that found no change (stubs only). */
  quietChecks?: number;
  /** metadata.update (owner 2026-09-29): the at-a-glance update the card leads with. */
  update?: unknown;
  /** A NEWER status card exists in this chat (owner 2026-09-29): render ONE
   *  line (pill · time · summary · change count) that expands in place. */
  superseded?: boolean;
}) {
  const [expandedOld, setExpandedOld] = useState(false);
  const raw = normalizeProjectStatus(status, content);
  const quiet = normalizeProjectStatusQuiet({ unchanged, quietSince, quietChecks });
  // Owner 2026-09-14: any harness clock that survives into a status line reads
  // in the viewer's local time (the backend renderer strips them; belt and braces).
  const loc = (xs: string[]) => xs.map((x) => localizeUtcTimes(x, { anchor: generatedAt }));
  const d: ProjectStatusData = {
    ...raw,
    // Review C19 (2026-09-24): a stub's "no change since 22:21Z" names the
    // STREAK START, so its bare clock takes its calendar day from quietSince —
    // anchored on the card time it resolved to the wrong day once the card was
    // generated after UTC midnight, and disagreed with the quiet line below.
    headline: localizeUtcTimes(raw.headline, { anchor: quiet?.quietSince ?? generatedAt }),
    // 2026-09-24: an empty Working on next to running lanes is the contradiction
    // the owner read ("running … but no active work item") — fill it from the
    // measured running lanes (older rows; the fixed backend fills its own).
    workingOn: raw.workingOn.length ? loc(raw.workingOn) : runningLaneLines(raw.timing),
    doneSince: loc(raw.doneSince),
    blocked: loc(raw.blocked),
    next: loc(raw.next),
  };
  const stamp = timeLabel ?? formatMessageTime(generatedAt) ?? undefined;
  const sections = SECTIONS.filter((s) => d[s.key].length > 0);
  const counters = statusCounters(d);
  const isSession = variant === 'session';
  const headline = d.headline || (isSession ? 'Session status' : 'Project status');
  const nameLabel = isSession ? (d.sessionTitle || d.projectName) : d.projectName;
  // Review C15 (2026-09-24): an OLDER row whose lanes reconciled to none
  // running also loses its "N work sessions are running" sentence — the
  // headline, the counters and the brief must tell one story.
  const brief = normalizeProjectBrief(briefRaw, raw.lanesReconciled);
  const plainWords = brief ? [brief.mission, brief.now].filter(Boolean).join(' ') : '';

  const header = (
    <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <ClipboardList className="size-3.5 shrink-0 text-ink-2" aria-hidden="true" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground/80">{isSession ? 'Session status' : 'Project status'}</span>
        {nameLabel && <span> · {nameLabel}</span>}
        {isSession && d.projectName && d.sessionTitle && <span className="text-muted-foreground/70"> · {d.projectName}</span>}
      </span>
      {stamp && <span className="ml-auto shrink-0">{stamp}</span>}
    </div>
  );

  const update = variant === 'project' ? normalizeProjectUpdate(updateRaw) : undefined;
  if (update) {
    const quietText = quiet ? quietLine(quiet, undefined) : undefined;
    if (superseded && !expandedOld) {
      return (
        <button
          type="button"
          aria-expanded={false}
          onClick={() => setExpandedOld(true)}
          data-project-status data-status-variant={variant} data-status-superseded
          className="flex w-full min-w-0 items-center gap-1.5 rounded-lg border bg-muted/20 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
        >
          <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
          <StatePill update={update} />
          {stamp && <span className="shrink-0 tabular-nums">{stamp}</span>}
          <span className="min-w-0 flex-1 truncate text-foreground/80">{update.summary}</span>
          <span className="shrink-0 whitespace-nowrap">· {quiet ? 'no change' : changeCountText(update)}</span>
        </button>
      );
    }
    const openAsks = brief ? brief.asks.filter((a) => isUnresolvedAsk(a.status)) : [];
    const answeredAsks = brief ? brief.asks.filter((a) => !isUnresolvedAsk(a.status)) : [];
    const hasDetails = !quiet && (!!plainWords || !!d.timing || sections.length > 0 || counters.length > 0 || (brief?.asks.length ?? 0) > 0);
    return (
      <div className="w-full min-w-0 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs" data-project-status data-status-variant={variant} {...(quiet ? { 'data-status-compact': true } : {})}>
        {superseded ? (
          <button type="button" aria-expanded onClick={() => setExpandedOld(false)} className="w-full text-left">{header}</button>
        ) : header}
        <UpdateSummary update={update} nextStatusAt={d.timing?.nextStatusAt} quietText={quietText} />
        {hasDetails && (
          <DetailsToggle label={detailsLabel({ hasBrief: !!plainWords, hasTiming: !!d.timing, openAsks: openAsks.length, asks: brief?.asks.length ?? 0 })}>
            <div className="text-[11px] text-muted-foreground" data-status-headline>{headline}</div>
            {plainWords && (
              <div className="mt-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-2" data-project-brief>
                <div className="mb-0.5 text-[12px] font-medium text-ink-3">Summary (written by Digby)</div>
                <p className="text-[12.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{plainWords}</p>
                {brief?.next && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"><span className="font-medium text-foreground/80">Next:</span> {brief.next}</p>}
              </div>
            )}
            {d.timing && <TimingStrip timing={d.timing} generatedAt={generatedAt} />}
            {sections.length > 0 && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {sections.map((s) => (
                  <div key={s.key} className="min-w-0">
                    <div className={cn('mb-0.5 text-[12px] font-medium', s.key === 'blocked' ? 'text-warning' : 'text-muted-foreground/80')}>
                      {s.key === 'blocked' && !(typeof d.ownerItems === 'number' && d.ownerItems > 0) ? 'Blocked' : s.label}
                    </div>
                    <ul className="space-y-0.5">
                      {d[s.key].map((item, i) => (
                        <li key={i} className={cn('flex items-start gap-1.5 leading-relaxed [overflow-wrap:anywhere]', s.tone)}>
                          <span className={cn('mt-[0.45em] size-1.5 shrink-0 rounded-full', s.dot)} aria-hidden="true" />
                          <span className="min-w-0">{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {brief && brief.asks.length > 0 && (
              <AsksList open={openAsks} answered={answeredAsks} />
            )}
            {counters.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
                {counters.map((c) => (
                  <span key={c.label} className="whitespace-nowrap">
                    <span className="font-medium text-foreground/70">{c.label}</span> {c.text}
                  </span>
                ))}
              </div>
            )}
          </DetailsToggle>
        )}
      </div>
    );
  }

  if (quiet) {
    // COMPACT stub (2026-09-24): an unchanged hour asserts nothing of its own —
    // only that nothing changed, since when, and when it looks again. A
    // changed set of asks becomes a REAL card (the backend's asks fingerprint
    // is part of "unchanged"), so a stub carries no asks and renders no brief.
    // The one thing it keeps is the owner-question signal (review C12): the
    // headline's "; N item(s) waiting on you" clause as sent, and the "Needs
    // you" counter — no other counter. The "next check" is the next status
    // sweep (timing.nextStatusAt), falling back to the supervisor's next wake.
    const needsYou = counters.filter((c) => c.label === 'Needs you');
    return (
      <div className="w-full min-w-0 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs" data-project-status data-status-variant={variant} data-status-compact>
        {header}
        <div className="text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{headline}</div>
        <div className="mt-1 text-[11px] text-muted-foreground" data-status-quiet>{quietLine(quiet, d.timing?.nextStatusAt ?? d.timing?.nextCheckAt)}</div>
        {needsYou.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground" data-status-needs-you>
            {needsYou.map((c) => (
              <span key={c.label} className="whitespace-nowrap">
                <span className="font-medium text-foreground/70">{c.label}</span> {c.text}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs" data-project-status data-status-variant={variant}>
      {header}
      <div className="text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]">{headline}</div>
      {plainWords && (
        <div className="mt-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-2" data-project-brief>
          <div className="mb-0.5 text-[12px] font-medium text-ink-3">In plain words</div>
          <p className="text-[12.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{plainWords}</p>
          {brief?.next && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"><span className="font-medium text-foreground/80">Next:</span> {brief.next}</p>}
        </div>
      )}
      {d.timing && <TimingStrip timing={d.timing} generatedAt={generatedAt} />}
      {sections.length > 0 && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {sections.map((s) => (
            <div key={s.key} className="min-w-0">
              <div className={cn('mb-0.5 text-[12px] font-medium', s.key === 'blocked' ? 'text-warning' : 'text-muted-foreground/80')}>
                {/* "needs you" only when an owner question is actually open (ownerItems > 0);
                    machine blocks under that title read as an owner ask (2026-09-15). */}
                {s.key === 'blocked' && !(typeof d.ownerItems === 'number' && d.ownerItems > 0) ? 'Blocked'
                  : s.key === 'doneSince' && isSession ? 'Done since the last update'
                  : s.label}
              </div>
              <ul className="space-y-0.5">
                {d[s.key].map((item, i) => (
                  <li key={i} className={cn('flex items-start gap-1.5 leading-relaxed [overflow-wrap:anywhere]', s.tone)}>
                    <span className={cn('mt-[0.45em] size-1.5 shrink-0 rounded-full', s.dot)} aria-hidden="true" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {brief && brief.asks.length > 0 && (
        <div className="mt-2 min-w-0" data-project-brief-asks>
          <div className="mb-0.5 text-[12px] font-medium text-ink-3">You asked</div>
          <p className="mb-1 text-[10.5px] leading-snug text-muted-foreground/80" data-project-brief-asks-explainer>{ASK_EXPLAINER}</p>
          <ul className="space-y-1">
            {visibleAsks(brief.asks, 6).map((a, i) => (
              <li key={`${a.at}-${i}`} className="leading-relaxed [overflow-wrap:anywhere]" data-ask-status={a.status}>
                <span className="text-muted-foreground">{formatAskTime(a.at)}</span>
                <span className="text-muted-foreground"> — </span>
                <span className="text-foreground">“{a.text.length > 110 ? `${a.text.slice(0, 109)}…` : a.text}”</span>
                <span className="text-muted-foreground"> → </span>
                <span className={cn('font-medium', ASK_TONE[a.status])}>
                  {!isUnresolvedAsk(a.status) && <span aria-hidden="true">✓ </span>}
                  {ASK_LABEL[a.status]}
                </span>
                {a.note && <span className="text-muted-foreground">: {a.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {counters.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
          {counters.map((c) => (
            <span key={c.label} className="whitespace-nowrap">
              <span className="font-medium text-foreground/70">{c.label}</span> {c.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
