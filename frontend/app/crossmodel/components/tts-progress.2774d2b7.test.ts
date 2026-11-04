/**
 * Ticket 2774d2b7 — "text to speech button doesn't work at all just spins
 * and dies". Source pins (the repo's convention for browser-bound code — see
 * api-client.timeout.test.ts): the read-aloud path must NEVER again hang on a
 * single whole-answer /tts request that axios aborts at 45 s.
 *
 * Root cause pinned here: lib/api-client.ts gives every apiClient call a 45 s
 * default timeout (2026-10-09 Windows-shell hang fix), while the legacy
 * voiceApi.tts() synthesized the ENTIRE answer in one POST /tts — ~14 s per
 * ≤600-char chunk, sequential, 50-130 s for a multi-paragraph answer. The
 * client aborted, the spinner died, and no audio played. Zero backend error
 * rows: the client had already left.
 *
 * Pins:
 *   - voiceApi.ttsStream EXISTS and rides raw fetch (NOT apiClient) — the
 *     45 s instance timeout cannot kill read-aloud.
 *   - its ONLY bound is the 55 s idle-between-lines timer, reset by every
 *     line (chunk or server ping), NOT a total-request cap.
 *   - the speaker button calls the progressive handler, which plays the
 *     FIRST chunk as soon as it arrives (text order preserved by index).
 *   - the legacy one-shot tts() stays for any non-read-aloud consumer —
 *     unchanged shape.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const API_SRC = readFileSync(
  fileURLToPath(new URL('../../../lib/api/crossmodel.ts', import.meta.url)),
  'utf8',
);
const SPEECH_SRC = readFileSync(
  fileURLToPath(new URL('../../../../backend/src/modules/crossmodel/speech.ts', import.meta.url)),
  'utf8',
);
const CONTROLLER_SRC = readFileSync(
  fileURLToPath(new URL('../../../../backend/src/modules/crossmodel/crossmodel.controller.ts', import.meta.url)),
  'utf8',
);
const TRANSCRIPT_SRC = readFileSync(
  fileURLToPath(new URL('./code-transcript.tsx', import.meta.url)),
  'utf8',
);
const API_CLIENT_SRC = readFileSync(
  fileURLToPath(new URL('../../../lib/api-client.ts', import.meta.url)),
  'utf8',
);

describe('voiceApi.ttsStream (ticket 2774d2b7 — progressive read-aloud)', () => {
  // The whole method: from its key to the voiceApi object's closing brace.
  const streamBlock = API_SRC.slice(
    API_SRC.indexOf('ttsStream: async ('),
    API_SRC.indexOf('};', API_SRC.indexOf("signal?.removeEventListener('abort', onCallerAbort);")),
  );
  it('exists and rides raw fetch with the auth header — never the 45 s apiClient instance', () => {
    expect(API_SRC).toContain('ttsStream: async (');
    // The stream call must NOT go through apiClient (axios): its 45 s default
    // is exactly what killed the legacy one-shot. Raw fetch + Bearer, the
    // feedbackApi idiom (crossmodel.ts).
    expect(streamBlock).toContain("fetch(`${apiBase}/crossmodel/tts/stream`");
    expect(streamBlock).toContain("Authorization: `Bearer ${token}`");
    expect(streamBlock).not.toMatch(/apiClient\.post/);
  });

  it('the ONLY timeout is the idle-between-lines bound — reset on every line, no total-request cap', () => {
    expect(streamBlock).toContain('IDLE_TIMEOUT_MS');
    const m = streamBlock.match(/IDLE_TIMEOUT_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ''));
    // Above the vendor's worst measured chunk (~40 s) and the server's 20 s
    // keepalive ping interval; a total silence of 55 s means the stream died.
    expect(ms).toBeGreaterThanOrEqual(50_000);
    expect(ms).toBeLessThanOrEqual(90_000);
    // the reader loop resets the idle timer on EVERY chunk of bytes
    expect(streamBlock).toMatch(/const \{ done, value \} = await reader\.read\(\);[\s\S]*?resetIdle\(\);/);
  });

  it('parses NDJSON defensively: chunk / done / error terminal shapes, torn lines skipped', () => {
    expect(streamBlock).toContain(`obj?.type === 'chunk'`);
    expect(streamBlock).toContain(`obj?.type === 'done'`);
    expect(streamBlock).toContain(`obj?.type === 'error'`);
    expect(streamBlock).toMatch(/catch \{ continue; \}/); // a torn line never kills the stream
  });

  it('the legacy one-shot tts() keeps its exact shape (no other consumer breaks)', () => {
    expect(API_SRC).toMatch(/tts: async \(text: string, voice\?: string\): Promise<\{ audio: string; mimeType: string \}> => \{\s*const response = await apiClient\.post\('\/crossmodel\/tts', \{ text, voice \}\);/);
  });

  it('the apiClient 45 s default is untouched (the Windows-shell hang fix stands)', () => {
    const m = API_CLIENT_SRC.match(/export const API_TIMEOUT_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ''))).toBe(45_000);
  });
});

describe('the speaker button (PlainMessageActions) — progressive playback wiring', () => {
  it('calls the progressive handler and keeps the stop-on-second-click contract', () => {
    expect(TRANSCRIPT_SRC).toContain('onClick={() => void handleReadAloudProgressive()}');
    expect(TRANSCRIPT_SRC).toMatch(/if \(speaking\) \{ stopPlainReadAloud\?\.\(\); return; \}/);
    expect(TRANSCRIPT_SRC).toContain('stopPlainReadAloud = stopAll;');
  });

  it('plays chunks strictly in TEXT order (index), starting on the first arrival', () => {
    // The queue only ever advances through nextToPlay in index order, and a
    // late-arriving earlier chunk is what resumes it.
    expect(TRANSCRIPT_SRC).toContain('const playNext = () => {');
    expect(TRANSCRIPT_SRC).toMatch(/const el = clipsByIndex\.get\(nextToPlay\);\s*\n\s*if \(!el\) \{/);
    expect(TRANSCRIPT_SRC).toMatch(/if \(current === chunk\.index\) \{ nextToPlay = current \+ 1; playNext\(\); \}/);
  });

  it('natural completion clears the speaking state (review #7): every clip played + stream over → stopAll', () => {
    expect(TRANSCRIPT_SRC).toContain('const checkNaturalCompletion = () => {');
    expect(TRANSCRIPT_SRC).toMatch(/streamDone = true;/);
    // the guard: stopped OR stream still open OR clips unended → no cleanup
    expect(TRANSCRIPT_SRC).toMatch(/if \(stopped \|\| !streamDone \|\| arrivedCount === 0 \|\| endedCount < arrivedCount\) return;/);
    // gap-skip: a torn-line gap advances to the next EXISTING index instead of waiting forever
    expect(TRANSCRIPT_SRC).toMatch(/filter\(\(i\) => i >= nextToPlay\)/);
  });

  it('a user stop (abort) never toasts an error (review #8)', () => {
    // the catch path returns silently when the stop was intentional
    expect(TRANSCRIPT_SRC).toMatch(/catch \{\s*\n\s*\/\/ Review finding #8[\s\S]*?if \(stopped\) return;/);
  });

  it('chunk mimeType rides the stream from synthesis, never hardcoded (review #5)', () => {
    // speech.ts carries each chunk's TRUE mime into onChunk, and the
    // controller passes part.mimeType through — the override seat's mp3
    // chunks must not be labelled audio/wav (Safari rejects mislabeled
    // data: URLs → the ticket symptom reborn for that config).
    expect(SPEECH_SRC).toContain("await onChunk({ index: i, audio, mimeType: 'audio/wav' }, chunks.length);");
    expect(SPEECH_SRC).toMatch(/await onChunk\(\{ index: 0, audio, mimeType: [^}]+ \}, 1\)/);
    expect(CONTROLLER_SRC).toContain('mimeType: part.mimeType, audio: part.audio.toString(\'base64\')');
  });

  it('a failed tail is an honest partial error, and total failure keeps the legacy toast', () => {
    expect(TRANSCRIPT_SRC).toContain('Read aloud stopped early — the speech service dropped part of the answer.');
    expect(TRANSCRIPT_SRC).toContain("'Text-to-speech failed. Please try again.'");
  });

  it('aborting the stream (stop button) cancels the fetch and every queued clip', () => {
    expect(TRANSCRIPT_SRC).toMatch(/const abort = new AbortController\(\);/);
    expect(TRANSCRIPT_SRC).toMatch(/abort\.abort\(\);/);
    expect(TRANSCRIPT_SRC).toMatch(/for \(const el of clipsByIndex\.values\(\)\) \{ el\.onended = null; el\.onerror = null; el\.pause\(\); \}/);
    expect(TRANSCRIPT_SRC).toMatch(/signal: abort\.signal|abort\.signal,/);
  });
});
