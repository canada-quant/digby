'use client';

/**
 * Shared status badges — deduped from files/page.tsx and projects/[id]/page.tsx
 * (kept the spinning-clock "Processing" variant).
 */
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { TYPE_ICONS, TYPE_LABELS, TYPE_COLORS } from './canvas-meta';

export function DocStatusBadge({ status }: { status: string }) {
  if (status === 'ready') return (
    <Badge variant="outline" className="text-ok border-ok/40 text-[10px]">
      <CheckCircle2 className="size-2.5 mr-1" />Ready
    </Badge>
  );
  if (status === 'error') return (
    <Badge variant="outline" className="text-destructive border-destructive/40 text-[10px]">
      <AlertCircle className="size-2.5 mr-1" />Error
    </Badge>
  );
  return (
    <Badge variant="outline" className="text-warn-ink border-warn/40 text-[10px]">
      <Clock className="size-2.5 mr-1 animate-spin" />Processing
    </Badge>
  );
}

export function CanvasTypeBadge({ type, language }: { type: string; language?: string | null }) {
  const Icon = TYPE_ICONS[type as keyof typeof TYPE_ICONS] || TYPE_ICONS.document;
  const label = TYPE_LABELS[type as keyof typeof TYPE_LABELS] || TYPE_LABELS.document;
  const color = TYPE_COLORS[type as keyof typeof TYPE_COLORS] || TYPE_COLORS.document;
  return (
    <Badge variant="outline" className={`text-[10px] gap-1 py-0 h-4 px-1.5 ${color}`}>
      <Icon className="size-2" />
      {label}{language ? ` · ${language}` : ''}
    </Badge>
  );
}
