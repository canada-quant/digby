/**
 * Ticket 9255c3f0 — "mac os app voice recording": two symptoms in the macOS
 * shell's native voice path (VoiceMode.swift), both reproduced against the
 * 0.1.13 source:
 *
 *   1. "it puts your voice messages as the title of the digby app and not in
 *      the message box" — the recognition callback wrote the LIVE transcript
 *      into `status` ("● \(text)"), and AppDelegate's onStatusChange mirrors
 *      every ●-prefixed status into `window.title` ("Digby — ● <transcript>").
 *      Fixed in shell 0.1.14 (commit 2ab9f0ed): status is TEXT-FREE whenever
 *      it feeds the title — word count only.
 *
 *   2. "it also only sends the last few words not the whole text if you
 *      dictate a lot" — ONE SFSpeechRecognitionTask ran for the whole
 *      utterance with requiresOnDeviceRecognition = true, and each partial
 *      result REPLACED the transcript. On long audio the on-device session
 *      degrades/exhausts and delivers isFinal early carrying only the newest
 *      seconds — that tail replaced the transcript and ended the session.
 *
 * REWORK (ticket 9255c3f0, 2026-10-28): the utterance is SPLIT — text already
 * heard is sealed (sealedText) and the active task re-transcribes only ITS
 * OWN audio; every 45 s (or the moment a task finalizes mid-utterance) the
 * segment is sealed and a fresh task takes over primed with ~1.5 s of
 * trailing audio (the ring), and every absorb dedupes the task's result
 * against the RING baseline (the ring's known words) before folding it into
 * liveSegment. The tap feeds the live request AND the ring with EVERY buffer
 * (no cursor gating); results AND errors are guarded by `request === req`
 * checked on main; the ring is a plain [AVAudioPCMBuffer] under ARC; a
 * dictation stop (send:false) no longer wipes the transcript; a
 * mid-utterance isFinal keeps recording.
 *
 * Review leg (2026-10-28): the first cut deduped only against liveSegment —
 * empty at a seam because rotateSegment() seals the transcript and clears
 * liveSegment BEFORE the fresh task can speak — so every seam duplicated the
 * re-heard ring into the transcript (executed proof, reviewer's seamsim).
 * The fix: ringTail (the sealed tail the ring re-hears) is the dedupe
 * baseline for EVERY absorb of the segment (freshTail).
 *
 * Three layers (the mic-entitlement.61823826 idiom — the Swift toolchain
 * only exists on the build Mac, so CI pins the sources):
 *   1. SEMANTIC — line-for-line JS mirrors of mergeSegment / freshTail /
 *      ringWords run on Linux CI;
 *   2. PIPELINE — a faithful simulation of the seal → clear → prime →
 *      absorb state machine (the reviewer's seam scenarios, which the
 *      first cut's in-isolation tests never covered);
 *   3. SOURCE pins — structural invariants the mirrors cannot see.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const VOICE = readFileSync(
  fileURLToPath(new URL('../../macos-app/Sources/Digby/VoiceMode.swift', import.meta.url)),
  'utf8',
);
const BUILD_SH = readFileSync(
  fileURLToPath(new URL('../../macos-app/build-app.sh', import.meta.url)),
  'utf8',
);

/**
 * MIRROR of VoiceMode.mergeSegment (Swift, static func) — transcribed
 * line-for-line. Swift `split(separator: " ", omittingEmptySubsequences:
 * false)` and JS `split(' ')` produce identical word arrays; Swift
 * `lowercased()` ↔ JS `toLowerCase()`. If the Swift body changes, change
 * THIS in the same commit.
 */
function mergeSegment(prevLive: string, liveText: string): string {
  const trimmed = liveText.trim();
  if (trimmed === '') return prevLive;
  const prevWords = prevLive.split(' ');
  const newWords = trimmed.split(' ');
  let overlap = 0;
  if (prevWords.length > 0) {
    const maxOverlap = Math.min(prevWords.length, newWords.length);
    scan: for (let length = maxOverlap; length >= 1; length--) {
      let i = 0;
      while (
        i < length &&
        newWords[i].toLowerCase() === prevWords[prevWords.length - length + i].toLowerCase()
      ) {
        i += 1;
      }
      if (i === length) {
        overlap = length;
        break scan;
      }
    }
  }
  const fresh = newWords.slice(overlap).join(' ');
  if (overlap > 0) {
    return fresh === '' ? prevLive : `${prevLive} ${fresh}`;
  }
  return fresh;
}

