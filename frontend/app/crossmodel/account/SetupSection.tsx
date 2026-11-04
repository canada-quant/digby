'use client';

/**
 * SetupSection — Account → Admin → Setup (self-host setup hardening, 2026-10-20).
 *
 * The one checklist of what THIS instance has configured, built from code
 * truth (GET /api/crossmodel/instance/setup → platform/instance-setup.ts):
 * every feature row says Ready / Partly set up / Not set up / Off, what the gap
 * costs the user, the exact env NAMES still missing (never values), the
 * compose profile to run, the OAuth callback URL to register, a copyable note
 * (the Telegram webhook command, the Mac-agent one-liner) and a deep link into
 * the self-hosting guide at /help/self-host. Browser-side build flags (the
 * production ad tags) are reported here too, from the bundle's own env.
 *
 * Production reads all-ready; a self-host at digby.example.com sees exactly its
 * own gaps. Nothing here mutates — the fixes are .env edits + a restart.
 */

import { useCallback, useEffect, useState } from 'react';
import NextLink from 'next/link';
import { toast } from 'sonner';
import { Wrench, RefreshCw, Loader2, Copy, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { instanceSetupApi, type InstanceSetup, type InstanceSetupFeature } from '@/lib/api/crossmodel';
import { groupFeatures, setupHeadline, stateTone, STATE_LABELS, SELF_HOST_HELP, type StateTone } from '@/lib/instance-setup';
import { googleAdsTagDisabled } from '@/lib/google-ads';
import { metaPixelDisabled } from '@/lib/meta-pixel';

const TONE_VARIANT: Record<StateTone, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  ok: 'success', warn: 'warning', bad: 'destructive', muted: 'secondary',
};

function copy(text: string, what: string) {
  try {
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${what}`);
  } catch {
    toast.error('Could not copy — select the text instead.');
  }
}

/**
 * Build-time browser flags the SERVER cannot see: on a self-host the production
 * Google Ads / GA4 / Meta Pixel tags must be off (the compose build args default
 * them off since 2026-10-20); this row makes a stale image visible.
 */
export function browserTagsFeature(selfHosted: boolean): InstanceSetupFeature | null {
  if (!selfHosted) return null;
  const adsOff = googleAdsTagDisabled();
  const pixelOff = metaPixelDisabled();
  const ok = adsOff && pixelOff;
  return {
    key: 'browser_tags',
    label: 'Browser analytics tags',
    group: 'instance',
    state: ok ? 'ready' : 'partial',
    configured: ok,
    required: false,
    summary: ok
      ? 'No production ad or analytics tags are compiled into this build.'
      : `This build still carries Digby's production ${[!adsOff && 'Google Ads / GA4 tag', !pixelOff && 'Meta Pixel'].filter(Boolean).join(' and ')} — page views report to Digby's accounts.`,
    help: `${SELF_HOST_HELP}#quick-start`,
    missing: [!adsOff && 'NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED', !pixelOff && 'NEXT_PUBLIC_META_PIXEL_DISABLED'].filter((x): x is string => !!x),
    present: [],
    hint: ok ? undefined : 'Rebuild the frontend with the build args NEXT_PUBLIC_GOOGLE_ADS_TAG_DISABLED=1 and NEXT_PUBLIC_META_PIXEL_DISABLED=1 (docker-compose.selfhost.yml defaults them on): docker compose -f docker-compose.selfhost.yml up -d --build frontend.',
  };
}

