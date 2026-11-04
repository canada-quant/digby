'use client';

/**
 * Admin → Settings → "Depth policy" panel (audit 2026-09-26: the always-Auto
 * switch `patience_auto_only` had been flipped ON in production at
 * 2026-09-26 20:35Z with no UI, no audit row and every doc still saying OFF).
 * One toggle bound to the admin-only SystemSetting through
 * adminApi.setPatienceAutoOnly (PUT /admin/settings/patience_auto_only
 * { value: '0'|'1' } — validated, idempotent, audited with `_by`), the
 * since / by facts from GET /admin/settings/patience-auto-only, the "what ON
 * means" copy, and a confirm dialog before turning it OFF (turning ON is
 * immediate — it only removes a control the user never sees). The backend
 * flips LIVE (60 s cache on every box); nothing here needs a deploy.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SlidersHorizontal, RefreshCw, Loader2 } from 'lucide-react';
import { adminApi, type PatienceAutoOnlyState } from '@/lib/api/crossmodel';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { describeAutoOnlyState } from '@/lib/depth-ux';

export const PATIENCE_AUTO_ONLY_KEY = 'patience_auto_only';

/** What ON means — one fact per line (pinned by the vitest). */
export const AUTO_ONLY_ON_FACTS: readonly string[] = [
  'Every human send into a normal chat is routed as Auto — the router picks the shape per question; a depth level a stored client sends (REST / API callers — the web sends Auto) is kept only as the requested depth (routing.requestedMode) and never picks the run.',
  'Guests are routed too (kept off Research); kids, supervisor chats and Dig deeper re-runs are never touched.',
  'Turning it OFF restores the pre-policy semantics at once: an API client’s explicit preset picks the run again and guests get the forced Ensemble.',
  'The switch is admin-only — no platform tool can write it. The flip is live within 60 s on every box; no deploy.',
];

export function PatienceAutoOnlySection() {
  const [state, setState] = useState<PatienceAutoOnlyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await adminApi.getPatienceAutoOnly());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flip = useCallback(async (enabled: boolean) => {
    setSaving(true);
    try {
      const res = await adminApi.setPatienceAutoOnly(enabled);
      if (res.state) setState(res.state);
      else await load();
      toast.success(
        res.changed
          ? `Always-Auto turned ${enabled ? 'ON' : 'OFF'} — live fleet-wide within 60 s.`
          : `Always-Auto was already ${enabled ? 'ON' : 'OFF'}.`,
      );
    } catch {
      toast.error('Failed to update the always-Auto policy');
    } finally {
      setSaving(false);
    }
  }, [load]);

  const onToggle = (next: boolean) => {
    if (next) void flip(true); // turning ON is immediate
    else setConfirmOff(true); // turning OFF confirms first
  };

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4" data-testid="patience-auto-only-section">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Depth policy</h3>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Always-Auto: route every human send through the Auto router regardless of the depth the client asked for. The flip is live within 60 s on every box — no deploy.
      </p>
      {loading && !state ? (
        <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
      ) : error && !state ? (
        <p className="text-xs text-destructive">Could not load the always-Auto switch.</p>
      ) : state ? (
        <div className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-3" data-testid="patience-auto-only-switch">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Always-Auto</span>
              {state.enabled
                ? <Badge variant="success" className="text-[10px]">ON</Badge>
                : <Badge variant="warning" className="text-[10px]">OFF</Badge>}
              <code className="text-[10px] font-mono text-muted-foreground">{state.key}</code>
            </div>
            <p className="text-xs" data-testid="patience-auto-only-status">{describeAutoOnlyState(state)}</p>
          </div>
          <Switch
            aria-label="Always-Auto enabled"
            checked={state.enabled}
            disabled={saving}
            onCheckedChange={(v) => onToggle(v)}
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-xs font-medium">What ON means</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {AUTO_ONLY_ON_FACTS.map((f) => <li key={f} className="text-xs text-muted-foreground">{f}</li>)}
        </ul>
      </div>

      <AlertDialog open={confirmOff} onOpenChange={(open) => { if (!open) setConfirmOff(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn always-Auto off?</AlertDialogTitle>
            <AlertDialogDescription>
              Every client&apos;s explicit depth is honoured again: an explicit preset (REST / API caller) picks the run, mobile levels are taken as sent, and guests get the forced Ensemble. Sends already in flight finish as routed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              className="bg-send hover:bg-send/90 text-send-ink"
              onClick={() => { setConfirmOff(false); void flip(false); }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default PatienceAutoOnlySection;
