/**
 * Ticket 00504a77 — desktop-shell mic gate. The Digby macOS app (WKWebView)
 * injects window.__digbyDesktop; the WEB recorder is not usable there (the
 * mic button's MediaRecorder fallback calls getUserMedia, raising the macOS
 * Microphone permission prompt for a path that cannot work). The helper
 * below drives the startRecording refusal. Since 2026-10-20 the mic button
 * RENDERS in the shell too (owner: one composer UI for chats and coding
 * sessions) and its tap is handed to the shell's native recorder over the
 * dictation bridge (`desktopShellCanDictate` / `requestDesktopShellDictation`).
 *
 * vitest environment is 'node' — no window global unless we install one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  isDigbyDesktopShell,
  desktopShellCanDictate,
  requestDesktopShellDictation,
  SHELL_PTT_HINT,
  shouldRestartRecognition,
  VOICE_START_WATCHDOG_MS,
  createVoiceSessionState,
  startSpeechSession,
} from './use-voice-composer';

describe('isDigbyDesktopShell (ticket 00504a77)', () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('returns false with no window at all (SSR / node)', () => {
    expect(isDigbyDesktopShell()).toBe(false);
  });

  it('returns false in a plain browser window (flag absent)', () => {
    (globalThis as any).window = {};
    expect(isDigbyDesktopShell()).toBe(false);
  });

  it('returns true when the desktop shell injected the flag', () => {
    (globalThis as any).window = {
      __digbyDesktop: { version: '0.1.6', platform: 'mac', canSetupIMessage: true },
    };
    expect(isDigbyDesktopShell()).toBe(true);
  });
});

/* ── Ticket 020d979d — voice input dead while queueing messages ──────────────
 *
 * Root cause: the Web Speech branch ran with `continuous = true`. Safari's
 * webkitSpeechRecognition NEVER delivers onresult in that mode (the mic shows
 * "Listening…", nothing is ever written into the composer — the filed report
 * "it says listening and i talk … but it doesn't write anything"), and the
 * engine dies silently in iOS home-screen PWAs. The fix: DISCRETE sessions
 * (continuous=false) that auto-restart on every onend while the user's voice
 * session is live. The helpers below are the pure decision core; the source
 * pins mirror c1-convergence-smoke.test.tsx (vitest is node-env — no jsdom,
 * so the wiring itself is pinned at source level).
 */
describe('shouldRestartRecognition (ticket 020d979d)', () => {
  it('restarts after a normal utterance end (the discrete-session replacement for continuous=true)', () => {
    // A live session: same generation, no manual stop, no error. This is the
    // behavior that keeps the mic "listening" on Safari, where continuous
    // mode never delivers a single result.
    expect(shouldRestartRecognition({ mySession: 3, sessionRefValue: 3, stoppingRefValue: false, lastError: null })).toBe(true);
  });

  it('treats no-speech as transient silence — the mic keeps listening (restart)', () => {
    // A silence gap between utterances fires error 'no-speech' then onend;
    // stopping there would end the session after the first pause.
    expect(shouldRestartRecognition({ mySession: 3, sessionRefValue: 3, stoppingRefValue: false, lastError: 'no-speech' })).toBe(true);
  });

  it('does NOT restart after the user stopped the mic (manual stop latch)', () => {
    expect(shouldRestartRecognition({ mySession: 3, sessionRefValue: 3, stoppingRefValue: true, lastError: null })).toBe(false);
  });

  it('does NOT restart after a send/queue discarded the session (generation advanced)', () => {
    // "Hitting send turns the mic off" (0c256c3a): discardRecording bumps the
    // generation; the trailing onend must not resurrect the session.
    expect(shouldRestartRecognition({ mySession: 3, sessionRefValue: 4, stoppingRefValue: false, lastError: null })).toBe(false);
  });

  it('does NOT restart after a real engine error (not-allowed / network / …)', () => {
    expect(shouldRestartRecognition({ mySession: 3, sessionRefValue: 3, stoppingRefValue: false, lastError: 'network' })).toBe(false);
    expect(shouldRestartRecognition({ mySession: 3, sessionRefValue: 3, stoppingRefValue: false, lastError: 'not-allowed' })).toBe(false);
  });
});

