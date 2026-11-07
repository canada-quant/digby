'use client';

/**
 * Chat attachment staging — THE shared upload flow for every chat surface
 * (extracted 2026-08-19 from app/crossmodel/page.tsx so the Management
 * supervisor composer stages uploads IDENTICALLY to the main chat).
 *
 * Pieces:
 *   - AttachmentInfo    — one staged upload (uploadId + display fields).
 *   - AttachmentChips   — the preview bar (thumbnails / icons + remove).
 *   - uploadChatFiles   — two-phase read-then-upload against
 *                         POST /crossmodel/upload (Redis-backed, 15-min TTL).
 *
 * Two-phase ordering is LOAD-BEARING (keep it): Chrome treats a DISABLED
 * <input type="file"> as permission-revoked for all associated File objects —
 * FileReader / arrayBuffer() then throw NotReadableError. Any re-render that
 * disables the picker mid-read (upload-state changes do this) is a hazard, so
 * ALL bytes are read into memory BEFORE any state change; callers hook the
 * boundary with opts.onBytesReady (e.g. to flip an uploading spinner).
 */

import { toast } from 'sonner';
import { Image as ImageIcon, FileText, X } from 'lucide-react';

export interface AttachmentInfo {
  uploadId: string;
  filename: string;
  /** Backend-assigned: 'image' | 'pdf' | 'document'. */
  type: string;
  /** Server preview (data: URL fragment for images). */
  preview: string;
  /** Blob URL for immediate image thumbnail display. */
  localPreview?: string;
  /** Declared MIME type (images only) — needed to hand the file to a coding session. */
  mimeType?: string;
  /**
   * Raw base64 payload (IMAGES ONLY, ≤5 MB enforced downstream) — retained so a
   * coding-session send can forward the bytes as ChatImage[] without a second
   * fetch (the Redis upload blob expires in 15 min and has no read-back route).
   * Never set for PDFs/documents (they can be 200 MB).
   */
  base64?: string;
}

/** Attachment preview bar chips — every chat surface renders staged uploads
 *  identically (main chat composer, unified view plain mode, Management
 *  supervisor composer). */
