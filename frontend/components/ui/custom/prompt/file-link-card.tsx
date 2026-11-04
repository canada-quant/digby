'use client';

/**
 * File link cards + authed inline image embeds for chat messages
 * (ticket 57ef1b9f PR3).
 *
 * The agent renders two file-route shapes verbatim into message markdown:
 *   - Generated docs (create_document): /api/crossmodel/generated-files/<uuid>/download
 *       (backend tool-executor.ts downloadPath — "render as-is")
 *   - Generated images (generate_image, 2026-09-24):
 *                                       /api/crossmodel/generated-files/<uuid>/inline
 *       (image/* only — the persisted transcript part's lazy `url`; a model
 *       that embeds it anyway gets the authed image, not a broken <img>)
 *   - Persisted uploads (PR1):          /api/crossmodel/files/<uuid>/(download|inline)
 *       (Bearer-only byte routes — a bare <a href> navigation would 401)
 *
 * MarkdownContent's anchor/img renderers call parseFileLinkHref: a recognized
 * href becomes a compact FileLinkCard (type icon + filename + authed download
 * button) instead of a bare link; a chat-file route as a markdown IMAGE src
 * becomes an AuthedFileImage (authed fetch → blob → objectURL). Everything
 * unrecognized renders exactly as before.
 *
 * SECURITY INVARIANT (review finding B1): scripting-capable types (text/html,
 * image/svg+xml essences) are NEVER rendered inline via blob: URLs — a blob
 * re-serve strips the backend's CSP sandbox header, so stored html/svg would
 * execute scripts in the app origin. AuthedFileImage therefore gates on the
 * FETCHED blob's mime essence (isBlobRenderableImage: image/* minus svg) and
 * falls back to the FileLinkCard for anything else. Download (attachment
 * disposition) stays available for all types. The gate mirrors
 * ChatFilesSection.canPreview / the backend's mimeEssence rule.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Download,
  FileDown,
  FileJson,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Maximize2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { chatFilesApi, filesApi } from '@/lib/api/crossmodel';
import { ImageLightbox } from './image-lightbox';

// ─── Route-shape recognizer (pure — unit-tested directly) ───────────────────

export type FileLinkTarget =
  /** `route` is present ONLY for the inline byte route (generated images,
   *  2026-09-24); absent = the download route — the legacy shape every
   *  create_document link resolves to (and the recognizer pin expects). */
  | { kind: 'generated'; id: string; route?: 'inline' }
  | { kind: 'chat-file'; id: string; route: 'download' | 'inline' };

/** The targets AuthedFileImage / AuthedImageLightbox can fetch as an image:
 *  any chat-file byte route (the fetched mime decides) or a generated file's
 *  INLINE route (image/* only server-side — a download-route generated link
 *  is a document card, never an image). */
export type AuthedImageTarget =
  | { kind: 'chat-file'; id: string; route: 'download' | 'inline' }
  | { kind: 'generated'; id: string; route: 'inline' };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const GENERATED_PATH_RE = new RegExp(`^/api/crossmodel/generated-files/(${UUID})/(download|inline)/?$`);
const CHAT_FILE_PATH_RE = new RegExp(`^/api/crossmodel/files/(${UUID})/(download|inline)/?$`);

/**
 * Narrow a recognized file link to an authed-image target, or null when the
 * link is a document card (a generated DOWNLOAD route). Pure — the markdown
 * anchor/img renderers route on it.
 */
export function authedImageTarget(target: FileLinkTarget | null | undefined): AuthedImageTarget | null {
  if (!target) return null;
  if (target.kind === 'chat-file') return target;
  if (target.route === 'inline') return { kind: 'generated', id: target.id, route: 'inline' };
  return null;
}

