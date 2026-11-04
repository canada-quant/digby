/**
 * Ticket 3dcb5b99 — the mic button must render in EVERY composer surface.
 *
 * THE BUG (owner report 2026-10-23, fleet supervisor chat): voice input's
 * microphone button was completely absent from the chat composer. Root
 * cause: ChatComposer renders the mic ONLY through the host-supplied
 * `rightActions` slot, and the Fleet Supervisor chat tab (SupervisorChatTab)
 * passed `leftActions` (attach) but never `rightActions` — so that surface
 * had no mic at all, while the main chat (page.tsx) and coding sessions
 * (CodeSessionView) did. Commit ceb6fe658 (2026-10-20, "the mic renders in
 * every composer" — owner: one composer UI for chats and coding sessions)
 * covered 2 of the 3 ChatComposer hosts; this third was missed.
 *
 * THE FIX: SupervisorChatTab adopts the shared useVoiceComposer hook and
 * passes the same mic button in rightActions, and its send() calls
 * discardRecording() after committing the draft ("hitting send turns the mic
 * off" — 0c256c3a) so a sent draft is never re-injected by trailing
 * recognition results.
 *
 * SOURCE-LEVEL pins in the management-shell.pins idiom: anchor on stable
 * identifiers, never line numbers. The host list is derived from the repo
 * (grep '<ChatComposer'), so a FOURTH host added without rightActions must
 * be added here (and wired) — the completeness pin names them all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Every file that renders <ChatComposer — the mic contract applies to all. */
const HOSTS = [
  ['main chat (page.tsx)', '../page.tsx'],
  ['coding sessions (CodeSessionView.tsx)', '../components/CodeSessionView.tsx'],
  ['fleet supervisor chat (SupervisorChatTab.tsx)', './SupervisorChatTab.tsx'],
] as const;

const TAB = read('./SupervisorChatTab.tsx');

describe('ticket 3dcb5b99 — the mic renders in every composer (voice input UI regression)', () => {
  it.each(HOSTS)('%s wires voice input (useVoiceComposer + a rightActions mic)', (_name, rel) => {
    const src = read(rel);
    expect(src).toContain('useVoiceComposer');
    expect(src).toMatch(/rightActions=\{\(?<>?/);
    // The button itself: the Voice input affordance with its recording states.
    expect(src).toContain("'Voice input'");
    expect(src).toContain("'Stop recording'");
  });

  it('the supervisor chat hands the tap to the shared hook and turns the mic off on send', () => {
    // The hook is instantiated against the tab's own composer refs.
    expect(TAB).toContain('useVoiceComposer({ composerRef, textareaRef })');
    expect(TAB).toContain('toggleRecording: handleMicClick');
    expect(TAB).toContain('onClick={handleMicClick}');
    // 0c256c3a: committing the draft (send) must abort any live recording so
    // trailing results are never re-injected into the cleared composer.
    expect(TAB).toContain('discardRecording();');
  });

  it('review F3 (PR #1913): discardRecording fires BEFORE the send await — mic auto-off is atomic with the send', () => {
    // CodeSessionView review M1 round 2 doctrine: discarding only AFTER the
    // await leaves recognition live during the POST, so trailing speech
    // re-writes the just-cleared composer and survives. The discard must
    // precede the network call.
    const discardIdx = TAB.indexOf('discardRecording();');
    const sendIdx = TAB.indexOf('await fleetApi.sendSupervisorMessage(');
    expect(discardIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(discardIdx).toBeLessThan(sendIdx);
  });

  it('review F1 (PR #1913): the recording placeholder mirrors the other hosts (Safari live feedback)', () => {
    // page.tsx / CodeSessionView both surface '🎤 Listening… speak now' while
    // recording — the strongest live feedback on iOS Safari (020d979d class),
    // where nothing is inserted until a final result arrives.
    expect(TAB).toContain("isRecording ? '🎤 Listening… speak now'");
  });
});
