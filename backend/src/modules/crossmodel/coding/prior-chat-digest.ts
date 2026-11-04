/**
 * PRIOR CHAT-ENGINE TOOL CALLS in a coding run's history (audit 2026-10-06
 * T7-11 — stanne.md #7).
 *
 * A plain chat that becomes coding-capable (configure_workspace / attach)
 * keeps its earlier chat-engine turns in crossmodel_messages, and the coding
 * run's history loads them — but history is CONTENT only, so the tool calls
 * those turns made (in `parts`) never reach the model. Stanne b8d8dd38: the
 * 18:55 turn spawned the lane with start_coding_session {title, goalId,
 * projectId, permissionMode} and NO prompt; the 19:14 coding run could not
 * see that, searched memory four times, concluded "the spawn args were
 * clipped by compaction" and filed a ticket with an undetermined root cause.
 *
 * For history rows written BEFORE the chat's coding state existed (the
 * chat-engine era), the run-executor appends a compact digest of the turn's
 * tool calls (name + argument keys with short values; ≤ PRIOR_TOOL_DIGEST_MAX
 * chars) to that assistant row's content. Rows from the coding era are never
 * touched (their tool calls are the coding transcript's own business).
 *
 * Pure leaf. Kill switch CODING_HISTORY_PRIOR_TOOL_DIGEST_DISABLED=1 (read
 * per call): history content exactly as before.
 */

export function priorToolDigestDisabled(): boolean {
  const v = String(process.env.CODING_HISTORY_PRIOR_TOOL_DIGEST_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export const PRIOR_TOOL_DIGEST_MAX = 1200;
const VALUE_MAX = 60;
const CALLS_MAX = 12;

function shortValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return JSON.stringify(v.length > VALUE_MAX ? `${v.slice(0, VALUE_MAX - 1)}…` : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  return '{…}';
}

/** One digest line for an assistant row's tool_call parts, or '' when it has none (pure). */
export function priorToolDigest(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const calls = parts.filter((p: any) => p && p.type === 'tool_call' && typeof p.name === 'string') as Array<{ name: string; args?: unknown }>;
  if (!calls.length) return '';
  const rendered: string[] = [];
  for (const c of calls.slice(0, CALLS_MAX)) {
    const args = c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {};
    const keys = Object.keys(args);
    rendered.push(keys.length ? `${c.name} {${keys.map((k) => `${k}: ${shortValue(args[k])}`).join(', ')}}` : `${c.name} {}`);
  }
  const more = calls.length > CALLS_MAX ? `; +${calls.length - CALLS_MAX} more` : '';
  let body = rendered.join('; ') + more;
  const head = '[Tool calls this earlier chat turn made (chat engine, before this chat became a coding session) — arguments exactly as sent; a key absent here was NOT passed: ';
  if (head.length + body.length + 1 > PRIOR_TOOL_DIGEST_MAX) body = `${body.slice(0, PRIOR_TOOL_DIGEST_MAX - head.length - 2)}…`;
  return `${head}${body}]`;
}
