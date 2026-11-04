'use client';

/**
 * Browser program (UI overhaul Phase 6a) — the agent-browse surfaces.
 *
 * The backend has always emitted rich per-action `browser-observation` data
 * (browser-agent/glm-loop.ts) that the UI collapsed into one "Reading a page"
 * progress line. These components render the retained stream
 * (lib/browser-activity.ts):
 *
 *   - BrowserActivityView — URL-bar chrome (adapted from InAppBrowser's pill),
 *     the latest screenshot as the live view (ExpandableDataImage → lightbox;
 *     screenshot-stream first: immune to X-Frame-Options, unlike an iframe),
 *     and a compact reverse-chronological action log with relative timestamps.
 *     Mounted as the workspace-panel 'browser' section (md+) AND as the mobile
 *     sheet's body — one implementation, two chromes.
 *
 *   - BrowserBottomSheet — the ChatGPT pattern for small screens (`md:` is THE
 *     mobile line): a bottom sheet with page title + Globe favicon (favicon
 *     services are external hosts — CSP'd out; the host name + Globe stand in),
 *     the activity view, and an "Open in browser" escape hatch. Purpose-built
 *     minimal sheet chrome on the app's z tokens (P4 deleted the dead
 *     drawer/sheet primitives — this does not resurrect them).
 */

import { ExternalLink, Globe, Monitor, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';
import { ExpandableDataImage } from '@/components/ui/custom/prompt/expandable-data-image';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  browserActionLabel, browserHost, browserPageLabel, browserPath,
  type BrowserActivityEntry, type BrowserActivityState,
} from '@/lib/browser-activity';

/** URL-bar chrome — InAppBrowser's pill, panel-sized. Computer-use frames
 *  (driver 'computer' — the user's own Mac screen, 2026-09-09) swap the URL
 *  pill for a "Your Mac · <frontmost app>" pill: there is no URL to show, the
 *  agent is driving their real desktop apps/browser. */
