'use client';

/**
 * MachineTurnGroup — the accordion wrapper for ONE machine run's collapsed
 * turn (lib/machine-turn-grouping.ts, platform task 2026-09-02; per-wake
 * regrouping 2026-09-03 after the #604 mega-accordion report). Each schedule/
 * hook/webhook wake gets its OWN accordion — never one spanning multiple
 * runs — and the ENTIRE turn folds in, final note included (the 2026-09-03
 * owner directive); the note's first line headlines the label.
 *
 * The header is the scannable history line the owner asked for:
 *   ⚙ 10:05 PM — Fleet wake — 2 lane completions, both no-ops · +14 detail rows
 * (time of the wake, the summary note's headline, the folded-row count), so
 * the transcript's story is readable WITHOUT opening anything; expansion
 * reveals ONLY this run's turn, verbatim, via the caller's per-row renderer.
 * "Detail rows" is what the fold actually holds: the wake envelope, verifier/
 * relay chrome, AND the run's final status note — not chrome alone.
 *
 * Semantic tinting (owner polish pass 2026-09-03): the collapsed row carries
 * a render-time tone from the SHARED classifyWakeHeadline (lib/fleet-summary
 * — the same function that tints the dashboard FleetSummaryCard, so the two
 * surfaces can never drift): 'quiet' dims (no accent), 'attention' gets a
 * warm left border + faint warm bg, 'action' gets the Fleet-summary card's
 * indigo left border. Subtle by design — row height and typography are
 * untouched. A headline-less (chrome-only) run stays neutral: with no note
 * there is no verdict to tint by.
 *
 * Same conservative discipline as MachineWakeBlock: COLLAPSE, never filter.
 * Human rows never enter a group, so this can never hide the owner or a
 * teammate. Collapse state is per component instance (the parent keys groups
 * by their first row's id), so a refetch never resets what the owner opened.
 * defaultExpanded mounts the group open (the dashboard card's click-through
 * anchors into one specific wake); groupKey stamps data-group-key for that
 * scroll target.
 */

import { useEffect, useState } from 'react';
import { BellRing, ChevronRight, Cog, GitBranch, Image as ImageIcon, Reply } from 'lucide-react';
import { cn } from '@/lib/utils';
import { classifyWakeHeadline, type WakeTone } from '@/lib/fleet-summary';
import { localizeUtcTimes } from '@/lib/localize-utc-times';

/** Tone → collapsed-row styling. Full literal class strings (Tailwind JIT). */
const TONE_ROW_CLS: Record<WakeTone, string> = {
  quiet: 'text-muted-foreground/70',
  attention: 'border-l-2 border-l-warn/70 bg-warn/5',
  action: 'border-l-2 border-l-line-2/60 bg-send/5',
};

/** Owner-armed (ticket 6ef770a1): the header chip that distinguishes an
 *  owner-armed scheduled digest (promptSetBy 'user') from internal wake
 *  noise. Digby Frontier (2026-10-06): NEUTRAL tokens — no violet in chat
 *  chrome; the ink-3 left rule + a hover-tint row still mark it distinct
 *  (and no raw violet-* utilities either — p3-token-guards). */
const OWNER_ARMED_ROW_CLS = 'border-l-2 border-l-ink-3/60 bg-hover/40';

