'use client';

/**
 * Generated images on a PUBLIC shared chat (generate_image tranche B,
 * 2026-09-24) — rendered under an answer's markdown as framed figures in the
 * chat transcript's idiom (code-transcript.tsx, data-image-source="generated":
 * bordered thumbnail, caption, lightbox on click) MINUS the owner-only
 * Download / Open row, which targets the authed /generated-files routes a
 * link viewer cannot reach.
 *
 * Every figure loads from the token-scoped public byte route
 * (sharingApi.sharedChatImageUrl → GET /shared/chat/:token/image/:fileId);
 * the payload never carries base64 and this component never builds a data:
 * URL — only `fileId` (and the caption) is read from each entry. Colocated
 * with page.tsx rather than exported from it: a page file may export only
 * Next's route fields.
 */

import { ExpandableDataImage } from '@/components/ui/custom/prompt/expandable-data-image';
import { sharingApi, type SharedChatImage } from '@/lib/api/crossmodel';

export function SharedChatImages({ token, images }: { token: string; images?: SharedChatImage[] | null }) {
  const list = Array.isArray(images)
    ? images.filter((img) => !!img && typeof img.fileId === 'string' && img.fileId.length > 0)
    : [];
  if (!list.length) return null;
  return (
    <div className="px-5 pb-4 flex flex-wrap gap-3" data-shared-chat-images={list.length}>
      {list.map((img) => {
        const caption = img.name || 'Generated image';
        return (
          <figure key={img.fileId} className="my-1 inline-block max-w-full" data-image-source="generated">
            <ExpandableDataImage
              src={sharingApi.sharedChatImageUrl(token, img.fileId)}
              alt={caption}
              className="max-h-72 max-w-full rounded-lg border border-border object-contain"
            />
            <figcaption className="mt-1 text-[10px] text-muted-foreground/80">{caption}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
