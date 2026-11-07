'use client';

/**
 * Admin → Branding packs (todo 61dc8aaf, Phase 2 Cloud).
 *
 * The operator surface for seasonal/holiday skins on a Cloud deployment. The
 * whole flow lives here, in the order an operator actually works:
 *
 *   UPLOAD     pick a file per slot (plus name/tagline/accent colours)
 *   VALIDATE   server-side, before anything is stored — magic-byte type,
 *              dimensions against the slot's bounds, 2 MB ceiling, SVG refused.
 *              A rejection names the slot and the reason; nothing is saved.
 *   PREVIEW    every asset renders at its real size in BOTH schemes, plus the
 *              spinner in both motion modes — the operator sees a broken
 *              light-mode logo before activating, not after.
 *   ACTIVATE   one click, atomic. Any pack already live is archived in the same
 *              transaction (a database partial-unique index makes "two active
 *              packs" impossible).
 *   ROLLBACK   one click back to the shipped Digby identity — the active row is
 *              cleared, so every surface falls back to default by construction.
 *
 * WHY PREVIEW READS THE PUBLIC ROUTE. The `<img src>` here is the exact URL a
 * visitor's browser will load (`/api/crossmodel/branding/pack/:id/asset/:slot`).
 * A preview that used a data: URL or an admin-only endpoint could pass while the
 * public path 404s — which is precisely the bug this panel must not ship. It
 * necessarily means preview works only for the ACTIVE pack's assets (a draft's
 * bytes are not publicly readable, by design); the pre-activation check is done
 * on the LOCAL File objects, which is the honest trade and is stated in the copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Palette, RefreshCw, Loader2, Upload, Check, Undo2, Trash2, AlertTriangle } from 'lucide-react';
import {
  brandingPacksApi,
  missingForActivation,
  packAssetUrl,
  SLOT_LABELS,
  type BrandingPack,
  type BrandingPacksList,
  type PackRejection,
} from '@/lib/api/branding-packs';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** The manifest fields an operator edits — the text half of a pack. */
interface DraftText {
  name: string;
  tagline: string;
  titleSuffix: string;
  light: string;
  dark: string;
}

const EMPTY_TEXT: DraftText = {
  name: '',
  tagline: '',
  titleSuffix: '',
  light: '#ffffff',
  dark: '#171717',
};

/** Slots offered in the upload grid, in the order they appear. */
const UPLOAD_SLOTS = [
  'logo',
  'logoDark',
  'logoLight',
  'logoCompact',
  'spinner',
  'spinnerStatic',
  'favicon32',
  'icon192',
  'icon512',
  'appleTouchIcon',
] as const;