export default function MachineTurnGroup({
  count,
  summary,
  headline,
  timeLabel,
  defaultExpanded,
  ownerArmed,
  childResult,
  ownerAskReply,
  hasImage,
  groupKey,
  children,
}: {
  /** Collapsed rows in this run (≥1). */
  count: number;
  /** Fallback label: the wake's "eventType from 'source'" or the kind label. */
  summary: string;
  /** The run's final note's first line ('' when the run has none). */
  headline: string;
  timeLabel?: string;
  /** Mount expanded (dashboard Fleet-summary click-through anchor). */
  defaultExpanded?: boolean;
  /** Ticket 6ef770a1: the group's anchor row is an owner-armed schedule wake
   *  (metadata.scheduleOwnerArmed) — mounts expanded AND renders the
   *  "requested" marker so owner-requested content is visually distinct from
   *  internal wake noise. Owner-armed tints with its own accent; a tone may
   *  still apply underneath, the violet marker wins the left border. */
  ownerArmed?: boolean;
  /** Ticket 56d6b204: the group's anchor row is a child→parent RESULT-hook
   *  wake (metadata.childResult — the parent SPAWNED the sub-session and is
   *  waiting on its verdict). Mounts EXPANDED and renders a "results" chip:
   *  the sub-session's delivered work is content the owner asked for, never
   *  internal wake noise to fold behind the collapsed pill (the 2026-09-25
   *  incident, chat 6e36c834 — "hidden in a machine accordion"). */
  childResult?: boolean;
  /** Fixer 2026-09-27 (tt-rd audit, finding upward-chatter-1): the group's
   *  anchor row is an [OWNER ASK UNANSWERED] re-wake / [FOLLOW-THROUGH] nudge
   *  (metadata.ownerAskReply) — the wake exists to answer a question the
   *  owner typed. Mounts EXPANDED and renders an "answer" chip: the reply is
   *  the answer the owner is waiting on, never noise to fold away (the audit's
   *  871d203b case — the re-wake's answer was folded and never seen). */
  ownerAskReply?: boolean;
  /** Ticket 390b6767: ANY row in this run carries a deliverable inline image
   *  (markdown image/link on an inline byte route, an image chip, or an image
   *  part). Mounts EXPANDED and renders an image chip on the pill — a
   *  delivered image is content to SEE, never noise folded out of sight (the
   *  owner's invisible-test-image report: the delivery note collapsed into
   *  the machine accordion and the image only appeared after a manual
   *  re-share). */
  hasImage?: boolean;
  /** Stamped as data-group-key on the wrapper for scroll-into-view anchors. */
  groupKey?: string;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(!!defaultExpanded || !!ownerArmed || !!hasImage || !!childResult || !!ownerAskReply);
  // Review finding (ticket 390b6767): the image signal typically arrives on
  // the run's LAST row while this group instance (keyed by the FIRST row) is
  // already mounted on a live session — useState only reads the initial
  // value, so a note appended into an existing run stayed collapsed until a
  // reload. Expand when hasImage flips on (a later manual collapse wins: the
  // effect only fires on the false→true transition, not on re-renders).
  useEffect(() => {
    if (hasImage) setExpanded(true);
  }, [hasImage]);
  // Ticket 56d6b204, same late-arrival shape: the child-result wake row
  // (the anchor) arrives BEFORE the run's final assistant reply holding the
  // sub-session's results — the group instance keyed by the anchor is already
  // mounted when the flag-bearing row lands, so the initial useState read
  // alone would leave the delivered results collapsed until a reload.
  useEffect(() => {
    if (childResult) setExpanded(true);
  }, [childResult]);
  // Fixer 2026-09-27, same late-arrival shape: the owner-ask wake anchor lands
  // before the answering reply — expand when the flag flips on.
  useEffect(() => {
    if (ownerAskReply) setExpanded(true);
  }, [ownerAskReply]);
  // Owner 2026-09-14: a headline like "WAKE — 03:43Z. No-op" reads in the
  // viewer's local time (the tone classifier still sees the original).
  const label = localizeUtcTimes(headline || summary);
  // Neutral (null) when the run produced no headline — no verdict, no tint.
  const tone: WakeTone | null = headline ? classifyWakeHeadline(headline) : null;
  const rowsLabel = `detail row${count === 1 ? '' : 's'}`;
  return (
    <div className="w-full min-w-0" {...(groupKey ? { 'data-group-key': groupKey } : {})}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/70',
          tone && TONE_ROW_CLS[tone],
          ownerArmed && OWNER_ARMED_ROW_CLS,
          expanded && 'rounded-b-none'
        )}
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform duration-200', expanded && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium"><Cog className="inline size-3 -mt-0.5 mr-0.5" aria-hidden="true" />{timeLabel ? `${timeLabel} — ` : ''}{label || 'machine turns'}</span>
          <span className="opacity-70"> · {expanded ? `${count} ${rowsLabel}` : `+${count} ${rowsLabel}`}</span>
        </span>
        {hasImage && (
          <span
            data-group-image
            title="This machine turn delivers an image — shown expanded"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2"
          >
            <ImageIcon className="size-2.5" aria-hidden="true" />image
          </span>
        )}
        {ownerArmed && (
          <span
            data-owner-armed
            title="You asked for this — fired by a schedule you set"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2"
          >
            <BellRing className="size-2.5" aria-hidden="true" />requested
          </span>
        )}
        {childResult && (
          <span
            data-child-result
            title="Results from a session you requested — shown expanded"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2"
          >
            <GitBranch className="size-2.5" aria-hidden="true" />results
          </span>
        )}
        {ownerAskReply && (
          <span
            data-owner-ask-reply
            title="The answer to a question you asked — shown expanded"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2"
          >
            <Reply className="size-2.5" aria-hidden="true" />answer
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-3 rounded-b-lg border border-t-0 bg-muted/20 px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}
