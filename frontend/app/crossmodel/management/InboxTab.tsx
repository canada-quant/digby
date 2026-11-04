'use client';

/**
 * Management → Inbox (ticket 7705fec2) — the persistent "Needs owner" surface.
 *
 * One poll (GET /crossmodel/confirmations/pending, 20s, visibility-gated)
 * feeds every owner-attention item:
 *  - OWNER QUESTIONS (kind 'owner_question'): flagged by an agent run via the
 *    flag_owner_question platform tool. They NEVER expire — they persist here
 *    until the owner answers (posted back into the flagging chat's transcript)
 *    or dismisses them ("stop raising this").
 *  - PENDING CONFIRMATIONS (kind 'confirmation', not expired): staged
 *    consequential actions — Confirm/Cancel inline (executes the STORED args
 *    server-side, one-shot). STALE ones (past the execution-freshness
 *    horizon) render Dismiss + a re-stage hint only (Confirm would refuse).
 *  - LIVE QUESTIONS & APPROVALS (kind 'question' | 'approval'): a run blocked
 *    on the inline card right now — answered where they live (open the chat).
 *  - Recently expired confirmations (expired:true) render as a small
 *    non-actionable trace so nothing vanishes silently (f789d84e).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Inbox, BellRing, MessageSquareWarning, AlarmClockOff, Loader2, Check, Copy, Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { surfaceConfirmSecret } from '@/lib/confirm-secret';
import { toast } from 'sonner';
import { confirmationsApi, type PendingConfirmation } from '@/lib/api/crossmodel';
import { codingApi } from '@/lib/api/coding';
import { usePolling } from '@/lib/use-polling';
import { relativeTime } from '@/lib/relative-time';
import { copyTextToClipboard } from '@/lib/utils';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';

const POLL_MS = 20_000;

export function InboxTab() {
  const router = useRouter();
  const [items, setItems] = useState<PendingConfirmation[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Ticket ad4fae90: per-card secret-input drafts for credential-gated rows. */
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  /** Ticket 26786762: per-card revealed delivered-secrets (ordinal → value or
   *  error). The value is decrypted on demand via the owner-scoped reveal
   *  endpoint; local state only — a re-mount re-hides. */
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, Record<number, { value?: string; error?: string }>>>({});
  const [revealBusyKey, setRevealBusyKey] = useState<string | null>(null);
  const revealDelivered = useCallback(async (p: PendingConfirmation, ordinal: number) => {
    const key = `${p.id}:${ordinal}`;
    setRevealBusyKey(key);
    try {
      const r = await confirmationsApi.revealOwnerQuestionSecret(p.id, ordinal);
      setRevealedSecrets((prev) => ({
        ...prev,
        [p.id]: {
          ...(prev[p.id] ?? {}),
          [ordinal]: r?.error === 'unreadable'
            ? { error: 'no longer readable (the platform key rotated since delivery)' }
            : r?.value
              ? { value: r.value }
              : { error: 'could not reveal' },
        },
      }));
    } catch {
      setRevealedSecrets((prev) => ({ ...prev, [p.id]: { ...(prev[p.id] ?? {}), [ordinal]: { error: 'could not reveal' } } }));
    } finally {
      setRevealBusyKey(null);
    }
  }, []);
  const mountedRef = useRef(true);

  const refresh = useCallback((signal?: AbortSignal) => {
    confirmationsApi.getPending({ signal })
      .then((list) => { if (mountedRef.current) setItems(Array.isArray(list) ? list : []); })
      .catch(() => { /* best-effort — keep the last loaded list (aborts land here too) */ });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // usePolling (P5): abortable ticks, hidden-tab pause + catch-up tick on
  // return to visible (the legacy interval only gated ticks on visibility —
  // returning to the tab could wait a full POLL_MS for fresh items).
  usePolling((signal) => refresh(signal), { intervalMs: POLL_MS });
  // Live approvals / questions answered from the inbox (owner 2026-10-20):
  // the run's own endpoints, one-shot server-side; a second click lands on a
  // gone row and the refresh simply drops the card.
  const [liveBusyId, setLiveBusyId] = useState<string | null>(null);
  const resolveLiveApproval = useCallback(async (p: PendingConfirmation, decision: 'allow' | 'always' | 'deny') => {
    setLiveBusyId(p.id);
    try {
      await codingApi.approve(p.id, decision);
      toast.success(decision === 'deny' ? 'Denied.' : decision === 'always' ? 'Allowed for the rest of the run.' : 'Allowed — running now.');
    } catch {
      toast.error('Could not send that decision — open the chat and answer there.');
    } finally {
      setLiveBusyId(null);
      void refresh();
    }
  }, [refresh]);
  const answerLiveQuestion = useCallback(async (p: PendingConfirmation, answer: string) => {
    setLiveBusyId(p.id);
    try {
      const res = await codingApi.answerQuestion(p.id, answer);
      if (res.success) toast.success('Answer sent.');
      else toast.error(res.error || 'That question is no longer waiting — open the chat to continue.');
    } catch {
      toast.error('Could not send that answer — open the chat and answer there.');
    } finally {
      setLiveBusyId(null);
      void refresh();
    }
  }, [refresh]);

  /** Confirm/Cancel a staged consequential action (one-shot server-side). */
  const resolveConfirmation = useCallback(async (p: PendingConfirmation, action: 'confirm' | 'cancel') => {
    setBusyId(p.id);
    try {
      const res = action === 'confirm'
        ? await confirmationsApi.confirmAction(p.id)
        : await confirmationsApi.cancelAction(p.id);
      if (res.success) {
        // A minted secret (create_chat_webhook) rides the result ONCE — show it here or nowhere.
        if (!(action === 'confirm' && surfaceConfirmSecret((res as { result?: string }).result))) toast.success(action === 'confirm' ? 'Action confirmed — running now.' : 'Action dismissed.');
      } else {
        toast.error(res.error === 'expired'
          ? 'That action is stale — ask the chat to re-stage it.'
          : res.error === 'already_resolved'
            ? 'Already resolved elsewhere.'
            : res.error || 'Failed.');
      }
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [refresh]);

  /** Answer a flagged owner question — the answer lands in the flagging chat. */
  const answerQuestion = useCallback(async (p: PendingConfirmation) => {
    const answer = (drafts[p.id] ?? '').trim();
    if (!answer) { toast.error('Type an answer first.'); return; }
    setBusyId(p.id);
    try {
      const res = await confirmationsApi.answerOwnerQuestion(p.id, answer);
      if (res.success) {
        toast.success('Answer sent — the chat sees it on its next turn.');
        setDrafts((prev) => ({ ...prev, [p.id]: '' }));
      } else if (res.error === 'reply_recorded') {
        // Todo 0dd7d3f2: a choice/yes_no gate got text that doesn't match an
        // option — the reply DID reach the asking chat as conversation; only
        // the card resolution is refused (the old credential_pending code
        // showed the wrong banner and kept the draft). Clear the draft: the
        // words were delivered; picking an option is what resolves the card.
        // 2026-10-20: a credential card answers the same code when the owner
        // typed WORDS (not the key) — the asking agent is woken to answer on
        // the card; the gate still needs the key through the key field.
        toast.info(p.needsCredential
          ? 'Sent to the agent as a reply — it is being woken to answer you on this card. The card stays open until the key is stored (paste it in the key field above).'
          : 'Sent to the chat as a reply — the chat is being woken with your words now. The card stays open until you pick an option (or a yes/no ruling).');
        setDrafts((prev) => ({ ...prev, [p.id]: '' }));
      } else if (res.error === 'credential_pending') {
        // Todo 77c88942 + ticket ad4fae90: a credential gate never resolves on
        // answer text — route the owner to the dedicated key field. Since
        // 2026-10-20 only a paste-shaped reply (a token / PEM typed into the
        // text box) lands here; plain words go through reply_recorded above.
        toast.error('Recorded — but that looked like a key, and keys pasted as text are never stored. Use the key field on the card (it goes straight to your encrypted credentials and opens the gate), or store it via store_secret, or add it under Account → Coding → Credentials. It stays open.');
      } else {
        toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
      }
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [drafts, refresh]);

  /** Ticket ad4fae90: submit a credential-gated card's secret field — the
   *  value vault-stores server-side and the gate lifts on that very answer. */
  const submitCredential = useCallback(async (p: PendingConfirmation) => {
    const value = (secretDrafts[p.id] ?? '').trim();
    if (!value) { toast.error('Paste the key first.'); return; }
    setBusyId(p.id);
    try {
      const res = await confirmationsApi.answerOwnerQuestion(p.id, value, { credentialPaste: true });
      if (res.success) {
        // Post-merge review F-A: resolved but NOT stored (preset-managed key /
        // size limit / kill switch) must not toast "Key stored".
        if ((res as { pasteRefused?: boolean }).pasteRefused) {
          toast.error('Question resolved — but the pasted key was NOT stored (it may be preset-managed or refused). A previously stored key still governs; manage it under Account → Coding → Credentials.');
        } else {
          toast.success('Key stored — the gate is open and the chat is being told now.');
        }
        setSecretDrafts((prev) => ({ ...prev, [p.id]: '' }));
      } else if (res.error === 'credential_pending') {
        toast.error('Recorded — but the gate did not open. The key may be missing or malformed; paste the full value (a single token or a complete key block) and try again.');
      } else {
        toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
      }
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [secretDrafts, refresh]);

  /** One-tap pick of a typed option (todo 0dd7d3f2) — the flagger's option
   *  labels post through the normal answer path, where matchAnswerToOption
   *  stamps chosenOption and resolves the card. Same shape as the rail's
   *  OwnerQuestionCard quick-picks. */
  const pickOption = useCallback(async (p: PendingConfirmation, label: string) => {
    setBusyId(p.id);
    try {
      const res = await confirmationsApi.answerOwnerQuestion(p.id, label);
      if (res.success) {
        toast.success(`Recorded: ${label}`);
        setDrafts((prev) => ({ ...prev, [p.id]: '' }));
      } else if (res.error === 'reply_recorded') {
        toast.info('Sent to the chat as a reply — the chat is being woken with your words now. The card stays open until you pick an option (or a yes/no ruling).');
      } else if (res.error === 'credential_pending') {
        toast.error('This question needs a key, not a text answer — use the key field on the card, store it via store_secret, or add it under Account → Coding → Credentials; it stays open.');
      } else {
        toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
      }
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [refresh]);

  /** Dismiss a flagged owner question ("stop raising this"). */
  const dismissQuestion = useCallback(async (p: PendingConfirmation) => {
    setBusyId(p.id);
    try {
      const res = await confirmationsApi.dismissOwnerQuestion(p.id);
      if (res.success) {
        toast.success('Dismissed — the chat is told not to raise it again.');
      } else {
        toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
      }
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [refresh]);

  /** One-tap approve/decline (ticket 43212128) — a canned answer through the
   *  same answer path (posted back into the flagging chat's transcript + the
   *  chat is woken immediately), so a yes/no decision never needs typing.
   *  Review finding 1 (todo 0dd7d3f2): a CHOICE card has no approve/decline
   *  ruling — on a choice row these canned answers are a mismatch, so route
   *  reply_recorded to the honest reply toast, never the raw error code. */
  const quickResolve = useCallback(async (p: PendingConfirmation, decision: 'approve' | 'decline') => {
    setBusyId(p.id);
    try {
      const res = await confirmationsApi.answerOwnerQuestion(p.id, decision === 'approve' ? 'Approved.' : 'Declined.');
      if (res.success) {
        toast.success(decision === 'approve' ? 'Approved — the chat is told now.' : 'Declined — the chat is told now.');
        setDrafts((prev) => ({ ...prev, [p.id]: '' }));
      } else if (res.error === 'reply_recorded') {
        toast.info('Sent to the chat as a reply — the chat is being woken with your words now, but a choice card resolves by picking an option. Open the card above (or in the chat) to pick one.');
      } else {
        toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
      }
    } finally {
      setBusyId(null);
      refresh();
    }
  }, [refresh]);

  if (items === null) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const ownerQuestions = items.filter((p) => p.kind === 'owner_question' && !p.triaged);
  // Owner 2026-09-18 ("chats say waiting for my response but my inbox is
  // empty"): questions a supervisor is answering first are shown, muted, so the
  // owner can tell a real wait from a lane's wording — and pre-empt if they want.
  const triagedQuestions = items.filter((p) => p.kind === 'owner_question' && p.triaged);
  const confirmations = items.filter((p) => p.kind === 'confirmation' && !p.expired);
  const liveAsks = items.filter((p) => p.kind === 'question' || p.kind === 'approval');
  const expiredTraces = items.filter((p) => p.kind === 'confirmation' && p.expired);

  if (items.length === 0) {
    return (
      <Empty className="py-16 border-none">
        <EmptyHeader>
          <EmptyMedia>
            <Inbox className="size-8 text-muted-foreground/50" />
          </EmptyMedia>
          <EmptyDescription className="text-sm text-muted-foreground">Nothing needs you right now.</EmptyDescription>
          <EmptyDescription className="text-xs text-muted-foreground/70">
            Confirmations and agent-flagged questions persist here until you answer or dismiss them.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-4">
      {ownerQuestions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BellRing className="size-4 text-warn-ink" />
              Owner questions ({ownerQuestions.length})
              <span className="text-xs font-normal text-muted-foreground">— flagged by an agent; they never expire</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {ownerQuestions.map((p) => (
              <div key={p.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground truncate">{p.title || 'Untitled chat'}</span>
                  <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">{relativeTime(new Date(p.ts).toISOString())}</span>
                </div>
                {/* Ticket 1b1c41bc: a console-action row renders its body as
                    markdown — the composed four-element body carries the
                    paste-ready payload in a fenced block, and the markdown
                    renderer gives every fenced block a Copy button. Plain
                    text would flatten the payload into an uncopyable wall. */}
                {p.consoleAction ? (
                  <div className="text-sm break-words">
                    <MarkdownContent textSizeCls="text-[13.5px] leading-[1.55]">{p.question}</MarkdownContent>
                  </div>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{p.question}</p>
                )}
                {/* 2026-10-20: the flagger's context — what it tried, the
                    policy / console steps the owner needs — collapsed under the
                    question; markdown so a fenced policy block gets the Copy
                    button. Before this nothing the agent put in context ever
                    reached the owner ("the read-only policy I sent"). */}
                {p.context && (
                  <details className="rounded-md border border-line bg-background/60 px-2.5 py-1.5" data-owner-context>
                    <summary className="cursor-pointer select-none text-[11.5px] font-medium text-ink-3">Details from the agent</summary>
                    <div className="mt-1.5 text-sm break-words">
                      <MarkdownContent textSizeCls="text-[13px] leading-[1.5]">{p.context}</MarkdownContent>
                    </div>
                  </details>
                )}
                {/* Ticket 26786762: delivered credentials — the card text
                    carries numbered handles ("[SECRET 1]"); the values live
                    server-side, encrypted, revealed on demand here. */}
                {p.secrets && p.secrets.length > 0 && (
                  <div className="rounded-md border border-line bg-background p-2.5 space-y-1.5" data-delivered-secrets>
                    <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                      <KeyRound className="size-3 text-warn" aria-hidden="true" />
                      Delivered credential{p.secrets.length > 1 ? 's' : ''} — reveal to copy
                    </div>
                    {p.secrets.map((s) => {
                      const r = revealedSecrets[p.id]?.[s.ordinal];
                      return (
                        <div key={s.ordinal} className="flex flex-wrap items-center gap-1.5" data-delivered-secret={s.ordinal}>
                          <span className="text-xs text-ink-2">
                            <span className="font-medium text-ink">[SECRET {s.ordinal}]</span> {s.label} <span className="text-ink-4">({s.preview})</span>
                          </span>
                          {!r ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={revealBusyKey !== null}
                              onClick={() => void revealDelivered(p, s.ordinal)}
                              className="h-7 gap-1 text-xs"
                              data-reveal-secret={s.ordinal}
                            >
                              {revealBusyKey === `${p.id}:${s.ordinal}` ? <Loader2 className="size-3 animate-spin" /> : <Eye className="size-3" />}
                              Reveal
                            </Button>
                          ) : r.value ? (
                            <>
                              <code className="max-w-full break-all rounded-md bg-hover px-1.5 py-0.5 text-[11.5px] text-ink" data-secret-value={s.ordinal}>{r.value}</code>
                              <Button variant="outline" size="sm" onClick={() => void copyTextToClipboard(r.value!)} className="h-7 gap-1 text-xs" data-copy-secret={s.ordinal}>
                                <Copy className="size-3" /> Copy
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRevealedSecrets((prev) => {
                                  const nextCard = { ...(prev[p.id] ?? {}) };
                                  delete nextCard[s.ordinal];
                                  return { ...prev, [p.id]: nextCard };
                                })}
                                className="h-7 gap-1 text-xs"
                                data-hide-secret={s.ordinal}
                              >
                                <EyeOff className="size-3" /> Hide
                              </Button>
                            </>
                          ) : (
                            <span className="text-[11.5px] text-warn" data-secret-error={s.ordinal}>{r.error}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Ticket ad4fae90: a credential-gated row gets the dedicated
                    masked key field — the vault stores the value and the gate
                    lifts on this very answer; the free-text box stays for
                    nuance/questions back. */}
                {p.needsCredential && (
                  <div className="rounded-md border border-line bg-background p-2.5 space-y-1.5" data-credential-input>
                    <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
                      <KeyRound className="size-3 text-warn" aria-hidden="true" />
                      This question needs a key
                    </div>
                    <p className="text-[11.5px] leading-snug text-ink-3">
                      Paste it here — it goes straight to your encrypted credentials (never stored in the chat), and the waiting agent can use it immediately as an environment variable.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={secretDrafts[p.id] ?? ''}
                        onChange={(e) => setSecretDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitCredential(p); } }}
                        disabled={busyId === p.id}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder="Paste the key…"
                        aria-label="Credential value for this question"
                        className="min-w-0 flex-1 rounded-md border border-line bg-background px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-warn disabled:opacity-50"
                        data-credential-value
                      />
                      <Button size="sm" disabled={busyId === p.id || !(secretDrafts[p.id] ?? '').trim()} onClick={() => void submitCredential(p)} data-credential-submit>
                        <KeyRound className="size-3.5" /> Store key
                      </Button>
                    </div>
                  </div>
                )}
                {/* One-tap decision (ticket 43212128) / typed options (todo
                    0dd7d3f2): with the flagger's typed options the quick-picks
                    ARE those labels (an exact match resolves + stamps
                    chosenOption); without them it's the classic Approve/Decline.
                    The free-text path below stays for nuance/questions back. */}
                {p.options && p.options.length > 0 ? (
                  <div className="flex flex-wrap gap-2" data-owner-options>
                    {p.options.map((label, i) => (
                      <Button key={`${p.id}:${i}:${label}`} size="sm" disabled={busyId === p.id} onClick={() => void pickOption(p, label)} data-owner-option={label}>
                        {label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busyId === p.id} onClick={() => void quickResolve(p, 'approve')}>
                      <Check className="size-3.5" /> Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => void quickResolve(p, 'decline')}>
                      <X className="size-3.5" /> Decline
                    </Button>
                  </div>
                )}
                <Textarea
                  value={drafts[p.id] ?? ''}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  placeholder="Or type a specific answer — posted back into that chat…"
                  rows={2}
                  className="text-sm"
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" disabled={busyId === p.id} onClick={() => void answerQuestion(p)}>
                    Send answer
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void dismissQuestion(p)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {triagedQuestions.length > 0 && (
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <BellRing className="size-4 text-muted-foreground/60" />
              Being answered by your supervisors ({triagedQuestions.length})
              <span className="text-xs font-normal text-muted-foreground/80">— nothing needed from you yet; each reaches you if still open at its deadline</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {triagedQuestions.map((p) => (
              <div key={p.id} className="rounded-md border border-dashed p-3 space-y-2 opacity-80">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground truncate">{p.title || 'Untitled chat'}</span>
                  <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">
                    {p.triageUntil ? `surfaces ${relativeTime(new Date(p.triageUntil).toISOString())}` : relativeTime(new Date(p.ts).toISOString())}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{p.question}</p>
                {/* Review finding 1 (todo 0dd7d3f2): a TRIAGED choice card is the
                    oq_17b85b72 specimen class — it needs its typed options as
                    quick-picks, not just approve/decline (which are mismatches
                    on a choice row). */}
                {p.options && p.options.length > 0 ? (
                  <div className="flex flex-wrap gap-2" data-owner-options>
                    {p.options.map((label, i) => (
                      <Button key={`${p.id}:${i}:${label}`} size="sm" variant="outline" disabled={busyId === p.id} onClick={() => void pickOption(p, label)} data-owner-option={label}>
                        {label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => void quickResolve(p, 'approve')}>
                      <Check className="size-3.5" /> Answer now: approve
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busyId === p.id} onClick={() => void quickResolve(p, 'decline')}>
                      <X className="size-3.5" /> Decline
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {confirmations.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquareWarning className="size-4 text-warn-ink" />
              Pending confirmations ({confirmations.length})
              <span className="text-xs font-normal text-muted-foreground">— staged actions; they persist until answered</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {confirmations.map((p) => (
              <div key={p.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground truncate">{p.title || 'Untitled chat'}</span>
                  <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">{relativeTime(new Date(p.ts).toISOString())}</span>
                </div>
                <p className="text-sm">{p.question}</p>
                {p.stale ? (
                  <>
                    <p className="text-[11px] text-warn-ink/80">
                      ⏳ Staged too long ago to run safely — ask the chat to re-stage it if still wanted.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => void resolveConfirmation(p, 'cancel')}>
                        Dismiss
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busyId === p.id} onClick={() => void resolveConfirmation(p, 'confirm')}>
                      Confirm
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === p.id} onClick={() => void resolveConfirmation(p, 'cancel')}>
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {liveAsks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BellRing className="size-4" />
              Live questions &amp; approvals ({liveAsks.length})
              <span className="text-xs font-normal text-muted-foreground">— a run is blocked on these right now</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {liveAsks.map((p) => (
              <div key={p.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground truncate">{p.title || 'Untitled chat'}</span>
                  <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">{relativeTime(new Date(p.ts).toISOString())}</span>
                </div>
                <p className="text-sm">
                  {p.kind === 'approval' ? 'Approval: ' : ''}{p.question}
                </p>
                {/* Owner 2026-10-20: "i cant click approve or allow or anything" —
                    answer INLINE through the run's own endpoints (the same calls
                    the chat view makes); Open chat stays as the secondary action. */}
                <div className="flex flex-wrap gap-2">
                  {p.kind === 'approval' ? (
                    <>
                      <Button size="sm" disabled={liveBusyId === p.id} onClick={() => void resolveLiveApproval(p, 'allow')}>Allow</Button>
                      <Button size="sm" variant="outline" disabled={liveBusyId === p.id} onClick={() => void resolveLiveApproval(p, 'always')} title="Allow this tool for the rest of the run">Always</Button>
                      <Button size="sm" variant="outline" disabled={liveBusyId === p.id} onClick={() => void resolveLiveApproval(p, 'deny')}>Deny</Button>
                    </>
                  ) : (
                    (p.options ?? []).slice(0, 4).map((opt) => (
                      <Button key={opt} size="sm" variant="outline" disabled={liveBusyId === p.id} onClick={() => void answerLiveQuestion(p, opt)} title={opt}>
                        <span className="max-w-[16rem] truncate">{opt}</span>
                      </Button>
                    ))
                  )}
                  <Button size="sm" variant="ghost" onClick={() => router.push(`/?chatId=${p.chatId}`)}>
                    Open chat
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {expiredTraces.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlarmClockOff className="size-4" />
              Recently expired ({expiredTraces.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {expiredTraces.map((p) => (
              <div key={p.id} className="rounded-md border border-dashed p-3 opacity-70">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground truncate">{p.title || 'Untitled chat'}</span>
                  <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">
                    expired {p.expiresAt != null ? relativeTime(new Date(p.expiresAt).toISOString()) : ''}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{p.question}</p>
                <p className="text-[11px] text-muted-foreground/80">
                  ⏳ Expired unconfirmed — ask the chat to re-stage it if still wanted.
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
