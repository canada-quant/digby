'use client';

/**
 * Model endpoints — Digby Edge (Phase 2) admin section (Account → Admin →
 * Endpoints). Manages the custom model endpoint registry: any OpenAI-compatible
 * server (Ollama, vLLM, LM Studio, OpenRouter, llama.cpp). API keys are
 * write-only (the API returns hasApiKey, never the key). Any CHAT-capable model
 * (kind: chat) becomes selectable as a coding model ("<label>:<modelId>") in
 * Account → Coding and for the chat / agent seats — coding is a seat choice,
 * not a model capability (owner, 2026-09-27; the legacy [coding] flag is only
 * one of the ways a model reads as chat-capable).
 *
 * The dialog auto-discovers models via POST …/model-endpoints/probe (the
 * server's GET /models); vision / image / MRL / no-think / typed decisions /
 * calibrated are per-row toggle chips; the 2026-09-27 seat/provider limits
 * (max tools, reasoning-effort support, provider class, kind, context window)
 * are per-row controls; and "Detect capabilities" (POST …/:id/detect[/:modelId])
 * runs a bounded probe suite that SETS those flags with evidence — a flag the
 * admin set by hand (`manualFlags`) is never overwritten by a re-detect.
 *
 * Decision servers (providerShape 'systemone'; 2026-09-26 open-weight support):
 * TypeSafe Jev or a self-hosted Laya / JevK5 / NeoHorse-Jev / openjev. Their
 * models carry two extra fields for the decision gate — the [calibrated]
 * assertion chip and a "max state chars" cap (Laya's 512-token context) —
 * and the Test button runs a typed /systemone probe instead of the chat probe.
 *
 * Layout contract (owner screenshot 2026-09-27 — the edit dialog clipped its
 * intro, label hint, flag chips and legend past the right edge, with a
 * fixed-height model list inside a dialog that could not scroll): the dialog
 * is viewport-capped and scrolls as a whole (ENDPOINT_DIALOG_CONTENT_CLASS),
 * every model row and its chip / control lines WRAP (MODEL_ROW_CLASS,
 * MODEL_CHIPS_CLASS), ids break, the legend is a compact wrapped block, and
 * nothing carries whitespace-nowrap or a fixed pixel width wider than the
 * container. Pinned by ModelEndpointsSection.test.tsx at 1280 px and 400 px.
 */

import { useCallback, useEffect, useState } from 'react';
import { strippedDecisionFields } from '@/lib/decision-backends';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  modelEndpointsApi, modelKindOf, ENDPOINT_MODEL_KINDS, PROVIDER_CLASSES, REASONING_EFFORT_SUPPORTS, DETECT_CAPABILITY_LABELS,
  type ModelEndpoint, type EndpointModel, type EndpointTestResult,
  type EndpointModelVerifyResult, type EndpointModelVerifyShapeResult,
  type EndpointSettings, type DetectedModelReport, type DetectedCapabilityResult, type DetectCapability,
  type EndpointModelKind, type ProviderClass, type ReasoningEffortSupport,
} from '@/lib/api/model-endpoints';
import { Cable, Loader2, Pencil, Plus, Trash2, PlugZap, Check, X, RefreshCw, ShieldCheck, Radar, ChevronDown, ChevronRight } from 'lucide-react';

interface DraftState {
  id: string | null; // null = create
  label: string;
  providerShape: 'openai_chat' | 'systemone' | 'systemone_chat';
  baseUrl: string;
  apiKey: string;    // write-only; '' on edit = unchanged until typed (see save)
  clearKey: boolean;
  models: EndpointModel[];
  /** Endpoint-level settings (2026-09-27): { maxTools } for every model without its own cap. */
  settings: EndpointSettings;
}

const EMPTY_DRAFT: DraftState = { id: null, label: '', providerShape: 'openai_chat', baseUrl: '', apiKey: '', clearKey: false, models: [], settings: {} };

// ── Layout contract (pinned by ModelEndpointsSection.test.tsx) ────────────────
/** The dialog: never wider than the viewport (16 px gutters), a generous
 *  desktop cap, viewport-capped height with the WHOLE dialog scrolling, no
 *  horizontal overflow, and min-w-0 so a long id / URL cannot widen the grid. */
export const ENDPOINT_DIALOG_CONTENT_CLASS =
  'w-[calc(100%-2rem)] max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[calc(100dvh-2rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] overflow-y-auto overflow-x-hidden min-w-0';
/** One model row: the id line, then the chips / controls / report WRAP under it. */
export const MODEL_ROW_CLASS = 'flex flex-wrap items-start gap-x-2 gap-y-1 px-2 py-1.5 min-w-0';
/** The flag chips and the limit controls wrap on any width. */
export const MODEL_CHIPS_CLASS = 'flex flex-wrap items-center gap-1 min-w-0 w-full';
/** The footer legend: compact, wrapped, never one run-on line. */
export const LEGEND_CLASS = 'text-[11px] leading-snug text-muted-foreground mt-2 break-words space-y-0.5';

/** Human labels for the per-model parse-verification battery shapes. */
const VERIFY_SHAPE_LABELS: Record<EndpointModelVerifyShapeResult['shape'], string> = {
  chat_stream: 'Streaming chat (SSE parse)',
  utility: 'Utility completion (non-streaming)',
  embeddings: 'Embeddings (1536-dim)',
  rerank: 'Rerank (Cohere shape)',
  decision: 'Typed decision (/systemone)',
};

/** Which model flag a detected capability writes — highlights the report row when `changed` names it. */
const CAPABILITY_FLAG: Record<string, string[]> = {
  max_tools: ['maxTools'],
  reasoning_effort: ['reasoningEffort'],
  thinking_default: ['thinking'],
  vision: ['vision'],
  embeddings: ['matryoshka', 'kind'],
  rerank: ['kind'],
  typed_decisions: ['decision', 'kind'],
  image_generation: ['image', 'kind'],
  context_window: ['contextWindow'],
  tool_calling: ['kind'],
  chat_stream: ['kind'],
  // 2026-09-28: a typed-decision model's ONLY probe (the Verify call) — pins kind: decision.
  decision: ['kind'],
};

/** 2026-09-28: true when a detection report is a typed-decision model's (the decision probe ran —
 *  the chat probes were not applicable and were never sent). Pure. */
export function isDecisionModelReport(report: Pick<DetectedModelReport, 'results'>): boolean {
  return report.results.some(r => r.capability === 'decision');
}

/** The flags the admin may set by hand — each manual change is remembered in `manualFlags`. */
type ManualFlag = 'vision' | 'image' | 'matryoshka' | 'calibrated' | 'thinking' | 'decision' | 'maxStateChars' | 'maxTools' | 'reasoningEffort' | 'providerClass' | 'kind' | 'contextWindow' | 'usdPerMTokIn' | 'usdPerMTokOut' | 'unservable' | 'imageTimeoutMs';

