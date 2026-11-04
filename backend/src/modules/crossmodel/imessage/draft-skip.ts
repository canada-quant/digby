/**
 * When the post-answer iMessage send classifier must NOT run (audit 2026-10-08 W4-6).
 *
 * THE BUG: chat-agent runs classifySendDraft after EVERY human turn of a user with a paired Mac, on any chat type.
 * On a Project Supervisor chat the owner wrote "well message the tt-rd supervisor …" — an IN-APP message to another
 * Digby chat — the imessage_send gate read send=0.96, the utility classifier drafted it and an iMessage confirm card
 * popped ("Lol…tt-rd is a project supervisor chat in digby not a imessage contact"). All 3 such cards since 10-01
 * were declined.
 *
 * THE RULE (deterministic, before any model call):
 *   - a supervisor-class chat never drafts an iMessage — "message X" there is fleet work (send_chat_message);
 *   - a turn that already sent an IN-APP message (send_chat_message / send_to_instance / notify_user …) answered the
 *     ask in-app — the same words must not also become a text.
 * The classifier's own prompt also learns that a message to a Digby chat / lane / session / supervisor is in-app
 * (imessage/nlp.ts). Kill switch IMESSAGE_DRAFT_INAPP_SKIP_DISABLED=1 (the classifier runs on every turn again).
 * Telemetry: loop_metrics `imessage_draft_skipped` {reason} (chat-agent).
 */

/** Tools that deliver a message INSIDE Digby (or to the owner's own channel) — never an iMessage. */
export const IN_APP_MESSAGE_TOOLS: ReadonlySet<string> = new Set([
  'send_chat_message', 'send_to_instance', 'notify_user', 'dispatch_platform_task', 'send_email_as_digby',
]);

export type ImessageDraftSkipReason = 'supervisor_chat' | 'in_app_send';

export function imessageDraftInAppSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMESSAGE_DRAFT_INAPP_SKIP_DISABLED === '1';
}

/** Why the classifier must not run on this turn, or null. Pure. */
export function imessageDraftSkipReason(i: { supervisorChat: boolean; toolNames: readonly string[] }, env: NodeJS.ProcessEnv = process.env): ImessageDraftSkipReason | null {
  if (imessageDraftInAppSkipDisabled(env)) return null;
  if (i.supervisorChat) return 'supervisor_chat';
  if (i.toolNames.some((n) => IN_APP_MESSAGE_TOOLS.has(n))) return 'in_app_send';
  return null;
}

/** Distinct tool names a run called (tool_call parts; pure, bad input ⇒ []). */
export function toolNamesCalled(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts as Array<Record<string, unknown>>) {
    if (p && p.type === 'tool_call' && typeof p.name === 'string' && !out.includes(p.name)) out.push(p.name);
  }
  return out;
}
