'use client';

/**
 * The PROJECT side panel of a project supervisor chat (owner 2026-10-08: "project supervisor chats on the sidebar
 * dont show the projects overview and schedules and everything goals sessions working on todos cost and token usage
 * project wide etc … build out a special sidebar specifically for project supervisors").
 *
 * One scroll, top to bottom: the project's pulse (summary + goal chips), usage (today / 7 days / tokens + a 14-day
 * strip + the chats that spent most), goals with their todos and who is on each, the sessions working now, the
 * schedules that wake this project, and a link to the project page. Every session / lane opens IN PLACE through
 * ChatOpenContext. Each block loads on its own (one failing endpoint never blanks the panel) and refreshes every
 * 60 s while the panel is open.
 */

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleDot, CircleSlash, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatOpenContext } from '@/lib/chat-open-context';
import { CHAT_DEEP_LINK } from '@/lib/session-links';
import { fleetApi as platformApi, type FleetGoal, type FleetTodo } from '@/lib/api/platform';
import { fleetApi } from '@/lib/api/fleet';
import { projectsApi, type ProjectSessionRow } from '@/lib/api/crossmodel';
import { supervisorUsageApi, type ProjectUsage } from '@/lib/api/supervisor-usage';
import { isSessionDead } from '@/lib/session-latch';
import { SessionProjectPulse } from '../ProjectPulse';
import { DailyBars, EmptyLine, PanelSection, StatTile, StatusDot, fmtAgeSec, fmtCadence, fmtTokens, fmtUntil, fmtUsd } from './panel-ui';
import { useMinimalView } from '@/lib/view-mode';

const REFRESH_MS = 60_000;

interface ScheduleRow { id: string; chatId: string; chatTitle: string | null; kind: 'once' | 'recurring'; intervalSec: number | null; nextRunAt: string | null; enabled: boolean }

interface ProjectData {
  name: string | null;
  goals: FleetGoal[] | null;
  todos: FleetTodo[] | null;
  sessions: ProjectSessionRow[] | null;
  usage: ProjectUsage | null;
  schedules: ScheduleRow[] | null;
}

function useOpenChat() {
  const openChat = useContext(ChatOpenContext);
  return useCallback((chatId: string) => {
    if (openChat) openChat(chatId);
    else window.location.assign(`${CHAT_DEEP_LINK}${chatId}`);
  }, [openChat]);
}

function TodoIcon({ status }: { status: FleetTodo['status'] }) {
  const cls = 'size-3.5 shrink-0';
  if (status === 'done') return <CircleCheck className={cn(cls, 'text-success')} aria-label="Done" />;
  if (status === 'in_progress') return <CircleDot className={cn(cls, 'text-ink')} aria-label="In progress" />;
  if (status === 'blocked') return <CircleSlash className={cn(cls, 'text-warn-ink')} aria-label="Blocked" />;
  return <CircleDashed className={cn(cls, 'text-ink-3')} aria-label="Pending" />;
}

const GOAL_ORDER: Record<string, number> = { active: 0, blocked: 1, done: 2, archived: 3 };

