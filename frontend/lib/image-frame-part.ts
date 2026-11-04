/**
 * Live / replayed `image` SSE frame → transcript image part (2026-09-24 review).
 *
 * ONE mapping for both lanes: CodeSessionView's coding-lane frame handler and
 * plain-session's legacy normalizer used to rebuild the part with a field
 * whitelist (mediaType/data/name/source/pageUrl/app) that dropped the
 * generated-image fields — so the live figure rendered but had no Download /
 * Open row until a reload. The persisted part (agent.ts) and the crash-safe
 * partial (run-executor.ts) carry `url` + `fileId` + `prompt`; this helper
 * carries the same three, and accepts a frame with `url` but no `data`: the
 * durable log and the cross-instance mirror strip a generated image's base64
 * (durable-event-payload.ts), so a replayed frame renders from its lazy url
 * exactly like the persisted transcript part. Screenshots keep needing bytes.
 */

import type { MessagePart } from '@/lib/api/coding';

/** Returns the part for an `image` frame, or null when the frame carries neither bytes nor a lazy url. */
export function imagePartFromFrame(data: any): MessagePart | null {
  if (!data || typeof data !== 'object') return null;
  const bytes = typeof data.data === 'string' && data.data ? data.data : '';
  const url = typeof data.url === 'string' && data.url ? data.url : '';
  if (!bytes && !url) return null;
  const part: MessagePart = {
    type: 'image',
    mediaType: String(data.mediaType || 'image/png'),
    ...(bytes ? { data: bytes } : {}),
    name: data.name,
    source: data.source,
    pageUrl: data.pageUrl,
    app: data.app,
  };
  if (url) part.url = url;
  if (typeof data.fileId === 'string' && data.fileId) part.fileId = data.fileId;
  if (typeof data.prompt === 'string' && data.prompt) part.prompt = data.prompt;
  return part;
}
