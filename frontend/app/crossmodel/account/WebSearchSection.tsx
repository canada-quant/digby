'use client';

/**
 * Admin → Settings → "Web search" panel (ticket 6f4d42f2).
 *
 * On self-hosted / Digby Edge instances there was NO way for an admin to
 * supply Bright Data credentials — the installer's env file is the only input
 * surface, so search_engine / web_pipe / scrape tools failed outright with
 * generic unreachable errors. This panel is the admin surface: a Bright Data
 * API key + zone name, stored SERVER-SIDE ENCRYPTED (searchProviderConfig,
 * AES-256-GCM at rest) and NEVER echoed back after save — the status read
 * carries a masked preview only (env keys are not echoed at all).
 *
 * Resolution contract (backend platform/search-provider-config.ts): env
 * BRIGHTDATA_API_TOKEN takes precedence when present (cloud-deploy backwards
 * compatibility); the store key arms the direct tier within the resolver's
 * 30 s cache — no process restart. With NOTHING configured, the search tools
 * answer "search not configured — set a Bright Data key in Admin → Settings".
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Globe, Loader2, Save, Trash2 } from 'lucide-react';
import { adminApi, type WebSearchConfigStatus } from '@/lib/api/crossmodel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const SOURCE_COPY: Record<string, string> = {
  env: 'Env (BRIGHTDATA_API_TOKEN) — the admin store key is ignored while env is set (precedence)',
  store: 'Admin store — the key saved here arms the search backend within ~30 s (no restart)',
};

export function WebSearchSection() {
  const [status, setStatus] = useState<WebSearchConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [zone, setZone] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await adminApi.getWebSearchConfig();
      setStatus(s);
      setZone(s.zone ?? '');
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (input: { apiKey?: string; zone?: string; enabled?: boolean; clear?: boolean }): Promise<void> => {
    setSaving(true);
    try {
      const s = await adminApi.saveWebSearchConfig(input);
      setStatus(s);
      setZone(s.zone ?? '');
      setApiKey('');
      toast.success(input.clear ? 'Web-search configuration cleared' : 'Web-search configuration saved');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to save web-search configuration');
    } finally {
      setSaving(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading web-search configuration…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="text-sm text-destructive">
        Failed to load the web-search configuration. <Button variant="link" className="h-auto p-0" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }

  const notConfigured = status?.source === null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4" />
        <h3 className="text-sm font-semibold">Web search (Bright Data)</h3>
        {status?.source === 'env' && <Badge variant="secondary">env key in use</Badge>}
        {status?.source === 'store' && <Badge variant="default">admin key in use</Badge>}
        {notConfigured && <Badge variant="destructive">not configured</Badge>}
        {status?.storeConfigured && !status.storeEnabled && <Badge variant="outline">stored key disabled</Badge>}
        {status?.storeConfigured && status.storeReadable === false && <Badge variant="destructive">stored key unreadable — re-enter</Badge>}
      </div>

      <p className="text-xs text-muted-foreground">
        The Bright Data key web search (search_engine / web_pipe / page reads) authenticates with. On a self-hosted
        instance this is the ONLY way to configure search — the installer&apos;s env file never asks for it. The key is
        stored encrypted and never echoed back; a saved key arms search within ~30 s without a restart. An env{' '}
        <code className="rounded bg-muted px-1">BRIGHTDATA_API_TOKEN</code>, when set, always takes precedence.
      </p>

      {notConfigured && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          No search credential is configured — web-search tools currently fail with &ldquo;search not configured&rdquo;.
          Enter a Bright Data API key below to enable search on this instance.
        </div>
      )}

      {status?.storeConfigured && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Stored key</span>
            <span className="font-mono">{status.storePreview ?? '(unreadable — re-enter it)'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Zone</span>
            <span className="font-mono">{status.zone ?? '(default: web_unlocker1)'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Use the stored key</span>
            <Switch
              checked={status.enabled}
              disabled={saving}
              onCheckedChange={(checked) => void save({ enabled: checked })}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Resolves from</span>
            <span>{SOURCE_COPY[status.source ?? ''] ?? 'nothing — search is not configured'}</span>
          </div>
          {status.updatedAt && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Last saved</span>
              <span>{new Date(status.updatedAt).toLocaleString()}{status.updatedBy ? ` by ${status.updatedBy}` : ''}</span>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bd-api-key">Bright Data API key</Label>
          <Input
            id="bd-api-key"
            type="password"
            autoComplete="off"
            placeholder={status?.storeConfigured ? '•••• (unchanged unless you re-enter)' : 'brd-api-key-…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bd-zone">Zone (optional)</Label>
          <Input
            id="bd-zone"
            type="text"
            placeholder="web_unlocker1"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            disabled={saving}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={saving || (!apiKey.trim() && !status?.storeConfigured && zone === (status?.zone ?? ''))}
          onClick={() => void save({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(zone !== (status?.zone ?? '') ? { zone: zone.trim() } : {}) })}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </Button>
        {status?.storeConfigured && (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => setConfirmClear(true)}>
            <Trash2 className="h-4 w-4" /> Clear
          </Button>
        )}
      </div>

      {confirmClear && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs space-y-2">
          <p>Remove the stored Bright Data key? Web search will fail with &ldquo;search not configured&rdquo; until a key is saved again{status?.source === 'env' ? ' (an env key, if set, keeps working)' : ''}.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={saving} onClick={() => { setConfirmClear(false); void save({ clear: true }); }}>
              Remove key
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmClear(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
