'use client';

/**
 * ResizeHandle — the shared grab strip for the app's resizable rails (left
 * sidebar + right workspace panel), driven by lib/use-resizable.ts (owner UI
 * pass 2026-09-07). A thin vertical strip: col-resize cursor, hover/active
 * highlight, double-click (or Enter when focused) resets to the default width,
 * and arrow keys nudge it (keyboard accessibility).
 *
 * Discoverability (owner report 2026-09-09 — "still isn't resizable"): the
 * strip used to be fully transparent until hovered, so nobody could tell the
 * rails were resizable at all. It now carries a small always-visible grip pill
 * (centered, `bg-border`) that darkens to ink-3 on hover/drag/focus — the
 * same affordance VS Code / Slack / Linear use on their rails. (Digby
 * Frontier 2026-10-06: neutral hover tones — no violet in chat chrome.)
 *
 * Visibility is the CALLER's: pass the breakpoint classes that match how the
 * surface collapses on narrow viewports (both the sidebar and workspace-panel
 * handles are `hidden md:flex` — md is the app's ONE drawer/static switch
 * since the Phase-1 shell pass; below it every surface is a slide-over
 * drawer). The handle must never render where the surface overlays instead
 * of flowing.
 */

import { cn } from '@/lib/utils';
import { RESIZE_KEY_STEP } from '@/lib/use-resizable';

export function ResizeHandle({ onPointerDown, onReset, onNudge, label, className }: {
  /** useResizable().startResize */
  onPointerDown: (e: React.PointerEvent) => void;
  /** useResizable().reset — double-click / Enter restores the default width. */
  onReset?: () => void;
  /** useResizable().nudge — arrow keys move the handle in pointer space. */
  onNudge?: (deltaX: number) => void;
  /** Accessible name ("Resize sidebar" / "Resize workspace panel"). */
  label?: string;
  /** Layout + visibility (breakpoint) classes — owned by the caller. */
  className?: string;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onNudge || onReset ? (e) => {
        if (e.key === 'ArrowLeft' && onNudge) { e.preventDefault(); onNudge(-RESIZE_KEY_STEP); }
        else if (e.key === 'ArrowRight' && onNudge) { e.preventDefault(); onNudge(RESIZE_KEY_STEP); }
        else if (e.key === 'Enter' && onReset) { e.preventDefault(); onReset(); }
      } : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? 'Drag to resize'}
      tabIndex={onNudge ? 0 : undefined}
      title="Drag to resize · double-click to reset"
      data-slot="resize-handle"
      className={cn(
        'group shrink-0 w-1.5 cursor-col-resize bg-transparent outline-none transition-colors touch-none',
        'flex items-center justify-center',
        'hover:bg-hover/70 active:bg-hover focus-visible:bg-hover',
        className,
      )}
    >
      {/* The always-visible grip pill — see the module header. */}
      <span
        aria-hidden="true"
        className="h-8 w-1 rounded-full bg-border transition-colors group-hover:bg-ink-3 group-active:bg-ink-3 group-focus-visible:bg-ink-3"
      />
    </div>
  );
}