export function AttachmentChips({ attachments, onRemove }: { attachments: AttachmentInfo[]; onRemove: (index: number) => void }) {
  if (!attachments.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a, i) => (
        <div key={a.uploadId} className="flex items-center gap-1.5 rounded-xl border bg-muted/40 px-2.5 py-1.5 text-sm max-w-[200px]">
          {a.localPreview
            ? <img src={a.localPreview} alt={a.filename} className="size-7 rounded object-cover flex-shrink-0" />
            : (a.type === 'image'
              ? <ImageIcon className="size-3.5 text-ink-3 flex-shrink-0" />
              : <FileText className="size-3.5 text-ink-3 flex-shrink-0" />)
          }
          <span className="flex-1 truncate text-xs font-medium min-w-0">{a.filename}</span>
          <button onClick={() => onRemove(i)}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive flex-shrink-0" title="Remove">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

// Detect MIME type by extension when the browser doesn't provide one (e.g. .txt
// on some browser/OS combos returns file.type = '' — the backend needs a valid
// MIME to process it).
const EXT_MIME_MAP: Record<string, string> = {
  'txt': 'text/plain', 'csv': 'text/csv', 'json': 'application/json',
  'xml': 'text/xml', 'md': 'text/markdown', 'markdown': 'text/markdown',
  'pdf': 'application/pdf',
  // Ticket 33a742c1: the PLAIN-TEXT family. The pickers have always listed
  // these extensions in `accept` (users CAN choose them), but they were absent
  // here — so a .log/​.out/​.diff declared '' or the browser's
  // 'application/octet-stream' and the upload then depended ENTIRELY on the
  // server byte-sniffing it back to text. Any control byte in the first 8 KB
  // (autosave logs routinely carry them) failed that sniff and the file was
  // rejected AFTER the composer had already shown it attached. Declaring the
  // text type up front routes them through the known-text branch instead.
  'log': 'text/plain', 'out': 'text/plain', 'diff': 'text/plain',
  'patch': 'text/plain',
  'yaml': 'text/plain', 'yml': 'text/plain', 'toml': 'text/plain',
  'ini': 'text/plain', 'cfg': 'text/plain', 'conf': 'text/plain',
  'sh': 'text/plain', 'bash': 'text/plain', 'zsh': 'text/plain',
  'sql': 'text/plain', 'env': 'text/plain',
  'ts': 'text/plain', 'tsx': 'text/plain', 'js': 'text/plain',
  'jsx': 'text/plain', 'mjs': 'text/plain', 'cjs': 'text/plain',
  'py': 'text/plain', 'rb': 'text/plain', 'go': 'text/plain',
  'rs': 'text/plain', 'java': 'text/plain', 'kt': 'text/plain',
  'swift': 'text/plain', 'php': 'text/plain',
  'c': 'text/plain', 'h': 'text/plain', 'cpp': 'text/plain',
  'hpp': 'text/plain', 'cs': 'text/plain',
  'html': 'text/plain', 'htm': 'text/plain', 'css': 'text/plain',
  'scss': 'text/plain', 'less': 'text/plain', 'vue': 'text/plain',
  'svelte': 'text/plain',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Audio (ticket 6c050917): several browsers report file.type = '' for
  // audio — the extension then decides the mime the backend stages.
  'wav': 'audio/wav', 'mp3': 'audio/mpeg', 'm4a': 'audio/mp4',
  'aac': 'audio/aac', 'ogg': 'audio/ogg', 'oga': 'audio/ogg',
  'opus': 'audio/ogg', 'flac': 'audio/flac', 'webm': 'audio/webm',
};

/** One file that failed to stage. Surfaced INLINE by the composer (ticket
 *  33a742c1) — a toast alone let a rejection read as "the file just vanished":
 *  the chip never appeared, the message still sent, and nothing stayed on
 *  screen to explain it. */
export interface AttachmentRejection {
  filename: string;
  reason: string;
}

/**
 * Inline staging-failure notice — renders next to the attachment chips so a
 * rejected file leaves a trace the user can read BEFORE sending, instead of
 * disappearing silently after the upload completes.
 */
export function AttachmentNotice({ rejections, onDismiss }: { rejections: AttachmentRejection[]; onDismiss?: () => void }) {
  if (!rejections.length) return null;
  const names = rejections.slice(0, 3).map((r) => r.filename).join(', ')
    + (rejections.length > 3 ? ` +${rejections.length - 3} more` : '');
  // The first concrete reason is the useful one; the rest are usually the same.
  const reason = rejections[0]?.reason || 'Unsupported file type';
  return (
    <div role="alert" className="flex items-start gap-1.5 rounded-xl border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive max-w-full">
      <span className="flex-1 min-w-0">
        Couldn&apos;t attach {names} — {reason}
      </span>
      {onDismiss && (
        /* type="button" is LOAD-BEARING (review B1, ticket 33a742c1): this
           notice renders inside the composer's <form>, and an unmarked button
           defaults to type="submit" — clicking the X to CLEAR an error would
           submit the draft and send it. */
        <button type="button" onClick={onDismiss} className="p-0.5 rounded hover:bg-destructive/20 flex-shrink-0" title="Dismiss">
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Resolve the MIME the upload route should be told for one file (ticket
 * 33a742c1). A GENERIC declaration ('', 'application/octet-stream') must not
 * win over the extension map: browsers/OSes disagree about plain-text
 * extensions and several declare the generic binary type for `.log`/`.diff`/
 * code files, which used to leave the whole judgement to the server's byte
 * sniff — and a single control byte in the first 8 KB failed that sniff, so a
 * file the picker had accepted was rejected after the composer showed it
 * attached. A CONCRETE declared type (image/audio/pdf/…) still wins, exactly
 * as before; only genuinely unknown extensions fall through to the server's
 * sniff. Pure. Exported for tests.
 */
export function resolveAttachmentMime(fileName: string, declaredMime: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const declared = (declaredMime || '').toLowerCase();
  const isGenericDeclared = declared === '' || declared === 'application/octet-stream';
  if (!isGenericDeclared) return declared;
  return EXT_MIME_MAP[ext] || declared || 'application/octet-stream';
}

/**
 * Read + stage files via POST /crossmodel/upload. Per-file failures toast and
 * are skipped (never thrown); the returned array holds only successful uploads.
 * Never rejects — callers can rely on `await` without try/catch.
 *
 * `opts.onRejected` (ticket 33a742c1) receives one entry per file that did NOT
 * stage, so the composer can keep an INLINE, persistent error next to the
 * chips. Before this, a rejected file produced only a transient toast and no
 * chip — which reads exactly like an attachment silently vanishing after
 * upload while the message still sends.
 */
export async function uploadChatFiles(
  fileList: FileList | File[],
  opts?: { projectId?: string | null; onBytesReady?: () => void; onRejected?: (rejections: AttachmentRejection[]) => void },
): Promise<AttachmentInfo[]> {
  const files = Array.from(fileList);
  if (files.length === 0) return [];

  // ── PHASE 1: Read ALL files to ArrayBuffers BEFORE any state change ──────
  // (see the module header — a mid-read permission revocation is the hazard
  // this ordering defeats).
  type FileReadResult = { file: File; buffer: ArrayBuffer; localPreview?: string };
  const readResults: FileReadResult[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const file of files) {
    const localPreview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
    try {
      const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error(reader.error?.message || 'FileReader error'));
        reader.readAsArrayBuffer(file);
      });
      readResults.push({ file, buffer, localPreview });
    } catch {
      // Common causes: file is an iCloud Drive stub (not downloaded locally),
      // on a network drive, or the OS revoked access mid-read.
      const reason = 'the file could not be read (an iCloud Drive stub or a locked file is the usual cause)';
      rejected.push({ filename: file.name, reason });
      toast.error(
        `Could not read "${file.name}". If it's in iCloud Drive, right-click → Download Now in Finder first.`,
        { duration: 6000 }
      );
      if (localPreview) URL.revokeObjectURL(localPreview);
    }
  }

  if (readResults.length === 0) {
    if (rejected.length) opts?.onRejected?.(rejected);
    return [];
  }

  // ── PHASE 2: All bytes in memory — safe for callers to flip upload state ──
  opts?.onBytesReady?.();
  const token = localStorage.getItem('accessToken');
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  const newItems: AttachmentInfo[] = [];

  for (const { file, buffer, localPreview } of readResults) {
    try {
      const bytes = new Uint8Array(buffer);
      let binaryStr = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        binaryStr += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
      }
      const base64 = btoa(binaryStr);
      // Generic declared types ('', 'application/octet-stream') defer to the
      // extension map — see resolveAttachmentMime (ticket 33a742c1).
      const effectiveMimeType = resolveAttachmentMime(file.name, file.type);
      const res = await fetch(`${apiBase}/crossmodel/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          filename: file.name,
          mimeType: effectiveMimeType,
          base64,
          ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const reason = typeof err?.error === 'string' && err.error ? err.error : 'the upload was refused';
        rejected.push({ filename: file.name, reason });
        toast.error(`${file.name}: ${reason}`);
        if (localPreview) URL.revokeObjectURL(localPreview);
        continue;
      }
      const data = await res.json();
      newItems.push({
        uploadId: data.uploadId, filename: data.filename, type: data.type, preview: data.preview, localPreview,
        // Images keep their bytes client-side for the coding-session handoff.
        ...(data.type === 'image' ? { mimeType: effectiveMimeType, base64 } : {}),
      });
      // 2026-07-08: clearer confirmation that the AI now has access to the file.
      // Re-ask analysis (chat 713e636b) showed a user uploading a document mid-chat,
      // then re-asking the same question because it wasn't obvious Digby could read it.
      toast.success(
        data.type === 'image'
          ? `Attached: ${data.filename}`
          : `📄 ${data.filename} ready — Digby will read it in your next message`
      );
    } catch (err: any) {
      const reason = err?.message || 'the upload failed';
      rejected.push({ filename: file.name, reason });
      toast.error(err.message || `Failed to upload ${file.name}`);
      if (localPreview) URL.revokeObjectURL(localPreview);
    }
  }
  // Ticket 33a742c1: hand every failed file to the composer so it can keep an
  // INLINE notice. Reported AFTER the whole batch (not per file) so a
  // multi-file pick yields one notice, not a toast storm.
  if (rejected.length) opts?.onRejected?.(rejected);
  return newItems;
}
