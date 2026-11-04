'use client';

/**
 * ChatComposer — THE one composer for the crossmodel surface (P4, unification
 * plan design question (c)). Extracted from app/crossmodel/page.tsx's chat
 * composer and CodeSessionView's second composer: both surfaces now render this
 * same shell — container, shared ChatComposerTextarea, toolbar, stop/send —
 * with surface-specific controls (attach/mic/folder chip/Code chip, patience
 * control, steer note) passed as slot props.
 *
 * Digby Frontier (2026-10-06): BOTH variants render the same box — radius
 * 24, raised bg, 1px line, var(--shadow) (focus-within: line-2 +
 * var(--shadow-f), 260ms ease-out); the textarea on top (16px/1.5, padding
 * 16px 20px 6px, min-height 64px on home / 30px in a chat, max 220px) and a
 * toolbar below (padding 6px 10px 10px, gap 6px): left = attach (+ effort
 * control), right = mic, then the 36px Send circle (bg-send + ArrowUp; idle =
 * bg-hover + ink-3 — no gradient, no opacity-30). While a reply streams and
 * the draft is EMPTY the send circle becomes Stop (Square); with a draft it
 * stays the submit — "queue" (chat) or "steer" (code), same circle — and a
 * ghost Stop sits beside it.
 *
 * variant="chat": while streaming the submit QUEUES the message.
 * variant="code": while a run is live the submit STEERS the run.
 * BOTH variants share device-aware Enter semantics (2026-09-14, ticket
 * 67fc53a7): desktop plain Enter submits (Shift+Enter newline); touch-primary
 * devices Enter = newline, iMessage-style; Cmd/Ctrl+Enter always submits.
 */

