'use client';

/**
 * useVoiceComposer — shared voice input for the unified ChatComposer
 * (ticket 0c256c3a). Extracted from page.tsx's inline implementation so BOTH
 * surfaces (plain chat and coding sessions) get the microphone.
 *
 * Two transcription paths (unchanged from the original):
 *  - Web Speech API (Chrome / Edge): live interim results streamed into the draft.
 *  - MediaRecorder → Whisper (Firefox / unsupported browsers): transcribed on stop.
 *
 * Two ways to END a session — this distinction is the re-injection fix:
 *  - toggleRecording() (the mic button): recognition.stop() — trailing results
 *    ARE delivered and appended (the user wants their last words).
 *  - discardRecording() (a send/queue just committed the draft): recognition
 *    .abort() — NO trailing onresult fires, so the just-sent text is never
 *    re-injected into the cleared composer; the MediaRecorder path drops the
 *    chunks without a Whisper roundtrip. Hosts must call discardRecording()
 *    wherever a send/queue commits the draft ("hitting send turns the mic
 *    off" — 0c256c3a).
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { voiceApi } from '@/lib/api/crossmodel';
import type { ChatComposerHandle } from './ChatComposerTextarea';

/** True inside the Digby desktop shell (macOS WKWebView) — main.swift injects
 *  window.__digbyDesktop at document start. Ticket 00504a77: the WEB recorder
 *  is not usable in the Mac app (no SpeechRecognition; the MediaRecorder
 *  fallback's getUserMedia call raises the macOS Microphone prompt for a path
 *  that cannot work there), so startRecording never records in the shell.
 *  Since 2026-10-20 the mic button still RENDERS there (one composer UI for
 *  chats and coding sessions) and hands the tap to the shell's native
 *  recorder over the dictation bridge below. */
export function isDigbyDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__digbyDesktop);
}

/* ── Desktop-shell dictation bridge (owner 2026-10-20: "no different UI for
 * coding or chats" — the mic must exist everywhere) ────────────────────────
 *
 * The web mic cannot record inside the Mac shell (00504a77), but the shell
 * has its own native speech path (VoiceMode.swift, ⇧⌘Space push-to-talk).
 * The mic button therefore stays visible in the shell and hands the gesture
 * to the shell over the `digby` JS→native bridge as a DICTATE request
 * ({type:'voice', event:'dictate'} — toggle: first tap starts, second stops
 * and inserts the transcript into the focused composer WITHOUT sending).
 * The shell advertises support with `__digbyDesktop.canDictate`; it reports
 * its state back by dispatching `digby:voice` CustomEvents on window
 * ({detail:{state:'recording'|'transcribing'|'idle'}}) so the button mirrors
 * the native recorder. An older shell (no canDictate) gets a toast naming
 * the ⇧⌘Space shortcut instead of a dead button. */
export const SHELL_VOICE_EVENT = 'digby:voice';
export type ShellVoiceState = 'recording' | 'transcribing' | 'idle';

/** True when the shell can take a dictation request over the bridge. */
export function desktopShellCanDictate(): boolean {
  if (!isDigbyDesktopShell()) return false;
  const w = window as any;
  return Boolean(w.__digbyDesktop?.canDictate) && Boolean(w.webkit?.messageHandlers?.digby?.postMessage);
}

/** Post the dictate toggle to the shell; false when the bridge is missing. */
export function requestDesktopShellDictation(): boolean {
  if (!desktopShellCanDictate()) return false;
  try {
    (window as any).webkit.messageHandlers.digby.postMessage({ type: 'voice', event: 'dictate' });
    return true;
  } catch {
    return false;
  }
}

/** Copy for a shell that predates the dictation bridge (DMG ≤ 0.1.10). */
export const SHELL_PTT_HINT = 'In the Mac app, press ⇧⌘Space to talk (Voice → Push to Talk)';

