'use client';

/**
 * The FLEET side panel of the Fleet Supervisor chat (owner 2026-10-08: "… and then also a special sidebar for the
 * fleet supervisor"). The Fleet Supervisor's job is every project, so its panel is the fleet at a glance: what
 * needs the owner, counts, cost + tokens across the account (14-day strip), each project (digest status, goal
 * progress, lanes running, 7-day spend — tap to open that project's supervisor, else its page) and the sessions
 * running now. Chats open IN PLACE (ChatOpenContext). Blocks load independently; refresh every 60 s.
 */

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatOpenContext } from '@/lib/chat-open-context';
import { CHAT_DEEP_LINK } from '@/lib/session-links';
import { fleetApi, type FleetDigest, type FleetOverview } from '@/lib/api/fleet';
import { confirmationsApi } from '@/lib/api/crossmodel';
import { supervisorUsageApi, type FleetUsage } from '@/lib/api/supervisor-usage';
import { isSessionDead } from '@/lib/session-latch';
import { DailyBars, EmptyLine, PanelSection, StatTile, StatusDot, fmtTokens, fmtUsd } from './panel-ui';
import { useMinimalView } from '@/lib/view-mode';

const REFRESH_MS = 60_000;

const STATUS_LABEL: Record<string, string> = { blocked: 'Blocked', needs_attention: 'Needs attention', on_track: 'On track', idle: 'Idle' };
const STATUS_CLS: Record<string, string> = {
  blocked: 'border-warn/60 bg-warn/10 text-warn-ink',
  needs_attention: 'border-warn/60 bg-warn/10 text-warn-ink',
  on_track: 'border-success-border bg-success-soft text-success-strong',
  idle: 'border-line text-ink-3',
};

interface ProjectLine {
  projectId: string;
  name: string;
  status: string | null;
  summary: string | null;
  todosDone: number;
  todosTotal: number;
  running: number;
  usd7d: number;
  supervisorChatId: string | null;
}

