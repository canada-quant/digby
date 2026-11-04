'use client';

/**
 * OwnerQuestionCard — one agent-flagged "needs the owner" question, ANSWERABLE
 * where it is shown (owner 2026-09-22: "when I click the 1 needs your input
 * button it redirects to the proper chat but there is no other action for me
 * to take or understand what it needs from me").
 *
 * Before: a triaged owner question (a supervisor answering first) rendered in
 * the rail as a bare one-line link that only opened the chat, the chat itself
 * had no card, and the flagger's typed options never rendered anywhere.
 *
 * Now: the same card in the sidebar rail (compact) and in-flow at the bottom
 * of the open chat: the full question, the flagger's OPTIONS as buttons (each
 * with its consequence line), Approve/Decline when there are no options, a
 * free-text route to the Inbox, Dismiss, and an honest line when a supervisor
 * is triaging it ("answer now to pre-empt"). The clicked option's label posts
 * through the normal answer endpoint (the server matches it to the option).
 */

import { useState } from 'react';
import { BellRing, Check, Copy, Eye, EyeOff, KeyRound, Reply, X } from 'lucide-react';
import { cn, copyTextToClipboard } from '@/lib/utils';
import type { PendingConfirmation } from '@/lib/api/crossmodel';
import { confirmationsApi } from '@/lib/api/crossmodel';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';

/** Plain-text preview of a markdown question (bold / bullets / headings / code ticks / links). */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

export interface OwnerQuestionOption { label: string; consequence?: string }

/**
 * The pending-list `question` carries the typed options appended as numbered
 * lines ("1. Label — consequence"). Split them back out so the card renders
 * the question once and the options as buttons. Pure; exported for tests.
 */
export function splitOwnerQuestion(question: string, optionLabels: string[] | undefined): { text: string; options: OwnerQuestionOption[] } {
  const raw = String(question ?? '');
  const labels = (optionLabels ?? []).filter((l) => typeof l === 'string' && l.trim());
  if (!labels.length) return { text: raw.trim(), options: [] };
  const lines = raw.split('\n');
  const options: OwnerQuestionOption[] = [];
  const keep: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (m) {
      const body = m[2];
      const label = labels.find((l) => body.startsWith(l));
      if (label) {
        const rest = body.slice(label.length).replace(/^\s*[—–-]\s*/, '').trim();
        options.push({ label, ...(rest ? { consequence: rest } : {}) });
        continue;
      }
    }
    keep.push(line);
  }
  // Labels the numbered lines did not carry (older rows) still become buttons.
  for (const l of labels) if (!options.some((o) => o.label === l)) options.push({ label: l });
  return { text: keep.join('\n').trim(), options };
}