/* ── Ticket 020d979d: iOS Safari never delivers onresult with continuous=true ──
 *
 * Root cause (web-verified 2026-09-23, 4 sources incl. web-speech-api#96):
 * Safari's webkitSpeechRecognition ignores `continuous=true` — it shows the
 * mic live ("🎤 Listening… speak now" placeholder, pulsing red mic) but NEVER
 * fires onresult, so nothing is ever written into the composer. The API also
 * dies silently in iOS home-screen PWAs (no onresult, no onend, no onerror).
 * Desktop users queueing a message while a run is live (the composer's
 * amber "queue" state — a run active is precisely when users want to keep
 * talking) were the reported surface, but the defect is engine-level, not
 * queue-mode-specific.
 *
 * Fix: DISCRETE sessions — `continuous=false` + automatic restart on each
 * onend (the documented Safari workaround; Chrome/Edge behave identically
 * through restarts). The session stays "recording" until the user stops.
 * The restart loop is latched by a HOOK-LEVEL stop flag plus the session
 * generation (review 020d979d C1/C2/C3): every restart creates a FRESH
 * SpeechRecognition instance (same-instance restarts are unreliable on iOS —
 * web sources recommend a new instance per restart), the dead-engine
 * watchdog's abort latches stoppingRef so its onend cannot restart the
 * engine, and handlers mutate the hook refs only while they still own the
 * live session generation. */
/**
 * Should the recognition engine auto-restart after an `onend`? True while the
 * user's voice session is still active (ticket 020d979d): a discrete
 * (continuous=false) session ends after EVERY utterance — restarting is what
 * keeps the mic "listening" — but only when (a) the session hasn't been
 * discarded (send/queue committed the draft), (b) a manual stop hasn't been
 * requested, and (c) the error (if any) is transient (`no-speech` = silence
 * gap between utterances, not a failure).
 */
export function shouldRestartRecognition(opts: {
  mySession: number;
  sessionRefValue: number;
  stoppingRefValue: boolean;
  lastError?: string | null;
}): boolean {
  if (opts.mySession !== opts.sessionRefValue) return false; // discarded on send (M2)
  if (opts.stoppingRefValue) return false; // manual stop or send-discard ended it
  // `no-speech` is the normal silence gap between utterances in a discrete
  // session — keep listening. Anything else (network, not-allowed, …) stops.
  if (opts.lastError && opts.lastError !== 'no-speech') return false;
  return true;
}

/** After how many ms of TOTAL engine silence — no result, no restart cycle,
 *  no `no-speech` — should the watchdog declare the engine silently dead
 *  (iOS PWA class: no onresult, no onend, no onerror at all)? Review C2:
 *  the threshold can never false-fire on a thinking pause — once ANY result
 *  was delivered the watchdog is disarmed for the rest of the session, and
 *  before the first word a healthy engine keeps re-arming it with alive
 *  signals (`no-speech` after its own silence timeout, then the restart
 *  cycle). 10s sits comfortably after the engines' own no-speech signals
 *  (Chrome ~8s) and before "Listening forever". */
export const VOICE_START_WATCHDOG_MS = 10000;

/** Shared mutable state for one live voice session — deliberately an
 * engine-agnostic plain object (review C8: the test suite must drive the
 * real wiring, not just the pure gate). The hook owns exactly one of these
 * via `sessionRef`; `startSpeechSession` wires a SpeechRecognition instance
 * to it. Everything the handlers need crosses this boundary, so the
 * regression tests exercise the same code path the hook runs. */
export interface VoiceSessionState {
  /** Hook-level stop latch (review C1): set by stopRecording/discardRecording
   *  and by the dead-engine watchdog (C2). Lives OUTSIDE the per-instance
   *  closure so a manual stop on ANY restart generation ends the session. */
  stopping: boolean;
  /** Session generation (review C3): handlers own the hook refs only while
   *  their captured generation still equals `sessionRef.current` — a stale
   *  handler from a discarded session can never clobber a newer live one. */
  generation: number;
  /** True once ANY result was delivered this session (watchdog guard). */
  gotAnyResult: boolean;
  /** Last engine error, if any ('' = none). */
  lastError: string;
}

export function createVoiceSessionState(generation: number): VoiceSessionState {
  return { stopping: false, generation, gotAnyResult: false, lastError: '' };
}

