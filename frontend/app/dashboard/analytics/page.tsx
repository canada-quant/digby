'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '@/lib/api/analytics';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartConfig,
} from '@/components/ui/chart';
import { 
  LineChart, 
  Line, 
  AreaChart,
  Area,
  BarChart, 
  Bar, 
  PieChart, 
  Pie, 
  Cell,
  XAxis, 
  YAxis, 
  CartesianGrid,
} from 'recharts';
import { TrendingUp, Users, Activity, BarChart3 } from 'lucide-react';
import { format } from 'date-fns';

// Chart configurations for shadcn theming
const userGrowthConfig = {
  count: {
    label: "New Users",
    theme: {
      light: "#2563eb",
      dark: "#60a5fa",
    },
  },
} satisfies ChartConfig;

const activityConfig = {
  count: {
    label: "Activities",
    theme: {
      light: "#16a34a",
      dark: "#4ade80",
    },
  },
} satisfies ChartConfig;

const breakdownConfig = {
  count: {
    label: "Count",
    theme: {
      light: "#dc2626",
      dark: "#f87171",
    },
  },
} satisfies ChartConfig;

const featureConfig = {
  Users: { 
    label: "Users",
    theme: { light: "#2563eb", dark: "#60a5fa" }
  },
  "AI Chats": { 
    label: "AI Chats",
    theme: { light: "#16a34a", dark: "#4ade80" }
  },
  Content: { 
    label: "Content",
    theme: { light: "#dc2626", dark: "#f87171" }
  },
  Kanban: { 
    label: "Kanban",
    theme: { light: "#ea580c", dark: "#fb923c" }
  },
  CRM: { 
    label: "CRM",
    theme: { light: "#9333ea", dark: "#c084fc" }
  },
  Activities: { 
    label: "Activities",
    theme: { light: "#0891b2", dark: "#22d3ee" }
  },
} satisfies ChartConfig;

export default function AnalyticsPage() {
  const [days, setDays] = useState(30);

  const { data: overview, isLoading: loadingOverview } = useQuery({
    queryKey: ['analytics-overview'],
    queryFn: analyticsApi.getOverview,
  });

  const { data: userGrowth, isLoading: loadingGrowth } = useQuery({
    queryKey: ['analytics-user-growth', days],
    queryFn: () => analyticsApi.getUserGrowth({ days }),
  });

  const { data: activityData, isLoading: loadingActivity } = useQuery({
    queryKey: ['analytics-activity', days],
    queryFn: () => analyticsApi.getActivityOverview({ days }),
  });

  const { data: featureUsage, isLoading: loadingFeatures } = useQuery({
    queryKey: ['analytics-feature-usage'],
    queryFn: analyticsApi.getFeatureUsage,
  });

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx).
    <div className="h-dvh overflow-y-auto bg-background p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="text-muted-foreground">Track metrics and insights</p>
        </div>

        {/* Overview Stats */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Users</CardTitle>
              <Users className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingOverview ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{overview?.users.total || 0}</div>
                  <p className="text-xs text-muted-foreground">
                    +{overview?.users.active30d || 0} in last 30 days
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Users (7d)</CardTitle>
              <TrendingUp className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingOverview ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{overview?.users.active7d || 0}</div>
                  <p className="text-xs text-muted-foreground">Last 7 days</p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Activities</CardTitle>
              <Activity className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingOverview ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{overview?.activities.total || 0}</div>
                  <p className="text-xs text-muted-foreground">
                    {overview?.activities.today || 0} today
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Events</CardTitle>
              <BarChart3 className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {loadingOverview ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <div className="text-2xl font-bold">{overview?.events.total || 0}</div>
                  <p className="text-xs text-muted-foreground">Tracked events</p>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Time Range Selector */}
        <Tabs value={days.toString()} onValueChange={(v) => setDays(parseInt(v))}>
          <TabsList>
            <TabsTrigger value="7">7 Days</TabsTrigger>
            <TabsTrigger value="30">30 Days</TabsTrigger>
            <TabsTrigger value="90">90 Days</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Charts Grid */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* User Growth Chart */}
          <Card>
            <CardHeader>
              <CardTitle>User Growth</CardTitle>
              <CardDescription>New user registrations over time</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingGrowth ? (
                <Skeleton className="h-[300px] w-full" />
              ) : (
                <ChartContainer config={userGrowthConfig} className="h-[300px]">
                  <LineChart data={userGrowth?.data || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(value) => format(new Date(value), 'MMM dd')}
                    />
                    <YAxis />
                    <ChartTooltip 
                      content={<ChartTooltipContent />}
                      labelFormatter={(value) => format(new Date(value), 'MMM dd, yyyy')}
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Line 
                      type="monotone" 
                      dataKey="count" 
                      stroke="var(--color-count)" 
                      strokeWidth={2}
                    />
                  </LineChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          {/* Activity Timeline */}
          <Card>
            <CardHeader>
              <CardTitle>Activity Timeline</CardTitle>
              <CardDescription>User activities over time</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingActivity ? (
                <Skeleton className="h-[300px] w-full" />
              ) : (
                <ChartContainer config={activityConfig} className="h-[300px]">
                  <AreaChart data={activityData?.timeline || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(value) => format(new Date(value), 'MMM dd')}
                    />
                    <YAxis />
                    <ChartTooltip 
                      content={<ChartTooltipContent />}
                      labelFormatter={(value) => format(new Date(value), 'MMM dd, yyyy')}
                    />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Area 
                      type="monotone" 
                      dataKey="count" 
                      stroke="var(--color-count)" 
                      fill="var(--color-count)"
                      fillOpacity={0.2}
                    />
                  </AreaChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          {/* Feature Usage Pie Chart */}
          <Card>
            <CardHeader>
              <CardTitle>Feature Usage</CardTitle>
              <CardDescription>Distribution across features</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingFeatures ? (
                <Skeleton className="h-[300px] w-full" />
              ) : (
                <ChartContainer config={featureConfig} className="h-[300px]">
                  <PieChart>
                    <Pie
                      data={featureUsage || []}
                      dataKey="count"
                      nameKey="feature"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      label
                    >
                      {(featureUsage || []).map((entry) => {
                        // ChartContainer generates CSS variables based on the feature name
                        // e.g., --color-Users, --color-AI-Chats
                        const varName = entry.feature.replace(/\s+/g, '-');
                        return (
                          <Cell 
                            key={`cell-${entry.feature}`}
                            fill={`var(--color-${varName})`}
                          />
                        );
                      })}
                    </Pie>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                  </PieChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          {/* Activity Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>Activity Breakdown</CardTitle>
              <CardDescription>Actions by type</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingActivity ? (
                <Skeleton className="h-[300px] w-full" />
              ) : (
                <ChartContainer config={breakdownConfig} className="h-[300px]">
                  <BarChart data={activityData?.breakdown || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="action" />
                    <YAxis />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar dataKey="count" fill="var(--color-count)" />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}