'use client';

/**
 * FilePreviewModal — in-panel preview overlay for the Files panel
 * (ChatFilesSection) — the in-app answer to "Preview opened a new tab and
 * docx/xlsx couldn't preview at all" (2026-08-31).
 *
 * Same overlay idiom as ImageLightbox (fixed inset-0 z-50, Esc/backdrop/X
 * close, scroll lock, focus in/out, NO portal — the repo's node-env
 * renderToStaticMarkup test idiom can't survive a portal target). The close
 * DECISIONS reuse the lightbox's pure helpers; the per-mime routing decision
 * is the exported pure `previewKindForMime`.
 *
 * Kinds:
 *   - image — AuthedFileImage (Bearer fetch → blob, B1 svg gate, its own
 *     click→lightbox zoom).
 *   - pdf   — the inline byte route fetched authed → blob objectURL in an
 *     <iframe> (a pdf renders natively in every modern browser).
 *   - text  — the /preview-text route (docx→mammoth, xlsx→sheetjs, pdf/text
 *     utf-8) rendered in a scrollable <pre>; a `truncated` flag from the
 *     backend shows an honest "first 50,000 chars" note.
 *
 * Nothing here widens the backend /inline byte allowlist — docx/xlsx never
 * leave the server as bytes, only as extracted text (the stored-XSS guard,
 * B1, stays exactly as it was).
 */

import { useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { chatFilesApi, type ChatFileMeta } from '@/lib/api/crossmodel';
import { AuthedFileImage, fetchChatFileBlob, isBlobRenderableImage } from '@/components/ui/custom/prompt/file-link-card';
import { isBackdropSelfClick, lightboxKeyCloses } from '@/components/ui/custom/prompt/image-lightbox';

// ─── Pure mime routing (unit-tested directly — SSR can't fire fetches) ───────

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

/** Mime essence — parameters/case stripped, mirroring the backend's rule. */
const essence = (m: string) => (m || '').split(';', 1)[0].trim().toLowerCase();

export type PreviewKind = 'image' | 'pdf' | 'text';

/**
 * Which preview path a ChatFile takes in the modal — null when nothing can
 * preview it (the row hides the Preview action). Mirrors the backend
 * /preview-text dispatch (text-extract.ts) + the image/pdf byte routes.
 */
export function previewKindForMime(mimeType: string): PreviewKind | null {
  const m = essence(mimeType);
  // B1: scripting-capable essences never preview (a blob: re-serve carries no
  // sandbox header, and extracted html/svg source in-app is not a feature).
  if (m === 'text/html' || m === 'image/svg+xml') return null;
  // HEIC/HEIF: stored + downloadable, but no browser decodes them — a preview
  // would be a broken-image icon (server-side transcode is a deferred follow-up).
  if (m === 'image/heic' || m === 'image/heif') return null;
  if (isBlobRenderableImage(m)) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return 'text';
  if (m === DOCX_MIME || SHEET_MIMES.has(m)) return 'text';
  return null;
}

/**
 * May "Open in new tab" ride the inline BYTE route for this mime? (The old
 * preview path — kept as a secondary action.) Byte-inline-safe minus the
 * scripting-capable essences (html/svg — the B1 sandbox does NOT propagate to
 * a blob: URL, so those never get the new-tab action here).
 */
export function byteInlineOpenable(mimeType: string): boolean {
  const m = essence(mimeType);
  if (m === 'text/html' || m === 'image/svg+xml') return false;
  return m.startsWith('image/') || m === 'application/pdf' || m.startsWith('text/');
}

// ─── Modal ────────────────────────────────────────────────────────────────────

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'error' };

export function FilePreviewModal({
  file,
  onClose,
}: {
  file: ChatFileMeta;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const kind = previewKindForMime(file.mimeType);

  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState(false);
  const [textState, setTextState] = useState<TextState>({ status: 'loading' });

  // Scroll lock + Esc + focus — identical discipline to ImageLightbox.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightboxKeyCloses(e.key)) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  // pdf → authed byte fetch → objectURL for the iframe.
  useEffect(() => {
    if (kind !== 'pdf') return;
    let cancelled = false;
    let objectUrl: string | null = null;
    fetchChatFileBlob(file.id, 'inline')
      .then((blob) => {
        if (cancelled) return;
        if (!blob) { setPdfError(true); return; }
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setPdfError(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [kind, file.id]);

  // text/docx/xlsx → extracted text from the preview-text route.
  useEffect(() => {
    if (kind !== 'text') return;
    let cancelled = false;
    chatFilesApi.previewText(file.id)
      .then((d) => { if (!cancelled) setTextState({ status: 'ready', text: d.text, truncated: d.truncated }); })
      .catch(() => { if (!cancelled) setTextState({ status: 'error' }); });
    return () => { cancelled = true; };
  }, [kind, file.id]);

  async function handleDownload() {
    try {
      await chatFilesApi.download(file.id, file.filename);
    } catch {
      toast.error('Failed to download file');
    }
  }

  async function handleOpenNewTab() {
    try {
      await chatFilesApi.openInline(file.id);
    } catch {
      toast.error('Failed to open in a new tab');
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${file.filename}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 outline-none"
      onClick={(e) => {
        if (isBackdropSelfClick(e.target, e.currentTarget)) onCloseRef.current();
      }}
    >
      <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl">
        {/* Header — filename + actions */}
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <span className="flex-1 min-w-0 truncate text-sm font-medium" title={file.filename}>
            {file.filename}
          </span>
          {kind && byteInlineOpenable(file.mimeType) && (
            <Button variant="ghost" size="icon" className="size-8" title="Open in new tab" aria-label="Open in new tab"
              onClick={() => void handleOpenNewTab()}>
              <ExternalLink className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-8" title="Download file" aria-label="Download file"
            onClick={() => void handleDownload()}>
            <Download className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" title="Close (Esc)" aria-label="Close preview"
            onClick={() => onCloseRef.current()}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {kind === 'image' && (
            <AuthedFileImage
              target={{ kind: 'chat-file', id: file.id, route: 'inline' }}
              alt={file.filename}
              className="max-w-full max-h-full h-auto rounded-lg object-contain mx-auto"
            />
          )}
          {kind === 'pdf' && (
            pdfError ? (
              <PreviewError filename={file.filename} />
            ) : pdfUrl ? (
              <iframe src={pdfUrl} title={`Preview: ${file.filename}`} className="h-full w-full rounded-lg border" />
            ) : (
              <PreviewLoading />
            )
          )}
          {kind === 'text' && (
            textState.status === 'loading' ? (
              <PreviewLoading />
            ) : textState.status === 'error' ? (
              <PreviewError filename={file.filename} />
            ) : (
              <div>
                {textState.truncated && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Showing the first 50,000 characters — download the file for the full contents.
                  </p>
                )}
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs font-mono text-foreground">
                  {textState.text}
                </pre>
              </div>
            )
          )}
          {kind === null && <PreviewError filename={file.filename} />}
        </div>
      </div>
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading preview" />
    </div>
  );
}

function PreviewError({ filename }: { filename: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
      <p className="text-sm text-muted-foreground">No preview available for {filename}.</p>
      <p className="text-xs text-muted-foreground/70">Download the file instead.</p>
    </div>
  );
}