/**
 * Bare `file:` link destinations emitted by a model deviating from the
 * "render the download link as-is" contract (ticket 8db4c18e): tolerant of an
 * optional `//` authority marker (`file://<uuid>`), whitespace inside the
 * parens, scheme case, an angle-bracket destination (`[x](<file:<uuid>>)`),
 * and an optional CommonMark title (`[x](file:<uuid> "t")` / `'t'` / `(t)`)
 * (ticket a2325600 gap 1). ONLY a uuid is accepted — `file:///etc/passwd`,
 * `file:abc` etc. are left alone (they stay plain links, never cards). The
 * title must be WHITESPACE-separated from the destination: the
 * injection-shaped `](file:<uuid>" onmouseover=…)` (quote hard against the
 * uuid) never matches and passes through unrewritten (pinned negative test).
 */
const FILE_SCHEME_INLINE_RE = new RegExp(
  `\\]\\(\\s*<?\\s*file:(?:\\/\\/)?(${UUID})\\s*>?(\\s+(?:"[^"\\n]*"|'[^'\\n]*'|\\([^)\\n]*\\)))?\\s*\\)`,
  'gi',
);

/**
 * Reference-style link definitions (ticket a2325600 gap 1):
 * `[label]: file:<uuid>` at line start (≤3-space indent, CommonMark), with
 * optional angle brackets and an optional same-line title. The title group is
 * preserved in the rewrite.
 */
const FILE_SCHEME_REFDEF_RE = new RegExp(
  `^( {0,3}\\[[^\\]\\n]+\\]:[ \\t]*)<?[ \\t]*file:(?:\\/\\/)?(${UUID})[ \\t]*>?([ \\t]+(?:"[^"\\n]*"|'[^'\\n]*'|\\([^)\\n]*\\)))?[ \\t]*$`,
  'gim',
);

type CodeSegment = { text: string; code: boolean };

/**
 * Code-aware segmentation (ticket a2325600 gap 3): the rewrite is render-time
 * only, but a `](file:<uuid>)` shown AS CODE (fenced block or inline span)
 * must keep its DISPLAYED code text — code regions pass through
 * byte-identical. Fences: 3+ backticks/tildes at ≤3-space indent, closed by
 * the same char with run length ≥ the opener (CommonMark; mirrors the
 * markdown-normalize tracker). Inline spans: equal-length backtick runs; an
 * unmatched run is literal text and scanning resumes AFTER the run (cmark
 * semantics).
 */
