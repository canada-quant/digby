/**
 * Video-capability note (ticket e3113ec9) — the turn-scoped brief that makes a
 * video ask disclose the gap in the FIRST line instead of after several turns
 * of reference frames.
 *
 * The incident, verbatim from the ticket: a user asked for a 60-second
 * advertising Reel; the run produced a scenario + 4 photorealistic frames via
 * generate_image, then routed the actual deliverable to external apps (Veo /
 * Kling) — and the user asked why they had to wait: «وقتی بلد نیستی ویدیو
 * بسازی چرا وقتمو می‌گیری — همون اول بگو» ("if you can't make videos, say so at
 * the START").
 *
 * Both halves are pinned here:
 *   (a) the ASK is detected (proximity classifier, explicit-format ask, and the
 *       non-English case the incident actually was), and
 *   (b) the answers it must give — the gap first, then the real alternatives,
 *       never an implied in-flight video.
 * Plus the false-positive set that must stay SILENT: video understanding
 * (a capability Digby genuinely has), incidental mentions, storyboard-only asks.
 */

import {
  videoCapabilityNote, isVideoGenerationAsk, videoAskSignals,
  videoCapabilityNoteEnabled, VIDEO_CAPABILITY_NOTE_DISABLED_ENV,
} from './video-capability-note';

/** The ticket's own ask, as the user phrased it. */
const TICKET_ASK = 'Make me a 60-second advertising Reel for my café — a scenario plus photorealistic reference frames, then the video.';

