'use client';

import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Shared back control for secondary page chrome (Account, Management, Help,
 * Files, project, legal). 40×40 visual / 44×44 coarse-pointer hit area —
 * the old size-8 (32px) icon buttons were below the WCAG 2.5.5 floor.
 */
export function PageBackButton({
  onClick,
  label = 'Back to previous page',
  className,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onClick}
      className={cn(
        'size-10 shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 touch-manipulation',
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      <ArrowLeft className="size-4" aria-hidden />
    </Button>
  );
}
