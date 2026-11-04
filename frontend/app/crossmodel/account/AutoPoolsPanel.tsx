'use client';

/**
 * Account → Admin → Endpoints → Model roles → "Auto pools" (dynamic roster
 * phase 1, 2026-10-03; owner chose option B — docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md).
 *
 * Per-lane ORDERED model lists the Auto roster planner picks from. An empty
 * list follows its seat(s), so nothing changes until an admin edits a pool.
 * Only open (auto-eligible) chat models can be added — the backend refuses a
 * frontier-class model too. Self-loading; hides itself on a backend that
 * predates the route.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Layers, ArrowUp, ArrowDown, X } from 'lucide-react';
import { autoPoolsApi, isAutoPoolsView, type AutoPoolRole, type AutoPoolsView, type CatalogModelCard } from '@/lib/api/model-endpoints';
import { AUTO_POOL_HELP, AUTO_POOL_ROLES, addableModels, cardBadges, dirtyPoolPatch, draftFromView, movePoolEntry, type PoolDraft } from '@/lib/auto-pools';

export function AutoPoolsPanel() {
  const [view, setView] = useState<AutoPoolsView | null>(null);
  const [draft, setDraft] = useState<PoolDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await autoPoolsApi.get();
      if (!isAutoPoolsView(v)) { setView(null); return; }
      setView(v);
      setDraft(draftFromView(v));
    } catch {
      setView(null); // a backend without the route — the panel hides
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const bySpec = useMemo(() => new Map<string, CatalogModelCard>((view?.catalog ?? []).map(c => [c.spec, c])), [view]);
  if (!view || !draft) return null;

  const patch = dirtyPoolPatch(view, draft);
  const dirty = Object.keys(patch).length;
  const labelOf = (role: AutoPoolRole) => view.roles.find(r => r.role === role)?.label ?? role;
  const setRole = (role: AutoPoolRole, list: string[]) => setDraft(d => (d ? { ...d, [role]: list } : d));

  const save = async () => {
    setSaving(true);
    try {
      const r = await autoPoolsApi.update(patch);
      const next = { ...view, config: r.config, effective: r.effective };
      setView(next);
      setDraft(draftFromView(next));
      toast.success('Auto pools saved');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.response?.data?.message || 'Failed to save the Auto pools');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border p-3 space-y-3" data-testid="auto-pools-panel">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-semibold inline-flex items-center gap-1.5"><Layers className="size-3.5 text-brand-accent" /> Auto pools</span>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            The models an Auto chat picks its team from, per lane. Auto sorts each message into a lane (Quick, Standard, Checked or Research) and takes models from these lists in order. An empty list follows its seat. Only open models can be added; frontier models are never picked automatically.
            {view.disabled && <span className="text-warning"> AUTO_POOLS_DISABLED is set on this instance, so every pool follows its seats.</span>}
          </p>
        </div>
        {dirty > 0 && (
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" variant="outline" onClick={() => setDraft(draftFromView(view))} disabled={saving}>Reset</Button>
            <Button size="sm" onClick={save} disabled={saving} data-testid="auto-pools-save">
              {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
              Save {dirty} pool{dirty === 1 ? '' : 's'}
            </Button>
          </div>
        )}
      </div>

      {AUTO_POOL_ROLES.map(role => {
        const list = draft[role];
        const eff = view.effective[role];
        const options = addableModels(view.catalog, role, list);
        return (
          <div key={role} className="space-y-1" data-testid={`auto-pool-${role}`}>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-xs font-medium">{labelOf(role)}</span>
              <span className="text-[11px] text-muted-foreground">{AUTO_POOL_HELP[role]}</span>
            </div>
            {list.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Following the seat{eff.models.length === 1 ? '' : 's'}: {eff.models.length ? eff.models.join(', ') : 'none resolved'}
              </p>
            ) : (
              <ol className="space-y-1">
                {list.map((spec, i) => (
                  <li key={spec} className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
                    <span className="text-muted-foreground w-4 text-right">{i + 1}.</span>
                    <code className="font-mono break-all">{spec}</code>
                    {cardBadges(bySpec.get(spec)).map(b => <Badge key={b} variant="outline" className="text-[10px] px-1 py-0">{b}</Badge>)}
                    <span className="ml-auto inline-flex gap-0.5">
                      <Button size="icon" variant="ghost" className="size-6" aria-label="Move up" disabled={i === 0} onClick={() => setRole(role, movePoolEntry(list, i, -1))}><ArrowUp className="size-3" /></Button>
                      <Button size="icon" variant="ghost" className="size-6" aria-label="Move down" disabled={i === list.length - 1} onClick={() => setRole(role, movePoolEntry(list, i, 1))}><ArrowDown className="size-3" /></Button>
                      <Button size="icon" variant="ghost" className="size-6" aria-label="Remove" onClick={() => setRole(role, list.filter(s => s !== spec))}><X className="size-3" /></Button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {eff.dropped.length > 0 && (
              <p className="text-[11px] text-warning break-words">
                Skipped at run time: {eff.dropped.map(d => `${d.spec} (${d.reason})`).join('; ')}
              </p>
            )}
            {list.length < view.maxModels && options.length > 0 && (
              <select
                className="w-full max-w-md rounded-md border bg-background px-2 py-1 text-[11px]"
                value=""
                aria-label={`Add a model to the ${labelOf(role)} pool`}
                onChange={e => { const v = e.target.value; if (v) setRole(role, [...list, v]); }}
              >
                <option value="">+ Add a model…</option>
                {options.map(c => <option key={c.spec} value={c.spec}>{c.name} — {cardBadges(c).join(' · ')}</option>)}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}