/** One discrete Web Speech session wired to the hook's shared session state
 *  (ticket 020d979d). Every restart creates a FRESH SpeechRecognition
 *  instance via `makeRecognition` (review C5: same-instance restarts are
 *  unreliable on iOS Safari — web sources recommend a fresh instance per
 *  restart). Handler discipline enforced here (C1/C2/C3):
 *   - onresult writes ONLY through `compose` and only while live;
 *   - onend restarts ONLY while live and never latched;
 *   - onerror and the watchdog clear the hook refs ONLY while this closure
 *     still owns the live recognition instance (identity guard);
 *   - the dead-engine watchdog's abort sets `stopping` FIRST (C2) so its own
 *     onend cannot resurrect the engine into a toast-loop.
 *  The dead-engine watchdog (C2/C4) only guards the pre-first-result phase:
 *  an engine that never delivers ANY event (iOS PWA class) is aborted with an
 *  honest error; once the first result arrives it is disarmed, and a healthy
 *  engine re-arms it with alive signals (no-speech → onend → restart) long
 *  before the threshold — so a thinking pause can never false-fire it. */
/** One discrete Web Speech session wired to the hook's shared session state
 *  (ticket 020d979d). Every restart creates a FRESH SpeechRecognition
 *  instance via `makeRecognition` (review C5: same-instance restarts are
 *  unreliable on iOS Safari — web sources recommend a fresh instance per
 *  restart). Handler discipline enforced here (C1/C2/C3):
 *   - every handler captures ITS OWN instance; the identity guard
 *     (`isMyInstance`) compares that captured instance against the live
 *     recognition ref — a stale handler can never speak for a newer one;
 *   - onresult composes only while live; a manual stop still receives the
 *     trailing final result (the user's last words are kept — only the
 *     RESTART latch engages, not the write gate);
 *   - onend NEVER restarts when the stop latch is set (C1) or when this
 *     instance no longer owns the ref (C3), and it clears the ref only via
 *     the identity-guarded endSession;
 *   - the dead-engine watchdog's abort sets `stopping` FIRST (C2) so its own
 *     onend cannot resurrect the engine into a toast-loop.
 *  The dead-engine watchdog (C2/C4) only guards the pre-first-result phase:
 *  an engine that never delivers ANY event (iOS PWA class) is aborted with an
 *  honest error; once the first result arrives it is disarmed, and a healthy
 *  engine re-arms it with alive signals (no-speech → onend → restart) long
 *  before the threshold — so a thinking pause can never false-fire it. */
