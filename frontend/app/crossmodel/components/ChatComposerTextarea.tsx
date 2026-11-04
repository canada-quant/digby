'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { SW_RELOAD_EVENT, stashDraft, takeStashedDraft } from '@/lib/sw-update-draft';
import { enterKeySubmits, isTouchPrimary } from '@/lib/composer-enter';

export interface ChatComposerHandle {
  getValue: () => string;
  setValue: (v: string) => void;
  clear: () => void;
  focus: () => void;
}

interface ChatComposerTextareaProps {
  /** Parent's textarea ref — also attached to the inner <textarea> so existing focus() calls keep working. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  className?: string;
  /** Called to submit the message — Cmd/Ctrl+Enter always, or plain Enter on
      desktop (see submitOnEnter default). (Plain Enter inserts a newline on
      touch-primary devices, iMessage-style.) */
  onEnterSubmit: () => void;
  /**
   * Enter-key semantics override. DEFAULT (undefined) is device-aware
   * (ticket 67fc53a7): desktop submits on plain Enter (Shift+Enter = newline);
   * touch-primary devices insert a newline (send via the button), iMessage-style.
   * Cmd/Ctrl+Enter always submits regardless.
   */
  submitOnEnter?: boolean;
  /**
   * Fired ONLY when the empty/non-empty state flips — lets the parent toggle the Send button's
   * disabled state without re-rendering on every keystroke.
   */
  onEmptyChange?: (isEmpty: boolean) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * The chat draft text lives HERE, not in the giant page component. Typing therefore only re-renders
 * this tiny component instead of the entire ~5,500-line page (which, with a canvas open, meant
 * re-parsing the whole canvas on every keystroke). The parent reads/writes the text via the
 * imperative handle (getValue/setValue/clear/focus); it only re-renders on empty↔non-empty
 * transitions (via onEmptyChange), never on every keystroke.
 */
const ChatComposerTextarea = memo(
  forwardRef<ChatComposerHandle, ChatComposerTextareaProps>(function ChatComposerTextarea(
    { textareaRef, placeholder, className, onEnterSubmit, onEmptyChange, onPaste, submitOnEnter },
    ref,
  ) {
    const [text, setText] = useState('');
    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const wasEmpty = useRef(true);
    // 2026-06-11: Use a ref to always track the current value, even after unmount.
    // Previously getValue() fell back to stale `text` state when innerRef.current was null
    // (e.g. during navigation), which could cause stale message content to be sent.
    const textRef = useRef('');

    const resize = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      // Auto-grow measurement WITHOUT moving the page (owner recording
      // 2026-09-18, "the whole UI shifts with each letter"): collapsing to
      // `auto` to read scrollHeight forces a synchronous layout in which the
      // textarea is ONE line tall. The composer sits under a flex-1 transcript
      // scroller, so in that layout the scroller grows by the lost lines and
      // the browser CLAMPS its scrollTop right there — restoring the height a
      // statement later does not restore the offset, so the bottom-pinned
      // transcript painted ~20px lower on every keystroke until the next
      // stream chunk re-pinned it (a one-frame jump of the whole chat above the
      // pill; frame analysis: +20px on the keystroke frame, −20px the next).
      // Holding the enclosing <form> at its current height for the duration of
      // the measurement keeps the scroller's size (and its scroll offset)
      // untouched; the lock lifts before the next layout so a genuine line
      // gain/loss still resizes the composer normally.
      const lock = el.form;
      const prevMinHeight = lock ? lock.style.minHeight : '';
      if (lock) lock.style.minHeight = `${lock.offsetHeight}px`;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
      if (lock) lock.style.minHeight = prevMinHeight;
    }, []);

    const apply = useCallback((v: string) => {
      setText(v);
      textRef.current = v;
      const empty = !v.trim();
      if (empty !== wasEmpty.current) {
        wasEmpty.current = empty;
        // Defer parent notification to the next microtask — calling onEmptyChange synchronously
        // during apply() (which is called from setValue → useImperativeHandle) can trigger a
        // parent re-render while this child is still rendering, violating React's rules and
        // potentially causing stale-state issues in the parent component.
        queueMicrotask(() => onEmptyChange?.(empty));
      }
      // Resize after the new value is painted.
      requestAnimationFrame(resize);
    }, [onEmptyChange, resize]);

    useImperativeHandle(ref, () => ({
      // Prefer the live DOM value (always in sync with what's displayed); fall back to ref.
      // 2026-06-11: Changed fallback from `text` (state, stale after unmount) to `textRef.current`
      // (ref, always up-to-date) to prevent stale content being sent after navigation.
      getValue: () => innerRef.current?.value ?? textRef.current,
      // 2026-06-10: Guard against undefined — callers that bypass the page.tsx shim
      // (which has `next ?? ''`) could pass undefined directly, displaying 'undefined'.
      // 2026-06-23: Tightened from `v ?? ''` to a typeof check. `?? ''` only catches
      // null/undefined; a non-string (number, object from a malformed caller) would still
      // be set and React would stringify it into the textarea. Coerce anything non-string
      // to ''.
      // 2026-06-28: Also strip a value that is EXACTLY the literal string "undefined"/
      // "null". setValue is the programmatic path (follow-up button clicks, draft
      // restore, prefill) — NOT user typing, which flows through the textarea's onChange.
      // So a whole-value "undefined"/"null" here is a `String(undefinedVar)`
      // stringification bug upstream, not a user genuinely typing the word (which would
      // arrive via onChange and is untouched). Re-ask analysis showed users seeing
      // "undefined" in their own chat bubble (chats 5b669c92). Exact-match only — the
      // word inside a longer message ("what does undefined mean") is preserved.
      // 2026-06-30: Also strip the literal "[object Object]". A caller that passes a
      // non-string reaches the typeof guard above, but a caller that String()-ifies an
      // object FIRST (e.g. a template literal `${obj}` or `String(obj)` in a follow-up
      // handler) arrives here as the already-stringified "[object Object]" — a real
      // string, so it slips past the typeof check. Like "undefined"/"null", a whole-value
      // "[object Object]" is always an upstream stringification bug, never something a
      // user types, so blank it rather than display it.
      setValue: (v: string) => {
        if (typeof v !== 'string') return apply('');
        const t = v.trim();
        return apply(t === 'undefined' || t === 'null' || t === '[object Object]' ? '' : v);
      },
      clear: () => apply(''),
      focus: () => innerRef.current?.focus(),
    }), [apply]);

    // SW-update draft preservation (P5): UpdateNotification force-reloads the
    // page when a new service worker lands. Just before reloading it
    // dispatches SW_RELOAD_EVENT; any mounted composer stashes its non-empty
    // draft to sessionStorage (keyed by pathname), and the next composer to
    // mount on that page restores it — the forced reload no longer discards
    // what the user was typing. Restore is one-shot + freshness-bounded (see
    // lib/sw-update-draft.ts) and never clobbers text already present.
    useEffect(() => {
      let restored: string | null = null;
      try {
        restored = takeStashedDraft(window.location.pathname, window.sessionStorage);
      } catch { /* sessionStorage unavailable — nothing to restore */ }
      if (restored && !textRef.current.trim()) apply(restored);
      const stash = () => {
        try {
          stashDraft(window.location.pathname, innerRef.current?.value ?? textRef.current, window.sessionStorage);
        } catch { /* unavailable — the draft is lost on reload, as before P5 */ }
      };
      window.addEventListener(SW_RELOAD_EVENT, stash);
      return () => window.removeEventListener(SW_RELOAD_EVENT, stash);
    }, [apply]);

    const attachRef = useCallback((el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (textareaRef) {
        (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
      }
    }, [textareaRef]);

    return (
      <textarea
        ref={attachRef}
        value={text}
        onChange={(e) => apply(e.target.value)}
        placeholder={placeholder}
        rows={1}
        className={className}
        onPaste={onPaste}
        onKeyDown={(e) => {
          // 2026-09-14 (ticket 67fc53a7, owner report): Enter semantics are
          // DEVICE-AWARE — desktop: plain Enter submits, Shift+Enter newline;
          // touch-primary: Enter inserts a newline, iMessage-style (send via
          // the Send button). Cmd/Ctrl+Enter always submits. The decision
          // lives in lib/composer-enter (pure + unit-tested); isTouchPrimary()
          // is read at keypress time, so there is no SSR/hydration skew.
          // (History: 41c534372 forced Enter=newline on ALL devices — correct
          // on mobile, the desktop regression this fixes.)
          if (enterKeySubmits(e, submitOnEnter, isTouchPrimary())) {
            e.preventDefault();
            onEnterSubmit();
          }
        }}
      />
    );
  }),
);

export default ChatComposerTextarea;