export function BrandingPacksSection() {
  const [data, setData] = useState<BrandingPacksList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [packName, setPackName] = useState('');
  const [text, setText] = useState<DraftText>(EMPTY_TEXT);
  const [files, setFiles] = useState<Partial<Record<string, File>>>({});
  const [rejections, setRejections] = useState<PackRejection[]>([]);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<BrandingPack | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await brandingPacksApi.list());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const activePack = useMemo(
    () => data?.packs.find((p) => p.status === 'active') ?? null,
    [data],
  );

  const pickedFiles = Object.entries(files).filter(([, f]) => !!f);
  const canSubmit = packName.trim().length > 0 && !busy;

  const submit = useCallback(async () => {
    if (!packName.trim()) {
      toast.error('Give the pack a name first.');
      return;
    }
    setBusy('create');
    setRejections([]);
    try {
      const pack = await brandingPacksApi.create({
        name: packName.trim(),
        manifest: {
          name: text.name || undefined,
          tagline: text.tagline || undefined,
          titleSuffix: text.titleSuffix || undefined,
          theme: {
            light: text.light,
            dark: text.dark,
            backgroundLight: text.light,
            backgroundDark: text.dark,
          },
        } as any,
        files,
      });
      toast.success(`Pack "${pack.name}" saved as a draft. Activate it to put it live.`);
      setPackName('');
      setText(EMPTY_TEXT);
      setFiles({});
      await load();
    } catch (err: any) {
      if (Array.isArray(err?.rejections) && err.rejections.length) {
        setRejections(err.rejections);
        toast.error(err.message || 'Some assets did not pass validation.');
      } else {
        toast.error(err?.message || 'Could not create the pack.');
      }
    } finally {
      setBusy(null);
    }
  }, [packName, text, files, load]);

  const activate = useCallback(async (pack: BrandingPack) => {
    const missing = missingForActivation(pack.assets.map((a) => a.slot));
    if (missing.length) {
      toast.error(`Cannot activate yet — missing: ${missing.map((s) => SLOT_LABELS[s] ?? s).join(', ')}`);
      return;
    }
    setBusy(pack.id);
    try {
      await brandingPacksApi.activate(pack.id);
      toast.success(`"${pack.name}" is live. Reload to see it applied everywhere.`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not activate the pack.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const rollback = useCallback(async () => {
    setBusy('rollback');
    try {
      const res = await brandingPacksApi.rollback();
      toast.success(
        res.rolledBack
          ? 'Rolled back to the shipped Digby branding.'
          : 'Nothing was active — the shipped branding is already in place.',
      );
      await load();
    } catch {
      toast.error('Could not roll back to the default branding.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const remove = useCallback(async (pack: BrandingPack) => {
    setBusy(pack.id);
    try {
      await brandingPacksApi.remove(pack.id);
      toast.success(`Deleted "${pack.name}".`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not delete the pack.');
    } finally {
      setBusy(null);
    }
  }, [load]);

  return (
    <div className="space-y-6" data-testid="branding-packs-section">
      {/* header + what is live now */}
      <div className="rounded-lg border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Palette className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Seasonal branding packs</h3>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Refresh
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Put a seasonal or holiday skin on the site without a rebuild or a frontend fork. Upload the
          assets, check the preview in both colour schemes, then activate. Rolling back restores the
          shipped Digby branding immediately — the default is never overwritten.
        </p>
        <div className="flex items-center gap-2 text-xs" data-testid="branding-active-state">
          <span className="text-muted-foreground">Live now:</span>
          {activePack ? (
            <>
              <Badge variant="success" className="text-[10px]">ACTIVE</Badge>
              <span className="font-medium">{activePack.name}</span>
              <button
                type="button"
                onClick={() => setConfirmRollback(true)}
                disabled={busy === 'rollback'}
                className="ml-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                <Undo2 className="size-3.5" /> Roll back to default
              </button>
            </>
          ) : (
            <>
              <Badge variant="warning" className="text-[10px]">DEFAULT</Badge>
              <span className="text-muted-foreground">shipped Digby branding</span>
            </>
          )}
        </div>
      </div>

      {/* create */}
      <div className="rounded-lg border bg-card p-5 space-y-4">
        <h4 className="text-sm font-semibold">1 · Upload a pack</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium">Pack name</span>
            <input
              value={packName}
              onChange={(e) => setPackName(e.target.value)}
              placeholder="Winter 2026"
              maxLength={80}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="pack-name"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Brand name shown in the app</span>
            <input
              value={text.name}
              onChange={(e) => setText({ ...text, name: e.target.value })}
              placeholder="Leave blank to keep the current name"
              maxLength={40}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Tagline</span>
            <input
              value={text.tagline}
              onChange={(e) => setText({ ...text, tagline: e.target.value })}
              placeholder="Ask once. Get the best of every AI."
              maxLength={140}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Title suffix</span>
            <input
              value={text.titleSuffix}
              onChange={(e) => setText({ ...text, titleSuffix: e.target.value })}
              placeholder="Private, Canadian AI Assistant"
              maxLength={80}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Accent — light mode</span>
            <input
              type="color"
              value={text.light}
              onChange={(e) => setText({ ...text, light: e.target.value })}
              className="h-9 w-full rounded-md border bg-background"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Accent — dark mode</span>
            <input
              type="color"
              value={text.dark}
              onChange={(e) => setText({ ...text, dark: e.target.value })}
              className="h-9 w-full rounded-md border bg-background"
            />
          </label>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">Assets</p>
          <p className="text-[11px] text-muted-foreground">
            PNG, JPEG, GIF, WebP or ICO · 2&nbsp;MB per file · SVG is refused (it can carry script and
            would be served from our origin). Each file&apos;s real type is read from its bytes, never
            from its extension.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {UPLOAD_SLOTS.map((slot) => {
              const file = files[slot];
              const rejected = rejections.find((r) => r.slot === slot);
              return (
                <div
                  key={slot}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${rejected ? 'border-destructive/50' : ''}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{SLOT_LABELS[slot] ?? slot}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {file ? `${file.name} · ${Math.round(file.size / 1024)} KB` : 'no file'}
                    </p>
                    {rejected && (
                      <p className="text-[11px] text-destructive" data-testid={`rejection-${slot}`}>
                        {rejected.reason}
                      </p>
                    )}
                  </div>
                  <input
                    ref={(el) => { fileInputs.current[slot] = el; }}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      setFiles((prev) => ({ ...prev, [slot]: f }));
                      setRejections((prev) => prev.filter((r) => r.slot !== slot));
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputs.current[slot]?.click()}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted"
                  >
                    <Upload className="size-3" /> {file ? 'Change' : 'Choose'}
                  </button>
                  {file && (
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => ({ ...prev, [slot]: undefined }))}
                      className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                      aria-label={`Remove ${SLOT_LABELS[slot] ?? slot}`}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* local validation preview — before anything is stored */}
        {pickedFiles.length > 0 && (
          <div className="space-y-2 rounded-md bg-muted/40 p-3">
            <p className="text-xs font-medium">Local check (before upload)</p>
            <div className="flex flex-wrap gap-3">
              {pickedFiles.map(([slot, file]) => (
                <div key={slot} className="space-y-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={URL.createObjectURL(file as File)}
                    alt={SLOT_LABELS[slot] ?? slot}
                    className="size-14 rounded-md border bg-background object-contain"
                  />
                  <p className="max-w-[90px] truncate text-[10px] text-muted-foreground">{SLOT_LABELS[slot] ?? slot}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === 'create' ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          Save as draft
        </button>
      </div>

      {/* list */}
      <div className="rounded-lg border bg-card p-5 space-y-3">
        <h4 className="text-sm font-semibold">2 · Preview, activate, roll back</h4>
        {loading && !data ? (
          <div className="flex justify-center py-3"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
        ) : error && !data ? (
          <p className="text-xs text-destructive">Could not load branding packs.</p>
        ) : !data?.packs.length ? (
          <p className="text-xs text-muted-foreground">No packs yet. Upload one above.</p>
        ) : (
          <div className="space-y-3">
            {data.packs.map((pack) => {
              const missing = missingForActivation(pack.assets.map((a) => a.slot));
              const isActive = pack.status === 'active';
              return (
                <div
                  key={pack.id}
                  className={`rounded-md border p-3 space-y-2 ${isActive ? 'border-brand bg-brand-soft/40' : ''}`}
                  data-testid={`pack-row-${pack.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{pack.name}</span>
                    {isActive
                      ? <Badge variant="success" className="text-[10px]">ACTIVE</Badge>
                      : pack.status === 'archived'
                        ? <Badge variant="outline" className="text-[10px]">ARCHIVED</Badge>
                        : <Badge variant="warning" className="text-[10px]">DRAFT</Badge>}
                    <span className="text-[11px] text-muted-foreground">
                      {pack.manifest.name} · {pack.assets.length} asset{pack.assets.length === 1 ? '' : 's'}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => void activate(pack)}
                          disabled={busy === pack.id || missing.length > 0}
                          title={missing.length ? `Missing: ${missing.join(', ')}` : 'Make this pack live'}
                          className="inline-flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
                        >
                          {busy === pack.id ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                          Activate
                        </button>
                      )}
                      {isActive && (
                        <button
                          type="button"
                          onClick={() => setConfirmRollback(true)}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          <Undo2 className="size-3" /> Roll back
                        </button>
                      )}
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(pack)}
                          className="rounded-md border p-1 text-muted-foreground hover:bg-muted"
                          aria-label={`Delete ${pack.name}`}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {missing.length > 0 && (
                    <p className="flex items-center gap-1 text-[11px] text-warn-ink">
                      <AlertTriangle className="size-3" />
                      Cannot go live — missing: {missing.map((s) => SLOT_LABELS[s] ?? s).join(', ')}
                    </p>
                  )}

                  {/* PREVIEW — both schemes, both motion modes, the real public URLs */}
                  {pack.assets.length > 0 && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <SchemePreview pack={pack} scheme="light" />
                      <SchemePreview pack={pack} scheme="dark" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {activePack && (
          <p className="text-[11px] text-muted-foreground">
            Preview images load from the same public URL visitors use, so what renders here is what
            ships. A draft&apos;s bytes are not publicly readable — activate to see them served.
          </p>
        )}
      </div>

      <AlertDialog open={confirmRollback} onOpenChange={(open) => { if (!open) setConfirmRollback(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back to the shipped branding?</AlertDialogTitle>
            <AlertDialogDescription>
              The active pack stops being served and every surface returns to the default Digby
              identity. The pack is kept as an archived row, so you can activate it again later
              without re-uploading.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it live</AlertDialogCancel>
            <AlertDialogAction
              className="bg-send hover:bg-send/90 text-send-ink"
              onClick={() => { setConfirmRollback(false); void rollback(); }}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{confirmDelete?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              The pack and its uploaded assets are removed permanently. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { const p = confirmDelete; setConfirmDelete(null); if (p) void remove(p); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One colour scheme's worth of a pack's assets. Shows the resolved logo for the
 * scheme (falling back exactly as `logoForScheme` does) and the spinner in both
 * motion modes, so a reduced-motion visitor's experience is legible before the
 * pack goes live rather than after.
 */
function SchemePreview({ pack, scheme }: { pack: BrandingPack; scheme: 'light' | 'dark' }) {
  const bySlot = new Map(pack.assets.map((a) => [a.slot, a]));
  const schemeLogo = bySlot.get(scheme === 'dark' ? 'logoDark' : 'logoLight') ?? bySlot.get('logo');
  const compact = bySlot.get('logoCompact') ?? schemeLogo;
  const spinner = bySlot.get('spinner');
  const spinnerStatic = bySlot.get('spinnerStatic') ?? schemeLogo;

  return (
    <div
      className={`space-y-2 rounded-md border p-3 ${scheme === 'dark' ? 'bg-neutral-900' : 'bg-white'}`}
      data-testid={`preview-${scheme}`}
    >
      <p className={`text-[11px] font-medium ${scheme === 'dark' ? 'text-neutral-300' : 'text-neutral-600'}`}>
        {scheme === 'dark' ? 'Dark mode' : 'Light mode'}
      </p>
      <div className="flex items-center gap-3">
        {schemeLogo ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={packAssetUrl(pack.id, schemeLogo.slot)}
            alt={pack.manifest.logoAlt}
            className="h-8 w-auto object-contain"
          />
        ) : (
          <span className={`text-[11px] ${scheme === 'dark' ? 'text-neutral-500' : 'text-neutral-400'}`}>
            no {scheme} logo — falls back to the default
          </span>
        )}
        {compact && compact.slot !== schemeLogo?.slot && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={packAssetUrl(pack.id, compact.slot)}
            alt=""
            className="size-6 object-contain"
          />
        )}
      </div>
      {spinner && (
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={packAssetUrl(pack.id, spinner.slot)} alt="" className="size-6 object-contain" />
          <span className={`text-[10px] ${scheme === 'dark' ? 'text-neutral-400' : 'text-neutral-500'}`}>motion</span>
          {spinnerStatic && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={packAssetUrl(pack.id, spinnerStatic.slot)} alt="" className="size-6 object-contain" />
              <span className={`text-[10px] ${scheme === 'dark' ? 'text-neutral-400' : 'text-neutral-500'}`}>
                reduced motion
              </span>
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-1">
        <span
          className="size-3 rounded-full border"
          style={{ backgroundColor: pack.manifest.theme[scheme === 'dark' ? 'dark' : 'light'] }}
        />
        <span className={`text-[10px] ${scheme === 'dark' ? 'text-neutral-400' : 'text-neutral-500'}`}>
          {pack.manifest.theme[scheme === 'dark' ? 'dark' : 'light']}
        </span>
      </div>
    </div>
  );
}

export default BrandingPacksSection;