/** MIRROR of VoiceMode.freshTail (static func). */
function freshTail(baseline: string, liveText: string): string {
  const trimmed = liveText.trim();
  if (trimmed === '') return '';
  const merged = mergeSegment(baseline, trimmed);
  if (merged === baseline) return '';
  if (merged.startsWith(`${baseline} `)) {
    return merged.slice(baseline.length + 1);
  }
  return merged;
}

/** MIRROR of VoiceMode.ringWords(of:maxWords:) (Swift split defaults to
 * omittingEmptySubsequences: true — hence the filter). */
function ringWords(text: string, maxWords = 10): string {
  const words = text.split(' ').filter((w) => w !== '');
  if (words.length <= maxWords) return text.trim();
  return words.slice(words.length - maxWords).join(' ');
}

/**
 * PIPELINE simulation of the live session state machine — mirrors
 * absorbTranscript / rotateSegment / mid-utterance-isFinal handling exactly
 * (state names match the Swift). This is the seam the first cut never
 * tested: mergeSegment passed 18/18 in isolation while every rotation
 * duplicated the ring.
 */
class VoiceSessionSim {
  sealedText = '';
  liveSegment = '';
  ringTail = '';

  fullTranscript(): string {
    if (this.sealedText === '') return this.liveSegment;
    return this.liveSegment === '' ? this.sealedText : `${this.sealedText} ${this.liveSegment}`;
  }

  /** absorbTranscript(_:finalized:) */
  absorb(text: string, finalized: boolean): void {
    const trimmed = text.trim();
    const fresh = freshTail(this.ringTail, text);
    if (fresh === '' && trimmed !== '') {
      // mergeLive: the task has produced nothing beyond the ring yet —
      // keep the previous live segment (refinement wave).
    } else {
      this.liveSegment = mergeSegment(this.liveSegment, fresh);
    }
    if (finalized) {
      // MID-UTTERANCE isFinal: the handler immediately rotates (recording,
      // !stopping) — mirrored by the driver calling rotate() right after.
      this.sealedText = this.fullTranscript();
      this.liveSegment = '';
    }
  }

  /** rotateSegment()'s transcript half (the fresh task's own audio is its
   * concern; the dedupe baseline is all the seam needs here). */
  rotate(): void {
    this.sealedText = this.fullTranscript();
    this.liveSegment = '';
    this.ringTail = ringWords(this.sealedText);
  }
}

describe('9255c3f0 — mergeSegment semantics (pure, mirrored)', () => {
  it('a fresh task with no previous text starts the transcript', () => {
    expect(mergeSegment('', 'hello world')).toBe('hello world');
  });

  it('the re-heard overlap is deduped — the seam does not double words', () => {
    expect(mergeSegment('hello world', 'world and more')).toBe('hello world and more');
    expect(mergeSegment('the quick brown fox', 'brown fox jumps over')).toBe(
      'the quick brown fox jumps over',
    );
    expect(mergeSegment('one two three', 'three four')).toBe('one two three four');
    // The ring re-hears a TAIL of a longer segment (not its whole text).
    expect(mergeSegment('a b c d', 'c d e f')).toBe('a b c d e f');
  });

  it('the overlap matches case-insensitively and keeps the sealed casing', () => {
    expect(mergeSegment('Hello World', 'world and more')).toBe('Hello World and more');
  });

  it('the whole previous segment re-heard at the front keeps it once', () => {
    expect(mergeSegment('seam words', 'seam words continued')).toBe('seam words continued');
  });

  it('no overlap REPLACES (never appends) — the duplication class B1', () => {
    expect(mergeSegment('alpha beta', 'gamma delta')).toBe('gamma delta');
  });

  it('an empty live result keeps the previous live segment (refinement wave)', () => {
    expect(mergeSegment('hello world', '')).toBe('hello world');
    expect(mergeSegment('hello world', '   ')).toBe('hello world');
  });
});