function segmentCodeRegions(src: string): CodeSegment[] {
  const segs: CodeSegment[] = [];
  const n = src.length;
  let proseStart = 0;
  let i = 0;
  const flushProseTo = (end: number) => {
    if (end > proseStart) segs.push({ text: src.slice(proseStart, end), code: false });
  };
  while (i < n) {
    const lineStart = i === 0 || src[i - 1] === '\n';
    if (lineStart) {
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(src.slice(i, i + 24));
      if (fence) {
        const ch = fence[1][0];
        const len = fence[1].length;
        // Find the closing fence line: same char, run ≥ len, ≤3-space indent,
        // nothing but whitespace after (CommonMark) — else the block runs to EOF.
        let end = n;
        let lineEnd = src.indexOf('\n', i);
        if (lineEnd === -1) lineEnd = n;
        let cursor = lineEnd;
        while (cursor < n) {
          const nextEnd = src.indexOf('\n', cursor + 1);
          const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}[ \\t]*\\r?$`);
          if (closeRe.test(src.slice(cursor + 1, nextEnd === -1 ? n : nextEnd))) {
            end = nextEnd === -1 ? n : nextEnd;
            break;
          }
          if (nextEnd === -1) break;
          cursor = nextEnd;
        }
        flushProseTo(i);
        segs.push({ text: src.slice(i, end), code: true });
        proseStart = end;
        i = end;
        continue;
      }
    }
    if (src[i] === '`') {
      let runLen = 1;
      while (src[i + runLen] === '`') runLen++;
      // Closing run must be EXACTLY the same length (CommonMark code spans).
      let k = i + runLen;
      let closeEnd = -1;
      while (k < n) {
        const next = src.indexOf('`', k);
        if (next === -1) break;
        let rl = 1;
        while (src[next + rl] === '`') rl++;
        if (rl === runLen) {
          closeEnd = next + runLen;
          break;
        }
        k = next + rl;
      }
      if (closeEnd !== -1) {
        flushProseTo(i);
        segs.push({ text: src.slice(i, closeEnd), code: true });
        proseStart = closeEnd;
        i = closeEnd;
        continue;
      }
      i += runLen; // unmatched opener run is literal — resume after it
      continue;
    }
    i++;
  }
  if (proseStart < n) segs.push({ text: src.slice(proseStart), code: false });
  return segs;
}

/**
 * Pre-render defense for the model-deviation bug in ticket 8db4c18e: a model
 * sometimes renders a generated file's download link as `[x](file:<uuid>)`
 * instead of the /api route the tool returned. react-markdown's
 * defaultUrlTransform (which we must NOT loosen — secure by default) blanks
 * the `file:` scheme, leaving href="" on a target=_blank anchor → a full app
 * reload. Rewrite such destinations to the canonical generated-file download
 * route BEFORE react-markdown sees the content, so parseFileLinkHref above
 * recognizes them and renders the working FileLinkCard. Idempotent; inputs
 * without a bare `file:` uuid destination pass through byte-identical.
 * Render-time only — the stored message is never touched — and
 * fence/inline-code aware (ticket a2325600 gap 3): displayed code keeps its
 * text.
 */
export function rewriteFileSchemeLinks(markdown: string): string {
  if (!markdown || !/file:/i.test(markdown)) return markdown;
  return segmentCodeRegions(markdown)
    .map((seg) => {
      if (seg.code) return seg.text;
      return seg.text
        .replace(
          FILE_SCHEME_INLINE_RE,
          (_match, id: string) => `](/api/crossmodel/generated-files/${id}/download)`,
        )
        .replace(
          FILE_SCHEME_REFDEF_RE,
          (_match, prefix: string, id: string, title?: string) =>
            `${prefix}/api/crossmodel/generated-files/${id}/download${title ?? ''}`,
        );
    })
    .join('');
}

/** Origins whose absolute URLs may be treated as app file routes. */
function appOrigins(): string[] {
  const origins: string[] = [];
  if (typeof window !== 'undefined' && window.location?.origin) {
    origins.push(window.location.origin);
  }
  // The configured byte-API origin (same fallback as chatFilesApi/filesApi) —
  // absolute links a model built from the API base still resolve to our API.
  try {
    origins.push(new URL(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api').origin);
  } catch {
    /* a malformed env value must never break message rendering */
  }
  return origins;
}

/**
 * Recognize the known file-route hrefs. Accepts same-origin-relative paths
 * (what the agent renders) and absolute URLs on an app origin (page origin or
 * the configured API origin); every other href returns null → the caller
 * renders the ordinary link/image path. Query strings (?token=…) and
 * fragments are ignored.
 */
export function parseFileLinkHref(href: string | null | undefined): FileLinkTarget | null {
  if (!href || typeof href !== 'string') return null;
  let path: string;
  if (href.startsWith('/')) {
    path = href.split(/[?#]/, 1)[0];
  } else if (/^https?:\/\//i.test(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (!appOrigins().includes(url.origin)) return null;
    path = url.pathname;
  } else {
    return null;
  }
  const generated = GENERATED_PATH_RE.exec(path);
  if (generated) {
    return generated[2] === 'inline'
      ? { kind: 'generated', id: generated[1], route: 'inline' }
      : { kind: 'generated', id: generated[1] };
  }
  const chatFile = CHAT_FILE_PATH_RE.exec(path);
  if (chatFile) return { kind: 'chat-file', id: chatFile[1], route: chatFile[2] as 'download' | 'inline' };
  return null;
}

// ─── Bare image-URL promotion (pure — the streaming render must stay sync) ───

/**
 * Extensions a bare href may be promoted to an inline image on. Deliberately
 * NOT the FileLinkIcon IMAGE_EXTS set: svg is scripting-capable (the B1
 * family — never inline-rendered on a bare-URL sniff), and the exotic
 * bmp/ico/tif forms stay plain links rather than risk a broken embed.
 */
const INLINE_IMAGE_URL_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);

/**
 * Does this href's PATHNAME end in a known inline-renderable image extension?
 * Case-insensitive, query/hash stripped; accepts absolute http(s) URLs and
 * relative paths. SYNCHRONOUS ONLY — a streaming transcript render can never
 * HEAD-fetch to sniff a content-type, so an extension-less image URL stays a
 * plain link by design. Pure — unit-tested directly.
 */
export function isInlineImageUrl(href: string | null | undefined): boolean {
  if (!href || typeof href !== 'string') return false;
  let path: string;
  if (/^https?:\/\//i.test(href)) {
    try {
      path = new URL(href).pathname;
    } catch {
      return false;
    }
  } else {
    path = href.split(/[?#]/, 1)[0];
  }
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return !!ext && INLINE_IMAGE_URL_EXTS.has(ext);
}

// ─── Mime gates (pure — mirror ChatFilesSection.tsx / the backend essence rule) ─

/** Mime essence — parameters/case stripped, mirroring the backend's rule. */
const mimeEssence = (m: string) => (m || '').split(';', 1)[0].trim().toLowerCase();

/**
 * May these bytes be rendered as an <img> from a blob: URL? image/* EXCEPT
 * svg (scripting-capable — B1). Compared on the essence so a parameterized or
 * case-variant svg (`image/svg+xml; charset=utf-8`) cannot slip past.
 */
export function isBlobRenderableImage(mimeType: string): boolean {
  const m = mimeEssence(mimeType);
  return m.startsWith('image/') && m !== 'image/svg+xml';
}

// ─── Authed byte fetch (injectable for tests) ────────────────────────────────

/** The absolute byte URL an authed-image target fetches (pure — unit-tested). */
export function authedImageUrl(target: AuthedImageTarget): string {
  if (target.kind === 'generated') return filesApi.inlineGeneratedUrl(target.id);
  return target.route === 'inline' ? chatFilesApi.inlineUrl(target.id) : chatFilesApi.downloadUrl(target.id);
}

/**
 * Fetch a file's bytes with the Bearer header (the byte routes are
 * Bearer-only — a bare navigation 401s). Returns the Blob on success, null on
 * any http/network failure. Callers gate on blob.type before rendering.
 * Generalized from the chat-file-only form (2026-09-24) so generated images
 * ride the same authed fetch → blob → objectURL path.
 */
export async function fetchFileBlob(
  target: AuthedImageTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob | null> {
  const url = authedImageUrl(target);
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('accessToken') : null;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.blob();
  } catch {
    return null;
  }
}

/** Chat-file form of fetchFileBlob (kept for its callers + tests). */
export async function fetchChatFileBlob(
  fileId: string,
  route: 'download' | 'inline',
  fetchImpl: typeof fetch = fetch,
): Promise<Blob | null> {
  return fetchFileBlob({ kind: 'chat-file', id: fileId, route }, fetchImpl);
}

// ─── Type icon (filename extension — the only signal a bare link carries) ────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'svg']);
const SHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'ods']);

const ICON_CLS = 'h-4 w-4 flex-shrink-0';

/** Mirrors the ChatFilesSection/files-page icon set, keyed on the extension. */
function FileLinkIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.has(ext)) return <ImageIcon className={cn(ICON_CLS, 'text-brand-accent')} />;
  if (ext === 'pdf') return <FileDown className={cn(ICON_CLS, 'text-destructive')} />;
  if (SHEET_EXTS.has(ext)) return <FileSpreadsheet className={cn(ICON_CLS, 'text-success')} />;
  if (ext === 'json') return <FileJson className={cn(ICON_CLS, 'text-warn-ink')} />;
  return <FileText className={cn(ICON_CLS, 'text-brand-accent')} />;
}

// ─── FileLinkCard ────────────────────────────────────────────────────────────

/**
 * Compact card replacing a bare file-route link: type icon, filename (the
 * markdown link text), and a keyboard-focusable download action that rides
 * the same authed fetch→blob→objectURL flow as the Files page / Files panel
 * (the chat-file routes 401 on a plain navigation). Rendered as phrasing
 * content (spans, not divs) so it stays valid inside the markdown <p>.
 */
export function FileLinkCard({
  filename,
  target,
}: {
  filename: string;
  target: FileLinkTarget;
}) {
  const [busy, setBusy] = useState(false);
  // The link text sometimes already says "Download …" — don't stutter it in
  // the action's accessible name ("Download Download file").
  const actionLabel = /^download\b/i.test(filename) ? filename : `Download ${filename}`;

  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    try {
      if (target.kind === 'generated') {
        await filesApi.downloadGenerated(target.id, filename);
      } else {
        await chatFilesApi.download(target.id, filename);
      }
    } catch {
      toast.error('Failed to download file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      data-file-link-card={target.kind}
      className="my-2 flex w-full max-w-md items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2"
    >
      <FileLinkIcon filename={filename} />
      <span
        className="flex-1 min-w-0 truncate text-sm font-medium text-foreground"
        title={filename}
      >
        {filename}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0"
        title={actionLabel}
        aria-label={actionLabel}
        disabled={busy}
        onClick={() => void handleDownload()}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </Button>
    </span>
  );
}

// ─── AuthedFileImage ─────────────────────────────────────────────────────────

type AuthedImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; mime: string }
  | { status: 'error' };

// ─── AudioFilePlayer (ticket 6c050917 — inline audio player) ────────────────

/**
 * May these bytes be played from a blob: URL? audio/* only. Mirrors the B1
 * discipline of isBlobRenderableImage (compare the essence, never the raw
 * string — `audio/mpeg; charset=utf-8` must not slip past), and audio is
 * inherently non-scripting: a <audio> element never executes markup. A
 * mislabeled non-audio blob is rejected and falls back to the FileLinkCard.
 */
export function isBlobPlayableAudio(mimeType: string): boolean {
  return mimeEssence(mimeType).startsWith('audio/');
}

type AudioState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error' };

/**
 * Inline audio player for a chat-file byte route (ticket 6c050917 — "allow
 * audio playing inside a digby ui in any session"). The byte routes are
 * Bearer-only, so the clip is fetched with auth and re-served from a blob
 * object URL into a native <audio controls> (play/pause, scrubber, volume —
 * the browser's own accessible player). The blob's FETCHED mime must be
 * audio/* (isBlobPlayableAudio — same defense as AuthedFileImage's image
 * gate); anything else falls back to the FileLinkCard. The filename chip is
 * kept beneath the player so the name is never lost.
 *
 * Under SSR the effect never runs — the static markup is the loading
 * placeholder, exactly the AuthedFileImage contract the chip tests pin.
 */
export function AudioFilePlayer({
  target,
  filename,
}: {
  target: { kind: 'chat-file'; id: string; route: 'download' | 'inline' };
  filename?: string;
}) {
  const { id, route } = target;
  const [state, setState] = useState<AudioState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchChatFileBlob(id, route)
      .then((blob) => {
        if (cancelled) return;
        if (!blob || !isBlobPlayableAudio(blob.type)) {
          setState({ status: 'error' });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, route]);

  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    try {
      await chatFilesApi.download(id, filename || 'audio-clip');
    } catch {
      toast.error('Failed to download audio');
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'ready') {
    return (
      <span className="my-2 flex w-full max-w-md flex-col gap-1" data-audio-player={id}>
        <audio controls preload="metadata" src={state.url} className="w-full" />
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate" title={filename}>{filename}</span>
          <Button
            variant="ghost" size="icon" className="h-6 w-6 flex-shrink-0"
            title={filename ? `Download ${filename}` : 'Download audio'} aria-label={filename ? `Download ${filename}` : 'Download audio'}
            disabled={busy} onClick={() => void handleDownload()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </Button>
        </span>
      </span>
    );
  }
  if (state.status === 'error') {
    return <FileLinkCard filename={filename?.trim() || 'Attached audio'} target={target} />;
  }
  return (
    <span
      data-audio-player="loading"
      role="status"
      aria-label={filename ? `Loading ${filename}` : 'Loading audio'}
      className="my-2 flex h-10 w-full max-w-md items-center justify-center rounded-lg border bg-muted/30"
    >
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
    </span>
  );
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
};

/**
 * Review finding (ticket 390b6767): the markdown alt text is model-authored
 * prose — it can be a whole sentence, contain path separators/newlines, or
 * run absurdly long. Sanitize it into a SAFE download filename: one line,
 * path-free, whitespace-collapsed, capped; falls back to null when nothing
 * usable remains (the caller then derives id+ext).
 */
export function safeImageFilename(alt: string | undefined, maxLen = 80): string | null {
  if (typeof alt !== 'string') return null;
  const cleaned = alt
    .split(/\r?\n/, 1)[0]                       // first line only
    .replace(/[/\\]/g, '-')                      // never a path
    .replace(/[\u0000-\u001f\u007f]/g, ' ')      // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .replace(/[. ]+$/, '');                      // no trailing dots/spaces
  return cleaned || null;
}

/**
 * Decisions for the rendered-image action row (ticket 390b6767) — pure so the
 * node-env test idiom can pin them without running effects: the download
 * filename (a sanitized markdown alt when it names the file, else derived
 * from the id + fetched blob mime — the generatedImageFilename idiom), which
 * authed download API serves the kind, and the two accessible labels.
 */
export function imageActionsFor(
  target: AuthedImageTarget,
  alt?: string,
  mime?: string,
): {
  filename: string;
  downloadApi: 'chat-file' | 'generated';
  downloadLabel: string;
  openLabel: string;
} {
  const m = (mime ?? '').split(';', 1)[0].trim().toLowerCase();
  const ext = IMAGE_EXT_BY_MIME[m] ?? 'png';
  const safe = safeImageFilename(alt);
  // An alt with no file extension would download extension-less — append the
  // truthful one from the fetched mime (a browser can't open "photo" alone).
  const filename = safe && /\.[A-Za-z0-9]+$/.test(safe) ? safe : `image-${(target.id || 'file').slice(0, 8)}.${ext}`;
  return {
    filename,
    downloadApi: target.kind,
    downloadLabel: `Download ${filename}`,
    openLabel: 'View full size',
  };
}

/**
 * Inline embed for a markdown image whose src is a chat-file byte route
 * (`![photo](/api/crossmodel/files/<uuid>/inline)`). The route is
 * Bearer-only, so the bytes are fetched with auth and re-served from an
 * object URL — but ONLY when the fetched blob's mime essence is a
 * non-scripting image (B1: html/svg never blob-render). Anything else (http
 * error, pdf, svg, …) falls back to the FileLinkCard.
 *
 * Click-to-expand (ticket c6e8edda): the resolved image opens an
 * ImageLightbox with the same blob objectURL (backdrop/Esc close) — the
 * cursor-zoom-in affordance + title hint advertise it. `className`
 * overrides the default markdown sizing so the transcript's attachment
 * chips can render a capped thumbnail (max-h-48) through the same
 * authed/mime-gated path.
 *
 * Under SSR the effect never runs, so the static markup is the loading
 * placeholder — a reserved min-height keeps the stream from jumping when the
 * image resolves.
 */
export function AuthedFileImage({
  target,
  alt,
  className,
}: {
  /** A chat-file byte route, or a generated file's INLINE route (2026-09-24 —
   *  generated images; the server 415s non-images there, so the same fetched-
   *  mime gate applies). */
  target: AuthedImageTarget;
  alt?: string;
  /** Overrides the default `max-w-full h-auto rounded-lg` image sizing. */
  className?: string;
}) {
  const { id, route, kind } = target;
  const [state, setState] = useState<AuthedImageState>({ status: 'loading' });
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchFileBlob(kind === 'generated' ? { kind, id, route: 'inline' } : { kind, id, route })
      .then((blob) => {
        if (cancelled) return;
        if (!blob || !isBlobRenderableImage(blob.type)) {
          setState({ status: 'error' });
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setState({ status: 'ready', url: objectUrl, mime: blob.type });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kind, id, route]);

  // Ticket 390b6767 — the action row's Download. Same authed fetch → blob →
  // <a download> flow as FileLinkCard / GeneratedImageActions, wired by kind
  // (chatFilesApi.download vs filesApi.downloadGenerated).
  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    try {
      const actions = imageActionsFor(target, alt, state.status === 'ready' ? state.mime : undefined);
      if (actions.downloadApi === 'generated') {
        await filesApi.downloadGenerated(target.id, actions.filename);
      } else {
        await chatFilesApi.download(target.id, actions.filename);
      }
    } catch {
      toast.error('Failed to download image');
    } finally {
      setBusy(false);
    }
  }

  if (state.status === 'ready') {
    const actions = imageActionsFor(target, alt, state.mime);
    return (
      <>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title={actions.openLabel}
          aria-label={actions.openLabel}
          className="cursor-zoom-in"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.url}
            alt={alt || ''}
            data-authed-file-image="ready"
            className={className ?? 'max-w-full h-auto rounded-lg my-3'}
          />
        </button>
        {/* Ticket 390b6767: explicit Download / View-full-size row (the
            GeneratedImageActions ghost-button idiom) — the image must not
            hide its affordances behind the click affordance alone. Download
            rides the authed fetch → blob → <a download> flow (the Bearer
            route 401s on a bare navigation); View opens the same-blob
            lightbox as the click affordance (the chat-file inline route is
            Bearer-only, so there is no popup-safe new-tab URL). */}
        <div className="mt-1 flex items-center gap-0.5" data-authed-image-actions={id}>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            title={actions.downloadLabel} aria-label={actions.downloadLabel}
            disabled={busy} onClick={() => void handleDownload()}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            title={actions.openLabel} aria-label={actions.openLabel}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        {expanded && <ImageLightbox src={state.url} alt={alt} onClose={() => setExpanded(false)} />}
      </>
    );
  }
  if (state.status === 'error') {
    return <FileLinkCard filename={alt?.trim() || 'Attached file'} target={target} />;
  }
  return (
    <span
      data-authed-file-image="loading"
      role="img"
      aria-label={alt || 'Loading attached image'}
      className="my-3 flex min-h-24 w-full max-w-md items-center justify-center rounded-lg border bg-muted/30"
    >
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
    </span>
  );
}

// ─── AuthedImageLightbox ─────────────────────────────────────────────────────

/**
 * Full-size preview of an authed image target WITHOUT a thumbnail — the
 * Files sidebar / Files page "Preview" (Eye) action on a generated image row
 * (2026-09-24). Same authed fetch → blob → objectURL path and the same B1
 * mime gate as AuthedFileImage; a non-image or failed fetch toasts and
 * closes (never a blank dialog). Mounted only after the click, so SSR markup
 * never carries the dialog.
 */
export function AuthedImageLightbox({
  target,
  alt,
  onClose,
}: {
  target: AuthedImageTarget;
  alt?: string;
  onClose: () => void;
}) {
  const { id, route, kind } = target;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchFileBlob(kind === 'generated' ? { kind, id, route: 'inline' } : { kind, id, route })
      .then((blob) => {
        if (cancelled) return;
        if (!blob || !isBlobRenderableImage(blob.type)) {
          toast.error('Failed to preview image');
          onClose();
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error('Failed to preview image');
        onClose();
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // onClose is read once per fetch outcome; a new identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, route]);

  if (!url) {
    return (
      <span
        data-authed-image-lightbox="loading"
        role="status"
        aria-label={alt ? `Loading ${alt}` : 'Loading image'}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
        onClick={onClose}
      >
        <Loader2 className="h-6 w-6 animate-spin text-white" aria-hidden />
      </span>
    );
  }
  return <ImageLightbox src={url} alt={alt} onClose={onClose} />;
}
