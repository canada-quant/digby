'use client';

/**
 * GhostComposerToggle (2026-10-22) — the ONE ghost button beside a composer:
 * the guest toggle (CodeSessionView), the signed-in toggle on an open plain
 * chat (CodeSessionView) and the signed-in "arm the next new chat" toggle on
 * the home composer (page.tsx) all render this, so they share one look with
 * the FloatingChrome Ghost badge (the lucide Ghost glyph, the honest one-liner
 * as the tooltip). The pressed state doubles as the persistent indicator.
 *
 * Never `disabled` (a disabled button swallows the click AND its tooltip on
 * Chromium — the 2026-08-09 dead-click report): while a save is in flight the
 * host passes `busy` and ignores the click itself.
 */

import { Ghost } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GHOST_MODE_TOOLTIP } from '@/lib/ghost-mode';
import { COMPOSER_TOOL_BTN } from './ChatComposer';

export default function GhostComposerToggle({ on, onToggle, busy, armsNewChat }: {
  /** Ghost is on (open chat / guest session) or armed (the next new chat). */
  on: boolean;
  onToggle: () => void;
  /** A save is in flight — rendered aria-busy and dimmed, never disabled. */
  busy?: boolean;
  /** Home composer: the toggle arms the chat the next send creates (the label says so). */
  armsNewChat?: boolean;
}) {
  const label = armsNewChat
    ? (on ? 'Ghost mode on for the new chat — turn off' : 'Start this chat in ghost mode')
    : (on ? 'Turn ghost mode off' : 'Turn ghost mode on');
  return (
    <button type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-busy={busy || undefined}
      data-testid="ghost-composer-toggle"
      data-ghost-on={on ? 'true' : 'false'}
      className={cn(COMPOSER_TOOL_BTN, on && 'text-ink bg-hover', busy && 'opacity-60')}
      title={GHOST_MODE_TOOLTIP}
      aria-label={label}>
      <Ghost className="size-[17px]" strokeWidth={1.75} />
    </button>
  );
}
