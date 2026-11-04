'use client';

/**
 * Account → Admin → Endpoints → Model roles → "Reflection council" (F2, owner
 * 2026-10-06 late: "the only reason a frontier model is ever used is for a
 * special use case and tool like reflection").
 *
 * Automatic picks never choose a frontier model. When an agent fails
 * repeatedly it reflects and consults 1–3 frontier advisors OF ITS CHOOSING
 * (consult_frontier_council). This list is only the DEFAULT the harness
 * consults when the agent ignores its reflect note; empty = the first three
 * frontier models by vendor diversity. Self-loading; hides itself on a
 * backend that predates the route.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Users, ArrowUp, ArrowDown, X } from 'lucide-react';
import { reflectionCouncilApi, isReflectionCouncilView, type FrontierCouncilModel, type ReflectionCouncilView } from '@/lib/api/model-endpoints';
import { addableCouncilModels, councilBadges, councilDirty } from '@/lib/reflection-council';
import { movePoolEntry } from '@/lib/auto-pools';

export function ReflectionCouncilPanel() {
  const [view, setView] = useState<ReflectionCouncilView | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await reflectionCouncilApi.get();
      if (!isReflectionCouncilView(v)) { setView(null); return; }
      setView(v);
      setDraft([...v.config.models]);
    } catch {
      setView(null); // a backend without the route — the panel hides
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const bySpec = useMemo(() => new Map<string, FrontierCouncilModel>((view?.candidates ?? []).map(c => [c.spec, c])), [view]);
  if (!view || !draft) return null;

  const dirty = councilDirty(view.config.models, draft);
  const options = addableCouncilModels(view.candidates, draft);

  const save = async () => {
    setSaving(true);
    try {
      const r = await reflectionCouncilApi.update(draft);
      const next = { ...view, ...r };
      setView(next);
      setDraft([...next.config.models]);
      toast.success('Reflection council saved');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.response?.data?.message || 'Failed to save the reflection council');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border p-3 space-y-3" data-testid="reflection-council-panel">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-semibold inline-flex items-center gap-1.5"><Users className="size-3.5 text-brand-accent" /> Reflection council</span>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Frontier models are never picked automatically. When an agent fails repeatedly it writes a reflection and asks 1–3 frontier models of its choosing for advice; it keeps its own model. This list is who the harness asks when the agent ignores that step (at most {view.maxPerRun} councils per run, {view.sessionDailyCap} per session a day). Empty = the first {view.maxModels} frontier models by vendor.
            {view.disabled && <span className="text-warning"> FRONTIER_REFLECTION_COUNCIL_DISABLED is set on this instance — agents use the Double Checker instead.</span>}
          </p>
        </div>
        {dirty && (
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" variant="outline" onClick={() => setDraft([...view.config.models])} disabled={saving}>Reset</Button>
            <Button size="sm" onClick={save} disabled={saving} data-testid="reflection-council-save">
              {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
              Save
            </Button>
          </div>
        )}
      </div>

      {view.candidates.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No frontier model is configured on this instance (add one under Endpoints) — agents fall back to the Double Checker.</p>
      ) : draft.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Default: {view.defaults.join(', ') || 'none'}</p>
      ) : (
        <ol className="space-y-1">
          {draft.map((spec, i) => (
            <li key={spec} className="flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
              <span className="text-muted-foreground w-4 text-right">{i + 1}.</span>
              <code className="font-mono break-all">{spec}</code>
              {councilBadges(bySpec.get(spec)).map(b => <Badge key={b} variant="outline" className="text-[10px] px-1 py-0">{b}</Badge>)}
              <span className="ml-auto inline-flex gap-0.5">
                <Button size="icon" variant="ghost" className="size-6" aria-label="Move up" disabled={i === 0} onClick={() => setDraft(movePoolEntry(draft, i, -1))}><ArrowUp className="size-3" /></Button>
                <Button size="icon" variant="ghost" className="size-6" aria-label="Move down" disabled={i === draft.length - 1} onClick={() => setDraft(movePoolEntry(draft, i, 1))}><ArrowDown className="size-3" /></Button>
                <Button size="icon" variant="ghost" className="size-6" aria-label="Remove" onClick={() => setDraft(draft.filter(s => s !== spec))}><X className="size-3" /></Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      {view.dropped.length > 0 && (
        <p className="text-[11px] text-warning break-words">
          Skipped: {view.dropped.map(d => `${d.spec} (${d.reason})`).join('; ')}
        </p>
      )}
      {draft.length < view.maxModels && options.length > 0 && (
        <select
          className="w-full max-w-md rounded-md border bg-background px-2 py-1 text-[11px]"
          value=""
          aria-label="Add a frontier model to the reflection council"
          onChange={e => { const v = e.target.value; if (v) setDraft([...draft, v]); }}
        >
          <option value="">+ Add a frontier model…</option>
          {options.map(c => <option key={c.spec} value={c.spec}>{c.name} — {councilBadges(c).join(' · ')}</option>)}
        </select>
      )}
    </div>
  );
}
