'use client';

import { Eye, EyeOff } from 'lucide-react';

/**
 * Compact eye control with a ≥44px coarse-pointer hit area and a
 * named a11y tree entry (aria-label + sr-only text).
 */
export function PasswordToggle({
  visible,
  onToggle,
  showLabel = 'Show password',
  hideLabel = 'Hide password',
}: {
  visible: boolean;
  onToggle: () => void;
  showLabel?: string;
  hideLabel?: string;
}) {
  const label = visible ? hideLabel : showLabel;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center size-9 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 text-muted-foreground hover:text-foreground rounded-md touch-manipulation"
      aria-label={label}
      aria-pressed={visible}
    >
      <span className="sr-only">{label}</span>
      {visible ? (
        <EyeOff className="size-4" aria-hidden />
      ) : (
        <Eye className="size-4" aria-hidden />
      )}
    </button>
  );
}
