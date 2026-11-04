'use client';

/**
 * AgentMessageCard — an agent-to-agent relay (send_chat_message from another
 * Digby chat: metadata.origin 'agent' and/or the position-0
 * '[AGENT-SENT MESSAGE — from chat "<title>" (<id8>), another Digby agent,
 * NOT the owner. …]' provenance header). Owner ask 2026-09-14: these USER-role
 * rows rendered as the OWNER's brand bubble, indistinguishable from the owner
 * typing.
 *
 * Renders as a LEFT-aligned neutral card: header "From <sender> · agent"
 * (title + id8 parsed from the header when present, else "another agent";
 * the sender name deep-links to /crossmodel?chatId=<full id> when the
 * caller has metadata.sourceChatId), the raw header line itself HIDDEN, and
 * the body collapsed past ~8 lines with a "Show more" toggle. Body renders as
 * markdown (relays carry bullets/links); the collapse is a CSS max-height so
 * a truncated fence can never mis-render.
 *
 * COLLAPSE, never filter — the full body is one click away. Collapse state is
 * per instance (the parent keys rows by id), so a refetch never resets it.
 */

import { useState } from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseAgentSendHeader } from '@/lib/machine-wake';
import { localizeUtcTimes } from '@/lib/localize-utc-times';
import { CHAT_DEEP_LINK } from '@/lib/session-links';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';

/** Past this many lines (or characters) the body starts collapsed. */
const COLLAPSE_LINES = 8;
const COLLAPSE_CHARS = 700;

export function isLongAgentBody(body: string): boolean {
  const lines = body.split('\n').filter((l) => l.trim().length > 0).length;
  return lines > COLLAPSE_LINES || body.length > COLLAPSE_CHARS;
}

export default function AgentMessageCard({
  content,
  sourceChatId,
  timeLabel,
}: {
  content: string;
  /** metadata.sourceChatId of the relay (full chat id) — enables the header link. */
  sourceChatId?: string;
  timeLabel?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const { title, id8, body: rawBody } = parseAgentSendHeader(content);
  // Owner 2026-09-14: agent relays quote the harness clock — show local time.
  const body = localizeUtcTimes(rawBody);
  const sender = title || id8 || 'another agent';
  const href = sourceChatId ? `${CHAT_DEEP_LINK}${sourceChatId}` : undefined;
  const long = isLongAgentBody(body);
  const collapsed = long && !showAll;

  return (
    <div className="w-full min-w-0 rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-agent-message>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Bot className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          From{' '}
          {href ? (
            <a href={href} className="font-medium text-foreground/80 underline-offset-2 hover:underline" title={`Open chat ${sourceChatId}`}>
              {sender}
            </a>
          ) : (
            <span className="font-medium text-foreground/80">{sender}</span>
          )}
          {' · agent'}
        </span>
        {timeLabel && <span className="ml-auto shrink-0">{timeLabel}</span>}
      </div>
      <div className={cn('relative min-w-0', collapsed && 'max-h-48 overflow-hidden')}>
        <MarkdownContent
          textSizeCls="text-sm leading-6"
          h1Cls="text-base" h2Cls="text-sm" h3Cls="text-sm" h4Cls="text-sm"
          thCls="text-xs" tdCls="text-xs"
        >
          {body}
        </MarkdownContent>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-muted/80 to-transparent" aria-hidden="true" />
        )}
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="mt-1 text-[11.5px] font-medium text-ink-2 underline decoration-line-2 underline-offset-[3px] hover:text-ink"
        >
          {showAll ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