function BrowserUrlBar({ activity }: { activity: BrowserActivityState }) {
  const url = activity.currentUrl;
  const host = browserHost(url);
  const mac = activity.currentDriver === 'computer';
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-card/60 shrink-0">
      {mac ? <Monitor className="size-3.5 text-ink-3 shrink-0" /> : <Globe className="size-3.5 text-ink-3 shrink-0" />}
      <div
        className="flex-1 min-w-0 rounded-full border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground truncate select-all"
        title={mac ? (activity.currentApp || 'Your Mac') : (url || undefined)}
      >
        {mac ? (
          <>Your Mac{activity.currentApp ? <span className="opacity-70"> · {activity.currentApp}</span> : null}</>
        ) : (
          <>{host || 'No page yet'}<span className="opacity-50">{browserPath(url)}</span></>
        )}
      </div>
      {url && (
        <button
          onClick={() => window.open(url, '_blank', 'noopener')}
          className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"
          title="Open in browser"
          aria-label="Open in browser"
        >
          <ExternalLink className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function LogRow({ entry }: { entry: BrowserActivityEntry }) {
  return (
    <li className="flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-muted/40">
      <span
        className={cn('mt-1.5 size-1.5 rounded-full shrink-0', entry.ok ? 'bg-success-accent' : 'bg-destructive')}
        title={entry.ok ? 'OK' : 'Failed'}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-foreground truncate">{browserActionLabel(entry)}</span>
          <span className="ml-auto text-[10px] text-muted-foreground/70 whitespace-nowrap">{relativeTime(new Date(entry.ts).toISOString())}</span>
        </div>
        {(entry.reasoning || entry.preview) && (
          <p className="text-[11px] text-muted-foreground truncate" title={entry.reasoning || entry.preview}>
            {entry.reasoning || entry.preview}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * The shared browser view: chrome + live screenshot + reverse-chron action log.
 * `live` tints the header dot while a run is still streaming.
 */
export function BrowserActivityView({ activity, live, className }: {
  activity: BrowserActivityState;
  live?: boolean;
  className?: string;
}) {
  const newestFirst = [...activity.entries].reverse();
  return (
    <div className={cn('flex flex-col h-full min-h-0 bg-background', className)}>
      <BrowserUrlBar activity={activity} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Live view — the latest screenshot (data: URL → lightbox on click). */}
        {activity.screenshot ? (
          <div className="p-2 border-b border-border">
            <ExpandableDataImage
              src={activity.screenshot.src}
              alt={activity.currentDriver === 'computer'
                ? `Screenshot of your Mac${activity.currentApp ? ` (${activity.currentApp})` : ''}`
                : `Screenshot of ${browserHost(activity.screenshot.url) || 'the page'}`}
              className="w-full max-h-[50vh] rounded-lg border border-border object-contain bg-white"
            />
            <p className="mt-1 text-[10px] text-muted-foreground/70 text-center">
              {activity.currentDriver === 'computer'
                ? (activity.currentApp || 'Your Mac')
                : (browserHost(activity.screenshot.url) || 'Screenshot')}
              {' · '}{relativeTime(new Date(activity.screenshot.ts).toISOString())}
              {live && <span className="ml-1 text-ink-3">· live</span>}
            </p>
          </div>
        ) : activity.entries.length === 0 ? (
          <Empty className="border-0 p-6 md:p-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Globe /></EmptyMedia>
              <EmptyTitle className="text-sm">No browser activity yet</EmptyTitle>
              <EmptyDescription className="text-xs">
                When Digby browses the web for you, each page and action shows up here live.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <p className="px-3 py-2 text-[11px] text-muted-foreground border-b border-border">
            {live
              ? (activity.currentDriver === 'cloud' ? 'Rendering a preview of this page…' : 'Waiting for the first screenshot…')
              : 'No visual preview was captured for this browse.'}
          </p>
        )}
        {/* Action log — newest first, compact rows. */}
        {newestFirst.length > 0 && (
          <ul className="p-1">
            {newestFirst.map(e => <LogRow key={e.step} entry={e} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Mobile bottom sheet (<md only): auto-opened by the view on browser activity
 * (lib/browser-activity.ts nextBrowserSheetState), dismissible, with the
 * open-in-new-tab escape hatch in the header. Backdrop + sheet ride the app's
 * z tokens like the workspace drawer.
 */
export function BrowserBottomSheet({ activity, live, open, onClose }: {
  activity: BrowserActivityState;
  live?: boolean;
  open: boolean;
  onClose: () => void;
}) {
  if (!open || activity.entries.length === 0) return null;
  const url = activity.currentUrl;
  return (
    <div className="md:hidden">
      <div
        className="fixed inset-0 bg-black/40 z-(--z-overlay-backdrop)"
        style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Agent browser"
        className="fixed inset-x-0 bottom-0 z-(--z-overlay) flex flex-col rounded-t-2xl border-t border-border bg-background shadow-2xl max-h-[75dvh] animate-in slide-in-from-bottom-4"
      >
        {/* Grab handle + header: Globe favicon (no external favicon hosts) +
            page title (host) + escape hatch + close. */}
        <div className="mx-auto mt-1.5 h-1 w-9 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <Globe className={cn('size-4 shrink-0', live ? 'text-ink-3 animate-pulse' : 'text-ink-3')} />
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">{browserPageLabel(activity)}</span>
          {url && (
            <button
              onClick={() => window.open(url, '_blank', 'noopener')}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-2 hover:bg-muted transition-colors shrink-0"
            >
              <ExternalLink className="size-3.5" /> Open in browser
            </button>
          )}
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground shrink-0" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        {/* Body: the shared view minus its own URL bar? No — keep the full view:
            the pill carries the path, which the header host-title lacks. */}
        <div className="flex-1 min-h-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          <BrowserActivityView activity={activity} live={live} />
        </div>
      </div>
    </div>
  );
}
