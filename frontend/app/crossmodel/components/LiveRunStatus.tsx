'use client';

/**
 * The live bubble's status row — "Digby is working" hat + the ONE status
 * sentence + the run clock. A leaf so the resumed-run state renders under
 * react-dom/server (resumed-run-composer.test.tsx): a polled guest resume
 * shows the calm GUEST_RESUME_STATUS line with NO clock (`since` null —
 * nothing is attached in that tab), an attached stream shows the clock.
 */

import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { DigbyLoader } from '@/components/ui/custom/DigbyLoader';
import { fmtElapsed } from './code-transcript';

/** Isolated 1s clock — ticking the elapsed label must not re-render the whole
 *  session view (transcript + panel) every second (flicker review 2026-07-18). */
export function ElapsedTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return <>{fmtElapsed(now - since)}</>;
}

export function LiveRunStatus({ stopping, status, since }: {
  stopping?: boolean;
  /** The harness's status line (or the resume line); "Working" when absent. */
  status?: string;
  /** Run start (ms) — the clock renders only when set. */
  since?: number | null;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5 min-w-0">
      <DigbyLoader size={24} label={stopping ? 'Stopping' : 'Digby is working'} />
      {/* Two spans (audit 2026-09-15): the sentence truncates, the clock never
          does — one truncating span used to swallow the timer on narrow
          viewports. */}
      <span className="truncate min-w-0">{stopping ? 'Stopping…' : (status || 'Digby is on it')}{since || status ? '' : '…'}</span>
      {since && <span className="shrink-0 tabular-nums">· <ElapsedTimer since={since} /></span>}
    </div>
  );
}

// ── Digby Frontier thinking + streaming states (2026-10-06) ────────────────

/** Max steps the Thinking list keeps (oldest drop first). */
export const THINKING_STEPS_MAX = 12;

/** The harness's elapsed-time pulse ("Still digging — 1:32 so far…",
 *  backend chat-agent/status-voice.ts) — the run clock already says that, so
 *  a pulse is never a step and never the shown status line (owner 2026-10-07:
 *  "looking at the streaming status there seems to be a lot going on"). */
export function isHeartbeatStatus(msg: string | undefined | null): boolean {
  return !!msg && /^Still\b.*—\s*\d+:\d{2}\s+so far/i.test(msg.trim());
}

/** Append a progress line to the step list: distinct lines only (a repeat of
 *  an earlier line is not a new step), heartbeat pulses skipped, capped. Pure. */
export function appendThinkingStep(steps: string[] | undefined, msg: string): string[] {
  const t = (msg || '').trim();
  const list = steps ?? [];
  if (!t || list.includes(t) || isHeartbeatStatus(t)) return list;
  const next = [...list, t];
  return next.length > THINKING_STEPS_MAX ? next.slice(next.length - THINKING_STEPS_MAX) : next;
}

/** True once the live turn has visible prose (the first token arrived). */
export function liveHasText(parts: Array<{ type: string; text?: string }>): boolean {
  return parts.some(p => p.type === 'text' && !!p.text?.trim());
}

/**
 * Before the first token — ONE calm block (owner 2026-10-07, "there seems to
 * be a lot going on"): the spinning hat + "Thinking" (shimmer) + the run clock,
 * and under it ONE line — the current step. Every earlier step sits behind a
 * quiet "N steps" toggle (collapsed by default); heartbeat pulses never show
 * (the clock covers them). The live tool run is not repeated above it (plain
 * chats pass quietLiveTail to AssistantParts) — the settled row keeps the full
 * "Tool activity" fold.
 */
export function ThinkingBlock({ steps, status, stopping, since }: {
  steps?: string[];
  status?: string;
  stopping?: boolean;
  since?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const list = (steps && steps.length ? steps : (status ? [status] : [])).filter(t => !isHeartbeatStatus(t));
  const current = list[list.length - 1];
  const earlier = list.length - 1;
  return (
    <div className="dg-fade mt-1 font-sans" data-thinking role="status" aria-live="polite">
      <div className="flex items-center gap-2.5 min-w-0">
        {/* The owner's ANIMATED propeller hat (DigbyLoader → /digbyspin.gif):
            owner 2026-10-06, "the animated propeller spinning loader was way
            better" — never the static png. */}
        <DigbyLoader size={26} label={stopping ? 'Stopping' : 'Digby is thinking'} />
        <span className="dg-shimmer text-[14px] font-medium">{stopping ? 'Stopping' : 'Thinking'}</span>
        {since ? <span className="text-[12px] text-ink-3 tabular-nums"><ElapsedTimer since={since} /></span> : null}
        {earlier > 0 && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            data-thinking-toggle
            className="ml-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink-2 transition-colors"
          >
            {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
            {list.length} steps
          </button>
        )}
      </div>
      {open && earlier > 0 ? (
        <div className="mt-2.5 ml-[9px] flex flex-col gap-[7px] border-l border-line pl-5" data-thinking-steps>
          {list.map((t, i) => {
            const done = i < list.length - 1;
            return (
              <div key={t} className="flex items-center gap-2 text-[13px] text-ink-3">
                {done
                  ? <Check className="size-[13px] shrink-0" aria-hidden />
                  : <span className="flex w-[13px] shrink-0 justify-center" aria-hidden><span className="dg-pulse size-1.5 rounded-full bg-ink-2" /></span>}
                <span className="min-w-0 truncate">{t}</span>
              </div>
            );
          })}
        </div>
      ) : current ? (
        <div key={current} className="dg-fade mt-1.5 ml-[36px] min-w-0 truncate text-[13px] text-ink-3" data-thinking-current>{current}</div>
      ) : null}
    </div>
  );
}

/** While words stream: the spinning propeller hat keeps turning after the text
 *  (owner 2026-10-06 — the animated loader, not a pulsing dot), plus the
 *  current harness status in quiet ink-3 (e.g. the Double Checker reviewing). */
export function StreamingDot({ status, stopping }: { status?: string; stopping?: boolean }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 font-sans" role="status" aria-live="polite">
      <DigbyLoader size={20} label={stopping ? 'Stopping' : 'Digby is writing'} />
      {(stopping || (status && !isHeartbeatStatus(status))) && <span className="min-w-0 truncate text-[12.5px] text-ink-3">{stopping ? 'Stopping…' : status}</span>}
    </div>
  );
}
