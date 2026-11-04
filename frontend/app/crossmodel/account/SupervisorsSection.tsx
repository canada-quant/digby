'use client';

/**
 * Admin → Settings → "Supervisors" panel (owner 2026-09-26: "we need a way to
 * turn off fleet supervisor from the framework"). Two toggles bound to the
 * admin-only SystemSettings `fleet_supervisor_enabled` /
 * `project_supervisors_enabled` (GET /admin/settings/supervisors, PUT
 * /admin/settings/<key> { value: '0'|'1' }), the skipped-wake counter since
 * the flip, the since/by facts, the "what OFF means" copy, and a confirm
 * dialog before turning a tier OFF (turning ON is immediate). The backend
 * flips LIVE (60 s cache elsewhere in the fleet); nothing here needs a deploy.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ShieldOff, RefreshCw, Loader2 } from 'lucide-react';
import { adminApi } from '@/lib/api/crossmodel';
import type { SupervisorSwitchState, SupervisorSwitchTargetState } from '@/lib/api/fleet';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  SUPERVISOR_SWITCH_LABEL, SUPERVISOR_OFF_FACTS, describeSwitchTarget, totalSkipped, confirmOffCopy,
  FLEET_SUPERVISOR_ENABLED_KEY, PROJECT_SUPERVISORS_ENABLED_KEY,
} from '@/lib/supervisor-switch';

const KEY_OF: Record<'fleet' | 'project', string> = {
  fleet: FLEET_SUPERVISOR_ENABLED_KEY,
  project: PROJECT_SUPERVISORS_ENABLED_KEY,
};

const TARGET_HINT: Record<'fleet' | 'project', string> = {
  fleet: 'The one pinned Fleet Supervisor chat per owner — hook wakes, 2 h sweeps, infra alerts, follow-through nudges, spawns.',
  project: 'Every per-project supervisor lane — project-scope hook wakes, hourly sweeps, worker spawns; no new lane is scaffolded while off.',
};

export function SupervisorsSection() {
  const [state, setState] = useState<SupervisorSwitchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState<'fleet' | 'project' | null>(null);
  const [confirmOff, setConfirmOff] = useState<'fleet' | 'project' | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await adminApi.getSupervisorSwitches());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const flip = useCallback(async (target: 'fleet' | 'project', enabled: boolean) => {
    setSaving(target);
    try {
      const res = await adminApi.setSupervisorSwitch(KEY_OF[target], enabled);
      if (res.state) setState(res.state);
      else await load();
      toast.success(
        res.changed
          ? `${SUPERVISOR_SWITCH_LABEL[target]} turned ${enabled ? 'ON' : 'OFF'} — live fleet-wide within 60 s.`
          : `${SUPERVISOR_SWITCH_LABEL[target]} was already ${enabled ? 'ON' : 'OFF'}.`,
      );
    } catch {
      toast.error(`Failed to update ${SUPERVISOR_SWITCH_LABEL[target].toLowerCase()}`);
    } finally {
      setSaving(null);
    }
  }, [load]);

  const onToggle = (target: 'fleet' | 'project', next: boolean) => {
    if (next) void flip(target, true); // turning ON is immediate
    else setConfirmOff(target); // turning OFF confirms first
  };

  const skipped = totalSkipped(state);
  const copy = confirmOff ? confirmOffCopy(confirmOff) : null;

  const row = (t: SupervisorSwitchTargetState) => (
    <div key={t.target} className="flex items-start justify-between gap-4 rounded-md bg-muted/40 px-3 py-3" data-testid={`supervisor-switch-${t.target}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{SUPERVISOR_SWITCH_LABEL[t.target]}</span>
          {t.enabled
            ? <Badge variant="success" className="text-[10px]">ON</Badge>
            : <Badge variant="warning" className="text-[10px]">OFF</Badge>}
          <code className="text-[10px] font-mono text-muted-foreground">{t.key}</code>
        </div>
        <p className="text-xs text-muted-foreground">{TARGET_HINT[t.target]}</p>
        <p className="text-xs" data-testid={`supervisor-switch-${t.target}-status`}>{describeSwitchTarget(t)}</p>
      </div>
      <Switch
        aria-label={`${SUPERVISOR_SWITCH_LABEL[t.target]} enabled`}
        checked={t.enabled}
        disabled={saving !== null}
        onCheckedChange={(v) => onToggle(t.target, v)}
      />
    </div>
  );

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldOff className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Supervisors</h3>
        {state && skipped !== null && skipped > 0 && (
          <Badge variant="warning" className="text-[10px]" data-testid="supervisor-switch-skipped">wakes skipped: {skipped}</Badge>
        )}
        <button type="button" onClick={() => void load()} disabled={loading}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Turn the Fleet Supervisor and the project supervisors off from the framework. The flip is live within 60 s on every box — no deploy.
      </p>
      {loading && !state ? (
        <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
      ) : error && !state ? (
        <p className="text-xs text-destructive">Could not load the supervisor switches.</p>
      ) : state ? (
        <div className="space-y-2">
          {row(state.fleet)}
          {row(state.project)}
          {state.line && (
            <p className="text-xs font-medium text-warn-ink" data-testid="supervisor-switch-line">{state.line}</p>
          )}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-xs font-medium">What OFF means</p>
        <ul className="list-disc pl-4 space-y-0.5">
          {SUPERVISOR_OFF_FACTS.map((f) => <li key={f} className="text-xs text-muted-foreground">{f}</li>)}
        </ul>
      </div>

      <AlertDialog open={confirmOff !== null} onOpenChange={(open) => { if (!open) setConfirmOff(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              className="bg-send hover:bg-send/90 text-send-ink"
              onClick={() => { const t = confirmOff; setConfirmOff(null); if (t) void flip(t, false); }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SupervisorsSection;
