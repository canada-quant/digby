'use client';

/**
 * Account → Admin → Endpoints → Model roles → "Ghost mode" (2026-10-22).
 *
 * Per-chat ghost mode routes a chat's models to ONE admin-designated
 * self-hosted endpoint (an "abliterated" unrestricted model) and keeps the
 * chat out of memory / learning / cross-chat surfacing. THIS panel is the
 * admin designation: which chat-capable registry model ghost chats run on,
 * and whether the feature is offered at all. Users toggle ghost mode per
 * chat (side panel → Settings) or per guest session (composer toggle) — the
 * backend applies the routing server-side.
 *
 * Self-loading; hides itself on a backend that predates the route (GET 404s
 * or returns a partial body — isGhostEndpointView). A 400 from PUT carries a
 * human reason (unresolvable spec, non-chat model, not servable) and is
 * surfaced inline + as a toast.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Ghost, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { ghostEndpointApi, isGhostEndpointView, modelEndpointsApi, isChatCapableModel, type GhostEndpointView, type ModelEndpoint } from '@/lib/api/model-endpoints';
import { relativeTimeLong } from '@/lib/relative-time';

export function GhostModePanel() {
  const [view, setView] = useState<GhostEndpointView | null>(null);
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([]);
  const [missing, setMissing] = useState(false); // older backend — hide
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [v, eps] = await Promise.all([
        ghostEndpointApi.get(),
        // The registry list feeds the model picker. Tolerated failure: a
        // backend without it still renders the panel (read-only spec row).
        modelEndpointsApi.list().catch(() => [] as ModelEndpoint[]),
      ]);
      if (!isGhostEndpointView(v)) { setMissing(true); return; }
      setView(v);
      setEndpoints(eps);
    } catch {
      setMissing(true); // a backend without the route — the panel hides
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Chat-capable registry models (the same rule agent seats use — kind
   *  'chat' / legacy [coding] / detection / id heuristic, via
   *  isChatCapableModel; mirrors ModelRolesSection's registryOptions). */
  const registryOptions = useMemo(() => {
    const all: Array<{ spec: string; name: string }> = [];
    for (const ep of endpoints.filter(e => e.enabled)) {
      for (const m of ep.models) {
        if (isChatCapableModel(m)) {
          all.push({ spec: `${ep.label}:${m.id}`, name: `${ep.label} · ${m.displayName || m.id}` });
        }
      }
    }
    return all;
  }, [endpoints]);
  const bySpec = useMemo(() => new Map(registryOptions.map(o => [o.spec, o])), [registryOptions]);

  if (missing || !view) return null;

  /**
   * Save — the backend REPLACES the designation: a body whose `spec` is
   * absent/null CLEARS it (review D2, 2026-10-22: `{ enabled }` alone would
   * wipe the designation entirely). Every save therefore carries the FULL
   * body — the spec the admin sees plus the enabled flag — so the toggle can
   * never destroy the designation and the picker can never flip the flag.
   */
  const save = async (next: { spec: string | null; enabled: boolean }) => {
    setSaving(true);
    setError(null);
    try {
      const v = await ghostEndpointApi.update(next);
      if (!isGhostEndpointView(v)) throw new Error('unexpected response');
      setView(v);
      toast.success('Ghost endpoint saved');
    } catch (err: any) {
      // 400 carries { error } with the human reason — show it inline.
      const reason = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Failed to save the ghost endpoint';
      setError(String(reason));
      toast.error(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const specName = view.spec ? (bySpec.get(view.spec)?.name ?? view.spec) : null;

  return (
    <div className="rounded-xl border p-3 space-y-3" data-testid="ghost-mode-panel">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-semibold inline-flex items-center gap-1.5"><Ghost className="size-3.5 text-brand-accent" /> Ghost mode</span>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            The self-hosted model per-chat ghost mode routes through. When on, a ghost chat&apos;s models are routed to this endpoint and the chat is kept out of memory, learning and cross-chat surfacing — the user&apos;s transcript stays in their account.
          </p>
        </div>
      </div>

      {/* The designation — a chat-capable registry model, or none. */}
      {view.spec ? (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
          <code className="font-mono break-all">{specName}</code>
          <span className="ml-auto inline-flex gap-0.5">
            <Button
              size="icon" variant="ghost" className="size-6" aria-label="Clear the ghost endpoint"
              disabled={saving} onClick={() => void save({ spec: null, enabled: false })}
            >
              <X className="size-3" />
            </Button>
          </span>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No ghost endpoint designated — ghost mode is not offered until one is set.</p>
      )}

      <select
        className="w-full max-w-md rounded-md border bg-background px-2 py-1 text-[11px]"
        value=""
        aria-label="Designate the ghost endpoint model"
        disabled={saving || registryOptions.length === 0}
        onChange={e => { const v = e.target.value; if (v) void save({ spec: v, enabled: true }); }}
      >
        <option value="">
          {registryOptions.length === 0
            ? 'No chat-capable registry model on this instance'
            : view.spec ? 'Switch to a different model…' : 'Designate a ghost endpoint model…'}
        </option>
        {registryOptions.map(o => (
          <option key={o.spec} value={o.spec}>{o.name}</option>
        ))}
      </select>

      {/* Enabled — the instance-wide offer switch (independent of the spec). */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Offer ghost mode on this instance
        </span>
        <Switch
          aria-label="Ghost mode enabled"
          checked={view.enabled}
          disabled={saving}
          onCheckedChange={(v) => void save({ spec: view.spec, enabled: v })}
        />
      </div>

      {error && <p className="text-[11px] text-destructive break-words" data-testid="ghost-mode-panel-error">{error}</p>}

      {view.updatedAt && (
        <p className="text-[11px] text-muted-foreground/80">Last saved {relativeTimeLong(view.updatedAt)}</p>
      )}
    </div>
  );
}
