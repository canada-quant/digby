'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  adminApi,
  type DeepResearchUsageEntry,
  type AdminUser,
  type AdminStats,
  type ApiCostData,
  type JobHealthData,
} from '@/lib/api/crossmodel';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { relativeTime, absoluteDate } from '@/lib/relative-time';
import { ScrollableTabBar } from '@/components/ui/scrollable-tab-bar';
import JobsSection from './JobsSection';
import { ModelEndpointsSection } from './ModelEndpointsSection';
import { ModelRolesSection } from './ModelRolesSection';
import { CloudLinkSection } from './CloudLinkSection';
// Supervisor OFF switch (owner 2026-09-26): the Settings section's "Supervisors" panel.
import { SupervisorsSection } from './SupervisorsSection';
import { WebSearchSection } from './WebSearchSection';
import { SetupSection } from './SetupSection';
import { DebugModeSection } from './DebugModeSection';
// Always-Auto depth policy (audit 2026-09-26): the Settings section's "Depth policy" panel.
import { PatienceAutoOnlySection } from './PatienceAutoOnlySection';
// Phase 2 Cloud — seasonal/holiday branding packs (todo 61dc8aaf).
import { BrandingPacksSection } from './BrandingPacksSection';
import { ConnectedInstancesSection } from '../components/ConnectedInstancesSection';
// Users & traffic (owner 2026-10-07): first-party visitor analytics — sources, users table, user flow.
import { TrafficSection } from './TrafficSection';
// Held tickets (audit 2026-10-08 W5-1a): approve another account's ticket for an auto-merging ticket lane.
import { HeldTicketsSection } from './HeldTicketsSection';
// Delegation ledger (build 2026-10-08 D): the SHADOW delegation task ledger + tool-intent journal readout.
import { DelegationTasksSection } from './DelegationTasksSection';
import {
  Server,
  Settings,
  Users,
  RefreshCw,
  Save,
  Loader2,
  Shield,
  Zap,
  DollarSign,
  TrendingUp,
  MessageSquare,
  Calendar,
  BarChart2,
  AlertCircle,
  Crown,
  Activity,
  Trash2,
  Cable,
  Cloud,
  Globe,
  Inbox,
  Wrench,
  Palette,
} from 'lucide-react';

type AdminSection = 'overview' | 'setup' | 'jobs' | 'users' | 'traffic' | 'feedback' | 'costs' | 'settings' | 'endpoints' | 'cloud' | 'instances' | 'branding';

