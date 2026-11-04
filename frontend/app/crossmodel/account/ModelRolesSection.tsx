'use client';

/**
 * Model roles — Digby Edge admin section (Account → Admin → Endpoints, below
 * the endpoint registry). Lets an admin point each NAMED SEAT of the Digby
 * experience (Digby the lead, the Double Checker — ONE secondary model for
 * Level 2 and the Level 3 council — the Triple Checker council colleague,
 * The Helper fast tier, the background utility model, the capability seats —
 * Image reader, PDF reader (OCR), Browser agent, Computer-use vision, Digby
 * Kids — the RAG embeddings/reranker, and the speech seats ASR + TTS) at a
 * built-in model or any registered custom endpoint model ("<label>:<modelId>")
 * — so an Edge instance without the cloud provider keys can run the FULL
 * experience on its own servers. Seat names are the SAME strings the chat's
 * status stream and More-info cards show (owner 2026-09-15). 2026-09-22
 * (owner: "fully configure and edit ALL models … understand what everything is
 * doing exactly"): every model call is a seat, the built-in picks per seat come
 * from the backend (`builtInOptions`), and a read-only MODEL MAP below the
 * seats lists every built-in model's fixed call parameters and every fixed
 * chain (fallback orders, pipelines).
 *
 * "Add custom fallback" (owner 2026-09-15): fallbackable seats carry a second
 * picker — the model that serves when the seat's own model fails — replacing
 * Digby's built-in fallback behaviour (described under the picker).
 *
 * Every row has a live "Test" button that exercises the REAL call shape
 * (streamed chat completion to first token / /embeddings with the 1536-dim
 * check / Cohere-style /rerank / multipart /audio/transcriptions with a tiny
 * silent WAV) — not just GET /models. The fallback slot has its own Test.
 *
 * Decision backends (2026-09-26, owner: "support the open weight version of
 * jev for testing different decision models … we are self hosting laya now"):
 * the Decision gate seat carries a third control, DecisionBackendsPanel — per
 * purpose a PRIMARY backend (built-in jev / deepseek-flash readout, or any
 * registered endpoint model: a systemone server such as Laya, JevK5, NeoHorse
 * or openjev, or a logprobs-capable chat server) plus CHALLENGERS asked in
 * parallel whose answers only ever land as shadow rows; a comparison table
 * from the readiness job's per-(purpose, backend) report; a Test per backend;
 * and "Promote to primary", which warns that an act purpose drops to shadow
 * until the readiness job re-stamps the new backend (≤ 6 h).
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  modelRolesApi, modelEndpointsApi, decisionGateApi, decisionBackendsApi, isChatCapableModel,
  type ModelRole, type ModelRoleTestResult, type ModelEndpoint, type ProviderKeyStatus, type BuiltInModelInfo, type FixedChain,
  type DecisionModeConfig, type DecisionReadinessView, type DecisionBackendsView, type DecisionBackendsPatch, type DecisionBackendCandidate, type DecisionReadinessEntry,
  type DecisionRegistryView, type DecisionRolloutView, type SeatApplyReport,
} from '@/lib/api/model-endpoints';
import { sortRegistryRows, TIER_TITLE, type RegistrySortKey } from '@/lib/decision-registry';
import {
  PROMOTE_CONFIRM_COPY, backendRoleFor, coerceBackendsView, dirtyBackendPatch, draftFromConfig, effectiveChallengers, entryBackendKey,
  fmtMetric, fmtMs, fmtPercent, isDecisionBackendsView, primaryChangesOnActPurposes, promotePatch, purposeKeys, purposeLabelFor, purposeView, readinessEntryMetrics,
  type BackendsDraft,
} from '@/lib/decision-backends';
import { Loader2, PlugZap, Check, X, UsersRound, KeyRound, LifeBuoy, Plus, Map, ChevronDown, ChevronRight, ToggleLeft, Scale, ArrowUpToLine, FlaskConical } from 'lucide-react';
import { ExpandableDataImage } from '@/components/ui/custom/prompt/expandable-data-image';
import { AutoPoolsPanel } from './AutoPoolsPanel';
import { ReflectionCouncilPanel } from './ReflectionCouncilPanel';
import { GhostModePanel } from './GhostModePanel';

// ── Seats govern sessions (2026-09-28): "Apply seats to existing sessions" ──
//
// The Workspace default seat now governs every coding session at run time
// (explicit session pick → human-set project pick → a preference the user set
// themselves → the seat). This action is the one-click re-point for the
// RECORDS: it clears framework-stamped project overrides that point at
// built-ins, re-stamps provenance-less live sessions to the seat and lists the
// explicit picks it leaves alone. Dry-run preview first, then apply.

/** One line per counter of a report — pure, shared by the preview and the applied result. */
export function seatApplySummaryLines(r: SeatApplyReport): string[] {
  return [
    `Seat: ${r.seat}`,
    `Projects: ${r.projects.cleared} override${r.projects.cleared === 1 ? '' : 's'} ${r.dryRun ? 'to clear' : 'cleared'} (framework-stamped built-ins), ${r.projects.kept} human / registry pick${r.projects.kept === 1 ? '' : 's'} left alone`,
    `Sessions: ${r.sessions.restamped} live session${r.sessions.restamped === 1 ? '' : 's'} ${r.dryRun ? 'to re-stamp' : 're-stamped'} to the seat, ${r.sessions.explicit} explicit pick${r.sessions.explicit === 1 ? '' : 's'} left alone, ${r.sessions.alreadyOnSeat} already on the seat`,
    `Preferences: ${r.prefs.explicit} explicit personal pick${r.prefs.explicit === 1 ? '' : 's'} (their sessions follow it), ${r.prefs.ignored} stored value${r.prefs.ignored === 1 ? '' : 's'} with no explicit marker (the seat governs — nothing to change)`,
    ...(r.errors.length ? [`Errors: ${r.errors.length} — ${r.errors.slice(0, 3).join('; ')}${r.errors.length > 3 ? ' …' : ''}`] : []),
  ];
}

