/**
 * Thinking stays hidden (owner 2026-10-04: "by default always hide thinking and dont show in network calls or
 * anything to a user the thinking process").
 *
 * The server no longer sends model reasoning to any client (backend coding/reasoning-wire.ts). This flag is the
 * client half: the stream normalisers drop any reasoning event that still arrives (an older backend, a replay of a
 * run recorded before the change), and AssistantParts hides reasoning parts already saved in a guest's local
 * history. NEXT_PUBLIC_HIDE_REASONING_DISABLED=1 (build-time, pairs with the backend's HIDE_REASONING_DISABLED=1)
 * restores the thinking rows, chips and the session view's Show/Hide thinking toggle.
 */
// A function, read at call time: Next inlines the literal `process.env.NEXT_PUBLIC_…` at build either way, and tests
// can flip it per case.
export function reasoningVisible(): boolean {
  return process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED === '1';
}
