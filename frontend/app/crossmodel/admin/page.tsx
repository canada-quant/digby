'use client';

import { useState, useEffect, useCallback } from 'react';
import { absoluteDate } from '@/lib/relative-time';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import {
  Users,
  MessageSquare,
  Settings,
  ExternalLink,
  RefreshCw,
  ChevronLeft,
  Save,
  Loader2,
  Microscope,
  Bug,
  Lightbulb,
  MessageCircle,
  AlertTriangle,
  Sparkles,
  TrendingUp,
  BarChart2,
  AlertCircle,
  CheckCircle2,
  Clock,
  Calendar,
  PartyPopper,
} from 'lucide-react';

/** ADMIN role, or the owner e-mail (production convenience; a self-host admin has the role). Used by BOTH gates below. */
const isAdminUser = (u: { role?: string; email?: string | null } | null | undefined): boolean =>
  u?.role === 'ADMIN' || (u?.email ?? '').toLowerCase() === 'example-user@example.com';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

function apiGet(path: string, token: string) {
  return fetch(`${API}/crossmodel${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(r => r.json());
}

function apiPut(path: string, token: string, body: object) {
  return fetch(`${API}/crossmodel${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());
}

interface AdminStats {
  totalUsers: number;
  totalChats: number;
  newUsersToday: number;
  newUsers7d: number;
  newUsers30d: number;
  openTickets: number;
}

interface DrUsage {
  userId: string;
  email: string;
  name: string | null;
  count: number;
}

interface FeatureRequest {
  id: string;
  type: string;
  title: string;
  description: string;
  status: string;
  createdAt: string;
  source?: 'user' | 'agent';
  user?: { email: string; name?: string };
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  bug_report:       <Bug className="size-3.5 text-destructive" />,
  feature_request:  <Lightbulb className="size-3.5 text-warn-ink" />,
  general_feedback: <MessageCircle className="size-3.5 text-ink-2" />,
  mishap:           <AlertTriangle className="size-3.5 text-warn-ink" />,
  enhancement:      <Sparkles className="size-3.5 text-brand-accent" />,
  research_idea:    <Microscope className="size-3.5 text-ok" />,
};

const STATUS_BADGE: Record<string, string> = {
  open:        'bg-warn/10 text-warn-ink dark:bg-warn/15 border-warn/40',
  in_progress: 'bg-hover text-ink dark:bg-hover/30 dark:text-ink-2 border-line',
  done:        'bg-success-muted text-success-strong border-ok/40',
  // 6665fff6 lifecycle states (review A1): awaiting rides the verifier's clock,
  // reopened is owed work again, deployed_verified is the strongest terminal.
  awaiting_verification: 'bg-warn/10 text-warn-ink dark:bg-warn/15 border-warn/40',
  reopened:              'bg-warn/10 text-warn-ink dark:bg-warn/15 border-warn/40',
  deployed_verified:     'bg-success-muted text-success-strong border-ok/40',
};

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');

  // Data
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [drUsage, setDrUsage] = useState<DrUsage[]>([]);
  const [tickets, setTickets] = useState<FeatureRequest[]>([]);
  const [drLimit, setDrLimit] = useState('');
  const [savingLimit, setSavingLimit] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const t = localStorage.getItem('accessToken') || '';
    setToken(t);
    authApi.getCurrentUser()
      .then(u => {
        setUser(u);
        // ADMIN role, or the owner e-mail (production convenience) — a self-host admin
        // has the role, never that address (self-host setup hardening 2026-10-20).
        if (!isAdminUser(u)) {
          router.replace('/');
          return;
        }
        loadAll(t);
      })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the loading state stays.
        if (isDefinitiveAuthFailure(err)) router.replace('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
  }, []);

  const loadAll = useCallback(async (t: string) => {
    setRefreshing(true);
    try {
      // 6665fff6 (review A1): a verifier-reopened row is OWED WORK — it must
      // surface here next to open rows, not vanish behind the single-status
      // fetch. The endpoint takes one status per call, so fan out and merge.
      const [statsRes, settingsRes, drRes, openRes, reopenedRes] = await Promise.all([
        apiGet('/admin/stats', t),
        apiGet('/admin/settings', t),
        apiGet('/admin/deep-research-usage', t),
        apiGet('/admin/feature-requests?status=open&limit=20', t),
        apiGet('/admin/feature-requests?status=reopened&limit=20', t),
      ]);
      if (statsRes.success)    setStats(statsRes.data);
      if (settingsRes.success) {
        setSettings(settingsRes.data);
        setDrLimit(settingsRes.data.deep_research_daily_limit || '5');
      }
      if (drRes.success)       setDrUsage(drRes.data?.usage || []);
      if (openRes.success || reopenedRes.success) {
        const merged = [
          ...(reopenedRes.success ? reopenedRes.data || [] : []),
          ...(openRes.success ? openRes.data || [] : []),
        ];
        setTickets(merged.slice(0, 40));
      }
    } catch (e) {
      toast.error('Failed to load admin data');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  const handleSaveLimit = async () => {
    const val = parseInt(drLimit, 10);
    if (isNaN(val) || val < 1 || val > 100) {
      toast.error('Limit must be between 1 and 100');
      return;
    }
    setSavingLimit(true);
    try {
      const res = await apiPut('/admin/settings/deep_research_daily_limit', token, { value: String(val) });
      if (res.success) {
        setSettings(prev => ({ ...prev, deep_research_daily_limit: String(val) }));
        toast.success(`Deep Research limit updated to ${val}/day`);
      } else {
        toast.error('Failed to save setting');
      }
    } catch {
      toast.error('Failed to save setting');
    } finally {
      setSavingLimit(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user || !isAdminUser(user)) return null;

  const drLimit_num = parseInt(settings.deep_research_daily_limit || '5', 10);
  const drTotalToday = drUsage.reduce((s, u) => s + u.count, 0);

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx). The root IS the
    // scroll container so the sticky header sticks inside it.
    <div className="h-dvh overflow-y-auto bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => router.push('/')}
              title="Back to Digby"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm font-semibold">Admin Panel</span>
            <Badge className="text-[10px] bg-warn/10 text-warn-ink border-warn/40 dark:bg-warn/15">
              {user.email}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5"
              onClick={() => loadAll(token)}
              disabled={refreshing}
            >
              <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">

        {/* ── Overview Stats ── */}
        <div>
          <h2 className="text-sm font-medium text-ink-3 mb-3">Overview</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: 'Total Users',    value: stats?.totalUsers    ?? '…', icon: <Users className="size-4 text-brand-accent" />,      sub: '' },
              { label: 'Total Chats',    value: stats?.totalChats    ?? '…', icon: <MessageSquare className="size-4 text-ink-3" />, sub: '' },
              { label: 'New Today',      value: stats?.newUsersToday ?? '…', icon: <TrendingUp className="size-4 text-success-accent" />,  sub: 'signups' },
              { label: 'New 7 Days',     value: stats?.newUsers7d    ?? '…', icon: <Calendar className="size-4 text-ink-3" />,    sub: 'signups' },
              { label: 'New 30 Days',    value: stats?.newUsers30d   ?? '…', icon: <BarChart2 className="size-4 text-ink-3" />,  sub: 'signups' },
              { label: 'Open Tickets',   value: stats?.openTickets   ?? '…', icon: <AlertCircle className="size-4 text-destructive" />,   sub: 'feature requests' },
            ].map(({ label, value, icon, sub }) => (
              <Card key={label} className="border">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 mb-1">
                    {icon}
                    <span className="text-[11px] text-muted-foreground font-medium">{label}</span>
                  </div>
                  <div className="text-2xl font-bold tabular-nums">{value}</div>
                  {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <Separator />

        {/* ── Deep Research Settings ── */}
        <div className="grid lg:grid-cols-2 gap-4">

          {/* Limit setting */}
          <Card className="border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Microscope className="size-4 text-primary" />
                Deep Research Limit
              </CardTitle>
              <CardDescription className="text-xs">
                Max deep research queries per user per day. Currently: <strong>{drLimit_num}/day</strong>.
                Resets at midnight UTC.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs mb-1 block">Daily limit per user</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={drLimit}
                    onChange={e => setDrLimit(e.target.value)}
                    className="h-9 text-sm w-32"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-9 gap-1.5"
                  onClick={handleSaveLimit}
                  disabled={savingLimit || drLimit === (settings.deep_research_daily_limit || '5')}
                >
                  {savingLimit ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  Save
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Setting is stored in SystemSettings and cached in Redis (invalidated immediately on save).
              </p>
            </CardContent>
          </Card>

          {/* Today's usage */}
          <Card className="border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="size-4 text-warn-ink" />
                Deep Research Usage Today
              </CardTitle>
              <CardDescription className="text-xs">
                {drTotalToday} total queries today across {drUsage.length} user{drUsage.length !== 1 ? 's' : ''}.
                Limit is {drLimit_num}/user/day.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {drUsage.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No deep research usage today.</p>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {drUsage.map(u => (
                    <div key={u.userId} className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex-1 min-w-0">
                        <span className="font-medium truncate block">{u.email}</span>
                        {u.name && <span className="text-muted-foreground text-[10px]">{u.name}</span>}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden w-16">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${Math.min(100, (u.count / drLimit_num) * 100)}%` }}
                          />
                        </div>
                        <Badge variant="outline" className="text-[10px] py-0 h-4 px-1.5 tabular-nums">
                          {u.count}/{drLimit_num}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Separator />

        {/* ── API Cost Explorer (placeholder) ── */}
        <div>
          <Card className="border border-dashed bg-muted/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart2 className="size-4 text-muted-foreground" />
                API Cost Explorer
                <Badge variant="outline" className="text-[10px]">Coming Soon</Badge>
              </CardTitle>
              <CardDescription className="text-xs">
                Per-model token usage and cost breakdown with date range picker. Requires adding token count
                tracking to the chat pipeline — each model response will log <code>inputTokens</code>, <code>outputTokens</code>,
                and cost in USD to a new <code>ApiUsage</code> table.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>

        <Separator />

        {/* ── Open Feature Requests ── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-ink-3">
              Open Feature Requests ({tickets.length})
            </h2>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5"
              onClick={() => router.push('/account?tab=feedback')}
            >
              <ExternalLink className="size-3.5" />
              Full Feedback Panel
            </Button>
          </div>
          {tickets.length === 0 ? (
            <Card className="border">
              <CardContent className="py-8 text-center">
                <CheckCircle2 className="size-8 text-success-accent mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No open tickets. Inbox zero! <PartyPopper className="inline size-4 -mt-0.5" aria-hidden="true" /></p>
              </CardContent>
            </Card>
          ) : (
            <Card className="border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="text-[11px] h-8 pl-4">Type</TableHead>
                    <TableHead className="text-[11px] h-8">Title</TableHead>
                    <TableHead className="text-[11px] h-8">User</TableHead>
                    <TableHead className="text-[11px] h-8">Status</TableHead>
                    <TableHead className="text-[11px] h-8 text-right pr-4">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tickets.map(ticket => (
                    <TableRow key={ticket.id} className="text-xs hover:bg-muted/30">
                      <TableCell className="pl-4 py-2">
                        <div className="flex items-center gap-1.5">
                          {TYPE_ICON[ticket.type] || <MessageCircle className="size-3.5 text-muted-foreground" />}
                          <span className="text-[10px] text-muted-foreground capitalize">
                            {ticket.type.replace(/_/g, ' ')}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="py-2 max-w-[250px]">
                        <span className="font-medium line-clamp-1">{ticket.title}</span>
                        <span className="text-muted-foreground text-[10px] line-clamp-1 mt-0.5">
                          {ticket.description}
                        </span>
                      </TableCell>
                      <TableCell className="py-2 text-muted-foreground">
                        {ticket.source === 'agent' ? (
                          <Badge variant="outline" className="text-[10px] py-0 h-5 px-2 bg-active text-ink border-line">
                            Digby
                          </Badge>
                        ) : (
                          ticket.user?.email?.split('@')[0] || '—'
                        )}
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] py-0 h-5 px-2 ${STATUS_BADGE[ticket.status] || ''}`}
                        >
                          {ticket.status.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2 text-right pr-4 text-muted-foreground tabular-nums">
                        {absoluteDate(ticket.createdAt, 'monthDay')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </div>

        {/* ── Other Settings ── */}
        <Separator />
        <div>
          <h2 className="text-sm font-medium text-ink-3 mb-3">System Settings</h2>
          <Card className="border">
            <CardContent className="p-4">
              {Object.keys(settings).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No settings found.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(settings).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-4 text-xs">
                      <code className="font-mono text-[11px] text-muted-foreground w-48 flex-shrink-0">{key}</code>
                      <span className="font-medium">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="pb-8" />
      </div>
    </div>
  );
}
