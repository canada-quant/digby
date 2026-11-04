'use client';

/**
 * TranscriptAttachmentChips — the user-row attachment chips shared by every
 * chat transcript surface (ticket c6e8edda): the unified view's history rows
 * AND queued echoes (CodeSessionView) plus the Management supervisor thread
 * (SupervisorChatTab). Extracted so the three sites can never diverge.
 *
 * Rendering contract:
 *   - A chip carrying fileId && type 'image' renders an INLINE thumbnail via
 *     AuthedFileImage (authed fetch → blob → objectURL, gated on the FETCHED
 *     mime essence — the B1 invariant lives there, untouched), capped at
 *     max-h-48, click-to-expand through AuthedFileImage's own lightbox.
 *   - Every other chip (no fileId, non-image type, or the client-only
 *     localPreview echo) keeps the pre-existing chip UI EXACTLY: localPreview
 *     thumbnail when present, Paperclip icon otherwise, truncated filename.
 *     The echo-only localPreview path is deliberately NOT touched — an
 *     optimistic bubble shows its blob thumbnail until the server row lands.
 *   - The filename chip ALSO stays beneath an inline-rendered image, so the
 *     name (and its download-adjacent affordance) is never lost.
 *
 * Two chip skins exist and are preserved byte-for-byte via `variant`:
 *   - 'bubble'  — the unified view's bordered muted chip (rounded-xl border
 *                 bg-muted/40 px-2.5 py-1.5 text-xs, h-7 preview, h-3.5 icon).
 *   - 'overlay' — the supervisor bubble's on-violet chip (rounded-lg
 *                 bg-white/15 px-2 py-0.5 text-[11px], h-4 preview, h-3 icon).
 */

import { Paperclip, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AudioFilePlayer, AuthedFileImage } from './file-link-card';

/** The chip shape every transcript surface carries (persisted metadata +
 *  client-only localPreview on optimistic echoes). */
export interface TranscriptAttachmentChip {
  filename: string;
  type: string;
  /** Staged-upload id stamped at send time (backend attachmentMeta). */
  uploadId?: string;
  /** Durable ChatFile id resolved at read time — enables the inline render. */
  fileId?: string;
  /** ChatFile mimeType (injected alongside fileId). */
  mimeType?: string;
  /** CLIENT-ONLY optimistic-echo blob URL — never persisted, never inline. */
  localPreview?: string;
}

/**
 * May this chip render inline as an image? Requires BOTH the durable
 * ChatFile id (the authed byte route's key) and an image-type chip — a
 * localPreview echo is the composer's path and stays a chip thumbnail; a
 * chip whose uploadId matched no ChatFile (expired before persistence)
 * stays a chip too (graceful degradation). Pure — unit-tested directly.
 */
export function isRenderableImageChip(
  chip: Pick<TranscriptAttachmentChip, 'type' | 'fileId'>,
): boolean {
  return chip.type === 'image' && typeof chip.fileId === 'string' && chip.fileId.length > 0;
}

/**
 * May this chip render inline as an AUDIO PLAYER (ticket 6c050917)? An
 * audio-typed chip with a durable fileId — same degradation contract as the
 * image twin: no fileId (legacy row / expired upload) stays a plain chip.
 * Pure — unit-tested directly.
 */
export function isPlayableAudioChip(
  chip: Pick<TranscriptAttachmentChip, 'type' | 'fileId'>,
): boolean {
  return chip.type === 'audio' && typeof chip.fileId === 'string' && chip.fileId.length > 0;
}

const SKIN = {
  bubble: {
    chip: 'inline-flex items-center gap-1.5 rounded-xl border bg-muted/40 px-2.5 py-1.5 text-xs max-w-[200px]',
    preview: 'h-7 w-7 rounded object-cover flex-shrink-0',
    icon: 'h-3.5 w-3.5 text-brand-accent flex-shrink-0',
    label: 'truncate font-medium min-w-0',
  },
  overlay: {
    chip: 'inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-2 py-0.5 text-[11px] font-medium max-w-[180px]',
    preview: 'h-4 w-4 rounded object-cover shrink-0',
    icon: 'h-3 w-3 shrink-0',
    label: 'truncate',
  },
} as const;

export function TranscriptAttachmentChips({
  attachments,
  variant,
  className,
}: {
  attachments: TranscriptAttachmentChip[];
  variant: keyof typeof SKIN;
  /** Layout of the chip row (each surface keeps its own alignment). */
  className?: string;
}) {
  if (!attachments?.length) return null;
  const skin = SKIN[variant];
  return (
    <div className={className}>
      {attachments.map((a, i) => (
        <span key={i} className="inline-flex max-w-full flex-col items-start gap-1">
          {isRenderableImageChip(a) && (
            <AuthedFileImage
              target={{ kind: 'chat-file', id: a.fileId!, route: 'inline' }}
              alt={a.filename}
              className="max-h-48 max-w-full rounded-lg object-contain"
            />
          )}
          {isPlayableAudioChip(a) && (
            <AudioFilePlayer
              target={{ kind: 'chat-file', id: a.fileId!, route: 'inline' }}
              filename={a.filename}
            />
          )}
          <span className={skin.chip}>
            {a.localPreview
              ? <img src={a.localPreview} alt={a.filename} className={skin.preview} />
              : isPlayableAudioChip(a)
                ? <Play className={skin.icon} />
                : <Paperclip className={skin.icon} />}
            <span className={skin.label}>{a.filename}</span>
          </span>
        </span>
      ))}
    </div>
  );
}