/** A non-negative USD/M price from an input (blank / garbage / negative → unset). */
function priceOrUndefined(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Mark a flag as admin-set so a re-detect never overwrites it. Pure. */
export function withManualFlag(m: EndpointModel, flag: ManualFlag): EndpointModel {
  const flags = new Set(m.manualFlags ?? []);
  flags.add(flag);
  return { ...m, manualFlags: [...flags] };
}

/** Merge a detection report's persisted entry into the dialog's draft entry:
 *  the backend's flags win, except the fields the DRAFT marks manual (unsaved
 *  admin edits stay). Pure. */
export function mergeDetectedEntry(draftEntry: EndpointModel, entry: EndpointModel): EndpointModel {
  const manual = new Set([...(draftEntry.manualFlags ?? []), ...(entry.manualFlags ?? [])]);
  const merged: EndpointModel = { ...draftEntry, ...entry, manualFlags: manual.size ? [...manual] : undefined };
  for (const f of draftEntry.manualFlags ?? []) {
    (merged as unknown as Record<string, unknown>)[f] = (draftEntry as unknown as Record<string, unknown>)[f];
  }
  if (!merged.manualFlags) delete merged.manualFlags;
  return merged;
}

const positiveIntOrUndefined = (raw: string): number | undefined => {
  const n = Math.floor(Number(raw));
  return raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A detected value as a short human string. */
function detectedValueText(r: DetectedCapabilityResult): string {
  if (r.skipped) return 'skipped';
  if (!r.ok) return '—';
  if (r.value === null || r.value === undefined) return 'undetermined';
  if (typeof r.value === 'boolean') return r.value ? 'yes' : 'no';
  return String(r.value);
}

const clock = (iso: string | undefined): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') + 'Z' : iso;
};

/**
 * Toast/message suffix for the completion-auth probe outcome (ticket 1dc89d48):
 * when the probe fell back past dead listed model(s), name the model that
 * actually answered so the admin learns their server's list order is hiding a
 * dead route. '' when no probe ran (no key / empty models list).
 */
function completionAuthNote(r: EndpointTestResult): string {
  if (r.completionAuth !== 'ok') return '';
  return r.probedModel
    ? ` · chat-completion auth verified via ${r.probedModel} (earlier listed model(s) did not respond)`
    : ' · chat-completion auth verified';
}

// ── Pure presentational pieces (rendered by the layout test with react-dom/server) ──

export interface ModelChip { key: string; label: string; on: boolean; flip: () => void; title: string; manual?: boolean }

/** The flag chips of one model row — a wrapping line, never nowrap. */
export function ModelFlagChips({ chips }: { chips: ModelChip[] }) {
  return (
    <div className={MODEL_CHIPS_CLASS} data-testid="model-chips">
      {chips.map(chip => (
        <button
          key={chip.key}
          type="button"
          onClick={chip.flip}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors',
            chip.on
              ? 'border-brand-accent bg-brand-accent/10 text-brand-text'
              : 'text-muted-foreground hover:border-muted-foreground/50',
          )}
          title={`${chip.title}${chip.manual ? ' (manual — kept by Detect capabilities)' : ''}`}
        >
          {chip.label}{chip.manual ? '*' : ''}
        </button>
      ))}
    </div>
  );
}

/** The 2026-09-27 seat/provider-limit controls of one model row: max tools,
 *  reasoning-effort support, provider class, kind, context window. Each change
 *  is a manual flag. */