describe('9255c3f0 — freshTail: ring-baselined dedupe (the review-leg fix)', () => {
  it('the first post-seam partial (liveSegment still empty) drops the re-heard ring', () => {
    // ring re-hears "hello world"; the fresh task reports "world and more".
    expect(freshTail('hello world', 'world and more')).toBe('and more');
    expect(freshTail('hello world', 'hello world and more')).toBe('and more');
  });

  it('the task reporting exactly the ring words yields nothing new', () => {
    expect(freshTail('hello world', 'hello world')).toBe('');
    // Case differences still match (the merge is case-insensitive).
    expect(freshTail('Hello World', 'hello world and more')).toBe('and more');
  });

  it('no overlap matched means the whole text is genuinely new', () => {
    expect(freshTail('hello world', 'brand new audio')).toBe('brand new audio');
    expect(freshTail('', 'brand new audio')).toBe('brand new audio');
  });

  it('an empty live result yields nothing new', () => {
    expect(freshTail('hello world', '')).toBe('');
    expect(freshTail('hello world', '   ')).toBe('');
  });

  it('ringWords keeps the last maxWords words (the ring re-hears a short tail)', () => {
    const twelve = 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12';
    expect(ringWords(twelve)).toBe('w3 w4 w5 w6 w7 w8 w9 w10 w11 w12');
    expect(ringWords('a b c')).toBe('a b c');
  });
});

describe('9255c3f0 — PIPELINE: seal → clear → prime ring → absorb (the seam the first cut never tested)', () => {
  it('the reviewer seam scenario: ring duplication cannot re-enter the transcript', () => {
    const s = new VoiceSessionSim();
    s.absorb('hello world and', false);
    expect(s.fullTranscript()).toBe('hello world and');
    s.rotate(); // 45 s boundary; fresh task primed with the ~1.5 s ring
    expect(s.ringTail).toBe('hello world and');
    s.absorb('and more', false); // the fresh task re-hears the ring, then new words
    expect(s.fullTranscript()).toBe('hello world and more');
    s.absorb('and more x', false); // cumulative partial refines in place
    expect(s.fullTranscript()).toBe('hello world and more x');
  });

  it('mid-utterance isFinal: seals, rotates, and the fresh task dedupes its ring', () => {
    const s = new VoiceSessionSim();
    s.absorb('please send the report', true); // degraded task finalizes early
    s.rotate(); // the handler rotates immediately (recording, !stopping)
    s.absorb('the report thanks', false);
    expect(s.fullTranscript()).toBe('please send the report thanks');
    // …and a second isFinal seam in the same session stays clean.
    s.absorb('the report thanks doc', true);
    s.rotate();
    s.absorb('thanks doc very much', false);
    expect(s.fullTranscript()).toBe('please send the report thanks doc very much');
  });

  it('a long segment: only the ring TAIL is re-heard and deduped', () => {
    const s = new VoiceSessionSim();
    const first = 'one two three four five six seven eight nine ten eleven twelve';
    s.absorb(first, false);
    s.rotate();
    expect(s.ringTail).toBe('three four five six seven eight nine ten eleven twelve');
    s.absorb('three four five six seven eight nine ten eleven twelve thirteen fourteen', false);
    expect(s.fullTranscript()).toBe(
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    );
  });

  it('a short first segment (no rotation yet) is NOT deduped away — full text survives', () => {
    const s = new VoiceSessionSim();
    s.absorb('hello there', false);
    s.absorb('hello there how are', false);
    s.absorb('hello there how are you doing today', false);
    expect(s.fullTranscript()).toBe('hello there how are you doing today');
  });

  it('a refinement wave arriving empty mid-segment keeps the live segment', () => {
    const s = new VoiceSessionSim();
    s.absorb('alpha beta', false);
    s.absorb('   ', false);
    expect(s.fullTranscript()).toBe('alpha beta');
  });

  it('an unmatched fresh task after a seam REPLACES the live segment without losing sealed text', () => {
    const s = new VoiceSessionSim();
    s.absorb('please send the report', false);
    s.rotate();
    s.absorb('completely unrelated audio', false);
    expect(s.fullTranscript()).toBe('please send the report completely unrelated audio');
  });
});

