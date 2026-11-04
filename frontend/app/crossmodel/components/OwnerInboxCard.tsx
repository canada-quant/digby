'use client';

/**
 * OwnerInboxCard — an `[Owner inbox] …` assistant note (metadata.origin
 * 'owner-inbox' or the position-0 prefix; backend platform/owner-questions.ts
 * + pending-confirmations.ts). Owner ask 2026-09-14: these rendered as a wall
 * of text.
 *
 * Collapsed (default): the title — "Owner inbox — the Fleet Supervisor
 * answered a lane's question" or the row's first clause — plus the question's
 * first line and the answer's first line. Expanded: labelled sections
 * (Question / Answer / Answered by / Rationale / Note) parsed by
 * lib/machine-wake.ts parseOwnerInboxNote; a note with no Q/A shape falls
 * back to its verbatim text so nothing is ever hidden for good.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, Inbox } from 'lucide-react';
import { parseOwnerInboxNote } from '@/lib/machine-wake';
import { localizeUtcTimes } from '@/lib/localize-utc-times';

function firstLine(s?: string): string {
  if (!s) return '';
  const l = s.split('\n').map((x) => x.trim()).find((x) => x.length > 0) || '';
  return l.replace(/\s+/g, ' ');
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-ink-3">{label}</dt>
      <dd className="whitespace-pre-wrap text-xs text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export default function OwnerInboxCard({ content, timeLabel }: { content: string; timeLabel?: string }) {
  const [open, setOpen] = useState(false);
  // Owner 2026-09-14: inbox answers quote the harness clock — show local time.
  const p = parseOwnerInboxNote(localizeUtcTimes(content));
  const q = firstLine(p.question);
  const a = firstLine(p.answer);
  const hasParsed = !!(p.question || p.answer || p.answeredBy || p.rationale || p.note);

  return (
    <div className="w-full min-w-0 rounded-xl border border-line bg-bg-2 px-3 py-2 text-xs font-sans" data-owner-inbox>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-start gap-1.5 text-left"
      >
        <Inbox className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground [overflow-wrap:anywhere]">{p.title}</span>
          {q && (
            <span className="block truncate text-muted-foreground"><span className="font-medium">Q:</span> {q}</span>
          )}
          {a && (
            <span className="block truncate text-muted-foreground"><span className="font-medium">A:</span> {a}</span>
          )}
          {!q && !a && !open && (
            <span className="block truncate text-muted-foreground">{firstLine(p.rest)}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground/70">
          {timeLabel && <span className="hidden sm:inline text-[10px]">{timeLabel}</span>}
          {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
        </span>
      </button>
      {open && (
        <dl className="mt-2 space-y-2 border-t border-border/60 pt-2">
          {p.question && <Section label="Question">{p.question}</Section>}
          {p.answer && <Section label="Answer">{p.answer}</Section>}
          {p.answeredBy && (
            <Section label="Answered by">{p.answeredBy}{p.under ? <span className="text-muted-foreground"> — under {p.under}</span> : null}</Section>
          )}
          {p.rationale && <Section label="Rationale">{p.rationale}</Section>}
          {p.note && <Section label="Note">{p.note}</Section>}
          {hasParsed
            ? <Section label="Full text"><span className="text-muted-foreground">{p.rest}</span></Section>
            : <Section label="Details">{p.rest}</Section>}
        </dl>
      )}
    </div>
  );
}
