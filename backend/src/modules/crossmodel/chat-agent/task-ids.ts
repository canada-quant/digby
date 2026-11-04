/**
 * Task ids — the ONE convention every branch of the task card shares
 * (cohesive-chat wave). Import-free leaf so the coding plane (the deliverable
 * hand-off) and the chat plane (task-events) agree without either pulling the
 * other's module graph in.
 */

/** ONE taskId per sub-session: the spawn-time running card (chat-agent finalize)
 *  and the hand-off's done card (coding/deliverable-handoff.ts) share it, so
 *  the card the user watched flips to done instead of a second card appearing. */
export function taskIdForSession(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The sessionId behind a session task id, or null for any other task. */
export function sessionIdOfTaskId(taskId: string): string | null {
  return typeof taskId === 'string' && taskId.startsWith('session:') && taskId.length > 8 ? taskId.slice(8) : null;
}
