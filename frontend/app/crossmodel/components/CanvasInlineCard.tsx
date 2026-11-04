'use client';

/**
 * Inline canvas card (Digby Frontier redesign, 2026-10-06): the artifact an
 * answer produced, as a quiet card under the prose — max 440px, radius 14,
 * 1px line, raised bg, var(--shadow); a 40px radius-10 tile with the type
 * icon, the title (14/500), "Document · Open" (12.5px ink-3) and an
 * ArrowUpRight. Hover lifts 1px and darkens the border (200ms). A click opens
 * the canvas in the side panel.
 */
import { ArrowUpRight, FileText } from 'lucide-react';
import { TYPE_ICONS, TYPE_LABELS } from './canvas-meta';

export default function CanvasInlineCard({ title, type, onOpen }: {
  title: string;
  type: string;
  onOpen: () => void;
}) {
  const Icon = TYPE_ICONS[type as keyof typeof TYPE_ICONS] || FileText;
  const label = TYPE_LABELS[type as keyof typeof TYPE_LABELS] || 'Document';
  return (
    <button
      type="button"
      onClick={onOpen}
      data-canvas-card
      className="my-1.5 flex w-full max-w-[440px] items-center gap-3.5 rounded-[14px] border border-line bg-raised px-3.5 py-3 text-left font-sans text-ink shadow-(--shadow) transition-[transform,border-color] duration-200 ease-(--ease-out) hover:-translate-y-px hover:border-line-2"
    >
      <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-hover text-ink-2">
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{title || 'Untitled'}</span>
        <span className="mt-0.5 block text-[12.5px] text-ink-3">{label} · Open</span>
      </span>
      <ArrowUpRight className="size-4 flex-shrink-0 text-ink-3" />
    </button>
  );
}