import type { ClipboardEvent, DragEvent, ReactNode, RefObject } from 'react';
import { ArrowUp, ListEnd, Loader2, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import ChatComposerTextarea, { type ChatComposerHandle } from './ChatComposerTextarea';

export interface ChatComposerDragHandlers {
  onDragOver: (e: DragEvent<HTMLFormElement>) => void;
  onDragEnter: (e: DragEvent<HTMLFormElement>) => void;
  onDragLeave: (e: DragEvent<HTMLFormElement>) => void;
  onDrop: (e: DragEvent<HTMLFormElement>) => void;
}

export interface ChatComposerProps {
  variant?: 'chat' | 'code';
  /** Textarea resting height: 'home' (64px — the hero composer) or 'chat'
      (30px — under a transcript). Animated (260ms) when it changes. */
  size?: 'home' | 'chat';
  /** Enter-key semantics override. Default (both variants): device-aware —
      desktop plain Enter submits (Shift+Enter newline), touch-primary Enter
      inserts a newline, Cmd/Ctrl+Enter always submits (lib/composer-enter,
      ticket 67fc53a7). Pass a boolean only to force semantics (tests, hosts
      with a genuine reason). */
  submitOnEnter?: boolean;
  /** Imperative draft-text handle (the draft lives inside ChatComposerTextarea). */
  composerRef: RefObject<ChatComposerHandle | null>;
  /** Also attaches to the inner <textarea> so hosts can call focus(). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  /** Send button / submit-key press. The host decides send vs queue (chat) or steer (code). */
  onSubmit: () => void;
  /** Fired only on empty↔non-empty flips (keeps keystrokes from re-rendering the host). */
  onEmptyChange?: (isEmpty: boolean) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Send-button enabled state. */
  canSubmit: boolean;
  /** Spinner state of the send button (code: a steer is in flight). */
  submitPending?: boolean;
  /** chat: a response is streaming (send becomes "queue"); code: a run is live (send steers). */
  isStreaming?: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
  stopPending?: boolean;
  submitTitle?: string;
  stopTitle?: string;
  /** Rendered inside the form, above the composer box (chat: folder breadcrumb). */
  topContent?: ReactNode;
  /** Left side of the toolbar (attach + the effort control). */
  leftActions?: ReactNode;
  /** Right side of the toolbar, before stop/send (the mic; the legacy patience
      picker when NEXT_PUBLIC_DEPTH_UX_DISABLED=1). */
  rightActions?: ReactNode;
  /** Note under the composer box (code: the steer-while-running hint). */
  footerNote?: ReactNode;
  /** chat: the hidden <input type="file"> (kept inside the form, as before). */
  hiddenFileInput?: ReactNode;
  dragOver?: boolean;
  dragHandlers?: ChatComposerDragHandlers;
}

/* ── ONE visual language for both variants (P2 item 4 → Digby Frontier) ──── */
export const COMPOSER_BOX =
  'rounded-[24px] border border-line bg-raised shadow-(--shadow) ' +
  'transition-[box-shadow,border-color] duration-[260ms] ease-(--ease-out) ' +
  'focus-within:border-line-2 focus-within:shadow-(--shadow-f)';
/** 34px toolbar circles (attach = outlined, mic = ghost) — exported for hosts. */
export const COMPOSER_TOOL_BTN =
  'relative flex size-[34px] shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors duration-150 ' +
  'hover:bg-hover touch-manipulation disabled:opacity-40 disabled:pointer-events-none ' +
  'before:absolute before:-inset-[5px] before:rounded-full before:content-[\'\']';
export const COMPOSER_ATTACH_BTN = cn(COMPOSER_TOOL_BTN, 'border border-line');
/** The 36px Send circle: enabled = bg-send + send-ink; disabled = bg-hover +
 *  ink-3 (no gradient, no opacity fade); press = scale(.94). The before:
 *  pseudo-element extends the hit area to 44px. */
export const SEND_BTN =
  'relative flex size-9 shrink-0 items-center justify-center rounded-full ' +
  'bg-send text-send-ink transition-[background-color,color,transform] duration-200 active:scale-[0.94] ' +
  'disabled:bg-hover disabled:text-ink-3 disabled:active:scale-100 ' +
  'before:absolute before:-inset-1 before:rounded-full before:content-[\'\']';
/** Ghost Stop shown BESIDE a queue/steer submit (a draft exists mid-reply). */
const STOP_GHOST_BTN = cn(COMPOSER_TOOL_BTN, 'disabled:opacity-50');

const ARROW = <ArrowUp className="size-[17px]" strokeWidth={2.25} />;

export default function ChatComposer({
  variant = 'chat',
  size = 'chat',
  submitOnEnter,
  composerRef,
  textareaRef,
  placeholder,
  onSubmit,
  onEmptyChange,
  onPaste,
  canSubmit,
  submitPending,
  isStreaming,
  onStop,
  stopDisabled,
  stopPending,
  submitTitle,
  stopTitle,
  topContent,
  leftActions,
  rightActions,
  footerNote,
  hiddenFileInput,
  dragOver,
  dragHandlers,
}: ChatComposerProps) {
  const isCode = variant === 'code';
  const resolvedStopTitle = stopTitle ?? (isCode ? 'Stop the run' : 'Stop generating');
  // Mid-reply with an EMPTY draft: the send circle IS Stop. With a draft the
  // circle submits (queue / steer) and a ghost Stop sits beside it.
  const stopAsPrimary = !!isStreaming && !!onStop && !canSubmit && !submitPending;

  const stopIcon = stopPending ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-[15px]" fill="currentColor" strokeWidth={0} />;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      {...(dragHandlers ?? {})}
    >
      {hiddenFileInput}
      {topContent}
      <div
        data-composer-box
        className={cn(COMPOSER_BOX, dragOver && 'border-line-2 bg-hover/40')}
      >
        {/* Textarea — borderless, full width on top. Owns its own draft text
            so typing doesn't re-render the host (see ChatComposerTextarea). */}
        <ChatComposerTextarea
          ref={composerRef}
          textareaRef={textareaRef}
          onEnterSubmit={onSubmit}
          onEmptyChange={onEmptyChange}
          onPaste={onPaste}
          submitOnEnter={submitOnEnter}
          placeholder={placeholder}
          className={cn(
            'block w-full max-h-[220px] resize-none overflow-y-auto bg-transparent px-5 pt-4 pb-1.5 outline-none',
            'text-[16px] leading-[1.5] text-ink placeholder:text-ink-3',
            'transition-[min-height] duration-[260ms] ease-(--ease-out)',
            size === 'home' ? 'min-h-[64px]' : 'min-h-[30px]',
          )}
        />
        {/* Toolbar — attach + effort left; mic + send/stop right. */}
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-2.5">
          <div className="flex min-w-0 items-center gap-1.5">{leftActions}</div>
          <div className="flex-1" />
          {rightActions}
          {stopAsPrimary ? (
            <button
              type="button"
              onClick={onStop}
              disabled={stopDisabled}
              className={SEND_BTN}
              title={resolvedStopTitle}
              aria-label={resolvedStopTitle}
            >
              {stopIcon}
            </button>
          ) : (
            <>
              {isStreaming && onStop && (
                <button
                  type="button"
                  onClick={onStop}
                  disabled={stopDisabled}
                  className={STOP_GHOST_BTN}
                  title={resolvedStopTitle}
                  aria-label={resolvedStopTitle}
                >
                  {stopIcon}
                </button>
              )}
              <button
                type="submit"
                disabled={!canSubmit || (isCode && !!submitPending)}
                className={SEND_BTN}
                title={submitTitle ?? (isStreaming
                  ? (isCode ? 'Steer the run — send this to the agent now' : 'Queue message')
                  : (isCode ? 'Send' : 'Send message'))}
                aria-label={submitTitle ?? (isStreaming ? (isCode ? 'Steer the run' : 'Queue message') : 'Send message')}
              >
                {submitPending
                  ? <Loader2 className="size-4 animate-spin" />
                  : isStreaming && !isCode ? <ListEnd className="size-[17px]" strokeWidth={2} /> : ARROW}
              </button>
            </>
          )}
        </div>
      </div>
      {footerNote}
    </form>
  );
}
