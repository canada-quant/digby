'use client';

/**
 * MachineBundle — ONE row for a stretch of background machine activity
 * between two visible rows (owner 2026-09-29, the digby-benchmarks recording:
 * "we need to hide a lot more machine messages"). The collapsed row reads
 *   ⚙ 3 background check-ins · 9:16 PM – 11:16 PM · latest: Sweep complete …
 * and expanding it renders the per-wake MachineTurnGroup pills the caller
 * passes as children, exactly as they rendered before bundling. A bundle that
 * holds the dashboard's click-through target mounts expanded (defaultExpanded).
 * lib/machine-turn-grouping.ts bundleMachineGroups decides what bundles.
 */

import { useState, type ReactNode } from 'react';
import { ChevronRight, Cog } from 'lucide-react';
import { cn } from '@/lib/utils';
import { localizeUtcTimes } from '@/lib/localize-utc-times';

/** "3 background check-ins · 9:16 PM – 11:16 PM · 2 messages between agents · 1 flagged a problem" — pure. */
export function bundleLabel(b: { groups: number; firstTime?: string; lastTime?: string; attention: number; agentMessages?: number }): string {
  const parts = [`${b.groups} background check-in${b.groups === 1 ? '' : 's'}`];
  if (b.firstTime && b.lastTime && b.firstTime !== b.lastTime) parts.push(`${b.firstTime} – ${b.lastTime}`);
  else if (b.firstTime) parts.push(b.firstTime);
  if (b.agentMessages && b.agentMessages > 0) parts.push(`${b.agentMessages} message${b.agentMessages === 1 ? '' : 's'} between agents`);
  if (b.attention > 0) parts.push(`${b.attention} flagged a problem`);
  return parts.join(' · ');
}

export default function MachineBundle({
  groups,
  firstTime,
  lastTime,
  attention,
  agentMessages,
  latest,
  defaultExpanded,
  children,
}: {
  groups: number;
  firstTime?: string;
  lastTime?: string;
  attention: number;
  agentMessages?: number;
  latest?: string;
  defaultExpanded?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const latestText = latest ? localizeUtcTimes(latest) : '';
  return (
    <div className="w-full min-w-0" data-machine-bundle>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-dashed bg-transparent px-3 py-1.5 text-left text-[11px] text-muted-foreground/80 transition-colors hover:bg-muted/40',
          attention > 0 && 'border-l-2 border-l-warn/70',
          expanded && 'rounded-b-none',
        )}
      >
        <ChevronRight className={cn('size-3 shrink-0 transition-transform duration-200', expanded && 'rotate-90')} aria-hidden="true" />
        <Cog className="size-3 shrink-0" aria-hidden="true" />
        <span className="shrink-0 whitespace-nowrap font-medium">{bundleLabel({ groups, firstTime, lastTime, attention, agentMessages })}</span>
        {latestText && !expanded && <span className="min-w-0 flex-1 truncate opacity-80">· latest: {latestText}</span>}
      </button>
      {expanded && (
        <div className="space-y-2 rounded-b-lg border border-t-0 border-dashed px-2 py-2">
          {children}
        </div>
      )}
    </div>
  );
}
