/**
 * Chat open + mid-run resume — regression pins for ticket 5060c3d2
 * (owner report, verbatim: "the chat ui is so bad i cant open older chats and
 * when i leave a chat and come back mid response i dont see the current
 * progress").
 *
 * TWO DISTINCT DEFECTS, both on the PLAIN chat path in the unified view:
 *
 *  1. "can't open older chats" — there was no loading state at all. The only
 *     `Opening session` loader was CODING-gated (`if (!activeSession &&
 *     !plain)`), and the plain load effect hard-clears `messages` before its
 *     blocking transcript GET. So the empty-state branch painted the NEW-CHAT
 *     home hero ("Ask Digby anything") for the whole round trip — and forever
 *     if the GET hung (a hung fetch never rejects, so `loadFailed` never
 *     fires). Opening any older/uncached chat therefore looked identical to
 *     failing to open it.
 *
 *  2. "don't see the current progress" — the attach decision read ONLY
 *     `attachOnLoad`, the page's LOCAL run mark. That mark dies with the
 *     unmount, so a fresh tab / hard reload / return during a live run
 *     attached to nothing and rendered a settled chat with no spinner and no
 *     answer, i.e. the run looked dead. The one fallback was a single
 *     tri-state probe whose `null` means UNKNOWN and which is never retried
 *     until a focus/visibility event.
 *
 * The fix carries the cross-process busy truth (`isChatBusy`, the same helper
 * `listChats` ships as `running`) on the chat GET the view already makes, and
 * attaches from it. Backend coverage for the DTO field lives in
 * `backend/src/modules/crossmodel/crossmodel.service.test.ts`
 * ("getChatById — live run truth"); this file pins the VIEW wiring, which is
 * what silently regresses.
 *
 * Household idiom (`guest-reload-state.test.ts`, `chat-return-instant.*`):
 * source-level pins in a node environment — stable identifiers, never line
 * numbers, plus an order assertion where ORDER is the actual bug.
 *
 * VERIFICATION-ONLY: a failing row is a BLOCKED finding to report, never a
 * test to weaken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const VIEW = readSrc('./components/CodeSessionView.tsx');
const API = readSrc('../../lib/api/crossmodel.ts');

/** Slice helper for region-anchored pins (fails loudly when an anchor drifts). */
function region(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  expect(a, `region anchor ${JSON.stringify(from)} missing`).toBeGreaterThanOrEqual(0);
  expect(b, `region anchor ${JSON.stringify(to)} missing`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('1. older/uncached plain chat renders an honest loader, not the new-chat hero', () => {
  it('the view has a PLAIN loading arm (the loader used to be coding-gated only)', () => {
    // The coding arm must stay exactly as it was — this is an ADDITION.
    expect(VIEW).toContain('if (!activeSession && !plain) {');
    const plainArm = region(
      VIEW,
      'if (plain && chatId && !plainLoaded && messages.length === 0 && !live.running) {',
      '// Plain mode renders at the user',
    );
    expect(plainArm).toContain('<DigbyLoader size={40} label="Opening chat" />');
    // It renders the header like its coding twin, so the surface doesn't jump.
    expect(plainArm).toContain('{header}');
  });

  it('it is gated on the transcript having SETTLED, so a snapshot first paint still renders instantly', () => {
    const gate = VIEW.slice(
      VIEW.indexOf('if (plain && chatId && !plainLoaded && messages.length === 0 && !live.running) {') - 1,
      VIEW.indexOf('if (plain && chatId && !plainLoaded && messages.length === 0 && !live.running) {') + 200,
    );
    // plainLoaded = the GET settled. Without it a chat whose load hangs spins
    // forever instead of showing the hero; WITH messages.length===0 a
    // snapshot/instant first paint (ce78ab80, b5734922) is never covered up.
    expect(gate).toContain('!plainLoaded');
    expect(gate).toContain('messages.length === 0');
  });

  it('ORDER: the plain loader is decided BEFORE the empty-home hero can paint', () => {
    // This is the whole bug. The hero is `messages.length === 0 && !live.running`
    // — true on every cold plain open — so if it is reached first it wins and
    // the user sees "Ask Digby anything" on a chat that is about to fill.
    const loaderAt = VIEW.indexOf('label="Opening chat"');
    const heroAt = VIEW.indexOf('{messages.length === 0 && !live.running && (');
    expect(loaderAt, 'plain loader missing').toBeGreaterThanOrEqual(0);
    expect(heroAt, 'empty-home hero anchor missing').toBeGreaterThanOrEqual(0);
    expect(loaderAt).toBeLessThan(heroAt);
  });

  it('an idle chat that has loaded shows NO loader (it must not stick)', () => {
    // plainLoaded flips true on both the success and the catch path, so the
    // arm can never trap the view. The catch sets loadFailed, which renders
    // EARLIER (the error/deleted arms are above this block).
    const errArm = VIEW.indexOf("if (loadFailed === 'error') {");
    const loaderAt = VIEW.indexOf('label="Opening chat"');
    expect(errArm).toBeGreaterThanOrEqual(0);
    expect(errArm).toBeLessThan(loaderAt); // a failed load shows retry, not a spinner
  });
});

describe('2. returning to a chat mid-run restores live progress from SERVER truth', () => {
  const attachLine = 'const attach = !!plainRef.current?.attachOnLoad || full.running === true;';

  it('the attach decision consults the fetched chat row, not only the dead local mark', () => {
    const load = region(
      VIEW,
      'const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });',
      'const attach = !!plainRef.current?.attachOnLoad || full.running === true;',
    );
    expect(load).toContain('const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });');
    expect(VIEW).toContain(attachLine);
    // The pre-existing local mark MUST stay — it is what makes a locally
    // started run attach before the list round trip lands.
    expect(attachLine).toContain('!!plainRef.current?.attachOnLoad');
    expect(attachLine).toContain('full.running === true');
  });

  it('it is a STRICT === true, so an older backend (field absent) keeps today behaviour', () => {
    // Deploy skew: during a rolling deploy the view can talk to a backend that
    // does not send `running` yet. `undefined` must read as "no evidence of a
    // run" — NOT as a false negative that suppresses the probe, and not as a
    // truthy attach. A bare `full.running` would be ambiguous; `=== true` is not.
    expect(VIEW).toContain('full.running === true');
    expect(VIEW).not.toContain('const attach = !!plainRef.current?.attachOnLoad || full.running;');
  });

  it('running:true drives the SAME live chrome a locally-started run gets', () => {
    const after = region(
      VIEW,
      'const attach = !!plainRef.current?.attachOnLoad || full.running === true;',
      'if (attach) {',
    );
    // One state object for both sources — a server-truth attach is not a
    // second-class path with a different spinner/progress contract.
    expect(after).toContain('setLive({ parts: [], pendingApproval: null, running: attach });');
    expect(after).toContain('setPlainLoaded(true);');
    // And it connects to the real stream, which replays what was missed.
    const connect = region(VIEW, 'if (attach) {', '} else {');
    expect(connect).toContain('connectStream(chatId, \'\', { attach: true });');
  });

  it('the tri-state probe remains the fallback for runs started elsewhere', () => {
    // Telegram / schedule / another device / another instance: the GET field
    // covers these too, but the probe stays as the belt-and-braces path and
    // must keep its "definitive TRUE only" contract (null = unknown = skip).
    //
    // SCOPE MATTERS: `region(VIEW, '} else {', ...)` is useless here — the
    // FIRST `} else {` in the file is ~46k chars earlier, so the region would
    // span the whole plain-load body and `connectStream(...)` would match the
    // `if (attach)` branch, passing even with the probe deleted. Anchor on the
    // probe itself so the assertions can only pass if the probe is present.
    const probeAt = VIEW.indexOf('const active = await fetchPlainRunActive(chatId);');
    expect(probeAt, 'the tri-state liveness probe is gone — runs started outside this tab can no longer attach').toBeGreaterThanOrEqual(0);
    const probe = region(
      VIEW,
      'const active = await fetchPlainRunActive(chatId);',
      '})();',
    );
    expect(probe).toContain('if (active !== true || activeIdRef.current !== chatId || esRef.current) return;');
    expect(probe).toContain("connectStream(chatId, '', { attach: true });");
    // And it must sit INSIDE the else-branch of the attach decision, i.e. it is
    // the fallback rather than the primary path.
    const attachAt = VIEW.indexOf('const attach = !!plainRef.current?.attachOnLoad || full.running === true;');
    expect(attachAt).toBeGreaterThanOrEqual(0);
    expect(attachAt).toBeLessThan(probeAt);
  });

  it('the API type documents the field and the undefined-means-unknown rule', () => {
    // NOT `expect(API).toContain('running?: boolean;')` — CrossModelChat on
    // origin/main already carries that line, so a file-wide match would pass
    // with this whole type change reverted. Scope to the Detail interface and
    // pin the DOC text, which only exists here.
    const iface = region(API, 'export interface CrossModelChatDetail extends CrossModelChat {', '\n}');
    expect(iface).toContain('running?: boolean;');
    // The doc comment must keep the deploy-skew rule legible to the next dev.
    expect(iface).toContain('no evidence');
    expect(iface).toContain('5060c3d2');
  });
});