'use client';

import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { featureRequestApi, FeatureRequest, FeatureRequestType, FeatureRequestCounts } from '@/lib/api/crossmodel';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { Loader2, CheckCircle2, Clock, Zap, Sparkles, Check, MessageCircle, RefreshCw, ImagePlus, X, Send } from 'lucide-react';
import { RequestTimestamps, formatFeedbackStamp, shouldShowUpdatedStamp } from './feedback-timestamps';

// ── Image helpers ─────────────────────────────────────────────────────────────

const IMAGE_DELIMITER = '\n\n---IMAGES---\n';
// Owner directive 2026-09-13: "we want to allow more than just 3 screenshots
// for tickets". 8 matches the chat/coding uploadId cap convention; at the 5 MB
// per-image ceiling the packed description stays under the backend's 75 MB
// express json limit (8 × 5 MB raw ≈ 53 MB base64). Exported for the test pin.
export const MAX_IMAGES = 8;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB per image

/** Convert a File to a base64 data URL */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Pack description + base64 images into a single string for storage */
function packDescription(text: string, images: string[]): string {
  if (images.length === 0) return text;
  return text + IMAGE_DELIMITER + images.join('\n');
}

/** Unpack a stored description into text + image data URLs */
function unpackDescription(raw: string): { text: string; images: string[] } {
  const idx = raw.indexOf(IMAGE_DELIMITER);
  if (idx === -1) return { text: raw, images: [] };
  const text = raw.slice(0, idx);
  const imagesStr = raw.slice(idx + IMAGE_DELIMITER.length);
  const images = imagesStr.split('\n').filter(s => s.startsWith('data:image/'));
  return { text, images };
}

const TYPE_OPTIONS: { value: FeatureRequestType; label: string; desc: string; emoji: string }[] = [
  { value: 'feature_request', label: 'Feature Request',    desc: 'Suggest a new capability',       emoji: '💡' },
  { value: 'bug_report',      label: 'Bug Report',         desc: 'Something isn\'t working right', emoji: '🐛' },
  { value: 'general_feedback', label: 'General Feedback',  desc: 'Share thoughts or ideas',        emoji: '💬' },
];

const STATUS_BADGE: Record<string, { label: string; variant: 'info' | 'warning' | 'success'; icon: React.ElementType }> = {
  open:        { label: 'Open',        variant: 'info',    icon: Clock        },
  in_progress: { label: 'In Progress', variant: 'warning', icon: Zap          },
  done:        { label: 'Done ✓',      variant: 'success', icon: CheckCircle2 },
  // Ticket 6665fff6 (done-bar lifecycle): a metric-carrying ticket hands its
  // terminal transition to the post-deploy verifier — these states must render
  // as themselves, never fall through to the "Open" badge (review A1).
  awaiting_verification: { label: 'Verifying',  variant: 'info',    icon: Clock        },
  deployed_verified:     { label: 'Verified ✓', variant: 'success', icon: CheckCircle2 },
  reopened:              { label: 'Reopened',   variant: 'warning', icon: RefreshCw    },
};

const TYPE_LABEL: Record<string, string> = {
  feature_request:  'Feature',
  bug_report:       'Bug',
  general_feedback: 'Feedback',
  mishap:           'Mishap',
  enhancement:      'Enhancement',
  research_idea:    'Research',
};

const TYPE_EMOJI: Record<string, string> = {
  feature_request:  '💡',
  bug_report:       '🐛',
  general_feedback: '💬',
  mishap:           '⚠️',
  enhancement:      '✨',
  research_idea:    '🔬',
};

/**
 * One submission row (ticket d578fed5 — the feedback-UI typing-lag fix).
 * This tree used to render inline inside FeedbackTab, which also owns the
 * controlled title/description fields: every keystroke re-rendered the WHOLE
 * tab, re-running unpackDescription() on every row — descriptions pack base64
 * screenshots (then capped at 3, now MAX_IMAGES=8; the reporter's list alone
 * totals ~10 MB) — plus
 * per-row Intl timestamp formatting, across up to 500 rows per keystroke.
 * That was the seconds-long lag between typing and text appearing.
 *
 * The row is memo()ized and takes only its request object, two booleans, and
 * STABLE callbacks from the parent, so keystrokes in the form no longer
 * re-render any row. The parent must keep the callback props referentially
 * stable (useCallback, no inline arrows) or memo is defeated.
 */