function SeatApplyPanel({ onApplied }: { onApplied: () => void }) {
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [preview, setPreview] = useState<SeatApplyReport | null>(null);
  const [applied, setApplied] = useState<SeatApplyReport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const runPreview = async () => {
    setBusy('preview');
    setApplied(null);
    try {
      setPreview(await modelRolesApi.applySeats(true));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.response?.data?.message || 'Preview failed');
    } finally {
      setBusy(null);
    }
  };
  const runApply = async () => {
    setConfirmOpen(false);
    setBusy('apply');
    try {
      const r = await modelRolesApi.applySeats(false);
      setApplied(r);
      setPreview(null);
      toast.success(`Applied — ${r.sessions.restamped} session(s) re-stamped, ${r.projects.cleared} project override(s) cleared`);
      onApplied();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.response?.data?.message || 'Apply failed');
    } finally {
      setBusy(null);
    }
  };
  const shown = applied ?? preview;
  return (
    <div className="rounded-xl border p-3 space-y-2" data-testid="seat-apply-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-semibold">Apply seats to existing sessions</span>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Seats govern every coding session at run time (an explicit session pick, a human-set project pick or a personal pick you made yourself still wins). This re-points the records: it clears framework-stamped project overrides that name a built-in model, re-stamps live sessions with no provenance to the Workspace default seat, and lists the explicit picks it leaves alone. Preview first — nothing is written until you apply.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={runPreview} disabled={busy !== null} data-testid="seat-apply-preview">
          {busy === 'preview' && <Loader2 className="size-3.5 animate-spin mr-1" />}
          Preview (dry run)
        </Button>
        <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={busy !== null || !preview} data-testid="seat-apply-run" title={preview ? 'Apply the previewed plan' : 'Run the preview first'}>
          {busy === 'apply' && <Loader2 className="size-3.5 animate-spin mr-1" />}
          Apply seats to existing sessions
        </Button>
      </div>
      {shown && (
        <div className="rounded-md border border-dashed px-2 py-1 text-[11px] space-y-0.5" data-testid="seat-apply-report">
          <p className="font-medium">{shown.dryRun ? 'Preview — nothing written yet' : 'Applied'} · {new Date(shown.at).toISOString().slice(0, 16).replace('T', ' ')}Z</p>
          {seatApplySummaryLines(shown).map(line => <p key={line} className="text-muted-foreground break-words">{line}</p>)}
          {shown.projects.rows.filter(r => r.action === 'cleared').length > 0 && (
            <p className="text-muted-foreground break-words">Project overrides {shown.dryRun ? 'to clear' : 'cleared'}: {shown.projects.rows.filter(r => r.action === 'cleared').map(r => `${r.projectId.slice(0, 8)} (${r.codingModel})`).join(', ')}</p>
          )}
          {shown.sessions.rows.filter(r => r.action === 'explicit').length > 0 && (
            <p className="text-muted-foreground break-words">Explicit session picks left alone: {shown.sessions.rows.filter(r => r.action === 'explicit').map(r => `${r.sessionId.slice(0, 8)} (${r.from}, ${r.modelSource})`).join(', ')}</p>
          )}
        </div>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply seats to existing sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview ? seatApplySummaryLines(preview).join(' · ') : 'Run the preview first.'} Explicit picks (a session set with set_session_model or a spawn-time model, a human-set project pick, a personal pick you made yourself) are never touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runApply}>Apply</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Decision-role registry + the rollout automaton (rollout self-governance, 2026-09-27) ──

// The sort + tier copy live in lib/decision-registry.ts (pure, tested without rendering).

function DecisionRegistryPanel({ view, onRollout }: { view: DecisionRegistryView; onRollout: (rollout: DecisionRolloutView) => void }) {
  const [sortKey, setSortKey] = useState<RegistrySortKey>('tier');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [flipping, setFlipping] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useMemo(() => sortRegistryRows(view.registry, sortKey, sortDir), [view.registry, sortKey, sortDir]);
  const sw = view.rollout.switch;
  const st = view.rollout.state;
  const parked = Object.entries(st.parked).filter(([, p]) => Date.parse(p.until) > Date.now()).map(([k]) => k);
  const header = (key: RegistrySortKey, label: string) => (
    <button
      type="button"
      className={cn('inline-flex items-center gap-0.5 font-medium hover:text-foreground', sortKey === key ? 'text-foreground' : 'text-muted-foreground')}
      onClick={() => { if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(key); setSortDir('asc'); } }}
      aria-label={`Sort the decision-role registry by ${label}`}
      data-testid={`decision-registry-sort-${key}`}
    >
      {label}{sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
  const toggleRollout = async () => {
    setFlipping(true);
    try {
      const next = await decisionGateApi.setRollout(!sw.enabled);
      onRollout(next);
      toast.success(`Auto-rollout ${next.switch.enabled ? 'ON' : 'OFF'}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? err?.message ?? 'Could not flip the auto-rollout switch');
    } finally {
      setFlipping(false);
    }
  };
  return (
    <div className="mt-2 rounded-lg border border-dashed p-2.5 space-y-1.5" data-testid="decision-gate-registry">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium"><Map className="size-3.5 text-brand-accent" /> Decision roles registry + rollout automaton</span>
        <Badge variant={sw.enabled ? 'default' : 'outline'} className={cn('text-[10px]', sw.enabled && 'bg-success text-success-foreground')} title={`SystemSetting decision_gate_auto_rollout (boot default ${sw.bootDefault ? 'ON' : 'OFF'}; since ${sw.since ?? 'never set'}${sw.updatedBy ? ` by ${sw.updatedBy}` : ''}). The worker cron decision-gate-rollout runs every ${sw.intervalMin} min and judges each readiness report once.`} data-testid="decision-rollout-switch">
          auto-rollout {sw.enabled ? 'ON' : 'OFF'}
        </Badge>
        {sw.dryRun && <Badge variant="outline" className="text-[10px]" title="DECISION_GATE_AUTO_ROLLOUT_DRY_RUN is set on the answering backend — the automaton records what it WOULD flip and writes no mode.">dry run</Badge>}
        {sw.jobDisabled && <Badge variant="destructive" className="text-[10px]" title="DECISION_GATE_ROLLOUT_JOB_DISABLED is set — the cron computes nothing.">job disabled</Badge>}
        {st.inconsistencies.length > 0 && <Badge variant="destructive" className="text-[10px]" title={st.inconsistencies.join('\n')} data-testid="decision-rollout-inconsistencies">{st.inconsistencies.length} store/code inconsistenc{st.inconsistencies.length === 1 ? 'y' : 'ies'}</Badge>}
        <div className="flex-1" />
        <span className="text-[11px] text-muted-foreground" title={st.lastSummary ?? 'the automaton has not run yet'}>{st.lastRunAt ? `last pass ${new Date(st.lastRunAt).toLocaleString()}` : 'no pass yet'}</span>
        <Button size="sm" variant="outline" onClick={toggleRollout} disabled={flipping} data-testid="toggle-decision-rollout">
          {flipping && <Loader2 className="size-3.5 animate-spin mr-1" />}
          {sw.enabled ? 'Turn auto-rollout off' : 'Turn auto-rollout on'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">{view.tierRule}. A wrong act shows up as an auto-demote; a purpose auto-demoted twice in a week is parked for a week. Off purposes are never touched; a store row that says act for a code-capped purpose is reported here, never rewritten.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" data-testid="decision-registry-table">
          <thead>
            <tr className="text-left border-b">
              <th className="py-1 pr-2">{header('label', 'Purpose')}</th>
              <th className="py-1 pr-2">{header('tier', 'Tier')}</th>
              <th className="py-1 pr-2">{header('effective', 'Now')}</th>
              <th className="py-1 pr-2">{header('ready', 'Readiness')}</th>
              <th className="py-1 pr-2 text-muted-foreground font-medium" title="Answered backend calls (memo hits excluded) and the recorded run_spend USD for this purpose over the last 24 h — Account → Admin → API costs has the full window.">24 h</th>
              <th className="py-1 pr-2 text-muted-foreground font-medium">What act does</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const readyNow = !!r.readiness?.ready && !r.readiness?.stale;
              const isOpen = open === r.purpose;
              return (
                <Fragment key={r.purpose}>
                  <tr className="border-b border-dashed align-top cursor-pointer hover:bg-muted/40" onClick={() => setOpen(isOpen ? null : r.purpose)} data-testid={`decision-registry-${r.purpose}`}>
                    <td className="py-1 pr-2">
                      <span className="font-medium">{purposeLabelFor(r.purpose, r.label)}</span>
                      <code className="ml-1 font-mono text-[10px] text-muted-foreground">{r.purpose}</code>
                      {r.parked && <Badge variant="outline" className="ml-1 text-[10px]" title={`Parked by the automaton until ${st.parked[r.purpose]?.until ?? '?'} (${st.parked[r.purpose]?.reason ?? 'repeated auto-demotes'}).`}>parked</Badge>}
                      {r.actCap?.active && <Badge variant="outline" className="ml-1 text-[10px]" title={`Capped at shadow in code since ${r.actCap.since}: ${r.actCap.why} — lift with ${r.actCap.liftEnv}=1.`}>capped</Badge>}
                      {r.retiredOnHumanTurns?.active && <Badge variant="outline" className="ml-1 text-[10px]" data-testid={`decision-registry-human-retired-${r.purpose}`} title={`Not asked on human turns since ${r.retiredOnHumanTurns.since}: ${r.retiredOnHumanTurns.why} — machine turns still ask. Restore with ${r.retiredOnHumanTurns.liftEnv}=1 (or ${r.retiredOnHumanTurns.globalLiftEnv}=1 for all).`}>human: retired</Badge>}
                      {st.ownerAsks[r.purpose] && <Badge variant="outline" className="ml-1 text-[10px]" title={`Owner question ${st.ownerAsks[r.purpose].questionId} filed ${st.ownerAsks[r.purpose].at} — ready, needs the owner.`}>needs owner</Badge>}
                    </td>
                    <td className="py-1 pr-2"><Badge variant="outline" className="text-[10px]" title={`${TIER_TITLE[r.tier]} ${r.tierWhy}`}>tier {r.tier}</Badge></td>
                    <td className="py-1 pr-2"><code className="font-mono" title={`from ${r.effectiveSource ?? '?'}${r.storeMode ? ` (store ${r.storeMode})` : ''}${r.primarySpec ? `; primary ${r.primarySpec}` : ''}`}>{r.effective ?? '?'}</code></td>
                    <td className="py-1 pr-2">
                      {r.readiness
                        ? <Badge variant={readyNow ? 'default' : 'secondary'} className={cn('text-[10px]', readyNow && 'bg-success')} title={`${r.readiness.ready ? 'READY' : 'NOT READY'}${r.readiness.stale ? ' (stale)' : ''}${r.readiness.at ? ` — stamped ${r.readiness.at}` : ''}${r.readiness.reasons?.length ? ` — ${r.readiness.reasons.join('; ')}` : ''}${r.admission?.reason ? `\nadmission: ${r.admission.reason}` : ''}`}>{readyNow ? 'READY' : r.readiness.ready ? 'stale' : 'not ready'}</Badge>
                        : <Badge variant="outline" className="text-[10px]" title={r.admission?.reason ?? 'no readiness stamp'}>no stamp</Badge>}
                    </td>
                    <td className="py-1 pr-2 tabular-nums whitespace-nowrap" data-testid={`decision-registry-cost-${r.purpose}`} title={typeof r.calls24h === 'number' ? `${r.calls24h} answered calls in 24 h; $${(r.costUsd24h ?? 0).toFixed(4)} recorded over ${r.pricedCalls24h ?? 0} priced calls` : 'cost readout needs the 2026-09-28 backend'}>
                      {typeof r.calls24h === 'number' ? <>{r.calls24h.toLocaleString()} · <span className="text-success">${(r.costUsd24h ?? 0) >= 0.01 ? (r.costUsd24h ?? 0).toFixed(2) : (r.costUsd24h ?? 0).toFixed(4)}</span></> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground max-w-[420px]">{r.actDoes}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-dashed bg-muted/20" data-testid={`decision-registry-detail-${r.purpose}`}>
                      <td colSpan={6} className="py-1.5 px-2 space-y-0.5 text-muted-foreground">
                        <div><span className="font-medium text-foreground">Decides:</span> {r.decides}</div>
                        <div><span className="font-medium text-foreground">Consumer:</span> <code className="font-mono">{r.consumerSite}</code></div>
                        <div><span className="font-medium text-foreground">Question:</span> <code className="font-mono">{r.question}</code> — {r.questionShape}, τ {r.defaultThreshold}</div>
                        <div><span className="font-medium text-foreground">Harness label:</span> {r.harnessLabel}</div>
                        <div><span className="font-medium text-foreground">Act bars:</span> labels ≥ {r.bars.minLabels} over ≥ {r.bars.minDays} d, act band n ≥ {r.bars.minActBandN} at precision ≥ {r.bars.minActBandPrecision}, AUROC ≥ {r.bars.minAuroc}, coverage@5% ≥ {r.bars.minCoverageAt5}{r.bars.controlGated ? ', control-gated (act-period floor turns)' : ''}</div>
                        <div><span className="font-medium text-foreground">Why tier {r.tier}:</span> {r.tierWhy}</div>
                        <div><span className="font-medium text-foreground">Kill switches:</span> {r.killSwitches.map(k => <code key={k} className="font-mono mr-1">{k}</code>)}</div>
                        {r.ownerLock && <div><span className="font-medium text-foreground">Owner lock:</span> {r.ownerLock}</div>}
                        {r.actCap && <div><span className="font-medium text-foreground">Act cap:</span> since {r.actCap.since} — {r.actCap.why} (lift: <code className="font-mono">{r.actCap.liftEnv}=1</code>{r.actCap.active ? '' : '; lifted on the answering backend'})</div>}
                        {r.retiredOnHumanTurns && <div><span className="font-medium text-foreground">Human turns:</span> not asked since {r.retiredOnHumanTurns.since} — {r.retiredOnHumanTurns.why} ({r.retiredOnHumanTurns.sites}; lift: <code className="font-mono">{r.retiredOnHumanTurns.liftEnv}=1</code>{r.retiredOnHumanTurns.active ? '' : '; lifted on the answering backend'})</div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(st.actions.length > 0 || parked.length > 0 || view.rollout.recentDemotes.length > 0) && (
        <div className="rounded-md border p-2 space-y-0.5 text-[11px]" data-testid="decision-rollout-ledger">
          <div className="font-medium">Automaton ledger</div>
          {st.actions.slice(0, 8).map((a, i) => (
            <div key={`${a.at}-${a.purpose}-${i}`} className="text-muted-foreground">{new Date(a.at).toLocaleString()} · <code className="font-mono">{a.purpose}</code> {a.from} → {a.to} ({a.reason}{a.by ? ` by ${a.by}` : ''})</div>
          ))}
          {view.rollout.recentDemotes.slice(0, 5).map((d, i) => (
            <div key={`${d.at}-${d.purpose}-${i}`} className="text-muted-foreground">{new Date(d.at).toLocaleString()} · <code className="font-mono">{d.purpose}</code> auto-demoted ({d.outcome}{d.precision !== null ? `, precision ${d.precision}` : ''}{d.n !== null ? ` over n=${d.n}` : ''})</div>
          ))}
          {parked.length > 0 && <div className="text-muted-foreground">Parked: {parked.join(', ')}</div>}
        </div>
      )}
    </div>
  );
}

/** Roles whose call shape is not chat/completions — they take any registered
 *  endpoint model (no [coding] flag), never a built-in chat id. Mirrors
 *  NON_CHAT_ROLES in backend model-roles.service.ts. */
const NON_CHAT_ROLES = new Set(['embeddings', 'rerank', 'asr', 'tts']);

/** Seats that send images inline — their custom endpoint models must be
 *  flagged [vision] as well as [coding]. Mirrors VISION_ROLES in the backend. */
const VISION_ROLES = new Set(['vision_describe', 'pdf_ocr', 'computer_vision']);

/** Image GENERATION seats (owner ask 2026-09-24): the picker offers the
 *  backend's built-in image ids (builtInOptions) plus registry models flagged
 *  [image] (an OpenAI-shaped /images/generations route) — never [coding] chat
 *  models. Mirrors IMAGE_ROLES in the backend. */
const IMAGE_ROLES = new Set(['image_generate']);

/** The decision-gate seat (WI-S, 2026-09-25) carries a second control under
 *  its row: the per-purpose MODE (off / shadow / act), stored ONCE for the
 *  whole fleet (web A/B + worker C read the same row within 30 s) — a flip is
 *  one save here, no env staging on three boxes, no redeploy. Env
 *  DECISION_GATE_MODE_<PURPOSE> is only the fallback when nothing is stored. */
const DECISION_ROLE_KEY = 'decision';
const DECISION_MODE_OPTIONS: Array<{ value: '' | 'off' | 'shadow' | 'act'; label: string }> = [
  { value: '', label: 'Not set — env / default' },
  { value: 'off', label: 'off — no call' },
  { value: 'shadow', label: 'shadow — call, record, change nothing' },
  { value: 'act', label: 'act — skip / route on a confident answer' },
];

/** The built-in ids a seat accepts come from the backend (`builtInOptions`,
 *  computed by builtInOptionsFor — ONE source of truth for the save-time gate
 *  and this picker). Pre-2026-09-22 backends omit the field → no built-ins
 *  offered rather than a stale client-side list. */
const builtInsFor = (role: ModelRole): string[] => role.builtInOptions ?? [];

/** The Image generator seat's Test result carries the probe's actual picture
 *  (2026-09-24) — shown as a small expandable thumbnail (click → lightbox) so
 *  the admin SEES what the seat draws, not just "connected". */
function ProbeImage({ image, label }: { image: { mediaType: string; data: string }; label: string }) {
  return (
    <div className="mt-1.5" data-testid="probe-image">
      <ExpandableDataImage
        src={`data:${image.mediaType};base64,${image.data}`}
        alt={label}
        className="max-h-32 max-w-full rounded-md border border-border object-contain"
      />
    </div>
  );
}

/** A toggle chip (the Endpoints dialog's flag-chip idiom) for challenger picks. */
function ToggleChip({ on, label, title, onClick, disabled, testId }: { on: boolean; label: string; title?: string; onClick: () => void; disabled?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={title}
      data-testid={testId}
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors disabled:opacity-50',
        on ? 'border-brand-accent bg-brand-accent/10 text-brand-text' : 'text-muted-foreground hover:border-muted-foreground/50',
      )}
    >
      {label}
    </button>
  );
}

/**
 * Decision backends per purpose (2026-09-26). ONE stored row, fleet-wide:
 * per purpose a PRIMARY (first leg of that purpose's chain; unset = the
 * Decision gate seat's own chain) and CHALLENGERS (asked in parallel with the
 * primary; their answers land ONLY as shadow telemetry rows — they never
 * answer, never act, and — detached since the 2026-09-26 Laya follow-up — add
 * ZERO latency: a slow one keeps running in the background under
 * DECISION_GATE_CHALLENGER_TIMEOUT_MS and records its row when it settles).
 * The readiness job's stored report then carries one entry per (purpose,
 * backend), which the comparison table ranks on the same labels. "Promote to
 * primary" swaps a challenger in and keeps the old primary as a challenger;
 * on an ACT purpose the backend drops the purpose to shadow until the job
 * re-stamps the new backend (≤ 6 h) — the confirm dialog says so first.
 */
function DecisionBackendsPanel({ view, readiness, modes, seatEffective: seatEffectiveProp, onSaved }: {
  view: DecisionBackendsView;
  readiness: DecisionReadinessView | null;
  modes: DecisionModeConfig | null;
  /** The Decision gate seat's effective model — the head of the seat chain a purpose without a primary runs. */
  seatEffective: string;
  onSaved: (next: DecisionBackendsView) => void;
}) {
  // The seat chain's head: the backend's own reading of the seat when the view carries it, else the roles list's.
  const seatEffective = view.seatModel || seatEffectiveProp;
  // Tolerated: a view whose candidates went missing renders an empty strip, never a crash (coerceBackendsView keeps
  // the previous list on a short PUT body; the initial GET is guarded by isDecisionBackendsView in the section).
  const candidates: DecisionBackendCandidate[] = Array.isArray(view.candidates) ? view.candidates : [];
  const [draft, setDraft] = useState<BackendsDraft>(() => draftFromConfig(view.config, view.purposes));
  const [saving, setSaving] = useState(false);
  const [testingSpec, setTestingSpec] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ModelRoleTestResult>>({});
  // A PUT waiting for the admin to accept the act → shadow drop it causes.
  const [confirm, setConfirm] = useState<{ patch: DecisionBackendsPatch; purposes: string[]; what: string } | null>(null);
  const [tableOpen, setTableOpen] = useState(true);

  useEffect(() => { setDraft(draftFromConfig(view.config, view.purposes)); }, [view]);

  // Plain records, not Map: the lucide `Map` icon import above shadows the global in this file.
  const candidateBySpec = useMemo(() => {
    const m: Record<string, DecisionBackendCandidate> = {};
    for (const c of candidates) m[c.spec] = c;
    return m;
  }, [candidates]);
  const labelFor = (spec: string): string => candidateBySpec[spec]?.label ?? spec;
  // Fleet-effective mode per purpose: the modes control's reading wins; the backends view carries the same
  // value per purpose object and fills in when the modes route is absent.
  const modeByPurpose = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of view.purposes ?? []) if (p && typeof p === 'object' && p.purpose && p.mode) m[p.purpose] = p.mode;
    for (const p of modes?.purposes ?? []) m[p.purpose] = p.effective;
    return m;
  }, [modes, view]);
  // The backend's label wins; the client map (lib/decision-backends.ts DECISION_PURPOSE_LABELS) only fills a row an older backend sent bare.
  const purposeLabel = (purpose: string): string => purposeLabelFor(purpose, purposeView(view.purposes, purpose)?.label ?? modes?.purposes.find(p => p.purpose === purpose)?.label);
  // Every purpose the view (object or string entries) or the config knows, in registry order.
  const purposes = useMemo(() => {
    const out = purposeKeys(view.purposes);
    for (const p of Object.keys(view.config?.purposes ?? {})) if (!out.includes(p)) out.push(p);
    return out;
  }, [view]);

  const pendingPatch = dirtyBackendPatch(view.config, draft);
  const dirtyCount = (pendingPatch?.purposes ? Object.keys(pendingPatch.purposes).length : 0) + (pendingPatch?.defaultChallengers ? 1 : 0);

  const send = async (patch: DecisionBackendsPatch, what: string) => {
    setSaving(true);
    try {
      const raw = await decisionBackendsApi.update(patch);
      // The backend answers the PUT with the same view as GET — but a shorter body ({ config } / { ok }) must never
      // unmount the section: re-read the view, and if even that fails keep what we had plus whatever came back.
      let next: unknown = raw;
      if (!isDecisionBackendsView(raw)) next = await decisionBackendsApi.get().catch(() => raw);
      onSaved(coerceBackendsView(view, next));
      toast.success(`${what} — every box picks it up within 30 seconds`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to save decision backends');
    } finally {
      setSaving(false);
    }
  };

  /** Save or promote. A primary change on an ACT purpose asks first — the backend drops that purpose to shadow on the PUT. */
  const submit = (patch: DecisionBackendsPatch | null, what: string) => {
    if (!patch) return;
    const dropping = primaryChangesOnActPurposes(view.config, patch, modeByPurpose);
    if (dropping.length) { setConfirm({ patch, purposes: dropping, what }); return; }
    void send(patch, what);
  };
  const save = () => submit(pendingPatch, 'Decision backends saved');
  const promote = (purpose: string, spec: string) => submit(promotePatch(view.config, purpose, spec, seatEffective), `${labelFor(spec)} is now the primary for ${purpose}`);

  /** Test = the seat's real probe (POST /admin/model-roles/test { role: 'decision', model: spec }): one typed noul + choice with sanity answers. */
  const runTest = async (spec: string) => {
    setTestingSpec(spec);
    setTests(prev => { const { [spec]: _gone, ...rest } = prev; return rest; });
    try {
      const result = await modelRolesApi.test(DECISION_ROLE_KEY, spec);
      setTests(prev => ({ ...prev, [spec]: result }));
      if (result.ok) toast.success(`${labelFor(spec)}: answered (${(result.latencyMs / 1000).toFixed(1)}s)`);
      else toast.error(`${labelFor(spec)}: ${result.error || 'probe failed'}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Test failed');
    } finally {
      setTestingSpec(null);
    }
  };

  const setPrimary = (purpose: string, spec: string) =>
    setDraft(d => ({ ...d, purposes: { ...d.purposes, [purpose]: { ...(d.purposes[purpose] ?? { primary: '', challengers: null }), primary: spec } } }));
  // A purpose's own challenger list is TRI-STATE (the backend contract): null = none of its own → the default
  // challengers apply; [] = explicitly NONE (overrides the defaults); else the list. Removing the last own
  // challenger falls back to the defaults (null); the "none" chip is the explicit [].
  const toggleChallenger = (purpose: string | null, spec: string) =>
    setDraft(d => {
      if (purpose === null) {
        const has = d.defaultChallengers.includes(spec);
        return { ...d, defaultChallengers: has ? d.defaultChallengers.filter(s => s !== spec) : [...d.defaultChallengers, spec] };
      }
      const row = d.purposes[purpose] ?? { primary: '', challengers: null };
      const own = row.challengers ?? [];
      const next = own.includes(spec) ? own.filter(s => s !== spec) : [...own, spec];
      return { ...d, purposes: { ...d.purposes, [purpose]: { ...row, challengers: next.length ? next : null } } };
    });
  const toggleNoChallengers = (purpose: string) =>
    setDraft(d => {
      const row = d.purposes[purpose] ?? { primary: '', challengers: null };
      const isNone = row.challengers !== null && row.challengers.length === 0;
      return { ...d, purposes: { ...d.purposes, [purpose]: { ...row, challengers: isNone ? null : [] } } };
    });

  // Comparison rows: the report's entries with numbers, grouped by purpose, most-labelled first.
  const entriesByPurpose = useMemo(() => {
    const groups: Record<string, DecisionReadinessEntry[]> = {};
    for (const e of readiness?.report?.entries ?? []) {
      const m = readinessEntryMetrics(e);
      if (!m || m.n <= 0) continue;
      (groups[e.purpose] = groups[e.purpose] ?? []).push(e);
    }
    for (const list of Object.values(groups)) list.sort((a, b) => (readinessEntryMetrics(b)?.n ?? 0) - (readinessEntryMetrics(a)?.n ?? 0));
    return groups;
  }, [readiness]);
  const tablePurposes = useMemo(() => {
    const extra = Object.keys(entriesByPurpose).filter(p => !purposes.includes(p)).sort();
    return [...purposes.filter(p => p in entriesByPurpose), ...extra];
  }, [entriesByPurpose, purposes]);

  return (
    <div className="mt-2 rounded-lg border border-dashed p-2.5 space-y-2" data-testid="decision-gate-backends">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium"><Scale className="size-3.5 text-brand-accent" /> Decision backends per purpose (fleet-wide)</span>
        {view.config?.updatedAt && <span className="text-[11px] text-muted-foreground" title={view.config.updatedBy ? `by ${view.config.updatedBy}` : undefined}>saved {new Date(view.config.updatedAt).toLocaleString()}</span>}
        {dirtyCount > 0 && <Badge className="text-[10px] bg-brand-accent">unsaved</Badge>}
        <div className="flex-1" />
        {dirtyCount > 0 && (
          <Button size="sm" variant="outline" onClick={save} disabled={saving} data-testid="save-decision-backends">
            {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
            Save backends
          </Button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The <span className="font-medium text-foreground">primary</span> is the first leg of a purpose&apos;s chain (then the Decision gate seat&apos;s own chain above). <span className="font-medium text-foreground">Challengers</span> are asked in parallel with the primary and only ever add shadow rows — they never answer, never act, cost nothing but their own call, and add no latency (a slow one keeps running in the background and records its row when it settles) — so a self-hosted Laya, JevK5, NeoHorse or openjev — or Laya behind LiteLLM (<code className="font-mono">cql-litellm:agx-laya</code>, the model flagged [typed decisions] on its endpoint) — can be measured against TypeSafe Jev on the same labels before it answers anything. The comparison table below ranks every (purpose, backend) pair the readiness job has seen.
      </p>

      {/* Backends: every candidate with its kind / calibration / servability + a real probe. */}
      <div className="rounded-md border p-2 space-y-1" data-testid="decision-backend-candidates">
        <div className="text-[11px] font-semibold">Backends</div>
        {candidates.length === 0 && <p className="text-[11px] text-muted-foreground">No backend can be called on this instance — add TYPESAFE_API_KEY / DEEPSEEK_API_KEY, or register a &quot;Decision model (/systemone)&quot; endpoint above.</p>}
        {candidates.map(c => {
          const t = tests[c.spec];
          return (
            <div key={c.spec} className="space-y-0.5" data-testid={`decision-backend-${c.spec}`}>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="font-medium">{c.label}</span>
                <code className="font-mono text-[10px] text-muted-foreground">{c.spec}</code>
                <Badge variant="outline" className="text-[10px]" title={c.kind === 'systemone' ? 'A TypeSafe-compatible POST /systemone decision server — typed answers with probabilities in one prefill.' : c.kind === 'systemone_chat' ? 'A typed-decision model reached through POST /chat/completions with a questions map (LiteLLM fronting Laya — the [typed decisions] flag on its endpoint model, or a typed-decision proxy endpoint). Same answer shape and calibration rule as a systemone server.' : 'A logprob readout: one prefill, max_tokens 1, top_logprobs over the option letters, softmax ÷ the fitted temperature.'}>
                  {c.kind === 'systemone' ? 'systemone' : c.kind === 'systemone_chat' ? 'typed decisions via chat' : 'logprob readout'}
                </Badge>
                {c.calibrated
                  ? <Badge variant="secondary" className="text-[10px]" title="Calibrated: a systemone server the admin flagged [calibrated] (or TypeSafe Jev), or a readout with a fitted temperature — an act purpose may act on its answers.">calibrated</Badge>
                  : <Badge variant="outline" className="text-[10px] text-muted-foreground" title="Uncalibrated: an act purpose this backend answers is downgraded to shadow until the readiness job fits a temperature for it (or the admin flags the endpoint model [calibrated]).">uncalibrated</Badge>}
                {!c.servable && <Badge variant="destructive" className="text-[10px]" title={c.unservableReason || 'This backend cannot be called on this instance.'}>unservable</Badge>}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => runTest(c.spec)}
                  disabled={testingSpec !== null || saving}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  title="Live probe through the Decision gate's real call shape (one typed noul + choice with sanity answers) — checks the answer parses, not calibration"
                  data-testid={`test-decision-backend-${c.spec}`}
                >
                  {testingSpec === c.spec ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                  Test
                </button>
              </div>
              {t && (
                <p className={cn('flex items-center gap-1 text-[11px]', t.ok ? 'text-success' : 'text-destructive')}>
                  {t.ok ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
                  {t.ok ? `${t.target}: ${t.detail || 'answered'} (${(t.latencyMs / 1000).toFixed(1)}s)` : `${t.target}: ${t.error || 'probe failed'}`}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Default challengers: every purpose without a list of its own runs these. */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="decision-default-challengers">
        <span className="inline-flex items-center gap-1 font-medium"><FlaskConical className="size-3 text-brand-accent" /> Default challengers</span>
        <span className="text-muted-foreground">(purposes with no challengers of their own)</span>
        {candidates.map(c => (
          <ToggleChip
            key={c.spec}
            on={draft.defaultChallengers.includes(c.spec)}
            label={c.label}
            title={`${c.spec}${c.servable ? '' : ` — ${c.unservableReason || 'unservable'}`}`}
            onClick={() => toggleChallenger(null, c.spec)}
            disabled={saving}
            testId={`default-challenger-${c.spec}`}
          />
        ))}
      </div>

      {/* Per purpose: primary select + own challenger chips. */}
      <div className="space-y-1">
        {purposes.map(p => {
          const row = draft.purposes[p] ?? { primary: '', challengers: null };
          const dirty = !!pendingPatch?.purposes?.[p];
          const mode = modeByPurpose[p];
          // null = no list of its own → the default challengers apply; [] = explicitly none.
          const own = row.challengers;
          const explicitNone = own !== null && own.length === 0;
          const inherited = own === null ? effectiveChallengers({ purposes: {}, defaultChallengers: draft.defaultChallengers }, p) : [];
          return (
            <div key={p} className={cn('flex flex-wrap items-center gap-2 text-xs rounded-md px-1 py-0.5', dirty && 'bg-brand-accent/5')} data-testid={`decision-backend-purpose-${p}`}>
              <span className="font-medium min-w-[180px]">{purposeLabel(p)}</span>
              <code className="font-mono text-[10px] text-muted-foreground">{p}</code>
              {mode && (
                <Badge variant={mode === 'act' ? 'default' : 'outline'} className={cn('text-[10px]', mode === 'act' ? 'bg-success text-success-foreground' : 'text-muted-foreground')} title={mode === 'act' ? 'Runs in act — a primary change drops it to shadow until the readiness job re-stamps the new backend (≤ 6 h).' : `Effective mode: ${mode}`}>
                  {mode}
                </Badge>
              )}
              <div className="flex-1" />
              <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                primary
                <select
                  value={row.primary}
                  onChange={e => setPrimary(p, e.target.value)}
                  className={cn('h-7 max-w-[240px] rounded-md border bg-background px-2 text-xs font-mono', dirty && 'border-brand-accent/50')}
                  aria-label={`${purposeLabel(p)} primary decision backend`}
                  disabled={saving}
                >
                  <option value="">Seat chain — {seatEffective || 'built-in'} first</option>
                  {candidates.map(c => (
                    <option key={c.spec} value={c.spec} disabled={!c.servable && c.spec !== row.primary}>
                      {c.label}{c.calibrated ? '' : ' (uncalibrated)'}{c.servable ? '' : ' (unservable)'}
                    </option>
                  ))}
                </select>
              </label>
              <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                challengers
                {candidates.map(c => (
                  <ToggleChip
                    key={c.spec}
                    on={own?.includes(c.spec) ?? false}
                    label={c.label}
                    title={`${c.spec}${c.servable ? '' : ` — ${c.unservableReason || 'unservable'}`}`}
                    onClick={() => toggleChallenger(p, c.spec)}
                    disabled={saving}
                    testId={`challenger-${p}-${c.spec}`}
                  />
                ))}
                <ToggleChip
                  on={explicitNone}
                  label="none"
                  title={explicitNone
                    ? 'Explicitly NO challengers for this purpose (overrides the default challengers) — click to inherit the defaults again'
                    : 'Run NO challengers for this purpose even while default challengers are set (a request-path purpose with a tight budget). Stored as an explicit empty list.'}
                  onClick={() => toggleNoChallengers(p)}
                  disabled={saving}
                  testId={`challenger-${p}-none`}
                />
                {own === null && (inherited.length > 0
                  ? <span className="text-[10px]" title="No challengers of its own — the default challengers apply.">(default: {inherited.map(labelFor).join(', ')})</span>
                  : <span className="text-[10px]" title="No challengers of its own and no default challengers set.">(default: none)</span>)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Comparison: purpose × backend from the readiness job's stored report. */}
      <div className="rounded-md border p-2 space-y-1" data-testid="decision-backend-comparison">
        <button type="button" onClick={() => setTableOpen(o => !o)} className="flex w-full items-center gap-1.5 text-left" aria-expanded={tableOpen}>
          {tableOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          <span className="text-[11px] font-semibold">Comparison — purpose × backend</span>
          <span className="text-[11px] text-muted-foreground">
            {readiness?.report?.computedAt ? `from the report computed ${new Date(readiness.report.computedAt).toLocaleString()}` : 'no report yet'}
          </span>
        </button>
        {tableOpen && (tablePurposes.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No labelled (purpose, backend) pair in the last report. Set challengers above, let the gate run, and the worker&apos;s readiness job ({readiness?.job?.id ?? 'decision-gate-readiness'}, every {readiness?.job?.intervalMin ?? 360} min) fills this table — one row per backend per purpose, on the same outcome labels.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" data-testid="decision-backend-table">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-2 py-0.5 font-medium">Backend</th>
                  <th className="pr-2 py-0.5 font-medium">Role</th>
                  <th className="pr-2 py-0.5 font-medium text-right" title="Labelled outcomes on the newest question partition">n</th>
                  <th className="pr-2 py-0.5 font-medium text-right" title="Agreement with the outcome label at the purpose's act cutoff">agree</th>
                  <th className="pr-2 py-0.5 font-medium text-right" title="Precision inside the act band at the purpose's real cutoff (correct / in-band)">act band</th>
                  <th className="pr-2 py-0.5 font-medium text-right">Brier</th>
                  <th className="pr-2 py-0.5 font-medium text-right">ECE</th>
                  <th className="pr-2 py-0.5 font-medium text-right">AUROC</th>
                  <th className="pr-2 py-0.5 font-medium text-right" title="Latency of this backend's decision calls in the window">p50 / p95</th>
                  <th className="pr-2 py-0.5 font-medium text-right" title="Share of this backend's calls that errored or timed out (challenger timeouts count)">fail</th>
                  <th className="py-0.5" />
                </tr>
              </thead>
              <tbody>
                {tablePurposes.map(p => (
                  <Fragment key={p}>
                    <tr className="border-t">
                      <th colSpan={11} className="pt-1.5 pb-0.5 text-left">
                        <span className="font-medium">{purposeLabel(p)}</span>
                        <code className="ml-1.5 font-mono text-[10px] text-muted-foreground">{p}</code>
                        {modeByPurpose[p] && <span className="ml-1.5 text-[10px] text-muted-foreground">· now: {modeByPurpose[p]}</span>}
                      </th>
                    </tr>
                    {(entriesByPurpose[p] ?? []).map(e => {
                      const m = readinessEntryMetrics(e)!;
                      const role = backendRoleFor(e, view.config, seatEffective);
                      const key = entryBackendKey(e);
                      const spec = e.backendSpec;
                      const candidate = spec ? candidateBySpec[spec] : undefined;
                      const calibrated = e.calibrated ?? candidate?.calibrated;
                      return (
                        <tr key={`${p}|${key}${e.segment ? `|${e.segment}` : ''}`} data-testid={`decision-backend-row-${p}-${key}`} data-segment={e.segment ?? 'human'}>
                          <td className="pr-2 py-0.5">
                            <span className="font-medium">{spec ? labelFor(spec) : e.backend}</span>
                            {spec && <code className="ml-1 font-mono text-[10px] text-muted-foreground">{spec}</code>}
                          </td>
                          <td className="pr-2 py-0.5">
                            <span className="inline-flex flex-wrap gap-1">
                              {role === 'primary' && <Badge className="text-[10px] bg-brand-accent">primary</Badge>}
                              {role === 'challenger' && <Badge variant="secondary" className="text-[10px]">challenger</Badge>}
                              {role === 'fallback' && !e.segment && <Badge variant="outline" className="text-[10px] text-muted-foreground">fallback</Badge>}
                              {e.segment && <Badge variant="outline" className="text-[10px] text-muted-foreground" title="Rows from this sender segment are partitioned out of the human sample — no harness label exists for them yet, so this entry is never the stamp and never READY">{e.segment} segment</Badge>}
                              {e.ready && <Badge variant="default" className="text-[10px] bg-success text-success-foreground" title="Every flip bar holds for this backend on this purpose">READY</Badge>}
                              {calibrated === false && <Badge variant="outline" className="text-[10px] text-muted-foreground" title="Its probabilities are not calibrated yet — an act purpose it answers is downgraded to shadow">uncalibrated</Badge>}
                            </span>
                          </td>
                          <td className="pr-2 py-0.5 text-right font-mono">{m.n}</td>
                          <td className="pr-2 py-0.5 text-right font-mono">{fmtPercent(m.accuracy, 1)}</td>
                          <td className="pr-2 py-0.5 text-right font-mono" title={`τ=${m.actBand.threshold}`}>{m.actBand.n > 0 ? `${m.actBand.correct}/${m.actBand.n} (${fmtMetric(m.actBand.precision, 3)})` : 'n/a'}</td>
                          <td className="pr-2 py-0.5 text-right font-mono">{fmtMetric(m.brier)}</td>
                          <td className="pr-2 py-0.5 text-right font-mono">{fmtMetric(m.ece)}</td>
                          <td className="pr-2 py-0.5 text-right font-mono">{fmtMetric(m.auroc)}</td>
                          <td className="pr-2 py-0.5 text-right font-mono whitespace-nowrap">{m.p50Ms === undefined && m.p95Ms === undefined ? 'n/a' : `${fmtMs(m.p50Ms)} / ${fmtMs(m.p95Ms)}`}</td>
                          <td className="pr-2 py-0.5 text-right font-mono">{fmtPercent(m.failRate, 1)}</td>
                          <td className="py-0.5 text-right">
                            {spec && role !== 'primary' && (
                              <button
                                type="button"
                                onClick={() => promote(p, spec)}
                                disabled={saving || (candidate ? !candidate.servable : false)}
                                className="inline-flex items-center gap-1 text-[11px] text-brand-accent hover:underline disabled:opacity-50 disabled:no-underline whitespace-nowrap"
                                title={candidate && !candidate.servable ? (candidate.unservableReason || 'unservable') : `Make ${labelFor(spec)} the primary for ${p}; the current primary becomes a challenger`}
                                data-testid={`promote-${p}-${spec}`}
                              >
                                <ArrowUpToLine className="size-3" /> Promote to primary
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Stored once for the whole fleet (every box within 30 seconds, no redeploy). A purpose with no primary runs the Decision gate seat&apos;s chain (seat model → its custom fallback → built-in jev → built-in deepseek-flash readout). Challengers run only on the seat-chain path — never on memo hits, probes or a caller that pins a backend — at most <code className="font-mono">DECISION_GATE_CHALLENGER_MAX</code> (default 2) per call, DETACHED — the primary answers as soon as its chain settles and a still-running challenger continues in the background under its own <code className="font-mono">DECISION_GATE_CHALLENGER_TIMEOUT_MS</code> (default 5000; <code className="font-mono">DECISION_GATE_CHALLENGER_GRACE_MS</code> is an optional wait, default 0); their rows carry <code className="font-mono">challenger:true</code> and never feed auto-demote. Promoting a backend for an act purpose: {PROMOTE_CONFIRM_COPY}.
      </p>

      <AlertDialog open={!!confirm} onOpenChange={open => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change the primary backend for {confirm?.purposes.join(', ')}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.purposes.length === 1 ? 'This purpose runs' : 'These purposes run'} in <strong>act</strong>: {PROMOTE_CONFIRM_COPY}. Until then the gated site runs its pre-gate path. Nothing else changes — thresholds fitted on the old backend are never carried over.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const c = confirm; setConfirm(null); if (c) void send(c.patch, c.what); }} disabled={saving} data-testid="confirm-decision-backend-change">
              Change primary (drops to shadow)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


export function ModelRolesSection() {
  const [roles, setRoles] = useState<ModelRole[]>([]);
  const [providerKeys, setProviderKeys] = useState<ProviderKeyStatus[]>([]);
  const [builtIns, setBuiltIns] = useState<BuiltInModelInfo[]>([]);
  const [chains, setChains] = useState<FixedChain[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  // Custom fallback per seat (owner 2026-09-15) — '' = Digby's built-in behaviour.
  const [fallbackDraft, setFallbackDraft] = useState<Record<string, string>>({});
  // Seats whose "Add custom fallback" picker is open (a saved fallback opens it).
  const [fallbackOpen, setFallbackOpen] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [testingRole, setTestingRole] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ModelRoleTestResult>>({});
  // Decision-gate modes (WI-S): null = the backend predates the endpoint / failed to load — the control hides.
  const [decisionModes, setDecisionModes] = useState<DecisionModeConfig | null>(null);
  const [decisionDraft, setDecisionDraft] = useState<Record<string, string>>({});
  const [savingModes, setSavingModes] = useState(false);
  // Flip-readiness stamp (E1, 2026-09-25): null = the backend predates the route / never stamped — the readout says so.
  const [decisionReadiness, setDecisionReadiness] = useState<DecisionReadinessView | null>(null);
  // Per-purpose decision backends (2026-09-26): null = the backend predates the route / failed to load — the panel hides.
  const [decisionBackends, setDecisionBackends] = useState<DecisionBackendsView | null>(null);
  // Decision-role registry + the rollout automaton (rollout self-governance, 2026-09-27): null = the backend predates the route — the panel hides.
  const [decisionRegistry, setDecisionRegistry] = useState<DecisionRegistryView | null>(null);

  const resetDecisionDraft = (cfg: DecisionModeConfig | null) => {
    const d: Record<string, string> = {};
    for (const p of cfg?.purposes ?? []) d[p.purpose] = p.storeMode ?? '';
    setDecisionDraft(d);
  };

  const resetDraft = (rs: ModelRole[]) => {
    const d: Record<string, string> = {};
    const f: Record<string, string> = {};
    const open: Record<string, boolean> = {};
    for (const r of rs) {
      d[r.key] = r.override ?? '';
      f[r.key] = r.fallback ?? '';
      if (r.fallback) open[r.key] = true;
    }
    setDraft(d);
    setFallbackDraft(f);
    setFallbackOpen(prev => ({ ...prev, ...open }));
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [rolesResp, eps, modes, readiness, backends, registry] = await Promise.all([
        modelRolesApi.list(),
        modelEndpointsApi.list(),
        // Tolerated: a pre-WI-S backend has no decision-modes route — the seats still load.
        decisionGateApi.listModes().catch(() => null),
        // Tolerated the same way: a pre-E1 backend has no readiness route.
        decisionGateApi.readiness().catch(() => null),
        // Tolerated the same way: a pre-2026-09-26 backend has no decision-backends route — the panel hides. A
        // body that is not the full view hides it too (isDecisionBackendsView) instead of crashing the section.
        decisionBackendsApi.get().then(v => (isDecisionBackendsView(v) ? v : null)).catch(() => null),
        // Tolerated the same way: a pre-2026-09-27 backend has no decision-registry route — the registry panel hides.
        decisionGateApi.registry().catch(() => null),
      ]);
      setDecisionReadiness(readiness);
      setDecisionBackends(backends);
      setDecisionRegistry(registry);
      setRoles(rolesResp.roles);
      setProviderKeys(rolesResp.providerKeys);
      setBuiltIns(rolesResp.builtIns);
      setChains(rolesResp.chains);
      setEndpoints(eps);
      resetDraft(rolesResp.roles);
      setDecisionModes(modes);
      resetDecisionDraft(modes);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Registry options: agent seats take every CHAT-capable model (2026-09-27 —
  // "coding is a seat choice, not a model capability": kind 'chat', the legacy
  // [coding] flag, a detection, or an id that does not look like an
  // embeddings / rerank / asr / tts / image / decision model — the run path
  // applies the same rule); embeddings/rerank/decision take ANY registered model.
  const registryOptions = useMemo(() => {
    const all: Array<{ spec: string; name: string; chatCapable: boolean; image: boolean }> = [];
    for (const ep of endpoints.filter(e => e.enabled)) {
      for (const m of ep.models) {
        all.push({ spec: `${ep.label}:${m.id}`, name: `${ep.label} · ${m.displayName || m.id}`, chatCapable: isChatCapableModel(m), image: m.image === true });
      }
    }
    return all;
  }, [endpoints]);

  const dirtyKeys = roles.filter(r => (draft[r.key] ?? '') !== (r.override ?? '')).map(r => r.key);
  const dirtyFallbackKeys = roles.filter(r => r.fallbackable && (fallbackDraft[r.key] ?? '') !== (r.fallback ?? '')).map(r => r.key);
  const dirtyCount = dirtyKeys.length + dirtyFallbackKeys.length;

  const save = async () => {
    if (!dirtyCount) return;
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      for (const k of dirtyKeys) patch[k] = draft[k] ?? '';
      const fallbacks: Record<string, string> = {};
      for (const k of dirtyFallbackKeys) fallbacks[k] = fallbackDraft[k] ?? '';
      const { roles: rs, warnings } = await modelRolesApi.updateWithWarnings(patch, fallbacks);
      setRoles(rs);
      resetDraft(rs);
      // 09a03aef: save-time advisories (a slow [image] seat model that will
      // time out at chat sizes) surface as their own warning toast — the save
      // SUCCEEDED, but the admin must see WHY the seat would silently serve a
      // fallback model. One toast per warning (a multi-seat save can produce
      // several), each long-lived like ModelEndpointsSection's clamped-fields
      // advisory.
      toast.success('Model roles saved');
      for (const w of warnings) toast.warning(w, { duration: 10000 });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to save model roles');
    } finally {
      setSaving(false);
    }
  };

  const dirtyDecisionKeys = (decisionModes?.purposes ?? []).filter(p => (decisionDraft[p.purpose] ?? '') !== (p.storeMode ?? '')).map(p => p.purpose);

  const saveDecisionModes = async () => {
    if (!dirtyDecisionKeys.length) return;
    setSavingModes(true);
    try {
      const patch: Record<string, string> = {};
      for (const k of dirtyDecisionKeys) patch[k] = decisionDraft[k] ?? '';
      const cfg = await decisionGateApi.updateModes(patch);
      setDecisionModes(cfg);
      resetDecisionDraft(cfg);
      toast.success('Decision-gate modes saved — every box picks them up within 30 seconds');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to save decision-gate modes');
    } finally {
      setSavingModes(false);
    }
  };

  const runTest = async (role: ModelRole, slot: 'seat' | 'fallback' = 'seat') => {
    const resultKey = slot === 'fallback' ? `${role.key}:fallback` : role.key;
    setTestingRole(resultKey);
    setTestResults(prev => { const { [resultKey]: _gone, ...rest } = prev; return rest; });
    try {
      // Tests the CURRENT selection (saved or not) — '' exercises the built-in
      // default; the fallback slot tests its own candidate.
      // Ticket 61d33af9 (2026-10-10): the image seat rides the STREAMING test —
      // its probe can run 180 s (a real self-hosted image backend takes ~118 s
      // at the OpenAI Images default shape), which outlives every sync JSON
      // timeout on the path (client 45 s default, ALB 60 s idle); the stream
      // keepalives past all of them and delivers the same result object.
      const call = slot === 'fallback'
        ? { role: role.key, model: fallbackDraft[role.key] ?? '', opts: { fallback: true } as const }
        : { role: role.key, model: draft[role.key] ?? '', opts: undefined as undefined | { fallback: true } };
      const result = IMAGE_ROLES.has(role.key)
        ? await modelRolesApi.testStream(call.role, call.model, call.opts)
        : await modelRolesApi.test(call.role, call.model, call.opts);
      setTestResults(prev => ({ ...prev, [resultKey]: result }));
      const who = slot === 'fallback' ? `${role.persona} fallback` : role.persona;
      if (result.ok) toast.success(`${who}: connected (${(result.latencyMs / 1000).toFixed(1)}s)`);
      else toast.error(`${who}: ${result.error || 'connection failed'}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Test failed');
    } finally {
      setTestingRole(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>;
  }
  if (loadError) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
        Failed to load model roles. <button className="underline" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <UsersRound className="size-4 text-brand-accent" /> Model roles
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Which model serves each seat of the Digby experience — Digby (the lead), the Double Checker (Level 2 second opinion and Level 3 council, one model), the Triple Checker (Level 3 council), the helper tier, background utility, the capability seats (image reader, PDF OCR, browser agent, computer use, Digby Kids), RAG embeddings/rerank, and speech-to-text plus text-to-speech. The Image generator seat draws the pictures generate_image makes (DashScope Qwen-Image / Wan / Z-Image, Z.AI GLM-Image / CogView, or your own [image] endpoint model). Every model Digby calls anywhere is one of these seats — there are no fixed vendor models left in the code. Assign registered endpoint models to run everything on your own servers. These are the exact names the chat shows while it works and in an answer&apos;s More info panel.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            <span className="font-medium text-foreground">Instance-wide:</span> these seats are the production defaults for <em>every</em> user and chat on this instance (stored once, not per account). A change applies to new runs within ~30 seconds — no redeploy. Seats govern EXISTING coding sessions too: a session&apos;s stored model is a record, and the Workspace default is resolved live at every run — it yields only to an explicit session pick, a human-set project pick, or a personal pick the user made themselves in Account → Coding (flagged on the row when it affects you).
          </p>
        </div>
        {dirtyCount > 0 && (
          <Button size="sm" onClick={save} disabled={saving} className="shrink-0">
            {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
            Save {dirtyCount} change{dirtyCount === 1 ? '' : 's'}
          </Button>
        )}
      </div>

      <SeatApplyPanel onApplied={() => { void load(); }} />

      {/* Dynamic roster phase 1 (2026-10-03): per-lane Auto pools — self-loading, hides on an older backend. */}
      <AutoPoolsPanel />

      {/* F2 (2026-10-06): the reflection council — the one place frontier models run. Self-loading, hides on an older backend. */}
      <ReflectionCouncilPanel />

      {/* Ghost mode (2026-10-22): the admin-designated self-hosted endpoint
          per-chat ghost mode routes through. Self-loading, hides on an older
          backend (404 / partial body). */}
      <GhostModePanel />

      {providerKeys.length > 0 && (
        <div className="rounded-xl border p-3 space-y-2">
          <div className="flex items-center gap-1.5">
            <KeyRound className="size-3.5 text-brand-accent" />
            <span className="text-xs font-semibold">Provider API keys on this instance</span>
          </div>
          <div className="space-y-1">
            {providerKeys.map(pk => (
              <div key={pk.envKey} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <code className="font-mono text-[11px]">{pk.envKey}</code>
                {pk.present ? (
                  <span className="inline-flex items-center gap-0.5 text-success"><Check className="size-3" /> set</span>
                ) : (
                  <span className="inline-flex items-center gap-0.5 text-destructive"><X className="size-3" /> missing</span>
                )}
                <span className="text-muted-foreground">{pk.provider} — {pk.serves.join(', ')}</span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            These are the cloud providers behind the built-in seat defaults. Add a missing key to the backend <code className="font-mono">.env</code> and restart — or skip the key entirely by assigning your own endpoint models to the seats below. Key values never leave the server; only set/missing is shown.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {roles.map(role => {
          const value = draft[role.key] ?? '';
          const nonChat = NON_CHAT_ROLES.has(role.key);
          // The Decision gate seat takes ANY registered endpoint model — a
          // "Decision model (/systemone)" server or a logprobs-capable chat
          // server; the [coding] flag is meaningless there (mirrors the
          // backend's assertAssignable 'decision' branch; fixed 2026-09-26 —
          // the picker used to hide every non-[coding] registry model).
          const decisionSeat = role.key === DECISION_ROLE_KEY;
          const options = nonChat || decisionSeat ? registryOptions : registryOptions.filter(o => o.chatCapable);
          const builtIns = builtInsFor(role);
          const needsVision = VISION_ROLES.has(role.key);
          // The Utility seat's custom fallback takes ONLY custom endpoint specs —
          // the backend (assertAssignable asFallback) refuses built-in ids for
          // it: they are already legs of the built-in chain (DeepSeek primary /
          // DashScope safety net), so offering them would be redundant-to-harmful.
          const fallbackBuiltIns = role.key === 'utility' ? [] : builtIns;
          // Image generator seat (2026-09-24): registry options are the models
          // flagged [image] (an /images/generations route), never the [coding]
          // chat models; the built-in image ids come from builtInOptions.
          const imageSeat = IMAGE_ROLES.has(role.key);
          const seatOptions = imageSeat ? registryOptions.filter(o => o.image) : options;
          const test = testResults[role.key];
          const fallbackTest = testResults[`${role.key}:fallback`];
          const dirty = value !== (role.override ?? '');
          const fallbackValue = fallbackDraft[role.key] ?? '';
          const fallbackDirty = role.fallbackable && fallbackValue !== (role.fallback ?? '');
          const showFallback = role.fallbackable && (fallbackOpen[role.key] || !!role.fallback || !!fallbackValue);
          return (
            <div key={role.key} className={cn('rounded-xl border p-3', (dirty || fallbackDirty) && 'border-brand-accent/50')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{role.persona}</span>
                {role.override && <Badge variant="secondary" className="text-[10px]">custom</Badge>}
                {role.override && role.resolves === false && (
                  <Badge variant="destructive" className="text-[10px]" title="The assigned endpoint model no longer resolves (endpoint deleted/disabled/renamed) — this seat is silently running its default until fixed.">
                    not resolving
                  </Badge>
                )}
                {role.servable === false && !dirty && (
                  <Badge variant="destructive" className="text-[10px] font-mono" title={role.unservableReason || 'This seat\'s model cannot be served on this instance — assign an endpoint model or set the provider API key.'}>
                    {role.missingEnvKey ? `add ${role.missingEnvKey}` : 'no API key on this instance'}
                  </Badge>
                )}
                {role.latched && (
                  // 2026-09-27: the seat's model was rejected DETERMINISTICALLY (tools over
                  // the model's cap, reasoning_effort refused with tools, tools unsupported,
                  // unknown parameter, model not found, context too long) and is latched off —
                  // the runs use the fallback until `until`. Harness fact from loop_metrics.
                  <Badge
                    variant="outline"
                    data-testid="seat-latched"
                    className="text-[10px] border-warn/60 bg-warn/10 text-warn-ink max-w-full whitespace-normal break-words"
                    title={`${role.latched.fingerprint ? `${role.latched.fingerprint} — ` : ''}${role.latched.reason}. Retried after ${role.latched.until.slice(0, 16).replace('T', ' ')}Z. Fix the model entry in Endpoints (max tools / effort / kind) or re-seat.`}
                  >
                    seat unusable: {role.latched.reason} — running on {role.latched.to || 'the built-in fallback'} since {role.latched.since.slice(0, 16).replace('T', ' ')}Z (retried after {role.latched.until.slice(11, 16)}Z)
                  </Badge>
                )}
                {role.providerClass === 'frontier' && (
                  <Badge variant="destructive" className="text-[10px]" title={role.frontierSeatsAllowed !== false
                    ? 'This seat runs a frontier-class model (a frontier vendor host, or a proxy model id naming a closed frontier family). Digby\'s own lineup is open-model only (2026-09-22); this seat is your setting and it saves, serves and tests normally — the badge and a seat_governance telemetry row are the only effect. FRONTIER_SEATS_REFUSE=1 would make the next save of such a model refuse.'
                    : 'This seat runs a frontier-class model (a frontier vendor host, or a proxy model id naming a closed frontier family). FRONTIER_SEATS_REFUSE=1 is set on this instance: the seat keeps serving and testing, but re-saving this model is refused — assign an open-weight model, or unset the switch.'}>
                    frontier
                  </Badge>
                )}
                {role.fallbackProviderClass === 'frontier' && (
                  <Badge variant="destructive" className="text-[10px]" title={role.frontierSeatsAllowed !== false
                    ? 'The custom fallback is a frontier-class model. It saves and serves normally (observe-only governance; a seat_governance telemetry row records it); FRONTIER_SEATS_REFUSE=1 would make re-saving it refuse.'
                    : 'The custom fallback is a frontier-class model and FRONTIER_SEATS_REFUSE=1 is set on this instance — re-saving it on a chat / supervisor seat is refused (an owner-confirmed set_model_role_fallback card still passes).'}>
                    frontier fallback
                  </Badge>
                )}
                {role.fallback && (
                  <Badge variant="secondary" className="text-[10px]" title={`Custom fallback: ${role.fallback}`}>
                    <LifeBuoy className="size-2.5 mr-0.5" /> fallback set
                  </Badge>
                )}
                {role.fallback && role.fallbackResolves === false && (
                  <Badge variant="destructive" className="text-[10px]" title="The custom fallback model no longer resolves (endpoint deleted/disabled/renamed) — Digby's built-in fallback behaviour applies until fixed.">
                    fallback not resolving
                  </Badge>
                )}
                {(dirty || fallbackDirty) && <Badge className="text-[10px] bg-brand-accent">unsaved</Badge>}
                <div className="flex-1" />
                <select
                  value={value}
                  onChange={e => setDraft(d => ({ ...d, [role.key]: e.target.value }))}
                  className="h-8 max-w-[260px] rounded-md border bg-background px-2 text-xs font-mono"
                  aria-label={`${role.persona} model`}
                >
                  <option value="">Default — {role.defaultModel || (role.followsSession ? "each lane's own coding model" : 'built-in chain')}</option>
                  {builtIns.length > 0 && (
                    <optgroup label="Built-in models">
                      {builtIns.map(id => <option key={id} value={id}>{id}</option>)}
                    </optgroup>
                  )}
                  {seatOptions.length > 0 && (
                    <optgroup label="Custom endpoints">
                      {seatOptions.map(o => <option key={o.spec} value={o.spec}>{o.name}</option>)}
                    </optgroup>
                  )}
                </select>
                <button
                  onClick={() => runTest(role)}
                  disabled={testingRole !== null}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  title="Live connection test with this role's real call shape"
                >
                  {testingRole === role.key ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                  Test
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{role.description}</p>
              {/* Custom fallback (owner 2026-09-15): "add custom fallback" so the
                  admin can override the normal Digby fallbacks with a model of
                  their own when the preferred model fails. */}
              {role.fallbackable && !showFallback && (
                <button
                  type="button"
                  onClick={() => setFallbackOpen(o => ({ ...o, [role.key]: true }))}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-brand-accent hover:underline"
                  data-testid={`add-fallback-${role.key}`}
                >
                  <Plus className="size-3" /> Add custom fallback
                </button>
              )}
              {showFallback && (
                <div className="mt-2 rounded-lg border border-dashed p-2.5 space-y-1.5" data-testid={`fallback-${role.key}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-medium"><LifeBuoy className="size-3.5 text-brand-accent" /> Custom fallback</span>
                    {fallbackDirty && <Badge className="text-[10px] bg-brand-accent">unsaved</Badge>}
                    <div className="flex-1" />
                    <select
                      value={fallbackValue}
                      onChange={e => setFallbackDraft(d => ({ ...d, [role.key]: e.target.value }))}
                      className="h-8 max-w-[260px] rounded-md border bg-background px-2 text-xs font-mono"
                      aria-label={`${role.persona} custom fallback model`}
                    >
                      <option value="">None — Digby&apos;s built-in fallback</option>
                      {fallbackBuiltIns.length > 0 && (
                        <optgroup label="Built-in models">
                          {fallbackBuiltIns.map(id => <option key={id} value={id}>{id}</option>)}
                        </optgroup>
                      )}
                      {seatOptions.length > 0 && (
                        <optgroup label="Custom endpoints">
                          {seatOptions.map(o => <option key={o.spec} value={o.spec}>{o.name}</option>)}
                        </optgroup>
                      )}
                    </select>
                    <button
                      onClick={() => runTest(role, 'fallback')}
                      disabled={testingRole !== null || !fallbackValue}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      title="Live connection test of the fallback model with this seat's real call shape"
                    >
                      {testingRole === `${role.key}:fallback` ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                      Test
                    </button>
                    {!role.fallback && (
                      <button
                        type="button"
                        onClick={() => { setFallbackOpen(o => ({ ...o, [role.key]: false })); setFallbackDraft(d => ({ ...d, [role.key]: '' })); }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                        aria-label={`Cancel custom fallback for ${role.persona}`}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Serves when this seat&apos;s model fails (provider error, nothing returned, or it rejects the request). Without one: {role.builtInFallback}
                  </p>
                  {fallbackTest && (
                    <p className={cn('flex items-center gap-1 text-xs', fallbackTest.ok ? 'text-success' : 'text-destructive')}>
                      {fallbackTest.ok ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
                      {fallbackTest.ok
                        ? `${fallbackTest.target}: ${fallbackTest.detail || 'connected'} (${(fallbackTest.latencyMs / 1000).toFixed(1)}s)`
                        : `${fallbackTest.target}: ${fallbackTest.error || 'connection failed'}`}
                    </p>
                  )}
                  {fallbackTest?.ok && fallbackTest.image && <ProbeImage image={fallbackTest.image} label={`${role.persona} fallback test image`} />}
                </div>
              )}
              {role.key === 'coding_default' && role.viewerPick && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  <Badge variant="secondary" className="text-[10px] mr-1">your pick shadows this</Badge>
                  New sessions you start run <code className="font-mono">{role.viewerPick.resolved}</code>, not this default — your personal coding pick (Account → Coding) wins over the workspace default. Change it there to use the workspace default for your own sessions.
                </p>
              )}
              {nonChat && options.length === 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">Add the embedding / rerank / speech-to-text / text-to-speech model to an endpoint above to make it assignable here.</p>
              )}
              {needsVision && (
                <p className="text-[11px] text-muted-foreground mt-1">This seat sends images inline — a custom endpoint model must be flagged [vision] (and be a chat model — kind: chat) on its endpoint entry.</p>
              )}
              {imageSeat && (
                <p className="text-[11px] text-muted-foreground mt-1">This seat generates pictures — a custom endpoint model must be flagged [image] on its endpoint entry (an OpenAI-shaped /images/generations route); Test draws a small picture and shows it here.</p>
              )}
              {role.key === DECISION_ROLE_KEY && decisionModes && (
                <div className="mt-2 rounded-lg border border-dashed p-2.5 space-y-1.5" data-testid="decision-gate-modes">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-medium"><ToggleLeft className="size-3.5 text-brand-accent" /> Gate mode per purpose (fleet-wide)</span>
                    {decisionModes.gateDisabled && <Badge variant="destructive" className="text-[10px]" title="DECISION_GATE_DISABLED is set on the answering backend — every purpose is off there regardless of these settings.">DECISION_GATE_DISABLED</Badge>}
                    {decisionModes.admissionDisabled && <Badge variant="destructive" className="text-[10px]" title="DECISION_GATE_ADMISSION_DISABLED is set on the answering backend — act is admitted without a flip-readiness stamp.">admission off</Badge>}
                    {dirtyDecisionKeys.length > 0 && <Badge className="text-[10px] bg-brand-accent">unsaved</Badge>}
                    <div className="flex-1" />
                    {dirtyDecisionKeys.length > 0 && (
                      <Button size="sm" variant="outline" onClick={saveDecisionModes} disabled={savingModes} data-testid="save-decision-modes">
                        {savingModes && <Loader2 className="size-3.5 animate-spin mr-1" />}
                        Save modes
                      </Button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {decisionModes.purposes.map(p => {
                      const v = decisionDraft[p.purpose] ?? '';
                      const dirtyMode = v !== (p.storeMode ?? '');
                      // E12: the flip-readiness stamp decides whether "act" can be
                      // saved — the backend refuses (409) an unready purpose, and
                      // the badge says so BEFORE the save.
                      const admitted = p.admission ? p.admission.admitted : true;
                      const readyNow = !!p.readiness?.ready && !p.readiness?.stale;
                      const readinessTitle = p.readiness
                        ? `${p.readiness.ready ? 'READY' : 'NOT READY'}${p.readiness.stale ? ' (stale)' : ''}${p.readiness.at ? ` — stamped ${p.readiness.at}` : ''}${Object.keys(p.readiness.metrics ?? {}).length ? ` — ${Object.entries(p.readiness.metrics).slice(0, 8).map(([k, m]) => `${k}=${typeof m === 'number' ? (Number.isInteger(m) ? m : m.toFixed(3)) : String(m)}`).join(', ')}` : ''}${p.readiness.reasons?.length ? ` — ${p.readiness.reasons.join('; ')}` : ''}`
                        : 'No flip-readiness stamp: the report (npm run decision-gate:fit) has never marked this purpose READY, so "act" will be refused.';
                      return (
                        <div key={p.purpose} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`decision-mode-${p.purpose}`}>
                          <span className="font-medium min-w-[180px]" title={p.description}>{purposeLabelFor(p.purpose, p.label)}</span>
                          <code className="font-mono text-[10px] text-muted-foreground">{p.purpose}</code>
                          {p.admission && (
                            <Badge
                              variant={readyNow ? 'default' : 'outline'}
                              className={cn('text-[10px]', readyNow ? 'bg-success text-success-foreground' : v === 'act' && !admitted ? 'border-destructive/40 text-destructive' : 'text-muted-foreground')}
                              title={p.admission.reason ?? readinessTitle}
                              data-testid={`decision-readiness-${p.purpose}`}
                            >
                              {readyNow ? 'ready' : v === 'act' && !admitted ? 'not ready — act will be refused' : 'not ready'}
                            </Badge>
                          )}
                          <div className="flex-1" />
                          <span className="text-[11px] text-muted-foreground" title={`Effective now: ${p.effective} (from ${p.effectiveSource.replace('_', ' ')}); env alone would give ${p.envMode}`}>
                            now: <code className="font-mono">{p.effective}</code>
                          </span>
                          <select
                            value={v}
                            onChange={e => setDecisionDraft(d => ({ ...d, [p.purpose]: e.target.value }))}
                            className={cn('h-7 max-w-[260px] rounded-md border bg-background px-2 text-xs font-mono', dirtyMode && 'border-brand-accent/50')}
                            aria-label={`${purposeLabelFor(p.purpose, p.label)} decision-gate mode`}
                          >
                            {DECISION_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Stored once for the whole fleet: the web backends and the coding worker all read this row within 30 seconds — no env staging on three boxes, no redeploy. &quot;Not set&quot; leaves the purpose on its environment value (<code className="font-mono">DECISION_GATE_MODE_&lt;PURPOSE&gt;</code>, else <code className="font-mono">DECISION_GATE_DEFAULT_MODE</code>, else shadow). Every purpose fails open: act can only skip work on a confident answer. &quot;act&quot; is admitted only for a purpose the flip-readiness report has stamped <em>ready</em> (≥200 labelled outcomes, act-band precision ≥ 0.9, AUROC ≥ 0.8, coverage ≥ 60%, a calibrated backend) — an unready purpose is refused on save and named — and a purpose whose act-band precision later falls below the bar is demoted to shadow automatically. Kill switches: <code className="font-mono">DECISION_GATE_DISABLED=1</code> (no calls at all), <code className="font-mono">DECISION_GATE_ADMISSION_DISABLED=1</code> (admit act without a stamp).
                  </p>
                  <div className="rounded-md border p-2 space-y-1" data-testid="decision-gate-readiness">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">Flip readiness</span>
                      {decisionReadiness?.stampedAt
                        ? <span className="text-[11px] text-muted-foreground">stamped {new Date(decisionReadiness.stampedAt).toLocaleString()}</span>
                        : <span className="text-[11px] text-muted-foreground">no report stamped yet</span>}
                      {decisionReadiness?.computedAt
                        ? <span className="text-[11px] text-muted-foreground" title={`The worker's ${decisionReadiness.job?.id ?? 'decision-gate-readiness'} job recomputes the report every ${decisionReadiness.job?.intervalMin ?? 360} min over the last ${decisionReadiness.job?.windowDays ?? 14} days; the page shows the stored result, never a live recompute.`}>· job computed {new Date(decisionReadiness.computedAt).toLocaleString()}</span>
                        : decisionReadiness?.job ? <span className="text-[11px] text-muted-foreground">· job has not run yet (every {decisionReadiness.job.intervalMin} min)</span> : null}
                      {decisionReadiness?.job?.disabled && <Badge variant="destructive" className="text-[10px]" title="DECISION_GATE_READINESS_JOB_DISABLED is set — the worker's readiness job computes nothing; the CLI still can.">job disabled</Badge>}
                    </div>
                    {/* DOI-17 (2026-09-28): backend health — the answering backend's 401/403 auth-latch
                        state (per PROCESS; the worker keeps its own map) beside the stamp's per-purpose
                        health counters below. `latches` absent = an older backend. */}
                    <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="decision-backend-latches">
                      <span className="font-medium">Backend health</span>
                      {decisionReadiness?.latches == null ? (
                        <span className="text-muted-foreground">latch state not reported by this backend</span>
                      ) : decisionReadiness.latches.latches.length === 0 ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground" title={`No decision backend is latched on the answering process (read ${new Date(decisionReadiness.latches.at).toLocaleString()}; a 401/403 parks a backend for ${Math.round(decisionReadiness.latches.cooldownMs / 1000)} s with one probe ask per cooldown). The worker process keeps its own latch map — get_fleet_telemetry view 'boxes' carries the fleet-wide tile.`}>no backend latched</Badge>
                      ) : decisionReadiness.latches.latches.map(l => (
                        <Badge
                          key={l.key}
                          variant={l.holding ? 'destructive' : 'secondary'}
                          className="text-[10px]"
                          data-testid={`decision-latch-${l.spec}`}
                          title={`${l.backend} (${l.spec}) answered HTTP ${l.status} at ${new Date(l.at).toLocaleString()}; latched since ${new Date(l.since).toLocaleString()}${l.relatches ? ` (re-latched ${l.relatches}×)` : ''}; ${l.holding ? `re-probe at ${new Date(l.until).toLocaleString()} (${Math.ceil(l.remainingMs / 1000)} s)${l.probing ? ' — probe in flight' : ''}` : 'cooldown elapsed — the next ask probes'}. Act purposes on this backend run their pre-gate path meanwhile.`}
                        >
                          {l.holding ? 'latched' : 'probing'}: {l.backend} · HTTP {l.status}{l.holding ? ` · ${Math.ceil(l.remainingMs / 1000)} s` : ''}
                        </Badge>
                      ))}
                    </div>
                    {decisionReadiness?.purposes && Object.keys(decisionReadiness.purposes).length > 0 ? (
                      <div className="space-y-0.5">
                        {decisionModes.purposes.map(p => {
                          const r = decisionReadiness.purposes?.[p.purpose];
                          const m = r?.metrics;
                          const h = r?.health;
                          const tip = r && m
                            ? `${r.backend} · n=${m.n} over ${m.days.toFixed(1)} d · act band at τ=${m.actBand.threshold}: ${m.actBand.correct}/${m.actBand.n} (precision ${Number.isFinite(m.actBand.precision) ? m.actBand.precision.toFixed(3) : 'n/a'}) · AUROC ${Number.isFinite(m.auroc) ? m.auroc.toFixed(3) : 'n/a'} · coverage@≤5% ${(m.coverageAt5.coverage * 100).toFixed(1)}% · positives ${m.positives}${r.reasons.length ? `\nmissing: ${r.reasons.join('; ')}` : ''}`
                            : 'not in the last report';
                          return (
                            <div key={p.purpose} className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`decision-readiness-${p.purpose}`} title={tip}>
                              <span className="font-medium min-w-[150px]">{purposeLabelFor(p.purpose, p.label)}</span>
                              <code className="font-mono text-muted-foreground min-w-[120px]">{p.purpose}</code>
                              {r
                                ? <Badge variant={r.ready ? 'default' : 'secondary'} className={cn('text-[10px]', r.ready && 'bg-success')}>{r.ready ? 'READY' : 'NOT READY'}</Badge>
                                : <Badge variant="outline" className="text-[10px]">no data</Badge>}
                              {m && <span className="text-muted-foreground">n={m.n} · band {m.actBand.correct}/{m.actBand.n} @τ{m.actBand.threshold} · AUROC {Number.isFinite(m.auroc) ? m.auroc.toFixed(2) : 'n/a'} · cov@5% {(m.coverageAt5.coverage * 100).toFixed(0)}%</span>}
                              {h && (
                                <span
                                  className={cn('text-muted-foreground', (h.downgraded > 0 || h.latched > 0 || h.fails > 0) && 'text-warn-ink')}
                                  data-testid={`decision-health-${p.purpose}`}
                                  title={`Health over the window, summed across this purpose's non-challenger backends: ${h.calls} calls · ${h.fails} failed · ${h.fellThrough} answered by a later leg · ${h.latched} skipped a latched backend · ${h.downgraded} act asks answered by an uncalibrated backend (the consumer ran its pre-gate path).`}
                                >
                                  · health {h.calls}c/{h.fails}f{h.fellThrough ? `/${h.fellThrough}ft` : ''}{h.latched ? `/${h.latched}lat` : ''}{h.downgraded ? `/${h.downgraded}dg` : ''}
                                </span>
                              )}
                              {r && !r.ready && r.reasons[0] && <span className="text-muted-foreground truncate max-w-[360px]">— {r.reasons[0]}{r.reasons.length > 1 ? ` (+${r.reasons.length - 1})` : ''}</span>}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">Run <code className="font-mono">{decisionReadiness?.howTo ?? 'cd backend && npm run decision-gate:fit -- --days=14 --stamp'}</code> to measure every purpose against the flip bars (labels ≥ {decisionReadiness?.bars.minLabels ?? 200} over ≥ {decisionReadiness?.bars.minDays ?? 3} d, act-band precision ≥ {decisionReadiness?.bars.minActBandPrecision ?? 0.9} at the real cutoff, AUROC ≥ {decisionReadiness?.bars.minAuroc ?? 0.8}, coverage at ≤5% error ≥ {decisionReadiness?.bars.minCoverageAt5 ?? 0.6}) and stamp the verdict here. A purpose without a READY stamp has no evidence for act.</p>
                    )}
                  </div>
                </div>
              )}
              {role.key === DECISION_ROLE_KEY && decisionBackends && (
                <DecisionBackendsPanel
                  view={decisionBackends}
                  readiness={decisionReadiness}
                  modes={decisionModes}
                  seatEffective={role.effective}
                  onSaved={setDecisionBackends}
                />
              )}
              {role.key === DECISION_ROLE_KEY && decisionRegistry && (
                <DecisionRegistryPanel view={decisionRegistry} onRollout={(rollout) => setDecisionRegistry(v => (v ? { ...v, rollout } : v))} />
              )}
              {decisionSeat && (
                <p className="text-[11px] text-muted-foreground mt-1">This seat takes the built-in backends (jev = TypeSafe /v1/systemone, deepseek-flash = a logprob readout) or ANY registered endpoint model — a &quot;Decision model (/systemone)&quot; endpoint (TypeSafe Jev, or a self-hosted Laya / JevK5 / NeoHorse-Jev / openjev), a typed-decision model behind an OpenAI-compatible proxy (LiteLLM → Laya: flag it [typed decisions] on its endpoint, e.g. cql-litellm:agx-laya) or an OpenAI-compatible server that returns logprobs; the model need not be chat-capable.</p>
              )}
              {test && (
                <p className={cn('flex items-center gap-1 text-xs mt-2', test.ok ? 'text-success' : 'text-destructive')}>
                  {test.ok ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
                  {test.ok
                    ? `${test.target}: ${test.detail || 'connected'} (${(test.latencyMs / 1000).toFixed(1)}s)`
                    : `${test.target}: ${test.error || 'connection failed'}`}
                </p>
              )}
              {test?.ok && test.image && <ProbeImage image={test.image} label={`${role.persona} test image`} />}
            </div>
          );
        })}
      </div>

      {(builtIns.length > 0 || chains.length > 0) && (
        <div className="rounded-xl border p-3 space-y-2" data-testid="model-map">
          <button type="button" onClick={() => setMapOpen(o => !o)} className="flex w-full items-center gap-1.5 text-left" aria-expanded={mapOpen}>
            {mapOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
            <Map className="size-3.5 text-brand-accent" />
            <span className="text-xs font-semibold">Model map — what every built-in model is set to, and every fixed chain</span>
            <span className="text-[11px] text-muted-foreground ml-1">({builtIns.length} built-in models · {chains.length} chains)</span>
          </button>
          {mapOpen && (
            <div className="space-y-3">
              <p className="text-[11px] text-muted-foreground">
                Read-only. The seats above decide WHICH model runs; this lists the call parameters the code fixes for each built-in (reasoning, thinking, output caps, context budget) and the orders Digby walks when a model fails — so nothing about which model runs when is hidden in source.
              </p>
              <div className="space-y-1">
                <div className="text-[11px] font-semibold">Built-in models</div>
                {builtIns.map(m => (
                  <div key={m.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                    <code className="font-mono">{m.id}</code>
                    <span className="text-muted-foreground">{m.provider}</span>
                    {m.envKey && (m.present
                      ? <span className="inline-flex items-center gap-0.5 text-success"><Check className="size-3" /> {m.envKey}</span>
                      : <span className="inline-flex items-center gap-0.5 text-destructive"><X className="size-3" /> {m.envKey} missing</span>)}
                    {m.supportsVision && <Badge variant="secondary" className="text-[10px]">vision</Badge>}
                    {m.mustStream && <Badge variant="secondary" className="text-[10px]">must stream</Badge>}
                    <span className="text-muted-foreground">{m.params}{m.contextChars ? `; context budget ~${Math.round(m.contextChars / 4000)}k tokens` : ''}</span>
                    {m.defaultFor.length > 0 && <span className="text-muted-foreground">— default for {m.defaultFor.join(', ')}</span>}
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <div className="text-[11px] font-semibold">Fixed chains</div>
                {chains.map(c => (
                  <div key={c.key} className="text-[11px]">
                    <div className="font-medium">{c.title}{c.seats?.length ? <span className="text-muted-foreground font-normal"> · seats: {c.seats.join(', ')}</span> : null}</div>
                    <ol className="list-decimal pl-5 text-muted-foreground">
                      {c.steps.map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                    {c.envKeys?.length ? <div className="text-muted-foreground">env: {c.envKeys.map(k => <code key={k} className="font-mono mr-1">{k}</code>)}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Agent seats take built-ins or any chat-capable endpoint model (kind: chat — coding is a seat choice, not a model capability; embeddings / rerank / speech / image / decision models never appear here); the image seats (Image reader, PDF reader, Computer-use vision) also need the [vision] flag. A seat whose model rejected a request deterministically (tools over its cap, reasoning_effort refused with tools, an unsupported parameter, model not found, context too long) is latched off for 30 minutes and shows an amber &quot;seat unusable&quot; badge naming what runs instead — fix the model entry under Model endpoints (max tools / effort / kind, or run Detect capabilities) or re-seat it. The Helper and Utility seats (and their custom fallbacks) are called non-streaming — a default-thinking custom model (Qwen3…) should be flagged &quot;no-think&quot; on its endpoint entry or it spends the whole budget reasoning; the Test button now probes that exact shape. The Browser agent, Computer-use vision and image seats are also non-streaming (one bounded call per step) — Kimi is offered only where its per-step latency fits. A custom fallback only takes over when the seat&apos;s own model fails; leave it empty to keep Digby&apos;s built-in behaviour. Embeddings overrides must yield 1536-dimension vectors: an MRL model that natively returns more (Qwen3-Embedding…) works when flagged &quot;MRL&quot; on its endpoint entry (Digby truncates client-side), Save refuses a mismatch, and switching embedding models means re-ingesting existing documents. The reranker expects a Cohere-style /rerank route and falls back to fused keyword+vector order on failure. The speech-to-text (ASR) seat expects an OpenAI-compatible /audio/transcriptions route (voice notes + YouTube audio); when it errors or is unset, the built-in chain (self-hosted STT_BASE_URL, else DashScope qwen3-asr-flash) serves instead. The text-to-speech seat expects an OpenAI-compatible /audio/speech route; unset = DashScope qwen3-tts-flash. The Image generator seat takes the built-in image models (DashScope Qwen-Image / Wan / Z-Image, Z.AI GLM-Image / CogView) or an endpoint model flagged [image] (an OpenAI-compatible /images/generations route returning b64_json); when its model fails, the built-in image chain serves next, and its Test draws a small picture and shows it under the row. The Decision gate seat takes any registered endpoint model (a Decision model (/systemone) server such as TypeSafe Jev, Laya, JevK5, NeoHorse-Jev or openjev, or a logprobs-capable chat server) and carries its own per-purpose primary / challenger panel — flag a self-hosted decision server&apos;s model [calibrated] only when its probabilities really are, and set &quot;max state chars&quot; for a short-context model (Laya: ~1,200).
      </p>
    </div>
  );
}