describe('discrete-session wiring (ticket 020d979d, source pins)', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./use-voice-composer.ts', import.meta.url)), 'utf8');

  it('the Web Speech branch pins continuous=false (the Safari onresult fix)', () => {
    expect(SRC).toContain('recognition.continuous = false');
    expect(SRC).not.toContain('recognition.continuous = true');
  });

  it('a start watchdog bounds the iOS-PWA silent-death class with an honest error', () => {
    expect(SRC).toContain('VOICE_START_WATCHDOG_MS');
    expect(SRC).toMatch(/Voice input (started but the browser never delivered|stopped receiving) speech events/);
    expect(VOICE_START_WATCHDOG_MS).toBeGreaterThan(2500); // ≥ the documented iOS permission-to-capture delay
  });

  it('no-speech is transient in the error handler (a silence gap must not end the session)', () => {
    expect(SRC).toContain("event.error !== 'aborted' && event.error !== 'no-speech'");
  });
});

/* ── Review 020d979d rework: the real wiring, driven behaviorally ────────────
 *
 * The reviewer's C8: the original suite pinned only the pure gate
 * (shouldRestartRecognition) and some source-text pins — 11/11 green while
 * three BLOCKING wiring defects shipped. The helpers the hook actually runs
 * are exported and engine-agnostic, so these tests drive the REAL session
 * wiring (startSpeechSession) with fake SpeechRecognition instances and a
 * hook-shaped ref pair — the same code path useVoiceComposer executes, with
 * the exact latching/generation/identity discipline the blockers were about.
 * vitest environment is 'node' (no jsdom/react render), so the hook body
 * itself remains pinned at source level below. */
