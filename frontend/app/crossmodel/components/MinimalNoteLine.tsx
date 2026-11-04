'use client';

/**
 * Minimal view (2026-10-16): one centred grey line for background traffic a user should know happened but never
 * needs to read — "Message from Hyperstack 8xA100". The Grok-Bot pattern. A stretch of notes is ONE line
 * (2026-10-21, lib/view-mode.ts groupMinimalNotes); `title` carries the full sender list when the line is capped.
 */
export function MinimalNoteLine({ text, title }: { text: string; title?: string }) {
  return (
    <div data-minimal-note className="my-2 flex justify-center">
      <span className="max-w-full truncate text-[12.5px] text-ink-3" title={title}>{text}</span>
    </div>
  );
}