function FeatureRow({ f, admin }: { f: InstanceSetupFeature; admin: boolean }) {
  const tone = stateTone(f.state, f.required);
  const hasDetail = admin && (!!f.hint || !!f.note || !!f.redirectUri || (f.missing?.length ?? 0) > 0);
  const [open, setOpen] = useState(f.state !== 'ready');
  return (
    <div className="rounded-md bg-muted/40 px-3 py-3 space-y-2" data-testid={`setup-row-${f.key}`} data-state={f.state}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {hasDetail ? (
              <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-sm font-medium" aria-expanded={open}>
                {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                {f.label}
              </button>
            ) : (
              <span className="text-sm font-medium">{f.label}</span>
            )}
            <Badge variant={TONE_VARIANT[tone]} className="text-[10px]" data-testid={`setup-state-${f.key}`}>{STATE_LABELS[f.state]}</Badge>
            {f.required && f.state !== 'ready' && <Badge variant="outline" className="text-[10px]">required</Badge>}
            {f.profile && <Badge variant="outline" className="text-[10px] font-mono">--profile {f.profile}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{f.summary}</p>
        </div>
        <NextLink href={f.help} className="shrink-0 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline">
          Guide <ExternalLink className="size-3" />
        </NextLink>
      </div>

      {hasDetail && open && (
        <div className="space-y-2 border-t border-line pt-2">
          {(f.missing?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid={`setup-missing-${f.key}`}>
              <span className="text-[11px] text-muted-foreground">Missing in .env:</span>
              {f.missing!.map((name) => (
                <code key={name} className="rounded border border-warn/40 bg-warn/8 px-1.5 py-0.5 text-[10.5px] font-mono text-warn-ink">{name}</code>
              ))}
            </div>
          )}
          {(f.present?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Set:</span>
              {f.present!.map((name) => (
                <code key={name} className="rounded border border-line bg-muted px-1.5 py-0.5 text-[10.5px] font-mono text-muted-foreground">{name}</code>
              ))}
            </div>
          )}
          {f.hint && <p className="text-xs leading-relaxed" data-testid={`setup-hint-${f.key}`}>{f.hint}</p>}
          {f.redirectUri && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground shrink-0">Callback URL:</span>
              <code className="min-w-0 truncate rounded border border-line bg-muted px-1.5 py-0.5 text-[10.5px] font-mono" title={f.redirectUri}>{f.redirectUri}</code>
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={() => copy(f.redirectUri!, 'the callback URL')} aria-label="Copy callback URL">
                <Copy className="size-3" />
              </Button>
            </div>
          )}
          {f.note && (
            <div className="relative rounded border border-line bg-muted/60 p-2 pr-9">
              <pre className="whitespace-pre-wrap break-all text-[10.5px] font-mono leading-relaxed">{f.note}</pre>
              <Button variant="ghost" size="sm" className="absolute top-1 right-1 h-6 w-6 p-0" onClick={() => copy(f.note!, 'the note')} aria-label="Copy note">
                <Copy className="size-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SetupSection() {
  const [setup, setSetup] = useState<InstanceSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showReady, setShowReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSetup(await instanceSetupApi.get());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading && !setup) {
    return (
      <div className="rounded-lg border bg-card p-5 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking what this instance has configured…
      </div>
    );
  }
  if (loadError || !setup) {
    return <LoadErrorState message="Couldn't read this instance's setup state." onRetry={load} />;
  }

  const admin = setup.viewer.admin;
  const extra = browserTagsFeature(setup.instance.selfHosted);
  const allFeatures = extra ? [...setup.features, extra] : setup.features;
  const visible = showReady ? allFeatures : allFeatures.filter((f) => f.state !== 'ready');
  const groups = groupFeatures(visible);
  const readyCount = allFeatures.filter((f) => f.state === 'ready').length;

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4" data-testid="setup-section">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="size-4 text-brand-accent" />
        <h3 className="text-sm font-semibold">Setup</h3>
        <Badge variant={setup.summary.missingRequired.length ? 'destructive' : 'success'} className="text-[10px]" data-testid="setup-summary">
          {readyCount} of {allFeatures.length} ready
        </Badge>
        <button
          type="button"
          onClick={load}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          aria-label="Refresh"
        >
          <RefreshCw className="size-3.5" /> Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="setup-headline">{setupHeadline({ ...setup, features: allFeatures, summary: { ...setup.summary, ready: readyCount, total: allFeatures.length } })}</p>
      <p className="text-xs text-muted-foreground">
        Every row is read from this server&apos;s own configuration: a feature is Ready when the code that serves it can run here.
        Fixes are <code className="font-mono text-[11px]">.env</code> edits (names only — values never leave the server) followed by{' '}
        <code className="font-mono text-[11px]">docker compose up -d</code>; the{' '}
        <NextLink href={SELF_HOST_HELP} className="underline underline-offset-2">self-hosting guide</NextLink> has every step.
        {!admin && ' Only administrators see the exact variables.'}
      </p>
      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="size-3.5" checked={showReady} onChange={(e) => setShowReady(e.target.checked)} />
        Show items that are already ready
      </label>

      {groups.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="setup-all-ready">Everything this instance offers is ready.</p>
      )}
      {groups.map((g) => (
        <div key={g.group} className="space-y-2" data-testid={`setup-group-${g.group}`}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h4>
          {g.features.map((f) => <FeatureRow key={f.key} f={f} admin={admin} />)}
        </div>
      ))}
    </div>
  );
}

export default SetupSection;
