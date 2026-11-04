'use client';

import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Honest load-failure state — shown instead of empty/"not connected" states
 * when a fetch errored, so an outage never masquerades as "no data".
 * Pattern source: management LogsTab / DashboardTab error+Retry blocks.
 */
export function LoadErrorState({
  message = "Couldn't load this — check your connection and try again.",
  onRetry,
  retrying,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'py-12 px-4 text-center space-y-3 flex flex-col items-center',
        className,
      )}
    >
      <div className="size-10 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
        <CircleAlert className="size-5" aria-hidden />
      </div>
      <p className="text-sm text-foreground max-w-sm text-balance">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} className="min-h-10">
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </div>
  );
}
