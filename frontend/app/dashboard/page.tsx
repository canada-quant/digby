'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { authApi, User } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { dashboardApi } from '@/lib/api/dashboard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Users, MessageSquare, TrendingUp, BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { RecentActivities } from './components/recent-activities';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoadingUser, setIsLoadingUser] = useState(true);

  const { data: stats, isLoading: isLoadingStats } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: dashboardApi.getStats,
    enabled: !!user,
  });

  useEffect(() => {
    const loadUser = async () => {
      try {
        const userData = await authApi.getCurrentUser();
        setUser(userData);
      } catch (error) {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and renders the empty dashboard.
        if (isDefinitiveAuthFailure(error)) router.push('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', error);
      } finally {
        setIsLoadingUser(false);
      }
    };

    loadUser();
  }, [router]);

  const handleLogout = async () => {
    try {
      await authApi.logout();
      toast.success('Logged out successfully');
      router.push('/login');
    } catch (error) {
      toast.error('Logout failed');
    }
  };

  if (isLoadingUser) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p>Loading...</p>
      </div>
    );
  }

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx).
    <div className="h-dvh overflow-y-auto bg-background p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground">Welcome back, {user?.firstName || user?.email}!</p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/dashboard/users">Users</Link>
            </Button>
            <Button onClick={handleLogout} variant="outline">
              Logout
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* Users Card */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoadingStats ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{stats?.users.total || 0}</div>
                  <p className="text-xs text-muted-foreground">
                    {stats?.users.active || 0} active in last 30 days
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* AI Chats Card */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">AI Chats</CardTitle>
              <MessageSquare className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoadingStats ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{stats?.chats.total || 0}</div>
                  <p className="text-xs text-muted-foreground">Total conversations</p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Growth Card */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">User Growth</CardTitle>
              <TrendingUp className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoadingStats ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">
                    {stats?.users.active && stats?.users.total 
                      ? Math.round((stats.users.active / stats.users.total) * 100) 
                      : 0}%
                  </div>
                  <p className="text-xs text-muted-foreground">Active rate</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Common tasks and navigation</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <Button asChild variant="outline" className="justify-start">
                <Link href="/dashboard/users">
                  <Users className="mr-2 size-4" />
                  Manage Users
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/dashboard/ai-chat">
                  <MessageSquare className="mr-2 size-4" />
                  AI Chat
                </Link>
              </Button>
              <Button asChild variant="outline" className="justify-start">
                <Link href="/dashboard/analytics">
                  <BarChart3 className="mr-2 size-4" />
                  Analytics
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activities and System Info */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Recent Activities */}
          <RecentActivities />

          {/* System Info */}
          <Card>
            <CardHeader>
              <CardTitle>System Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Your Role</p>
                  <p className="font-medium">{user?.role}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Email</p>
                  <p className="font-medium">{user?.email}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">User ID</p>
                  <p className="font-medium font-mono text-xs">{user?.id}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium text-ok">Active</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