describe('startSpeechSession wiring (review 020d979d rework)', () => {
  /** A hook-shaped live-recognition ref: exactly what useVoiceComposer's
   *  recognitionRef looks like from the helper's side. */
  function makeHarness() {
    let liveRecognition: any = null;
    let generation = 1;
    const created: any[] = [];
    const composed: string[] = [];
    const toasts: string[] = [];
    const deadEngineToasts: string[] = [];
    const makeRecognition = () => {
      const instance: any = {
        continuous: undefined,
        interimResults: undefined,
        lang: undefined,
        started: 0,
        stopped: 0,
        aborted: 0,
        start: () => { instance.started++; },
        stop: () => { instance.stopped++; },
        abort: () => { instance.aborted++; },
      };
      created.push(instance);
      return instance;
    };
    const run = (state = createVoiceSessionState(generation)) => {
      startSpeechSession({
        makeRecognition,
        state,
        getSessionGeneration: () => generation,
        getLiveRecognition: () => liveRecognition,
        setLiveRecognition: (r) => { liveRecognition = r; },
        compose: (finalSoFar, interimText) => {
          composed.push([finalSoFar, interimText].filter(Boolean).join(' '));
        },
        onDeadEngine: (m) => { deadEngineToasts.push(m); },
        onErrorToast: (m) => { toasts.push(m); },
      });
      return state;
    };
    return {
      run,
      getLive: () => liveRecognition,
      setLive: (r: any) => { liveRecognition = r; },
      getGeneration: () => generation,
      bumpGeneration: () => { generation += 1; },
      created,
      composed,
      toasts,
      deadEngineToasts,
    };
  }

  /** Fire a fake result event on an instance. */
  const fireResult = (instance: any, text: string, isFinal: boolean) => {
    instance.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal }] });
  };

  it('starts one instance with discrete-session settings and composes results', () => {
    const h = makeHarness();
    h.run();
    expect(h.created).toHaveLength(1);
    expect(h.created[0].continuous).toBe(false); // the Safari onresult fix
    expect(h.created[0].interimResults).toBe(true);
    expect(h.created[0].lang).toBe('en-US');
    expect(h.created[0].started).toBe(1);
    fireResult(h.created[0], 'hello world', true);
    expect(h.composed).toEqual(['hello world']);
    expect(h.getLive()).toBe(h.created[0]);
  });

  it('restarts with a FRESH instance after a normal utterance end (discrete sessions)', () => {
    const h = makeHarness();
    h.run();
    fireResult(h.created[0], 'first', true);
    h.created[0].onend();
    // C5: a fresh instance per restart, the old one never restarted itself
    expect(h.created).toHaveLength(2);
    expect(h.created[1]).not.toBe(h.created[0]);
    expect(h.created[0].started).toBe(1);
    expect(h.created[1].started).toBe(1);
    expect(h.getLive()).toBe(h.created[1]);
  });

  it('keeps confirmed words across a restart (no lost-word window, C6)', () => {
    const h = makeHarness();
    h.run();
    fireResult(h.created[0], 'first words', true);
    h.created[0].onend(); // restart
    fireResult(h.created[1], 'second words', true);
    expect(h.composed).toEqual(['first words', 'first words second words']);
  });

  it('REGRESSION C1: a manual stop does NOT restart the engine', () => {
    const h = makeHarness();
    const state = h.run();
    fireResult(h.created[0], 'hello', true);
    // Manual stop, hook-style: latch stopping on the live session state
    // object (captured by every closure), then stop() — the trailing onend
    // must NOT resurrect the engine.
    state.stopping = true;
    h.created[0].stop();
    h.created[0].onend();
    expect(h.created).toHaveLength(1); // no restart, no new instance
    expect(h.getLive()).toBeNull(); // ref cleared by the identity-guarded onend
  });

  it('REGRESSION C1: a manual stop still delivers the trailing final result (last words kept)', () => {
    const h = makeHarness();
    const state = h.run();
    fireResult(h.created[0], 'hello', true);
    state.stopping = true; // manual stop latch
    fireResult(h.created[0], ' and goodbye', true); // trailing result from stop()
    h.created[0].onend();
    expect(h.composed).toEqual(['hello', 'hello and goodbye']);
    expect(h.created).toHaveLength(1);
  });

  it('REGRESSION C2: the dead-engine watchdog abort does NOT restart (no toast-loop)', async () => {
    const h = makeHarness();
    h.run();
    expect(h.created[0].started).toBe(1);
    // Engine goes totally silent: no results, no onend — the watchdog fires
    await new Promise((r) => setTimeout(r, VOICE_START_WATCHDOG_MS + 50));
    expect(h.created[0].aborted).toBe(1); // watchdog aborted the dead engine
    expect(h.deadEngineToasts).toHaveLength(1); // exactly ONE honest error
    h.created[0].onend(); // the abort's trailing onend — the toast-loop vector
    expect(h.created).toHaveLength(1); // REGRESSION: no restart
    expect(h.deadEngineToasts).toHaveLength(1); // still exactly one toast
    expect(h.getLive()).toBeNull();
  }, VOICE_START_WATCHDOG_MS + 5000); // waits out the real watchdog

  it('REGRESSION C2: the watchdog cannot false-fire on a thinking pause with speech behind it', async () => {
    const h = makeHarness();
    h.run();
    fireResult(h.created[0], 'some words', true); // disarm via first result
    h.created[0].onend(); // restart (alive signal)
    // A 4-second (and more) thinking pause after speech: nothing fires
    await new Promise((r) => setTimeout(r, Math.min(VOICE_START_WATCHDOG_MS + 50, 4500)));
    expect(h.created[0].aborted).toBe(0);
    expect(h.deadEngineToasts).toHaveLength(0);
    expect(h.created).toHaveLength(2); // only the utterance-end restart
  });

  it('REGRESSION C3: a discarded session\u2019s late onend does NOT clobber the newer live session', () => {
    // ONE shared ref pair — exactly the hook's recognitionRef. Session A is
    // discarded (send commits the draft), session B starts talking on the
    // SAME ref, then A's trailing onend arrives. The ticket's exact
    // queue-and-keep-talking flow.
    const h = makeHarness();
    const stateA = h.run(); // session A, generation 1
    fireResult(h.created[0], 'words before send', true);
    expect(h.composed).toEqual(['words before send']);
    // discardRecording, hook-style: bump the generation, latch stopping on
    // the discarded session's state, null the shared ref (abort semantics).
    h.bumpGeneration();
    stateA.stopping = true;
    h.setLive(null);
    // The user keeps talking: a NEW session starts on the SAME ref pair.
    h.run(); // session B, generation 2, fresh state — created[1] is live
    expect(h.getLive()).toBe(h.created[1]);
    // Session A's onend arrives LATE (after the send).
    h.created[0].onend();
    // Session B is untouched: still live, still the recognition ref, no
    // restart of A, no toasts. (An unconditional ref clear here is the
    // original C3 defect — it would null B's live instance.)
    expect(h.getLive()).toBe(h.created[1]);
    expect(h.created).toHaveLength(2); // no resurrected A instance
    expect(h.created[1].started).toBe(1);
    expect(h.created[1].aborted).toBe(0);
    expect(h.toasts).toEqual([]);
    expect(h.deadEngineToasts).toEqual([]);
  });

  it('REGRESSION C3: a discarded session\u2019s late RESULT does not write into the composer', () => {
    const h = makeHarness();
    const state = h.run();
    fireResult(h.created[0], 'pre-send words', true);
    // discard: generation advances past this session's
    h.bumpGeneration();
    state.stopping = true;
    h.setLive(null);
    // Late trailing result from the discarded session — must be dropped
    fireResult(h.created[0], 'stale trailing', true);
    expect(h.composed).toEqual(['pre-send words']); // nothing new written
  });

  it('a real engine error ends the session honestly (no restart, one toast)', () => {
    const h = makeHarness();
    h.run();
    h.created[0].onerror({ error: 'network' });
    expect(h.toasts).toEqual(['Voice recognition error. Please try again.']);
    h.created[0].onend();
    expect(h.created).toHaveLength(1); // error latched: no restart
  });

  it('no-speech is transient: the restart cycle keeps the mic listening through a silence gap', () => {
    const h = makeHarness();
    h.run();
    h.created[0].onerror({ error: 'no-speech' });
    h.created[0].onend(); // must still restart (silence gap between utterances)
    expect(h.created).toHaveLength(2);
    expect(h.toasts).toEqual([]); // no error surfaced for a silence gap
  });
});