export function startSpeechSession(opts: {
  makeRecognition: () => any;
  state: VoiceSessionState;
  /** The hook's CURRENT session generation (review C3): a stale handler
   *  compares its own captured generation against this — never against
   *  itself — so a discarded session's late onend can never restart or
   *  clobber a newer live session. */
  getSessionGeneration: () => number;
  getLiveRecognition: () => any;
  setLiveRecognition: (r: any) => void;
  compose: (finalSoFar: string, interimText: string) => void;
  onDeadEngine: (message: string) => void;
  onErrorToast: (message: string) => void;
}): void {
  const { state } = opts;
  let liveRecognition: any = null; // the instance this session currently runs on
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Confirmed finals accumulate at SESSION level (review C6): each restart
   *  is a fresh instance with an empty result buffer — without this hoist,
   *  words confirmed before a restart would vanish from the composition the
   *  moment the next instance delivered its first result. */
  let finalSoFar = '';

  const clearWatchdog = () => {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  };

  /** True while `instance` is the recognition this session currently runs
   *  on AND the hook's ref still points at it (C3). */
  const isMyInstance = (instance: any) =>
    instance !== null && instance === liveRecognition && instance === opts.getLiveRecognition();

  /** Ref mutations are IDENTITY-GUARDED (review C3): only the closure that
   *  still owns the live recognition ref may clear it — a stale handler
   *  ending after a newer session started clears nothing. */
  const endSession = () => {
    clearWatchdog();
    if (opts.getLiveRecognition() === liveRecognition) opts.setLiveRecognition(null);
  };

  /** Dead-engine watchdog (review C2/C4): guards the pre-first-result phase
   *  only — after the first onresult it is disarmed for the whole session (a
   *  thinking pause with words behind it can never trip it), and while armed
   *  a healthy engine keeps re-arming it with alive signals. When it DOES
   *  fire the engine has been totally silent for VOICE_START_WATCHDOG_MS:
   *  abort it and end the session with an honest error. The abort LATCHES
   *  `stopping` (C2) so the onend it triggers cannot restart — this is the
   *  fix for the toast-loop on iOS silent-death. */
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (state.gotAnyResult) return; // disarmed: real speech arrived
      state.stopping = true; // C2: latch BEFORE abort() — its onend must not restart
      try { liveRecognition?.abort(); } catch { /* already dead */ }
      endSession();
      opts.onDeadEngine('Voice input stopped receiving speech events — try again, or use the keyboard.');
    }, VOICE_START_WATCHDOG_MS);
  };

  /** Start a FRESH instance (C5) and arm its watchdog. */
  const startFreshInstance = () => {
    const recognition = opts.makeRecognition();
    liveRecognition = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      // Write gate (review C3 + the trailing-words contract): results are
      // composed only while this instance's generation is still the live one
      // (discardRecording bumps it — late results drop) and this instance
      // still owns the recognition ref. A MANUAL stop deliberately passes
      // here: stop() delivers a trailing final result the user wants kept,
      // and it changes neither the generation nor the ref — only the
      // restart latch, which onresult does not consult.
      if (state.generation !== opts.getSessionGeneration() || !isMyInstance(recognition)) return;
      state.gotAnyResult = true;
      clearWatchdog(); // C4: disarmed from the first result on — no dead timer
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalSoFar += (finalSoFar ? ' ' : '') + t.trim();
        } else {
          interimText += t;
        }
      }
      // Live update: confirmed finals + live interim. The hook's `compose`
      // prepends the base draft captured at session start, and finals live at
      // session level, so words are never lost across restarts (C6).
      opts.compose(finalSoFar, interimText);
    };

    recognition.onend = () => {
      clearWatchdog();
      if (state.stopping || !isMyInstance(recognition)) {
        // Stopped (manual stop / send-discard / watchdog abort) or superseded
        // by a newer session: clean up if we still own the ref — NEVER
        // restart, no toast (the stop path already updated the UI; a stale
        // handler clears nothing it no longer owns — C3).
        endSession();
        return;
      }
      if (
        shouldRestartRecognition({
          mySession: state.generation,
          sessionRefValue: opts.getSessionGeneration(),
          stoppingRefValue: state.stopping,
          lastError: state.lastError,
        })
      ) {
        // Discrete session ended (every utterance ends one): restart with a
        // FRESH instance — that is what keeps the mic "listening" without
        // continuous=true (020d979d). Clearing lastError lets the new
        // instance's own no-speech be re-evaluated on its own terms.
        state.lastError = '';
        startFreshInstance();
        armWatchdog(); // alive signal: a restart cycle just happened
        return;
      }
      endSession();
    };

    recognition.onerror = (event: any) => {
      state.lastError = event.error ?? '';
      if (event.error === 'not-allowed') {
        if (state.stopping || !isMyInstance(recognition)) return;
        endSession();
        opts.onErrorToast('Microphone access denied. Please allow microphone access and try again.');
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        // `no-speech` is a silence gap in a discrete session — transient,
        // onend restarts. Anything else ends the session honestly.
        if (state.stopping || !isMyInstance(recognition)) return;
        endSession();
        opts.onErrorToast('Voice recognition error. Please try again.');
      }
    };

    opts.setLiveRecognition(recognition);
    try { recognition.start(); } catch { /* already started — fine */ }
  };

  startFreshInstance();
  armWatchdog();
}

