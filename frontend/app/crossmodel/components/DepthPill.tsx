'use client';

/**
 * DepthPill + DepthChipRow — the compute policy's two bubble surfaces
 * (docs/DEPTH_UX_SOTA_2026-09-26.md §4 "UX (one control)"; lib/depth-ux.ts).
 *
 *   · DepthPill: ONE quiet pill under an assistant bubble, driven only by
 *     harness events / persisted metadata: Checking… → Checked ✓ / Updated ·
 *     what changed (expands to the changed-claim list + a side-by-side of the
 *     previous vs current answer from metadata.revision.previousContent) /
 *     Check didn't finish → Dig deeper. Never model prose.
 *   · DepthChipRow: the single "Dig deeper" control (or the guest's "Sign in
 *     for a deeper look"), rendered next to the follow-up chips under the
 *     LATEST answer only. The research rung shows the daily deep-research
 *     quota (the badge re-keyed from the retired Level-3 picker state).
 *
 * Both render nothing when they have nothing harness-given to say, so a
 * legacy backend (no check_state / chips) leaves the bubble exactly as before
 * minus the two old "still working / updated after" text lines they replace.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, CircleCheck, Loader2, Sparkles, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PILL_TEXT, quotaBlocksResearch, quotaHintFor,
  type DepthChip, type DepthQuotaView, type PillState,
} from '@/lib/depth-ux';
import { transparencyLabel, type HowRow, type PillTone } from '@/lib/answer-transparency';

export interface DepthPillProps {
  state: PillState;
  /** metadata.revision.previousContent — enables the side-by-side on 'updated'. */
  previousContent?: string;
  /** The bubble's current (revised) text — the right column of the side-by-side. */
  currentContent?: string;
  /** Seat label for the checker ("Double Checker" by default — never a vendor). */
  checkerLabel?: string;
  /** 'interrupted' offers a retry through the same Dig-deeper path. */
  onDigDeeper?: () => void;
}

