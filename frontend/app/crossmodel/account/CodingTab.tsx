'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { displayModelId } from '@/lib/model-alias';
import { preferencesApi } from '@/lib/api/crossmodel';
import { codingApi, CodingCredentialSummary, DevContainerStatus } from '@/lib/api/coding';
import { devContainerPanelView } from '@/lib/dev-container-panel';
import { modelEndpointsApi, isChatCapableModel } from '@/lib/api/model-endpoints';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { FleetNoticeSection } from './FleetNoticeSection';
import { Check, Cpu, Loader2, ShieldCheck, ClipboardList, MessageCircleQuestion, KeyRound, Plus, Trash2, Container, RefreshCw, PlugZap } from 'lucide-react';

type PermissionMode = 'auto' | 'plan' | 'ask';

/** Picker entry — built-ins plus Digby Edge registry models ('<label>:<modelId>'). */
interface ModelOption { id: string; name: string; blurb: string }

// Provider presets: the env vars each provider's CLI/API expects. Every field
// becomes ONE stored credential; the session shell gets them all as env vars.
const CRED_PRESETS: { id: string; name: string; blurb: string; fields: { envKey: string; label: string; required?: boolean }[] }[] = [
  { id: 'cloudflare', name: 'Cloudflare', blurb: 'wrangler + API', fields: [
    { envKey: 'CLOUDFLARE_API_TOKEN', label: 'API token', required: true },
    { envKey: 'CLOUDFLARE_ACCOUNT_ID', label: 'Account ID' },
  ] },
  { id: 'aws', name: 'AWS', blurb: 'aws CLI + SDKs', fields: [
    { envKey: 'AWS_ACCESS_KEY_ID', label: 'Access key ID', required: true },
    { envKey: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key', required: true },
    { envKey: 'AWS_DEFAULT_REGION', label: 'Default region (e.g. us-east-1)' },
  ] },
  { id: 'namecheap', name: 'Namecheap', blurb: 'domains API', fields: [
    { envKey: 'NAMECHEAP_API_USER', label: 'API user', required: true },
    { envKey: 'NAMECHEAP_API_KEY', label: 'API key', required: true },
    { envKey: 'NAMECHEAP_USERNAME', label: 'Username' },
    { envKey: 'NAMECHEAP_CLIENT_IP', label: 'Whitelisted client IP' },
  ] },
  { id: 'brev', name: 'Brev', blurb: 'NVIDIA Brev GPU envs', fields: [
    { envKey: 'BREV_API_TOKEN', label: 'API token', required: true },
  ] },
  { id: 'custom', name: 'Custom', blurb: 'any env var', fields: [] },
];

// OPEN-SOURCE models only — Digby Code never uses closed/frontier agents.
// Owner 2026-09-15: the old persona names ("The Professor"/"The Logician")
// belonged to SEATS of the chat ensemble, not to these coding engines — a
// re-seated instance made them lie (glm-5.3 as "The Professor" while it ran
// the Digby seat). This picker chooses an ENGINE for your own workspace
// sessions, so it names the engine plainly; ids stay technical.
const MODELS: ModelOption[] = [
  { id: 'glm-5.3',         name: 'GLM-5.3',              blurb: 'Default. Methodical pair-programmer — strong agentic coding + tool use, thinking-max.' },
  { id: 'deepseek-flash',  name: 'DeepSeek V4.1 Flash',  blurb: 'Deep reasoning, 1M context, sees images natively.' },
  { id: 'kimi-k3',         name: 'Kimi K3',              blurb: '1M context, always-on reasoning, strong tool loops (the chat lead\'s default engine).' },
];

const MODES: { id: PermissionMode; name: string; blurb: string; icon: React.ElementType }[] = [
  { id: 'auto', name: 'Auto (bypass)', blurb: 'Edit files and run commands without asking. Fastest, most autonomous.', icon: ShieldCheck },
  { id: 'plan', name: 'Plan',          blurb: 'Read-only: investigates and proposes a plan; makes no changes until you switch.', icon: ClipboardList },
  { id: 'ask',  name: 'Ask',           blurb: 'Approve each file change and command before it runs. Safest.', icon: MessageCircleQuestion },
];

export function CodingTab({ isAdmin = false }: { isAdmin?: boolean } = {}) {
  const [model, setModel] = useState<string>('glm-5.3');
  // Seats govern sessions (2026-09-28): a stored coding model counts as YOUR pick only when
  // you chose it yourself (the backend's explicit marker); otherwise your sessions follow
  // the admin's Workspace default seat and the picker is folded behind "Choose my own".
  const [modelExplicit, setModelExplicit] = useState<boolean>(true); // pre-load placeholder (a pre-change backend omits the flag → picker shown)
  const [seatModel, setSeatModel] = useState<string>('');
  const [choosingOwn, setChoosingOwn] = useState(false);
  const [mode, setMode] = useState<PermissionMode>('auto'); // pre-load placeholder — matches the platform default (flipped 'ask'→'auto' 2026-09-17)
  const [loading, setLoading] = useState(true);
  // Per-section error + retry flags: a failed fetch degrades only the sections
  // it feeds (inline LoadErrorState + Retry) instead of blocking the whole tab.
  const [settingsError, setSettingsError] = useState(false);
  const [settingsRetrying, setSettingsRetrying] = useState(false);
  const [credsError, setCredsError] = useState(false);
  const [credsRetrying, setCredsRetrying] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  // Digby Edge registry models ([coding]-flagged) — ADMIN-only: the list
  // endpoint 403s for everyone else and the catch below keeps the picker
  // built-in-only.
  const [registryModels, setRegistryModels] = useState<ModelOption[]>([]);
  // ── Credentials state ──
  const [creds, setCreds] = useState<CodingCredentialSummary[]>([]);
  const [presetId, setPresetId] = useState<string>('cloudflare');
  // Shared tailnet dev container (ticket 3ba5d35d)
  const [dc, setDc] = useState<DevContainerStatus | null>(null);
  // Status-fetch failure — a genuinely-disabled container is a real payload
  // (enabled:false), so dc===null after a failed fetch must not silently hide
  // the status panel as if there were nothing to report.
  const [dcError, setDcError] = useState(false);
  const [dcRetrying, setDcRetrying] = useState(false);
  const [dcEnabled, setDcEnabled] = useState(false); // from PREFS — the toggle's source of truth (status endpoint failing must not lock the toggle)
  const [dcKey, setDcKey] = useState('');
  const [dcBusy, setDcBusy] = useState<string | null>(null);
  const [dcEgressDraft, setDcEgressDraft] = useState<string | null>(null); // null = not loaded yet
  const [dcEgressSaving, setDcEgressSaving] = useState(false);
  const [credDraft, setCredDraft] = useState<Record<string, string>>({});
  const [customKey, setCustomKey] = useState('');
  const [customValue, setCustomValue] = useState('');
  const [credLabel, setCredLabel] = useState('');
  const [credSaving, setCredSaving] = useState(false);

  const loadPrefs = () => {
    setSettingsError(false);
    setSettingsRetrying(true);
    preferencesApi.get()
      .then(p => {
        // Legacy aliases (lib/model-alias.ts): prefs stored as kimi-k2.6
        // (pre-K3 switch) select Kimi K3; prefs stored as glm-5.2 (pre-GLM-5.3
        // cutover, 2026-09-03) select GLM-5.3.
        if (p.codingModel) setModel(displayModelId(p.codingModel as string));
        // A pre-change backend omits codingModelExplicit → keep the picker visible.
        setModelExplicit(p.codingModelExplicit === undefined ? true : p.codingModelExplicit === true);
        setSeatModel(typeof p.codingSeatModel === 'string' ? displayModelId(p.codingSeatModel) : '');
        setChoosingOwn(false);
        if (p.codingPermissionMode) setMode(p.codingPermissionMode);
        setDcEnabled(p.devContainerEnabled === true);
      })
      // Honest failure — rendering the defaults over an errored fetch would
      // show (and let the user "re-save") settings that aren't theirs.
      .catch(() => setSettingsError(true))
      // The full-tab spinner covers only the first load (`loading` starts
      // true and is never re-armed); retries stay inline via settingsRetrying.
      .finally(() => { setLoading(false); setSettingsRetrying(false); });
  };

  const loadCreds = () => {
    setCredsError(false);
    setCredsRetrying(true);
    codingApi.listCredentials()
      .then(setCreds)
      .catch(() => setCredsError(true))
      .finally(() => setCredsRetrying(false));
  };

  // Best-effort — a failure flags only the status sub-panel (with retry),
  // never blocks the tab.
  const loadDcStatus = () => {
    setDcError(false);
    setDcRetrying(true);
    codingApi.devContainerStatus()
      .then(setDc)
      .catch(() => { setDc(null); setDcError(true); })
      .finally(() => setDcRetrying(false));
  };

  // Initial load — each fetch degrades per-section below; the full-tab
  // spinner waits only on the settings fetch (inside loadPrefs).
  useEffect(() => {
    loadPrefs();
    loadCreds();
    loadDcStatus();
    // Per-session egress policy (ticket 4ed6eb2e): null → allow-all (empty draft).
    codingApi.tailnetEgressPolicy()
      .then(p => setDcEgressDraft(p.allow === null ? '' : p.allow.join('\n')))
      .catch(() => setDcEgressDraft(null));
  }, []);

  useEffect(() => {
    // Digby Edge: every CHAT-capable custom endpoint model joins the picker
    // (2026-09-27 — "coding is a seat choice, not a model capability"; the
    // legacy [coding] flag is only one way a model reads as chat-capable).
    // ADMIN-only endpoint: only admins ask (walkthrough 2026-10-06 — every
    // other account logged a 403 on each visit to this tab).
    if (!isAdmin) return;
    modelEndpointsApi.list()
      .then(eps => setRegistryModels(eps.filter(e => e.enabled).flatMap(e =>
        e.models.filter(m => isChatCapableModel(m)).map(m => ({
          id: `${e.label}:${m.id}`,
          name: m.displayName || m.id,
          blurb: `Custom endpoint · ${e.label}`,
        })),
      )))
      .catch(() => setRegistryModels([]));
  }, [isAdmin]);

  const saveCreds = async () => {
    const preset = CRED_PRESETS.find(p => p.id === presetId)!;
    const entries = presetId === 'custom'
      ? (customKey.trim() && customValue.trim() ? [{ envKey: customKey.trim().toUpperCase(), value: customValue }] : [])
      : preset.fields.map(f => ({ envKey: f.envKey, value: (credDraft[f.envKey] || '').trim() })).filter(e => e.value);
    if (!entries.length) { toast.error('Enter at least one value'); return; }
    const missing = presetId !== 'custom'
      ? preset.fields.filter(f => f.required && !(credDraft[f.envKey] || '').trim()) : [];
    if (missing.length) { toast.error(`Missing: ${missing.map(f => f.label).join(', ')}`); return; }
    setCredSaving(true);
    try {
      const label = credLabel.trim();
      let warned = false;
      for (const e of entries) {
        const saved = await codingApi.saveCredential(presetId, e.envKey, e.value, label || undefined);
        // All-caps anomaly (ticket 8a46847f): values are stored verbatim, so an
        // ALL-CAPS value was mangled at entry — surface the backend's warning
        // immediately instead of letting a dead secret reach session shells.
        // Toast ONCE per save batch (the text is static; one per entry would stack).
        if (saved.warning && !warned) { warned = true; toast.warning(saved.warning, { duration: 10000 }); }
      }
      setCreds(await codingApi.listCredentials());
      setCredDraft({}); setCustomKey(''); setCustomValue(''); setCredLabel('');
      toast.success(`${preset.name} credentials saved — new coding sessions can use them`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not save credential');
    } finally { setCredSaving(false); }
  };

  const removeCred = async (c: CodingCredentialSummary) => {
    try {
      await codingApi.deleteCredential(c.id);
      setCreds(prev => prev.filter(x => x.id !== c.id));
      toast.message(`${c.injectedKey || c.envKey} removed`);
      if (c.provider === 'tailscale') codingApi.devContainerStatus().then(setDc).catch(() => {});
    } catch { toast.error('Could not delete'); }
  };

  const toggleDevContainer = async (enabled: boolean) => {
    setDcBusy('toggle');
    try {
      await preferencesApi.updateCoding({ devContainerEnabled: enabled });
      setDcEnabled(enabled);
      setDc(prev => (prev ? { ...prev, enabled } : prev));
      toast.success(enabled
        ? 'Dev container enabled — new coding sessions will use it once it joins your tailnet'
        : 'Dev container disabled — sessions fall back to per-session containers');
      codingApi.devContainerStatus().then(setDc).catch(() => {});
    } catch { toast.error('Could not save'); }
    finally { setDcBusy(null); }
  };
  const saveDcKey = async () => {
    const v = dcKey.trim();
    if (!v) { toast.error('Paste a tailscale auth key (tskey-auth-…)'); return; }
    setDcBusy('key');
    try {
      await codingApi.saveCredential('tailscale', 'TS_AUTHKEY', v);
      setDcKey('');
      toast.success('Tailscale auth key saved (stored encrypted, never shown again)');
      codingApi.devContainerStatus().then(setDc).catch(() => {});
    } catch (err: any) { toast.error(err?.response?.data?.error || 'Could not save the key'); }
    finally { setDcBusy(null); }
  };
  // Restart / Reconnect run on the coding server in the background (2026-10-13):
  // the response is the status with the start note; a refusal (409) or "the
  // coding server didn't answer" (503) carries the reason + the latest status.
  const runDcAction = async (kind: 'restart' | 'reconnect') => {
    setDcBusy(kind);
    try {
      const s = kind === 'restart' ? await codingApi.devContainerRestart() : await codingApi.devContainerReconnect();
      setDc(s);
      toast.message(s.note || (kind === 'restart' ? 'Rebuilding the dev container…' : 'Reconnecting the tailnet…'));
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.data) setDc(data.data);
      toast.error(data?.error || (kind === 'restart' ? 'Restart failed' : 'Reconnect failed'));
    } finally { setDcBusy(null); }
  };
  const restartDc = () => runDcAction('restart');
  const reconnectDc = () => runDcAction('reconnect');
  // While an action runs on the coding server, poll its progress (≤ 6 min).
  const dcPollUntil = useRef(0);
  const dcActionRunning = dc?.action?.state === 'running';
  useEffect(() => {
    if (!dcActionRunning) { dcPollUntil.current = 0; return; }
    if (!dcPollUntil.current) dcPollUntil.current = Date.now() + 6 * 60_000;
    const t = setInterval(() => {
      if (Date.now() > dcPollUntil.current) { clearInterval(t); return; }
      codingApi.devContainerStatus().then(setDc).catch(() => {});
    }, 3_000);
    return () => clearInterval(t);
  }, [dcActionRunning]);
  // Per-session egress scoping (ticket 4ed6eb2e): one rule per line; blank
  // lines + '#'-comments ignored. Empty = allow-all (v1 reachability).
  const saveDcEgress = async () => {
    const rules = (dcEgressDraft ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    setDcEgressSaving(true);
    try {
      const r = await codingApi.saveTailnetEgressPolicy(rules.length ? rules : null);
      toast.success(r.allow === null
        ? 'Tailnet egress policy cleared — sessions may reach the whole tailnet (allow-all)'
        : `Tailnet egress policy saved — ${r.allow.length} rule${r.allow.length === 1 ? '' : 's'}${r.pushed ? ', live on the running container' : ' (applies on next container start)'}`);
      codingApi.devContainerStatus().then(setDc).catch(() => {});
    } catch (err: any) { toast.error(err?.response?.data?.error || 'Invalid policy'); }
    finally { setDcEgressSaving(false); }
  };

  const pickModel = async (m: string) => {
    if (m === model && modelExplicit) return;
    setSaving('model'); const prev = model; const prevExplicit = modelExplicit; setModel(m); setModelExplicit(true);
    try { await preferencesApi.updateCoding({ codingModel: m }); toast.success(`Coding model set to ${m} — your own pick; new sessions use it`); setChoosingOwn(false); }
    catch { setModel(prev); setModelExplicit(prevExplicit); toast.error('Could not save'); }
    finally { setSaving(null); }
  };
  // Seats govern sessions (2026-09-28): '' clears the personal pick — the admin's Workspace
  // default seat governs this user's sessions again (existing ones on their next run too).
  const followSeat = async () => {
    setSaving('model'); const prevExplicit = modelExplicit; setModelExplicit(false); setChoosingOwn(false);
    try { await preferencesApi.updateCoding({ codingModel: '' }); toast.success(`Following the admin seat${seatModel ? ` (${seatModel})` : ''}`); }
    catch { setModelExplicit(prevExplicit); toast.error('Could not save'); }
    finally { setSaving(null); }
  };
  const pickMode = async (m: PermissionMode) => {
    if (m === mode) return;
    setSaving('mode'); const prev = mode; setMode(m);
    try { await preferencesApi.updateCoding({ codingPermissionMode: m }); toast.success(`Default permission mode: ${m}`); }
    catch { setMode(prev); toast.error('Could not save'); }
    finally { setSaving(null); }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <FleetNoticeSection />
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Cpu className="size-4 text-brand-accent" />
          <h3 className="text-sm font-semibold">Coding model</h3>
          {saving === 'model' && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-3">Digby Code uses open-source models only. Your sessions follow the admin&apos;s Workspace default seat unless you choose your own model here.</p>
        {settingsError ? (
          <LoadErrorState message="Couldn't load your coding settings." onRetry={loadPrefs} retrying={settingsRetrying} className="py-6" />
        ) : (
        <div className="space-y-2">
          {!modelExplicit && (
            <div className="rounded-xl border border-brand-accent bg-brand-soft p-3" data-testid="coding-model-following-seat">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Following the admin seat{seatModel ? ` (${seatModel})` : ''}</span>
                <Check className="size-4 text-brand-text shrink-0" />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Your coding sessions run whatever Account → Admin → Endpoints → Model roles sets as the Workspace default — existing sessions pick it up on their next run.</p>
              {!choosingOwn && (
                <button type="button" onClick={() => setChoosingOwn(true)} className="mt-2 text-xs text-brand-text hover:underline" data-testid="coding-model-choose-own">
                  Choose my own
                </button>
              )}
            </div>
          )}
          {modelExplicit && (
            <button type="button" onClick={followSeat} className="text-xs text-brand-text hover:underline" data-testid="coding-model-follow-seat">
              Use the workspace default instead{seatModel ? ` (${seatModel})` : ''}
            </button>
          )}
          {(modelExplicit || choosingOwn) && MODELS.map(m => (
            <button
              key={m.id}
              onClick={() => pickModel(m.id)}
              className={cn(
                'w-full text-left rounded-xl border p-3 transition-colors',
                modelExplicit && model === m.id ? 'border-brand-accent bg-brand-soft' : 'border-border hover:border-muted-foreground/40',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{m.name}</span>
                {modelExplicit && model === m.id && <Check className="size-4 text-brand-text" />}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{m.blurb}</p>
            </button>
          ))}
          {(modelExplicit || choosingOwn) && registryModels.length > 0 && (
            <>
              <p className="text-[11px] text-muted-foreground pt-2">Custom endpoints (Digby Edge)</p>
              {registryModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => pickModel(m.id)}
                  className={cn(
                    'w-full text-left rounded-xl border p-3 transition-colors',
                    modelExplicit && model === m.id ? 'border-brand-accent bg-brand-soft' : 'border-border hover:border-muted-foreground/40',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{m.name}</span>
                    {modelExplicit && model === m.id && <Check className="size-4 text-brand-text" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.blurb}</p>
                </button>
              ))}
            </>
          )}
        </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="size-4 text-brand-accent" />
          <h3 className="text-sm font-semibold">Default permission mode</h3>
          {saving === 'mode' && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-3">The starting mode for new sessions (changeable per session).</p>
        {settingsError ? (
          <LoadErrorState message="Couldn't load your coding settings." onRetry={loadPrefs} retrying={settingsRetrying} className="py-6" />
        ) : (
        <div className="space-y-2">
          {MODES.map(m => {
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                onClick={() => pickMode(m.id)}
                className={cn(
                  'w-full text-left rounded-xl border p-3 transition-colors flex items-start gap-3',
                  mode === m.id ? 'border-brand-accent bg-brand-soft' : 'border-border hover:border-muted-foreground/40',
                )}
              >
                <Icon className="size-4 mt-0.5 text-muted-foreground shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{m.name}</span>
                    {mode === m.id && <Check className="size-4 text-brand-text" />}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.blurb}</p>
                </div>
              </button>
            );
          })}
        </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="size-4 text-brand-accent" />
          <h3 className="text-sm font-semibold">CLI &amp; API credentials</h3>
          {credSaving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Injected as environment variables into every coding-session shell so the agent can use provider CLIs (wrangler, aws, brev…) as you.
          Values are encrypted, never shown again after saving, and scrubbed from transcripts. Store several credentials of the same provider by adding a label (a second Cloudflare token labeled WORK is injected as CLOUDFLARE_API_TOKEN_WORK).
        </p>

        {credsError && (
          <LoadErrorState message="Couldn't load your credentials." onRetry={loadCreds} retrying={credsRetrying} className="py-6" />
        )}
        {!credsError && creds.length > 0 && (
          <div className="space-y-1.5 mb-4">
            {creds.map(c => (
              <div key={c.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                <span className=" text-[12px] font-medium text-brand-text w-20 shrink-0">{c.provider}</span>
                <span className="font-mono flex-1 truncate">{c.injectedKey || c.envKey}</span>
                {c.label ? (
                  <span className="rounded bg-active px-1.5 py-0.5 text-[10px] font-semibold text-ink shrink-0">{c.label}</span>
                ) : null}
                {c.readable === false ? (
                  <span className="rounded bg-warn/10 dark:bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn-ink shrink-0"
                    title="The stored value can no longer be decrypted (platform secret rotated). It is skipped in session shells — delete and re-save this credential.">
                    unreadable — re-enter
                  </span>
                ) : null}
                {c.warning ? (
                  <span className="rounded bg-warn/10 dark:bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn-ink shrink-0"
                    title={c.warning}>
                    all-caps — check case
                  </span>
                ) : null}
                <span className="font-mono text-muted-foreground shrink-0">{c.preview}</span>
                <button onClick={() => removeCred(c)} title="Remove" className="p-1 rounded hover:bg-muted text-muted-foreground shrink-0"><Trash2 className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-border p-3 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {CRED_PRESETS.map(p => (
              <button key={p.id} onClick={() => setPresetId(p.id)}
                className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors',
                  presetId === p.id ? 'border-brand-accent bg-brand-soft font-medium' : 'border-border hover:border-muted-foreground/40')}
                title={p.blurb}>
                {p.name}
              </button>
            ))}
          </div>
          {presetId === 'custom' ? (
            <div className="space-y-2">
              <input value={customKey} onChange={e => setCustomKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="ENV_VAR_NAME" className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:border-brand-ring" />
              <input value={customValue} onChange={e => setCustomValue(e.target.value)} type="password" autoComplete="off"
                placeholder="Value" className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:border-brand-ring" />
            </div>
          ) : (
            <div className="space-y-2">
              {CRED_PRESETS.find(p => p.id === presetId)!.fields.map(f => (
                <div key={f.envKey}>
                  <label className="text-[11px] text-muted-foreground">{f.label}{f.required && ' *'} <span className="font-mono opacity-60">({f.envKey})</span></label>
                  <input value={credDraft[f.envKey] || ''} onChange={e => setCredDraft(d => ({ ...d, [f.envKey]: e.target.value }))}
                    type="password" autoComplete="off"
                    className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:border-brand-ring" />
                </div>
              ))}
            </div>
          )}
          <div>
            <input value={credLabel} onChange={e => setCredLabel(e.target.value.toUpperCase())}
              placeholder="Label (optional — e.g. WORK)"
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs font-mono outline-none focus:border-brand-ring" />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Empty = update your primary. A label stores an ADDITIONAL credential of the same type, injected as
              {' '}<span className="font-mono">{presetId === 'custom' ? (customKey || 'ENV_VAR_NAME') : (CRED_PRESETS.find(p => p.id === presetId)!.fields[0]?.envKey || 'ENV_VAR_NAME')}_LABEL</span> — nothing is overwritten.
            </p>
          </div>
          <button onClick={saveCreds} disabled={credSaving}
            className="flex items-center gap-1.5 text-xs bg-brand text-brand-foreground rounded-md px-3 py-1.5 disabled:opacity-40">
            <Plus className="size-3.5" /> Save credentials
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Container className="size-4 text-brand-accent" />
          <h3 className="text-sm font-semibold">Dev container (tailnet)</h3>
          {dcBusy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          One shared dev container that joins your tailnet — coding sessions ssh to your
          infrastructure directly (no SSM round-trips) and share tooling across sessions.
          If it can’t start or can’t join, sessions automatically fall back to per-session containers.
          Currently honored for admin accounts only (per-user isolation of the shared workspace is a follow-up).
        </p>
        <div className="space-y-2">
          <button
            onClick={() => toggleDevContainer(!dcEnabled)}
            disabled={dcBusy !== null}
            className={cn(
              'w-full text-left rounded-xl border p-3 transition-colors',
              dcEnabled ? 'border-brand-accent bg-brand-soft' : 'border-border hover:border-muted-foreground/40',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{dcEnabled ? 'Enabled' : 'Disabled'}</span>
              {dcEnabled && <Check className="size-4 text-brand-text" />}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {dcEnabled
                ? 'New coding-session commands run in your shared tailnet container.'
                : 'Click to enable. Requires a tailscale auth key below.'}
            </p>
          </button>

          {dcEnabled && (dcError ? (
            <LoadErrorState message="Couldn't load the dev container status." onRetry={loadDcStatus} retrying={dcRetrying} className="py-6" />
          ) : dc && (() => {
            const view = devContainerPanelView(dc);
            return (
            <div className="rounded-xl border border-border p-3 text-xs space-y-1" data-testid="dev-container-status">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-sm">Status</span>
                <div className="flex items-center gap-3">
                  <button onClick={reconnectDc} disabled={dcBusy !== null || !view.reconnectEnabled}
                    data-testid="dev-container-reconnect"
                    title="Rejoin your tailnet with the saved key — running work keeps going"
                    className={cn('flex items-center gap-1 text-xs disabled:opacity-40',
                      view.reconnectRecommended ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    <PlugZap className={cn('size-3', dcBusy === 'reconnect' && 'animate-pulse')} /> Reconnect
                  </button>
                  <button onClick={restartDc} disabled={dcBusy !== null || !view.restartEnabled}
                    data-testid="dev-container-restart"
                    title="Rebuild the container with the saved key — needs no coding run in progress"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">
                    <RefreshCw className={cn('size-3', dcBusy === 'restart' && 'animate-spin')} /> Restart
                  </button>
                </div>
              </div>
              <p className="text-muted-foreground">
                Container: <span className="font-mono">{dc.container}</span> — {view.containerState}
                {view.tailnetLine && <> · {view.tailnetLine}</>}
              </p>
              {view.actionMessage && (
                <p className={cn('flex items-center gap-1.5',
                  view.actionMessage.tone === 'success' && 'text-success',
                  view.actionMessage.tone === 'warn' && 'text-warn-ink',
                  view.actionMessage.tone === 'muted' && 'text-muted-foreground')}>
                  {view.actionRunning && <Loader2 className="size-3 animate-spin" />}{view.actionMessage.text}
                </p>
              )}
              {view.messages.map((m) => (
                <p key={m.text} className={cn(m.tone === 'warn' ? 'text-warn-ink' : m.tone === 'success' ? 'text-success' : 'text-muted-foreground')}>{m.text}</p>
              ))}
              {dc.egress && (
                <p className={cn(
                  dc.egress.mode === 'scoped' && 'text-success',
                  dc.egress.mode === 'degraded' && 'text-warn-ink',
                  (dc.egress.mode === 'legacy' || dc.egress.mode === 'off' || dc.egress.mode === 'unknown') && 'text-muted-foreground',
                )}>
                  Per-session egress: <span className="font-medium">{dc.egress.mode}</span>
                  {dc.egress.policyRules !== null && dc.egress.mode === 'scoped' && <> · {dc.egress.policyRules} default rule{dc.egress.policyRules === 1 ? '' : 's'}</>}
                  {dc.egress.mode === 'scoped' && dc.egress.policyRules === null && <> · allow-all default</>}
                  {dc.egress.note ? <> — {dc.egress.note}</> : null}
                </p>
              )}
              {view.showLoginLink && dc.tailscale?.loginUrl && (
                <p className="text-muted-foreground">
                  Without a key you can instead{' '}
                  <a href={dc.tailscale.loginUrl} target="_blank" rel="noreferrer" className="underline font-medium">
                    approve the node in your tailnet admin console
                  </a>
                  {' '}— then tag it there, or it joins with your personal permissions and expires. A saved tagged key is the better setup.
                </p>
              )}
              {dc.note && dc.reach !== 'unreachable' && dc.note !== view.actionMessage?.text && <p className="text-muted-foreground">{dc.note}</p>}
              <p className="text-muted-foreground">
                Inside sessions, reach tailnet hosts with the baked-in helpers <span className="font-mono">tssh host</span> and{' '}
                <span className="font-mono">tcurl url</span> (SOCKS5 via localhost:1055 — no hand-written ProxyCommand).
                For anything else, opt in per command via <span className="font-mono">$DIGBY_TAILNET_PROXY</span>
                {' '}(e.g. <span className="font-mono">ALL_PROXY=$DIGBY_TAILNET_PROXY curl …</span>).
              </p>
            </div>
            );
          })())}

          <div className="rounded-xl border border-border p-3">
            <p className="text-xs text-muted-foreground mb-2">
              Tailscale auth key (from your tailnet admin console — use a tagged, reusable key).
              Stored encrypted, write-only{dc?.keyConfigured ? ' — a key is currently configured' : ''}.
              {dc?.keyConfigured ? ' After saving a new key, press Reconnect to use it.' : ''}
            </p>
            <div className="flex gap-2">
              <input
                type="password" autoComplete="off" value={dcKey}
                onChange={e => setDcKey(e.target.value)}
                placeholder="tskey-auth-…"
                className="flex-1 rounded-md border border-border bg-transparent px-2 py-1.5 text-xs font-mono"
              />
              <button onClick={saveDcKey} disabled={dcBusy !== null || !dcKey.trim()}
                className="flex items-center gap-1.5 text-xs bg-brand text-brand-foreground rounded-md px-3 py-1.5 disabled:opacity-40">
                <KeyRound className="size-3.5" /> Save key
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border p-3">
            <p className="text-xs font-medium mb-1">Tailnet egress policy <span className="text-muted-foreground font-normal">(per-session scoping)</span></p>
            <p className="text-xs text-muted-foreground mb-2">
              What coding sessions may reach through the tailnet proxy — one rule per line:
              host (<span className="font-mono">box-1</span>), suffix (<span className="font-mono">.tail1234.ts.net</span>),
              CIDR (<span className="font-mono">100.64.0.0/10</span>), each with an optional
              <span className="font-mono">:port</span>. Every session authenticates with its own
              per-session credentials and gets this default; per-session overrides are settable via the API.
              Empty = allow-all (previous behavior). App-enforced (advisory) — the strongest in-container
              scoping available on a shared node.
            </p>
            <textarea
              value={dcEgressDraft ?? ''}
              onChange={e => setDcEgressDraft(e.target.value)}
              disabled={dcEgressDraft === null || dcEgressSaving}
              rows={4}
              placeholder={'# empty = allow-all\nbox-1\n.tail1234.ts.net\n100.64.0.0/10:22'}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs font-mono mb-2 disabled:opacity-50"
            />
            <button onClick={saveDcEgress} disabled={dcEgressDraft === null || dcEgressSaving}
              className="flex items-center gap-1.5 text-xs bg-brand text-brand-foreground rounded-md px-3 py-1.5 disabled:opacity-40">
              {dcEgressSaving && <Loader2 className="size-3.5 animate-spin" />} Save egress policy
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