export default function OwnerQuestionCard({
  p,
  busy = false,
  compact = false,
  onAnswer,
  onDismiss,
  onOpenChat,
  onOpenInbox,
}: {
  p: PendingConfirmation;
  busy?: boolean;
  /** Sidebar rail sizing (smaller type, title opens the chat). */
  compact?: boolean;
  onAnswer: (p: PendingConfirmation, answer: string, opts?: { credentialPaste?: boolean }) => void | Promise<void>;
  onDismiss?: (p: PendingConfirmation) => void | Promise<void>;
  onOpenChat?: (p: PendingConfirmation) => void;
  onOpenInbox?: () => void;
}) {
  // Ticket f3a69ed3 (defect 2): the fold mark — the owner's reply on the card
  // this one replaced, appended to the question server-side. When the API
  // carries priorReplyFold the card renders it as its own block (never
  // clamped away by the rail's 3-line preview) and strips it from the body.
  // Ticket 913339d7 (review obs 7): BYTE-PARITY TWIN of
  // backend/src/modules/crossmodel/platform/owner-questions.ts
  // REPLACED_REPLY_MARK ('\n\n↩ FROM YOUR EARLIER REPLY —'). No frontend→
  // backend import path exists in this repo (frontend/tsconfig.json maps
  // only '@/*'), so the mark is duplicated here deliberately — the same
  // discipline as frontend/lib/machine-wake.ts. If the backend mark ever
  // changes, this MUST change with it. The load-bearing path is the
  // priorReplyFold API field (parsed server-side by parseReplacedReplyFold);
  // this literal is only the belt-and-braces strip for a fold the API has
  // already announced, so a desync degrades to rendering the fold inline —
  // never to losing the owner's reply.
  const FOLD_MARK = '\n\n↩ FROM YOUR EARLIER REPLY —';
  const stripFold = (t: string): string => {
    const at = t.indexOf(FOLD_MARK);
    return at >= 0 ? t.slice(0, at) : t;
  };
  const { text: textRaw, options } = splitOwnerQuestion(p.question, p.options);
  const text = p.priorReplyFold ? stripFold(textRaw) : textRaw;
  const [expanded, setExpanded] = useState(false);
  // Ticket 1b1c41bc: a console-action card NEVER collapses — the collapsed
  // preview strips markdown (the payload would vanish) and clamps to 3 lines.
  // The whole point of the card is the paste-ready content: render it in full.
  const clamped = compact && !expanded && text.length > 160 && p.consoleAction !== true;
  // Ticket ad4fae90: the dedicated paste field for a credential-gated card —
  // submitting it posts { credentialPaste: true } so the server vault-stores
  // the value and lifts the gate on that very answer (answer text alone never
  // resolves a credential gate). Local state only; the value never renders
  // back after submit (the input clears).
  const [secretDraft, setSecretDraft] = useState('');
  const submitSecret = async () => {
    const v = secretDraft.trim();
    if (!v) return;
    setSecretDraft('');
    await onAnswer(p, v, { credentialPaste: true });
  };
  // Ticket 26786762: delivered-credential reveal. The card's question text
  // carries numbered handles ("[SECRET 1]"); the values live server-side,
  // encrypted, and are decrypted on demand by the owner-scoped reveal
  // endpoint. Reveal state is LOCAL (a re-mount re-hides); the value is
  // shown with a copy button — never re-posted anywhere.
  const [revealed, setRevealed] = useState<Record<number, { value?: string; error?: string }>>({});
  const [revealBusy, setRevealBusy] = useState<number | null>(null);
  const reveal = async (ordinal: number) => {
    if (revealed[ordinal] || revealBusy !== null) return;
    setRevealBusy(ordinal);
    try {
      const r = await confirmationsApi.revealOwnerQuestionSecret(p.id, ordinal);
      setRevealed((prev) => ({
        ...prev,
        [ordinal]: r?.error === 'unreadable'
          ? { error: 'no longer readable (the platform key rotated since delivery)' }
          : r?.value
            ? { value: r.value }
            : { error: 'could not reveal' },
      }));
    } catch {
      setRevealed((prev) => ({ ...prev, [ordinal]: { error: 'could not reveal' } }));
    } finally {
      setRevealBusy(null);
    }
  };
  const btn = compact ? 'text-[12px] px-2.5 py-1' : 'text-[12.5px] px-3 py-1.5';
  return (
    <div
      className={cn('rounded-xl border border-line bg-raised font-sans', compact ? 'px-3 py-2.5' : 'p-3.5')}
      data-owner-question
      data-triaged={p.triaged ? 'true' : undefined}
    >
      <div className={cn('flex items-center gap-1.5 font-medium text-ink', compact ? 'text-[12.5px]' : 'text-[13px] mb-1')}>
        <BellRing className={cn('text-warn', compact ? 'size-3' : 'size-3.5')} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {p.triaged ? 'Your supervisor is answering this first' : 'Needs your decision'}
          {compact && onOpenChat && p.title ? (
            <>
              {' · '}
              <button type="button" onClick={() => onOpenChat(p)} className="hover:underline underline-offset-2" title={`Open chat: ${p.title}`}>
                {p.title}
              </button>
            </>
          ) : null}
        </span>
      </div>
      {p.triaged && (
        <p className={cn('text-ink-3', compact ? 'text-[11.5px] leading-snug' : 'text-[12px] mb-1')}>
          It is listed so you can see the wait; answer now to pre-empt, or leave it to the supervisor.
        </p>
      )}
      {p.recordedReply && (
        /* Ticket f3a69ed3 (defect 1): the owner's own reply, rendered back ON
           the card it was posted to. Before, a reply the typed gate could not
           resolve showed a toast and vanished — nothing on the card told the
           owner his words were heard, why they did not close it, or where
           they went. This block is the answer to "didnt i reply to the
           ticket from the agents??": yes — here it is, and here is why it
           did not close the card. NEVER clamped (rendered outside the
           3-line preview). */
        <div
          className={cn('mt-1.5 rounded-lg border border-warn/40 bg-warn/5', compact ? 'px-2 py-1.5' : 'px-2.5 py-2')}
          data-owner-recorded-reply
        >
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <Reply className="size-3 text-warn" aria-hidden="true" />
            Your reply{p.recordedReply.receivedAt ? ` — received ${new Date(p.recordedReply.receivedAt).toLocaleString()}` : ' (received)'}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-ink-2 text-[12.5px] leading-snug" data-recorded-reply-text>
            {p.recordedReply.text}
          </p>
          <p className="mt-1 text-[11.5px] leading-snug text-ink-3" data-recorded-reply-reason>
            It did not close this card: {p.recordedReply.reason}. Your reply {p.recordedReply.delivered}.
            {p.needsCredential ? ' The card stays open until the key itself is stored.' : ''}
          </p>
        </div>
      )}
      {p.priorReplyFold && (
        /* Ticket f3a69ed3 (defect 2): this card REPLACED one the owner had
           already replied to. His reply is folded forward, visibly — before,
           the auto-dismiss of the old card (system banner: "a replacement
           superseded it, NOT your ruling") hid the reply entirely. NEVER
           clamped. */
        <div
          className={cn('mt-1.5 rounded-lg border border-line bg-background', compact ? 'px-2 py-1.5' : 'px-2.5 py-2')}
          data-owner-prior-reply-fold
        >
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <Reply className="size-3 text-ink-3" aria-hidden="true" />
            Folded in from your earlier reply
            <span className="text-ink-4">(card {p.priorReplyFold.fromQuestionId.slice(0, 11)})</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-ink-2 text-[12.5px] leading-snug" data-prior-reply-text>
            {p.priorReplyFold.text}
          </p>
        </div>
      )}
      {clamped ? (
        /* Collapsed preview: plain words (markdown marks stripped) so a 3-line
           clamp never shows literal ** / - / # (Frontier sweep 2026-10-06). */
        <p
          className={cn('whitespace-pre-wrap break-words leading-snug text-ink-2 line-clamp-3', compact ? 'text-[12.5px]' : 'text-[13.5px]')}
          title={stripMarkdown(text)}
        >
          {stripMarkdown(text)}
        </p>
      ) : (
        <div className={cn('break-words text-ink-2 [&_p:last-child]:mb-0', compact ? 'text-[12.5px]' : 'text-[13.5px]')}>
          <MarkdownContent
            textSizeCls={compact ? 'text-[12.5px] leading-snug' : 'text-[13.5px] leading-[1.55]'}
            h1Cls="text-[13.5px]" h2Cls="text-[13.5px]" h3Cls="text-[13px]" h4Cls="text-[13px]" thCls="text-xs" tdCls="text-xs">
            {text}
          </MarkdownContent>
        </div>
      )}
      {clamped && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-0.5 text-[11.5px] font-medium text-ink-3 hover:text-ink" aria-expanded={!clamped}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {p.context && !clamped && (
        /* 2026-10-20: the flagger's context — what it tried, the policy /
           console steps the owner needs — collapsed under the question (hidden
           behind "Show more" on a clamped rail card). Markdown so a fenced
           policy block gets the Copy button. Before this nothing the agent put
           in context ever reached the owner. */
        <details className={cn('mt-1.5 rounded-lg border border-line bg-background', compact ? 'px-2 py-1' : 'px-2.5 py-1.5')} data-owner-context>
          <summary className="cursor-pointer select-none text-[11.5px] font-medium text-ink-3">Details from the agent</summary>
          <div className={cn('mt-1 break-words text-ink-2 [&_p:last-child]:mb-0', compact ? 'text-[12px]' : 'text-[13px]')}>
            <MarkdownContent textSizeCls={compact ? 'text-[12px] leading-snug' : 'text-[13px] leading-[1.5]'} h1Cls="text-[13px]" h2Cls="text-[13px]" h3Cls="text-[12.5px]" h4Cls="text-[12.5px]" thCls="text-xs" tdCls="text-xs">
              {p.context}
            </MarkdownContent>
          </div>
        </details>
      )}
      {p.secrets && p.secrets.length > 0 && (
        /* Ticket 26786762: delivered-credential reveal affordance. The card
           carries numbered handles ("[SECRET 1]") in its text; each entry
           here is one owner-scoped reveal. The value is decrypted on demand
           (never present until Reveal is clicked), shown with Copy, and
           hidden again on EyeOff — nothing is re-posted anywhere. */
        <div className={cn('mt-1.5 rounded-lg border border-line bg-background', compact ? 'p-2' : 'p-2.5')} data-delivered-secrets>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <KeyRound className="size-3 text-warn" aria-hidden="true" />
            Delivered credential{p.secrets.length > 1 ? 's' : ''} — reveal to copy
          </div>
          {p.secrets.map((s) => {
            const r = revealed[s.ordinal];
            return (
              <div key={s.ordinal} className="mt-1.5 flex flex-wrap items-center gap-1.5" data-delivered-secret={s.ordinal}>
                <span className="text-[12px] text-ink-2">
                  <span className="font-medium text-ink">[SECRET {s.ordinal}]</span> {s.label} <span className="text-ink-4">({s.preview})</span>
                </span>
                {!r ? (
                  <button
                    type="button"
                    disabled={revealBusy !== null}
                    onClick={() => void reveal(s.ordinal)}
                    className={cn('inline-flex items-center gap-1 rounded-full border border-line text-ink-2 hover:bg-hover hover:border-line-2 disabled:opacity-50 transition-colors', btn)}
                    data-reveal-secret={s.ordinal}
                    aria-label={`Reveal ${s.label}`}
                  >
                    {revealBusy === s.ordinal ? 'Revealing…' : (<><Eye className="size-3" /> Reveal</>)}
                  </button>
                ) : r.value ? (
                  <>
                    <code className={cn('min-w-0 max-w-full break-all rounded-md bg-hover px-1.5 py-0.5 text-[11.5px] text-ink', compact ? 'max-h-16' : 'max-h-24')} data-secret-value={s.ordinal}>
                      {r.value}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyTextToClipboard(r.value!)}
                      className={cn('inline-flex items-center gap-1 rounded-full border border-line text-ink-2 hover:bg-hover hover:border-line-2 transition-colors', btn)}
                      aria-label={`Copy ${s.label}`}
                      data-copy-secret={s.ordinal}
                    >
                      <Copy className="size-3" /> Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevealed((prev) => { const n = { ...prev }; delete n[s.ordinal]; return n; })}
                      className={cn('inline-flex items-center gap-1 rounded-full border border-line text-ink-3 hover:bg-hover hover:border-line-2 transition-colors', btn)}
                      aria-label={`Hide ${s.label}`}
                      data-hide-secret={s.ordinal}
                    >
                      <EyeOff className="size-3" /> Hide
                    </button>
                  </>
                ) : (
                  <span className="text-[11.5px] text-warn" data-secret-error={s.ordinal}>{r.error}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {p.needsCredential && (
        /* Ticket ad4fae90: the dynamic credential affordance. A credential-
           gated card renders a dedicated masked paste field: the owner's key
           goes straight to the encrypted vault (server-side), the gate lifts
           on that very answer, and the card never carries the value back.
           type=password keeps the value off-screen; autoComplete="off" keeps
           the browser from caching it into the owner's password store. */
        <div className={cn('mt-1.5 rounded-lg border border-line bg-background', compact ? 'p-2' : 'p-2.5')} data-credential-input>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <KeyRound className="size-3 text-warn" aria-hidden="true" />
            This question needs a key
          </div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
            Paste it here — it goes straight to your encrypted credentials (never stored in the chat), and the waiting agent can use it immediately as an environment variable.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <input
              type="password"
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitSecret(); } }}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Paste the key…"
              aria-label="Credential value for this question"
              className={cn('min-w-0 flex-1 rounded-md border border-line bg-background px-2 py-1 text-[12.5px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-warn disabled:opacity-50', compact && 'text-[12px]')}
              data-credential-value
            />
            <button
              type="button"
              disabled={busy || !secretDraft.trim()}
              onClick={() => void submitSecret()}
              className={cn('inline-flex items-center gap-1 rounded-full bg-send font-medium text-send-ink hover:opacity-90 disabled:opacity-50 transition', btn)}
              data-credential-submit
            >
              <KeyRound className="size-3" /> Store key
            </button>
          </div>
        </div>
      )}
      <div className={cn('flex flex-col gap-1', compact ? 'mt-1' : 'mt-2')}>
        {options.length > 0 ? options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            disabled={busy}
            onClick={() => void onAnswer(p, o.label)}
            className={cn('w-full rounded-lg border border-line bg-background text-left hover:bg-hover hover:border-line-2 disabled:opacity-50 transition-colors', btn)}
            data-option-index={i + 1}
          >
            <span className="font-medium text-ink">{i + 1}. {o.label}</span>
            {o.consequence && <span className={cn('block text-ink-3', compact ? 'text-[11.5px]' : 'text-[12px]')}>{o.consequence}</span>}
          </button>
        )) : (
          <div className="flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => void onAnswer(p, 'Approved.')} className={cn('inline-flex items-center gap-1 rounded-full bg-send font-medium text-send-ink hover:opacity-90 disabled:opacity-50 transition', btn)}>
              <Check className="size-3" /> Approve
            </button>
            <button type="button" disabled={busy} onClick={() => void onAnswer(p, 'Declined.')} className={cn('inline-flex items-center gap-1 rounded-full border border-line text-ink-2 hover:bg-hover hover:border-line-2 disabled:opacity-50 transition-colors', btn)}>
              <X className="size-3" /> Decline
            </button>
          </div>
        )}
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          {onOpenInbox && (
            <button type="button" onClick={onOpenInbox} className={cn('rounded-md text-ink-3 hover:bg-hover hover:text-ink transition-colors', compact ? 'text-[11.5px] px-1' : 'text-[12px] px-1.5 py-0.5')} title="Type a free-text answer in Management → Inbox">
              Type a different answer
            </button>
          )}
          {onDismiss && (
            <button type="button" disabled={busy} onClick={() => void onDismiss(p)} className={cn('rounded-md text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50 transition-colors', compact ? 'text-[11.5px] px-1' : 'text-[12px] px-1.5 py-0.5')}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
