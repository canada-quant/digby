'use client';

import { useQuery } from '@tanstack/react-query';
import { dashboardApi, Activity } from '@/lib/api/dashboard';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { relativeTimeLong } from '@/lib/relative-time';
import { 
  Activity as ActivityIcon, 
  User, 
  MessageSquare, 
  FileText, 
  Contact, 
  LayoutGrid,
  LogIn,
  LogOut,
  UserPlus,
  Edit,
  Trash
} from 'lucide-react';

// Map action types to icons
const getActionIcon = (action: string) => {
  const iconMap: Record<string, any> = {
    login: LogIn,
    logout: LogOut,
    register: UserPlus,
    create_user: UserPlus,
    update_user: Edit,
    delete_user: Trash,
    create_chat: MessageSquare,
    create_content: FileText,
    create_contact: Contact,
    create_board: LayoutGrid,
    update: Edit,
    delete: Trash,
  };

  const Icon = iconMap[action.toLowerCase()] || ActivityIcon;
  return <Icon className="size-4" />;
};

// Get action color for badge
const getActionColor = (action: string) => {
  if (action.includes('create') || action.includes('register')) return 'default';
  if (action.includes('update') || action.includes('edit')) return 'secondary';
  if (action.includes('delete')) return 'destructive';
  if (action.includes('login')) return 'outline';
  return 'secondary';
};

// Format action text for display
const formatAction = (action: string) => {
  return action
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export function RecentActivities() {
  const { data: activities, isLoading, refetch } = useQuery({
    queryKey: ['dashboard-activities'],
    queryFn: () => dashboardApi.getRecentActivities(15),
    refetchInterval: 30000, // Auto-refresh every 30 seconds
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest actions across the system</CardDescription>
          </div>
          <Badge variant="outline" className="h-6">
            Live
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start gap-4">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : activities && activities.length > 0 ? (
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-4">
              {activities.map((activity: Activity) => (
                <div
                  key={activity.id}
                  className="flex items-start gap-4 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                >
                  {/* Icon */}
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    {getActionIcon(activity.action)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">
                        {activity.user.name || activity.user.email}
                      </p>
                      <Badge variant={getActionColor(activity.action) as any} className="h-5 text-xs">
                        {formatAction(activity.action)}
                      </Badge>
                    </div>
                    
                    {/* Metadata */}
                    {activity.metadata && Object.keys(activity.metadata).length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {JSON.stringify(activity.metadata, null, 0).substring(0, 100)}
                      </p>
                    )}
                    
                    {/* Timestamp */}
                    <p className="text-xs text-muted-foreground">
                      {relativeTimeLong(activity.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex h-[200px] items-center justify-center text-center">
            <div className="space-y-2">
              <ActivityIcon className="mx-auto size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No recent activities</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}