export const FeedbackRequestRow = memo(function FeedbackRequestRow({
  req, resolving, expanded, onToggleImages, onResolve,
}: {
  req: FeatureRequest;
  /** true while this row's own "Mark as Resolved" request is in flight */
  resolving: boolean;
  /** true while this row's attached images are expanded */
  expanded: boolean;
  /** stable (useCallback) toggler — takes the row id */
  onToggleImages: (id: string) => void;
  /** stable (useCallback) resolver — takes the row's request object */
  onResolve: (req: FeatureRequest) => void;
}) {
  const badge = STATUS_BADGE[req.status] || STATUS_BADGE.open;
  const BadgeIcon = badge.icon;
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-base leading-none">{TYPE_EMOJI[req.type] || '📝'}</span>
              <span className="text-[12px] font-medium text-ink-3">
                {TYPE_LABEL[req.type] || req.type}
              </span>
              <Badge variant={badge.variant} className="rounded-full text-[10px] px-1.5 py-0.5">
                <BadgeIcon className="size-3" />
                {badge.label}
              </Badge>
              {req.title.startsWith('In-chat feedback:') && (
                <Badge variant="warning" className="rounded-full text-[10px] px-1.5 py-0.5">
                  <MessageCircle className="size-3" />
                  from chat
                </Badge>
              )}
              {req.source === 'agent' && (
                <Badge variant="outline" className="rounded-full text-[10px] px-1.5 py-0.5 border-line bg-active text-ink">
                  <Sparkles className="size-3" />
                  filed by Digby
                </Badge>
              )}
              {(req.occurrences ?? 1) > 1 && (
                <Badge variant="outline" className="rounded-full text-[10px] px-1.5 py-0.5 border-warn/40 bg-warn/10 text-warn-ink dark:bg-warn/15" title={`Sighted ${req.occurrences} times — a recurring issue, not a one-off`}>
                  <RefreshCw className="size-3" />
                  ×{req.occurrences}
                </Badge>
              )}
            </div>
            <p className="text-sm font-medium truncate">{req.title}</p>
          </div>
          <RequestTimestamps
            createdAt={req.createdAt}
            updatedAt={req.updatedAt}
            className="text-[10px] text-muted-foreground flex-shrink-0 mt-1 text-right leading-tight"
          />
        </div>
        {(() => {
          const { text: descText, images: descImages } = unpackDescription(req.description);
          return (
            <>
              <p className="text-xs text-muted-foreground line-clamp-2 [overflow-wrap:anywhere]">{descText}</p>
              {descImages.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => onToggleImages(req.id)}
                    className="inline-flex items-center gap-1 text-[10px] font-medium text-brand-text hover:underline"
                  >
                    <ImagePlus className="size-3" />
                    {descImages.length} image{descImages.length > 1 ? 's' : ''} attached
                    <span className="text-[9px]">{expanded ? '▲' : '▼'}</span>
                  </button>
                  {expanded && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {descImages.map((src, i) => (
                        <a key={i} href={src} target="_blank" rel="noopener noreferrer">
                          <img
                            src={src}
                            alt={`Attachment ${i + 1}`}
                            className="h-24 w-auto rounded-md border object-cover hover:opacity-80 transition-opacity cursor-zoom-in"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Status indicator / Digby response */}
      {req.status === 'in_progress' ? (
        // Always show "working on it" for in_progress — never show raw internal adminNote
        <div className="px-4 py-3 border-t bg-warn/6 dark:bg-warn/8 border-warn/40 dark:border-warn/30">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Loader2 className="size-3.5 text-warn-ink animate-spin flex-shrink-0" />
              <p className="text-xs text-warn-ink">
                In progress — the Digby team is on this…
              </p>
            </div>
            <button
              onClick={() => onResolve(req)}
              disabled={resolving}
              className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border border-ok/40 text-success-strong hover:bg-success-soft transition-colors disabled:opacity-50"
            >
              {resolving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
              Mark as Resolved
            </button>
          </div>
        </div>
      ) : (() => {
        // For open/done: filter out internal messages before displaying
        const note = req.adminNote;
        const isInternal = !note
          || note.startsWith('Kanban task created:')
          || note.startsWith('Awaiting clarification from admin')
          || note.includes('kanban_task:')
          || note.includes('awaiting_clarification')
          || /^retries:\d+$/m.test(note.trim());

        return (
          <>
            {!isInternal && note && (
              <div className="px-4 py-3 border-t bg-brand-faint border-brand-muted dark:border-brand-dim/30">
                <div className="flex items-start gap-2">
                  <div className="flex-shrink-0 mt-0.5">
                    <div className="size-5 rounded-full bg-active text-ink-2 flex items-center justify-center">
                      <Sparkles className="size-3 text-brand-text" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-brand-text mb-1">
                      Digby's Response
                      {shouldShowUpdatedStamp(req.createdAt, req.updatedAt) && (
                        <span className="ml-1.5 font-normal normal-case tracking-normal text-ink-3">
                          · {formatFeedbackStamp(req.updatedAt as string)}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]">{note}</p>
                  </div>
                </div>
              </div>
            )}
            {req.status !== 'done' && (
              <div className="px-4 py-2 border-t flex justify-end">
                <button
                  onClick={() => onResolve(req)}
                  disabled={resolving}
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border border-ok/40 text-success-strong hover:bg-success-soft transition-colors disabled:opacity-50"
                >
                  {resolving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                  Mark as Resolved
                </button>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
});

export function FeedbackTab() {
  const [type, setType] = useState<FeatureRequestType>('feature_request');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<string[]>([]); // base64 data URLs
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);
  // The real Submit button is off-screen BELOW the viewport (the form is still
  // being filled) — never "above", which means the reader scrolled past the
  // form to their submissions (owner 2026-10-07: "weird floating submit button
  // on feedback tab").
  const [submitBelow, setSubmitBelow] = useState(false);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  /** A field inside the form has focus (the user is writing feedback). */
  const [formFocused, setFormFocused] = useState(false);

  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [counts, setCounts] = useState<FeatureRequestCounts | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [loadRequestsError, setLoadRequestsError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [expandedImages, setExpandedImages] = useState<string | null>(null); // request id with expanded images

  const fetchRequests = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const data = await featureRequestApi.list();
      setRequests(data.requests);
      setCounts(data.counts ?? null);
      setTruncated(!!data.truncated);
      setLoadRequestsError(false);
    } catch {
      // Honest failure — never render "No submissions yet" over an errored fetch.
      setLoadRequestsError(true);
    }
    finally {
      setLoadingRequests(false);
      setRefreshing(false);
    }
  }, []);

  // Fetch on mount
  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // Re-fetch when tab becomes visible (user switches back from chat)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchRequests(true);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [fetchRequests]);

  // ── Sticky submit bar: track whether the real submit button is visible ────
  // On mobile, the virtual keyboard pushes the submit button off-screen.
  // When it's not visible, we show a fixed bottom bar so users can always submit.
  // We use BOTH IntersectionObserver AND visualViewport to detect this reliably.
  // IntersectionObserver alone fails because it uses the layout viewport (which
  // doesn't shrink when the keyboard opens), so the button appears "visible"
  // even when it's behind the keyboard.
  useEffect(() => {
    const btn = submitBtnRef.current;
    if (!btn) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const viewBottom = entry.rootBounds?.bottom ?? window.innerHeight;
        setSubmitBelow(!entry.isIntersecting && entry.boundingClientRect.top >= viewBottom - 1);
      },
      { threshold: 0.1 }
    );
    observer.observe(btn);
    return () => observer.disconnect();
  }, []);

  // Track focus inside the form — the keyboard case only counts while the user
  // is typing feedback (not, e.g., in an unrelated field elsewhere).
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onIn = () => setFormFocused(true);
    const onOut = () => {
      // focusout fires before the next focusin — check after the move settles.
      window.setTimeout(() => setFormFocused(!!form.contains(document.activeElement)), 0);
    };
    form.addEventListener('focusin', onIn);
    form.addEventListener('focusout', onOut);
    return () => { form.removeEventListener('focusin', onIn); form.removeEventListener('focusout', onOut); };
  }, []);

  // ── Keyboard detection via visualViewport ──────────────────────────────────
  // When the virtual keyboard opens, visualViewport.height shrinks significantly
  // (typically 40-60% of the full height). We use this to show the sticky bar.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const threshold = 0.75; // keyboard is "open" when visual viewport < 75% of outer height
    const handleResize = () => {
      const ratio = vv.height / window.innerHeight;
      setIsKeyboardOpen(ratio < threshold);
    };
    vv.addEventListener('resize', handleResize);
    // Check initial state
    handleResize();
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  // ── Image handling ─────────────────────────────────────────────────────────
  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const remaining = MAX_IMAGES - images.length;
    if (remaining <= 0) {
      setError(`Maximum ${MAX_IMAGES} images allowed.`);
      return;
    }
    const selected = Array.from(files).slice(0, remaining);
    const oversized = selected.filter(f => f.size > MAX_IMAGE_SIZE);
    if (oversized.length > 0) {
      setError(`Images must be under 5 MB each. ${oversized.map(f => f.name).join(', ')} too large.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setError('');
    try {
      const dataUrls = await Promise.all(selected.map(fileToDataUrl));
      setImages(prev => [...prev, ...dataUrls].slice(0, MAX_IMAGES));
    } catch {
      setError('Failed to read image file.');
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  // Core submit logic — called by both the form onSubmit and the sticky bar button.
  // Separated from the form event handler so the sticky bar doesn't need requestSubmit().
  // IMPORTANT: This must NEVER be gated behind a disabled button on mobile — the
  // validation logic here scrolls to the first empty field and shows an error message.
  // If the button is disabled, tapping it does nothing and the user is stuck.
  const doSubmit = useCallback(async () => {
    if (submitting) return;
    if (!title.trim() || !description.trim()) {
      setError(!title.trim() ? 'Please add a title.' : 'Please add a description.');
      // Scroll to and focus the first empty field so the user knows what's missing
      if (!title.trim() && titleInputRef.current) {
        titleInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => titleInputRef.current?.focus(), 300);
      } else if (!description.trim() && descInputRef.current) {
        descInputRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => descInputRef.current?.focus(), 300);
      }
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const packedDesc = packDescription(description.trim(), images);
      const newRequest = await featureRequestApi.submit({ type, title: title.trim(), description: packedDesc });
      setRequests(prev => [newRequest, ...prev]);
      setTitle('');
      setDescription('');
      setImages([]);
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 3000);
    } catch {
      setError('Failed to submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [submitting, title, description, images, type]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  // Split into sections for easier reading. The 6665fff6 lifecycle states fold
  // into the section a reader expects (review A1 — before this, an
  // awaiting_verification ticket rendered in NO section and a reopened one was
  // invisible): awaiting → In Progress (merged, verifier measuring),
  // reopened → Pending Review (owed work again), deployed_verified → Completed.
  const openRequests = useMemo(() => requests.filter(r => r.status === 'open' || r.status === 'reopened'), [requests]);
  const activeRequests = useMemo(() => requests.filter(r => r.status === 'in_progress' || r.status === 'awaiting_verification'), [requests]);
  const doneRequests = useMemo(() => requests.filter(r => r.status === 'done' || r.status === 'deployed_verified'), [requests]);

  const handleResolve = useCallback(async (req: FeatureRequest) => {
    setResolvingId(req.id);
    try {
      const updated = await featureRequestApi.resolve(req.id);
      setRequests(prev => prev.map(r => r.id === req.id ? updated : r));
    } catch { toast.error('Could not mark as resolved — please try again.'); }
    finally { setResolvingId(null); }
  }, []);

  // Stable toggler for a row's attached-images disclosure. Must stay
  // useCallback-stable: FeedbackRequestRow is memo()ized and an inline arrow
  // here would give every row a new prop identity on each keystroke,
  // re-rendering the whole list (ticket d578fed5 regression).
  const handleToggleImages = useCallback((id: string) => {
    setExpandedImages(prev => (prev === id ? null : id));
  }, []);

  const renderRequest = (req: FeatureRequest) => (
    <FeedbackRequestRow
      key={req.id}
      req={req}
      resolving={resolvingId === req.id}
      expanded={expandedImages === req.id}
      onToggleImages={handleToggleImages}
      onResolve={handleResolve}
    />
  );

  const hasDraft = !!(title.trim() || description.trim() || images.length);
  const showStickySubmit = !submitted && ((isKeyboardOpen && formFocused) || (submitBelow && hasDraft));

  return (
    <div className="space-y-8 pb-16 sm:pb-0">
      {/* Submit form */}
      <div>
        <h2 className="text-sm font-semibold mb-1">Share Feedback</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Feature requests and bug reports are reviewed by the Digby team. You'll see a response below each submission as it's addressed.
        </p>

        <form ref={formRef} onSubmit={handleSubmit} className="space-y-4">
          {/* Type selector — compact pill row on mobile, full cards on desktop */}
          {/* Mobile: horizontal pill buttons (saves ~120px vertical space) */}
          <div className="flex gap-2 md:hidden">
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setType(opt.value)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 rounded-full border px-3 py-2.5 text-xs font-medium transition-colors',
                  type === opt.value
                    ? 'border-line-2 bg-active text-ink'
                    : 'border-border text-muted-foreground active:bg-muted/50'
                )}
              >
                <span>{opt.emoji}</span>
                <span>{opt.label.split(' ')[0]}</span>
              </button>
            ))}
          </div>
          {/* Desktop: full radio cards */}
          <div className="hidden md:flex md:flex-col gap-2">
            {TYPE_OPTIONS.map(opt => (
              <label
                key={opt.value}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors',
                  type === opt.value
                    ? 'border-brand-accent bg-brand-soft'
                    : 'border-border hover:bg-muted/50'
                )}
              >
                <input
                  type="radio"
                  name="feedbackType"
                  value={opt.value}
                  checked={type === opt.value}
                  onChange={() => setType(opt.value)}
                  className="accent-brand-accent"
                />
                <span className="text-xl">{opt.emoji}</span>
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-xs text-muted-foreground">{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">Title <span className="text-destructive">*</span></label>
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={e => { setTitle(e.target.value); if (error) setError(''); }}
              onKeyDown={e => {
                // On mobile, pressing "Next"/"Go" on the keyboard moves to description
                if (e.key === 'Enter') {
                  e.preventDefault();
                  descInputRef.current?.focus();
                }
              }}
              enterKeyHint="next"
              placeholder={
                type === 'feature_request' ? 'e.g. Add dark mode for canvas panel' :
                type === 'bug_report'      ? 'e.g. Canvas doesn\'t save on mobile' :
                                            'Brief summary…'
              }
              maxLength={120}
              className={cn(
                'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-ring',
                error && !title.trim() && 'border-destructive ring-1 ring-destructive/30'
              )}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">Description <span className="text-destructive">*</span></label>
            <textarea
              ref={descInputRef}
              value={description}
              onChange={e => { setDescription(e.target.value); if (error) setError(''); }}
              placeholder={
                type === 'feature_request' ? 'What should it do? Why is it useful?' :
                type === 'bug_report'      ? 'What happened? What did you expect? Steps to reproduce?' :
                                            'Share your thoughts…'
              }
              rows={4}
              maxLength={2000}
              className={cn(
                'w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand-ring resize-none',
                error && title.trim() && !description.trim() && 'border-destructive ring-1 ring-destructive/30'
              )}
            />
            <p className="text-xs text-muted-foreground text-right">{description.length}/2000</p>
          </div>

          {/* Image upload */}
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-ink-3">
              Screenshots <span className="normal-case font-normal">(optional, up to {MAX_IMAGES})</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={handleImageSelect}
              className="hidden"
            />
            {/* Image previews */}
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {images.map((src, i) => (
                  <div key={i} className="relative group">
                    <img
                      src={src}
                      alt={`Upload ${i + 1}`}
                      className="size-20 rounded-md border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(i)}
                      className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity shadow-sm"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {images.length < MAX_IMAGES && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-dashed rounded-md px-3 py-2 transition-colors hover:border-brand-ring"
              >
                <ImagePlus className="size-3.5" />
                Add image{images.length > 0 ? ` (${images.length}/${MAX_IMAGES})` : ''}
              </button>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* Submit button — NEVER disabled on mobile. doSubmit() handles validation
              and scrolls to the first empty field with an error message. A disabled button
              on mobile is a dead end — the user taps it, nothing happens, no feedback. */}
          <button
            ref={submitBtnRef}
            type="submit"
            disabled={submitting}
            className={cn(
              'w-full h-10 rounded-lg text-sm font-medium transition-all',
              submitted
                ? 'bg-success-accent text-white'
                : (!title.trim() || !description.trim())
                  ? 'bg-send text-send-ink opacity-60 active:opacity-100'
                  : 'bg-send text-send-ink hover:opacity-90 active:opacity-90',
              submitting && 'opacity-50 cursor-not-allowed'
            )}
          >
            {submitting ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Submitting…
              </span>
            ) : submitted ? (
              <span className="flex items-center justify-center gap-2">
                <CheckCircle2 className="size-4" />
                Submitted! Thanks 🙏
              </span>
            ) : (
              'Submit'
            )}
          </button>
        </form>
      </div>

      {/* Sticky submit bar (mobile only) — shown while the user is WRITING
          feedback and the real Submit button is out of reach: the keyboard is
          open over a focused form field, or the button sits below the
          viewport with something typed. Never while the reader scrolled down
          to their submissions (the button is then ABOVE the viewport) — owner
          2026-10-07: "weird floating submit button on feedback tab". Portaled
          to <body> so `fixed bottom-0` is the real screen bottom (the account
          page's scroll container must not become its containing block).
          NEVER disabled — doSubmit() validates and scrolls to the first empty
          field. Calls doSubmit() directly instead of requestSubmit() —
          requestSubmit() is unreliable on some mobile browsers. */}
      {showStickySubmit && typeof document !== 'undefined' && createPortal(
        <div
          data-feedback-sticky-submit
          className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 px-4 pt-3 md:hidden"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0.75rem))' }}
        >
          <button
            type="button"
            disabled={submitting}
            onMouseDown={(e) => e.preventDefault() /* keep the field focused until we submit */}
            onClick={() => {
              // Blur any focused input to dismiss the keyboard first
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
              // Small delay to let the keyboard dismiss, then submit directly
              setTimeout(() => {
                doSubmit();
              }, 100);
            }}
            className={cn(
              'w-full h-12 rounded-full text-sm font-semibold transition-all flex items-center justify-center gap-2 bg-send text-send-ink active:opacity-90',
              (!title.trim() || !description.trim()) && 'opacity-60',
              submitting && 'opacity-50 cursor-not-allowed'
            )}
          >
            {submitting ? (
              <><Loader2 className="size-4 animate-spin" /> Submitting…</>
            ) : (
              <><Send className="size-4" /> Submit</>
            )}
          </button>
        </div>,
        document.body,
      )}

      {/* Previous submissions */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold">Your Submissions</h2>
          <button
            onClick={() => fetchRequests(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            title="Refresh submissions"
          >
            <RefreshCw className={cn('size-3', refreshing && 'animate-spin')} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Track the status of your requests — including in-chat feedback (👎). We review submissions and update each one as it's addressed.
        </p>
        {/* Loaded-with-error: keep the last known submissions visible, but say so. */}
        {loadRequestsError && requests.length > 0 && (
          <p className="text-xs text-destructive mb-3">Couldn't refresh — showing the last loaded submissions.</p>
        )}

        {loadingRequests ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : requests.length === 0 && loadRequestsError ? (
          <LoadErrorState message="Couldn't load your submissions." onRetry={() => fetchRequests(true)} retrying={refreshing} className="py-6" />
        ) : requests.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">
            No submissions yet. Be the first to share feedback!
          </p>
        ) : (
          <div className="space-y-6">
            {/* In Progress — show first since they're actively being worked on. Counts are
                section-truthful post-6665fff6: awaiting_verification rows ride this section. */}
            {activeRequests.length > 0 && (
              <div className="space-y-2">
                <p className="text-[12px] font-medium text-warn-ink flex items-center gap-1.5">
                  <Zap className="size-3" />
                  In Progress ({(counts?.in_progress ?? 0) + (counts?.awaiting_verification ?? 0) > 0 ? (counts?.in_progress ?? 0) + (counts?.awaiting_verification ?? 0) : activeRequests.length})
                </p>
                {activeRequests.map(renderRequest)}
              </div>
            )}

            {/* Open / Reopened — awaiting review (a verifier-reopened row is owed work again) */}
            {openRequests.length > 0 && (
              <div className="space-y-2">
                <p className="text-[12px] font-medium text-ink-2 flex items-center gap-1.5">
                  <Clock className="size-3" />
                  Pending Review ({(counts?.open ?? 0) + (counts?.reopened ?? 0) > 0 ? (counts?.open ?? 0) + (counts?.reopened ?? 0) : openRequests.length})
                </p>
                {openRequests.map(renderRequest)}
              </div>
            )}

            {/* Done / Deployed-verified */}
            {doneRequests.length > 0 && (
              <div className="space-y-2">
                <p className="text-[12px] font-medium text-success flex items-center gap-1.5">
                  <CheckCircle2 className="size-3" />
                  Completed ({(counts?.done ?? 0) + (counts?.deployed_verified ?? 0) > 0 ? (counts?.done ?? 0) + (counts?.deployed_verified ?? 0) : doneRequests.length})
                </p>
                {doneRequests.map(renderRequest)}
              </div>
            )}

            {truncated && (
              <p className="text-[11px] text-muted-foreground text-center pt-2">
                Showing your {requests.length} most recent of {counts?.total ?? requests.length} total submissions.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