export function DepthPill({ state, previousContent, currentContent, checkerLabel, onDigDeeper }: DepthPillProps) {
  const [open, setOpen] = useState(false);
  if (!state) return null;
  const who = checkerLabel || 'Double Checker';
  // Digby Frontier: one neutral 30px pill — the tone lives in the icon only.
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 h-[30px] text-[12.5px] text-ink-2 select-none';
  if (state.kind === 'checking') {
    return (
      <div className="pt-1.5" data-depth-pill="checking">
        <span className={base} title={`${who} is still working — this answer may update.`}>
          <Loader2 className="size-3.5 animate-spin text-ink-3" />
          {PILL_TEXT.checking}
        </span>
      </div>
    );
  }
  if (state.kind === 'checked') {
    return (
      <div className="pt-1.5" data-depth-pill="checked">
        <span className={base} title={`${who} agrees with this answer.`}>
          <CircleCheck className="size-3.5 text-ok" strokeWidth={2} />
          {PILL_TEXT.checked}
        </span>
      </div>
    );
  }
  if (state.kind === 'quick') {
    return (
      <div className="pt-1.5" data-depth-pill="quick">
        <span className={base} title="Answered on the quick lane — one fast model with a web search, no second check. Dig deeper for a checked answer.">
          <Zap className="size-3.5 text-ink-3" strokeWidth={1.75} />
          {PILL_TEXT.quick}
        </span>
      </div>
    );
  }
  if (state.kind === 'interrupted') {
    return (
      <div className="pt-1.5 flex items-center gap-2 flex-wrap" data-depth-pill="interrupted">
        <span className={base} title={`${who} didn’t finish checking this answer.`}>
          <CircleAlert className="size-3.5 text-warn" />
          {PILL_TEXT.interrupted}
        </span>
        {onDigDeeper && (
          <button type="button" onClick={onDigDeeper} className="text-[12.5px] text-ink-3 underline decoration-line-2 underline-offset-[3px] hover:text-ink">
            Dig deeper to retry
          </button>
        )}
      </div>
    );
  }
  // updated
  const n = state.changed.length;
  const canExpand = n > 0 || !!previousContent;
  return (
    <div className="pt-1.5" data-depth-pill="updated">
      <button
        type="button"
        onClick={() => canExpand && setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(base, canExpand ? 'hover:bg-hover transition-colors duration-150' : 'cursor-default')}
        title={`Updated after ${who} finished.`}
      >
        <Sparkles className="size-3.5 text-ink-2" strokeWidth={1.75} />
        {PILL_TEXT.updated}
        {n > 0 ? ` · ${n} ${n === 1 ? 'correction' : 'corrections'}` : ''}
        {canExpand && <span className="text-ink-3">· what changed</span>}
        {canExpand && (open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />)}
      </button>
      {open && (
        <div className="dg-pop mt-2 rounded-[14px] border border-line bg-bg-2 p-4 text-[13px] space-y-3" data-depth-diff>
          {n > 0 && (
            <ul className="list-disc pl-5 space-y-0.5 text-ink-2">
              {state.changed.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
          {previousContent && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink-3 mb-1">Before</p>
                <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-ink-3 max-h-64 overflow-y-auto">{previousContent}</pre>
              </div>
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink-3 mb-1">Now</p>
                <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-ink-2 max-h-64 overflow-y-auto">{currentContent ?? ''}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface DepthChipRowProps {
  chip: DepthChip | null;
  quota?: DepthQuotaView | null;
  disabled?: boolean;
  onEscalate?: (escalationOf: string) => void;
  /** Where the guest affordance sends them (the login page by default). */
  signinHref?: string;
  /** The guest tapped the sign-in affordance (the ux_beacon `tap` / `signin_deeper` — audit 2026-09-26); navigation still happens through the anchor. */
  onSigninDeeper?: () => void;
  /** Render as the LAST pill inside the follow-ups row (no own wrapper row). */
  inline?: boolean;
}

export function DepthChipRow({ chip, quota, disabled, onEscalate, onSigninDeeper, signinHref = '/login', inline }: DepthChipRowProps) {
  if (!chip) return null;
  // Digby Frontier: the follow-up pill language — 8px 14px, radius 999, 1px
  // line, 13.5px ink-2; hover bg-hover + line-2 + ink. Sparkles 14px leads.
  const cls = 'group inline-flex items-center gap-[7px] text-[13.5px] px-3.5 py-2 rounded-full border border-line bg-transparent text-ink-2 transition-colors duration-150 hover:bg-hover hover:border-line-2 hover:text-ink text-left leading-snug disabled:opacity-50 disabled:hover:bg-transparent';
  if (chip.kind === 'signin_deeper') {
    return (
      <div className={inline ? 'contents' : 'pt-[18px]'} data-depth-chip="signin_deeper">
        <a href={signinHref} onClick={() => onSigninDeeper?.()} className={cls}>
          <Sparkles className="size-3.5" strokeWidth={1.75} />
          <span>{chip.label}</span>
        </a>
      </div>
    );
  }
  const blocked = quotaBlocksResearch(quota, chip.nextRung);
  const hint = quotaHintFor(quota, chip.nextRung);
  const eta = chip.etaText;
  return (
    <div className={inline ? 'contents' : 'pt-[18px] flex items-center gap-2 flex-wrap'} data-depth-chip="escalate" data-next-rung={chip.nextRung}>
      <button
        type="button"
        disabled={disabled || blocked}
        onClick={() => onEscalate?.(chip.escalationOf)}
        title={blocked ? 'Daily deep-research quota reached — resets tomorrow.' : eta ? `Takes ${eta}.` : undefined}
        className={cls}
      >
        <Sparkles className="size-3.5" strokeWidth={1.75} />
        <span>{chip.label}</span>
      </button>
      {(eta || hint) && (
        <span className="self-center text-[12px] text-ink-3 select-none">
          {eta}{eta && hint ? ' · ' : ''}{hint}
        </span>
      )}
    </div>
  );
}

// ── Transparency pill + "How Digby answered" (Digby Frontier, 2026-10-06) ──
// Replaces DepthPill + "More info" under SETTLED answers: one 30px pill whose
// label carries the check state; expanding shows one row per seat with its
// note, model id (Geist Mono) and time. The live streaming turn keeps the
// static DepthPill above. Pure labels/rows: lib/answer-transparency.ts.

const TONE_ICON: Record<PillTone, ReactNode> = {
  ok: <CircleCheck className="size-3.5 text-ok" strokeWidth={2} />,
  spin: <Loader2 className="size-3.5 animate-spin text-ink-3" />,
  updated: <Sparkles className="size-3.5 text-ink-2" strokeWidth={1.75} />,
  quick: <Zap className="size-3.5 text-ink-3" strokeWidth={1.75} />,
  warn: <CircleAlert className="size-3.5 text-warn" />,
  neutral: <CircleCheck className="size-3.5 text-ink-3" strokeWidth={1.75} />,
};

export function TransparencyPill({ state, seats, open, onToggle, onRetry }: {
  state: PillState;
  seats: number;
  open: boolean;
  onToggle: () => void;
  /** 'interrupted' — "Check didn't finish · Retry" runs the Dig-deeper send. */
  onRetry?: () => void;
}) {
  const view = transparencyLabel(state, seats, open);
  if (!view) return null;
  const retry = !open && state?.kind === 'interrupted' && onRetry;
  return (
    <button
      type="button"
      onClick={retry ? onRetry : onToggle}
      aria-expanded={retry ? undefined : open}
      data-depth-pill={state?.kind ?? 'how'}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[12.5px] text-ink-2 transition-colors duration-150 hover:bg-hover"
    >
      {TONE_ICON[view.tone]}
      <span>{view.label}</span>
      {!retry && (
        <ChevronDown className={cn('size-[13px] text-ink-3 transition-transform duration-[220ms]', open && 'rotate-180')} />
      )}
    </button>
  );
}

export function HowDigbyAnswered({ rows, state, previousContent, currentContent, renderDetail }: {
  rows: HowRow[];
  state: PillState;
  previousContent?: string;
  currentContent?: string;
  /** Admin drill-down: the full per-model response for a row (PlainModelCard). */
  renderDetail?: (row: HowRow) => ReactNode;
}) {
  const [detail, setDetail] = useState<string | null>(null);
  const changed = state?.kind === 'updated' ? state.changed : [];
  return (
    <div className="dg-pop mt-2 overflow-hidden rounded-[14px] border border-line bg-bg-2" data-how-digby-answered>
      {rows.map((r, i) => (
        <div key={r.key} className={cn('grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 px-4 py-3.5', i > 0 && 'border-t border-line')}>
          <span className="flex size-[22px] items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-ink-2">{r.n}</span>
          <div className="min-w-0 font-sans">
            <span className="text-[13.5px] font-semibold text-ink">{r.name}</span>
            <span className="text-[13px] text-ink-3"> · {r.role}</span>
            <p className="mt-1 text-[13.5px] leading-[1.5] text-ink-2">{r.note}</p>
            {r.model && <p className="mt-1.5 font-mono text-[11.5px] text-ink-3">{r.model}</p>}
            {renderDetail && r.response?.response && (
              <button
                type="button"
                onClick={() => setDetail((d) => (d === r.key ? null : r.key))}
                className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
                aria-expanded={detail === r.key}
              >
                {detail === r.key ? 'Hide full response' : 'Full response'}
                <ChevronRight className={cn('size-3 transition-transform', detail === r.key && 'rotate-90')} />
              </button>
            )}
            {renderDetail && detail === r.key && <div className="mt-2">{renderDetail(r)}</div>}
          </div>
          <span className="text-[12px] text-ink-3 tabular-nums">{r.time ?? ''}</span>
        </div>
      ))}
      {(changed.length > 0 || previousContent) && (
        <div className={cn('space-y-3 px-4 py-3.5 font-sans text-[13px]', rows.length > 0 && 'border-t border-line')} data-depth-diff>
          {changed.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
              {changed.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          )}
          {previousContent && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1 text-[12px] font-medium text-ink-3">Before</p>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-ink-3">{previousContent}</pre>
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[12px] font-medium text-ink-3">Now</p>
                <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[12.5px] leading-snug text-ink-2">{currentContent ?? ''}</pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