export function AdminTab() {
  const [section, setSection] = useState<AdminSection>('overview');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<DeepResearchUsageEntry[]>([]);
  const [usageDate, setUsageDate] = useState('');
  const [currentLimit, setCurrentLimit] = useState('5');
  const [editLimit, setEditLimit] = useState('5');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [apiCosts, setApiCosts] = useState<ApiCostData | null>(null);
  const [costDays, setCostDays] = useState(30);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<AdminUser | null>(null);
  const [confirmRole, setConfirmRole] = useState<{ user: AdminUser; role: 'ADMIN' | 'USER' } | null>(null);
  const [roleSavingId, setRoleSavingId] = useState<string | null>(null);
  const [jobHealth, setJobHealth] = useState<JobHealthData | null>(null);
  const [jobHealthLoading, setJobHealthLoading] = useState(false);

  const loadData = useCallback(async (): Promise<boolean> => {
    try {
      const [settingsData, usageData, statsData, usersData, costsData] = await Promise.all([
        adminApi.getSettings(),
        adminApi.getDeepResearchUsage(),
        adminApi.getStats(),
        adminApi.getUsers(),
        adminApi.getApiCosts(costDays),
      ]);
      setSettings(settingsData);
      const limit = settingsData.deep_research_daily_limit || '5';
      setCurrentLimit(limit);
      setEditLimit(limit);
      setUsage(usageData.usage);
      setUsageDate(usageData.date);
      setStats(statsData);
      setUsers(usersData);
      setApiCosts(costsData);
      return true;
    } catch {
      toast.error('Failed to load admin data');
      return false;
    } finally {
      setLoading(false);
    }
  }, [costDays]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSaveLimit = async () => {
    const num = parseInt(editLimit, 10);
    if (isNaN(num) || num < 0) { toast.error('Limit must be a non-negative number'); return; }
    setSaving(true);
    try {
      await adminApi.updateSetting('deep_research_daily_limit', String(num));
      setCurrentLimit(String(num));
      toast.success(`Deep research daily limit updated to ${num}`);
    } catch { toast.error('Failed to update setting'); }
    finally { setSaving(false); }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    const ok = await loadData();
    setRefreshing(false);
    // loadData already toasts its own failure — only claim success when it IS one.
    if (ok) toast.success('Data refreshed');
  };

  const handleDeleteUser = async (u: AdminUser) => {
    setDeletingUserId(u.id);
    try {
      await adminApi.deleteUser(u.id);
      setUsers(prev => prev.filter(x => x.id !== u.id));
      toast.success(`Deleted ${u.email}`);
    } catch {
      toast.error('Failed to delete user');
    } finally {
      setDeletingUserId(null);
      setConfirmDeleteUser(null);
    }
  };

  // Promote / demote (owner 2026-10-16). The server refuses your own row, the owner account and Digby Kids accounts.
  const handleSetRole = async (u: AdminUser, role: 'ADMIN' | 'USER') => {
    setRoleSavingId(u.id);
    try {
      await adminApi.setUserRole(u.id, role);
      setUsers(prev => prev.map(x => (x.id === u.id ? { ...x, role } : x)));
      toast.success(role === 'ADMIN' ? `${u.email} is now an admin` : `${u.email} is now a user`, {
        description: 'Takes effect on their next sign-in, or within 15 minutes.',
      });
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to change role');
    } finally {
      setRoleSavingId(null);
      setConfirmRole(null);
    }
  };

  // --- HOOKS MUST BE DECLARED BEFORE ANY EARLY RETURN (React Rules of Hooks) ---
  // Violating this causes React #310 "Rendered more hooks than during the previous render"
  // when `loading` flips false and the post-return hooks run for the first time.

  const loadJobHealth = useCallback(async () => {
    setJobHealthLoading(true);
    try { setJobHealth(await adminApi.getJobHealth()); }
    catch { toast.error('Failed to load job health'); }
    finally { setJobHealthLoading(false); }
  }, []);

  // Load job health when Jobs tab is selected
  useEffect(() => { if (section === 'jobs' && !jobHealth) loadJobHealth(); }, [section, jobHealth, loadJobHealth]);

  // --- End hooks. Safe to early-return now. ---

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-brand-accent" />
      </div>
    );
  }

  const totalUsageToday = usage.reduce((sum, u) => sum + u.count, 0);
  const limit = parseInt(currentLimit, 10) || 5;

  const MODEL_LABELS: Record<string, string> = {
    'kimi-k3': 'Kimi K3 (Moonshot)', 'kimi-k2.6': 'Kimi K2.6 (Moonshot)',
    'glm-5.3': 'GLM-5.3 (Z.ai)', 'glm-5.2': 'GLM-5.2 (Z.ai)',
    'deepseek-flash': 'DeepSeek V4.1 Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro', 'deepseek-v4-flash': 'DeepSeek V4 Flash',
    'qwen3.6-27b': 'Qwen 3.6 27B', unknown: 'Unknown model',
  };
  // Provider color legend — categorical (one distinguishing hue per provider,
  // like canvas-meta TYPE_COLORS), NOT success/brand semantics: keep raw.
  const MODEL_COLORS: Record<string, string> = {
    'kimi-k3': 'bg-pink-500', 'kimi-k2.6': 'bg-pink-400', // palette-keep
    'glm-5.3': 'bg-purple-500', 'glm-5.2': 'bg-purple-400', // palette-keep
    'deepseek-flash': 'bg-cyan-500', 'deepseek-v4-pro': 'bg-cyan-600', 'deepseek-v4-flash': 'bg-cyan-400', // palette-keep
    'qwen3.6-27b': 'bg-amber-500', unknown: 'bg-gray-400', // palette-keep
  };

  const sections: { id: AdminSection; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: 'overview', label: 'Overview', icon: BarChart2 },
    // Self-host setup hardening (2026-10-20): what THIS instance has configured + how to fix each gap.
    { id: 'setup', label: 'Setup', icon: Wrench },
    { id: 'jobs', label: 'Jobs', icon: Activity, badge: jobHealth?.errorSummary?.errorSpike ? 1 : undefined },
    { id: 'users', label: 'Users', icon: Users },
    { id: 'traffic', label: 'Users & traffic', icon: Globe },
    { id: 'feedback', label: 'Feedback', icon: Inbox },
    { id: 'costs', label: 'API Costs', icon: DollarSign },
    { id: 'endpoints', label: 'Endpoints', icon: Cable },
    { id: 'instances', label: 'Instances', icon: Server },
    // Phase 2 Cloud (todo 61dc8aaf): seasonal/holiday skins an operator can put
    // on and take off at runtime — no rebuild, no frontend fork.
    { id: 'branding', label: 'Branding packs', icon: Palette },
    { id: 'cloud', label: 'Cloud link', icon: Cloud },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="size-5 text-brand-accent" />
          <h2 className="text-lg font-semibold">Admin Panel</h2>
        </div>
        <button onClick={handleRefresh} disabled={refreshing}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <ScrollableTabBar
        ariaLabel="Admin sections"
        size="sm"
        value={section}
        onChange={setSection}
        tabs={sections}
        className="border-b"
      />

      {/* OVERVIEW */}
      {section === 'overview' && (
        <div className="space-y-6">
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {[
                { label: 'Total Users', value: stats.totalUsers, icon: <Users className="size-4 text-brand-accent" /> },
                { label: 'Total Chats', value: stats.totalChats, icon: <MessageSquare className="size-4 text-ink-2" /> },
                { label: 'New Today', value: stats.newUsersToday, icon: <TrendingUp className="size-4 text-success-accent" /> },
                { label: 'New 7d', value: stats.newUsers7d, icon: <Calendar className="size-4 text-warn-ink" /> },
                { label: 'New 30d', value: stats.newUsers30d, icon: <BarChart2 className="size-4 text-warn-ink" /> },
                { label: 'Open Tickets', value: stats.openTickets, icon: <AlertCircle className="size-4 text-destructive" /> },
              ].map(s => (
                <div key={s.label} className="rounded-lg border bg-card p-3">
                  <div className="flex items-center gap-2 mb-1">
                    {s.icon}
                    <span className="text-[11px] text-muted-foreground font-medium">{s.label}</span>
                  </div>
                  <div className="text-2xl font-bold tabular-nums">{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Deep Research Usage Today */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="size-4 text-warn-ink" />
                <h3 className="text-sm font-semibold">Deep Research Today</h3>
              </div>
              <span className="text-xs text-muted-foreground">{usageDate}</span>
            </div>
            {usage.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2 text-center">No deep research queries today.</p>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">
                  {usage.length} user{usage.length !== 1 ? 's' : ''} &middot; {totalUsageToday} total &middot; limit {limit}/user/day
                </div>
                <div className="rounded-md border overflow-hidden overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 text-xs text-muted-foreground">
                        <th className="text-left px-3 py-2 font-medium">User</th>
                        <th className="text-right px-3 py-2 font-medium">Used</th>
                        <th className="text-right px-3 py-2 font-medium">Left</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Sort a copy — in-place .sort() mutates state during render */}
                      {[...usage].sort((a, b) => b.count - a.count).map(u => {
                        const rem = Math.max(0, limit - u.count);
                        return (
                          <tr key={u.userId} className="border-t">
                            <td className="px-3 py-2">
                              <div className="text-sm font-medium">{u.email}</div>
                              {u.name && <div className="text-xs text-muted-foreground">{u.name}</div>}
                            </td>
                            <td className="text-right px-3 py-2 tabular-nums">
                              <span className={cn('font-medium', u.count >= limit ? 'text-destructive' : '')}>{u.count}</span>
                              <span className="text-muted-foreground">/{limit}</span>
                            </td>
                            <td className="text-right px-3 py-2 tabular-nums">
                              <span className={cn(rem === 0 ? 'text-destructive' : 'text-success')}>{rem}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* Quick cost summary */}
          {apiCosts && (
            <div className="rounded-lg border bg-card p-5 space-y-3">
              <div className="flex items-center gap-2">
                <DollarSign className="size-4 text-success-accent" />
                <h3 className="text-sm font-semibold">Cost Summary (Last {apiCosts.days} Days)</h3>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center">
                  <div className="text-xl font-bold tabular-nums">{apiCosts.totalMessages.toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground">Total Queries</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-bold tabular-nums text-success">${apiCosts.totalSpendUsd.toFixed(2)}</div>
                  <div className="text-[10px] text-muted-foreground">Spend ({apiCosts.spendWindowDays}d recorded)</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-bold tabular-nums">{apiCosts.totalMessages > 0 ? (apiCosts.totalSpendUsd / apiCosts.totalMessages * 100).toFixed(1) : '0'}&cent;</div>
                  <div className="text-[10px] text-muted-foreground">Avg Spend/Query</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* JOBS */}
      {section === 'jobs' && (<JobsSection jh={jobHealth} loading={jobHealthLoading} onRefresh={loadJobHealth} />)}
      {/* Delegation ledger (build 2026-10-08 D): the SHADOW task ledger + tool-intent journal, read-only. */}
      {section === 'jobs' && <div className="mt-4"><DelegationTasksSection /></div>}


      {/* USERS */}
      {section === 'users' && (
        <div className="space-y-4">
          <div className="text-xs text-muted-foreground">{users.length} registered users</div>
          <div className="rounded-md border overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-xs text-muted-foreground">
                  <th className="text-left px-3 py-2 font-medium">User</th>
                  <th className="text-left px-3 py-2 font-medium">Role</th>
                  <th className="text-right px-3 py-2 font-medium">Chats</th>
                  <th className="text-right px-3 py-2 font-medium">Messages</th>
                  <th className="text-left px-3 py-2 font-medium">Joined</th>
                  <th className="text-left px-3 py-2 font-medium">Last Active</th>
                  <th className="px-3 py-2 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isOwner = u.email?.toLowerCase() === 'example-user@example.com';
                  const isAdmin = u.role === 'ADMIN' || isOwner;
                  return (
                    <tr key={u.id} className={cn('border-t', isAdmin && 'bg-brand-faint')}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          {isAdmin && <Crown className="size-3 text-warn-ink flex-shrink-0" />}
                          <div>
                            <div className="text-sm font-medium">{u.email}</div>
                            {u.name && <div className="text-xs text-muted-foreground">{u.name}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {isOwner ? (
                          <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] bg-active text-ink border-line">Owner</Badge>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <select
                              value={isAdmin ? 'ADMIN' : 'USER'}
                              disabled={roleSavingId === u.id}
                              onChange={(e) => setConfirmRole({ user: u, role: e.target.value as 'ADMIN' | 'USER' })}
                              aria-label={`Role for ${u.email}`}
                              data-testid={`role-select-${u.id}`}
                              className="h-7 rounded-md border border-line bg-background px-1.5 text-xs text-foreground disabled:opacity-50"
                            >
                              <option value="USER">User</option>
                              <option value="ADMIN">Admin</option>
                            </select>
                            {roleSavingId === u.id && <Loader2 className="size-3 animate-spin text-ink-3" />}
                          </div>
                        )}
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">{u.chatCount}</td>
                      <td className="text-right px-3 py-2 tabular-nums">{u.messageCount}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{absoluteDate(u.createdAt)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {u.lastActive ? relativeTime(u.lastActive) : '\u2014'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {!isAdmin && (
                          <button
                            onClick={() => setConfirmDeleteUser(u)}
                            disabled={deletingUserId === u.id}
                            title={`Delete ${u.email}`}
                            className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/20 transition-colors disabled:opacity-50"
                          >
                            {deletingUserId === u.id
                              ? <Loader2 className="size-3.5 animate-spin" />
                              : <Trash2 className="size-3.5" />}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Role change confirmation */}
          <AlertDialog open={!!confirmRole} onOpenChange={(open) => !open && setConfirmRole(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <Crown className="size-5 text-warn-ink" />
                  {confirmRole?.role === 'ADMIN' ? 'Make admin' : 'Remove admin'}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmRole?.role === 'ADMIN'
                    ? <>Make <strong>{confirmRole?.user.email}</strong> an admin? They will see this Admin page, every user, API costs, endpoints and settings, and the full debug view of chats.</>
                    : <>Make <strong>{confirmRole?.user.email}</strong> a regular user? They lose access to the Admin page and see the minimal view.</>}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => confirmRole && handleSetRole(confirmRole.user, confirmRole.role)}
                  disabled={!!confirmRole && roleSavingId === confirmRole.user.id}
                  data-testid="confirm-role-change"
                >
                  {confirmRole?.role === 'ADMIN' ? 'Make admin' : 'Remove admin'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Delete confirmation dialog */}
          <AlertDialog open={!!confirmDeleteUser} onOpenChange={(open) => !open && setConfirmDeleteUser(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                  <Trash2 className="size-5" />
                  Delete User
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to permanently delete <strong>{confirmDeleteUser?.email}</strong>?
                  This will remove all their chats ({confirmDeleteUser?.chatCount}), messages ({confirmDeleteUser?.messageCount}), memory, and other data. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => confirmDeleteUser && handleDeleteUser(confirmDeleteUser)}
                  disabled={!!confirmDeleteUser && deletingUserId === confirmDeleteUser.id}
                  className="bg-destructive hover:bg-destructive/90 text-white gap-1.5"
                >
                  {confirmDeleteUser && deletingUserId === confirmDeleteUser.id
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Trash2 className="size-3.5" />}
                  Delete User
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {/* USERS & TRAFFIC — first-party visitor analytics (owner 2026-10-07): traffic sources, the users table with
          per-user API cost + ip hash, and each user's flow. Fetches only while selected. */}
      {section === 'traffic' && <TrafficSection />}

      {/* FEEDBACK — held tickets awaiting an admin's "Approve for a ticket lane" (audit 2026-10-08 W5-1a) */}
      {section === 'feedback' && <HeldTicketsSection />}

      {/* API COSTS */}
      {section === 'costs' && apiCosts && (
        <div className="space-y-6">
          {/* Date range selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Period:</span>
            {[7, 14, 30, 60, 90].map(d => (
              <button key={d} onClick={() => setCostDays(d)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  costDays === d ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
                )}>
                {d}d
              </button>
            ))}
          </div>

          {/* Summary cards — RECORDED spend (loop_metrics run_spend rows) + truthful chat query count */}
          <div className="grid grid-cols-4 gap-3">
            <div className="rounded-lg border bg-card p-4 text-center">
              <div className="text-2xl font-bold tabular-nums text-success">${apiCosts.totalSpendUsd.toFixed(2)}</div>
              <div className="text-[10px] text-muted-foreground mt-1">Total Spend ({apiCosts.spendWindowDays}d recorded)</div>
            </div>
            <div className="rounded-lg border bg-card p-4 text-center">
              <div className="text-2xl font-bold tabular-nums">${apiCosts.surfaceSpend.coding.toFixed(2)}</div>
              <div className="text-[10px] text-muted-foreground mt-1">Coding Sessions</div>
            </div>
            <div className="rounded-lg border bg-card p-4 text-center">
              <div className="text-2xl font-bold tabular-nums">${apiCosts.surfaceSpend.chat.toFixed(2)}</div>
              <div className="text-[10px] text-muted-foreground mt-1">Chat + Research (${apiCosts.surfaceSpend.chatResearch.toFixed(2)})</div>
            </div>
            <div className="rounded-lg border bg-card p-4 text-center">
              <div className="text-2xl font-bold tabular-nums">{apiCosts.totalMessages.toLocaleString()}</div>
              <div className="text-[10px] text-muted-foreground mt-1">Chat Queries ({apiCosts.days}d)</div>
            </div>
          </div>

          {/* Seats govern sessions (2026-09-28): what governed each coding run's model (run_spend meta.modelSource) */}
          {Array.isArray(apiCosts.modelGovernance) && apiCosts.modelGovernance.length > 0 && (
            <div className="rounded-lg border bg-card p-4" data-testid="model-governance">
              <h3 className="text-sm font-semibold mb-1">What governed the coding model ({apiCosts.spendWindowDays}d)</h3>
              <p className="text-[11px] text-muted-foreground mb-2">Per coding run, from its run_spend row: <span className="font-mono">seat</span> = the Workspace default seat resolved live · <span className="font-mono">project</span> = a human-set project pick · <span className="font-mono">preference</span> = a personal pick the user made themselves · <span className="font-mono">explicit</span> = a session-level pick (set_session_model / spawn model) · <span className="font-mono">stamp</span> = the stored session model (seat unresolvable) · <span className="font-mono">unstamped</span> = runs older than the change.</p>
              <div className="flex flex-wrap gap-2">
                {apiCosts.modelGovernance.map(g => (
                  <div key={g.source} className="rounded-md border px-2.5 py-1.5 text-xs">
                    <span className="font-mono font-medium">{g.source}</span>
                    <span className="text-muted-foreground"> · {g.runs.toLocaleString()} run{g.runs === 1 ? '' : 's'} · ${g.usd.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* audit 2026-10-08 W3-2: prompt-cache hit rate per profile — cached input bills at a fraction of the input rate. */}
          {Array.isArray(apiCosts.promptCacheByProfile) && apiCosts.promptCacheByProfile.length > 0 && (
            <div className="rounded-lg border bg-card p-4" data-testid="prompt-cache-by-profile">
              <h3 className="text-sm font-semibold mb-1">Prompt cache hits ({apiCosts.spendWindowDays}d)</h3>
              <p className="text-[11px] text-muted-foreground mb-2">Share of input tokens the provider served from its prompt cache, per profile (runs recorded since the cache fields shipped). The per-model share is on each row below.</p>
              <div className="flex flex-wrap gap-2">
                {apiCosts.promptCacheByProfile.map(c => (
                  <div key={c.profile} className="rounded-md border px-2.5 py-1.5 text-xs">
                    <span className="font-mono font-medium">{c.profile}</span>
                    <span className="text-muted-foreground"> · {c.cacheHitPct.toFixed(1)}% cached · {c.runs.toLocaleString()} run{c.runs === 1 ? '' : 's'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-model breakdown — real recorded tokens; built-ins priced at list, custom endpoints token-tracked */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Activity className="size-4 text-ink-2" />
              Per-Model Breakdown (recorded tokens, {apiCosts.spendWindowDays}d)
            </h3>
            {(() => {
              // Decision-gate rows (profile 'decision') render in their own group: same vendor id, different seat, different price table.
              const builtIn = apiCosts.models.filter(m => !m.custom && m.profile !== 'decision');
              const custom = apiCosts.models.filter(m => m.custom && m.profile !== 'decision');
              const decision = apiCosts.models.filter(m => m.profile === 'decision');
              const totalList = apiCosts.models.reduce((s, m) => s + m.listCostUsd, 0);
              const fmtTok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
              const renderRow = (m: typeof apiCosts.models[number]) => {
                const pct = totalList > 0 ? (m.listCostUsd / totalList) * 100 : 0;
                return (
                  <div key={m.model} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className={cn('size-2.5 rounded-full', MODEL_COLORS[m.model] || 'bg-ink-3')} />
                        <span className="font-medium">{MODEL_LABELS[m.model] || m.model}</span>
                        {m.estimated && <span className="text-[9px] text-muted-foreground">(some turns estimated)</span>}
                        {m.profile === 'decision' && <span className="text-[9px] text-muted-foreground" title={m.priceNote}>decision gate{m.priceSource ? ` · ${m.priceSource === 'self_hosted' ? 'self-hosted' : m.priceSource === 'env' ? 'env price' : m.priceSource === 'registry' ? 'registry price' : m.priceSource}` : ''}</span>}
                        {m.unpriced && <span className="text-[9px] text-warning" title={m.priceNote}>{m.priceSource === 'self_hosted' ? 'self-hosted — no registry price set' : 'unpriced'}</span>}
                      </div>
                      <div className="flex items-center gap-3 tabular-nums">
                        <span className="text-muted-foreground">{m.runs.toLocaleString()} runs · {fmtTok(m.inTokens)} in / {fmtTok(m.outTokens)} out{typeof m.cacheHitPct === 'number' && m.profile !== 'decision' ? ` · cache ${m.cacheHitPct.toFixed(1)}%` : ''}</span>
                        <span className="font-medium text-success">${m.listCostUsd.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div className={cn('h-full rounded-full', MODEL_COLORS[m.model] || 'bg-ink-3')}
                        style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                );
              };
              return (
                <>
                  <div className="space-y-2">{builtIn.map(renderRow)}</div>
                  {custom.length > 0 && (
                    <div className="space-y-2 pt-2 border-t">
                      <div className="text-[10px] text-muted-foreground">
                        Custom endpoints — tokens recorded across your own providers; exact $ is tracked on your provider's bill (list-price estimate shown).
                      </div>
                      {custom.map(renderRow)}
                    </div>
                  )}
                  {decision.length > 0 && (
                    <div className="space-y-2 pt-2 border-t" data-testid="api-costs-decision-models">
                      <div className="text-[10px] text-muted-foreground">
                        Decision gate backends — the harness's own typed decisions (TypeSafe Jev at its list price, a self-hosted decision model at its registry price, the DeepSeek logprob readout at list). One "run" = one decision call.
                      </div>
                      {decision.map(renderRow)}
                    </div>
                  )}
                  {apiCosts.models.length === 0 && (
                    <div className="text-xs text-muted-foreground">No recorded spend in this window (spend telemetry began {apiCosts.spendRecordedSince}).</div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Decision gate — the harness's own typed decisions (owner 2026-09-28: "did you make sure to add jev to api costs as well") */}
          {apiCosts.decisionGate && (() => {
            const dg = apiCosts.decisionGate;
            const fmtTok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
            const fmtUsd = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0';
            const unpricedBackends = dg.byBackend.filter(b => b.unpriced);
            const unbackfilled = dg.totals.calls - dg.totals.pricedCalls;
            const replacedTotal = dg.replaced.reduce((s, r) => s + (r.estimateUsd ?? 0), 0);
            return (
              <div className="rounded-lg border bg-card p-5 space-y-3" data-testid="api-costs-decision-gate">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <DollarSign className="size-4 text-ink-2" />
                  Decision gate ({dg.windowDays}d)
                </h3>
                <div className="grid grid-cols-4 gap-3">
                  <div className="rounded-md bg-muted/40 p-3 text-center">
                    <div className="text-lg font-bold tabular-nums">{dg.totals.calls.toLocaleString()}</div>
                    <div className="text-[10px] text-muted-foreground">Decision calls{dg.totals.memoHits > 0 ? ` (+${dg.totals.memoHits.toLocaleString()} memo hits, free)` : ''}</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3 text-center">
                    <div className="text-lg font-bold tabular-nums">{fmtTok(dg.totals.inputTokens)}</div>
                    <div className="text-[10px] text-muted-foreground">Input tokens</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3 text-center">
                    <div className="text-lg font-bold tabular-nums text-success">{fmtUsd(dg.totals.usd)}</div>
                    <div className="text-[10px] text-muted-foreground">Recorded spend{unbackfilled > 0 ? ` (${dg.totals.pricedCalls.toLocaleString()} of ${dg.totals.calls.toLocaleString()} calls priced)` : ''}</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3 text-center">
                    <div className="text-lg font-bold tabular-nums">{dg.replaced.length ? `≈ ${fmtUsd(replacedTotal)}` : '—'}</div>
                    <div className="text-[10px] text-muted-foreground">What it replaced (estimate)</div>
                  </div>
                </div>
                {unpricedBackends.length > 0 && (
                  <div className="text-[11px] text-warning">
                    {unpricedBackends.map(b => b.backend).join(', ')}: {unpricedBackends.some(b => b.priceSource === 'self_hosted') ? 'self-hosted — $0 until a registry price (usdPerMTokIn / usdPerMTokOut on the model or the endpoint) is set' : `unpriced — set ${dg.pricing.envIn}`}.
                  </div>
                )}
                {unbackfilled > 0 && (
                  <div className="text-[11px] text-muted-foreground">{unbackfilled.toLocaleString()} calls in this window carry no spend rows yet (history before the 2026-09-28 deploy) — run <code className="font-mono">scripts/framework-audit/backfill-decision-gate-spend.js --apply</code> via prodq.sh to mint them.</div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[11px] font-medium mb-1">Per backend</div>
                    <table className="w-full text-[11px]">
                      <thead><tr className="text-left text-muted-foreground"><th className="py-0.5 pr-2 font-medium">Backend</th><th className="py-0.5 pr-2 font-medium text-right">Calls</th><th className="py-0.5 pr-2 font-medium text-right">Input</th><th className="py-0.5 pr-2 font-medium text-right">p50</th><th className="py-0.5 font-medium text-right">$</th></tr></thead>
                      <tbody>
                        {dg.byBackend.map(b => (
                          <tr key={b.backend} className="border-t border-dashed" data-testid={`api-costs-decision-backend-${b.backend}`}>
                            <td className="py-0.5 pr-2">{b.backend}{b.model ? <code className="ml-1 font-mono text-[10px] text-muted-foreground">{b.model}</code> : null}{b.unpriced && <span className="ml-1 text-[9px] text-warning">{b.priceSource === 'self_hosted' ? 'self-hosted' : 'unpriced'}</span>}</td>
                            <td className="py-0.5 pr-2 text-right tabular-nums">{b.calls.toLocaleString()}</td>
                            <td className="py-0.5 pr-2 text-right tabular-nums">{fmtTok(b.inputTokens)}</td>
                            <td className="py-0.5 pr-2 text-right tabular-nums">{b.p50Ms === null ? '—' : `${b.p50Ms} ms`}</td>
                            <td className="py-0.5 text-right tabular-nums font-medium">{fmtUsd(b.usd)}</td>
                          </tr>
                        ))}
                        {dg.byBackend.length === 0 && <tr><td colSpan={5} className="py-1 text-muted-foreground">No decision calls in this window.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium mb-1">Per purpose</div>
                    <div className="max-h-52 overflow-y-auto">
                      <table className="w-full text-[11px]">
                        <thead><tr className="text-left text-muted-foreground"><th className="py-0.5 pr-2 font-medium">Purpose</th><th className="py-0.5 pr-2 font-medium text-right">Calls</th><th className="py-0.5 pr-2 font-medium text-right">Input</th><th className="py-0.5 pr-2 font-medium text-right">p50</th><th className="py-0.5 font-medium text-right">$</th></tr></thead>
                        <tbody>
                          {dg.byPurpose.map(p => (
                            <tr key={p.purpose} className="border-t border-dashed">
                              <td className="py-0.5 pr-2"><code className="font-mono">{p.purpose}</code></td>
                              <td className="py-0.5 pr-2 text-right tabular-nums">{p.calls.toLocaleString()}</td>
                              <td className="py-0.5 pr-2 text-right tabular-nums">{fmtTok(p.inputTokens)}</td>
                              <td className="py-0.5 pr-2 text-right tabular-nums">{p.p50Ms === null ? '—' : `${p.p50Ms} ms`}</td>
                              <td className="py-0.5 text-right tabular-nums font-medium">{fmtUsd(p.usd)}</td>
                            </tr>
                          ))}
                          {dg.byPurpose.length === 0 && <tr><td colSpan={5} className="py-1 text-muted-foreground">—</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                {dg.replaced.length > 0 && (
                  <div className="rounded-md border border-dashed p-2 text-[11px] space-y-0.5" data-testid="api-costs-decision-replaced">
                    <div className="font-medium">What it replaced — an ESTIMATE, not a saving claim</div>
                    {dg.replaced.map(r => (
                      <div key={r.purpose} className="text-muted-foreground" title={r.basis}>
                        <code className="font-mono">{r.purpose}</code>: {r.avoided.toLocaleString()} {r.unit}{r.avoided === 1 ? '' : 's'} × {r.meanRunUsd === null ? 'no comparable runs in the window' : `${fmtUsd(r.meanRunUsd)} mean run (n={r.runsSampled})`} {r.estimateUsd === null ? '' : `≈ ${fmtUsd(r.estimateUsd)}`}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  TypeSafe Jev priced at ${dg.pricing.typesafe.usdPerMTokIn}/M input, ${dg.pricing.typesafe.usdPerMTokOut}/M output ({dg.pricing.typesafe.source === 'env' ? `${dg.pricing.envIn} override` : <a className="underline" href={dg.pricing.typesafe.url} target="_blank" rel="noreferrer">vendor list price</a>}); the DeepSeek readout at its list rate; a self-hosted decision model at the registry price you set on the endpoint. Memo hits cost nothing and are not counted as calls. Spend attributes to the chat the decision served, else to the synthetic <code className="font-mono">decision-gate</code> session (excluded from per-user rows).
                </p>
              </div>
            );
          })()}

          {/* Per-user spend — who is spending what, and on which surface */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Users className="size-4 text-ink-2" />
              Per-User Spend ({apiCosts.spendWindowDays}d)
            </h3>
            {apiCosts.perUser.length > 0 ? (
              <div className="max-h-60 overflow-y-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50 text-muted-foreground sticky top-0">
                      <th className="text-left px-3 py-1.5 font-medium">User</th>
                      <th className="text-right px-3 py-1.5 font-medium">Total</th>
                      <th className="text-right px-3 py-1.5 font-medium">Coding</th>
                      <th className="text-right px-3 py-1.5 font-medium">Chat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiCosts.perUser.map(u => (
                      <tr key={u.userId ?? '(deleted)'} className="border-t">
                        <td className="px-3 py-1.5">{u.email}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-medium">${u.totalUsd.toFixed(2)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">${u.codingUsd.toFixed(2)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">${u.chatUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">No recorded spend in this window.</div>
            )}
            <p className="text-[10px] text-muted-foreground">
              Recorded spend since {apiCosts.spendRecordedSince}; telemetry retention 30d (spend window clamps at {apiCosts.spendWindowDays}d).
              Per-model $ is a list-price estimate from recorded tokens; the headline total is recorded spend.
              Machine-triggered runs: ${apiCosts.triggerSpend.machine.toFixed(2)} · scheduled: ${apiCosts.triggerSpend.schedule.toFixed(2)} · hook wakes: ${apiCosts.triggerSpend.hook.toFixed(2)} · user-triggered: ${apiCosts.triggerSpend.user.toFixed(2)}{typeof apiCosts.triggerSpend.decision === 'number' ? ` · decision gate: $${apiCosts.triggerSpend.decision.toFixed(4)}` : ''}.
              Utility/background calls (titles, digests) are unmetered.
            </p>
          </div>

          {/* Mode breakdown */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <h3 className="text-sm font-semibold">Query Mode Distribution</h3>
            <div className="grid grid-cols-3 gap-3">
              {Object.entries(apiCosts.modeCounts).map(([mode, count]) => (
                <div key={mode} className="rounded-md bg-muted/40 p-3 text-center">
                  <div className="text-lg font-bold tabular-nums">{count.toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground capitalize">{mode.replace('_', ' ')}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Daily trend */}
          {apiCosts.dailyTrend.length > 0 && (
            <div className="rounded-lg border bg-card p-5 space-y-3">
              <h3 className="text-sm font-semibold">Daily Query Volume</h3>
              <div className="max-h-60 overflow-y-auto overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50 text-muted-foreground sticky top-0">
                      <th className="text-left px-3 py-1.5 font-medium">Date</th>
                      <th className="text-right px-3 py-1.5 font-medium">Queries</th>
                      <th className="px-3 py-1.5 font-medium">Volume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiCosts.dailyTrend.slice().reverse().map(d => {
                      const maxTotal = Math.max(...apiCosts.dailyTrend.map(x => x.total));
                      const pct = maxTotal > 0 ? (d.total / maxTotal) * 100 : 0;
                      return (
                        <tr key={d.date} className="border-t">
                          <td className="px-3 py-1.5 font-mono">{d.date}</td>
                          <td className="text-right px-3 py-1.5 tabular-nums font-medium">{d.total}</td>
                          <td className="px-3 py-1.5">
                            <div className="h-2 rounded-full bg-muted overflow-hidden w-full">
                              <div className="h-full rounded-full bg-brand-accent" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* MODEL ENDPOINTS (Digby Edge — custom OpenAI-compatible registry)
          + MODEL ROLES (which model serves each named seat of the experience) */}
      {section === 'endpoints' && (
        <div className="space-y-8">
          <ModelEndpointsSection />
          <ModelRolesSection />
        </div>
      )}

      {/* CONNECTED INSTANCES (Digby Edge — paired edge instances, cloud side) */}
      {section === 'instances' && (
        <div className="max-w-sm">
          <p className="text-xs text-muted-foreground mb-2">
            Self-hosted Digby instances paired to this one. Expand an instance to browse its chats; the full browser lives at /crossmodel/instances.
          </p>
          <div className="rounded-xl border bg-card">
            <ConnectedInstancesSection />
          </div>
        </div>
      )}

      {/* CLOUD LINK (Digby Edge — this instance paired TO a cloud, edge side) */}
      {section === 'cloud' && <CloudLinkSection />}

      {/* BRANDING PACKS (Phase 2 Cloud, todo 61dc8aaf) — seasonal/holiday skins
          an admin puts on and takes off at runtime; no rebuild, no fork. */}
      {section === 'branding' && <BrandingPacksSection />}

      {/* SETUP (self-host setup hardening 2026-10-20): what this instance has configured + how to fix each gap */}
      {section === 'setup' && <SetupSection />}

      {/* SETTINGS */}
      {section === 'settings' && (
        <div className="space-y-6">
          {/* Debug mode — this admin's full view vs the minimal view users see (owner 2026-10-16) */}
          <DebugModeSection />

          {/* Supervisors — the fleet / project supervisor OFF switches (owner 2026-09-26) */}
          <SupervisorsSection />
          <WebSearchSection />

          {/* Depth policy — the always-Auto switch patience_auto_only (audit 2026-09-26) */}
          <PatienceAutoOnlySection />

          {/* Deep Research Daily Limit */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-warn-ink" />
              <h3 className="text-sm font-semibold">Deep Research Daily Limit</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Max deep research (Patience 4) queries per user per day. Resets at midnight UTC.
            </p>
            <div className="flex items-center gap-3">
              <input type="number" min={0} max={1000} value={editLimit}
                onChange={(e) => setEditLimit(e.target.value)}
                className="w-24 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent" />
              <span className="text-xs text-muted-foreground">/ user / day</span>
              <button onClick={handleSaveLimit} disabled={saving || editLimit === currentLimit}
                className={cn('flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium transition-colors',
                  editLimit !== currentLimit ? 'bg-brand text-brand-foreground hover:bg-brand-hover' : 'bg-muted text-muted-foreground cursor-not-allowed')}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                Save
              </button>
            </div>
            {editLimit !== currentLimit && (
              <p className="text-xs text-warn-ink">Current: {currentLimit} &rarr; New: {editLimit}</p>
            )}
          </div>

          {/* All Settings */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Settings className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">All System Settings</h3>
            </div>
            {Object.keys(settings).length === 0 ? (
              <p className="text-xs text-muted-foreground">No settings configured.</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(settings).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                    <code className="text-xs font-mono text-muted-foreground">{key}</code>
                    <span className="text-sm font-medium">{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
