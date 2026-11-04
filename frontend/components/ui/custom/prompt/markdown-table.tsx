'use client';

/**
 * The ONE markdown table renderer (UI overhaul Phase 4).
 *
 * Four byte-alike copies of the react-markdown table override lived in
 * markdown-content, help-markdown, CanvasPanel, and the public shared-chat
 * page — and the shared-chat copy had silently dropped the iOS momentum-scroll
 * fix. All four now spread `markdownTableComponents()` so the scroll container
 * (and the `WebkitOverflowScrolling: 'touch'` fix) exists exactly once.
 *
 * Plain HTML on purpose — NOT the shadcn <Table>: its own scroll wrapper
 * nests a second scroll container inside ours and breaks iOS scrolling.
 */

import type { ComponentProps, ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';

/** Scroll-contained table wrapper — the single home of the iOS momentum fix. */
export function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    // Digby Frontier (2026-10-06): radius 14, 1px line, raised bg, hairline
    // rows, tabular figures — no tinted header, no shadow.
    <div className="my-4 rounded-[14px] border border-line bg-raised overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
      <table className="w-full caption-bottom font-sans text-[13.5px] leading-normal tabular-nums min-w-[420px]">{children}</table>
    </div>
  );
}

const TH_BASE =
  'px-3.5 py-[11px] text-left align-bottom font-semibold text-ink whitespace-normal break-words';
const TD_BASE = 'px-3.5 py-[11px] align-top text-ink whitespace-normal break-words';

/**
 * The full table slice of a react-markdown `components` map. Spread it into a
 * surface's map; `thClassName`/`tdClassName` are the per-surface text-size
 * knobs (e.g. 'text-sm', 'text-xs sm:text-sm').
 *
 * Callers that memoize their components map (markdown-content, help-markdown)
 * call this INSIDE their useMemo so the renderer entries stay referentially
 * stable — a fresh entry per render remounts the whole markdown DOM.
 */
export function markdownTableComponents(opts?: {
  thClassName?: string;
  tdClassName?: string;
}): Pick<Components, 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td'> {
  const { thClassName, tdClassName } = opts ?? {};
  return {
    table: ({ children }: ComponentProps<'table'>) => <MarkdownTable>{children}</MarkdownTable>,
    thead: ({ children }: ComponentProps<'thead'>) => (
      <thead className="[&_tr]:border-b [&_tr]:border-line">{children}</thead>
    ),
    tbody: ({ children }: ComponentProps<'tbody'>) => (
      <tbody className="[&_tr:last-child]:border-0">{children}</tbody>
    ),
    tr: ({ children }: ComponentProps<'tr'>) => (
      <tr className="border-b border-line">{children}</tr>
    ),
    th: ({ children }: ComponentProps<'th'>) => <th className={cn(thClassName, TH_BASE)}>{children}</th>,
    td: ({ children }: ComponentProps<'td'>) => <td className={cn(tdClassName, TD_BASE)}>{children}</td>,
  };
}
