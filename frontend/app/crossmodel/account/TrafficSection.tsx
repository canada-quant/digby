'use client';

/**
 * Account → Admin → Users & traffic (owner 2026-10-07: "i need a way to see activity on users/api cost/ ip addressed
 * or unique hash for users that use digby from what traffic source ie google ads facebook and the user flow").
 *
 * Lives in the Account → Admin tab — the admin surface admins actually use (it already carries Users and API Costs);
 * the legacy /dashboard/analytics page is the pre-Digby admin dashboard and reads only the old raw-IP events table.
 *
 * Three views over the first-party visitor analytics (lib/api/traffic.ts):
 *  - Sources: per channel (paid ads first — Google Ads and Facebook Ads each on their own row) and per campaign —
 *    visitors, guest chatters, signups, activated, retained D7, API cost, cost per signup; the per-channel funnel
 *    (landed → signed up → first chat → D7 active); top pages + landing pages; spend buckets.
 *  - Users: one server-side sorted / searched / paginated table of signed-in users AND anonymous visitors.
 *  - Flow: one user's or visitor's timeline (landing with source → pages → signup → first chat → chats → coding).
 * Never a raw IP — an 8-char prefix of an HMAC hash. Digby Kids accounts never appear.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Globe, Loader2, Search, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ScrollableTabBar } from '@/components/ui/scrollable-tab-bar';
import { absoluteDate, relativeTime } from '@/lib/relative-time';
import {
  trafficApi,
  type TrafficFlow,
  type TrafficSources,
  type TrafficUserRow,
  type TrafficUserSort,
  type TrafficUsersPage,
  type TrafficUsersQuery,
} from '@/lib/api/traffic';
import { costPerSignup, deviceLabel, flowItemText, fmtUsd, nextSort, pageCount, pct, rangeForDays, SPEND_KIND_LABELS } from '@/lib/traffic-format';

type View = 'sources' | 'users' | 'flow';
export type FlowSubject = { userId: string } | { visitorId: string };

const PRESETS = [7, 30, 90] as const;
const PAGE_SIZE = 25;

// ── presentational pieces (exported for the vitest render tests) ────────────

function Num({ n }: { n: number }) {
  return <span className="tabular-nums">{n.toLocaleString()}</span>;
}

export function SourcesView({ data }: { data: TrafficSources }) {
  const paid = data.channels.filter((c) => c.paid);
  const other = data.channels.filter((c) => !c.paid);
  const t = data.totals;
  const maxLanded = Math.max(1, ...data.funnel.map((f) => f.landed));
  const channelRows = (rows: TrafficSources['channels']) => rows.map((c) => (
    <tr key={c.channel} className="border-t" data-testid={`channel-row-${c.channel}`}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{c.label}</span>
          {c.paid && <Badge variant="outline" className="rounded-full px-1.5 py-0 text-[9px]">Paid</Badge>}
        </div>
      </td>
      <td className="px-3 py-2 text-right"><Num n={c.visitors} /></td>
      <td className="px-3 py-2 text-right"><Num n={c.guestChatters} /></td>
      <td className="px-3 py-2 text-right"><Num n={c.signups} /></td>
      <td className="px-3 py-2 text-right"><Num n={c.activated} /> <span className="text-[10px] text-muted-foreground">{pct(c.activated, c.signups)}</span></td>
      <td className="px-3 py-2 text-right"><Num n={c.retainedD7} /><span className="text-[10px] text-muted-foreground">/{c.d7Eligible}</span></td>
      <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(c.costUsd)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{costPerSignup(c.costUsd, c.signups)}</td>
    </tr>
  ));
  const head = (
    <thead>
      <tr className="bg-muted/50 text-xs text-muted-foreground">
        <th className="text-left px-3 py-2 font-medium">Channel</th>
        <th className="text-right px-3 py-2 font-medium" title="Visitors first seen in the range">Visitors</th>
        <th className="text-right px-3 py-2 font-medium" title="Visitors who chatted without an account">Guest chats</th>
        <th className="text-right px-3 py-2 font-medium" title="Accounts created in the range (by their first-touch source)">Signups</th>
        <th className="text-right px-3 py-2 font-medium" title="Of those signups, sent at least one chat message">Activated</th>
        <th className="text-right px-3 py-2 font-medium" title="Came back 7+ days after signing up / signups at least 7 days old">Retained D7</th>
        <th className="text-right px-3 py-2 font-medium" title="Recorded API spend in the range">API cost</th>
        <th className="text-right px-3 py-2 font-medium">Cost / signup</th>
      </tr>
    </thead>
  );
  return (
    <div className="space-y-6" data-testid="traffic-sources">
      {!data.captureEnabled && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-testid="capture-off">
          Visitor capture is switched off on the server (VISITOR_ANALYTICS_DISABLED=1) — nothing new is being recorded.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Visitors', value: t.visitors.toLocaleString() },
          { label: 'Signups', value: t.signups.toLocaleString() },
          { label: 'Activated', value: `${t.activated.toLocaleString()} (${pct(t.activated, t.signups)})` },
          { label: 'Retained D7', value: `${t.retainedD7}/${t.d7Eligible}` },
          { label: 'API cost', value: fmtUsd(t.costUsd) },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border bg-card p-3 text-center">
            <div className="text-lg font-bold tabular-nums">{s.value}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">By channel <span className="text-xs font-normal text-muted-foreground">(first-touch source)</span></h3>
        <div className="rounded-md border overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            {head}
            <tbody>
              {paid.length > 0 && <tr className="bg-muted/30"><td colSpan={8} className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Paid ads</td></tr>}
              {channelRows(paid)}
              {other.length > 0 && <tr className="bg-muted/30 border-t"><td colSpan={8} className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Organic, referral & other</td></tr>}
              {channelRows(other)}
              {!data.channels.length && <tr><td colSpan={8} className="px-3 py-6 text-center text-xs text-muted-foreground">No traffic recorded in this range yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">&ldquo;Unknown&rdquo; = accounts with no visitor record (signed up before capture shipped, or blocked it). &ldquo;Unattributed&rdquo; cost = guests without a visitor id, chatless turns, decision-gate calls with no chat, Digby Kids and deleted chats.</p>
      </div>

      {data.campaigns.length > 0 && (
        <div className="space-y-2" data-testid="traffic-campaigns">
          <h3 className="text-sm font-semibold">By campaign <span className="text-xs font-normal text-muted-foreground">(utm_campaign)</span></h3>
          <div className="rounded-md border overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-xs text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium">Campaign</th>
                  <th className="text-left px-3 py-2 font-medium">Channel</th>
                  <th className="text-right px-3 py-2 font-medium">Visitors</th>
                  <th className="text-right px-3 py-2 font-medium">Signups</th>
                  <th className="text-right px-3 py-2 font-medium">Activated</th>
                  <th className="text-right px-3 py-2 font-medium">Retained D7</th>
                  <th className="text-right px-3 py-2 font-medium">API cost</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={`${c.channel}:${c.campaign}`} className="border-t">
                    <td className="px-3 py-2 font-mono text-xs">{c.campaign}</td>
                    <td className="px-3 py-2 text-xs">{c.label}</td>
                    <td className="px-3 py-2 text-right"><Num n={c.visitors} /></td>
                    <td className="px-3 py-2 text-right"><Num n={c.signups} /></td>
                    <td className="px-3 py-2 text-right"><Num n={c.activated} /></td>
                    <td className="px-3 py-2 text-right"><Num n={c.retainedD7} /><span className="text-[10px] text-muted-foreground">/{c.d7Eligible}</span></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(c.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="space-y-2" data-testid="traffic-funnel">
        <h3 className="text-sm font-semibold">Funnel by channel <span className="text-xs font-normal text-muted-foreground">(visitors first seen in the range)</span></h3>
        {data.funnel.length === 0 && <p className="text-xs text-muted-foreground">No landings in this range.</p>}
        <div className="space-y-3">
          {data.funnel.map((f) => (
            <div key={f.channel} className="space-y-1">
              <div className="text-xs font-medium">{f.label}{f.guestChatted > 0 && <span className="ml-2 font-normal text-muted-foreground">{f.guestChatted} chatted as a guest</span>}</div>
              {[
                { label: 'Landed', n: f.landed },
                { label: 'Signed up', n: f.signedUp },
                { label: 'First chat', n: f.firstChat },
                { label: 'Active D7', n: f.d7Active },
              ].map((s) => (
                <div key={s.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 text-muted-foreground">{s.label}</span>
                  <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-brand-accent" style={{ width: `${Math.min(100, (s.n / maxLanded) * 100)}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right tabular-nums">{s.n.toLocaleString()} <span className="text-muted-foreground">{s.label === 'Landed' ? '' : pct(s.n, f.landed)}</span></span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2" data-testid="traffic-paths">
          <h3 className="text-sm font-semibold">Top pages</h3>
          <ul className="rounded-md border divide-y text-xs">
            {data.topPaths.map((p) => (
              <li key={p.path} className="flex items-center justify-between px-3 py-1.5">
                <span className="font-mono truncate">{p.path}</span>
                <span className="tabular-nums text-muted-foreground shrink-0 ml-2">{p.views.toLocaleString()} views · {p.visitors.toLocaleString()} visitors</span>
              </li>
            ))}
            {!data.topPaths.length && <li className="px-3 py-2 text-muted-foreground">No page views yet.</li>}
          </ul>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Landing pages</h3>
          <ul className="rounded-md border divide-y text-xs">
            {data.topLandings.map((p) => (
              <li key={p.path} className="flex items-center justify-between px-3 py-1.5">
                <span className="font-mono truncate">{p.path}</span>
                <span className="tabular-nums text-muted-foreground shrink-0 ml-2">{p.visitors.toLocaleString()} visitors</span>
              </li>
            ))}
            {!data.topLandings.length && <li className="px-3 py-2 text-muted-foreground">No landings yet.</li>}
          </ul>
          {data.spendByKind.length > 0 && (
            <div className="rounded-md border p-3 text-xs space-y-1">
              <div className="font-medium">API cost by payer</div>
              {data.spendByKind.map((s) => (
                <div key={s.kind} className="flex justify-between"><span className="text-muted-foreground">{SPEND_KIND_LABELS[s.kind] ?? s.kind}</span><span className="tabular-nums">{fmtUsd(s.usd)}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const USER_COLUMNS: Array<{ key: TrafficUserSort; label: string; align?: 'right' }> = [
  { key: 'label', label: 'User' },
  { key: 'channel', label: 'Source' },
  { key: 'signedUp', label: 'Signed up' },
  { key: 'lastActive', label: 'Last active' },
  { key: 'msgs7', label: 'Chats / msgs 7d', align: 'right' },
  { key: 'msgs30', label: 'Chats / msgs 30d', align: 'right' },
  { key: 'cost7', label: 'Cost 7d', align: 'right' },
  { key: 'cost30', label: 'Cost 30d', align: 'right' },
  { key: 'costAll', label: 'Cost all', align: 'right' },
];

export function UsersTable({ page, onSort, onOpen }: { page: TrafficUsersPage; onSort: (s: TrafficUserSort) => void; onOpen: (row: TrafficUserRow) => void }) {
  return (
    <div className="rounded-md border overflow-hidden overflow-x-auto" data-testid="traffic-users">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted/50 text-xs text-muted-foreground">
            {USER_COLUMNS.map((c) => (
              <th key={c.key} className={cn('px-3 py-2 font-medium', c.align === 'right' ? 'text-right' : 'text-left')}>
                <button type="button" onClick={() => onSort(c.key)} className="inline-flex items-center gap-0.5 hover:text-foreground" data-testid={`sort-${c.key}`}>
                  {c.label}
                  {page.sort === c.key && (page.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                </button>
              </th>
            ))}
            <th className="text-left px-3 py-2 font-medium">IP hash</th>
            <th className="text-left px-3 py-2 font-medium">Device</th>
          </tr>
        </thead>
        <tbody>
          {page.rows.map((r) => (
            <tr key={`${r.kind}:${r.id}`} className="border-t hover:bg-hover cursor-pointer" onClick={() => onOpen(r)} data-testid={`user-row-${r.id}`}>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {r.kind === 'user' ? <UserRound className="size-3 text-ink-3 shrink-0" /> : <Globe className="size-3 text-ink-3 shrink-0" />}
                  <span className={cn('truncate max-w-[220px]', r.kind === 'visitor' && 'font-mono text-xs')}>{r.label}</span>
                </div>
              </td>
              <td className="px-3 py-2 text-xs">
                <div>{r.channelLabel}</div>
                {r.campaign && <div className="font-mono text-[10px] text-muted-foreground truncate max-w-[160px]">{r.campaign}</div>}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.signedUpAt ? absoluteDate(r.signedUpAt) : '—'}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{r.lastActiveAt ? relativeTime(r.lastActiveAt) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{r.chats7} / {r.msgs7}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{r.chats30} / {r.msgs30}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{fmtUsd(r.cost7)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{fmtUsd(r.cost30)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">{fmtUsd(r.costAll)}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{r.ipHash ?? '—'}</td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{deviceLabel(r.device)}</td>
            </tr>
          ))}
          {!page.rows.length && <tr><td colSpan={11} className="px-3 py-6 text-center text-xs text-muted-foreground">No users or visitors match.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function FlowView({ flow, onOpenUser }: { flow: TrafficFlow; onOpenUser?: (userId: string) => void }) {
  const a = flow.attribution;
  return (
    <div className="space-y-4" data-testid="traffic-flow">
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {flow.subject.kind === 'user' ? <UserRound className="size-4 text-ink-2" /> : <Globe className="size-4 text-ink-2" />}
          <span className={cn('font-semibold', flow.subject.kind === 'visitor' && 'font-mono')}>{flow.subject.label}</span>
          {a && <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-[10px]">{a.channelLabel}{a.campaign ? ` · ${a.campaign}` : ''}</Badge>}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {flow.subject.signedUpAt && <span>Signed up {absoluteDate(flow.subject.signedUpAt)}</span>}
          <span>API cost: 24h {fmtUsd(flow.cost.cost1)} · 7d {fmtUsd(flow.cost.cost7)} · 30d {fmtUsd(flow.cost.cost30)} · all {fmtUsd(flow.cost.costAll)}</span>
        </div>
        {flow.subject.linkedUserIds && flow.subject.linkedUserIds.length > 0 && onOpenUser && (
          <div className="text-xs">This visitor later signed in as{' '}
            {flow.subject.linkedUserIds.map((id) => (
              <button key={id} type="button" className="underline mr-2" onClick={() => onOpenUser(id)}>user {id.slice(0, 8)}</button>
            ))}
          </div>
        )}
        {flow.visitors.length > 0 && (
          <div className="text-[11px] text-muted-foreground space-y-0.5">
            {flow.visitors.map((v) => (
              <div key={v.id}>Browser <span className="font-mono">{v.ipHash ?? v.id.slice(0, 8)}</span> · {deviceLabel(v.device)} · first seen {v.firstSeen ? absoluteDate(v.firstSeen) : '—'} via {v.channelLabel}{v.isBot ? ' · suspected automation' : ''}</div>
            ))}
          </div>
        )}
      </div>
      <ol className="relative border-l pl-4 space-y-2" data-testid="flow-items">
        {flow.items.map((it, i) => (
          <li key={`${it.at}:${i}`} className="text-xs">
            <span className="absolute -left-1 mt-1.5 size-2 rounded-full bg-brand-accent" />
            <span className="text-muted-foreground tabular-nums mr-2">{new Date(it.at).toISOString().slice(0, 16).replace('T', ' ')}</span>
            <span className={cn(it.kind === 'landing' || it.kind === 'signup' || it.kind === 'first_chat' ? 'font-medium' : '')}>{flowItemText(it)}</span>
            {it.path && <span className="ml-2 font-mono text-[10px] text-muted-foreground">{it.path}</span>}
          </li>
        ))}
        {!flow.items.length && <li className="text-xs text-muted-foreground">No activity recorded.</li>}
      </ol>
      {flow.truncated && <p className="text-[11px] text-muted-foreground">Showing the newest 500 events.</p>}
    </div>
  );
}

// ── the container ────────────────────────────────────────────────────────────

export function TrafficSection() {
  const [view, setView] = useState<View>('sources');
  const [range, setRange] = useState(() => rangeForDays(30));
  const [sources, setSources] = useState<TrafficSources | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [query, setQuery] = useState<TrafficUsersQuery>({ sort: 'lastActive', dir: 'desc', page: 1, pageSize: PAGE_SIZE, kind: 'all' });
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<TrafficUsersPage | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [subject, setSubject] = useState<FlowSubject | null>(null);
  const [flow, setFlow] = useState<TrafficFlow | null>(null);
  const [flowLoading, setFlowLoading] = useState(false);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    try { setSources(await trafficApi.sources(range.from, range.to)); }
    catch { toast.error('Failed to load traffic sources'); }
    finally { setSourcesLoading(false); }
  }, [range]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try { setUsers(await trafficApi.users(query)); }
    catch { toast.error('Failed to load users'); }
    finally { setUsersLoading(false); }
  }, [query]);

  useEffect(() => { if (view === 'sources') void loadSources(); }, [view, loadSources]);
  useEffect(() => { if (view === 'users') void loadUsers(); }, [view, loadUsers]);
  useEffect(() => {
    if (view !== 'flow' || !subject) return;
    let cancelled = false;
    setFlowLoading(true);
    trafficApi.flow(subject)
      .then((f) => { if (!cancelled) setFlow(f); })
      .catch(() => { if (!cancelled) { setFlow(null); toast.error('Failed to load user flow'); } })
      .finally(() => { if (!cancelled) setFlowLoading(false); });
    return () => { cancelled = true; };
  }, [view, subject]);

  const openRow = (r: TrafficUserRow) => {
    setSubject(r.kind === 'user' ? { userId: r.id } : { visitorId: r.id });
    setView('flow');
  };

  const tabs = [
    { id: 'sources' as const, label: 'Sources' },
    { id: 'users' as const, label: 'Users' },
    { id: 'flow' as const, label: 'User flow', disabled: !subject },
  ];
  const pages = users ? pageCount(users.total, users.pageSize) : 1;

  return (
    <div className="space-y-4" data-testid="traffic-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ScrollableTabBar ariaLabel="Users and traffic views" size="sm" value={view} onChange={setView} tabs={tabs} />
        {view === 'sources' && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {PRESETS.map((d) => {
              const r = rangeForDays(d);
              const active = r.from === range.from && r.to === range.to;
              return (
                <button key={d} type="button" onClick={() => setRange(r)}
                  className={cn('rounded-md px-2.5 py-1 font-medium transition-colors', active ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                  {d}d
                </button>
              );
            })}
            <input type="date" aria-label="From" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} className="rounded-md border bg-transparent px-1.5 py-0.5" />
            <span className="text-muted-foreground">to</span>
            <input type="date" aria-label="To" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} className="rounded-md border bg-transparent px-1.5 py-0.5" />
          </div>
        )}
      </div>

      {view === 'sources' && (
        sourcesLoading && !sources
          ? <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>
          : sources ? <SourcesView data={sources} /> : null
      )}

      {view === 'users' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <form className="relative flex-1 min-w-[200px]" onSubmit={(e) => { e.preventDefault(); setQuery((q) => ({ ...q, q: search.trim() || undefined, page: 1 })); }}>
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search email, visitor hash, campaign, channel…" aria-label="Search users"
                className="w-full rounded-md border bg-transparent pl-7 pr-2 py-1.5 text-sm" />
            </form>
            <select aria-label="Show" value={query.kind ?? 'all'} onChange={(e) => setQuery((q) => ({ ...q, kind: e.target.value as TrafficUsersQuery['kind'], page: 1 }))}
              className="rounded-md border bg-transparent px-2 py-1.5 text-xs">
              <option value="all">Users + visitors</option>
              <option value="users">Signed-in users</option>
              <option value="visitors">Anonymous visitors</option>
            </select>
            {usersLoading && <Loader2 className="size-4 animate-spin text-brand-accent" />}
          </div>
          {users && (
            <>
              <UsersTable page={users} onOpen={openRow}
                onSort={(key) => setQuery((q) => ({ ...q, ...nextSort((q.sort ?? 'lastActive') as TrafficUserSort, q.dir ?? 'desc', key), page: 1 }))} />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{users.total.toLocaleString()} total</span>
                <div className="flex items-center gap-2">
                  <button type="button" aria-label="Previous page" disabled={users.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: Math.max(1, (q.page ?? 1) - 1) }))}
                    className="rounded-md border p-1 disabled:opacity-40"><ChevronLeft className="size-3.5" /></button>
                  <span>Page {users.page} of {pages}</span>
                  <button type="button" aria-label="Next page" disabled={users.page >= pages} onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 1) + 1 }))}
                    className="rounded-md border p-1 disabled:opacity-40"><ChevronRight className="size-3.5" /></button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {view === 'flow' && (
        flowLoading
          ? <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>
          : flow ? <FlowView flow={flow} onOpenUser={(id) => setSubject({ userId: id })} />
            : <p className="text-xs text-muted-foreground">Pick a row in Users to see its flow.</p>
      )}
    </div>
  );
}

export default TrafficSection;
