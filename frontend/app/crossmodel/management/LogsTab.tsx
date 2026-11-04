'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { fleetApi, type FleetLogRow } from '@/lib/api/fleet';
import { usePolling, isAbortError } from '@/lib/use-polling';
import { relativeTime } from '@/lib/relative-time';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { LOG_KIND_BADGE } from './utils';

const LOG_PAGE = 50;
/** Auto-refresh cadence — matches the Dashboard tab's poll. */
const POLL_MS = 20_000;

/** Kind badges — the shared variant-based map in ./utils (also used by the supervisor overview panel). */
const KIND_BADGE: Record<FleetLogRow['kind'], { label: string; variant: 'info' | 'warning' | 'success' | 'outline'; className?: string }> = LOG_KIND_BADGE;

export function LogsTab() {
  const [rows, setRows] = useState<FleetLogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Mirror for the background poll (its callback would otherwise close over
  // stale rows).
  const rowsRef = useRef<FleetLogRow[]>([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  /** Manual refresh — full reset back to the first page. */
  const refresh = useCallback(() => {
    setRefreshing(true);
    fleetApi.getFleetLog({ limit: LOG_PAGE })
      .then((page) => {
        setRows(page.messages);
        setHasMore(page.hasMore);
        setNextBefore(page.nextBefore);
        setError(null);
        setLoaded(true);
      })
      .catch(() => {
        // Honest failure — never render the "No activity yet" empty state
        // over an endpoint that errored.
        setError('Could not load fleet activity.');
        setLoaded(true);
      })
      .finally(() => setRefreshing(false));
  }, []);

  /**
   * Background poll — merges NEW head rows in without resetting the "Load
   * more" pagination the user may have walked into.
   */
  const pollNewest = useCallback((signal?: AbortSignal) => {
    fleetApi.getFleetLog({ limit: LOG_PAGE }, { signal })
      .then((page) => {
        const seen = new Set(rowsRef.current.map((r) => r.sourceId));
        const fresh = page.messages.filter((r) => !seen.has(r.sourceId));
        if (rowsRef.current.length === 0 || fresh.length === page.messages.length) {
          // Zero overlap with the loaded head means more than a full page
          // arrived since the last poll (hidden-tab catch-up) — the rows
          // between the fetched head and the known head are unreachable by
          // prepending, so reset to page 1 rather than silently omit them.
          setRows(page.messages);
          setHasMore(page.hasMore);
          setNextBefore(page.nextBefore);
        } else if (fresh.length > 0) {
          setRows((prev) => [...fresh, ...prev]);
        }
        setError(null);
        setLoaded(true);
      })
      .catch((err) => {
        if (isAbortError(err)) return; // superseded tick — never an error state
        setError('Could not refresh fleet activity.');
        setLoaded(true);
      });
  }, []);

  // Mount = one full first-page load; the background poll (usePolling, P5:
  // abortable ticks, hidden-tab pause + visible catch-up) merges new head rows
  // without resetting pagination. immediate:false — refresh() owns the mount load.
  useEffect(() => { refresh(); }, [refresh]);
  usePolling((signal) => pollNewest(signal), { intervalMs: POLL_MS, immediate: false });

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fleetApi.getFleetLog({ before: nextBefore, limit: LOG_PAGE });
      // APPEND older rows — sourceId dedupe guards against boundary overlap
      // from tie-safe cursors (sourceId is the server's dedupe key).
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.sourceId));
        return [...prev, ...page.messages.filter((r) => !seen.has(r.sourceId))];
      });
      setHasMore(page.hasMore);
      setNextBefore(page.nextBefore);
    } catch {
      toast.error('Could not load more activity.');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Everything, newest first — your messages, machine wakes, agent-to-agent sends, supervisor replies.
          Updates automatically.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs shrink-0"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCw className={`size-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Loaded-with-error: keep the last known rows visible, but say so. */}
      {error && rows.length > 0 && (
        <p className="text-xs text-destructive">{error} Showing the last loaded activity.</p>
      )}

      {!loaded ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 && error ? (
        <div className="text-center py-10 space-y-3">
          <p className="text-xs text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={refresh}>Retry</Button>
        </div>
      ) : rows.length === 0 ? (
        <Empty className="py-10 border-none">
          <EmptyHeader>
            <EmptyDescription className="text-xs">
              No activity yet — messages to and from your fleet will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-md border border-border divide-y divide-border">
          {rows.map((r) => {
            const kind = KIND_BADGE[r.kind] ?? KIND_BADGE.agent_message;
            return (
              <div key={r.sourceId} className="px-3 py-2 flex items-start gap-2 text-xs">
                <span
                  className="text-muted-foreground shrink-0 w-16 pt-0.5"
                  title={new Date(r.at).toLocaleString()}
                >
                  {relativeTime(r.at)}
                </span>
                <Badge variant={kind.variant} className={`text-[10px] shrink-0 ${kind.className ?? ''}`}>
                  {kind.label}
                </Badge>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {r.from} → {r.to}
                  </span>
                  <p className="text-xs line-clamp-2 break-words" title={r.summary}>
                    {r.summary}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {loaded && hasMore && (
        <div className="text-center">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore
              ? <span className="flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />Loading…</span>
              : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
