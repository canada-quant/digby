'use client';

/**
 * WorkspacePanel — THE right-hand panel for every conversation surface
 * (One-Digby consolidation, 2026-07-15). The old split was CanvasPanel (chat)
 * vs OverviewPanel (code page); this shell hosts both as capability-gated
 * sections. With several sections it shows a compact tab strip; with one it
 * shows a slim label header.
 *
 * Panel chrome is unified here (2026-08-31): when `onClose` is provided EVERY
 * section gets the same close X — in the tab strip's right end (multi-section)
 * or the label header (single-section) — so sections no longer grow their own
 * close buttons (previously only Overview/CanvasPanel had one; Files/Fleet
 * could only be closed from the ⋯ menu).
 *
 * Icon tabs (owner directive 2026-09-09 — "the tabs are cut off and
 * overflowing… switch to icons over text labels"): with five sections the
 * icon+label strip overflowed the default 320px panel and clipped the last
 * tab. The strip is now ICON-FIRST: every tab renders its icon (a per-section
 * default from SECTION_ICONS when the mount passes none) with the label as a
 * native tooltip + aria-label; the text label appears inline ONLY when the
 * panel is wide enough (container query — `@[26rem]`, i.e. ≥416px), so the
 * strip can never overflow at any allowed rail width (min 280px).
 *
 * Sections are passed as nodes so each surface wires only what it has:
 *   chat            → Artifacts (canvases)
 *   code session    → Overview (project · goal · todos · preview) [+ Artifacts later]
 */

import { ReactNode, useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { CalendarClock, FileText, Globe, LayoutDashboard, PanelRight, Paperclip, SlidersHorizontal, X } from 'lucide-react';

export interface WorkspaceSection {
  id: string;
  label: string;
  icon?: ReactNode;
  node: ReactNode;
}

/**
 * Default tab icons by section id (lib/workspace-sections.ts ids). Mounts may
 * still pass `icon` to override; the fallback guarantees an icon-only strip
 * never renders a blank tab.
 */
export const SECTION_ICONS: Record<string, ReactNode> = {
  overview: <LayoutDashboard className="size-4" />,
  artifacts: <FileText className="size-4" />,
  browser: <Globe className="size-4" />,
  files: <Paperclip className="size-4" />,
  schedules: <CalendarClock className="size-4" />,
  settings: <SlidersHorizontal className="size-4" />,
};

/** Container-query breakpoint at which tab labels appear beside their icons.
 *  Documentation only — the class strings below MUST stay literal (Tailwind's
 *  scanner does not evaluate template literals). */
export const TAB_LABEL_MIN_WIDTH = '26rem';

function sectionIcon(s: Pick<WorkspaceSection, 'id' | 'icon'>): ReactNode {
  return s.icon || SECTION_ICONS[s.id] || <PanelRight className="size-4" />;
}

/**
 * Cross-component tab switch (rm9): section nodes sometimes need to send the
 * viewer to a SIBLING tab (Overview's "N schedules → Schedules tab" line), but
 * the active-tab state is private to WorkspacePanel and the nodes are built by
 * the mounts, not the panel. A window CustomEvent keeps both mounts working
 * without threading a controller prop through every section builder. Unknown
 * ids are ignored (the panel only activates sections it actually has), so a
 * stale dispatch can never blank the panel. No-op during SSR.
 */
export const WORKSPACE_SECTION_EVENT = 'digby:workspace-section';
export function openWorkspaceSection(id: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_SECTION_EVENT, { detail: { id } }));
}

export default function WorkspacePanel({ sections, initial, onClose }: { sections: WorkspaceSection[]; initial?: string; onClose?: () => void }) {
  const [active, setActive] = useState(initial || sections[0]?.id);
  // If the active section disappears (e.g. last canvas deleted), fall back.
  useEffect(() => {
    if (!sections.some(s => s.id === active) && sections.length) setActive(sections[0].id);
  }, [sections, active]);
  // openWorkspaceSection() dispatches — activate only ids this panel mounts.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      if (typeof id === 'string' && sections.some(s => s.id === id)) setActive(id);
    };
    window.addEventListener(WORKSPACE_SECTION_EVENT, onOpen);
    return () => window.removeEventListener(WORKSPACE_SECTION_EVENT, onOpen);
  }, [sections]);

  if (!sections.length) return null;
  const current = sections.find(s => s.id === active) || sections[0];

  const closeBtn = onClose ? (
    <button
      onClick={onClose}
      title="Hide panel"
      aria-label="Hide panel"
      className="ml-auto flex size-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
    >
      <X className="size-[17px]" strokeWidth={1.75} />
    </button>
  ) : null;

  return (
    <div className="flex flex-col h-full bg-background @container">
      {sections.length > 1 ? (
        /* Digby Frontier header (2026-10-06): 56px, a segmented control
           (track bg-hover, 3px padding, radius 999; the active segment is
           raised with var(--shadow), 12.5px/500) and the 32px close. */
        <div className="flex h-14 flex-shrink-0 items-center gap-2.5 border-b border-line pl-3 pr-2.5 min-w-0">
        <div role="tablist" aria-label="Workspace sections" className="flex min-w-0 items-center gap-0.5 overflow-x-auto scrollbar-none rounded-full bg-hover p-[3px]">
          {sections.map(s => {
            const selected = current.id === s.id;
            return (
              <button
                key={s.id}
                role="tab"
                aria-selected={selected}
                aria-label={s.label}
                title={s.label}
                onClick={() => setActive(s.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2 py-1 text-[12.5px] font-medium transition-[background-color,color,box-shadow] duration-150 shrink-0',
                  '@[26rem]:px-3',
                  selected ? 'bg-raised text-ink shadow-(--shadow) px-2.5' : 'text-ink-3 hover:text-ink',
                )}
              >
                {sectionIcon(s)}
                {/* The SELECTED tab always names itself (walkthrough 2026-10-06:
                    an icon-only strip left you guessing which tab you were on);
                    the others label inline once the panel is wide enough. */}
                <span className={selected ? 'inline' : 'hidden @[26rem]:inline'}>{s.label}</span>
              </button>
            );
          })}
        </div>
          {closeBtn}
        </div>
      ) : (
        /* Single section: no tab strip to carry the label/close — a slim
           header keeps the same chrome (label left, X right). Only when the
           host wants the close affordance (onClose provided). */
        onClose && (
          <div className="flex h-14 flex-shrink-0 items-center gap-2.5 border-b border-line pl-[18px] pr-2.5">
            <span className="flex items-center gap-2 text-[14px] font-medium text-ink [&_svg]:text-ink-3">
              {sectionIcon(current)}
              {current.label}
            </span>
            {closeBtn}
          </div>
        )
      )}
      <div className="flex-1 min-h-0 overflow-hidden">{current.node}</div>
    </div>
  );
}