export function FleetSupervisorPanel({ selfChatId }: { selfChatId?: string | null }) {
  // Minimal view (2026-10-16): no cost or token figures for a user.
  const minimal = useMinimalView();
  const openChat = useContext(ChatOpenContext);
  const open = useCallback((chatId: string) => {
    if (openChat) openChat(chatId);
    else window.location.assign(`${CHAT_DEEP_LINK}${chatId}`);
  }, [openChat]);
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [digests, setDigests] = useState<FleetDigest[] | null>(null);
  const [usage, setUsage] = useState<FleetUsage | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    const load = async () => {
      const [ov, dg, us, pd] = await Promise.allSettled([
        fleetApi.getOverview({ signal: ctl.signal }),
        fleetApi.getDigests({ signal: ctl.signal }),
        supervisorUsageApi.fleet({ signal: ctl.signal }),
        confirmationsApi.getPending({ signal: ctl.signal }),
      ]);
      if (!alive) return;
      if (ov.status === 'fulfilled') setOverview(ov.value);
      if (dg.status === 'fulfilled') setDigests(dg.value.digests);
      if (us.status === 'fulfilled') setUsage(us.value);
      if (pd.status === 'fulfilled') setPending(pd.value.length);
      setLoaded(true);
    };
    void load();
    // Honor the session latch like usePolling does (f129, 2026-10-13): a raw
    // interval with no gate kept firing 4 authed calls every 60 s on a dead
    // session, each 401 re-triggering /api/auth/refresh with the dead cookie
    // (the post-rotation invalid-signature stream). Skip ticks while latched.
    const t = setInterval(() => { if (!isSessionDead()) void load(); }, REFRESH_MS);
    return () => { alive = false; ctl.abort(); clearInterval(t); };
  }, []);

  const projects = useMemo<ProjectLine[]>(() => {
    const by = new Map<string, ProjectLine>();
    const get = (id: string, name: string): ProjectLine => {
      let p = by.get(id);
      if (!p) { p = { projectId: id, name, status: null, summary: null, todosDone: 0, todosTotal: 0, running: 0, usd7d: 0, supervisorChatId: null }; by.set(id, p); }
      return p;
    };
    for (const pr of overview?.projects ?? []) get(pr.id, pr.name).running = pr.runningCount;
    for (const d of digests ?? []) {
      if (!d.projectId) continue;
      const p = get(d.projectId, d.projectName);
      p.status = d.status;
      p.summary = d.summary ? d.summary.split(/\n|(?<=\.)\s/)[0] : null;
      for (const g of d.goalProgress ?? []) { p.todosDone += g.todosDone; p.todosTotal += g.todosTotal; }
    }
    for (const u of usage?.projects ?? []) {
      if (!u.projectId) continue;
      const p = get(u.projectId, u.name);
      p.usd7d = u.usd7d;
      p.supervisorChatId = u.supervisorChatId;
    }
    const rank: Record<string, number> = { blocked: 0, needs_attention: 1, on_track: 2, idle: 3 };
    return [...by.values()]
      .filter(p => p.status !== null || p.running > 0 || p.usd7d > 0)
      .sort((a, b) => (rank[a.status ?? 'idle'] ?? 3) - (rank[b.status ?? 'idle'] ?? 3) || b.running - a.running || b.usd7d - a.usd7d);
  }, [overview, digests, usage]);

  const running = (overview?.sessions ?? []).filter(s => s.running && s.chatId !== selfChatId);
  const projectName = (id?: string | null) => (id ? overview?.projects.find(p => p.id === id)?.name : null) ?? null;
  const c = overview?.counts;

  // h-full + overflow-y-auto on the root (owner 2026-10-20: "it's only the
  // project tab in the sidebar that won't scroll down"): the panel host mounts
  // each tab in a `flex-1 min-h-0 overflow-hidden` slot, so a tab body must be
  // its own scroll container (Schedules is) — this root was a plain column, so
  // every goal below the window edge was clipped with no way to reach it.
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-4 py-4 text-[13px]" data-supervisor-panel="fleet">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11.5px] text-ink-3">Fleet</div>
          <div className="truncate text-[15px] font-medium text-ink">All projects</div>
        </div>
        <Link href="/management" className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:border-line-2 hover:bg-hover">
          Management <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>

      {pending ? (
        <Link href="/management?tab=inbox" className="flex items-center gap-2 rounded-lg border border-warn/60 bg-warn/10 px-3 py-2 text-[13px] text-warn-ink hover:bg-warn/15" data-fleet-pending>
          <Inbox className="size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{pending} {pending === 1 ? 'decision needs' : 'decisions need'} you</span>
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <StatTile label="Running sessions" value={c ? String(c.runningSessions) : '…'} />
        <StatTile label="Projects" value={c ? String(c.projects) : '…'} />
        <StatTile label="Schedules on" value={c ? String(c.enabledSchedules) : '…'} sub={c?.totalSchedules != null ? `of ${c.totalSchedules}` : undefined} />
        <StatTile label="Queued messages" value={c ? String(c.queuedMessages) : '…'} />
      </div>

      {!minimal && (
      <PanelSection title="Cost & tokens" aside={usage ? `30 days ${fmtUsd(usage.d30.usd)}` : undefined}>
        {usage ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Today" value={fmtUsd(usage.today.usd)} sub={`${fmtTokens(usage.today.tokensIn + usage.today.tokensOut)} tok`} />
              <StatTile label="7 days" value={fmtUsd(usage.d7.usd)} sub={`${fmtTokens(usage.d7.tokensIn + usage.d7.tokensOut)} tok`} />
              <StatTile label="Tokens 7d" value={fmtTokens(usage.d7.tokensIn + usage.d7.tokensOut)} sub={`${fmtTokens(usage.d7.tokensIn)} in · ${fmtTokens(usage.d7.tokensOut)} out`} />
            </div>
            <DailyBars days={usage.daily} />
          </>
        ) : <EmptyLine>{loaded ? 'No usage recorded yet.' : 'Loading…'}</EmptyLine>}
      </PanelSection>
      )}

      <PanelSection title="Projects" aside={projects.length ? `${projects.length}` : undefined}>
        {projects.length ? (
          <ul className="flex flex-col gap-1.5">
            {projects.map(p => {
              const pct = p.todosTotal ? Math.round((p.todosDone / p.todosTotal) * 100) : 0;
              const go = () => (p.supervisorChatId ? open(p.supervisorChatId) : window.location.assign(`/projects/${p.projectId}`));
              return (
                <li key={p.projectId}>
                  <button type="button" onClick={go} className="flex w-full flex-col gap-1.5 rounded-lg border border-line bg-raised px-3 py-2 text-left hover:bg-hover" data-fleet-project={p.status ?? 'idle'}>
                    <div className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{p.name}</span>
                      {p.status ? <span className={cn('shrink-0 rounded-full border px-1.5 py-[1px] text-[10.5px]', STATUS_CLS[p.status] ?? STATUS_CLS.idle)}>{STATUS_LABEL[p.status] ?? p.status}</span> : null}
                    </div>
                    {p.summary ? <div className="line-clamp-2 text-[12px] leading-snug text-ink-3">{p.summary}</div> : null}
                    <div className="flex w-full items-center gap-2 text-[11.5px] tabular-nums text-ink-3">
                      {p.todosTotal ? (
                        <span className="flex min-w-0 flex-1 items-center gap-1.5">
                          <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-success" style={{ width: `${pct}%` }} /></span>
                          {p.todosDone}/{p.todosTotal}
                        </span>
                      ) : <span className="flex-1" />}
                      {p.running ? <span className="inline-flex items-center gap-1"><StatusDot tone="running" />{p.running}</span> : null}
                      {!minimal && <span>{fmtUsd(p.usd7d)} 7d</span>}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : <EmptyLine>{loaded ? 'No active projects.' : 'Loading…'}</EmptyLine>}
      </PanelSection>

      <PanelSection title="Running now" aside={running.length ? `${running.length}` : undefined}>
        {running.length ? (
          <ul className="flex flex-col gap-0.5">
            {running.map(s => (
              <li key={s.chatId}>
                <button type="button" onClick={() => open(s.chatId)} className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-hover" data-fleet-running>
                  <StatusDot tone="running" />
                  <span className="min-w-0 flex-1 truncate text-ink-2">{s.title}</span>
                  {projectName(s.projectId) ? <span className="max-w-[40%] shrink-0 truncate text-ink-3">{projectName(s.projectId)}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : <EmptyLine>{loaded ? 'Nothing running right now.' : 'Loading…'}</EmptyLine>}
      </PanelSection>
    </div>
  );
}

export default FleetSupervisorPanel;