export function ModelLimitControls({ m, onChange }: { m: EndpointModel; onChange: (patch: Partial<EndpointModel>, flag: ManualFlag) => void }) {
  const manual = new Set(m.manualFlags ?? []);
  const star = (f: ManualFlag) => (manual.has(f) ? '*' : '');
  const derivedKind = modelKindOf(m);
  return (
    <div className={cn(MODEL_CHIPS_CLASS, 'text-[10px]')} data-testid="model-limits">
      <label className="flex items-center gap-1" title="Largest tools array the server accepts per request. Unset = the endpoint default, else the provider-class default (OpenAI-like ids → 128), else unlimited. Digby trims the long tail automatically (core + doctrine tools first).">
        <span className="text-muted-foreground">max tools{star('maxTools')}</span>
        <input
          type="number"
          min={1}
          step={1}
          value={m.maxTools ?? ''}
          onChange={e => onChange({ maxTools: positiveIntOrUndefined(e.target.value) }, 'maxTools')}
          placeholder="auto"
          aria-label={`${m.id} max tools`}
          className="h-6 w-16 rounded-md border bg-background px-1.5 text-[10px] font-mono"
        />
      </label>
      <label className="flex items-center gap-1" title="What this model bills at, USD per 1M INPUT tokens (0 = free). Read by the decision gate's spend rows (Account → Admin → API costs): unset = the endpoint's default price, else $0 badged self-hosted.">
        <span className="text-muted-foreground">$/M in{star('usdPerMTokIn')}</span>
        <input
          type="number"
          min={0}
          step="any"
          value={m.usdPerMTokIn ?? ''}
          onChange={e => onChange({ usdPerMTokIn: priceOrUndefined(e.target.value) }, 'usdPerMTokIn')}
          placeholder="endpoint"
          aria-label={`${m.id} USD per million input tokens`}
          className="h-6 w-16 rounded-md border bg-background px-1.5 text-[10px] font-mono"
        />
      </label>
      <label className="flex items-center gap-1" title="What this model bills at, USD per 1M OUTPUT tokens (0 = free).">
        <span className="text-muted-foreground">$/M out{star('usdPerMTokOut')}</span>
        <input
          type="number"
          min={0}
          step="any"
          value={m.usdPerMTokOut ?? ''}
          onChange={e => onChange({ usdPerMTokOut: priceOrUndefined(e.target.value) }, 'usdPerMTokOut')}
          placeholder="endpoint"
          aria-label={`${m.id} USD per million output tokens`}
          className="h-6 w-16 rounded-md border bg-background px-1.5 text-[10px] font-mono"
        />
      </label>
      <label className="flex items-center gap-1" title="Does the model accept reasoning_effort / thinking together with function tools on /chat/completions? auto (default) and unsupported = Digby omits them for custom endpoints; supported = the seat's effort flows through. OpenAI reasoning models behind LiteLLM reject reasoning_effort with tools: add `reasoning_effort: none` under litellm_params for that model group, or route it via /v1/responses.">
        <span className="text-muted-foreground">effort{star('reasoningEffort')}</span>
        <select
          value={m.reasoningEffort ?? 'auto'}
          onChange={e => onChange({ reasoningEffort: e.target.value as ReasoningEffortSupport }, 'reasoningEffort')}
          aria-label={`${m.id} reasoning effort support`}
          className="h-6 rounded-md border bg-background px-1 text-[10px] font-mono"
        >
          {REASONING_EFFORT_SUPPORTS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1" title="Provider family behind the endpoint — sets the DOCUMENTED tool cap (openai → 128, google → 512; the others document none = unlimited until a live 400 teaches one). Derived from the id unless you pick one.">
        <span className="text-muted-foreground">class{star('providerClass')}</span>
        <select
          value={m.providerClass ?? ''}
          onChange={e => onChange({ providerClass: (e.target.value || undefined) as ProviderClass | undefined }, 'providerClass')}
          aria-label={`${m.id} provider class`}
          className="h-6 rounded-md border bg-background px-1 text-[10px] font-mono"
        >
          <option value="">auto</option>
          {PROVIDER_CLASSES.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1" title="What the model IS. Only chat models can serve the chat, agent and coding seats — coding is a seat choice, not a model capability. Unset = derived (legacy flags, the last detection, then the id).">
        <span className="text-muted-foreground">kind{star('kind')}</span>
        <select
          value={m.kind ?? ''}
          onChange={e => onChange({ kind: (e.target.value || undefined) as EndpointModelKind | undefined }, 'kind')}
          aria-label={`${m.id} kind`}
          className="h-6 rounded-md border bg-background px-1 text-[10px] font-mono"
        >
          <option value="">auto ({derivedKind})</option>
          {ENDPOINT_MODEL_KINDS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1" title="Context window in tokens (from /models metadata when the server publishes one). Sizes the transcript budget for this model; blank = the conservative default.">
        <span className="text-muted-foreground">ctx{star('contextWindow')}</span>
        <input
          type="number"
          min={256}
          step={1024}
          value={m.contextWindow ?? ''}
          onChange={e => onChange({ contextWindow: positiveIntOrUndefined(e.target.value) }, 'contextWindow')}
          placeholder="tokens"
          aria-label={`${m.id} context window tokens`}
          className="h-6 w-24 rounded-md border bg-background px-1.5 text-[10px] font-mono"
        />
      </label>
    </div>
  );
}

/** The per-model detection report: capability · detected value · evidence · when; changed rows highlighted. */
export function DetectReportTable({ report, open, onToggle }: { report: DetectedModelReport; open: boolean; onToggle: () => void }) {
  const changedFlags = new Set(report.changed.map(c => c.split('=')[0]));
  const rowChanged = (capability: string) => (CAPABILITY_FLAG[capability] ?? []).some(f => changedFlags.has(f));
  return (
    <div className="w-full min-w-0 rounded-md border border-dashed px-2 py-1 text-[11px]" data-testid="detect-report">
      <button type="button" onClick={onToggle} className="flex w-full min-w-0 items-center gap-1 text-left text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <Radar className="size-3 shrink-0 text-brand-accent" />
        <span className="min-w-0 break-words">
          {report.results.length} capability result(s) · detected {clock(report.detectedAt)}
          {report.changed.length ? <span className="text-warn-ink"> · changed: {report.changed.join(', ')}</span> : ' · nothing changed'}
        </span>
      </button>
      {isDecisionModelReport(report) && (
        <p className="mt-1 text-muted-foreground break-words" data-testid="detect-decision-note">
          Typed-decision model — chat capabilities not applicable. Only the typed-decision probe ran (the same call Verify makes); the streaming / tools / vision probes were never sent.
        </p>
      )}
      {open && (
        <div className="mt-1 overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-muted-foreground">
              <tr><th className="pr-2 font-medium">capability</th><th className="pr-2 font-medium">detected</th><th className="pr-2 font-medium">evidence</th><th className="font-medium">when</th></tr>
            </thead>
            <tbody>
              {report.results.map(r => (
                <tr key={r.capability} className={cn('align-top', rowChanged(r.capability) && 'bg-warn/10')} data-changed={rowChanged(r.capability) ? '1' : undefined}>
                  <td className="pr-2 py-0.5 whitespace-normal">{DETECT_CAPABILITY_LABELS[r.capability as DetectCapability] ?? r.capability}</td>
                  <td className={cn('pr-2 py-0.5 font-mono', r.ok ? '' : 'text-muted-foreground')}>{detectedValueText(r)}</td>
                  <td className="pr-2 py-0.5 break-words text-muted-foreground">{r.evidence}</td>
                  <td className="py-0.5 whitespace-normal text-muted-foreground">{clock(r.at)}{r.latencyMs ? ` (${(r.latencyMs / 1000).toFixed(1)}s)` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The dialog's footer legend — a compact wrapped block (one item per line). */
export function EndpointDialogLegend() {
  return (
    <div className={LEGEND_CLASS} data-testid="endpoint-legend">
      <p>kind = what the model is (chat / embeddings / rerank / asr / tts / image / decision). Any chat-capable model (kind: chat) can serve the chat, agent and coding seats — coding is a seat choice, not a model capability.</p>
      <p>max tools = the largest tools array the server accepts; OpenAI-like models accept at most 128 tools — Digby trims the long tail automatically (core + doctrine tools first); set max tools when the server says otherwise (per model, or the endpoint default above). Kill switch TOOL_LIMIT_TRIM_DISABLED=1 keeps the cap but trims first-N instead.</p>
      <p>effort = whether the model accepts reasoning_effort with tools on /chat/completions; custom endpoints do NOT receive reasoning_effort unless flagged supported. OpenAI reasoning models behind LiteLLM reject reasoning_effort with tools on /chat/completions: add `reasoning_effort: none` under litellm_params for that model group, or route it via /v1/responses. A deterministic 400 (tools over the cap, effort refused, unsupported parameter, model not found, context too long) moves the seat to its fallback and latches it for 30 min (SEAT_INVALID_REQUEST_FALLBACK_DISABLED=1 turns that off).</p>
      <p>class = provider family behind the proxy (sets the default tool cap) · ctx = context window in tokens (sizes the transcript budget).</p>
      <p>vision = accepts image input · image = generates pictures via an OpenAI-shaped /images/generations route (assignable to the Image generator seat) · MRL = Matryoshka embedding model, truncated to 1536 client-side · no-think = disable thinking on every call (default-thinking models on the Helper / Utility seats).</p>
      <p>image timeout (ms) = the per-model image-generation wait (04c8ffd1, 2026-10-23): slow local backends (Qwen-Image behind LiteLLM, 5-10 min/generation) die at the shipped 120 s cap — set 300000-600000 (clamped 30000-720000); the whole-call budget scales up with it, and the seat's Test button probes at this raised budget too. Instance-wide default: the IMAGE_CUSTOM_TIMEOUT_MS env; a per-model value wins.</p>
      <p>calibrated = a DECISION backend whose probabilities you assert are calibrated (an act purpose may act on them without a fitted temperature; never for Laya) · typed decisions = a DECISION model behind an OpenAI-compatible proxy (LiteLLM → Laya, e.g. agx-laya): the gate calls it through /chat/completions with a questions map instead of the logprob readout · max state chars = the decision gate truncates the state to this many characters for the model (Laya ≈ 1200; Laya behind LiteLLM ≈ 3800; blank = no cap).</p>
      <p>Detect capabilities probes each model (≤4 at a time, ~20 s per probe) and sets these flags with evidence; a flag you set by hand (marked *) is kept.</p>
    </div>
  );
}

export function ModelEndpointsSection() {
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ModelEndpoint | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, EndpointTestResult>>({});
  // Model-list sync (ticket 780cd7a4): the endpoint being synced (one at a time).
  const [syncingId, setSyncingId] = useState<string | null>(null);
  // Per-model parse verification — keyed `${endpointId}:${modelId}` like testResults.
  const [verifyingKey, setVerifyingKey] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, EndpointModelVerifyResult>>({});
  // Dialog model-editor transients (reset whenever the draft opens/closes).
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newModelId, setNewModelId] = useState('');
  // Detect capabilities (2026-09-27): '*' = the whole endpoint, else one model id.
  const [detecting, setDetecting] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, DetectedModelReport>>({});
  const [openReports, setOpenReports] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      setEndpoints(await modelEndpointsApi.list());
    } catch {
      toast.error('Failed to load model endpoints');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDraft = (d: DraftState | null) => {
    setDraft(d);
    setFetching(false);
    setFetchMsg(null);
    setNewModelId('');
    setDetecting(null);
    setReports({});
    setOpenReports({});
  };

  const openEdit = (ep: ModelEndpoint) => openDraft({
    id: ep.id,
    label: ep.label,
    providerShape: ep.providerShape === 'systemone' ? 'systemone' : ep.providerShape === 'systemone_chat' ? 'systemone_chat' : 'openai_chat',
    baseUrl: ep.baseUrl,
    apiKey: '',
    clearKey: false,
    models: ep.models.map(m => ({ ...m })),
    settings: { ...(ep.settings ?? {}) },
  });

  /**
   * The decision-backend model fields ([calibrated], max state chars; 2026-09-26)
   * are stored only by a backend that carries plan item A's schema + whitelist —
   * an older one strips them SILENTLY on save (zod z.object drops unknown keys;
   * the service normalizer whitelists flags). Compare what was sent with what
   * came back and say so, instead of "Endpoint updated" followed by the chip
   * being gone after a reload (reviewer finding 2026-09-26).
   * bd51693b review F2: the echo can differ because it was DROPPED (older
   * backend) or CLAMPED to a bound (the value the backend stored) — the copy
   * covers both so a clamp is never told to "set it again" (which is a no-op).
   */
  const warnStrippedDecisionFields = (sent: EndpointModel[], saved: ModelEndpoint | null | undefined) => {
    const stripped = strippedDecisionFields(sent, saved?.models);
    if (!stripped.length) return;
    toast.warning(`This backend did not keep ${stripped.join(' / ')} as saved — the value was dropped (an older backend) or clamped to a stored bound. Reload to see the stored value; if it was dropped, deploy the backend half first and set it again.`, { duration: 10000 });
  };

  const save = async () => {
    if (!draft) return;
    const models = draft.models;
    if (!draft.label.trim()) { toast.error('Label is required'); return; }
    if (!draft.baseUrl.trim()) { toast.error('Base URL is required'); return; }
    if (!models.length) { toast.error('Add at least one model — fetch from the server or add manually'); return; }
    setSaving(true);
    try {
      if (draft.id) {
        const patch: Record<string, unknown> = {
          label: draft.label.trim(),
          providerShape: draft.providerShape,
          baseUrl: draft.baseUrl.trim(),
          models,
          settings: draft.settings,
        };
        // apiKey patch semantics: typed value = replace; "clear" = ''; untouched = omit.
        if (draft.apiKey.trim()) patch.apiKey = draft.apiKey.trim();
        else if (draft.clearKey) patch.apiKey = '';
        const saved = await modelEndpointsApi.update(draft.id, patch);
        toast.success('Endpoint updated');
        warnStrippedDecisionFields(models, saved);
      } else {
        const saved = await modelEndpointsApi.create({
          label: draft.label.trim(),
          providerShape: draft.providerShape,
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim() || undefined,
          models,
          settings: draft.settings,
        });
        toast.success('Endpoint added');
        warnStrippedDecisionFields(models, saved);
      }
      openDraft(null);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to save endpoint');
    } finally {
      setSaving(false);
    }
  };

  // ── Model list editor helpers ────────────────────────────────────────────

  const patchModel = (idx: number, fn: (m: EndpointModel) => EndpointModel) =>
    setDraft(d => d ? { ...d, models: d.models.map((m, j) => j === idx ? fn(m) : m) } : d);

  // Every hand toggle is remembered in `manualFlags` so Detect capabilities never overwrites it.
  const toggleFlag = (idx: number, flag: 'vision' | 'image' | 'matryoshka' | 'calibrated') =>
    patchModel(idx, m => withManualFlag({ ...m, [flag]: !m[flag] }, flag));

  // 'no-think' chip: thinking 'off' ⇄ unset (the server default).
  const toggleThinking = (idx: number) =>
    patchModel(idx, m => withManualFlag({ ...m, thinking: m.thinking === 'off' ? undefined : 'off' }, 'thinking'));

  // 'typed decisions' chip (Laya follow-up, 2026-09-26): decision 'systemone_chat' ⇄ unset — the model on an
  // OpenAI-compatible endpoint is a typed-decision model behind a proxy (LiteLLM → Laya); the gate uses the
  // systemone_chat transport for it instead of the logprob readout.
  const toggleTypedDecisions = (idx: number) =>
    patchModel(idx, m => withManualFlag({ ...m, decision: m.decision === 'systemone_chat' ? undefined : 'systemone_chat' }, 'decision'));

  // 'retired' chip (f90 follow-up, 2026-10-06): unservable ⇄ unset — the entry stays listed for
  // provenance but stops resolving (the gateway route was torn down; every call 400s "Invalid
  // model name"). Seats fall back to their built-in, the catalog card goes servable:false, and
  // no automatic pick ever routes here. Un-retiring is a human decision.
  const toggleRetired = (idx: number) =>
    patchModel(idx, m => withManualFlag({ ...m, unservable: m.unservable === true ? undefined : true }, 'unservable'));

  // 'max state chars' (decision backends, 2026-09-26): a positive integer or unset.
  const setMaxStateChars = (idx: number, raw: string) =>
    patchModel(idx, m => withManualFlag({ ...m, maxStateChars: positiveIntOrUndefined(raw) }, 'maxStateChars'));

  // 'image timeout ms' (04c8ffd1, 2026-10-23): per-model image-generation wait for
  // [image]-flagged registry models — slow local backends (Qwen-Image behind LiteLLM,
  // 5-10 min/generation) need 300000-600000; the backend clamps [30000, 720000] on save.
  const setImageTimeoutMs = (idx: number, raw: string) =>
    patchModel(idx, m => withManualFlag({ ...m, imageTimeoutMs: positiveIntOrUndefined(raw) }, 'imageTimeoutMs'));

  // The 2026-09-27 limit controls (max tools / effort / class / kind / ctx).
  const setLimit = (idx: number, patch: Partial<EndpointModel>, flag: ManualFlag) =>
    patchModel(idx, m => withManualFlag({ ...m, ...patch }, flag));

  /** Chip catalog — label, whether it is on, how to flip it, and the tooltip. */
  const modelChips = (m: EndpointModel, i: number): ModelChip[] => {
    const manual = new Set(m.manualFlags ?? []);
    return [
      { key: 'vision', label: 'vision', on: !!m.vision, flip: () => toggleFlag(i, 'vision'), title: 'Accepts image input', manual: manual.has('vision') },
      { key: 'image', label: 'image', on: !!m.image, flip: () => toggleFlag(i, 'image'), title: 'Image GENERATION model served on an OpenAI-shaped POST /images/generations route (b64_json) — the only registry models the Image generator seat accepts. Distinct from vision (image INPUT).', manual: manual.has('image') },
      { key: 'matryoshka', label: 'MRL', on: !!m.matryoshka, flip: () => toggleFlag(i, 'matryoshka'), title: 'Matryoshka-trained EMBEDDING model (Qwen3-Embedding, text-embedding-3, nomic v1.5…): when it returns more than 1536 dimensions Digby truncates to 1536 + renormalizes client-side. Only for MRL models — truncating anything else corrupts retrieval.', manual: manual.has('matryoshka') },
      { key: 'no-think', label: 'no-think', on: m.thinking === 'off', flip: () => toggleThinking(i), title: 'Send the thinking-disable directive (chat_template_kwargs.enable_thinking=false) on every call. Use for default-thinking models (Qwen3…) on the Helper / Utility seats — those are called non-streaming and a thinking model spends the whole budget reasoning, returning nothing.', manual: manual.has('thinking') },
      { key: 'typed-decisions', label: 'typed decisions', on: m.decision === 'systemone_chat', flip: () => toggleTypedDecisions(i), title: 'DECISION backends behind an OpenAI-compatible PROXY (LiteLLM fronting Laya — llm.cql.ca agx-laya): this model answers typed decisions through POST /chat/completions with a questions map and a JSON answers envelope in the message content. The Decision gate then calls it with the systemone_chat transport instead of the logprob readout (which such a proxy refuses: "a typed-decision model, not a chat model"). Set max state chars ≈ 3800 next to it (the proxy silently cuts the state at 1,024 input tokens). Never flag a chat model.', manual: manual.has('decision') },
      { key: 'calibrated', label: 'calibrated', on: !!m.calibrated, flip: () => toggleFlag(i, 'calibrated'), title: 'DECISION backends only: you assert this server returns CALIBRATED probabilities (TypeSafe Jev; JevK5 applies its fitted temperature server-side). Unset = uncalibrated — an act purpose it answers is downgraded to shadow until the readiness job fits a temperature for it on Digby\'s own labels. Laya ships over-confident (ECE ≈ 0.3–0.5 raw): leave it unset.', manual: manual.has('calibrated') },
      { key: 'retired', label: 'retired', on: m.unservable === true, flip: () => toggleRetired(i), title: 'RETIRED (2026-10-06): listed for provenance but never served — the gateway route behind this model was torn down, so every call 400s "Invalid model name" (a deterministic rejection retries cannot fix). The spec stops resolving (seats fall back to their built-in and badge resolves:false), the catalog card goes servable:false, and no automatic pick ever routes here. Un-retiring is a human decision.', manual: manual.has('unservable') },
    ];
  };

  const removeModel = (idx: number) =>
    setDraft(d => d ? { ...d, models: d.models.filter((_, j) => j !== idx) } : d);

  const addManual = () => {
    if (!draft) return;
    const id = newModelId.trim();
    if (!id) return;
    if (draft.models.some(m => m.id === id)) { toast.error(`"${id}" is already listed`); return; }
    setDraft({ ...draft, models: [...draft.models, { id }] });
    setNewModelId('');
  };

  /** Auto-discovery: probe the draft's server and merge reported ids (flags preserved). */
  const fetchModels = async () => {
    if (!draft || !draft.baseUrl.trim()) return;
    setFetching(true);
    setFetchMsg(null);
    try {
      const result = await modelEndpointsApi.probe({
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim() || undefined,
        endpointId: draft.id || undefined,
      });
      if (!result.ok) {
        setFetchMsg({ ok: false, text: result.error || 'Connection failed' });
        return;
      }
      const ids = result.models || [];
      setDraft(d => {
        if (!d) return d;
        const have = new Set(d.models.map(m => m.id));
        return { ...d, models: [...d.models, ...ids.filter(id => !have.has(id)).map(id => ({ id }))] };
      });
      setFetchMsg({
        ok: true,
        text: (ids.length ? `${ids.length} model(s) reported by the server` : 'The server reported no models — add ids manually below')
          + completionAuthNote(result),
      });
    } catch (err: any) {
      setFetchMsg({ ok: false, text: err?.response?.data?.error || 'Fetch failed' });
    } finally {
      setFetching(false);
    }
  };

  /**
   * Detect capabilities (2026-09-27): the backend probes the SAVED endpoint
   * (its stored key — never sent from here) and persists the flags; the report's
   * per-model entry is merged into the draft (a field the draft marks manual is
   * kept) and shown as a results table under the model.
   */
  const runDetect = async (modelId?: string) => {
    if (!draft?.id) { toast.error('Save the endpoint first — detection probes the saved endpoint with its stored key'); return; }
    const endpointId = draft.id;
    setDetecting(modelId ?? '*');
    try {
      const result = modelId ? await modelEndpointsApi.detectModel(endpointId, modelId) : await modelEndpointsApi.detect(endpointId);
      const byId = new Map(result.models.map(r => [r.id, r]));
      setDraft(d => d && d.id === endpointId ? { ...d, models: d.models.map(m => { const r = byId.get(m.id); return r ? mergeDetectedEntry(m, r.entry) : m; }) } : d);
      setReports(prev => { const next = { ...prev }; for (const r of result.models) next[r.id] = r; return next; });
      setOpenReports(prev => { const next = { ...prev }; for (const r of result.models) if (r.changed.length) next[r.id] = true; return next; });
      const changed = result.models.filter(r => r.changed.length);
      const failed = result.models.flatMap(r => r.results.filter(x => !x.ok && !x.skipped)).length;
      toast.success(`Detected ${result.models.length} model(s) — ${changed.length} changed${failed ? `, ${failed} probe(s) inconclusive` : ''}`);
      // The persisted flags are already on the server — refresh the card list.
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Detection failed');
    } finally {
      setDetecting(null);
    }
  };

  const toggleEnabled = async (ep: ModelEndpoint) => {
    try {
      await modelEndpointsApi.update(ep.id, { enabled: !ep.enabled });
      setEndpoints(prev => prev.map(e => e.id === ep.id ? { ...e, enabled: !ep.enabled } : e));
    } catch {
      toast.error('Failed to update endpoint');
    }
  };

  const runTest = async (ep: ModelEndpoint) => {
    setTestingId(ep.id);
    try {
      const result = await modelEndpointsApi.test(ep.id);
      setTestResults(prev => ({ ...prev, [ep.id]: result }));
      if (result.ok) {
        // Ticket 2df5ed65: a healthy endpoint whose probe verdict carries a
        // detail (the typed-decision shape note) toasts it — the admin must see
        // WHY the shape note appears, not just "connected".
        toast.success(`${ep.label}: connected — ${result.models?.length ?? 0} model(s) reported${completionAuthNote(result)}${result.detail ? ` — ${result.detail}` : ''}`);
      } else toast.error(`${ep.label}: ${result.error || 'connection failed'}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Test failed');
    } finally {
      setTestingId(null);
    }
  };

  /**
   * Model-list SYNC (ticket 780cd7a4): the backend re-pulls the SAVED
   * endpoint's live /v1/models (stored key — never sent from here) and merges
   * it into the row. The card list is reloaded from the server response so the
   * chips (new · retired) reflect what was persisted.
   */
  const runSync = async (ep: ModelEndpoint) => {
    setSyncingId(ep.id);
    try {
      const result = await modelEndpointsApi.refresh(ep.id);
      // Review F2: replace the whole card object, not just models — the
      // server's summary also recomputes frontierModelIds (and any other
      // derived field) from the new list; a stale chip is worse than none.
      const { sync, ...fresh } = result;
      setEndpoints(prev => prev.map(e => e.id === ep.id ? { ...e, ...fresh } : e));
      const parts: string[] = [];
      if (sync.added.length) parts.push(`${sync.added.length} added`);
      if (sync.retired.length) parts.push(`${sync.retired.length} retired`);
      if (sync.backButKeptRetired.length) parts.push(`${sync.backButKeptRetired.length} back on the server but kept retired (un-retire by hand)`);
      const summary = parts.length ? parts.join(', ') : 'already in sync';
      toast.success(`${ep.label}: ${summary} — server lists ${sync.unchanged.length + sync.added.length + sync.backButKeptRetired.length} model(s)`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Sync failed');
    } finally {
      setSyncingId(null);
    }
  };

  /** Per-model PARSE battery — proves a served model parses before it is
   *  seated as a fallback (the endpoint-wide Test only probes connectivity). */
  const runVerify = async (endpointId: string, modelId: string) => {
    const key = `${endpointId}:${modelId}`;
    setVerifyingKey(key);
    setVerifyResults(prev => { const { [key]: _gone, ...rest } = prev; return rest; });
    try {
      const result = await modelEndpointsApi.verify(endpointId, modelId);
      setVerifyResults(prev => ({ ...prev, [key]: result }));
      const failCount = result.results.filter(r => !r.ok).length;
      if (failCount === 0) toast.success(`${modelId}: all 4 shapes parse OK`);
      else toast.error(`${modelId}: ${failCount}/4 shapes failed — see details`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Verify failed');
    } finally {
      setVerifyingKey(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await modelEndpointsApi.remove(deleteTarget.id);
      setEndpoints(prev => prev.filter(e => e.id !== deleteTarget.id));
      toast.success(`Deleted "${deleteTarget.label}"`);
    } catch {
      toast.error('Failed to delete endpoint');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Model endpoints</h3>
          <p className="text-xs text-muted-foreground mt-0.5 break-words">
            Point Digby at any OpenAI-compatible server (Ollama, vLLM, LM Studio, OpenRouter, a LiteLLM proxy) — or a TypeSafe-compatible decision server (TypeSafe Jev, or a self-hosted Laya / JevK5 / NeoHorse-Jev / openjev) for the Decision gate seat. Any chat-capable model (kind: chat) appears in Account → Coding and the chat / agent seats as &quot;label:model-id&quot;; Detect capabilities fills in the limits (max tools, reasoning-effort support, vision…) with evidence.
          </p>
        </div>
        <Button size="sm" onClick={() => openDraft(EMPTY_DRAFT)} className="shrink-0">
          <Plus className="size-3.5 mr-1" /> Add endpoint
        </Button>
      </div>

      {endpoints.length === 0 && (
        <div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
          No custom endpoints yet — built-in providers are used for everything.
        </div>
      )}

      <div className="space-y-2">
        {endpoints.map(ep => {
          const test = testResults[ep.id];
          return (
            <div key={ep.id} className={cn('rounded-xl border p-3 min-w-0', !ep.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <Cable className="size-4 text-brand-accent shrink-0" />
                <span className="text-sm font-medium">{ep.label}</span>
                {ep.hasApiKey && <Badge variant="secondary" className="text-[10px]">key</Badge>}
                {!ep.enabled && <Badge variant="secondary" className="text-[10px]">disabled</Badge>}
                {ep.settings?.maxTools ? <Badge variant="secondary" className="text-[10px]" title="Endpoint default tool cap (models without their own)">≤{ep.settings.maxTools} tools</Badge> : null}
                {(ep.providerClass === 'frontier' || (ep.frontierModelIds?.length ?? 0) > 0) && (
                  <Badge variant="destructive" className="text-[10px]" title={ep.providerClass === 'frontier'
                    ? 'This host is a frontier vendor\'s API — every model here is frontier-class. Digby\'s own lineup is open-model only (2026-09-22); seating one of these on a chat or supervisor seat is badged and recorded (observe-only), and refused only when FRONTIER_SEATS_REFUSE=1 is set.'
                    : `Frontier-class model id(s) listed here: ${(ep.frontierModelIds ?? []).join(', ')}. Seating one on a chat or supervisor seat is badged and recorded (observe-only), and refused only when FRONTIER_SEATS_REFUSE=1 is set; the open ids are unaffected.`}>
                    {ep.providerClass === 'frontier' ? 'frontier host' : 'frontier models'}
                  </Badge>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => runTest(ep)}
                  disabled={testingId === ep.id}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  title={ep.providerShape === 'systemone'
                    ? 'Test connectivity (GET /models — a 404 is tolerated when models are listed here — then one typed decision through POST /systemone; checks the answer parses, not calibration)'
                    : ep.providerShape === 'systemone_chat'
                      ? 'Test connectivity (GET /models must answer, then one typed decision through POST /chat/completions on the first listed model; checks the answer parses, not calibration)'
                      : 'Test connectivity (GET /models, then a 1-token POST /chat/completions auth probe when a key is set). Typed-decision models — flagged [typed decisions], kind "decision", or a decision id like agx-laya — are probed with a typed decision here too (a plain chat probe is the wrong shape for them and is never a failure by itself); a model that answers the chat probe with its typed-decision usage guide is re-probed with the decision shape.'}
                >
                  {testingId === ep.id ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                  Test
                </button>
                <button
                  onClick={() => runSync(ep)}
                  disabled={syncingId === ep.id}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  title="Sync model list (ticket 780cd7a4): re-pull the server's live /v1/models and merge it into this endpoint — new ids are added, ids the server no longer serves are marked retired (they stop resolving; seats fall back to their built-in), every other flag is preserved and nothing is deleted. A server that went DARK entirely (every model vanished) is refused — edit the endpoint instead."
                >
                  {syncingId === ep.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  Sync
                </button>
                <button onClick={() => openEdit(ep)} className="text-muted-foreground hover:text-foreground transition-colors" title="Edit">
                  <Pencil className="size-3.5" />
                </button>
                <button onClick={() => setDeleteTarget(ep)} className="text-muted-foreground hover:text-destructive transition-colors" title="Delete">
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1 font-mono break-all">{ep.baseUrl}</p>
              <div className="flex flex-wrap gap-1 mt-2">
                {ep.models.map(m => {
                  const vKey = `${ep.id}:${m.id}`;
                  const kind = modelKindOf(m);
                  return (
                    <span key={m.id} className="inline-flex items-center gap-0.5 max-w-full">
                      <Badge variant="outline" className="text-[10px] font-mono max-w-full whitespace-normal break-all">
                        {m.displayName || m.id}
                        {kind !== 'chat' && ` · ${kind}`}
                        {m.vision && ' · vision'}
                        {m.image && ' · image'}
                        {m.image && m.imageTimeoutMs ? ` · timeout ${Math.round(m.imageTimeoutMs / 1000)}s` : ''}
                        {m.matryoshka && ' · MRL'}
                        {m.thinking === 'off' && ' · no-think'}
                        {m.calibrated && ' · calibrated'}
                        {m.unservable === true && ' · retired'}
                        {m.decision === 'systemone_chat' && ' · typed decisions'}
                        {m.maxStateChars ? ` · ≤${m.maxStateChars} state chars` : ''}
                        {m.maxTools ? ` · ≤${m.maxTools} tools` : ''}
                        {m.reasoningEffort && m.reasoningEffort !== 'auto' ? ` · effort ${m.reasoningEffort}` : ''}
                        {m.contextWindow ? ` · ctx ${m.contextWindow}` : ''}
                        {m.capabilities?.detectedAt ? ' · detected' : ''}
                        {(ep.frontierModelIds ?? []).includes(m.id) && ' · frontier'}
                      </Badge>
                      <button
                        onClick={() => runVerify(ep.id, m.id)}
                        disabled={verifyingKey === vKey}
                        className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        title="Verify parsing (chat stream, utility, embeddings, rerank)"
                      >
                        {verifyingKey === vKey ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
                      </button>
                    </span>
                  );
                })}
              </div>
              {ep.models.map(m => {
                const vKey = `${ep.id}:${m.id}`;
                const vr = verifyResults[vKey];
                if (!vr) return null;
                return (
                  <div key={`verify-${vKey}`} className="mt-2 rounded-md border p-2 space-y-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="size-3 text-brand-accent shrink-0" />
                      <span className="text-[11px] font-mono break-all">{vr.model}</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => setVerifyResults(prev => { const { [vKey]: _gone, ...rest } = prev; return rest; })}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        title="Dismiss"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                    {vr.results.map(r => (
                      <div key={r.shape} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                        {r.ok
                          ? <Check className="size-3 shrink-0 self-center text-success" />
                          : <X className="size-3 shrink-0 self-center text-destructive" />}
                        <span>{VERIFY_SHAPE_LABELS[r.shape]}</span>
                        <span className="text-muted-foreground">({(r.latencyMs / 1000).toFixed(1)}s)</span>
                        {(r.ok ? r.detail : r.error) && (
                          <span className={cn('text-[11px] break-all', r.ok ? 'text-muted-foreground' : 'text-destructive')}>
                            {r.ok ? r.detail : r.error}
                          </span>
                        )}
                      </div>
                    ))}
                    <p className="text-[11px] text-muted-foreground">
                      A chat model needs Streaming chat + Utility green; Embeddings/Rerank red is expected on chat-only models.
                    </p>
                  </div>
                );
              })}
              {test && (
                <p className={cn('flex items-center gap-1 text-xs mt-2 break-words', test.ok ? 'text-success' : 'text-destructive')}>
                  {test.ok ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
                  {test.ok
                    ? `Connected — ${test.models?.length ?? 0} model(s) reported by the server${completionAuthNote(test)}`
                    : (test.error || 'Connection failed')}
                  {test.ok && test.detail && (
                    <span className="text-[11px] text-muted-foreground break-all"> — {test.detail}</span>
                  )}
                </p>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => toggleEnabled(ep)}
                  className={cn(
                    'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                    ep.enabled ? 'bg-brand-accent' : 'bg-muted-foreground/30',
                  )}
                  title={ep.enabled ? 'Disable' : 'Enable'}
                >
                  <span className={cn('inline-block size-4 transform rounded-full bg-white transition-transform', ep.enabled ? 'translate-x-4' : 'translate-x-0.5')} />
                </button>
                <span className="text-[11px] text-muted-foreground">{ep.enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add / edit dialog */}
      <Dialog open={!!draft} onOpenChange={(open) => !open && openDraft(null)}>
        <DialogContent className={ENDPOINT_DIALOG_CONTENT_CLASS}>
          <DialogHeader className="min-w-0">
            <DialogTitle>{draft?.id ? 'Edit endpoint' : 'Add endpoint'}</DialogTitle>
            <DialogDescription className="break-words">
              {draft?.providerShape === 'systemone'
                ? 'A TypeSafe-compatible decision server (POST <base URL>/systemone): TypeSafe Jev (https://api.typesafe.ai/v1) or a self-hosted open-weight server — Laya (laya-serve, http://host:8000/v1; model ids english / multilingual / typed-decisions; 512-token context, set max state chars ≈ 1200), openjev (vLLM; CC BY-NC 4.0 — non-commercial testing only), JevK5 (jevk5-serve --port 8090, http://host:8090/v1) or NeoHorse-Jev (neohorse-decision serve --port 8080). Test = GET /models (a 404 is tolerated when models are listed below) then one typed noul + choice through POST /systemone — it checks the answer parses, not that it is calibrated; flag a model [calibrated] only when its probabilities are. Assignable to the Decision gate seat only (as its model, fallback, or a per-purpose primary / challenger).'
                : draft?.providerShape === 'systemone_chat'
                  ? 'A proxy that serves ONLY typed-decision models through POST <base URL>/chat/completions with a questions map — LiteLLM fronting Laya (https://llm.cql.ca/v1, model id agx-laya): the request is { model, messages:[{ role:"user", content:<state> }], questions } and the answers come back as a JSON envelope in the message content. Set max state chars ≈ 3800 on each model (the proxy silently truncates the state at 1,024 input tokens). Test = GET /models (must answer; the first listed model below is probed) then one typed noul + choice through the chat route — it checks the answer parses, not that it is calibrated. If the same proxy ALSO serves chat models (the usual LiteLLM case), register it as an OpenAI-compatible chat endpoint instead and flag the decision model [typed decisions] — that is the documented way. Assignable to the Decision gate seat only.'
                  : 'Any OpenAI-compatible /chat/completions server. Base URL usually ends in /v1 (Ollama: http://host:11434/v1). OpenAI-like models accept at most 128 tools (Digby trims the long tail automatically) and custom endpoints never receive reasoning_effort unless a model is flagged effort: supported — OpenAI reasoning models behind LiteLLM reject reasoning_effort with tools on /chat/completions: add `reasoning_effort: none` under litellm_params for that model group, or route it via /v1/responses. A typed-decision model served by the same proxy (LiteLLM → Laya, e.g. agx-laya on llm.cql.ca) gets the [typed decisions] flag + max state chars ≈ 3800 below; the Decision gate then reaches it through the chat route.'}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3 min-w-0">
              <div>
                <Label htmlFor="me-label">Label</Label>
                <Input
                  id="me-label"
                  value={draft.label}
                  onChange={e => setDraft({ ...draft, label: e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') })}
                  placeholder="my-ollama"
                />
                <p className="text-[11px] text-muted-foreground mt-1 break-words">Lowercase letters, digits, dashes (auto-formatted as you type). Models are addressed as label:model-id.</p>
              </div>
              <div>
                <Label htmlFor="me-shape">Server type</Label>
                <select
                  id="me-shape"
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={draft.providerShape}
                  // Round-trips all three shapes (the old handler folded systemone_chat back to openai_chat, so "Typed-decision proxy" never stuck).
                  onChange={e => setDraft({ ...draft, providerShape: e.target.value === 'systemone' ? 'systemone' : e.target.value === 'systemone_chat' ? 'systemone_chat' : 'openai_chat' })}
                >
                  <option value="openai_chat">OpenAI-compatible chat (/chat/completions)</option>
                  <option value="systemone">Decision model (TypeSafe-compatible /systemone)</option>
                  <option value="systemone_chat">Typed-decision proxy (LiteLLM /chat/completions + questions — decision models only)</option>
                </select>
              </div>
              <div>
                <Label htmlFor="me-url">Base URL</Label>
                <Input
                  id="me-url"
                  value={draft.baseUrl}
                  onChange={e => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder={draft.providerShape === 'systemone' ? 'https://api.typesafe.ai/v1' : draft.providerShape === 'systemone_chat' ? 'https://llm.cql.ca/v1' : 'http://192.168.1.50:11434/v1'}
                />
              </div>
              <div>
                <Label htmlFor="me-key">API key {draft.id && '(leave blank to keep the stored key)'}</Label>
                <Input
                  id="me-key"
                  type="password"
                  value={draft.apiKey}
                  onChange={e => setDraft({ ...draft, apiKey: e.target.value, clearKey: false })}
                  placeholder={draft.id ? '•••• (unchanged)' : 'optional — leave blank for no auth'}
                  autoComplete="new-password"
                />
                {draft.id && (
                  <label className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={draft.clearKey}
                      onChange={e => setDraft({ ...draft, clearKey: e.target.checked, apiKey: '' })}
                    />
                    Clear the stored key (no auth header)
                  </label>
                )}
              </div>
              {draft.providerShape === 'openai_chat' && (
                <div>
                  <Label htmlFor="me-max-tools">Max tools (endpoint default)</Label>
                  <Input
                    id="me-max-tools"
                    type="number"
                    min={1}
                    step={1}
                    value={draft.settings.maxTools ?? ''}
                    onChange={e => setDraft({ ...draft, settings: { ...draft.settings, maxTools: positiveIntOrUndefined(e.target.value) } })}
                    placeholder="blank = per model / provider class (OpenAI-like ids: 128)"
                    className="font-mono"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1 break-words">The largest tools array every model on this endpoint accepts unless the model sets its own max tools. Digby trims its tool list to the cap (core + doctrine tools first) instead of getting a 400.</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="me-usd-in">Price — $ per 1M input tokens (endpoint default)</Label>
                  <Input
                    id="me-usd-in"
                    type="number"
                    min={0}
                    step="any"
                    value={draft.settings.usdPerMTokIn ?? ''}
                    onChange={e => setDraft({ ...draft, settings: { ...draft.settings, usdPerMTokIn: priceOrUndefined(e.target.value) } })}
                    placeholder="blank = self-hosted ($0, badged)"
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label htmlFor="me-usd-out">Price — $ per 1M output tokens (endpoint default)</Label>
                  <Input
                    id="me-usd-out"
                    type="number"
                    min={0}
                    step="any"
                    value={draft.settings.usdPerMTokOut ?? ''}
                    onChange={e => setDraft({ ...draft, settings: { ...draft.settings, usdPerMTokOut: priceOrUndefined(e.target.value) } })}
                    placeholder="blank = self-hosted ($0, badged)"
                    className="font-mono"
                  />
                </div>
                <p className="col-span-2 text-[11px] text-muted-foreground break-words">What every model on this endpoint bills at unless the model sets its own price. Today the decision gate's spend rows read it (Account → Admin → API costs); a self-hosted endpoint with no price shows $0 with a "self-hosted" badge, never a guessed list price.</p>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label>Models</Label>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={fetchModels}
                      disabled={fetching || !draft.baseUrl.trim()}
                      className="flex items-center gap-1 text-xs text-brand-text hover:underline disabled:opacity-50 disabled:no-underline"
                      title="GET <baseUrl>/models and merge what the server reports"
                    >
                      {fetching ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                      Fetch from server
                    </button>
                    <button
                      type="button"
                      onClick={() => runDetect()}
                      disabled={!draft.id || detecting !== null || draft.models.length === 0}
                      data-testid="detect-capabilities"
                      className="flex items-center gap-1 text-xs text-brand-text hover:underline disabled:opacity-50 disabled:no-underline"
                      title={draft.id
                        ? 'Probe every model (≤4 at a time, ~20 s per probe): chat streaming shape, tool calling, max tools, reasoning_effort, thinking-by-default, vision, embeddings dims, rerank, typed decisions, image generation (image ids only), context window — and set the flags with evidence. Flags you set by hand are kept.'
                        : 'Save the endpoint first — detection probes the saved endpoint with its stored key'}
                    >
                      {detecting === '*' ? <Loader2 className="size-3 animate-spin" /> : <Radar className="size-3" />}
                      Detect capabilities
                    </button>
                  </div>
                </div>
                {detecting && (
                  <p className="flex items-center gap-1 text-[11px] text-muted-foreground mt-1" data-testid="detecting-note">
                    <Loader2 className="size-3 animate-spin shrink-0" />
                    Detecting{detecting !== '*' ? ` ${detecting}` : ''}… (≤4 models at a time, ~20 s per probe)
                  </p>
                )}
                {fetchMsg && (
                  <p className={cn('flex items-center gap-1 text-[11px] mt-1 break-words', fetchMsg.ok ? 'text-success' : 'text-destructive')}>
                    {fetchMsg.ok ? <Check className="size-3 shrink-0" /> : <X className="size-3 shrink-0" />}
                    {fetchMsg.text}
                  </p>
                )}
                {draft.models.length > 0 ? (
                  <div className="mt-1 rounded-md border divide-y min-w-0" data-testid="model-list">
                    {draft.models.map((m, i) => (
                      <div key={m.id} className={MODEL_ROW_CLASS} data-testid="model-row">
                        <span className="flex-1 min-w-0 break-all font-mono text-xs" title={m.id}>
                          {m.displayName ? <span className="text-muted-foreground">{m.displayName} · </span> : null}
                          {m.id}
                          {modelKindOf(m) !== 'chat' && <span className="text-muted-foreground"> · {modelKindOf(m)}</span>}
                        </span>
                        <span className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => runDetect(m.id)}
                            disabled={!draft.id || detecting !== null}
                            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                            title={draft.id ? `Detect this model's capabilities (~20 s per probe)` : 'Save the endpoint first'}
                          >
                            {detecting === m.id ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
                          </button>
                          <button type="button" onClick={() => removeModel(i)} className="text-muted-foreground hover:text-destructive transition-colors" title="Remove">
                            <X className="size-3.5" />
                          </button>
                        </span>
                        <ModelFlagChips chips={modelChips(m, i)} />
                        {draft.providerShape === 'openai_chat' && (
                          <ModelLimitControls m={m} onChange={(patch, flag) => setLimit(i, patch, flag)} />
                        )}
                        {(draft.providerShape === 'systemone' || draft.providerShape === 'systemone_chat' || m.decision === 'systemone_chat' || m.maxStateChars !== undefined) && (
                          <input
                            type="number"
                            min={1}
                            step={100}
                            value={m.maxStateChars ?? ''}
                            onChange={e => setMaxStateChars(i, e.target.value)}
                            placeholder="max state chars"
                            aria-label={`${m.id} max state chars`}
                            title="Decision backends: the gate truncates the STATE to this many characters for this model (stamped meta.stateTruncated). Laya's 512-token context ≈ 1200; Laya behind LiteLLM (agx-laya) cuts at 1,024 input tokens ≈ 3800; JevK5 / openjev / NeoHorse take 16k tokens — leave blank for no cap."
                            className="h-6 w-28 rounded-md border bg-background px-1.5 text-[10px] font-mono"
                          />
                        )}
                        {m.image === true && (
                          <label className="flex items-center gap-1" title="Per-request wait for this model's image generation (30 s – 720 s; default 120 s; slow local backends need 300 000 – 600 000). A value here wins over the instance IMAGE_CUSTOM_TIMEOUT_MS env, raises the Image generator seat's whole-call budget with it, and makes the seat's Test button probe at this raised budget.">
                            <span className="text-muted-foreground">image timeout (ms)</span>
                            <input
                              type="number"
                              min={30000}
                              step={10000}
                              value={m.imageTimeoutMs ?? ''}
                              onChange={e => setImageTimeoutMs(i, e.target.value)}
                              placeholder="120000"
                              aria-label={`${m.id} image timeout ms`}
                              className="h-6 w-28 rounded-md border bg-background px-1.5 text-[10px] font-mono"
                            />
                          </label>
                        )}
                        {reports[m.id] && (
                          <DetectReportTable
                            report={reports[m.id]}
                            open={!!openReports[m.id]}
                            onToggle={() => setOpenReports(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 rounded-md border border-dashed px-3 py-3 text-center text-[11px] text-muted-foreground">
                    No models yet — fetch from the server or add one manually.
                  </p>
                )}
                <div className="flex gap-1.5 mt-1.5">
                  <Input
                    value={newModelId}
                    onChange={e => setNewModelId(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
                    placeholder="Add a model id manually (e.g. qwen3:32b)"
                    className="h-8 text-xs font-mono min-w-0"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addManual} disabled={!newModelId.trim()} className="shrink-0 h-8">
                    Add
                  </Button>
                </div>
                <EndpointDialogLegend />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" onClick={() => openDraft(null)}>Cancel</Button>
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving && <Loader2 className="size-3.5 animate-spin mr-1" />}
                  {draft.id ? 'Save changes' : 'Add endpoint'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteTarget?.label}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Sessions using its models fall back to the default built-in model. The stored API key is destroyed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-3.5 animate-spin mr-1" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
