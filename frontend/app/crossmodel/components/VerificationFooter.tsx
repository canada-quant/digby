'use client';

/**
 * VerificationFooter — ONE collapsed row under an assistant final that carries
 * harness chrome (lib/harness-chrome.ts: the claims manifest, the auto-verify
 * line, the [HARNESS EVIDENCE GUARD] note, the 🔍 claim/push verification
 * footers). Owner ask 2026-09-14: those sections rendered as raw prose + a
 * JSON code block under every evidence-carrying report.
 *
 * Collapsed: a single summary line of chips — "✅ 1 verified · ⚠ 2 unverified ·
 * ✓ auto-verify · 1 claim" — with a chevron. Expanded: the full sections,
 * verbatim (COLLAPSE, never filter — byte-lossless, one click away).
 *
 * Extends the 295068fa claim-manifest chip (formerly ClaimsReceiptsRow in
 * code-transcript.tsx): a claims-only final renders the same quiet row with a
 * "1 claim" chip and the raw manifest behind the click.
 *
 * Semantic tokens only (text-success / text-warning / text-destructive /
 * muted) — theme-aware in both modes; truncating chip line for mobile.
 */

import { useMemo, useState } from 'react';
import { localizeUtcTimes } from '@/lib/localize-utc-times';
import { ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { summarizeHarnessChrome, verdictTone, type HarnessChrome } from '@/lib/harness-chrome';
import { parseClaimsEntries } from '@/lib/claims-block';

const TONE_CLS: Record<ReturnType<typeof verdictTone>, string> = {
  ok: 'text-success',
  bad: 'text-destructive',
  warn: 'text-warning',
  neutral: 'text-muted-foreground',
};

function chipTone(chip: string): string {
  if (chip.startsWith('✅') || chip.startsWith('✓')) return 'text-success';
  if (chip.startsWith('⚠')) return 'text-warning';
  return 'text-muted-foreground';
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] font-medium text-ink-3">{children}</div>;
}

/** Owner 2026-09-14: verification footers carry harness clocks ("verified-at
 *  14:02Z") — every string the footer shows is rewritten to the viewer's local
 *  time. Presentation only; the parsed chrome is not mutated. */
function localizeChrome(c: HarnessChrome): HarnessChrome {
  return {
    ...c,
    ...(c.autoVerify ? { autoVerify: localizeUtcTimes(c.autoVerify) } : {}),
    ...(c.evidenceGuard ? { evidenceGuard: localizeUtcTimes(c.evidenceGuard) } : {}),
    verifications: (c.verifications ?? []).map((v) => ({
      ...v,
      label: localizeUtcTimes(v.label),
      header: localizeUtcTimes(v.header),
      ...(v.verifiedAt ? { verifiedAt: localizeUtcTimes(v.verifiedAt) } : {}),
      items: v.items.map((it) => localizeUtcTimes(it)),
    })),
  };
}

export default function VerificationFooter({ chrome: rawChrome }: { chrome: HarnessChrome }) {
  const [open, setOpen] = useState(false);
  const chrome = useMemo(() => localizeChrome(rawChrome), [rawChrome]);
  const s = summarizeHarnessChrome(chrome);
  const entries = chrome.claims ? parseClaimsEntries(chrome.claims.json) : [];
  return (
    <div className="my-1 text-xs" data-harness-footer>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-left transition-colors hover:bg-muted/60"
      >
        <ShieldCheck className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/80">Harness verification</span>
          {s.chips.map((chip, i) => (
            <span key={i}>
              <span className="opacity-60"> · </span>
              <span className={chipTone(chip)}>{chip}</span>
            </span>
          ))}
        </span>
        {open
          ? <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          : <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />}
      </button>
      {open && (
        <div className="ml-2 mt-1 space-y-2.5 border-l border-border/60 pl-3">
          {chrome.autoVerify && (
            <div>
              <SectionLabel>Auto-verify</SectionLabel>
              <div className={cn('text-[11px] [overflow-wrap:anywhere]', s.autoVerify === 'passed' ? 'text-success' : 'text-warning')}>
                {chrome.autoVerify}
              </div>
            </div>
          )}
          {chrome.verifications.map((v, i) => (
            <div key={i}>
              <SectionLabel>
                {v.label}
                {v.verifiedAt && <span className="normal-case tracking-normal opacity-80"> · verified at {v.verifiedAt}</span>}
              </SectionLabel>
              <ul className="mt-0.5 space-y-0.5">
                {v.items.map((item, j) => (
                  <li key={j} className={cn('text-[11px] leading-relaxed [overflow-wrap:anywhere]', TONE_CLS[verdictTone(item)])}>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {chrome.evidenceGuard && (
            <div>
              <SectionLabel>Evidence guard</SectionLabel>
              <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-warning">{chrome.evidenceGuard}</pre>
            </div>
          )}
          {chrome.claims && (
            <div>
              <SectionLabel>
                Claim manifest{chrome.claims.entryCount > 0 ? ` · ${chrome.claims.entryCount} ${chrome.claims.entryCount === 1 ? 'entry' : 'entries'}` : ''}
              </SectionLabel>
              {entries.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {entries.map((e, k) => (
                    <span key={k} className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
                      {e.type ?? 'claim'}{e.ref ? ` ${e.ref}` : ''}
                    </span>
                  ))}
                </div>
              )}
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-muted-foreground/80">{chrome.claims.json}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
