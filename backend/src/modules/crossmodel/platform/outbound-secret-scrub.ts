/**
 * Outbound secret scrub (audit 2026-10-06 T2-2).
 *
 * An owner-pasted key reached four more transcripts because agents RELAYED
 * it: a project supervisor forwarded the plaintext to a lane with
 * send_chat_message, and the D4 redaction only ever covered machine READS.
 * The two agent-authored outbound channels that persist or deliver text to
 * someone else now redact credential-shaped values before anything is
 * stored, staged or sent — on machine AND human turns:
 *   - send_chat_message `content` (platform-tools.ts — before the
 *     consequential gate, so the staged card, its persisted args, the
 *     execute-time log line and the target chat all hold the redacted body;
 *     the REST confirm path re-scrubs a card staged before this shipped);
 *   - notify_user `message` (account-tools.ts — the Telegram push).
 * The redaction is ANNOUNCED in the tool result (secretsRedacted + the
 * notice naming store_secret / $ENVKEY), never silent, and one loop_metrics
 * row `outbound_secret_redacted` {tool, targetChatId, hits, count, machine}
 * records it. Kill switch OUTBOUND_SECRET_REDACT_DISABLED=1 (secret-scan.ts
 * redactOutboundSecrets) restores the verbatim send byte-for-byte.
 *
 * LEAF-ish: only the secret-scan leaf is imported statically; the metric
 * rides a dynamic import (account-tools.ts / platform-tools.ts import
 * discipline — a heavy static import here would kill unrelated jest graphs).
 */
import { redactOutboundSecrets, outboundRedactionNotice } from './secret-scan';

export interface OutboundScrub {
  /** The arg that was rewritten (`content` / `message`). */
  field: string;
  /** Pattern names that hit (never the values). */
  hits: string[];
  /** How many values were replaced. */
  count: number;
}

/**
 * Redact ONE string field of a tool's args. Returns the rewritten args COPY
 * plus what was dropped, or null when nothing was redacted (clean text, a
 * non-string field, or the kill switch). The input is never mutated.
 */
export function scrubOutboundField<T>(args: T, field: string): { args: T; scrub: OutboundScrub } | null {
  try {
    const v = (args as any)?.[field];
    if (typeof v !== 'string' || !v) return null;
    const r = redactOutboundSecrets(v);
    if (!r.hits.length || r.text === v) return null;
    return { args: { ...(args as any), [field]: r.text } as T, scrub: { field, hits: r.hits, count: Math.max(1, r.count) } };
  } catch {
    return null;
  }
}

/**
 * Announce the redaction on a tool result: a JSON object result gains
 * `secretsRedacted {field, count, patterns}` and the notice is appended to
 * its `message` (or set as `note` when it has none), so receipts and envelope
 * parsers keep working; any other result gets the notice on its own line.
 */
export function appendOutboundRedactionNote(result: string, scrub: OutboundScrub): string {
  const notice = outboundRedactionNotice(scrub.hits, scrub.count);
  if (typeof result !== 'string') return result;
  const trimmed = result.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.secretsRedacted = { field: scrub.field, count: scrub.count, patterns: scrub.hits };
        if (typeof parsed.message === 'string' && parsed.message) parsed.message = `${parsed.message} ${notice}`;
        else parsed.note = typeof parsed.note === 'string' && parsed.note ? `${parsed.note} ${notice}` : notice;
        return JSON.stringify(parsed);
      }
    } catch { /* not JSON — fall through to the text form */ }
  }
  return result ? `${result}\n\n${notice}` : notice;
}

/** One `outbound_secret_redacted` loop_metrics row. Fire-and-forget; never throws. */
export function recordOutboundRedaction(
  ctx: { sessionId?: string; userTurnAt?: Date | null; machineTriggered?: boolean } | null | undefined,
  tool: string,
  targetChatId: unknown,
  scrub: OutboundScrub,
): void {
  try {
    const machine = !!ctx && (ctx.machineTriggered === true || !ctx.userTurnAt);
    void import('./loop-metrics.service')
      .then((m: any) => {
        if (typeof m?.recordLoopMetric !== 'function') return;
        m.recordLoopMetric({
          kind: 'outbound_secret_redacted',
          sessionId: ctx?.sessionId,
          value: scrub.count,
          meta: {
            tool,
            field: scrub.field,
            targetChatId: typeof targetChatId === 'string' && targetChatId ? targetChatId : null,
            hits: scrub.hits,
            count: scrub.count,
            machine,
          },
        });
      })
      .catch(() => { /* telemetry never blocks a send */ });
  } catch { /* never throws */ }
}
