'use client';

import { type JobHealthData } from '@/lib/api/crossmodel';
import { Badge } from '@/components/ui/badge';
import { Activity, RefreshCw, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

type Props = {
  jh: JobHealthData | null;
  loading: boolean;
  onRefresh: () => void;
};

/**
 * JobsSection — deploy status, error monitoring, and ticket pipeline telemetry
 * for the admin panel.
 */
export default function JobsSection({ jh, loading, onRefresh }: Props) {
  const deployHealthy = jh?.deployHealth?.status === 'healthy';
  const frontendCode = jh?.deployHealth?.frontendCode;
  const backendCode = jh?.deployHealth?.backendCode;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Jobs & Health
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Deploy status, error monitoring, and ticket pipeline overview.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border hover:bg-muted disabled:opacity-50"
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          Refresh
        </button>
      </div>

      {!jh && !loading && (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No data loaded yet — tap Refresh to check system health.
        </div>
      )}

      {loading && !jh && (
        <div className="rounded-lg border p-6 text-center">
          <Loader2 className="size-5 animate-spin mx-auto text-muted-foreground" />
          <p className="text-xs text-muted-foreground mt-2">Running health checks…</p>
        </div>
      )}

{jh && (
        <>
          {/* Deploy health */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {deployHealthy ? (
                <CheckCircle2 className="size-4 text-success-accent" />
              ) : (
                <AlertCircle className="size-4 text-destructive" />
              )}
              <span className="text-sm font-medium">
                Production: {jh.deployHealth?.status ?? 'unknown'}
              </span>
              {typeof frontendCode === 'number' && (
                <span className="text-xs text-muted-foreground">FE {frontendCode}</span>
              )}
              {typeof backendCode === 'number' && (
                <span className="text-xs text-muted-foreground">BE {backendCode}</span>
              )}
            </div>
            {jh.deployHealth?.checkedAt && (
              <p className="text-[11px] text-muted-foreground">
                Checked {new Date(jh.deployHealth.checkedAt).toLocaleString()}
              </p>
            )}
          </div>

          {/* Error summary */}
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <AlertCircle
                  className={`size-4 ${jh.errorSummary?.errorSpike ? 'text-destructive' : 'text-muted-foreground'}`}
                />
                <span className="text-sm font-medium">Error logs</span>
                {jh.errorSummary?.errorSpike && (
                  <Badge variant="destructive" className="text-[10px] px-1.5 py-0.5">
                    Spike detected
                  </Badge>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground">1h errors</div>
                <div className="text-lg font-semibold">{jh.errorSummary?.last1h?.error ?? 0}</div>
              </div>
              <div>
                <div className="text-muted-foreground">24h errors</div>
                <div className="text-lg font-semibold">{jh.errorSummary?.last24h?.error ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">
                  {jh.errorSummary?.last24h?.warn ?? 0} warnings
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">7d errors</div>
                <div className="text-lg font-semibold">{jh.errorSummary?.last7d?.error ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">
                  {jh.errorSummary?.last7d?.warn ?? 0} warnings
                </div>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Avg {(jh.errorSummary?.avgErrorsPerHour ?? 0).toFixed(1)} errors/hr
            </div>
          </div>

          {/* Ticket pipeline */}
          {jh.ticketPipeline && (
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-3">
                <Activity className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Ticket pipeline</span>
              </div>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div>
                  <div className="text-muted-foreground">Open</div>
                  <div className="text-lg font-semibold">{jh.ticketPipeline.open ?? 0}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">In progress</div>
                  <div className="text-lg font-semibold">{jh.ticketPipeline.inProgress ?? 0}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Done (7d)</div>
                  <div className="text-lg font-semibold">{jh.ticketPipeline.done7d ?? 0}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Total</div>
                  <div className="text-lg font-semibold">{jh.ticketPipeline.total ?? 0}</div>
                </div>
              </div>
            </div>
          )}

          {/* Recent errors */}
          {Array.isArray(jh.recentErrors) && jh.recentErrors.length > 0 && (
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Recent errors</span>
              </div>
              <div className="space-y-2">
                {jh.recentErrors.slice(0, 5).map((err) => (
                  <div key={err.id} className="text-xs">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={err.level === 'error' ? 'destructive' : 'warning'}
                        className="text-[10px] px-1.5 py-0.5"
                      >
                        {err.level}
                      </Badge>
                      {err.source && <span className="text-muted-foreground">{err.source}</span>}
                      <span className="text-muted-foreground ml-auto">
                        {new Date(err.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="mt-0.5 text-muted-foreground truncate">{err.message}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}
