'use client';

/**
 * ExpandableDataImage — click-to-expand wrapper for base64 data-URL image
 * parts in transcript rows (ticket c6e8edda follow-up): assistant image parts
 * (code-transcript AssistantParts) and user attachment echoes
 * (CodeSessionView history rows + queued echoes) all carried a plain <img>
 * with no lightbox. Extracted so the three sites can never diverge — the same
 * reason TranscriptAttachmentChips exists.
 *
 * Rendering contract (mirrors markdown-content's ExpandableImage):
 *   - The thumbnail keeps the CALLER's exact classes (each surface caps its
 *     own sizing, e.g. max-h-48); the wrapper only adds the zoom affordance.
 *   - A click opens the shared ImageLightbox with the raw data URL (a data:
 *     src works as-is in the dialog — no fetch, no object URL).
 *   - Collapsed on first render: the dialog mounts only after a real click,
 *     so SSR markup is just the trigger button + <img> (the repo's
 *     node-environment renderToStaticMarkup idiom asserts exactly that).
 */

import { useState } from 'react';
import { ImageLightbox } from './image-lightbox';

export function ExpandableDataImage({
  src,
  alt,
  className,
}: {
  /** The data: URL (or any directly renderable src) to show. */
  src: string;
  alt?: string;
  /** The thumbnail's sizing classes — passed through untouched. */
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandLabel = alt?.trim() ? `Expand image: ${alt.trim()}` : 'Expand image';
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={expandLabel}
        aria-label={expandLabel}
        className="cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt || ''} className={className} />
      </button>
      {expanded && <ImageLightbox src={src} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  );
}
