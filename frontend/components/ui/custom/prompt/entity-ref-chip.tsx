'use client';

/**
 * One clickable reference in an answer — "session fbb5c9ca", "goal 534c37aa", "todo …", "receipt …"
 * (lib/entity-refs.ts makes the links). On click it asks the server where the id lives
 * (GET /api/crossmodel/refs/:kind/:id, owner-scoped) and opens it: a chat in place when the chat view published
 * ChatOpenContext, otherwise by navigating; a goal (or an unassigned todo) opens its project page. Hovering
 * resolves it once so the tooltip can name it. A miss says so in a toast and stays put.
 */

import { useContext, useState } from 'react';
import { CircleCheck, Loader2, MessagesSquare, ReceiptText, Target } from 'lucide-react';
import { toast } from 'sonner';
import apiClient from '@/lib/api-client';
import { ChatOpenContext } from '@/lib/chat-open-context';
import { CHAT_DEEP_LINK } from '@/lib/session-links';
import type { EntityRefKind } from '@/lib/entity-refs';

interface ResolvedRef {
  kind: EntityRefKind;
  id: string;
  title: string | null;
  open: { type: 'chat'; chatId: string } | { type: 'project'; projectId: string };
}

const cache = new Map<string, Promise<ResolvedRef | null>>();

export function resolveEntityRef(kind: EntityRefKind, id: string): Promise<ResolvedRef | null> {
  const key = `${kind}:${id}`;
  let p = cache.get(key);
  if (!p) {
    p = apiClient.get(`/crossmodel/refs/${kind}/${id}`)
      .then(r => (r.data?.data ?? null) as ResolvedRef | null)
      .catch(() => { cache.delete(key); return null; });
    cache.set(key, p);
  }
  return p;
}

const NOUN: Record<EntityRefKind, string> = { chat: 'chat', session: 'session', goal: 'goal', todo: 'todo', receipt: 'receipt' };

function KindIcon({ kind }: { kind: EntityRefKind }) {
  const cls = 'size-3 shrink-0 text-ink-3';
  if (kind === 'goal') return <Target className={cls} aria-hidden />;
  if (kind === 'todo') return <CircleCheck className={cls} aria-hidden />;
  if (kind === 'receipt') return <ReceiptText className={cls} aria-hidden />;
  return <MessagesSquare className={cls} aria-hidden />;
}

export function EntityRefChip({ kind, id }: { kind: EntityRefKind; id: string }) {
  const openChat = useContext(ChatOpenContext);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState<string | null>(null);

  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const ref = await resolveEntityRef(kind, id);
    setBusy(false);
    if (!ref) { toast.error(`Couldn't find ${NOUN[kind]} ${id}`); return; }
    if (ref.open.type === 'chat') {
      if (openChat) openChat(ref.open.chatId);
      else window.location.assign(`${CHAT_DEEP_LINK}${ref.open.chatId}`);
    } else {
      window.location.assign(`/projects/${ref.open.projectId}`);
    }
  };
  const peek = () => {
    if (label !== null) return;
    void resolveEntityRef(kind, id).then(ref => setLabel(ref?.title ? `Open ${NOUN[kind]}: ${ref.title}` : ''));
  };

  return (
    <button
      type="button"
      onClick={open}
      onMouseEnter={peek}
      onFocus={peek}
      title={label || `Open ${NOUN[kind]} ${id}`}
      data-entity-ref={kind}
      className="mx-[1px] inline-flex items-center gap-1 rounded-md border border-line bg-raised px-1.5 py-[1px] align-baseline font-mono text-[0.85em] leading-[1.35] text-ink-2 transition-colors hover:border-line-2 hover:bg-hover hover:text-ink"
    >
      {busy ? <Loader2 className="size-3 shrink-0 animate-spin text-ink-3" aria-hidden /> : <KindIcon kind={kind} />}
      {id}
    </button>
  );
}