describe('isVideoGenerationAsk — the ticket e3113ec9 shape', () => {
  it('fires on the incident ask (60-second advertising Reel)', () => {
    expect(isVideoGenerationAsk(TICKET_ASK)).toBe(true);
    expect(videoAskSignals(TICKET_ASK).videoObject).toBe(true);
  });

  it('fires on the common phrasings of a video-generation request', () => {
    for (const ask of [
      'generate a video of a cat playing piano',
      'can you make a reel for my product launch?',
      'I need a 30 second clip for Instagram',
      'create an animation showing our logo morphing',
      'render this image into a video please',
      'turn these 4 frames into a video',
      'make me a tiktok promo for the sale',
      'produce a short advertisement for my bakery',
      'animate this picture',
      'shoot a 60s advert for us',
      'build a motion graphics intro',
      'export it as an mp4',
      // the mixed ask: understand an old clip AND make a new one — still fires
      'summarise my last clip and then make a video like it',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(true);
    }
  });

  it('does NOT fire where Digby genuinely HAS the capability — video understanding', () => {
    for (const ask of [
      'summarise this video for me',
      'transcribe the clip I uploaded',
      'what does this video say?',
      'explain this video to me',
      'extract the subtitles from that reel',
      'add captions to my video',
      'create captions for my video',
      'download this video for me',
      'review this clip and tell me what is wrong with it',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  // Council review 2026-11-01 (gpt-5.6-sol / claude-opus-4-8, ticket e3113ec9): the blockers named for
  // merge were FALSE POSITIVES, not misses — a spurious "I cannot make video" on a turn where Digby HAS
  // the capability is user-facing and worse than silence. These are their exact cases, pinned.
  it('does NOT fire on the NON-DELIVERABLE compounds the council flagged (a video GAME, a video CALL)', () => {
    for (const ask of [
      'create an image of a video game character',
      'design a video call screen mockup',
      'generate a picture of a video camera',
      'make me a logo for a video game studio',
      'draw a video player UI',
      'build a video editing app',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  it('does NOT fire on a KNOWLEDGE deliverable about a video (captions / script / shot list — all real capabilities)', () => {
    for (const ask of [
      'write a video script for me',
      'create captions for my video',
      'storyboard a Reel for me',
      'generate still frames for a reel',
      'prepare a shot list for the shoot',
      'draft a summary of that clip',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  it('the ANIMATE-A-STILL shape still fires, but a plain image EDIT never does', () => {
    for (const ask of ['animate this photo', 'turn this image into a video', 'render these frames into motion', 'bring this picture to life']) {
      expect(isVideoGenerationAsk(ask)).toBe(true);
    }
    for (const ask of ['edit this photo and remove the background', 'retouch this image', 'generate a picture of a cat']) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  it('the MIXED ask fires — an explicit production clause beats the understand veto (council blocker)', () => {
    for (const ask of [
      'analyze this clip, then make a Reel',
      'summarise my last clip and then make a video like it',
      'transcribe this video and then generate an animation from it',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(true);
    }
  });

  it('ordinary imperatives are not missed by the proximity window (council blocker)', () => {
    for (const ask of [
      'make me a Reel',
      'turn this into a 60-second ad',
      'make a 60s Reel',
      'produce an MP4',
      'make a tiktok for us',
      'can you create a YouTube Short',
      'make a video for my brand',
      'render a clip from these images',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(true);
    }
  });

  it('does NOT fire on incidental video mentions or asks Digby can already satisfy', () => {
    for (const ask of [
      'I watched a video about building a house yesterday, what do you think?',
      'in short, what is quantum computing',
      'give me the video settings for a Sony A7',
      'what is the best video editor for beginners',
      'make me a storyboard for a scene',
      'write a script for a 30-second radio spot',
      'how many videos are on my YouTube channel',
      '',
      '   ',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  // ── ADVERSARIAL REVIEW 2026-11-01 (independent reviewer, fresh context) ──────
  // The reviewer REFUTED the first, proximity-based classifier with these exact
  // inputs: it fired "Digby has NO video generation" on IMAGE asks and on ADVICE
  // questions, and stayed SILENT on "make a video ad" — the ticket's own domain.
  // Both halves are pinned here so the regression cannot return.
  it('review F1: an IMAGE ask for a video-related thing never fires (poster / banner / artwork / cover)', () => {
    for (const ask of [
      'design a poster for a video',
      'make me a poster for my youtube video',
      'design a banner for my video',
      'make artwork for my video',
      'create a cover image for my video',
      'generate a thumbnail for the video',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  it('review F1: an ADVICE / meta question about video tooling never fires', () => {
    for (const ask of [
      'how do I make ads on facebook',
      'what is the best way to make a video',
      'what should I use to make videos?',
      'how much does it cost to make a video',
      'recommend a tool to make reels',
      'which software should I use to create videos',
      'make sure the video plays',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  it('review F2: "video ad" IS the deliverable — the ticket\'s own advertising-Reel class must fire', () => {
    for (const ask of [
      'make me a 30-second video ad for my bakery',
      'make me a video ad',
      'create a 30 second video ad',
      'I need a video ad for Facebook',
      'we want a video commercial for the launch',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(true);
    }
  });

  // The incident's user wrote in PERSIAN — an English-only trigger would leave the
  // ticket's own reporter unprotected (review observation 1).
  it('review obs 1: a non-English video ask fires, and a non-English UNDERSTANDING ask does not', () => {
    for (const ask of [
      'برای من یک ریلز بساز',
      'یک ویدیو ۶۰ ثانیه‌ای تبلیغاتی برای کافه‌ام بساز',
      'hey, haz un video de 60 segundos para mi panadería',
      'erstelle ein Video für meine Bäckerei',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(true);
    }
    for (const ask of [
      'این ویدیو را خلاصه کن',
      'زیرنویس این کلیپ را بنویس',
      'resume este video para mí',
    ]) {
      expect(isVideoGenerationAsk(ask)).toBe(false);
    }
  });

  it('the proximity window is real — a create verb and a video noun in unrelated clauses do not fire', () => {
    // "make" and "video" are far apart and split by sentence punctuation.
    const far = 'Make sure the invoice totals add up correctly. Later I will watch a video about taxes.';
    expect(isVideoGenerationAsk(far)).toBe(false);
  });
});

describe('videoCapabilityNote — the brief a video ask receives', () => {
  const note = videoCapabilityNote(TICKET_ASK);

  it('states the gap FIRST, absolutely, and forbids burn-turns-then-disclose', () => {
    expect(note.startsWith('## This turn asks for a VIDEO')).toBe(true);
    const firstLine = note.split('\n')[1];
    expect(firstLine).toContain('NO video generation');
    expect(firstLine).toContain('no text-to-video, no image-to-video');
    expect(note).toContain('Say it in your FIRST line');
    expect(note).toContain('do not spend turns on reference frames or planning first');
    expect(note).toContain('never imply a video is coming');
  });

  it('names what Digby CAN do in the same answer (the alternatives the incident offered too late)', () => {
    expect(note).toContain('generate_image');
    expect(note).toContain('shot list / storyboard table');
    expect(note).toContain('ready-to-paste prompt');
    expect(note).toContain('script / voiceover narration');
  });

  it('never implies the video is in flight — that is the exact lie the ticket reports', () => {
    expect(note).toContain('Never end by implying the video is in progress, queued, or will arrive later');
  });

  it('does not name a vendor the user has not named (prompt hygiene: no model/vendor guesses)', () => {
    expect(note).not.toMatch(/Kling|Veo|Hailuo|Runway|Pika|Sora/);
  });

  it('returns the empty string for anything that is not a video-generation ask', () => {
    for (const notAsk of ['summarise this video', 'in short, what is a monad', 'make me a logo', '']) {
      expect(videoCapabilityNote(notAsk)).toBe('');
    }
  });

  it(`${VIDEO_CAPABILITY_NOTE_DISABLED_ENV}=1 returns nothing even for a real ask`, () => {
    expect(videoCapabilityNote(TICKET_ASK, { [VIDEO_CAPABILITY_NOTE_DISABLED_ENV]: '1' })).toBe('');
    expect(videoCapabilityNoteEnabled({ [VIDEO_CAPABILITY_NOTE_DISABLED_ENV]: '1' })).toBe(false);
    expect(videoCapabilityNoteEnabled({})).toBe(true);
  });
});