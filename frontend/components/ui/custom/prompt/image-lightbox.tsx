'use client';

/**
 * ImageLightbox — click-to-expand overlay for inline chat images (ticket
 * c6e8edda). No lightbox/zoom component existed anywhere before this one.
 *
 * Deliberately plain (no portal, no zoom controls):
 *   - A fixed inset-0 z-50 black/80 backdrop with the image centered at up to
 *     95vw/95vh (object-contain — the full image is always visible).
 *   - Closes on a BACKDROP click (a click landing on the image itself does
 *     not dismiss), on Escape, and on the top-right close button.
 *   - Body scroll is locked while open and restored on close; focus moves
 *     into the dialog on open and returns to the previously focused element
 *     on close (role="dialog" aria-modal basics).
 *   - Rendered inline (NOT createPortal): the repo's component tests run
 *     under the node-environment SSR idiom (renderToStaticMarkup — no
 *     jsdom), which a portal target cannot survive; z-50 + fixed positioning
 *     is sufficient inside every chat surface's stacking contexts.
 *
 * Testability: the close DECISIONS are exported pure helpers
 * (lightboxKeyCloses / isBackdropSelfClick) — the SSR idiom can't fire DOM
 * key/click events, so the interactive contract is pinned at the logic
 * level, exactly like file-link-card's fetchChatFileBlob.
 */

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/** Escape is the only key that closes the lightbox. */
export function lightboxKeyCloses(key: string): boolean {
  return key === 'Escape';
}

/**
 * A backdrop click closes ONLY when the press lands on the backdrop element
 * itself — clicks on a child (the image, the close button's own handler)
 * must not double-dismiss.
 */
export function isBackdropSelfClick(target: unknown, currentTarget: unknown): boolean {
  return target != null && target === currentTarget;
}

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  /** The image URL to show full-size — a blob: objectURL or an ordinary src. */
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the mount effect (a streaming
  // transcript re-renders constantly — focus/scroll-lock must happen ONCE).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lightboxKeyCloses(e.key)) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // scroll lock while open
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus(); // focus into the dialog (tabIndex -1 — no ring)
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.(); // return focus to the trigger's neighborhood
    };
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Expanded image: ${alt}` : 'Expanded image'}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 outline-none cursor-zoom-out"
      onClick={(e) => {
        if (isBackdropSelfClick(e.target, e.currentTarget)) onCloseRef.current();
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || ''}
        className="max-w-[95vw] max-h-[95vh] object-contain rounded-lg shadow-2xl"
      />
      <button
        type="button"
        onClick={() => onCloseRef.current()}
        aria-label="Close expanded image"
        title="Close (Esc)"
        className="absolute top-4 right-4 rounded-full bg-black/60 p-2 text-white/90 hover:bg-black/80 hover:text-white transition-colors"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}