describe('9255c3f0 — source pins (the Swift toolchain is build-Mac-only; CI pins the sources)', () => {
  it('every absorb dedupes against the ring baseline (freshTail) — not against empty liveSegment', () => {
    expect(VOICE).toContain('static func freshTail(_ baseline: String, _ liveText: String) -> String');
    expect(VOICE).toContain('liveSegment = mergeLive(liveText)');
    expect(VOICE).toContain('let fresh = Self.freshTail(ringTail, liveText)');
    expect(VOICE).toContain('ringTail = Self.ringWords(of: sealedText)');
  });

  it('rotateSegment seals from the transcript CURRENT length — never resets the seal to 0 (B3)', () => {
    expect(VOICE).toMatch(/sealedText = fullTranscript\s*\n\s*liveSegment = ""/);
    expect(VOICE).not.toContain('seamCursor = 0');
    expect(VOICE).toContain('liveSegment.isEmpty ? sealedText : sealedText + " " + liveSegment');
  });

  it('the tap feeds the live request AND the ring with EVERY buffer (no gating — no deaf window, B2/B5)', () => {
    expect(VOICE).toContain('self.audioRing.append(buffer)');
    expect(VOICE).toContain('self.request?.append(buffer)');
    expect(VOICE).not.toContain('seamCursor');
  });

  it('the ring is a plain [AVAudioPCMBuffer] under ARC — no manual retain/release (B4)', () => {
    expect(VOICE).toContain('private var audioRing: [AVAudioPCMBuffer]');
    expect(VOICE).not.toContain('CMSampleBuffer');
    expect(VOICE).not.toMatch(/\.retain\(\)/);
    expect(VOICE).not.toMatch(/\.release\(\)/);
  });

  it('results AND errors are guarded by request === req, checked ON MAIN (M1)', () => {
    expect((VOICE.match(/self\.request === req/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(VOICE).not.toContain('let isCurrent =');
  });

  it('a mid-utterance isFinal keeps recording and keeps feeding audio (B5)', () => {
    expect(VOICE).toMatch(
      /if self\.stoppingForSend \{\s*\n\s*self\.finishRecording\(send: true\)\s*\n\s*\} else if !self\.stopping \{\s*\n\s*self\.rotateSegment\(\)/,
    );
  });

  it('a dictation stop (send:false) no longer wipes the transcript and never re-feeds the ring', () => {
    expect(VOICE).not.toContain('latestTranscript');
    expect(VOICE).toMatch(/stopping = true/);
    // The tap is ungated, so stop must NOT re-append the ring (double-fed
    // tail) — but rotateSegment's seam prime is REQUIRED and stays.
    const stopBody = VOICE.slice(
      VOICE.indexOf('private func stopRecording'),
      VOICE.indexOf('/// Terminal recording path'),
    );
    expect(stopBody).not.toContain('for buffer');
    const rotateBody = VOICE.slice(
      VOICE.indexOf('private func rotateSegment'),
      VOICE.indexOf('static func freshTail'),
    );
    expect(rotateBody).toContain('for buffer in pending');
  });

  it('status stays TEXT-FREE — word count only, transcript never in the title (symptom 1)', () => {
    expect(VOICE).toMatch(/● \\\(words\) words/);
    expect(VOICE).not.toMatch(/● \\\(text/);
    expect(VOICE).not.toMatch(/● \\\(latestTranscript/);
    expect(VOICE).not.toMatch(/Sending: \\\(/);
  });

  it('absorb() keeps results only from the CURRENT task (a stale task cannot mutate the transcript)', () => {
    expect(VOICE).toMatch(/self\.absorbTranscript\(text, finalized: result\.isFinal\)/);
    expect(VOICE).toMatch(/guard self\.request === req else \{ return \}/);
  });
});

describe('9255c3f0 — release contract (shell 0.1.14)', () => {
  it('build-app.sh defaults to 0.1.14 (the version carrying this fix)', () => {
    const m = BUILD_SH.match(/VERSION="\$\{VERSION:-([0-9]+\.[0-9]+\.[0-9]+)\}"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('0.1.14');
  });

  it('the version header names this ticket and both symptoms', () => {
    expect(BUILD_SH).toMatch(/0\.1\.14 \(2026-10-27, ticket 9255c3f0\)/);
    expect(BUILD_SH).toMatch(/window title/);
    expect(BUILD_SH).toMatch(/truncated|last few words/);
  });

  it('the historical 0.1.12 header is restored verbatim (review M4)', () => {
    expect(BUILD_SH).toContain('# 0.1.12 (2026-10-23, ticket 8b13ec2b)');
  });
});