describe('hook source pins (review 020d979d rework — the hook body itself)', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./use-voice-composer.ts', import.meta.url)), 'utf8');

  it('C1: every stop path latches the hook-level stop flag on the live session state', () => {
    // stopRecording, discardRecording and the unmount cleanup must ALL set
    // `.stopping = true` on voiceSessionRef.current BEFORE stopping/aborting
    // — the reviewer traced manualStop being set only in the two onerror
    // branches, so a manual mic-click-off resurrected the engine.
    const latchings = SRC.match(/voiceSessionRef\.current\.stopping = true/g) ?? [];
    expect(latchings.length).toBeGreaterThanOrEqual(3); // stop + discard + unmount
    // ...and the two error terminal branches must NOT carry their own latch
    // anymore (the latch is hook-level now, not error-branch-local).
    expect(SRC).not.toContain('manualStop = true');
  });

  it('C2: the watchdog latches stopping BEFORE its abort (order pinned)', () => {
    const watchdogBlock = SRC.slice(
      SRC.indexOf('const armWatchdog'),
      SRC.indexOf('const startFreshInstance'),
    );
    const latchAt = watchdogBlock.indexOf('state.stopping = true');
    const abortAt = watchdogBlock.indexOf('abort()');
    expect(latchAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(-1);
    expect(latchAt).toBeLessThan(abortAt);
    // Threshold: generous enough that a thinking pause (4s class) with zero
    // speech behind it cannot false-fire either.
    expect(VOICE_START_WATCHDOG_MS).toBeGreaterThanOrEqual(8000);
  });

  it('C3: every ref mutation is identity-guarded (no unconditional recognitionRef writes)', () => {
    // The stale-clobber vector was unconditional `recognitionRef.current =
    // null` inside handlers. All ref writes now flow through the guarded
    // setLiveRecognition / isMyInstance discipline.
    expect(SRC).not.toMatch(/on(end|error)[^;]*\{[^}]*recognitionRef\.current = null/);
    expect(SRC).toContain('isMyInstance(recognition)');
    expect(SRC).toContain('setLiveRecognition(null)');
  });

  it('C5: restarts create a fresh instance (no same-instance recognition.start() in onend)', () => {
    const onendBlock = SRC.slice(SRC.indexOf('recognition.onend ='), SRC.indexOf('recognition.onerror ='));
    expect(onendBlock).toContain('startFreshInstance()');
    expect(onendBlock).not.toContain('recognition.start()');
  });

  it('the phantom isSpeechRecognitionLive reference is gone (C7)', () => {
    expect(SRC).not.toContain('isSpeechRecognitionLive');
  });

  it('the hook wires the session helper with its own refs (the helper is the real path)', () => {
    expect(SRC).toContain('startSpeechSession({');
    expect(SRC).toContain('getSessionGeneration: () => sessionRef.current');
    expect(SRC).toContain('setLiveRecognition: (r) => { recognitionRef.current = r; }');
  });

  it('the MediaRecorder fallback and desktop-shell gate are untouched by the rework (constraint)', () => {
    // The rework must not alter the fallback path or the 00504a77 gate: the
    // shell never reaches getUserMedia — the tap goes to the native recorder
    // (dictation bridge) or, on an older shell, names the ⇧⌘Space shortcut.
    expect(SRC).toContain('navigator.mediaDevices.getUserMedia({ audio: true })');
    expect(SRC).toContain("if (isDigbyDesktopShell()) {");
    expect(SRC).toContain('if (!requestDesktopShellDictation()) toast.info(SHELL_PTT_HINT);');
    expect(SRC).toContain('voiceApi.transcribe');
  });
});

