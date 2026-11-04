/**
 * Thinking stays on the server (owner 2026-10-04: "by default always hide thinking and dont show in network calls
 * or anything to a user the thinking process").
 *
 * A model's reasoning (provider `reasoning_content`, a leading `<think>` block) is still produced, kept in the run's
 * TurnResult and fed back to the model where a vendor needs it (Kimi K3 history, wrong-tool detection, truncation
 * recovery, the empty-reply retry) — it simply never leaves the backend. The events that used to carry it to a
 * client are dropped at the wire:
 *   - `reasoning` / `subagent:reasoning` — the agent loop's raw deltas (coding runs; chat runs translate them);
 *   - `thinking-summary` — the chat adapter's "Digby: <first 160 chars of raw reasoning>" line;
 *   - `agent-activity` with `kind:'reasoning'` — the chat mirror of the raw deltas (lead, Double Checker, council).
 * Cut points: live-runs.ts pushRunEvent (the live buffer, every attached SSE writer, the agent_events Postgres tap
 * and the cross-instance Redis mirror tap all hang off it), the chat agent's `send` wrapper (the foreground stream),
 * and coding-stream.controller createFrameWriter (rows already stored in agent_events before this shipped).
 * The chat adapter shows a plain "Digby is thinking it through…" status line in place of the stream.
 *
 * Kill switch HIDE_REASONING_DISABLED=1 restores the reasoning stream byte-for-byte. Pure leaf — no imports.
 */

export function hideReasoningDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.HIDE_REASONING_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** True for an event whose payload is model reasoning (see the list above). Pure. */
export function isReasoningEvent(type: string, data: unknown): boolean {
  if (type === 'reasoning' || type === 'subagent:reasoning' || type === 'thinking-summary') return true;
  if (type === 'agent-activity' && data && typeof data === 'object' && (data as { kind?: unknown }).kind === 'reasoning') return true;
  return false;
}

/** True when this event must not reach a client (reasoning, and the switch is not set). */
export function withholdFromClient(type: string, data: unknown, env: Record<string, string | undefined> = process.env): boolean {
  return isReasoningEvent(type, data) && !hideReasoningDisabled(env);
}
