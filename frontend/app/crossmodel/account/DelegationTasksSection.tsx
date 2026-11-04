'use client';

/**
 * Admin → Jobs → "Delegation ledger" (build 2026-10-08 D). A read-only view of
 * the SHADOW delegation task ledger — one row per delegated piece of work
 * (sub-sessions, asks to other chats, ticket lanes, background workers,
 * schedule firings, continuations) in ONE state vocabulary — plus the
 * tool-intent journal's last 24 h (side-effecting calls with idempotency keys;
 * "would skip" = what act mode would have skipped on a resumed / requeued
 * attempt). Nothing reads either table to decide anything yet: this panel and
 * the nightly reconcile line are the measurement window before stage 2.
 */

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Loader2, Network, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { relativeTime } from '@/lib/relative-time';
import {
  delegationTasksApi, reconcileLine, DELEGATION_KINDS,
  type DelegationLedgerData,
} from '@/lib/api/delegation-tasks';

const STATE_FILTERS = ['', 'open', 'submitted', 'working', 'input_required', 'completed', 'failed', 'canceled'] as const;

export function DelegationTasksSection() {
  const [data, setData] = useState<DelegationLedgerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setData(await delegationTasksApi.list({ kind: kind || undefined, state: state || undefined, stale: staleOnly, limit: 50 }));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [kind, state, staleOnly]);

  useEffect(() => { void load(); }, [load]);

  const s = data?.summary;
  const ti = data?.toolIntents;

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4" data-testid="delegation-ledger">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Delegation ledger</h3>
          <Badge variant="outline">shadow</Badge>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Every piece of delegated work in one place: sub-sessions, asks to other chats, ticket lanes, background workers,
        schedule firings and continuations. Recorded only — nothing acts on it yet.
      </p>

      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          <div><div className="text-xl font-semibold tabular-nums">{s.total}</div><div className="text-[10px] text-muted-foreground">tasks ({Math.round(s.hours / 24)} d)</div></div>
          <div><div className="text-xl font-semibold tabular-nums">{s.open}</div><div className="text-[10px] text-muted-foreground">open</div></div>
          <div><div className="text-xl font-semibold tabular-nums">{s.stale}</div><div className="text-[10px] text-muted-foreground">stale (past TTL)</div></div>
          <div><div className="text-xl font-semibold tabular-nums">{s.duplicateKeys}</div><div className="text-[10px] text-muted-foreground">duplicate keys</div></div>
        </div>
      )}
      {data && <p className="text-xs text-muted-foreground" data-testid="delegation-reconcile-line">{reconcileLine(data.lastReconcile)}</p>}
      {ti && (
        <p className="text-xs text-muted-foreground" data-testid="tool-intent-line">
          Side-effecting calls (24 h): {ti.total} · applied {ti.byState.applied ?? 0} · would skip {ti.byVerdict.skip_applied ?? 0} ·
          would read back {ti.byVerdict.reconcile_lookup ?? 0} · never resend {ti.byVerdict.unknown_never_resend ?? 0} · in flight &gt; 1 h {ti.orphanPending}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-md border bg-background px-2 py-1">
          <option value="">All kinds</option>
          {DELEGATION_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
        </select>
        <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className="rounded-md border bg-background px-2 py-1">
          {STATE_FILTERS.map((k) => <option key={k} value={k}>{k ? k.replace(/_/g, ' ') : 'All states'}</option>)}
        </select>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={staleOnly} onChange={(e) => setStaleOnly(e.target.checked)} /> stale only
        </label>
      </div>

      {!loading && error && <p className="text-xs text-destructive">Could not load the delegation ledger.</p>}
      {!loading && !error && data && data.tasks.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="delegation-ledger-empty">
          <Inbox className="size-4" /> No delegation tasks match.
        </div>
      )}
      {data && data.tasks.length > 0 && (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                <th className="text-left px-2 py-1.5 font-medium">Kind</th>
                <th className="text-left px-2 py-1.5 font-medium">State</th>
                <th className="text-left px-2 py-1.5 font-medium">From → to</th>
                <th className="text-left px-2 py-1.5 font-medium">Brief</th>
                <th className="text-left px-2 py-1.5 font-medium">Last change</th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={t.id} className="border-t align-top" data-testid="delegation-task-row">
                  <td className="px-2 py-1.5 whitespace-nowrap">{t.kind.replace(/_/g, ' ')}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <Badge variant="outline">{t.state.replace(/_/g, ' ')}</Badge>
                    {t.stale && <Badge variant="outline" className="ml-1">stale</Badge>}
                    {t.duplicateOfId && <Badge variant="outline" className="ml-1">duplicate</Badge>}
                  </td>
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap">
                    {(t.parentChatId ?? '—').slice(0, 8)} → {(t.childChatId ?? t.childRef ?? '—').slice(0, 8)}
                  </td>
                  <td className="px-2 py-1.5 max-w-[24rem] break-words">{t.brief ?? ''}{t.reason ? ` (${t.reason})` : ''}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{t.lastEventAt ? relativeTime(t.lastEventAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
