'use client';

/**
 * MachineWakeBlock — Fleet Supervisor UX overhaul Phase C (goal 49dd1b20 /
 * todo 9cf23892): a machine-wake envelope (schedule firing / hook wake /
 * webhook fire — see lib/machine-wake.ts) renders as a ONE-LINE expandable
 * system row instead of a 100+-line user bubble.
 *
 * History: a previous attempt FILTERED these rows out of the transcript and
 * hid real owner messages (2026-08-26 regression). This component COLLAPSES,
 * never deletes — the full persisted payload is one click away, verbatim, and
 * persistence is untouched (presentation-layer only).
 *
 * Design notes:
 *  - Collapsed: full-width LEFT-aligned muted system row (deliberately NOT the
 *    right-aligned 75% user bubble — this is machine traffic, not the owner
 *    speaking). Single <button aria-expanded> row for a11y; variable parts
 *    truncate so the row never wraps or overflows on mobile.
 *  - Expanded: the full payload VERBATIM in a scrollable <pre> — NOT
 *    MarkdownContent (the envelope is a machine contract, not prose; fidelity
 *    beats prettiness here). Toggling restores the one-liner.
 *  - Collapse state is per component instance (the parent keys these rows like
 *    its other message rows), so a refetch never resets what the owner opened.
 */

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summarizeWakeEnvelope, summarizeSystemRow, type SystemRowKind } from '@/lib/machine-wake';
import { localizeUtcTimes } from '@/lib/localize-utc-times';
import AgentMessageCard from './AgentMessageCard';

/** Collapsed-row label per system-row kind (feedback 4959bb1c). */
const KIND_LABEL: Record<SystemRowKind, string> = {
  wake: '⚙ Machine wake',
  agent: '⇄ Agent message',
  system: '⚙ System message',
};

export default function MachineWakeBlock({
  content,
  timeLabel,
  kind = 'wake',
  origin,
  sourceChatId,
}: {
  content: string;
  timeLabel?: string;
  /** Which system row this is (default 'wake' — the Phase C behavior). */
  kind?: SystemRowKind;
  /** The backend origin stamp (shown on 'system' rows for transparency). */
  origin?: string;
  /** 'agent' rows: metadata.sourceChatId (full id) for the card's sender link. */
  sourceChatId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Agent-to-agent relays (owner ask 2026-09-14) render as a neutral card
  // with a "From <sender> · agent" header instead of the one-line pill —
  // every caller of this block (CodeSessionView, SupervisorChatTab, the dev
  // harness) gets the card without changing its call site.
  if (kind === 'agent') {
    return <AgentMessageCard content={content} sourceChatId={sourceChatId} timeLabel={timeLabel} />;
  }
  const { eventType, sourceTitle } = kind === 'wake'
    ? summarizeWakeEnvelope(content)
    : { eventType: undefined, sourceTitle: undefined };
  // Owner 2026-09-14: the envelope's harness clocks ("at 2026-09-14T14:41:21Z",
  // "14:41Z") read in the viewer's local time — parsing stays on the original.
  const shown = localizeUtcTimes(content);
  const preview = kind === 'wake' ? '' : summarizeSystemRow(shown);

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70',
          expanded && 'rounded-b-none'
        )}
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform duration-200', expanded && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium">{KIND_LABEL[kind]}</span>
        <span className="min-w-0 truncate">
          {eventType ? ` — fleet event (${eventType})` : ''}
          {sourceTitle ? ` from '${sourceTitle}'` : ''}
          {kind === 'system' && origin ? ` (${origin})` : ''}
          {preview ? ` — ${preview}` : ''}
          {timeLabel ? ` · ${timeLabel}` : ''}
        </span>
      </button>
      {expanded && (
        <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-b-lg border border-t-0 bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
          {shown}
        </pre>
      )}
    </div>
  );
}
