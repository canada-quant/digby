'use client';

/**
 * Building blocks shared by the Project / Fleet supervisor side panels (2026-10-08): a quiet section with a
 * header, stat tiles, a 14-day bar strip, a status dot and the number formatters. Frontier tokens only.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { UsageDay } from '@/lib/api/supervisor-usage';

export function PanelSection({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-medium text-ink-2">{title}</h3>
        {aside ? <div className="text-[12px] text-ink-3">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-raised px-2.5 py-2">
      <div className="truncate text-[11px] text-ink-3">{label}</div>
      <div className="truncate text-[15px] font-medium tabular-nums text-ink">{value}</div>
      {sub ? <div className="truncate text-[11px] text-ink-3 tabular-nums">{sub}</div> : null}
    </div>
  );
}

/** 14 thin bars, oldest → newest; height ∝ USD (tokens when no spend is recorded). */
export function DailyBars({ days }: { days: UsageDay[] }) {
  const useUsd = days.some(d => d.usd > 0);
  const val = (d: UsageDay) => (useUsd ? d.usd : d.tokens);
  const max = Math.max(0, ...days.map(val));
  return (
    <div className="flex h-10 items-end gap-[3px]" data-usage-bars aria-label="Daily usage, last 14 days">
      {days.map(d => {
        const v = val(d);
        const pct = max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 4;
        return (
          <div
            key={d.date}
            title={`${d.date} · ${fmtUsd(d.usd)} · ${fmtTokens(d.tokens)} tokens`}
            className={cn('flex-1 rounded-[2px]', v > 0 ? 'bg-ink-3/70' : 'bg-line')}
            style={{ height: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}

export type DotTone = 'running' | 'scheduled' | 'idle' | 'blocked' | 'done';

export function StatusDot({ tone }: { tone: DotTone }) {
  const cls: Record<DotTone, string> = {
    running: 'bg-success dg-pulse',
    scheduled: 'bg-ink-3',
    idle: 'bg-line-2',
    blocked: 'bg-warn',
    done: 'bg-success',
  };
  return <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', cls[tone])} />;
}

export function fmtUsd(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!n) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function fmtTokens(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

/** "4m ago" / "3h ago" / "2d ago" from seconds. */
export function fmtAgeSec(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

/** "in 14m" / "in 3h" / "overdue" from an ISO time. */
export function fmtUntil(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  if (m < 1440) return `in ${Math.round(m / 60)}h`;
  return `in ${Math.round(m / 1440)}d`;
}

/** "every 2h" / "every 30m" / "once". */
export function fmtCadence(kind: string, intervalSec: number | null | undefined): string {
  if (kind !== 'recurring' || !intervalSec) return 'once';
  if (intervalSec % 86400 === 0) return `every ${intervalSec / 86400}d`;
  if (intervalSec % 3600 === 0) return `every ${intervalSec / 3600}h`;
  return `every ${Math.round(intervalSec / 60)}m`;
}

export function EmptyLine({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[12px] text-ink-3">{children}</div>;
}