export function useVoiceComposer({
  composerRef,
  textareaRef,
}: {
  composerRef: RefObject<ChatComposerHandle | null>;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const recognitionRef = useRef<any>(null); // Web Speech API recognition instance
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  /** Set by discardRecording(): the next MediaRecorder onstop drops the audio
   *  instead of transcribing it (send-time auto-off must not re-inject). */
  const discardRef = useRef(false);
  /** The live voice session's shared state (review C1/C2/C3): the HOOK-LEVEL
   *  stop latch + generation + result bookkeeping. `stopping` is the stop
   *  latch that lives outside every per-instance closure — stopRecording,
   *  discardRecording, the unmount cleanup AND the dead-engine watchdog all
   *  set it, so no trailing onend can ever resurrect the engine. The
   *  `generation` is the session identity: startRecording and discardRecording
   *  replace the whole object (a new generation), so handlers from a stale
   *  session can never mutate hook refs owned by a newer live session. */
  const voiceSessionRef = useRef<VoiceSessionState | null>(null);
  /** Session generation (review M2): bumped by startRecording and
   *  discardRecording; result handlers capture it and refuse to write after a
   *  discard — late results from a stopped session (Whisper roundtrip,
   *  trailing Web-Speech finals) can never land in an already-cleared composer. */
  const sessionRef = useRef(0);
  /** Double-start guard (review N1): the getUserMedia await leaves a window
   *  where isRecording is still false — a second click would orphan a live
   *  recorder stream (mic hot, transcribing+appending later). */
  const startingRef = useRef(false);

  const focusComposer = useCallback(() => {
    setTimeout(() => textareaRef?.current?.focus(), 50);
  }, [textareaRef]);

  const startRecording = useCallback(async () => {
    // 00504a77: never request the mic inside the desktop shell — WKWebView has
    // no SpeechRecognition, so this would fall to getUserMedia and raise the
    // macOS Microphone prompt for a feature that cannot work there yet.
    // 2026-10-20: the gesture is handed to the shell's NATIVE recorder
    // instead (dictation bridge above); a shell without the bridge names the
    // push-to-talk shortcut rather than "isn't available".
    if (isDigbyDesktopShell()) {
      if (!requestDesktopShellDictation()) toast.info(SHELL_PTT_HINT);
      return;
    }
    if (startingRef.current) return;
    startingRef.current = true;
    const mySession = ++sessionRef.current;
    // ── Real-time transcription via Web Speech API (Chrome / Edge) ─────────
    const SpeechRecognitionClass = (typeof window !== 'undefined')
      && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

    if (SpeechRecognitionClass) {
      try {
        // Base draft captured ONCE per voice session: every restart's
        // onresult composes on top of it, so words are never lost across
        // restarts (review C6).
        const baseInput = (composerRef.current?.getValue() ?? '').trim();
        // Hook-level session state (review C1/C2/C3): a NEW object per
        // startRecording call — replacing it retires every handler of the
        // previous session at once.
        const voiceSession = createVoiceSessionState(mySession);
        voiceSessionRef.current = voiceSession;
        startSpeechSession({
          makeRecognition: () => new SpeechRecognitionClass() as any,
          state: voiceSession,
          getSessionGeneration: () => sessionRef.current, // C3: compare against the LIVE generation
          getLiveRecognition: () => recognitionRef.current,
          setLiveRecognition: (r) => { recognitionRef.current = r; },
          compose: (finalSoFar, interimText) => {
            if (voiceSessionRef.current !== voiceSession) return; // stale session — never write (C3/M2)
            if (mySession !== sessionRef.current) return; // discarded on send (M2)
            const parts = [baseInput, finalSoFar, interimText].filter(Boolean);
            composerRef.current?.setValue(parts.join(' '));
          },
          onDeadEngine: (message) => {
            if (voiceSessionRef.current !== voiceSession) return;
            setIsRecording(false);
            focusComposer();
            toast.error(message);
          },
          onErrorToast: (message) => {
            if (voiceSessionRef.current !== voiceSession) return;
            setIsRecording(false);
            focusComposer();
            toast.error(message);
          },
        });
        setIsRecording(true);
        startingRef.current = false;
      } catch {
        startingRef.current = false;
        toast.error('Could not start voice recognition. Please check your microphone.');
      }
      return;
    }

    // ── Fallback: MediaRecorder → Whisper API (Firefox / unsupported browsers) ─
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      discardRef.current = false;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        // discardRecording() stopped us: drop the audio, no Whisper roundtrip,
        // nothing appended to the (already-committed-and-cleared) draft.
        if (discardRef.current) {
          discardRef.current = false;
          audioChunksRef.current = [];
          return;
        }
        const mimeType = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.byteLength; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength)));
        }
        const base64 = btoa(binary);

        setIsTranscribing(true);
        try {
          const text = await voiceApi.transcribe(base64, mimeType, 'recording.webm');
          if (mySession !== sessionRef.current) return; // discarded on send (M2)
          if (text.trim()) {
            const cur = composerRef.current?.getValue() ?? '';
            composerRef.current?.setValue(cur ? `${cur} ${text}` : text);
            focusComposer();
          } else {
            toast.error('No speech detected. Please try again.');
          }
        } catch {
          toast.error('Transcription failed. Please try again.');
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      startingRef.current = false;
    } catch (err: any) {
      startingRef.current = false;
      if (err.name === 'NotAllowedError') {
        toast.error('Microphone access denied. Please allow microphone access and try again.');
      } else {
        toast.error('Could not start recording. Please check your microphone.');
      }
    }
  }, [composerRef, focusComposer]);

  /** Manual mic-button stop: trailing results are DELIVERED (the user wants
   *  their last words appended). LATCHES the hook-level stop flag (C1) BEFORE
   *  stop() — the onend that follows must not restart the engine into an
   *  unstoppable hot mic. */
  /** Manual mic-button stop: trailing results are DELIVERED (the user wants
   *  their last words appended). LATCHES the hook-level stop flag (C1) BEFORE
   *  stop() — the onend that follows must not restart the engine into an
   *  unstoppable hot mic. Neither the session ref nor the recognition ref is
   *  nulled here: stop() delivers a trailing final onresult asynchronously,
   *  which the write gates accept only while this session still owns them —
   *  the guarded onend then clears the recognition ref. A later session
   *  replaces both refs (generation bump), retiring this one fully.
   *  discardRecording/unmount abort() instead (no trailing results), so they
   *  null immediately. */
  const stopRecording = useCallback(() => {
    // HOOK-LEVEL STOP LATCH (review C1): the session state object is captured
    // by every per-instance closure — setting `.stopping` HERE, before stop(),
    // is visible to the trailing onend, which therefore cannot restart the
    // engine into an unstoppable hot mic.
    if (voiceSessionRef.current) {
      voiceSessionRef.current.stopping = true;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
  }, []);

  /** Send-time auto-off (0c256c3a): abort WITHOUT delivering trailing results
   *  so the just-sent text is never re-injected into the cleared composer. */
  const discardRecording = useCallback(() => {
    // Invalidate any in-flight results from the session being discarded (M2):
    // a Whisper roundtrip or trailing Web-Speech finals resolving AFTER this
    // point see a stale generation and drop their text instead of re-injecting
    // it into the cleared composer.
    sessionRef.current += 1;
    // HOOK-LEVEL STOP LATCH (review C1): abort() fires onend without an
    // error — only the latch stops that onend from restarting the engine
    // after the draft was just sent ("hitting send turns the mic off",
    // 0c256c3a). The generation bump above additionally retires the handlers
    // via getSessionGeneration (C3).
    if (voiceSessionRef.current) {
      voiceSessionRef.current.stopping = true;
      voiceSessionRef.current = null;
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      discardRef.current = true;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    // Desktop shell: the native recorder owns the toggle — both taps go over
    // the bridge (start, then stop-and-insert); nothing local to stop.
    if (isDigbyDesktopShell()) {
      if (!requestDesktopShellDictation()) toast.info(SHELL_PTT_HINT);
      return;
    }
    if (isRecording) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Desktop shell: mirror the native recorder's state onto the button
  // (recording pulse / transcribing spinner) — the shell dispatches
  // `digby:voice` on window as its recorder moves.
  useEffect(() => {
    if (!isDigbyDesktopShell()) return;
    const onShellVoice = (e: Event) => {
      const state = (e as CustomEvent<{ state?: ShellVoiceState }>).detail?.state;
      setIsRecording(state === 'recording');
      setIsTranscribing(state === 'transcribing');
    };
    window.addEventListener(SHELL_VOICE_EVENT, onShellVoice);
    return () => window.removeEventListener(SHELL_VOICE_EVENT, onShellVoice);
  }, []);

  // Unmount cleanup: abort everything (discard semantics — no trailing writes
  // into an unmounting composer). The hook-level stop latch (C1) is set so
  // the trailing onend cannot restart the engine on a gone component.
  useEffect(() => {
    return () => {
      if (voiceSessionRef.current) {
        voiceSessionRef.current.stopping = true; // C1: latch before abort()
        voiceSessionRef.current = null;
      }
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        discardRef.current = true;
        try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
        mediaRecorderRef.current = null;
      }
    };
  }, []);

  return { isRecording, isTranscribing, toggleRecording, discardRecording };
}