/* ── 2026-10-20: the mic renders in the desktop shell and dictates natively ── */
describe('desktop-shell dictation bridge (one composer UI for chats and coding)', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./use-voice-composer.ts', import.meta.url)), 'utf8');
  afterEach(() => { delete (globalThis as any).window; });

  it('canDictate is false outside the shell and on a shell without the flag', () => {
    expect(desktopShellCanDictate()).toBe(false);
    (globalThis as any).window = { __digbyDesktop: { version: '0.1.10', platform: 'mac', canSetupIMessage: true } };
    expect(desktopShellCanDictate()).toBe(false);
    expect(requestDesktopShellDictation()).toBe(false);
  });

  it('a shell advertising canDictate with the digby bridge takes the dictate toggle', () => {
    const posted: unknown[] = [];
    (globalThis as any).window = {
      __digbyDesktop: { version: '0.1.11', platform: 'mac', canSetupIMessage: true, canDictate: true },
      webkit: { messageHandlers: { digby: { postMessage: (m: unknown) => posted.push(m) } } },
    };
    expect(desktopShellCanDictate()).toBe(true);
    expect(requestDesktopShellDictation()).toBe(true);
    expect(posted).toEqual([{ type: 'voice', event: 'dictate' }]);
  });

  it('the older-shell hint names the push-to-talk shortcut (never "isn\'t available")', () => {
    expect(SHELL_PTT_HINT).toContain('⇧⌘Space');
    expect(SRC).not.toContain("isn't available in the Mac app");
  });

  it('BOTH composer hosts render the mic unconditionally (no isDesktopShell render gate)', () => {
    const page = readFileSync(fileURLToPath(new URL('../page.tsx', import.meta.url)), 'utf8');
    const csv = readFileSync(fileURLToPath(new URL('./CodeSessionView.tsx', import.meta.url)), 'utf8');
    for (const src of [page, csv]) {
      expect(src).not.toContain('isDesktopShell');
      expect(src).not.toContain('isDigbyDesktopShell');
    }
    expect(page).toContain("aria-label={isTranscribing ? 'Transcribing' : isRecording ? 'Stop recording' : 'Voice input'}");
    expect(csv).toContain("aria-label={voice.isTranscribing ? 'Transcribing' : voice.isRecording ? 'Stop recording' : 'Voice input'}");
  });

  it('the hook mirrors the native recorder state from the digby:voice window event', () => {
    expect(SRC).toContain("export const SHELL_VOICE_EVENT = 'digby:voice';");
    expect(SRC).toContain('window.addEventListener(SHELL_VOICE_EVENT, onShellVoice);');
  });
});