function GoalRow({ goal, todos, laneTitle, onOpen }: {
  goal: FleetGoal;
  todos: FleetTodo[];
  laneTitle: (chatId: string) => string | null;
  onOpen: (chatId: string) => void;
}) {
  const [open, setOpen] = useState(goal.status === 'active' || goal.status === 'blocked');
  const done = todos.filter(t => t.status === 'done').length;
  const total = todos.length;
  const pct = total ? Math.round((done / total) * 100) : goal.status === 'done' ? 100 : 0;
  return (
    <div className="rounded-lg border border-line bg-raised" data-goal-row={goal.status}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover rounded-lg">
        {open ? <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className={cn('min-w-0 text-[13px] leading-snug text-ink [overflow-wrap:anywhere]', goal.status === 'done' && 'text-ink-3 line-through decoration-line-2')}>{goal.title}</span>
            <span className="shrink-0 text-[11.5px] tabular-nums text-ink-3">{total ? `${done}/${total}` : goal.status}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
            <div className={cn('h-full rounded-full', goal.status === 'blocked' ? 'bg-warn' : 'bg-success')} style={{ width: `${pct}%` }} />
          </div>
          {goal.status === 'blocked' && goal.blockedReason ? <div className="mt-1 text-[11.5px] text-warn-ink [overflow-wrap:anywhere]">Blocked: {goal.blockedReason}</div> : null}
        </div>
      </button>
      {open && todos.length > 0 ? (
        <ul className="border-t border-line px-3 py-1.5" data-goal-todos>
          {todos.map(t => {
            const lane = t.assigneeChatId ? laneTitle(t.assigneeChatId) : null;
            return (
              <li key={t.id} className="flex items-start gap-2 py-1 text-[12.5px]">
                <TodoIcon status={t.status} />
                <span className={cn('min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]', t.status === 'done' ? 'text-ink-3' : 'text-ink-2')}>{t.title}</span>
                {t.assigneeChatId ? (
                  <button
                    type="button"
                    onClick={() => onOpen(t.assigneeChatId!)}
                    title={lane ? `Open ${lane}` : 'Open the session working on this'}
                    className="max-w-[45%] shrink-0 truncate rounded-md border border-line px-1.5 py-[1px] text-[11px] text-ink-3 hover:bg-hover hover:text-ink"
                    data-todo-lane
                  >
                    {lane || t.assigneeChatId.slice(0, 8)}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function ProjectSupervisorPanel({ projectId, selfChatId }: { projectId: string; selfChatId?: string | null }) {
  // Minimal view (2026-10-16): no cost or token figures for a user.
  const minimal = useMinimalView();
  const open = useOpenChat();
  const [data, setData] = useState<ProjectData>({ name: null, goals: null, todos: null, sessions: null, usage: null, schedules: null });
  const [loaded, setLoaded] = useState(false);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    const load = async () => {
      const [proj, goals, todos, sessions, usage, overview] = await Promise.allSettled([
        projectsApi.get(projectId, { signal: ctl.signal }),
        platformApi.listGoals(projectId, { signal: ctl.signal }),
        platformApi.listTodos({ projectId }),
        projectsApi.sessions(projectId),
        supervisorUsageApi.project(projectId, { signal: ctl.signal }),
        fleetApi.getOverview({ signal: ctl.signal }),
      ]);
      if (!alive) return;
      const sessionRows = sessions.status === 'fulfilled' ? sessions.value.sessions : null;
      const chatIds = new Set([...(sessionRows ?? []).map(s => s.chatId), ...(selfChatId ? [selfChatId] : [])]);
      setData({
        name: proj.status === 'fulfilled' ? proj.value.name : null,
        goals: goals.status === 'fulfilled' ? goals.value : null,
        todos: todos.status === 'fulfilled' ? todos.value : null,
        sessions: sessionRows,
        usage: usage.status === 'fulfilled' ? usage.value : null,
        schedules: overview.status === 'fulfilled' ? overview.value.schedules.filter(s => chatIds.has(s.chatId)) : null,
      });
      setLoaded(true);
    };
    void load();
    // Honor the session latch like usePolling does (f129, 2026-10-13): a raw
    // interval with no gate kept firing 6 authed calls every 60 s on a dead
    // session, each 401 re-triggering /api/auth/refresh with the dead cookie
    // (the post-rotation invalid-signature stream). Skip ticks while latched.
    const t = setInterval(() => { if (!isSessionDead()) void load(); }, REFRESH_MS);
    return () => { alive = false; ctl.abort(); clearInterval(t); };
  }, [projectId, selfChatId]);

  const titleBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of data.sessions ?? []) m.set(s.chatId, s.title);
    for (const c of data.usage?.topChats ?? []) if (c.title && !m.has(c.chatId)) m.set(c.chatId, c.title);
    return m;
  }, [data.sessions, data.usage]);
  const laneTitle = useCallback((id: string) => titleBy.get(id) ?? null, [titleBy]);

  const goals = useMemo(() => [...(data.goals ?? [])].filter(g => g.status !== 'archived').sort((a, b) => (GOAL_ORDER[a.status] ?? 9) - (GOAL_ORDER[b.status] ?? 9)), [data.goals]);
  const openGoals = goals.filter(g => g.status !== 'done');
  const doneGoals = goals.filter(g => g.status === 'done');
  const todosByGoal = useMemo(() => {
    const m = new Map<string, FleetTodo[]>();
    for (const t of data.todos ?? []) { const l = m.get(t.goalId) ?? []; l.push(t); m.set(t.goalId, l); }
    const rank: Record<string, number> = { in_progress: 0, blocked: 1, pending: 2, done: 3 };
    for (const l of m.values()) l.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    return m;
  }, [data.todos]);
  const working = (data.sessions ?? []).filter(s => s.chatId !== selfChatId && (s.status === 'running' || s.status === 'scheduled'));
  const idleCount = (data.sessions ?? []).filter(s => s.chatId !== selfChatId && s.status === 'idle').length;
  const u = data.usage;

  // h-full + overflow-y-auto on the root (owner 2026-10-20: "it's only the
  // project tab in the sidebar that won't scroll down"): the panel host mounts
  // each tab in a `flex-1 min-h-0 overflow-hidden` slot, so a tab body must be
  // its own scroll container (Schedules is) — this root was a plain column, so
  // every goal below the window edge was clipped with no way to reach it.
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-4 py-4 text-[13px]" data-supervisor-panel="project">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11.5px] text-ink-3">Project</div>
          <div className="truncate text-[15px] font-medium text-ink">{data.name ?? (loaded ? 'Project' : '…')}</div>
        </div>
        <a href={`/projects/${projectId}`} className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:border-line-2 hover:bg-hover">
          Project page <ArrowUpRight className="size-3" aria-hidden />
        </a>
      </div>

      <SessionProjectPulse projectId={projectId} />

      {!minimal && (
      <PanelSection title="Cost & tokens" aside={u ? `30 days ${fmtUsd(u.d30.usd)}` : undefined}>
        {u ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Today" value={fmtUsd(u.today.usd)} sub={`${fmtTokens(u.today.tokensIn + u.today.tokensOut)} tok`} />
              <StatTile label="7 days" value={fmtUsd(u.d7.usd)} sub={`${fmtTokens(u.d7.tokensIn + u.d7.tokensOut)} tok`} />
              <StatTile label="Tokens 7d" value={fmtTokens(u.d7.tokensIn + u.d7.tokensOut)} sub={`${fmtTokens(u.d7.tokensIn)} in · ${fmtTokens(u.d7.tokensOut)} out`} />
            </div>
            <DailyBars days={u.daily} />
            {u.topChats.length ? (
              <ul className="flex flex-col" data-usage-top>
                {u.topChats.map(c => (
                  <li key={c.chatId}>
                    <button type="button" onClick={() => open(c.chatId)} className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-hover">
                      <span className="min-w-0 truncate text-ink-2">{c.title || c.chatId.slice(0, 8)}</span>
                      <span className="shrink-0 tabular-nums text-ink-3">{fmtUsd(c.usd7d)} · {fmtTokens(c.tokens7d)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : <EmptyLine>{loaded ? 'No usage recorded yet.' : 'Loading…'}</EmptyLine>}
      </PanelSection>
      )}

      <PanelSection title="Goals" aside={goals.length ? `${openGoals.length} open` : undefined}>
        {openGoals.length ? openGoals.map(g => (
          <GoalRow key={g.id} goal={g} todos={todosByGoal.get(g.id) ?? []} laneTitle={laneTitle} onOpen={open} />
        )) : <EmptyLine>{loaded ? (data.goals == null ? 'Goals could not be loaded.' : 'No open goals.') : 'Loading…'}</EmptyLine>}
        {doneGoals.length ? (
          <button type="button" onClick={() => setShowDone(s => !s)} className="self-start text-[12px] text-ink-3 hover:text-ink">
            {showDone ? 'Hide' : 'Show'} {doneGoals.length} done
          </button>
        ) : null}
        {showDone ? doneGoals.map(g => <GoalRow key={g.id} goal={g} todos={todosByGoal.get(g.id) ?? []} laneTitle={laneTitle} onOpen={open} />) : null}
      </PanelSection>

      <PanelSection title="Working now" aside={idleCount ? `${idleCount} idle` : undefined}>
        {working.length ? (
          <ul className="flex flex-col gap-1">
            {working.map(s => (
              <li key={s.chatId}>
                <button type="button" onClick={() => open(s.chatId)} className="flex w-full items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-left hover:bg-hover" data-working-session={s.status}>
                  <StatusDot tone={s.status === 'running' ? 'running' : 'scheduled'} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">{s.title}</div>
                    <div className="truncate text-[11.5px] text-ink-3">
                      {s.status === 'running' ? 'Running' : 'Scheduled'}
                      {!minimal && fmtAgeSec(s.lastReceiptAgeSec) ? ` · last action ${fmtAgeSec(s.lastReceiptAgeSec)}` : ''}
                      {!minimal && s.spendTodayUsd ? ` · ${fmtUsd(s.spendTodayUsd)} today` : ''}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : <EmptyLine>{loaded ? 'Nothing running right now.' : 'Loading…'}</EmptyLine>}
      </PanelSection>

      <PanelSection title="Schedules" aside={data.schedules?.length ? `${data.schedules.filter(s => s.enabled).length} on` : undefined}>
        {data.schedules?.length ? (
          <ul className="flex flex-col gap-1">
            {data.schedules.map(s => (
              <li key={s.id}>
                <button type="button" onClick={() => open(s.chatId)} className={cn('flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-hover', !s.enabled && 'opacity-60')}>
                  {s.enabled ? <StatusDot tone="scheduled" /> : <PauseCircle className="size-3 shrink-0 text-ink-3" aria-label="Paused" />}
                  <span className="min-w-0 flex-1 truncate text-ink-2">{s.chatTitle || titleBy.get(s.chatId) || s.chatId.slice(0, 8)}</span>
                  <span className="shrink-0 tabular-nums text-ink-3">{fmtCadence(s.kind, s.intervalSec)}{s.enabled && fmtUntil(s.nextRunAt) ? ` · ${fmtUntil(s.nextRunAt)}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <EmptyLine>{loaded ? 'No schedules in this project.' : 'Loading…'}</EmptyLine>}
      </PanelSection>
    </div>
  );
}

export default ProjectSupervisorPanel;
