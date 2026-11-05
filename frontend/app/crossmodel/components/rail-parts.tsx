'use client';

/**
 * Digby Frontier sidebar building blocks (2026-10-06 redesign).
 *
 * The rail CONTENT for the signed-in sidebar (page.tsx) and the guest rail
 * (GuestSidebar.tsx) shares one row language so the two can't drift:
 *
 *   RailBrandRow     56px — hat 22px · "Digby" Newsreader 20/500 · collapse
 *   RailActionRow    36px primary actions (New chat ⌘⇧O, Search ⌘K, …)
 *   RailSectionLabel sentence-case 12px ink-3 labels ("Folders", "Today")
 *   railRowClass     34px chat/folder row skin (idle ink-2 · hover · active)
 *   RailFooter       avatar + name/email + Settings, border-top line
 *
 * Every value (heights, paddings, radii, sizes) is the design's final value.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { PanelLeft, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/ui/custom/BrandLogo';
import { useBranding } from '@/app/branding/BrandingProvider';

/** Coarse pointers (phones) get a 44px hit target without changing the look. */
const COARSE_HIT = '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';

export function RailBrandRow({ onCollapse, collapseLabel = 'Close sidebar' }: {
  onCollapse: () => void;
  collapseLabel?: string;
}) {
  const branding = useBranding();
  return (
    <div className="flex h-14 flex-shrink-0 items-center gap-[9px] pl-4 pr-2.5">
      <BrandLogo compact size={22} alt="" priority className="size-[22px] object-contain" />
      <span className="min-w-0 flex-1 truncate font-serif text-[20px] font-medium tracking-[-0.01em] text-ink">{branding.name}</span>
      <button
        type="button"
        onClick={onCollapse}
        title={collapseLabel}
        aria-label={collapseLabel}
        className={cn(
          'flex size-8 items-center justify-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink',
          COARSE_HIT,
        )}
      >
        <PanelLeft className="size-[18px]" strokeWidth={1.75} />
      </button>
    </div>
  );
}

export interface RailActionRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: ReactNode;
  /** Trailing keyboard hint ("⌘K") or element (chevron). */
  hint?: ReactNode;
  /** The primary row (New chat): 14px/500 ink instead of ink-2. */
  primary?: boolean;
}

export const RailActionRow = forwardRef<HTMLButtonElement, RailActionRowProps>(function RailActionRow(
  { icon, label, hint, primary, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left text-[14px] transition-colors duration-150 hover:bg-hover',
        primary ? 'font-medium text-ink' : 'text-ink-2',
        className,
      )}
    >
      <span className="flex w-[17px] flex-shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint != null && <span className="flex-shrink-0 text-[11.5px] font-normal text-ink-3">{hint}</span>}
    </button>
  );
});

/** The 7px warn dot with its soft halo — the "decisions need you" marker. */
export function WarnDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block size-[7px] rounded-full bg-warn shadow-[0_0_0_3px_oklch(0.75_0.15_65/0.18)]', className)}
    />
  );
}

export function RailSectionLabel({ children, action, onClick, first, expanded }: {
  children: ReactNode;
  /** Optional trailing control (e.g. "New folder"). */
  action?: ReactNode;
  /** Makes the label a collapse toggle. */
  onClick?: () => void;
  /** The first label in the list sits a little tighter (14px vs 16px top). */
  first?: boolean;
  expanded?: boolean;
}) {
  const text = onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="min-w-0 flex-1 truncate text-left transition-colors duration-150 hover:text-ink-2"
    >
      {children}
    </button>
  ) : (
    <span className="min-w-0 flex-1 truncate">{children}</span>
  );
  return (
    <div className={cn('flex items-center gap-1 px-2.5 pb-1.5 text-[12px] text-ink-3', first ? 'pt-3.5' : 'pt-4')}>
      {text}
      {action}
    </div>
  );
}

/** Small trailing icon button for a section label (New folder, New chat). */
export function RailLabelButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex size-6 items-center justify-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  );
}

/**
 * The 34px chat / folder row skin: 13.5px, radius 9, idle ink-2, hover
 * bg-hover + ink, active bg-active + ink.
 */
export function railRowClass(active: boolean): string {
  return cn(
    'flex min-h-[34px] items-center gap-2.5 rounded-[9px] px-2.5 text-[13.5px] transition-colors duration-150',
    active ? 'bg-active text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
  );
}

export const RailFooter = forwardRef<HTMLButtonElement, {
  name: string;
  email?: string | null;
  /** The Settings glyph → Account (its own click target). */
  onOpenSettings?: () => void;
  trailing?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>>(function RailFooter(
  { name, email, onOpenSettings, trailing, className, ...rest },
  ref,
) {
  const initial = (name || email || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="flex-shrink-0 border-t border-line p-2">
      <div className="flex items-center gap-1 rounded-[10px] transition-colors duration-150 hover:bg-hover">
        <button
          ref={ref}
          type="button"
          {...rest}
          className={cn('flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] py-2 pl-2.5 text-left', className)}
        >
          <span className="flex size-[30px] flex-shrink-0 items-center justify-center rounded-full bg-ink text-[13px] font-medium text-background">
            {initial}
          </span>
          <span className="min-w-0 flex-1 leading-[1.3]">
            <span className="block truncate text-[13.5px] font-medium text-ink">{name}</span>
            {email && email !== name && <span className="block truncate text-[12px] text-ink-3">{email}</span>}
          </span>
          {trailing}
        </button>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Settings"
            className={cn('mr-1.5 flex size-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors duration-150 hover:text-ink', COARSE_HIT)}
          >
            <Settings className="size-4" strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  );
});
